/**
 * api.js
 *
 * Talks to this app's own Express backend (server.js).
 *
 * Per OPERATIONS_PORTAL_NEW_APP_GUIDE Pitfall 4, every URL is prefixed with
 * `${API}` (the sub-app mount path) so the same code works locally
 * (`local.js` mounts at /shopfloor-mistakes) and in production
 * (operation.yotser.in/shopfloor-mistakes/).
 */
(function (global) {
  // The sub-app mount path. Matches the MOUNT in local.js and the
  // app.use('/shopfloor-mistakes', ...) line that will be inserted into the
  // main 5s-tracker server.js (Phase 4 of OPERATIONS_PORTAL_NEW_APP_GUIDE).
  const API = '/shopfloor-mistakes';

  function backendLabel() {
    return location.origin + API;
  }

  /**
   * Submit a new entry. Takes a plain object plus an `image` Blob.
   *
   *   {
   *     uploadedBy, projectNumber, projectName, date, notes,
   *     misspellings: [{ word, chosen }],
   *     image: Blob           // the (possibly annotated) PNG
   *     fileName: string      // hint for the server's stored filename
   *     idempotencyKey?       // optional; dedupes accidental double-submits
   *   }
   *
   * On success returns the full mistake row (id, fileUrl, ...).
   */
  async function submitEntry(payload) {
    if (!payload || !payload.image) {
      throw new Error('No image to upload.');
    }

    const fd = new FormData();
    fd.append('uploadedBy',    payload.uploadedBy || '');
    fd.append('projectNumber', payload.projectNumber || '');
    fd.append('projectName',   payload.projectName || '');
    fd.append('date',          payload.date || '');
    fd.append('notes',         payload.notes || '');
    fd.append('misspellings',  JSON.stringify(payload.misspellings || []));
    if (payload.idempotencyKey) fd.append('idempotencyKey', payload.idempotencyKey);
    fd.append('image', payload.image, payload.fileName || 'mistake.png');

    const res = await fetch(API + '/api/mistakes', {
      method: 'POST',
      body: fd,
      // Don't set Content-Type — the browser fills it in with the right
      // multipart boundary.
    });

    let json;
    try { json = await res.json(); }
    catch { throw new Error('Backend returned non-JSON response.'); }

    if (!res.ok || !json.ok) {
      throw new Error(json.error || ('Backend responded ' + res.status));
    }
    return json.mistake;     // server.js returns { ok, mistake }
  }

  /**
   * Fetch all entries (newest first).
   * Each entry has a `fileUrl` like "/uploads/xyz.png" — relative to API.
   * The caller (logs.js) is responsible for prefixing with `${API}` when
   * building the actual <a href>.
   */
  async function fetchEntries(query = '') {
    const url = API + '/api/mistakes' + (query ? '?q=' + encodeURIComponent(query) : '');
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error('Failed to load entries: ' + res.status + ' ' + res.statusText);
    }
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Unknown backend error.');
    return json.entries || [];
  }

  /**
   * Returns the absolute URL for an uploaded image. The server stores paths
   * relative to the app root (e.g. "/uploads/2026-05-07-abc.png"); we prefix
   * with ${API} so the browser hits /shopfloor-mistakes/uploads/...
   */
  function imageUrl(relPath) {
    if (!relPath) return '';
    if (/^https?:\/\//i.test(relPath)) return relPath;     // already absolute
    if (relPath[0] !== '/') relPath = '/' + relPath;
    return API + relPath;
  }

  // Health check — used during smoke testing.
  async function health() {
    const res = await fetch(API + '/api/health');
    if (!res.ok) throw new Error('Health check failed: ' + res.status);
    return res.json();
  }

  function isConfigured() { return true; }     // there's nothing to configure now
  function getBackendUrl() { return backendLabel(); }

  global.Api = {
    API,
    submitEntry,
    fetchEntries,
    imageUrl,
    health,
    isConfigured,
    getBackendUrl,
  };
})(window);
