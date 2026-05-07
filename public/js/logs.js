/**
 * logs.js
 *
 * Powers logs.html. Loads cached entries from localStorage immediately for
 * instant display, then re-fetches the live list from the Apps Script
 * backend in the background and merges in newer entries.
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const CACHE_KEY = "shopfloor.entries.cache";

  let allEntries = [];

  // Footer URL display (element is optional — guard against missing/commented-out)
  const backendDisplay = $("backend-url-display");
  if (backendDisplay) {
    backendDisplay.textContent = window.Api.isConfigured()
      ? window.Api.getBackendUrl()
      : "(not configured – see README.md)";
  }

  $("refreshBtn").addEventListener("click", () => loadFromBackend(true));
  $("filter").addEventListener("input", render);

  // 1) Show cached entries instantly
  const cached = readCache();
  if (cached.length) {
    allEntries = cached;
    setStatus("Showing cached entries while loading the latest from the server...", "");
    render();
  } else {
    setStatus("Loading entries...", "");
  }

  // 2) Fetch live data
  loadFromBackend(false);

  async function loadFromBackend(isManual) {
    try {
      $("refreshBtn").disabled = true;
      const fresh = await window.Api.fetchEntries();
      allEntries = fresh;
      writeCache(fresh);
      if (!fresh.length) {
        setStatus("", "");
      } else {
        setStatus(
          (isManual ? "Refreshed " : "Loaded ") + fresh.length + " entries from server.",
          "ok"
        );
        // Auto-clear the success message after a moment
        setTimeout(() => { if ($("status").classList.contains("ok")) setStatus("", ""); }, 2500);
      }
      render();
    } catch (err) {
      const msg = "Could not load from server: " + err.message;
      setStatus(
        cached.length
          ? msg + " (showing locally cached entries)"
          : msg,
        "err"
      );
    } finally {
      $("refreshBtn").disabled = false;
    }
  }

  function render() {
    const body = $("logsBody");
    const empty = $("empty");
    const table = $("logsTable");
    const stats = $("stats");
    body.innerHTML = "";

    const q = $("filter").value.trim().toLowerCase();
    const filtered = q
      ? allEntries.filter(e => entryMatches(e, q))
      : allEntries;

    stats.textContent = filtered.length === allEntries.length
      ? allEntries.length + " entries"
      : filtered.length + " of " + allEntries.length + " entries";

    if (!allEntries.length) {
      table.classList.add("hidden");
      empty.classList.remove("hidden");
      return;
    }

    table.classList.remove("hidden");
    empty.classList.add("hidden");

    filtered.forEach(e => body.appendChild(buildRow(e)));
  }

  function buildRow(e) {
    const tr = document.createElement("tr");
    tr.appendChild(td(formatDateTime(e.timestamp), "cell-time"));
    tr.appendChild(td(e.date || "—"));
    const proj = document.createElement("td");
    proj.innerHTML =
      '<div class="cell-project"><span class="proj-num">' + escapeHtml(e.projectNumber || "—") + '</span>' +
      '<span class="proj-name">' + escapeHtml(e.projectName || "") + '</span></div>';
    tr.appendChild(proj);
    tr.appendChild(td(e.uploadedBy || "—"));

    const issues = document.createElement("td");
    if (e.spellingIssues) {
      issues.innerHTML = renderIssues(e.spellingIssues);
    } else {
      issues.innerHTML = '<span class="muted-cell">—</span>';
    }
    tr.appendChild(issues);

    tr.appendChild(td(e.notes || "", "cell-notes"));

    const img = document.createElement("td");
    if (e.fileUrl) {
      // Server returns paths relative to the app root (e.g. "/uploads/x.png");
      // prefix with the sub-app mount so the browser hits the right URL.
      const fullUrl = window.Api.imageUrl(e.fileUrl);
      img.innerHTML =
        '<a class="img-link" href="' + escapeAttr(fullUrl) + '" target="_blank" rel="noopener">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>' +
        ' View</a>';
    } else {
      img.innerHTML = '<span class="muted-cell">—</span>';
    }
    tr.appendChild(img);

    return tr;
  }

  function td(text, cls) {
    const el = document.createElement("td");
    el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }

  function renderIssues(s) {
    // Each piece is "word -> correction" separated by " | "
    return s.split("|").map(piece => {
      const m = piece.split("->");
      if (m.length === 2) {
        return '<span class="issue-chip"><span class="bad">' + escapeHtml(m[0].trim()) +
               '</span><span class="arrow">&rarr;</span><span class="good">' +
               escapeHtml(m[1].trim()) + '</span></span>';
      }
      return '<span class="issue-chip">' + escapeHtml(piece.trim()) + '</span>';
    }).join(" ");
  }

  function entryMatches(e, q) {
    return [
      e.uploadedBy, e.projectNumber, e.projectName,
      e.notes, e.spellingIssues, e.fileName, e.date
    ].some(v => v && String(v).toLowerCase().indexOf(q) >= 0);
  }

  function formatDateTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return date + " · " + time;
  }

  function setStatus(msg, kind) {
    const el = $("status");
    el.className = "status" + (kind ? " " + kind : "");
    el.textContent = msg || "";
  }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "[]") || []; }
    catch { return []; }
  }
  function writeCache(list) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify((list || []).slice(0, 500))); }
    catch {/* private mode etc. */}
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }
})();
