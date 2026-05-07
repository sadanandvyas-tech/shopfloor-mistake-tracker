/**
 * app.js
 *
 * Wires the UI together: form -> image (upload or camera) -> OCR/spellcheck
 * -> annotation -> submit. Tracks user's chosen correction per misspelled
 * word; only the chosen correction is sent to the Sheet.
 */

(function () {
  const $ = (id) => document.getElementById(id);

  // Default the date picker to today
  $("entryDate").value = new Date().toISOString().slice(0, 10);

  // Wire up the Project Number typeahead (PROJECT_LOOKUP_GUIDE Pattern A).
  // Falls back to free-text input automatically when the upstream proxy
  // isn't reachable — see js/projects.js for the fallback logic.
  if (window.Projects) {
    window.Projects.attach($("projectNumber"));
  }

  // Show backend URL in the footer (the element is optional — the operator
  // can comment it out for a cleaner UI without breaking the app).
  const backendDisplay = $("backend-url-display");
  if (backendDisplay) {
    backendDisplay.textContent = window.Api.isConfigured()
      ? window.Api.getBackendUrl()
      : "(not configured – see README.md)";
  }

  // ------------------------------------------------------------------ State
  const annotator = new window.Annotator($("annotateCanvas"));
  let currentFile     = null;
  let lastOcrResult   = null;
  // Map of misspelled word -> chosen correction (string). Only entries in this
  // map are sent to the Sheet on submit.
  const chosenCorrections = new Map();

  // ------------------------------------------------------------------ Stepper
  function setStep(n) {
    document.querySelectorAll(".step").forEach(el => {
      const step = parseInt(el.dataset.step, 10);
      el.classList.toggle("active", step === n);
      el.classList.toggle("done",   step <  n);
    });
  }

  // ------------------------------------------------------------------ Upload + Camera
  $("imageInput").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await onImageReady(file);
  });

  $("captureBtn").addEventListener("click", async () => {
    try {
      const file = await window.Camera.open();
      await onImageReady(file);
    } catch (err) {
      // User cancelled or camera unavailable. Show a hint, no scary alert.
      const status = $("submit-status");
      if (err && err.message && !/cancel/i.test(err.message)) {
        status.className = "status err";
        status.textContent = err.message;
      }
    }
  });

  async function onImageReady(file) {
    currentFile = file;
    $("fileName").innerHTML =
      '<span class="preview-thumb"><img alt="" src="' + URL.createObjectURL(file) +
      '"/>' + escapeHtml(file.name) + '</span>';

    $("ocr-card").classList.remove("hidden");
    $("annotate-card").classList.remove("hidden");
    $("submit-card").classList.remove("hidden");

    setStep(3);

    await annotator.loadImage(file);
    await runOcr(file);
  }

  // Validate the form before allowing image step. Project name is optional,
  // so it is intentionally not in this list.
  document.querySelectorAll("#entry-form input").forEach(inp => {
    inp.addEventListener("input", () => {
      const allFilled = ["uploadedBy","projectNumber","entryDate"]
        .every(id => $(id).value.trim());
      if (allFilled) setStep(2);
      else           setStep(1);
    });
  });

  // ------------------------------------------------------------------ OCR
  async function runOcr(file) {
    const status  = $("ocr-status");
    const results = $("ocr-results");
    chosenCorrections.clear();
    status.className = "status";
    status.textContent = "Analyzing image text...";
    results.innerHTML = "";

    try {
      const out = await window.OCR.analyze(file, m => {
        if (m.status) {
          status.textContent =
            "OCR: " + m.status +
            (m.progress ? " (" + Math.round(m.progress * 100) + "%)" : "");
        }
      });
      lastOcrResult = out;

      if (!out.text || !out.text.trim()) {
        status.className = "status warn";
        status.textContent = "No readable text detected. Use the annotation tools below to mark issues.";
        return;
      }

      if (!out.misspellings.length) {
        status.className = "status ok";
        status.textContent = "No spelling issues detected. Use the annotation tools below if you spot other defects.";
        return;
      }

      status.className = "status warn";
      status.textContent =
        "Found " + out.misspellings.length +
        " spelling issue(s). The corrected word is shown for each — dismiss any you disagree with.";

      out.misspellings.forEach(m => results.appendChild(renderSuggestion(m)));
    } catch (err) {
      status.className = "status err";
      status.textContent = "OCR failed: " + err.message;
    }
  }

  /**
   * Render a single misspelling row showing only the top suggested
   * correction, auto-selected. A small × button lets the operator
   * dismiss it if the auto-correction is wrong.
   */
  function renderSuggestion(m) {
    const top = m.suggestions[0];
    const wrap = document.createElement("div");
    wrap.className = "suggestion has-choice";
    wrap.dataset.word = m.word;

    const left = document.createElement("div");
    left.className = "suggestion-text";
    left.innerHTML =
      '<span class="word-original">' + escapeHtml(m.word) + '</span>' +
      '<span class="word-arrow">&rarr;</span>' +
      '<span class="suggested-word">' + escapeHtml(top) + '</span>';

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "dismiss-btn";
    dismiss.title = "Don't include this correction";
    dismiss.setAttribute("aria-label", "Dismiss correction for " + m.word);
    dismiss.textContent = "×"; // ×
    dismiss.addEventListener("click", () => {
      chosenCorrections.delete(m.word);
      wrap.remove();
      // If the user dismisses every flagged word, update the status text.
      const left = document.querySelectorAll("#ocr-results .suggestion").length - 1;
      if (left <= 0) {
        const st = $("ocr-status");
        st.className = "status ok";
        st.textContent = "All corrections dismissed.";
      }
    });

    wrap.appendChild(left);
    wrap.appendChild(dismiss);

    // Auto-select the top suggestion so the user doesn't have to click.
    chosenCorrections.set(m.word, top);
    return wrap;
  }

  // ------------------------------------------------------------------ Toolbar
  document.querySelectorAll(".tool-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      annotator.setTool(btn.dataset.tool);
    });
  });
  $("strokeColor").addEventListener("input", e => annotator.setColor(e.target.value));
  $("strokeWidth").addEventListener("input", e => annotator.setWidth(e.target.value));
  $("undoBtn").addEventListener("click", () => annotator.undo());
  $("clearBtn").addEventListener("click", () => annotator.clear());

  // ------------------------------------------------------------------ Submit
  $("submitBtn").addEventListener("click", onSubmit);
  $("resetBtn").addEventListener("click",  () => location.reload());

  async function onSubmit() {
    const status = $("submit-status");
    status.className = "status";
    status.textContent = "";

    // Project name is optional — not included.
    const requiredIds = ["uploadedBy", "projectNumber", "entryDate"];
    for (const id of requiredIds) {
      if (!$(id).value.trim()) {
        status.className = "status err";
        status.textContent = "Please fill in all required fields.";
        $(id).focus();
        return;
      }
    }
    if (!currentFile) {
      status.className = "status err";
      status.textContent = "Please choose or capture an image first.";
      return;
    }

    setStep(4);
    $("submitBtn").disabled = true;
    status.className = "status";
    status.textContent = "Uploading...";

    try {
      const annotatedBlob = await annotator.toBlob();

      // Only include misspellings the user explicitly accepted a correction for
      const misspellingsForSubmit = (lastOcrResult && lastOcrResult.misspellings || [])
        .filter(m => chosenCorrections.has(m.word))
        .map(m => ({ word: m.word, chosen: chosenCorrections.get(m.word) }));

      const payload = {
        uploadedBy:    $("uploadedBy").value.trim(),
        projectNumber: $("projectNumber").value.trim(),
        projectName:   $("projectName").value.trim(),
        date:          $("entryDate").value,
        notes:         $("notes").value.trim(),
        fileName:      buildFileName(),
        misspellings:  misspellingsForSubmit,
        image:         annotatedBlob,
        // Stable idempotency key from the form fields + a coarse timestamp,
        // so a double-click doesn't insert two rows. The server returns the
        // same record on the second call (per INTEGRATION_GUIDE Pattern B).
        idempotencyKey: buildIdempotencyKey(),
      };

      const saved = await window.Api.submitEntry(payload);
      const fullImageUrl = window.Api.imageUrl(saved.fileUrl || saved.filePath);

      // Cache the submission locally so the Logs page can show it instantly,
      // even before the next backend fetch.
      try {
        const cacheKey = "shopfloor.entries.cache";
        const existing = JSON.parse(localStorage.getItem(cacheKey) || "[]");
        existing.unshift({
          id:             saved.id,
          timestamp:      saved.timestamp || new Date().toISOString(),
          date:           saved.date || payload.date,
          uploadedBy:     payload.uploadedBy,
          projectNumber:  payload.projectNumber,
          projectName:    payload.projectName,
          notes:          payload.notes,
          spellingIssues: (payload.misspellings || [])
                            .map(m => m.word + " -> " + m.chosen).join(" | "),
          fileName:       saved.fileName || payload.fileName,
          fileUrl:        saved.fileUrl || saved.filePath || ""
        });
        // Keep at most 200 cached entries to bound storage usage.
        localStorage.setItem(cacheKey, JSON.stringify(existing.slice(0, 200)));
      } catch (cacheErr) {
        // localStorage can fail in private mode; not fatal.
        console.warn("Could not cache entry:", cacheErr);
      }

      status.className = "status ok";
      status.innerHTML =
        "Submitted successfully. " +
        "<a href='" + fullImageUrl + "' target='_blank' rel='noopener'>View uploaded image</a>";
    } catch (err) {
      status.className = "status err";
      status.textContent = "Submit failed: " + err.message;
    } finally {
      $("submitBtn").disabled = false;
    }
  }

  function buildFileName() {
    const safe = (s) => (s || "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "entry";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return [
      safe($("projectNumber").value),
      safe($("projectName").value),
      stamp
    ].join("_") + ".png";
  }

  // Idempotency key that's stable across rapid double-clicks but unique across
  // genuinely separate submissions. Uses operator + project + minute precision
  // so two clicks within the same minute dedupe; a re-submit a minute later is
  // treated as a new entry.
  function buildIdempotencyKey() {
    const safe = (s) => (s || "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40);
    const minuteStamp = new Date().toISOString().slice(0, 16);   // YYYY-MM-DDTHH:MM
    return [
      "shopfloor",
      safe($("uploadedBy").value),
      safe($("projectNumber").value),
      minuteStamp
    ].join(":");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
})();
