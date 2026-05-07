/**
 * projects.js
 *
 * Project Number typeahead, per OPERATIONS_PORTAL_PROJECT_LOOKUP_GUIDE.md
 * (Pattern A — server-side search).
 *
 * The frontend calls `${API}/api/projects/search?q=…&limit=50`. That endpoint
 * is a thin proxy that loops back to the source-of-truth app at
 * http://localhost:3010/projects/api/work-orders.
 *
 * Today, this app's backend is Google Apps Script — there is no Express
 * Router and no loopback proxy. So the typeahead degrades gracefully:
 *
 *   - On focus / type, we call the proxy URL.
 *   - If it returns a non-JSON response (e.g. Apps Script's plain-text
 *     health-check) or we get a network/CORS error, we silently fall back
 *     to free-text mode — the input keeps working as a plain text field
 *     and the help text says "Projects app unavailable".
 *
 * When this app is later migrated to be an Express Router sub-app on
 * `operation.yotser.in`, add `/api/projects/search` to server.js per
 * Section A.1 of the lookup guide. No frontend changes will be needed.
 */

(function (global) {
  // Per OPERATIONS_PORTAL_NEW_APP_GUIDE Pitfall 4, every URL must be prefixed
  // with the sub-app's mount path. window.Api.API holds the same value the
  // server is mounted at — '/shopfloor-mistakes' in production and local dev.
  const SEARCH_URL = (window.Api && window.Api.API ? window.Api.API : "")
                   + "/api/projects/search";

  // State for race-condition guard: every search bumps `seq`; stale responses
  // whose seq is older than the current one are discarded.
  let timer = null;
  let seq = 0;
  let upstreamAvailable = null;   // null = unknown, true = ok, false = offline

  function attach(input) {
    if (!input) return;

    // The dropdown sits adjacent to the input inside the `.typeahead` field.
    const list = input.parentElement.querySelector(".typeahead-list");
    const help = input.parentElement.querySelector(".field-help");
    if (!list) return;

    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (help) help.textContent = q ? "Searching…" : "Loading latest work orders…";
      timer = setTimeout(() => runSearch(q, input, list, help), q ? 200 : 50);
    });

    input.addEventListener("focus", () => {
      if (!input.value.trim()) {
        if (help) help.textContent = "Loading latest work orders…";
        runSearch("", input, list, help);
      }
    });

    // Hide the dropdown on blur, but with a short delay so a click on a row
    // (which fires `mousedown` first) has time to register.
    input.addEventListener("blur", () => {
      setTimeout(() => list.classList.add("hidden"), 150);
    });
  }

  async function runSearch(q, input, list, help) {
    const my = ++seq;

    // If we already know the upstream is offline, don't keep hammering it —
    // just leave the input as a plain text field.
    if (upstreamAvailable === false) {
      list.classList.add("hidden");
      if (help) {
        help.classList.add("err");
        help.textContent = "Projects app unavailable — type the project number manually.";
      }
      return;
    }

    let resp;
    try {
      const r = await fetch(SEARCH_URL + "?q=" + encodeURIComponent(q) + "&limit=50", {
        credentials: "same-origin",
        headers: { "Accept": "application/json" }
      });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || !ct.includes("application/json")) {
        markUnavailable(list, help);
        return;
      }
      resp = await r.json();
    } catch (err) {
      markUnavailable(list, help);
      return;
    }

    if (my !== seq) return; // a newer search already started — discard.

    const projects = Array.isArray(resp.projects) ? resp.projects : [];
    upstreamAvailable = !!resp.ok;

    if (!resp.ok && !projects.length) {
      markUnavailable(list, help);
      return;
    }

    if (help) help.classList.remove("err");

    if (!projects.length) {
      list.innerHTML = q
        ? '<div class="proj-row empty">No work orders match "' + escapeHtml(q) + '".</div>'
        : '<div class="proj-row empty">No work orders available.</div>';
      list.classList.remove("hidden");
      if (help) help.textContent = q ? "0 matches" : "No work orders available";
      return;
    }

    list.innerHTML = projects.map(p =>
      '<div class="proj-row" data-id="' + escapeAttr(p.id) + '">' +
        '<div class="proj-row-head">' +
          '<div class="proj-row-id">' + escapeHtml(p.id) + '</div>' +
          (p.status ? '<div class="proj-row-status">' + escapeHtml(p.status) + '</div>' : '') +
        '</div>' +
        (p.name ? '<div class="proj-row-name">' + escapeHtml(p.name) + '</div>' : '') +
        ((p.customer || p.sales_rep)
          ? '<div class="proj-row-meta">' + escapeHtml([p.customer, p.sales_rep].filter(Boolean).join(" · ")) + '</div>'
          : '') +
      '</div>'
    ).join("");
    list.classList.remove("hidden");

    const total = Number(resp.total) || projects.length;
    if (help) {
      if (!q) {
        help.textContent = total > projects.length
          ? "Showing latest " + projects.length + " of " + total + " work orders — type to search."
          : "Showing all " + projects.length + " work orders.";
      } else {
        help.textContent = total > projects.length
          ? "Showing top " + projects.length + " of " + total + " matches — type more to narrow down."
          : projects.length + " match" + (projects.length === 1 ? "" : "es");
      }
    }

    // Wire the row clicks. mousedown fires BEFORE the input's blur so the
    // dropdown doesn't hide before the click registers.
    list.querySelectorAll(".proj-row[data-id]").forEach(row => {
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const picked = projects.find(p => p.id === row.dataset.id);
        if (!picked) return;
        input.value = picked.id;
        // Auto-fill project name when available — operator can still edit it.
        const nameInput = document.getElementById("projectName");
        if (nameInput && picked.name) nameInput.value = picked.name;
        list.classList.add("hidden");
        if (help) help.textContent = "Selected " + picked.id;
      });
    });
  }

  function markUnavailable(list, help) {
    upstreamAvailable = false;
    list.classList.add("hidden");
    list.innerHTML = "";
    if (help) {
      help.classList.add("err");
      help.textContent = "Projects app unavailable — type the project number manually.";
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  global.Projects = { attach };
})(window);
