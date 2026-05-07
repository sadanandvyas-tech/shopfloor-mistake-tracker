# Operations Portal — Project / Work-Order Lookup Pattern

**Version 1.0** · Distilled from the print-orders deployment (May 2026), which adopted the pattern that quotation-tracker first proved out.

This guide is the canonical reference for adding a **live, searchable Project Number / Work Order # field** (or any other cross-app lookup like Customer) to a sub-app on the Operations Portal. Reuse this verbatim; do **not** invent a new pattern.

---

## Table of Contents

1. [When to use this guide](#when-to-use-this-guide)
2. [Why this pattern](#why-this-pattern-over-the-alternatives)
3. [Architecture in one paragraph](#architecture-in-one-paragraph)
4. [Implementation A — Project / Work Order lookup (server-side search)](#implementation-a--project--work-order-lookup-server-side-search)
   1. [Server-side endpoint](#a1-server-side-endpoint-serverjs)
   2. [Client-side typeahead](#a2-client-side-typeahead-publicindexhtml)
   3. [Optional: keep an FDW view for JOINs](#a3-optional-keep-an-fdw-view-for-joins)
5. [Implementation B — Customer lookup (in-memory cache + client-side filter)](#implementation-b--customer-lookup-in-memory-cache--client-side-filter)
   1. [Server-side endpoint](#b1-server-side-endpoint-serverjs)
   2. [Client-side typeahead](#b2-client-side-typeahead-publicindexhtml)
6. [Choosing between A and B](#choosing-between-a-and-b)
7. [Setup checklist for a new app](#setup-checklist-for-a-new-app)
8. [Edge cases & gotchas](#edge-cases--gotchas)
9. [Testing checklist](#testing-checklist)
10. [Upstream API contract reference](#upstream-api-contract-reference)
11. [Document maintenance](#document-maintenance)

---

## When to use this guide

Use this when your sub-app needs a field that lets the user type-and-search against a **large dataset that already lives in another sub-app on the same portal**. Concretely:

- **Project Number / Work Order #** — the source of truth is the `projects-table` sub-app, which syncs from Zoho Creator (10,000+ records and growing).
- **Customer** — the source of truth is the `customer-list` sub-app, which syncs from Zoho Books (~1,000 records).
- **Any future master-data field** that follows the same shape (e.g. Vendors, SKUs, Sites).

Do **not** use this for fields whose data is local to your sub-app — those should be plain dropdowns or admin-managed tables in your own database.

Do **not** call Zoho directly from your sub-app — only the source-of-truth app talks to Zoho.

---

## Why this pattern (over the alternatives)

We considered three approaches and rejected two of them. Knowing why matters when the next person tries to "improve" things.

### Rejected: postgres_fdw (foreign data wrapper)

We tried this first in print-orders. It works, but:

- **No real search** — FDW gives you `SELECT ... WHERE ... LIKE` but every keystroke pulls partial-match rows across an inter-DB connection. Slow on 10K+ records and gets worse as Zoho keeps syncing.
- **Password lives in `pg_user_mappings`** — the foreign-DB password is stored (weakly hashed) inside Postgres metadata. One more place to rotate when passwords change.
- **Tight coupling to upstream schema** — if the source-of-truth app renames a column (`work_order_no` → `wo_no`), every consumer's foreign table breaks.
- **Cross-DB visibility** — FDW gives you a view that looks like a local table, which is great for `LEFT JOIN`s in list queries (we **kept** FDW in print-orders for that exact reason — see [A3](#a3-optional-keep-an-fdw-view-for-joins) below). But it is the wrong tool for typeahead UI.

### Rejected: live Zoho API on every keystroke

- Adds 200–800 ms latency per request (depending on Zoho's mood).
- Eats Zoho's API quota.
- Dies when Zoho is down or the OAuth token is mid-refresh.
- Couples every consumer app to Zoho credentials.

### Adopted: loopback proxy to the source-of-truth sub-app

- All sub-apps run inside one Node process on `localhost:3010`. A `fetch('http://localhost:3010/projects/api/work-orders?search=…')` from one sub-app to another is a same-process, same-event-loop call. Sub-100 ms, no network.
- The source-of-truth app already implements server-side search (across `work_order_no`, `company_name`, `wo_name`, `contact_person`, `phone_number`, `project_owner`, `po_number`). We get all that for free.
- Zoho credentials stay in one app.
- Outages degrade gracefully — the consumer sees `{ ok: false, projects: [], message: '…' }` and can fall back to a free-text input.

---

## Architecture in one paragraph

Every sub-app on the Operations Portal is an Express **Router** mounted into the main 5s-tracker process at `/var/www/5s-tracker/server.js` and listens on port 3010. Apps that own master data (`projects-table`, `customer-list`) expose JSON read endpoints on their sub-path. Consumer apps add a thin proxy endpoint that does an in-process `fetch` over the loopback (`http://localhost:3010/projects/api/work-orders`), normalises the response shape, and serves it to its own frontend. The frontend renders a typeahead that calls the consumer's proxy on each keystroke (debounced). The pattern is purely additive: the source-of-truth app doesn't need to know about its consumers.

```
┌──────────── Node process @ localhost:3010 ─────────────┐
│                                                          │
│  /projects/api/work-orders?search=…   ← projects-table  │
│         ▲          (source of truth, syncs from Zoho)   │
│         │                                                │
│         │ loopback fetch (sub-100ms)                     │
│         │                                                │
│  /<your-app>/api/projects/search?q=…  ← consumer proxy  │
│         ▲                                                │
│         │ HTTP                                           │
│  Browser → typeahead UI                                  │
└──────────────────────────────────────────────────────────┘
```

---

## Implementation A — Project / Work Order lookup (server-side search)

Use this when the dataset is too big to ship to the browser. Every keystroke = one fetch.

### A.1 — Server-side endpoint (`server.js`)

Drop the following block into your sub-app's `server.js`. Adjust the route prefix (`/api/projects/search`) only if you genuinely need a different URL.

```js
// =============================================================================
// PROJECTS — live search proxy to the Projects Table sub-app
// =============================================================================
//
// Both apps share the same Node process at localhost:3010, so we hit the
// projects-table app over the loopback. It has 10K+ records and proper
// server-side search across work_order_no, company_name, wo_name,
// contact_person, phone_number, project_owner, and po_number.
//
// Each keystroke is a fresh fetch (no cache); we cap at 50 results and
// surface a "Showing top N of M" hint when truncated.
//
// PROJECTS_API_URL env var lets you override the upstream URL — useful in
// local dev where the projects-table app might run on a different port,
// or in tests where you want to point at a stub.

const PROJECTS_API_CANDIDATES = [
  'http://localhost:3010/projects/api/work-orders',
];

async function fetchProjectsUpstream(q, limit) {
  const explicit = db.get('PROJECTS_API_URL');     // db.get() reads from your sub-app's .env
  const urls = explicit ? [explicit] : PROJECTS_API_CANDIDATES;
  const params = new URLSearchParams();
  if (q) params.set('search', q);
  params.set('limit', String(limit));
  params.set('page', '1');

  for (const base of urls) {
    try {
      const resp = await fetch(base + '?' + params.toString(),
                               { headers: { 'Accept': 'application/json' } });
      if (!resp.ok) continue;
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('application/json')) continue;

      const json = await resp.json();
      // The projects-table API returns { success, data, pagination }
      const list = Array.isArray(json.data)
        ? json.data
        : Array.isArray(json) ? json
        : Array.isArray(json.work_orders) ? json.work_orders
        : [];
      const total = (json.pagination && Number(json.pagination.total)) || list.length;

      // Normalise to a stable shape so frontend code never has to know about
      // upstream column names. If projects-table renames a column tomorrow,
      // only this normaliser changes.
      const normalised = list.map((r) => ({
        id:        r.work_order_no != null ? String(r.work_order_no) : '',
        name:      r.wo_name        || '',
        customer:  r.company_name   || '',
        sales_rep: r.project_owner  || '',
        status:    r.wo_status      || '',
        description: [r.work_category, r.wo_status, r.work_priority]
          .filter(Boolean).join(' · ') || null,
        due_date:  r.completion_date || null,
      })).filter(r => r.id && r.id.trim());   // drop rows with empty WO#

      return { ok: true, projects: normalised, total };
    } catch {
      // try next candidate
    }
  }
  return null;   // signals "upstream not reachable"
}

router.get('/api/projects/search', authRequired, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const data = await fetchProjectsUpstream(q, limit);
    if (data === null) {
      return res.json({
        ok: false, projects: [], total: 0,
        message: 'Projects app did not respond.',
      });
    }
    res.json(data);
  } catch (e) {
    console.error('[<your-app>] projects search error', e);
    res.json({ ok: false, projects: [], total: 0, message: e.message });
  }
});

// Single-project lookup by exact ID — useful for autofill on a pasted WO#.
// Goes through the same upstream search and picks the row whose ID matches.
router.get('/api/projects/:id', authRequired, async (req, res) => {
  try {
    const data = await fetchProjectsUpstream(req.params.id, 50);
    if (!data || !data.projects.length) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const exact = data.projects.find(p => p.id === req.params.id);
    if (!exact) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: exact });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

**Notes:**

- `authRequired` is your sub-app's auth middleware. The upstream call goes server-to-server over loopback so no cookie forwarding is needed; your endpoint just needs to gate its consumers.
- `db.get('PROJECTS_API_URL')` uses the same dotenv-isolated helper as `db.js` — see the main deployment guide's Section 1.2.
- The `.filter(r => r.id && r.id.trim())` drops rows where Zoho has an empty `work_order_no` (happens with newly-created records that haven't been numbered yet). Without this, the typeahead shows blank rows at the top of the list.

### A.2 — Client-side typeahead (`public/index.html`)

Drop this into your sub-app's frontend. The HTML is Tailwind-classed; if your app uses raw CSS, port the classes to your stylesheet.

#### HTML

```html
<div class="col-span-12">
  <label class="block text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2">
    Project Number <span class="text-red-500">*</span>
  </label>
  <div class="relative">
    <input id="project-search"
           autocomplete="off"
           placeholder="Type WO number, company, or project name to search…"
           class="w-full px-4 py-3 rounded-xl border-2 border-slate-200 focus:border-indigo-500 focus:outline-none text-sm font-mono"/>
    <div id="project-list"
         class="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200
                rounded-lg shadow-lg max-h-72 overflow-y-auto z-30 hidden"></div>
  </div>
  <div class="flex items-center justify-between mt-1.5">
    <small id="project-help" class="text-xs text-slate-500">
      Pulls live from the Projects Table — type to search across WO #, company, project name, owner, contact, PO #.
    </small>
  </div>
</div>
```

#### JavaScript

```js
// Project typeahead — proxies to the Projects Table sub-app via /api/projects/search.
// Server-side search across 10K+ rows; debounced 200ms; browse-on-focus shows latest 50.

let projectSearchTimer = null;
let projectSearchSeq = 0;     // monotonic counter — discard stale responses

function projectSearchHandler(e) {
  // Any typing breaks the locked-in selection until the user picks again.
  STATE.draftOrder.project = null;
  STATE.draftOrder.projectId = e.target.value.trim();
  clearTimeout(projectSearchTimer);
  const q = e.target.value.trim();
  $('#project-help').textContent = q ? 'Searching…' : 'Loading latest work orders…';
  projectSearchTimer = setTimeout(() => runProjectSearch(q), q ? 200 : 50);
}

async function runProjectSearch(q) {
  const seq = ++projectSearchSeq;
  const list = $('#project-list');
  const help = $('#project-help');
  if (!list) return;

  try {
    const resp = await fetch(API + '/api/projects/search?q=' + encodeURIComponent(q) + '&limit=50',
                             { credentials: 'same-origin' })
      .then(r => r.json());

    // If a newer search has started while we were waiting, discard this result.
    // Without this guard, a slow 200ms response can overwrite a fresher one.
    if (seq !== projectSearchSeq) return;

    const projects = Array.isArray(resp.projects) ? resp.projects : [];

    if (!resp.ok && !projects.length) {
      list.innerHTML = '<div class="px-3 py-3 text-sm text-slate-500 text-center">Projects app unavailable.</div>';
      list.classList.remove('hidden');
      help.textContent = resp.message || 'Could not reach Projects Table';
      return;
    }
    if (!projects.length) {
      list.innerHTML = q
        ? `<div class="px-3 py-3 text-sm text-slate-500 text-center">No work orders match "${q}".</div>`
        : `<div class="px-3 py-3 text-sm text-slate-500 text-center">No work orders available.</div>`;
      list.classList.remove('hidden');
      help.textContent = q ? '0 matches' : 'No work orders available';
      return;
    }

    list.innerHTML = projects.map(p => `
      <div class="px-3 py-2.5 hover:bg-indigo-50 cursor-pointer text-sm border-b border-slate-100 last:border-0 proj-row" data-id="${p.id}">
        <div class="flex items-center justify-between">
          <div class="font-mono font-semibold text-indigo-700">${p.id}</div>
          ${p.status ? `<div class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold">${p.status}</div>` : ''}
        </div>
        ${p.name ? `<div class="text-slate-800 truncate">${p.name}</div>` : ''}
        ${(p.customer || p.sales_rep) ? `<div class="text-xs text-slate-500 truncate">${[p.customer, p.sales_rep].filter(Boolean).join(' · ')}</div>` : ''}
      </div>
    `).join('');
    list.classList.remove('hidden');

    const total = Number(resp.total) || projects.length;
    if (!q) {
      help.textContent = total > projects.length
        ? `Showing latest ${projects.length} of ${total} work orders — type to search all.`
        : `Showing all ${projects.length} work orders.`;
    } else {
      help.textContent = total > projects.length
        ? `Showing top ${projects.length} of ${total} matches — type more to narrow down.`
        : `${projects.length} match${projects.length === 1 ? '' : 'es'}`;
    }

    // Wire row clicks. Use mousedown so it fires BEFORE the input's blur event
    // — otherwise the dropdown hides itself before the click registers.
    $$('.proj-row', list).forEach(row => {
      row.addEventListener('mousedown', e => {
        e.preventDefault();
        const picked = projects.find(p => p.id === row.dataset.id);
        if (!picked) return;
        STATE.draftOrder.project = picked;
        STATE.draftOrder.projectId = picked.id;
        list.classList.add('hidden');
        render();   // re-render to show the auto-filled project info card
      });
    });
  } catch (err) {
    if (seq !== projectSearchSeq) return;
    list.innerHTML = `<div class="px-3 py-3 text-sm text-red-600 text-center">Search failed: ${err.message}</div>`;
    list.classList.remove('hidden');
    help.textContent = 'Search failed';
  }
}

function attachProjectTypeahead() {
  const input = $('#project-search');
  const list  = $('#project-list');
  if (!input || !list) return;

  input.addEventListener('input', projectSearchHandler);

  // On focus with empty input, show the latest 50 (browse mode) so users
  // who don't remember a WO# can scroll through recent ones.
  input.addEventListener('focus', () => {
    if (!input.value.trim() && !STATE.draftOrder.project) {
      $('#project-help').textContent = 'Loading latest work orders…';
      runProjectSearch('');
    }
  });

  // Hide dropdown on blur (with a short delay so mousedown on items fires first).
  input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 150));
}
```

Call `attachProjectTypeahead()` at the bottom of whichever render function paints the form (e.g. `attachDraftHandlers()` in print-orders).

### A.3 — Optional: keep an FDW view for JOINs

If your sub-app stores **only the project ID** in its own tables (e.g. `work_orders.project_id TEXT`) and needs to display the project's name + customer in list views, you have two choices:

**Option 1 — Keep an FDW `projects` view (what print-orders does today).** Set up `postgres_fdw` once; your list query does `LEFT JOIN projects p ON p.id = your_table.project_id` and pulls name + customer cheaply. The view is purely for JOINs; the typeahead does NOT use it. See `print-orders/scripts/init-db.js` `setupProjectsView()` for the FDW setup, and the migration in `print-orders/README.md` for cross-DB FDW (when the source table lives in a different database).

**Option 2 — Denormalise on insert.** Add `project_name TEXT` and `project_customer TEXT` columns to your row. When the user submits, look up the project via your `/api/projects/:id` endpoint and store name + customer alongside the ID. No FDW needed. List queries become simple `SELECT *`.

**Recommendation:** Start with Option 1 if you already have FDW set up; migrate to Option 2 the next time you need to add a column to the source table (denormalisation insulates you from upstream schema churn).

---

## Implementation B — Customer lookup (in-memory cache + client-side filter)

Use this when the dataset is small enough (< ~5K records, or where each record is small) to fit in memory and ship to the browser once. Every keystroke = pure JS array filter, no fetch.

This is what `quotation-tracker` does for its Customer field. The customer-list app exposes the full customer list; the consumer caches it for 10 seconds and the frontend filters in JS.

### B.1 — Server-side endpoint (`server.js`)

```js
// =============================================================================
// CUSTOMERS — proxy to the customers app on the same portal
// =============================================================================
//
// We cache the customer list in memory for 10s — the upstream updates via
// webhook from Zoho Books, and a short cache means new customers appear in
// the dropdown almost immediately while still avoiding a roundtrip on every
// modal open.
//
// We pass ?status=active so deactivated customers don't clutter the dropdown.
// We deliberately do NOT pass ?limit — the customers app returns the full
// list when no limit is specified, which is what we want (typeahead filters
// client-side).

let _custCache = { at: 0, data: null };

async function fetchCustomersFromUpstream() {
  if (_custCache.data && (Date.now() - _custCache.at) < 10_000) {
    return _custCache.data;
  }
  const explicit = db.get('CUSTOMERS_API_URL');
  const QS = '?status=active';
  const candidates = explicit
    ? [explicit + (explicit.includes('?') ? '&status=active' : QS)]
    : [
        'http://localhost:3010/customers/api/customers' + QS,
        'http://localhost:3010/customers/api/list'      + QS,
        'http://localhost:3010/api/customers'           + QS,
      ];

  for (const url of candidates) {
    try {
      const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!resp.ok) continue;
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('application/json')) continue;
      const json = await resp.json();
      const list = Array.isArray(json)              ? json
                 : Array.isArray(json.customers)    ? json.customers
                 : Array.isArray(json.data)         ? json.data
                 : [];
      // Normalise — the customers app may use slightly different keys
      const normalised = list.map((c, i) => ({
        id:    String(c.id ?? c.contact_id ?? c.customer_id ?? c._id ?? i),
        name:  c.name ?? c.customer_name ?? c.contact_name ?? c.display_name ?? '',
        email: c.email ?? c.email_id ?? '',
        phone: c.phone ?? c.mobile ?? c.contact_number ?? '',
        gstin: c.gstin ?? c.gst_no ?? '',
        status: c.status ?? c.customer_status ?? 'active',
      })).filter(c => c.name);
      _custCache = { at: Date.now(), data: normalised };
      return normalised;
    } catch {
      // try next URL
    }
  }
  return null;
}

router.get('/api/customers', authRequired, async (_req, res) => {
  try {
    const data = await fetchCustomersFromUpstream();
    if (data === null) {
      return res.json({
        ok: false,
        message: 'Customers app did not return JSON. Falling back to manual entry.',
        customers: [],
      });
    }
    res.json({ ok: true, customers: data });
  } catch (e) {
    console.error('[<your-app>] customers proxy error', e);
    res.json({ ok: false, customers: [], message: e.message });
  }
});

// Force-refresh: bust the cache and re-fetch immediately. Useful for a
// "↻ Refresh" button next to the customer field, so users don't have to
// wait for the 10s cache to expire after adding a new customer in Zoho.
router.post('/api/customers/refresh', authRequired, async (_req, res) => {
  try {
    _custCache = { at: 0, data: null };
    const data = await fetchCustomersFromUpstream();
    if (data === null) {
      return res.json({ ok: false, message: 'Customers app did not return JSON.', customers: [] });
    }
    res.json({ ok: true, customers: data, refreshed_at: new Date().toISOString() });
  } catch (e) {
    res.json({ ok: false, customers: [], message: e.message });
  }
});
```

### B.2 — Client-side typeahead (`public/index.html`)

The frontend pulls the full customer list once on form-open and filters in JS.

```html
<div class="field">
  <label>Customer <span class="req">*</span></label>
  <div class="typeahead">
    <input type="text" id="customer-search" placeholder="Type to search customers…" required/>
    <input type="hidden" name="customer_id"/>
    <input type="hidden" name="customer_name"/>
    <div class="typeahead-list" id="customer-list"></div>
  </div>
  <div class="customer-help-row">
    <small class="help" id="customer-help">&nbsp;</small>
    <button type="button" class="btn-link" id="customer-refresh"
            title="Re-fetch customer list from Zoho Books">
      ↻ Refresh
    </button>
  </div>
</div>
```

```js
// Cache the full list once the modal opens.
const cache = { customers: [], customersOk: false };
async function loadCustomers() {
  const resp = await fetch(API + '/api/customers').then(r => r.json()).catch(() => ({ ok: false, customers: [] }));
  cache.customers   = resp.customers || [];
  cache.customersOk = !!resp.ok;
}

const custInput = $('#customer-search');
const custList  = $('#customer-list');

custInput.addEventListener('input', () => {
  $('form [name=customer_id]').value = '';   // typing breaks the lock
  $('form [name=customer_name]').value = custInput.value.trim();

  const q = custInput.value.trim().toLowerCase();
  const matches = cache.customers
    .filter(c => c.name.toLowerCase().includes(q))
    .slice(0, 50);

  if (!matches.length && !cache.customersOk) {
    // upstream offline — let the user save the typed name as-is
    custList.classList.remove('show');
    return;
  }
  if (!matches.length) {
    custList.innerHTML = `<div class="item empty">No customer matches "${q}". The name will be saved as-is.</div>`;
    custList.classList.add('show');
    return;
  }
  custList.innerHTML = matches.map(c => `
    <div class="item" data-id="${c.id}" data-name="${c.name}">
      <div><strong>${c.name}</strong></div>
      <div class="meta">${[c.email, c.phone, c.gstin].filter(Boolean).join(' · ')}</div>
    </div>`).join('');
  custList.classList.add('show');

  $$('.item', custList).forEach(item => {
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      $('form [name=customer_id]').value = item.dataset.id;
      $('form [name=customer_name]').value = item.dataset.name;
      custInput.value = item.dataset.name;
      custList.classList.remove('show');
    });
  });
});

custInput.addEventListener('blur', () => setTimeout(() => custList.classList.remove('show'), 150));

// "↻ Refresh" button next to the help row
$('#customer-refresh').addEventListener('click', async () => {
  const resp = await fetch(API + '/api/customers/refresh', { method: 'POST' }).then(r => r.json());
  cache.customers   = resp.customers || [];
  cache.customersOk = !!resp.ok;
  $('#customer-help').textContent = cache.customersOk
    ? `${cache.customers.length} customers loaded — start typing to filter`
    : 'Customer list unavailable — type customer name manually';
});
```

---

## Choosing between A and B

| Question | Use A (server-side) | Use B (in-memory) |
|---|---|---|
| Dataset size? | > 5,000 records or growing fast | < 5,000 stable records |
| Per-record size? | Could include long text fields | Compact (id, name, a few short fields) |
| Search needs? | Multi-column search across many fields | Single-column substring match is enough |
| Update frequency? | Updates need to be visible immediately | 10-second staleness is acceptable |
| Memory cost on the browser? | Don't ship 10K records to the browser | Fine to ship 1K records once |

If in doubt, **start with A**. The cost of an extra `fetch` per keystroke is invisible on the loopback; the cost of shipping a million records to a phone over 4G is not.

---

## Setup checklist for a new app

When you're adding a Project Number field (or Customer field, or any other cross-app lookup) to a sub-app:

1. [ ] **Pick A or B** based on the table above.
2. [ ] **Confirm the upstream URL.** For projects: `http://localhost:3010/projects/api/work-orders`. For customers: `http://localhost:3010/customers/api/customers`. Test it manually first: `curl http://localhost:3010/projects/api/work-orders?search=test\&limit=3` from the VPS shell. Should return JSON with a `data` array.
3. [ ] **Copy the server-side block** (A.1 or B.1) into your sub-app's `server.js`. Keep the comments — they answer the "why is this so weird" questions.
4. [ ] **Copy the client-side block** (A.2 or B.2) into your sub-app's `public/index.html`. Adjust selectors if your form uses different IDs.
5. [ ] **Wire up the attach function.** For pattern A, call `attachProjectTypeahead()` from whatever function paints your form. For pattern B, call `loadCustomers()` when the modal opens.
6. [ ] **Add an env override.** In `.env.example`, add `# PROJECTS_API_URL=` (or `CUSTOMERS_API_URL=`) so it's discoverable. Leave the value blank — the default loopback URL will be used.
7. [ ] **Test with the upstream stopped.** Stop the source app (`pm2 stop projects-table`) — your typeahead should show "Projects app unavailable" gracefully, not a stack trace.
8. [ ] **Test the "Showing N of M" hint** with both empty and non-empty queries.
9. [ ] **Test the autofill on selection** — click a row, the upstream's record fields should land in your form.
10. [ ] **(For pattern A) Decide JOIN strategy.** If you store the project ID and need to display its name elsewhere, either set up FDW (option 1) or denormalise (option 2) — see [A.3](#a3-optional-keep-an-fdw-view-for-joins).
11. [ ] **Update your `.gitignore` and `.env.example`** to keep the new env vars out of git.
12. [ ] **Push, pull on VPS, restart PM2** per the deployment guide.

---

## Edge cases & gotchas

These are the bugs we already hit. The templates above already work around them.

### 1. Race conditions — slower responses overwrite newer ones

**Symptom:** User types fast, the dropdown briefly shows the wrong results.
**Fix:** The `projectSearchSeq` counter in A.2. Every search increments it; when a response comes back, we discard it if a newer search has started.

### 2. `mousedown` vs `click` — the dropdown closes before the click fires

**Symptom:** Clicking a row in the dropdown does nothing; the dropdown just closes.
**Cause:** `blur` fires before `click`. By the time `click` resolves, the dropdown is hidden and detached.
**Fix:** Use `mousedown` on the row + `e.preventDefault()` to suppress the focus shift. Then close the dropdown explicitly inside the handler.

### 3. Blur timing — dropdown disappears mid-click

**Symptom:** Same as above, but the user sees a flash.
**Fix:** Wrap the dropdown-hide-on-blur in a `setTimeout(…, 150)` so any in-flight mousedown has time to fire.

### 4. Empty `work_order_no` rows show as blank

**Symptom:** First row of the typeahead has empty WO# and no status badge.
**Cause:** Zoho returns rows where `work_order_no` is `0`, `""`, or just whitespace.
**Fix:** The `.filter(r => r.id && r.id.trim())` in the normaliser. Don't be too lenient — empty WO# = unusable record.

### 5. Upstream returns HTML instead of JSON (404 page)

**Symptom:** Frontend errors with "Unexpected token < in JSON at position 0".
**Cause:** Sub-app isn't mounted, or the URL is wrong, and Express's SPA-fallback is serving `index.html` for the API path.
**Fix:** Check `Content-Type: application/json` in the proxy before parsing. Already in the templates.

### 6. CORS / cookies on the loopback

**Symptom:** None expected — the loopback is same-origin from the server's perspective.
**Note:** Don't try to forward the user's cookie to the upstream call. The upstream calls are server-to-server. Auth on the consumer endpoint protects the data; the upstream doesn't need to re-authenticate.

### 7. PM2 restart needed when proxy code changes

**Symptom:** Server returns old behaviour after `git pull`.
**Cause:** `server.js` was changed, and PM2 needs to re-`require()` it.
**Fix:** `pm2 restart 5s-tracker` after any change to a sub-app's `server.js`. Frontend-only changes (`public/index.html`) don't require a PM2 restart — Express serves them fresh on each request.

### 8. Env overrides not picked up

**Symptom:** `PROJECTS_API_URL` set but the proxy still hits the default.
**Cause:** Sub-apps must use the dotenv-isolated pattern from `db.js` to read `.env`. Don't rely on `process.env` directly — see Section 1.2 of the main deployment guide.
**Fix:** Use `db.get('PROJECTS_API_URL')` inside the sub-app, never bare `process.env.PROJECTS_API_URL`.

---

## Testing checklist

After deployment, smoke-test the typeahead in this order. Each step should pass before moving on.

1. **Empty input on focus → shows latest 50 rows.** Help text says "Showing latest 50 of N work orders".
2. **Type a known WO# → filters to that one row.** Help text says "1 match".
3. **Type a known company name (e.g. "Tetra") → multiple matches.** Help text says "N matches".
4. **Type 1 character → ≥ 50 matches.** Help text says "Showing top 50 of M matches — type more to narrow down".
5. **Click a row → dropdown closes, the auto-fill card populates.** Hidden inputs hold the picked record.
6. **Submit the form with the picked record → server saves it.** List view shows the project name + customer.
7. **Submit the form with just a typed WO# (no click) → still works** (the server-side search resolves it on save). Optional but good UX.
8. **Stop the upstream app (`pm2 stop projects-table`) → typeahead shows "Projects app unavailable" gracefully.** Restart it and the typeahead recovers within one keystroke.
9. **Clear browser cache + reload → typeahead still works** (no stale code).

---

## Upstream API contract reference

For convenience, here's what the source-of-truth apps return today. If they ever change, update only the `normalised = list.map(...)` block in your proxy.

### `projects-table`'s `/projects/api/work-orders`

Query params: `search` (free text), `limit` (1–200, default 50), `page` (1-based).

Response:
```json
{
  "success": true,
  "data": [
    {
      "id": 11072,
      "zoho_id": "98386000022038203",
      "auto_number": "11713",
      "work_order_no": 10508,
      "work_order_date": "20-Apr-2026",
      "project_owner": "Yash Sonar",
      "company_name": "Tetra Pak India Pvt. Ltd.",
      "wo_name": "Aluminium Foil Prepration",
      "contact_person": "yash sonar",
      "phone_number": "+919421078255",
      "work_category": "Video",
      "wo_status": "Orders",
      "project_status": "",
      "work_priority": "",
      "start_date": "20-Apr-2026",
      "completion_date": "",
      "po_number": "",
      "raw_json": { /* full Zoho record */ }
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 10422 }
}
```

### `customer-list`'s `/customers/api/customers`

Query params: `status` (active|inactive|all).

Response shape varies (one of `Array | { customers: Array } | { data: Array }`); the normaliser in B.1 handles all three. Each row has at least `id` and `name`; `email`, `phone`, `gstin`, `status` are best-effort.

---

## Document maintenance

When this guide turns out to be wrong, outdated, or incomplete, **fix it before the next sub-app adopts the pattern**. A stale guide is worse than no guide.

Common reasons for updates:

- **Upstream API contract changed** — update the response example + the normaliser block in A.1 / B.1.
- **A new gotcha discovered** — add to [Edge cases & gotchas](#edge-cases--gotchas) with symptom + cause + fix.
- **A new source-of-truth app exposed** — add a new section between A and B (e.g. "Implementation C — Vendor lookup") with the same structure.
- **A consumer migrated from FDW to denormalised** — update [A.3](#a3-optional-keep-an-fdw-view-for-joins) with the lessons learned.

End of guide.
