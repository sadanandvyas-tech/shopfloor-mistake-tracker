# Operations Portal — Cross-App Integration Guide

**Version 1.0** · Companion to `OPERATIONS_PORTAL_NEW_APP_GUIDE.md` and `Operations-Portal-Deployment-Guide.docx`.
This guide covers the *exact procedure* for letting one sub-app read or write data from another. The deployment guide covers how to add a new sub-app; this one covers how to wire data between apps so the portal behaves as one product instead of eight isolated screens.

---

## Table of Contents

1. [When to use this guide](#when-to-use-this-guide)
2. [The integration model in one paragraph](#the-integration-model-in-one-paragraph)
3. [The eight apps and what each owns](#the-eight-apps-and-what-each-owns)
4. [The data-flow map](#the-data-flow-map)
5. [Naming conventions for cross-app calls](#naming-conventions-for-cross-app-calls)
6. [The three integration patterns](#the-three-integration-patterns)
7. [Pattern A — Internal REST (the default)](#pattern-a--internal-rest-the-default)
8. [Pattern B — Snapshot-on-write](#pattern-b--snapshot-on-write)
9. [Pattern C — Event hooks](#pattern-c--event-hooks)
10. [Per-app integration matrix](#per-app-integration-matrix)
11. [Worked example — survey to quotation to work order](#worked-example--survey-to-quotation-to-work-order)
12. [Boilerplate templates](#boilerplate-templates)
13. [Error handling and resilience](#error-handling-and-resilience)
14. [Schema migrations needed in existing apps](#schema-migrations-needed-in-existing-apps)
15. [Pitfalls and lessons learned](#pitfalls-and-lessons-learned)
16. [Rollout plan — order of integrations](#rollout-plan--order-of-integrations)
17. [Quick-reference snippets](#quick-reference-snippets)

---

## When to use this guide

Use this when a sub-app needs to:

- Display data that lives in another sub-app (for example, the quotation-tracker showing a dropdown of customers from the customer-list)
- Pre-fill a form with data captured upstream (for example, the production-tracker creating a work order from a confirmed quotation)
- React when something changes in another sub-app (for example, the inventory-tracker decreasing stock when an installation is marked done)
- Show a dashboard that aggregates across apps (for example, "all active customers with their open leads, in-flight work orders, and scheduled installs")

Do NOT use this guide for:

- Adding a brand new sub-app from scratch — start with `OPERATIONS_PORTAL_NEW_APP_GUIDE.md` and come back here once the app is deployed
- Integrations with external services (Zoho Books, Zoho Creator, Bigin) — those use vendor webhooks and SDK clients, which are documented in each app's own README
- One-off data exports (CSV, Excel) — those don't need an integration layer, just an endpoint that streams the export

---

## The integration model in one paragraph

Every sub-app already exposes an Express `Router` mounted under a sub-path on the same Node process (port 3010). That means any sub-app can call any other sub-app via plain HTTP at `http://localhost:3010/<other-path>/api/...` with zero networking, zero auth, and zero new infrastructure. We treat each sub-app as the **owner of its data** and require other apps to fetch through its REST API rather than reaching into its Postgres database directly. Database isolation stays as it is today (one DB per app, all owned by `fivesuser`). When app A needs a record from app B, A calls B's `GET /api/<resource>/:id`. When A creates something derived from B (e.g. a work order from a quotation), A also stores a denormalized snapshot of B's display fields so A stays readable even if B is offline. Cross-app writes are rare — when they happen (for example, `POST /production/api/work-orders` from a "Confirm" button in the quotation-tracker), they go through the same REST surface.

---

## The eight apps and what each owns

This is the canonical "who owns what" table. Before you wire anything, find the owner — that's whose API you call. If two apps look like they own the same concept, fix that first by picking one and migrating the other.

| App | Owns | Identifier other apps reference | Currently calls |
|---|---|---|---|
| **customer-list** | Customer master (synced from Zoho Books) | `zoho_contact_id` (canonical) and `id` | nothing — pure source of truth |
| **visit-scheduler** | Visit requests (intent to visit a client) | `id` | nothing yet — should look up customer-list by name/phone |
| **site-survey-register** | On-site surveys with measurements, work items, photos | `survey_no` (UNIQUE) and `id` | nothing yet — should pull customers + materials from upstream |
| **quotation-tracker** | Sales pipeline / leads | `id` | already designed to reference customer_id and wo_number |
| **production-tracker** | Manufacturing work orders with stage tracking | `wo_number` (UNIQUE) and `id` | nothing yet — should pull customers + consume materials |
| **simple-installation-scheduler** | Site install scheduling (graphics / boards / LED) | `id` | nothing yet — should pull customers + work orders |
| **inventory-tracker** | Materials master + issue slips (stock movements) | material `id` and `name` | nothing yet — should expose endpoints for production + install to consume |
| **5S Daily Tracker** | Operations hygiene observations by zone | `id` | hosts the portal at `/`; otherwise standalone |

A few important subtleties this table makes obvious:

The customer-list is the master for **customer identity**. Every other app that mentions a customer should store the customer's `zoho_contact_id` (or the customer-list `id`) and look up the display fields via API. Today most apps just store a TEXT customer name — that needs to migrate (see [Schema migrations needed in existing apps](#schema-migrations-needed-in-existing-apps)).

The site-survey-register currently has its OWN `materials` and `surface_types` tables. That's fine for survey-time choices ("what surface are we mounting on"), but the **physical materials inventory** lives in the inventory-tracker. Don't merge them — they answer different questions.

The quotation-tracker already references `customer_id` (TEXT) and `wo_number` (TEXT). It is the only existing app designed for cross-app references. Use its schema as the model.

The 5S tracker is orthogonal to the core sales-to-install flow. It can record observations against any zone, including issues spotted during production or installation. We don't currently link 5S observations to specific work orders or installs — that's a future enhancement and out of scope for v1 of this guide.

---

## The data-flow map

The natural shape of the operations business is a left-to-right pipeline from "a customer needs something" to "we installed it and closed the loop":

```
                                   ┌─────────────────┐
                                   │  customer-list  │  ◄── Zoho Books webhook
                                   │  (master data)  │
                                   └────────┬────────┘
                                            │  read by every downstream app
            ┌───────────────────────────────┼───────────────────────────────┐
            ▼                               ▼                               ▼
   ┌─────────────────┐              ┌─────────────────┐            ┌─────────────────┐
   │ visit-scheduler │ ──────────► │  site-survey-   │ ─────────► │  quotation-     │
   │  (intent log)   │  promote    │   register      │  promote   │  tracker        │
   │                 │  to survey  │  (measurements) │  to lead   │  (sales pipe)   │
   └─────────────────┘              └─────────────────┘            └────────┬────────┘
                                                                            │ stage = won
                                                                            ▼
                                                                  ┌─────────────────┐
                                                                  │  production-    │
                                                                  │  tracker        │
                                                                  │  (work orders)  │
                                                                  └────────┬────────┘
                                                                            │ stage = ready-to-install
                                                                            ▼
                                                                  ┌─────────────────┐
                                                                  │ simple-         │
                                                                  │ installation-   │
                                                                  │ scheduler       │
                                                                  └────────┬────────┘
                                                                            │
                                                                            ▼
                                                                  ┌─────────────────┐
                                                                  │  done — close   │
                                                                  │  the loop       │
                                                                  └─────────────────┘

   Cross-cutting:
       inventory-tracker  ◄── consumed by production-tracker (issue slips per WO)
                          ◄── consumed by simple-installation-scheduler (consumables on site)
       5S Daily Tracker   — orthogonal: observations against any zone, any time
```

The arrows labelled "promote" mean a user clicks a button in the upstream app that creates a record in the downstream app, with all the relevant fields pre-filled. That's the most common cross-app interaction — we'll work through one end-to-end in the [Worked example](#worked-example--survey-to-quotation-to-work-order) section.

---

## Naming conventions for cross-app calls

These extend the conventions in the deployment guide. Following them keeps the URL surface predictable across apps so anyone reading code can guess where things live.

| Item | Convention | Example |
|---|---|---|
| Public REST resource | plural noun, kebab-case | `GET /customers/api/customers` |
| Single-record fetch | `/api/<resource>/:id` | `GET /customers/api/customers/42` |
| Lookup by external key | `/api/<resource>/lookup?<key>=<val>` | `GET /customers/api/customers/lookup?zoho_contact_id=ABC` |
| Snapshot field name | `<entity>_<field>_snapshot` | `customer_name_snapshot` |
| Foreign-key column | `<other_app>_<entity>_id` | `customer_id`, `wo_id` |
| Webhook receiver path | `/api/hooks/<source>` | `POST /production/api/hooks/quotation-won` |
| Internal helper module | `clients/<other-app>.js` | `clients/customer-list.js` |
| Cross-app HTTP timeout | 5 seconds for reads, 15 for writes | (see template) |
| Cache header on lists | `Cache-Control: private, max-age=30` | (server-side) |

The snapshot field convention is important. When app A creates a record that references app B, A should store both `b_id` (the foreign key, source of truth) and `b_<display_field>_snapshot` (a denormalized copy of the fields users actually see in A's UI). The snapshot makes A readable when B is down and lets A render its own list views without N+1 fetches. The snapshot is **never** the source of truth — when a user expands a row to see live details, A re-fetches from B.

---

## The three integration patterns

We use three patterns. Most integrations are A. B is only for cross-app **writes**. C is for change notifications.

| Pattern | When to use | Example |
|---|---|---|
| **A — Internal REST** | Reading data from another app at request time | Quotation-tracker shows a customer dropdown by calling `GET /customers/api/customers?active=1` |
| **B — Snapshot-on-write** | Creating a record in app B from a button in app A | "Confirm Lead" in quotation-tracker calls `POST /production/api/work-orders` and stores the new `wo_number` back on the lead |
| **C — Event hooks** | Reacting to a state change in another app | Inventory-tracker subscribes to "installation-completed" and decreases stock for consumables |

Pick the pattern by asking: *What direction does the data flow, and is it driven by a user action or a state change?*

- User clicks a button to see something → A
- User clicks a button to create something → B
- A state change in app X needs to update app Y, no user clicking → C

---

## Pattern A — Internal REST (the default)

This is how 90% of integrations work. App A wants to display data owned by app B. App B exposes `GET` endpoints under `/api/`. App A calls them server-side using a small wrapper.

### A.1 Where to call from — server, not browser

Always make cross-app HTTP calls from app A's **server** (in its router), not from the browser. Two reasons:

1. The browser request is `https://operation.yotser.in/...`. That's the Nginx proxy, not localhost. Going browser-to-Nginx-back-to-Express adds latency and TLS overhead. Server-side calls go straight to `localhost:3010`, which is in-process for routing purposes and adds <1 ms.
2. We want the browser to see one combined response. If app A's frontend has to make 5 separate fetches to 5 sub-apps, the page is slow and the failure modes multiply. App A's server fetches everything, composes one JSON, returns one response.

### A.2 The HTTP client wrapper

Every app that needs to call other apps gets a `clients/` folder with one file per app it talks to. Use Node 20's built-in `fetch` — no axios, no node-fetch, no extra dependency.

`clients/customer-list.js` (template):

```js
// Server-side client for the customer-list sub-app.
// Always call from this app's router, never from the browser.

const BASE = process.env.PORTAL_INTERNAL_BASE || 'http://localhost:3010';
const PREFIX = '/customers';
const TIMEOUT_MS = 5000;

async function request(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${PREFIX}${path}`, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-internal-call': 'true',          // marks the call as cross-app, not browser
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`customer-list ${path} -> ${res.status} ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  // List active customers, optional name filter
  list: (q = '') => request(`/api/customers?active=1&q=${encodeURIComponent(q)}`),

  // Single customer by internal id
  get: (id) => request(`/api/customers/${encodeURIComponent(id)}`),

  // Lookup by Zoho contact id (the canonical external key)
  byZohoId: (zohoId) =>
    request(`/api/customers/lookup?zoho_contact_id=${encodeURIComponent(zohoId)}`),
};
```

The `x-internal-call: true` header is a convention — receiving apps can use it to skip browser-only middleware (CSRF, rate limits) or to log internal vs. external traffic separately. It is **not** an authentication mechanism. Auth is unnecessary here because the Node process is the only thing that can hit `localhost:3010`.

### A.3 Using the client in your router

```js
// in production-tracker/server.js, when listing work orders,
// fetch the live customer name for each (or, ideally, fetch in bulk).
const customers = require('./clients/customer-list');

router.get('/api/work-orders', async (req, res, next) => {
  try {
    const { rows: orders } = await db.query(`SELECT * FROM work_orders ORDER BY created_at DESC LIMIT 100`);

    // De-dupe customer ids and fetch in one batch when possible.
    // For now, fetch one by one only if there's no snapshot stored.
    const enriched = await Promise.all(orders.map(async (wo) => {
      if (wo.customer_name_snapshot) return wo;     // already cached locally
      if (!wo.customer_id) return wo;
      try {
        const c = await customers.get(wo.customer_id);
        return { ...wo, customer_name_snapshot: c.customer_name };
      } catch {
        return wo;                                   // graceful degradation
      }
    }));

    res.json(enriched);
  } catch (err) { next(err); }
});
```

### A.4 Caching to avoid hammering

A list of 100 work orders that each fetch their customer means 100 HTTP calls. Two ways to fix:

1. **Best:** add a bulk-fetch endpoint to the owning app: `GET /customers/api/customers?ids=1,2,3,4`. The receiver loads all in one query.
2. **Acceptable for low traffic:** wrap the client in an in-memory LRU with 30-second TTL. The `lru-cache` npm package is 5 KB and zero-dep.

Don't reach for Redis or anything heavier. We're a single-process Node app — in-process caching is fine.

### A.5 Receiving end — what the owning app must expose

Every sub-app that owns data others need should expose, at minimum:

```
GET  /api/<resource>            list with optional ?q=, ?active=, ?ids=1,2,3, ?limit=, ?offset=
GET  /api/<resource>/:id        single full record
GET  /api/<resource>/lookup     lookup by external key (?zoho_contact_id=, ?wo_number=, etc.)
GET  /api/health                {"ok": true}
```

The list endpoint must support `?ids=` for bulk fetch. This is the single most important addition because it turns N+1 queries into one query.

---

## Pattern B — Snapshot-on-write

When app A creates a record in app B, A is acting as a client that POSTs to B's API. Three things to get right:

1. **Idempotency.** A might double-click. B's POST handler must accept an optional `idempotency_key` and return the same record if called twice with the same key.
2. **Snapshot back into A.** Once B returns the new record, A stores B's id (`wo_number` etc.) AND a snapshot of the display fields, so A's list views don't have to fetch back.
3. **Compensating action on failure.** If B's POST succeeds but A's UPDATE fails, you have an orphan in B. Either rerun the UPDATE on retry, or expose a `DELETE /api/<resource>/:id?reason=rollback` on B.

### B.1 The receiver — accepting an inbound write

```js
// in production-tracker/server.js
router.post('/api/work-orders', async (req, res, next) => {
  try {
    const {
      idempotency_key,
      customer_id,
      customer_name_snapshot,
      title,
      description,
      priority = 'Medium',
      target_date,
      source = 'manual',                 // 'manual' | 'quotation-tracker' | ...
      source_ref,                         // free-text reference back to source (e.g. lead id)
    } = req.body || {};

    // 1. Idempotency check
    if (idempotency_key) {
      const { rows } = await db.query(
        `SELECT * FROM work_orders WHERE idempotency_key = $1 LIMIT 1`,
        [idempotency_key]
      );
      if (rows[0]) return res.json(rows[0]);
    }

    // 2. Generate a wo_number (existing app convention)
    const wo_number = await nextWoNumber();   // YYYY-NNNN style; implement once

    // 3. Insert
    const { rows: [wo] } = await db.query(
      `INSERT INTO work_orders
         (wo_number, title, customer, customer_id, customer_name_snapshot,
          description, priority, target_date, source, source_ref, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [wo_number, title, customer_name_snapshot, customer_id, customer_name_snapshot,
       description, priority, target_date, source, source_ref, idempotency_key]
    );

    res.status(201).json(wo);
  } catch (err) { next(err); }
});
```

### B.2 The caller — initiating the write

```js
// in quotation-tracker/server.js, "Confirm Lead" handler
const production = require('./clients/production-tracker');

router.post('/api/leads/:id/confirm', async (req, res, next) => {
  try {
    const lead_id = +req.params.id;
    const { rows: [lead] } = await db.query(`SELECT * FROM qt_leads WHERE id = $1`, [lead_id]);
    if (!lead) return res.status(404).json({ error: 'lead not found' });

    // Build the WO payload from the lead
    const wo = await production.createWorkOrder({
      idempotency_key: `qt-lead-${lead_id}`,        // dedupes if the user double-clicks
      customer_id:     lead.customer_id,
      customer_name_snapshot: lead.customer_name,
      title:           lead.remarks?.slice(0, 80) || `Lead #${lead_id}`,
      description:     lead.remarks || '',
      priority:        'Medium',
      source:          'quotation-tracker',
      source_ref:      String(lead_id),
    });

    // Stamp the new wo_number back on the lead, plus mark the stage as won.
    await db.query(
      `UPDATE qt_leads
          SET wo_number = $1, wo_name = $2, stage_id = (SELECT id FROM qt_stages WHERE is_terminal_won LIMIT 1),
              closed_at = NOW()
        WHERE id = $3`,
      [wo.wo_number, wo.title, lead_id]
    );

    res.json({ lead_id, wo_number: wo.wo_number });
  } catch (err) { next(err); }
});
```

The `idempotency_key` of `qt-lead-${lead_id}` is the trick. If the user double-clicks Confirm, the second POST returns the same WO instead of creating a duplicate.

### B.3 The client wrapper for writes

`clients/production-tracker.js`:

```js
const BASE = process.env.PORTAL_INTERNAL_BASE || 'http://localhost:3010';
const PREFIX = '/production';

async function call(path, body) {
  const res = await fetch(`${BASE}${PREFIX}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-call': 'true' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`production-tracker ${path} -> ${res.status}`);
  return res.json();
}

module.exports = {
  createWorkOrder: (payload) => call('/api/work-orders', payload),
};
```

---

## Pattern C — Event hooks

Pattern C is for "something changed in app X, app Y wants to know". We do NOT introduce a message queue — we use a tiny dispatcher inside the 5s-tracker process.

### C.1 The dispatcher — `event-bus.js` in the main 5s-tracker

Add this to `/var/www/5s-tracker/event-bus.js`:

```js
// In-process event bus. Sub-apps require this module and use:
//   bus.publish('lead.won', { lead_id, customer_id, wo_number })
//   bus.subscribe('lead.won', (payload) => { ... })
//
// Subscribers run async; one subscriber failing does not block others.
// All events are also written to the operations_events table for replay/audit.

const { EventEmitter } = require('events');
const db = require('./db');                 // 5s-tracker's own DB

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

async function publish(event, payload) {
  // 1. Audit log (best-effort; never crashes the publisher)
  db.query(
    `INSERT INTO operations_events (event, payload, published_at)
     VALUES ($1, $2, NOW())`,
    [event, JSON.stringify(payload)]
  ).catch((e) => console.error('[event-bus] audit insert failed', e));

  // 2. Fan out to subscribers
  setImmediate(() => emitter.emit(event, payload));
}

function subscribe(event, handler) {
  emitter.on(event, async (payload) => {
    try { await handler(payload); }
    catch (err) { console.error(`[event-bus] handler for ${event} failed`, err); }
  });
}

module.exports = { publish, subscribe };
```

The `operations_events` table lives in the 5s-tracker DB and is the audit log:

```sql
CREATE TABLE IF NOT EXISTS operations_events (
  id            SERIAL PRIMARY KEY,
  event         TEXT NOT NULL,
  payload       JSONB,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_operations_events_event_time
  ON operations_events (event, published_at DESC);
```

### C.2 Publishing an event

In any sub-app:

```js
const bus = require('/var/www/5s-tracker/event-bus');

// after marking an installation as done
bus.publish('installation.completed', {
  installation_id: install.id,
  wo_number:       install.wo_number,
  customer_id:     install.customer_id,
  completed_at:    new Date().toISOString(),
});
```

### C.3 Subscribing to an event

In any sub-app's bootstrap (do this once, at module load):

```js
const bus = require('/var/www/5s-tracker/event-bus');
const inventory = require('./clients/inventory-tracker');

bus.subscribe('installation.completed', async (payload) => {
  // Subtract on-site consumables from stock
  await inventory.recordIssue({
    source: 'install-' + payload.installation_id,
    items: [{ name: 'Mounting screws', quantity: 8 }],
  });
});
```

### C.4 The canonical event names

Keep the list short. Add new events sparingly — every event is a contract.

| Event | Published by | Payload | Subscribed by |
|---|---|---|---|
| `customer.created` | customer-list | `{ id, zoho_contact_id, customer_name }` | (future: a CRM dashboard) |
| `customer.updated` | customer-list | `{ id, zoho_contact_id, changed_fields[] }` | downstream apps that cache snapshots |
| `survey.completed` | site-survey-register | `{ survey_no, customer_id }` | (future: auto-create a quotation lead) |
| `lead.won` | quotation-tracker | `{ lead_id, customer_id, wo_number }` | (audit only — production-tracker is created via Pattern B) |
| `wo.completed` | production-tracker | `{ wo_number, customer_id }` | simple-installation-scheduler (suggest scheduling install) |
| `installation.completed` | simple-installation-scheduler | `{ installation_id, wo_number }` | inventory-tracker (deduct consumables), 5S (optional follow-up) |
| `inventory.low` | inventory-tracker | `{ material_id, name, current_stock, minimum_qty }` | (future: notification dashboard) |

If you need a new event, add a row to this table in this guide before writing code, so the contract exists in writing.

---

## Per-app integration matrix

This is the cheat-sheet for "what does X need from Y". Read row-by-row.

### customer-list

- **Reads from:** nothing internal (it consumes Zoho via webhook)
- **Reads it:** every other app
- **Must expose:** `GET /api/customers`, `GET /api/customers/:id`, `GET /api/customers/lookup?zoho_contact_id=`, `GET /api/customers?ids=1,2,3`
- **Publishes:** `customer.created`, `customer.updated`

### visit-scheduler

- **Reads from:** customer-list (to autofill client_name + contact_number when an existing customer is selected)
- **Reads it:** site-survey-register (when a visit becomes a survey, copy fields)
- **Must expose:** `GET /api/visits`, `GET /api/visits/:id`, `POST /api/visits/:id/promote-to-survey` (server-side helper that POSTs into site-survey-register and stamps survey_no back)
- **Publishes:** none for now

### site-survey-register

- **Reads from:** customer-list (autofill company_name, contact_name, mobile when an existing customer is picked); visit-scheduler (when promoted from a visit)
- **Reads it:** quotation-tracker (a lead can be created from a survey, copying the work_items as quotation line-item descriptions); inventory-tracker (read-only — when you need to know the survey's material choices to pre-populate an issue slip)
- **Must expose:** `GET /api/surveys`, `GET /api/surveys/:id` (returns the survey with all work_items + photos), `GET /api/surveys/lookup?survey_no=`, `POST /api/surveys` (so visit-scheduler can promote)
- **Publishes:** `survey.completed`

### quotation-tracker

- **Reads from:** customer-list (customer dropdown); site-survey-register (optional — link a lead to a survey); production-tracker (look up wo_number / wo_name when stamping a confirmed lead)
- **Reads it:** production-tracker (when someone wants to see "what lead spawned this WO"); a future revenue dashboard
- **Must expose:** `GET /api/leads`, `GET /api/leads/:id`, `GET /api/leads/lookup?wo_number=`, `POST /api/leads`
- **Publishes:** `lead.won`

### production-tracker

- **Reads from:** customer-list (customer name on the WO); quotation-tracker (display the source lead); inventory-tracker (look up materials when planning a stage)
- **Reads it:** simple-installation-scheduler (an install is scheduled against a specific wo_number); a future shopfloor dashboard
- **Must expose:** `GET /api/work-orders`, `GET /api/work-orders/:id` (with stages), `GET /api/work-orders/lookup?wo_number=`, `POST /api/work-orders` (so quotation-tracker can promote)
- **Publishes:** `wo.completed`

### simple-installation-scheduler

- **Reads from:** customer-list (customer details); production-tracker (find the WO this install belongs to); inventory-tracker (consumables planning)
- **Reads it:** a future ops dashboard
- **Must expose:** `GET /api/installations`, `GET /api/installations/:id`, `POST /api/installations` (so production-tracker can suggest scheduling)
- **Publishes:** `installation.completed`

### inventory-tracker

- **Reads from:** nothing yet (materials master is hand-maintained or imported)
- **Reads it:** site-survey-register (look up materials when surveying), production-tracker (issue slips per WO), simple-installation-scheduler (consumables on site)
- **Must expose:** `GET /api/materials`, `GET /api/materials/:id`, `GET /api/materials/lookup?name=`, `POST /api/issue-slips` (so other apps can record consumption)
- **Publishes:** `inventory.low` (when stock falls below minimum_qty after a slip is created)

### 5S Daily Tracker

- **Reads from:** nothing yet
- **Reads it:** future dashboards
- **Must expose:** `GET /api/observations` (for cross-app dashboards)
- **Publishes:** none for now

---

## Worked example — survey to quotation to work order

Here is the full happy-path of one customer journey, with every cross-app call called out. Use this as the template when you build a new "promote" button.

### Step 1 — Customer logs a visit request

User opens `/visits/`, picks an existing customer from a dropdown.

The dropdown is populated by:

```js
// visit-scheduler/public/index.html
const customers = await fetch('/visits/api/customer-options').then((r) => r.json());
//                          ▲
//                          NOT '/customers/api/customers' directly — go through your own server,
//                          so the browser only ever talks to its own sub-app's prefix.
```

```js
// visit-scheduler/server.js
const customers = require('./clients/customer-list');

router.get('/api/customer-options', async (_req, res, next) => {
  try {
    const list = await customers.list();           // calls /customers/api/customers internally
    res.json(list.map((c) => ({ id: c.id, label: c.customer_name, phone: c.mobile || c.phone })));
  } catch (err) { next(err); }
});
```

Once the user picks a customer and submits, the visit row stores `customer_id` (NEW column — see [Schema migrations](#schema-migrations-needed-in-existing-apps)) plus a snapshot of `client_name` and `contact_number`.

### Step 2 — Visit is promoted to a site survey

The visit-scheduler shows a "Schedule Survey" button on Pending visits. Clicking it calls:

```js
// visit-scheduler/server.js
const surveys = require('./clients/site-survey-register');

router.post('/api/visits/:id/promote-to-survey', async (req, res, next) => {
  try {
    const visit_id = +req.params.id;
    const { rows: [v] } = await db.query(`SELECT * FROM visits WHERE id = $1`, [visit_id]);
    if (!v) return res.status(404).json({ error: 'visit not found' });

    const survey = await surveys.create({
      idempotency_key: `visit-${visit_id}`,
      customer_id:     v.customer_id,
      company_name:    v.client_name,         // snapshot
      contact_name:    v.client_name,
      mobile:          v.contact_number,
      visit_date:      v.visit_date,
      visit_time:      v.visit_time,
      purpose:         v.purpose,
      source:          'visit-scheduler',
      source_ref:      String(visit_id),
    });

    await db.query(
      `UPDATE visits SET status = 'Scheduled', notes = COALESCE(notes,'') || $1 WHERE id = $2`,
      [`\nPromoted to survey #${survey.survey_no}`, visit_id]
    );

    res.json({ visit_id, survey_no: survey.survey_no });
  } catch (err) { next(err); }
});
```

### Step 3 — Surveyor fills the survey on site, then promotes to a quotation lead

In site-survey-register, after saving a survey with all its work_items + photos, the surveyor sees a "Send to Quotation" button. The surveyor doesn't manually enter anything — the lead is built from the survey:

```js
// site-survey-register/server.js
const quotation = require('./clients/quotation-tracker');

router.post('/api/surveys/:id/promote-to-lead', async (req, res, next) => {
  try {
    const survey_id = +req.params.id;
    const { rows: [s] } = await db.query(`SELECT * FROM surveys WHERE id = $1`, [survey_id]);
    if (!s) return res.status(404).json({ error: 'survey not found' });

    const lead = await quotation.createLead({
      idempotency_key: `survey-${s.survey_no}`,
      customer_id:     s.customer_id,         // NEW column on surveys
      customer_name:   s.company_name,        // snapshot
      contact_person:  s.contact_name,
      contact_phone:   s.mobile,
      remarks:         s.requirement || s.purpose,
      source:          'site-survey-register',
      source_ref:      s.survey_no,
    });

    res.json({ survey_no: s.survey_no, lead_id: lead.id });
  } catch (err) { next(err); }
});
```

The new lead in quotation-tracker now has `source = 'site-survey-register'` and `source_ref = '<survey_no>'`. When the salesperson opens the lead, the UI shows a "View Survey" link that calls back to `GET /surveys/api/surveys/lookup?survey_no=...` for live details.

### Step 4 — Lead is won, work order is created

This is the Pattern B example we already wrote in [Pattern B section](#b2-the-caller--initiating-the-write). The lead's `Confirm` button creates a work order and stamps `wo_number` back on the lead.

### Step 5 — Production completes, install is scheduled

When the last stage of a work order is marked completed, production-tracker publishes `wo.completed`. The simple-installation-scheduler subscribes:

```js
// simple-installation-scheduler/server.js (at module load)
const bus = require('/var/www/5s-tracker/event-bus');

bus.subscribe('wo.completed', async (payload) => {
  // Insert a "draft" installation row so it shows up in the scheduler's "Awaiting scheduling" tab.
  await db.query(
    `INSERT INTO installations
       (customer_name, install_type, scheduled_date, status, wo_number, customer_id)
     VALUES ($1, 'other', CURRENT_DATE + 7, 'pending', $2, $3)
     ON CONFLICT (wo_number) DO NOTHING`,
    [payload.customer_name_snapshot || 'Unknown', payload.wo_number, payload.customer_id]
  );
});
```

A scheduler then fills in the real date, technician, type, and changes status to `in_progress`.

### Step 6 — Install completes, inventory is debited

`installation.completed` event fires. Inventory-tracker subscriber creates an issue slip for the consumables (template defined per install_type). Stock is decremented. If stock falls below minimum, `inventory.low` fires.

End-to-end, the user sees: a customer, a visit, a survey with photos, a lead, a quote, a work order with stage progress, an install with technician + photos, and a stock movement. All from one Zoho contact, all linked, all auditable.

---

## Boilerplate templates

Copy these into any new sub-app that needs to talk to others.

### `clients/<other-app>.js` — reusable HTTP client skeleton

```js
const BASE = process.env.PORTAL_INTERNAL_BASE || 'http://localhost:3010';
const PREFIX = '/<other-path>';
const TIMEOUT_MS = 5000;

async function request(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${PREFIX}${path}`, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-internal-call': 'true',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`<other-app> ${path} -> ${res.status} ${body.slice(0,200)}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally { clearTimeout(t); }
}

module.exports = {
  list: (q = '') => request(`/api/<resource>?q=${encodeURIComponent(q)}`),
  get:  (id) => request(`/api/<resource>/${encodeURIComponent(id)}`),
  create: (body) => request('/api/<resource>', { method: 'POST', body: JSON.stringify(body) }),
};
```

### Idempotency-aware POST handler

```js
router.post('/api/<resource>', async (req, res, next) => {
  try {
    const { idempotency_key, ...fields } = req.body || {};

    if (idempotency_key) {
      const { rows } = await db.query(
        `SELECT * FROM <resource> WHERE idempotency_key = $1 LIMIT 1`,
        [idempotency_key]
      );
      if (rows[0]) return res.json(rows[0]);
    }

    // ... validate fields, then INSERT including idempotency_key ...

    res.status(201).json(newRow);
  } catch (err) { next(err); }
});
```

The matching schema columns:

```sql
ALTER TABLE <resource>
  ADD COLUMN IF NOT EXISTS idempotency_key  TEXT,
  ADD COLUMN IF NOT EXISTS source           TEXT,
  ADD COLUMN IF NOT EXISTS source_ref       TEXT,
  ADD COLUMN IF NOT EXISTS customer_id      TEXT,
  ADD COLUMN IF NOT EXISTS customer_name_snapshot TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_<resource>_idempotency_key
  ON <resource> (idempotency_key) WHERE idempotency_key IS NOT NULL;
```

### Bulk-fetch endpoint (the one optimization that matters most)

```js
router.get('/api/customers', async (req, res, next) => {
  try {
    const { ids, q, active, limit = 100 } = req.query;
    const params = [];
    const where = [];

    if (active === '1') where.push(`status = 'active'`);
    if (q) { params.push(`%${q.toLowerCase()}%`); where.push(`LOWER(customer_name) LIKE $${params.length}`); }
    if (ids) {
      const arr = String(ids).split(',').map(Number).filter(Boolean);
      if (arr.length) { params.push(arr); where.push(`id = ANY($${params.length})`); }
    }

    const sql = `SELECT id, zoho_contact_id, customer_name, email, phone, mobile, status
                   FROM customers
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY customer_name LIMIT ${+limit}`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
});
```

### Subscribing to events

```js
const bus = require('/var/www/5s-tracker/event-bus');

// Subscribe ONCE at module load. Don't put inside a route handler.
bus.subscribe('wo.completed', async (payload) => {
  // ... handler ...
});
```

---

## Error handling and resilience

Cross-app calls add a new failure surface. Treat every cross-app fetch as something that can fail and design the UI to degrade gracefully.

### Server-side: never let a downstream failure crash your handler

Wrap every cross-app call in `try/catch` and return a partial result:

```js
let customer = null;
try { customer = await customers.get(wo.customer_id); }
catch (err) { console.warn(`[production] customer ${wo.customer_id} fetch failed:`, err.message); }

res.json({ ...wo, customer });   // customer is null if fetch failed; UI handles this
```

### Frontend: visible "stale" indicator on snapshots

If the UI shows a snapshot field, label it as such when the live fetch fails:

```html
<span class="customer-name">
  {{ wo.customer_name_snapshot }}
  <small class="badge-stale" v-if="!liveCustomer">cached</small>
</span>
```

### Timeouts are mandatory

Default 5-second timeout for reads, 15-second for writes. Hanging requests pile up Node's event loop and degrade the whole portal. The wrapper template above already does this — don't paste in your own fetch without timeouts.

### Retry policy

Don't retry POSTs blindly — that's why idempotency keys exist. For GETs, one retry after 200 ms is fine; more than that and the user is staring at a spinner anyway.

### Health checks for cross-app dependencies

Add a meta endpoint to each app that talks to others:

```js
router.get('/api/integrations/health', async (_req, res) => {
  const checks = await Promise.all([
    fetch('http://localhost:3010/customers/api/health').then((r) => r.ok).catch(() => false),
    fetch('http://localhost:3010/inventory/api/health').then((r) => r.ok).catch(() => false),
  ]);
  res.json({
    customer_list:    checks[0],
    inventory_tracker: checks[1],
  });
});
```

Then a simple monitoring page at `/portal/integrations` can show green/red dots.

---

## Schema migrations needed in existing apps

The existing apps were not designed with cross-app references in mind. Each needs a small migration to add `customer_id`, `idempotency_key`, `source`, and snapshot columns. Run these as part of the integration rollout — none are destructive (all use `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`), so they can be re-run safely by `npm run init-db`.

### visit-scheduler/schema.sql additions

```sql
ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS customer_id TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS source_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_visits_customer_id ON visits (customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_visits_idempotency_key
  ON visits (idempotency_key) WHERE idempotency_key IS NOT NULL;
```

### site-survey-register/schema.sql additions

```sql
ALTER TABLE surveys
  ADD COLUMN IF NOT EXISTS customer_id TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS source_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_surveys_customer_id ON surveys (customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_surveys_idempotency_key
  ON surveys (idempotency_key) WHERE idempotency_key IS NOT NULL;
```

### quotation-tracker/schema.sql additions

quotation-tracker already has `customer_id`, `wo_number`, and `wo_name`. Add only:

```sql
ALTER TABLE qt_leads
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS source_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_qt_leads_idempotency_key
  ON qt_leads (idempotency_key) WHERE idempotency_key IS NOT NULL;
```

### production-tracker/schema.sql additions

```sql
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS customer_id TEXT,
  ADD COLUMN IF NOT EXISTS customer_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS source_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_work_orders_customer_id ON work_orders (customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_orders_idempotency_key
  ON work_orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
```

### simple-installation-scheduler/schema.sql additions

```sql
ALTER TABLE installations
  ADD COLUMN IF NOT EXISTS customer_id TEXT,
  ADD COLUMN IF NOT EXISTS wo_number TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS source_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_installations_customer_id ON installations (customer_id);
CREATE INDEX IF NOT EXISTS idx_installations_wo_number ON installations (wo_number);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_installations_idempotency_key
  ON installations (idempotency_key) WHERE idempotency_key IS NOT NULL;
```

### inventory-tracker/schema.sql additions

```sql
ALTER TABLE issue_slips
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS source_ref TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_issue_slips_idempotency_key
  ON issue_slips (idempotency_key) WHERE idempotency_key IS NOT NULL;
```

(`issue_slips.source` already exists with a different meaning — manual vs image. Either rename the existing column to `entry_source` and add the new `source` for cross-app reference, or pick a different name like `originating_app`. Pick one and stick with it.)

### customer-list — no migration needed

It is already cross-app-ready.

### 5S Tracker — no migration needed for v1

Out of scope.

---

## Pitfalls and lessons learned

### Pitfall 1 — Calling a sibling app's database directly

**Symptom:** Your sub-app does `pg.connect('postgres://fivesuser:...@localhost/customers_list')` and reads `customers` directly.

**Why it's wrong:** You bypass the owning app's validation, you couple your app's deploy schedule to its schema, and you can't be migrated to a different storage layer later. Also, `db.js` in this codebase is deliberately scoped to ONE database — see Pitfall 1 in the deployment guide for why mixing is dangerous.

**Fix:** Always go through the owning app's HTTP API. Performance is not a real concern at our scale (single-process, localhost, sub-millisecond).

### Pitfall 2 — Storing only the foreign key, no snapshot

**Symptom:** UI shows "Customer #42" instead of a name when the customer-list is briefly unreachable.

**Fix:** Always store both `customer_id` AND `customer_name_snapshot`. The snapshot is what the list view renders. The id is what the detail view uses to fetch live data.

### Pitfall 3 — Forgetting the idempotency key on writes

**Symptom:** User double-clicks "Confirm" and you have two work orders for the same lead.

**Fix:** Every cross-app POST gets an `idempotency_key` derived from a stable upstream identifier (e.g. `qt-lead-${lead_id}`). The receiver looks up the key first; if present, returns the existing row.

### Pitfall 4 — Calling cross-app APIs from the browser

**Symptom:** Browser network tab shows the page making 5 separate requests to 5 different sub-paths. Page is slow. CORS errors appear.

**Fix:** The browser only ever talks to one sub-app's prefix. That sub-app's server makes the cross-app calls. The browser sees one request, one response.

### Pitfall 5 — Subscribing to an event inside a route handler

**Symptom:** Memory leak. After a few hours, `EventEmitter` warns about "max listeners exceeded".

**Fix:** Call `bus.subscribe(...)` exactly once, at module load time, at the top of `server.js`. Never inside a route handler.

### Pitfall 6 — Mutating data inside an event subscriber without idempotency

**Symptom:** A flaky deploy causes events to be re-played; stock is debited twice.

**Fix:** Every state-changing subscriber needs an idempotency key derived from the event payload. For example, the inventory-tracker's `installation.completed` handler should use `idempotency_key = 'install-' + installation_id`.

### Pitfall 7 — Schema-level cross-database foreign keys

**Symptom:** Tempting idea: "let me just `CREATE FOREIGN TABLE` from postgres_fdw and add a real FK". DON'T.

**Why it's wrong:** It couples deploys, breaks `pg_dump`, and silently loses referential integrity if you ever move an app to a different DB host. The FK column without an FK constraint is fine — we treat the integration layer as the enforcement boundary.

### Pitfall 8 — One sub-app crashes the whole portal because it imports another sub-app's `server.js`

**Symptom:** App A does `require('/var/www/<other-app>/server')` to share a function. A bug in B crashes the whole 5s-tracker process.

**Fix:** Never `require` another sub-app's source code. The HTTP boundary is the contract. If you need to share a small utility (e.g. wo_number generator), publish it as a tiny npm-style local package or copy the code.

### Pitfall 9 — Forgetting to update the snapshot on customer rename

**Symptom:** A customer is renamed in Zoho; six months of work orders still show the old name.

**Fix:** Subscribe to `customer.updated`. When a customer's display fields change, update all snapshots in your DB:

```js
bus.subscribe('customer.updated', async ({ id, customer_name }) => {
  await db.query(
    `UPDATE work_orders SET customer_name_snapshot = $1 WHERE customer_id = $2`,
    [customer_name, id]
  );
});
```

This is the canonical use case for Pattern C.

### Pitfall 10 — Cross-app calls during init-db

**Symptom:** `npm run init-db` hangs or fails because it tries to call `localhost:3010` while the server isn't running.

**Fix:** init-db must never make cross-app calls. It only creates schema and (optionally) seeds local data. Cross-app data hydration is a separate one-off script if you really need it.

---

## Rollout plan — order of integrations

Don't try to wire everything at once. Roll out in this order — each step is independently shippable and unblocks the next.

### Phase I — customer-list as the master (week 1)

1. Add the bulk-fetch endpoint `GET /customers/api/customers?ids=...` to customer-list
2. Add `customer_id` columns to visit-scheduler, site-survey-register, production-tracker, simple-installation-scheduler (quotation-tracker already has it)
3. In each app's create form, replace the free-text customer field with a dropdown populated from `/customers/api/customers`
4. Backfill `customer_id` on existing rows using fuzzy name match → manual review

After Phase I: every new record in every app correctly references a customer-list customer. Old records have a best-effort link.

### Phase II — visit-scheduler ↔ site-survey-register (week 2)

5. Add `POST /api/surveys` to site-survey-register
6. Add the "Schedule Survey" button to visit-scheduler that promotes a visit
7. Add a "View Source Visit" link on surveys promoted from a visit

### Phase III — site-survey-register → quotation-tracker (week 3)

8. Add the "Send to Quotation" button on completed surveys
9. Add a "View Source Survey" link on leads promoted from a survey

### Phase IV — quotation-tracker → production-tracker (week 4)

10. Add `POST /api/work-orders` to production-tracker (with idempotency key)
11. Wire the "Confirm Lead" button in quotation-tracker (Pattern B)
12. Add the wo_number → lead back-reference on the work order detail page

### Phase V — event bus and downstream automation (week 5)

13. Add `event-bus.js` to the 5s-tracker process
14. Add `operations_events` table to the 5s-tracker DB
15. Production-tracker publishes `wo.completed`; simple-installation-scheduler subscribes
16. Simple-installation-scheduler publishes `installation.completed`; inventory-tracker subscribes
17. Customer-list publishes `customer.updated`; downstream apps update snapshots

### Phase VI — inventory consumption + dashboards (week 6)

18. Add `POST /api/issue-slips` to inventory-tracker (with idempotency key)
19. Production-tracker stages emit issue slips when materials are consumed
20. A read-only "ops dashboard" sub-app shows: open leads, in-flight work orders, scheduled installs, low-stock materials — all by reading the public `/api/` of every app

After Phase VI: the portal acts as one product. Every customer has a visible journey from "they called us" to "we installed it". Inventory is current. Dashboards are accurate.

---

## Quick-reference snippets

```bash
#### Sanity-check that one sub-app can reach another (run on the VPS) ####
curl -sS -H 'x-internal-call: true' http://localhost:3010/customers/api/health | jq .
curl -sS -H 'x-internal-call: true' http://localhost:3010/inventory/api/health | jq .

#### Tail integration errors only ####
pm2 logs 5s-tracker | grep -E '\[(production|inventory|quotation|installation)\]'

#### Replay an event from the audit log (read-only — no rerun yet) ####
sudo -u postgres psql fives_tracker -c "SELECT id, event, published_at FROM operations_events ORDER BY id DESC LIMIT 20;"

#### Find any work order with a NULL customer_id (cleanup target) ####
sudo -u postgres psql production_tracker -c "SELECT id, wo_number, customer FROM work_orders WHERE customer_id IS NULL ORDER BY id DESC LIMIT 50;"

#### Verify all customer snapshots are in sync with the master ####
# (run as root, joins across DBs via psql --command + grep — for one-off checks only)
sudo -u postgres psql -d production_tracker -c "SELECT customer_id, customer_name_snapshot FROM work_orders WHERE customer_id IS NOT NULL" \
  | sort -u > /tmp/wo_snapshots.txt
sudo -u postgres psql -d customers_list -c "SELECT id, customer_name FROM customers" \
  | sort -u > /tmp/customer_master.txt
diff /tmp/wo_snapshots.txt /tmp/customer_master.txt | head
```

---

## Document maintenance

When something in this guide turns out to be wrong, outdated, or incomplete, fix it in this document **before** the next integration. The whole point of this guide is to compound learning — if it stays out of date it stops being useful.

Common reasons for updates:

- A new cross-app pattern appears → add to [The three integration patterns](#the-three-integration-patterns)
- A new event is added → add a row to the canonical event-name table in [The canonical event names](#c4-the-canonical-event-names)
- A new sub-app is deployed → add a row to [Per-app integration matrix](#per-app-integration-matrix)
- A new pitfall is discovered → add to [Pitfalls and lessons learned](#pitfalls-and-lessons-learned)

End of guide.
