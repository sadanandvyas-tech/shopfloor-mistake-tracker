# Operations Portal — Style & Architecture Guide

**Version 1.0** · Companion to `OPERATIONS_PORTAL_NEW_APP_GUIDE.md` and `OPERATIONS_PORTAL_APP_UPDATE_GUIDE.md`.

This document captures the conventions used in `production-tracker` so every future sub-app on `operation.yotser.in` looks, feels, and behaves the same way. Treat it as the source of truth: when you build a new app, copy these patterns first and only deviate when there is a clear reason.

---

## Table of contents

1. [Philosophy](#1-philosophy)
2. [Foundations — colour, typography, spacing](#2-foundations)
3. [Status & semantic colours](#3-status--semantic-colours)
4. [Components](#4-components)
5. [Layout patterns](#5-layout-patterns)
6. [Interaction patterns](#6-interaction-patterns)
7. [Frontend architecture](#7-frontend-architecture)
8. [Backend architecture](#8-backend-architecture)
9. [Database conventions](#9-database-conventions)
10. [File uploads](#10-file-uploads)
11. [Deployment & ops](#11-deployment--ops)
12. [Naming conventions](#12-naming-conventions)
13. [Accessibility minimums](#13-accessibility-minimums)
14. [Reusable scaffold checklist](#14-reusable-scaffold-checklist)

---

## 1. Philosophy

**Operational, not pretty.** Every screen is for somebody on the shop floor or in the dispatch area trying to get a job done. Information density beats whitespace. Colour is used for meaning, not decoration.

**One file, no build step.** Each sub-app's UI lives in a single `public/index.html` with inline `<style>` and `<script>`. Reasoning: deploys are `git pull && pm2 restart` with no compile step; static-only changes go live the moment the pull lands. The cost is no JSX, no SCSS — but the apps stay small enough that this is a feature, not a bug.

**Every list view answers three questions at a glance:** what is this work item, what is its current status, what should I do next. If a column doesn't help answer one of those, drop it.

**Red is loud, green is quiet.** Red means "act now" — overdue, delayed, blocked. Green means "this is fine, ignore it." Amber is the "heads-up before the red." Don't dilute the colours by using red for a non-urgent border or green for "submit" buttons; reserve them for state.

---

## 2. Foundations

### 2.1 Colour palette

These are the only colours that should appear in a sub-app. Pick from the table.

#### Brand & UI chrome

| Token              | Hex       | Usage                                       |
|--------------------|-----------|---------------------------------------------|
| Brand navy         | `#1e3a5f` | Header background, h1 / h3 text, WO IDs    |
| Primary blue       | `#3b82f6` | Primary buttons, focus rings, progress bars|
| Primary blue hover | `#2563eb` | Primary button hover                        |
| Page background    | `#f0f2f5` | App body                                    |
| Surface            | `#ffffff` | Cards, table cells, modal body              |
| Surface alt        | `#f8fafc` | Table headers, hover row, modal subtitle    |
| Border light       | `#e2e8f0` | Default 1px border on cards, table cells   |
| Border subtle      | `#f1f5f9` | Inner dividers inside a card                |
| Text primary       | `#222222` | Body text                                   |
| Text muted         | `#64748b` | Secondary text, table sub-info              |
| Text faint         | `#94a3b8` | Em-dashes, "no data", help text             |
| Disabled fill      | `#cbd5e1` | Empty state pills                           |

#### Semantic ramps

Use the ramp that matches the meaning, not the one whose hex you happen to like.

| Ramp     | Soft bg     | Strong bg   | Text on soft bg | Strong text |
|----------|-------------|-------------|-----------------|-------------|
| Success  | `#dcfce7`   | `#16a34a`   | `#166534`       | `#15803d`   |
| Info     | `#dbeafe`   | `#3b82f6`   | `#1d4ed8`       | `#2563eb`   |
| Warning  | `#fef3c7`   | `#d97706`   | `#92400e`       | `#b45309`   |
| Danger   | `#fee2e2`   | `#dc2626`   | `#991b1b`       | `#b91c1c`   |
| Neutral  | `#f3f4f6`   | `#6b7280`   | `#374151`       | `#4b5563`   |
| Accent   | `#f5f3ff`   | `#7c3aed`   | `#6d28d9`       | `#7c3aed`   |

**Rule:** soft bg + strong text for inline pills/badges/cells; strong bg + white text only for buttons and the most prominent overdue indicators.

### 2.2 Typography

```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```

| Use                 | Size  | Weight | Notes                               |
|---------------------|-------|--------|-------------------------------------|
| Page header (h1)    | 18px  | 700    | Inside the brand-navy header bar    |
| Section heading (h3)| 14px  | 700    | Brand-navy text, dashboard sections |
| Body                | 13px  | 400    | Table cells, modal body, paragraphs |
| Small body          | 12px  | 400    | Secondary table info                |
| Caption             | 11px  | 600    | Table headers, labels, chip text    |
| Tiny / pill text    | 10px  | 600/700| Status pills, badges                |
| Number stat         | 32px  | 800    | Dashboard summary card values       |
| Big stat (efficiency)| 36px | 800    | Production-efficiency tile values   |

Two weight rule: stick to 400 (regular) and 700 (bold). 600 is reserved for captions where bold-700 would feel heavy. Don't mix 500 / 800 / 900 across a single screen.

**Sentence case for everything.** Headings, labels, button text — `Mark complete`, not `Mark Complete` or `MARK COMPLETE`. Exception: status table headers stay UPPERCASE because the existing portal does, but only in the column-header context.

### 2.3 Spacing

Multiples of 4. Stick to: `4px, 6px, 8px, 10px, 12px, 14px, 16px, 20px, 24px`. Anything else is an accident.

| Use                                    | Value      |
|----------------------------------------|------------|
| Inside a pill / chip                    | `4px 10px` |
| Inside a small button                   | `5px 10px` |
| Inside a regular button                 | `8px 16px` |
| Inside a table cell                     | `8px 12px` |
| Inside a card                           | `16px 20px`|
| Between cards in a grid                 | `12px` or `16px` |
| Between dashboard sections (vertical)   | `24px`     |
| Modal body padding                      | `20px`     |

### 2.4 Borders & radius

```css
/* Default border on all surfaces */
border: 1px solid #e2e8f0;
border-radius: 6px;   /* small UI: pills, buttons, inputs */
border-radius: 8px;   /* cards inside dashboards */
border-radius: 10px;  /* full-width sections, modals */
border-radius: 999px; /* age pill, status pill, kanban-card-priority */
```

Single-sided borders never get rounded corners — if you set `border-left` only, set `border-radius: 0`.

### 2.5 Shadows

Three permitted variants. Don't invent new ones.

```css
/* Default modal */
box-shadow: 0 20px 60px rgba(0,0,0,0.2);

/* Pill or floating chip */
box-shadow: 0 1px 2px rgba(0,0,0,0.06);

/* Hover lift on a kanban card or interactive surface */
box-shadow: 0 4px 12px rgba(0,0,0,0.08);
```

No glow, no neon, no inner shadows. The single exception: the 4-day-overdue age pill uses a halo + slow pulse animation — that's a deliberate attention-grab, not decoration.

---

## 3. Status & semantic colours

### 3.1 Work-item status

The four canonical statuses every sub-app should use, in `snake_case`:

| Status         | Soft bg    | Strong text | Display label |
|----------------|------------|-------------|---------------|
| `not_started`  | `#f9fafb`  | `#9ca3af`   | Pending       |
| `in_progress`  | `#dbeafe`  | `#1d4ed8`   | In Progress   |
| `completed`    | `#dcfce7`  | `#166534`   | Done          |
| `delayed`      | `#fee2e2`  | `#991b1b`   | Delayed       |

Optional but common:

| Status         | Soft bg    | Strong text | Display label |
|----------------|------------|-------------|---------------|
| `outsourced`   | `#fef3c7`  | `#92400e`   | Outsourced    |

Always store the underscore form in the database (`stage-${st.status}` patterns expect it). Render the human label via a `statusLabel(s)` helper — never inline the string.

### 3.2 Priority

| Priority | Text colour |
|----------|-------------|
| High     | `#dc2626`   |
| Medium   | `#d97706`   |
| Low      | `#16a34a`   |

Priority is text colour only — not a background fill. Background fills are reserved for status (where the row needs to read at a glance).

### 3.3 Time / age signals

The 4-day rule is the standard production-efficiency threshold. Same colour mapping in every app that uses it:

| Age (active, non-outsourced) | State            | Background | Text  |
|------------------------------|------------------|------------|-------|
| 0–2 days                     | Fresh            | `#16a34a`  | white |
| 3 days                       | Heads-up         | `#f59e0b`  | white |
| ≥ 4 days                     | Overdue (red+halo+pulse) | `#dc2626` | white |
| Outsourced (any age)         | Informational    | `#d97706`  | white |
| No data                      | Empty            | `#e5e7eb`  | `#94a3b8` |

A red ≥4d pill must always be paired with a row-level red treatment (light red row background or red card border) so the row reads as overdue from across the room.

### 3.4 Outsourced state

Outsourced work items always get amber treatment, never red. The reasoning is operational: vendor turnaround is outside the team's control, so a vendor taking 6 days isn't a production-efficiency failure on the team's side. Surface the age, but never count it against the 4-day rule.

---

## 4. Components

Code snippets here are the canonical implementation. Copy from production-tracker's `public/index.html` for the working version.

### 4.1 Buttons

Three sizes (`btn`, `btn-sm`), and a small set of variants:

```html
<button class="btn btn-primary">Save</button>
<button class="btn btn-outline">Cancel</button>
<button class="btn btn-success">Mark complete</button>
<button class="btn btn-danger">Delete</button>
<button class="btn btn-sm btn-primary">+ New</button>
```

Action-row buttons inside table cells use semantic per-action variants:

```html
<button class="btn-edit">✏️ Edit</button>
<button class="btn-complete">✅ Complete</button>
<button class="btn-delete">🗑️ Delete</button>
<button class="btn-stats">📊 Stats</button>
```

Each is a soft bg + matching strong text + a thin matching border. Hover deepens the bg by one shade. No solid fills — those are reserved for the primary action button on a screen.

**Disabled state:** `opacity: 0.45; cursor: not-allowed;`

### 4.2 Pills, badges, and chips

Three flavours, by visual weight:

**Soft pill** (most common — status cells, summary chips):

```css
padding: 4px 10px;
border-radius: 12px;
font-size: 11px;
font-weight: 700;
background: <semantic-soft-bg>;
color: <semantic-strong-text>;
```

**Solid pill** (the loudest — age timer, primary attention):

```css
display: inline-flex;
padding: 5px 12px;
border-radius: 999px;
font-size: 13px;
font-weight: 700;
background: <semantic-strong-bg>;
color: white;
box-shadow: 0 1px 2px rgba(0,0,0,0.06);
```

**Dot indicator** (compact, for a stage strip on a kanban card):

```css
font-size: 9px;
padding: 2px 6px;
border-radius: 8px;
font-weight: 600;
```

A pill is round (`border-radius: 999px`); a chip is rectangular-rounded (`border-radius: 12px`). Don't blur the line.

### 4.3 Forms

```css
input, select, textarea {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
  outline: none;
  font-family: inherit;
}
input:focus, select:focus, textarea:focus { border-color: #3b82f6; }
textarea { resize: vertical; min-height: 60px; }
label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #475569;
  margin-bottom: 4px;
  margin-top: 12px;
}
label:first-child { margin-top: 0; }
```

Optional fields: append `<span style="color:#94a3b8; font-weight:normal;">(optional)</span>` to the label. Required fields: append `*`.

### 4.4 Tables

Every list view follows this skeleton:

```html
<div class="table-wrap">
  <table>
    <thead><tr>
      <th>#</th>
      <th>WO ID</th>
      <th>Title</th>
      <!-- … domain columns … -->
      <th style="text-align:center;">Actions</th>
    </tr></thead>
    <tbody>
      <tr>
        <td class="row-num">1</td>
        <td class="wo-id">WO-001</td>
        <td class="wo-title">…</td>
        <!-- … -->
        <td class="actions-cell">
          <button class="btn-edit">✏️ Edit</button>
          <button class="btn-delete">🗑️ Delete</button>
        </td>
      </tr>
    </tbody>
  </table>
</div>
```

Conventions:
- Header row: `background: #f8fafc; color: #475569; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;`
- Hover row: `background: #f8fafc;`
- First two columns (`#` and ID) freeze on horizontal scroll using `position: sticky` (`.freeze-id`).
- Centre-align numeric / status / single-word columns; left-align text columns.
- Row state: a critical row gets a soft tinted bg (e.g. `tr.row-overdue-4d td { background: #fef2f2; }`) — never a strong fill.
- Title cells link to the detail/comments modal via `<span class="wo-title-clickable">`.

### 4.5 Modals

```html
<div class="modal-overlay" id="myModal" onclick="if(event.target===this)closeModal('myModal')">
  <div class="modal">
    <div class="modal-header">
      <h3>Title</h3>
      <button class="modal-close" onclick="closeModal('myModal')">&times;</button>
    </div>
    <div class="modal-body">
      <!-- form / content -->
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal('myModal')">Cancel</button>
      <button class="btn btn-primary" onclick="save()">Save</button>
    </div>
  </div>
</div>
```

Sizing:

| Modal type             | `max-width` |
|------------------------|-------------|
| Confirm dialog         | `400px`     |
| Standard form          | `440px`     |
| Form with extra fields | `520px`     |
| Detail / kanban order  | `600px`     |
| Stats / comments       | `640px`     |

Footer order from left to right: review/navigation → secondary actions → close → primary action. The primary action sits on the right.

Click on the overlay (not on the modal body) closes the modal. Provide an explicit close `&times;` in the header. Provide a Cancel button in the footer. The user should always have three ways out.

### 4.6 Cards

Two flavours.

**Dashboard summary card** — the big-number tile:

```html
<div class="dash-card">
  <div class="dash-card-value" style="color:#1e3a5f;">42</div>
  <div class="dash-card-label">Total Orders</div>
  <div class="dash-card-sub">All work orders</div>
</div>
```

**Section card** — wraps a table or chart inside the dashboard:

```html
<div class="dash-section">
  <h3>📊 Section title</h3>
  <!-- chart or table -->
</div>
```

Both use `background: #fff; border-radius: 10px; padding: 20px; border: 1px solid #e2e8f0;`. The summary card centres a single big stat; the section card has a 14px h3 followed by content.

### 4.7 Tabs

```html
<div class="tabs">
  <div class="tab active" onclick="switchTab('dashboard')">📊 Dashboard</div>
  <div class="tab"        onclick="switchTab('table')">📋 Table View</div>
  <div class="tab"        onclick="switchTab('kanban')">🗂️ Kanban</div>
  <div class="tab"        onclick="switchTab('completed')">✅ Completed</div>
</div>
```

Active tab gets a 3px brand-navy bottom border. Inactive tabs are muted grey. Don't add tab counts inside the label — they'll go stale; show counts in the content instead (chips or section headers).

### 4.8 Toolbar

A search input, a few filter selects, a "Clear filters" outline button, and a summary-chips group on the right:

```html
<div class="toolbar">
  <input type="text" placeholder="🔍 Search orders…">
  <select id="filterStatus">…</select>
  <select id="filterPriority">…</select>
  <button class="btn btn-sm btn-outline">Clear Filters</button>
  <div class="summary-chips" style="margin-left:auto;">
    <span class="chip chip-total">Total: 12</span>
    <span class="chip chip-progress">In Progress: 5</span>
    <span class="chip chip-delayed">Delayed: 1</span>
  </div>
</div>
```

The chips on the right reflect *what the user is looking at* (post-filter), so a customer filter changes the totals.

### 4.9 Empty states

Centre-align, light grey, friendly. Don't try to be clever:

```html
<div style="text-align:center; padding:30px; color:#94a3b8; font-size:13px;">
  No comments yet. Be the first to add one below.
</div>
```

Pattern: state the situation in one short sentence + (when relevant) a hint at the next step.

---

## 5. Layout patterns

### 5.1 App shell

```
┌────────────────────────────────────────────────────────┐
│ [🏠 Portal]  📋 App Name           [+ New Item]        │  Header (sticky, brand-navy)
├────────────────────────────────────────────────────────┤
│ 📊 Dashboard | 📋 Table | 🗂️ Kanban | ✅ Completed    │  Tabs
├────────────────────────────────────────────────────────┤
│ Toolbar (search + filters + chips)                     │  Optional
├────────────────────────────────────────────────────────┤
│ Main content                                            │
│                                                         │
└────────────────────────────────────────────────────────┘
```

The `[🏠 Portal]` link top-left always points to `/` — the parent operations portal. Don't break this; it's how operators get back.

### 5.2 Default views

Every sub-app starts with these four tabs in this order:

1. **Dashboard** (default tab on load)
2. **Table View**
3. **Kanban**
4. **Completed**

Apps that don't need all four can drop tabs from the right (Completed, then Kanban). Don't reorder them, don't add a 5th tab without a clear reason — extra tabs become hard to find. If a feature is per-item, put it in a modal triggered from a row/card.

### 5.3 Dashboard layout

Top-down rhythm:

1. Summary cards row (4–6 cards, equal-width grid)
2. Headline efficiency section (full-width, mixes big numbers + a histogram)
3. Two-up rows of related sections (`grid-template-columns: 1fr 1fr`)
4. Full-width activity / log section at the bottom

Mobile breakpoints: 6-col grid → 3-col at 900px → 2-col at 600px. Two-up rows collapse to single column at 900px.

### 5.4 Kanban board

Columns from left to right map to status flow:

```
Not Started → In Progress → Delayed → (Completed) → Outsourced
```

Cards are draggable between columns; dropping in a new column advances or rolls back the active stage according to a clear rule (see `advanceStageForColumn` in production-tracker). Outsourced is a side-channel column (not part of the linear flow) — dragging in toggles the outsource flag.

### 5.5 Table view

Frozen first columns: `#` and the canonical ID column. Everything else scrolls horizontally. Use `min-width` on the table (e.g. `1100px`) so columns don't collapse on narrow screens — horizontal scroll is fine, squashed columns aren't.

### 5.6 Mobile

Goal: usable, not pretty. Don't redesign for mobile — let the table scroll horizontally, let the kanban columns scroll horizontally, shrink toolbar inputs, collapse grid rows. Operators on a phone will pinch-zoom.

```css
@media (max-width: 768px) {
  .toolbar input { width: 160px; }
  .summary-chips { margin-left: 0; }
  .stage-grid { grid-template-columns: repeat(2, 1fr); }
}
```

---

## 6. Interaction patterns

### 6.1 Click affordances

| Element                    | Cursor    | Visual                                       |
|----------------------------|-----------|----------------------------------------------|
| WO title (opens comments)  | `pointer` | Blue text, underline on hover, 💬 prefix     |
| Stage cell (opens modal)   | `pointer` | 2px blue outline on hover, offset inward     |
| Kanban card                | `grab` / `grabbing` | Subtle hover lift via box-shadow   |
| Actions buttons            | `pointer` | Background deepens by one shade on hover     |

Anything clickable must change the cursor. Anything that reveals more on click should hint at it before you click (icon prefix, hover underline, hover outline).

### 6.2 Confirmations

Destructive actions get a confirm dialog. Two flavours:

**Native `confirm()`** — for delete actions inside a list:

```js
if (!confirm(`Mark all ${n} stages of ${order.id} as Completed?\n\n"${order.title}"`)) return;
```

**Custom modal** — for the higher-stakes WO delete, where you want the WO name shown prominently and the destructive button red.

Always show the *thing* being deleted in the confirm — `Delete WO-014?` is better than `Delete this work order?`.

### 6.3 Notifications & errors

`alert()` is acceptable for now. Two rules:
- Be specific: `"Failed to save. Please try again."` not `"Error"`.
- Surface server-provided error messages when the API returns one (`{ error: '...' }`):

```js
let msg = 'Failed to post comment.';
try { const j = await res.json(); if (j.error) msg = j.error; } catch (_) {}
alert(msg);
```

A toast system would be nicer; if you build one, share it across all sub-apps so they all upgrade together. Until then, `alert()` is the standard.

### 6.4 Loading states

For any fetch that takes more than a beat:
- Disable the trigger button and change its label: `btn.textContent = 'Posting…'; btn.disabled = true;`
- Re-enable in a `finally { … }` so a network failure doesn't strand the UI.

For a modal that needs to fetch data on open: render a placeholder body (`Loading…`) immediately so the modal opens fast, then replace the body when data arrives.

### 6.5 Modal stacking

If you must open a second modal from inside a first, place the second's HTML *before* the first's in the DOM — it'll sit visually on top by z-index order. Production-tracker does this with `kanbanOrderModal` placed before `stageModal`.

---

## 7. Frontend architecture

### 7.1 Single-file pattern

```
public/
└── index.html       # everything: HTML, <style>, <script>
```

No bundler, no source maps, no `dist/`. The file can grow to 2–3k lines comfortably; if it crosses 5k, split *only when* the split makes the deploy story stay simple.

Order inside the file:

1. `<style>` block (ordered: foundations → components → layouts → modals → responsive)
2. HTML body (ordered: header → tabs → views → modals)
3. `<script>` block (ordered: config → data → utility → render → handlers → init)

### 7.2 State

Top-level globals. No framework, no store. Be intentional about which globals exist:

```js
const API = '/yourapp';      // sub-path mount; '' for local dev
const STAGES = [...];        // domain-static lookup
const STAGE_KEYS = STAGES.map(...);
let orders = [];             // canonical fetched data
let editingOrderIdx = -1;    // state per modal type
```

Re-fetch and re-render after every mutation — don't try to incrementally patch the local array. The table is always fast enough to re-render in full.

### 7.3 Render functions

One render function per view: `renderTable()`, `renderKanban()`, `renderDashboard()`, `renderCompleted()`. They each compute everything they need from the global `orders` array and the form fields' current values, then `innerHTML =` their slot.

`loadOrders()` re-fetches, then dispatches to the active view's render:

```js
async function loadOrders() {
  const res = await fetch(`${API}/api/orders`);
  orders = await res.json();
  // Dispatch to whichever view is currently visible
  if (dashboardVisible) renderDashboard();
  else if (kanbanVisible) renderKanban();
  else if (completedVisible) renderCompleted();
  else renderTable();
}
```

### 7.4 API conventions (frontend)

```js
const res = await fetch(`${API}/api/orders/${order.id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
```

For uploads, use `FormData` and don't set `Content-Type` — the browser fills in the multipart boundary.

### 7.5 Escaping

Two helpers, used everywhere:

```js
function escHtml(s)     { return String(s).replace(/[&<>"']/g, m => ({...}[m])); }
function escHtmlAttr(s) { return String(s).replace(/[&<>"']/g, m => ({...}[m])); }
```

Rule: any user-supplied text that goes into a template literal MUST go through `escHtml`. Single quotes that go into `onclick="..."` attributes MUST go through `escHtmlAttr`. Skipping this is the most common XSS bug in single-file vanilla apps.

### 7.6 Dates

Display: short, local, India-friendly:

```js
const d = new Date(iso);
const datePart = d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
const timePart = d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:false });
```

Storage: ISO. Postgres `DATE` and `TIMESTAMP` columns return Date objects via node-pg; pass them straight to `new Date(iso)` for display.

Relative time helper for activity feeds: `5m ago / 3h ago / 2d ago` for anything in the last 30 days, then absolute date.

---

## 8. Backend architecture

### 8.1 Express Router as sub-app

Every sub-app exports a Router that the main `5s-tracker` server mounts at a sub-path:

```js
const router = express.Router();
router.use(express.json());
router.use(express.static(path.join(__dirname, 'public')));
// … routes …
module.exports = router;

// Standalone-mode tail for local development
if (require.main === module) {
  require('dotenv').config();
  const app = express();
  app.use('/', router);
  app.listen(process.env.PORT || 3020);
}
```

Don't `app.listen()` at the top level when run under PM2. The mount happens inside `5s-tracker/server.js`.

### 8.2 Database connection

`db.js` uses the `dotenv.parse(fs.readFileSync(...))` isolation pattern — never `require('dotenv').config()` at the module level, because that pollutes `process.env` across sub-apps (Pitfall 1 in the new-app guide). Use the template from production-tracker's `db.js` verbatim:

```js
const { Pool } = require('pg');
require('dotenv').config();   // OK at module top — only loads .env if present

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : { host, port, user, password, database }
);
module.exports = { query: (t, p) => pool.query(t, p) };
```

`.env.example` lives in the repo (with placeholder values). `.env` does not. Each sub-app gets its own DB; never share with another app's DB.

### 8.3 REST endpoint conventions

Resource-oriented, plural nouns:

| Method | Path                                  | Action                              |
|--------|---------------------------------------|-------------------------------------|
| GET    | `/api/health`                         | `{ ok: true }` if DB is reachable   |
| GET    | `/api/orders`                         | List all (with embedded relations)  |
| POST   | `/api/orders`                         | Create new                          |
| GET    | `/api/orders/:id`                     | Single record                       |
| PUT    | `/api/orders/:id`                     | Update record                       |
| DELETE | `/api/orders/:id`                     | Delete                              |
| POST   | `/api/orders/:id/<sub-action>`        | State transition / sub-resource     |
| GET    | `/api/orders/:id/stats`               | Computed view                       |

Use the WO number (not the database ID) as `:id` in URLs — it's stable, human-readable, and what users will see in logs.

### 8.4 Error handling

Every route is wrapped in `try { … } catch (err) { … }` and returns a JSON error:

```js
router.put('/api/orders/:id', async (req, res) => {
  try {
    // … work …
    res.json({ success: true });
  } catch (err) {
    console.error('PUT order error:', err);
    res.status(500).json({ error: 'Failed to update order' });
  }
});
```

Log prefix `<app-name>` for cross-cutting bookkeeping logs:

```js
console.error('[production-tracker] wo.completed bookkeeping failed:', eventErr);
```

Don't use express-style error middleware unless you have a real reason. Per-route try/catch keeps the failing endpoint visible in the log.

### 8.5 Health endpoint

Every sub-app must expose `GET /api/health` that does a `SELECT 1` against its own DB and returns `{ ok: true }` or `{ ok: false, error }`. The portal uses this to render integration status; the dispatch-qc client uses it to know whether to enable cross-app reads.

### 8.6 Cross-app event bus

If the app emits events that other sub-apps care about (`wo.completed`, etc.), use the in-process bus at `/var/www/5s-tracker/event-bus.js`. The pattern is best-effort — never crash if the bus isn't loaded:

```js
let bus = { publish: () => {} };
try { bus = require('/var/www/5s-tracker/event-bus'); }
catch (e) { console.warn('[your-app] event-bus not available; events will be skipped.'); }
// later:
bus.publish('wo.completed', { wo_number, title, … });
```

Consumers should also poll as a safety net.

### 8.7 Authentication

There is none, by design. The portal lives behind a single shared password handled by Hostinger's basic auth at the domain level. **Don't build per-user logins inside a sub-app.** If a feature needs author tracking, capture a free-text name in localStorage and treat it as honour-system identity.

---

## 9. Database conventions

### 9.1 Schema file

`schema.sql` is the source of truth and is idempotent — it can run on a fresh DB or an existing one. Every new column uses `ADD COLUMN IF NOT EXISTS`; every table uses `CREATE TABLE IF NOT EXISTS`; every index uses `CREATE INDEX IF NOT EXISTS`. This is what makes `git pull && npm run init-db` safe on production.

```sql
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_work_orders_completed_at ON work_orders(completed_at);
```

When a new column needs a non-null default and the table is already populated, ship the column nullable, backfill in `scripts/init-db.js`, then alter to NOT NULL in a follow-up migration. Don't try to do it in one statement.

### 9.2 Indexes

Index every column that's filtered or sorted in a hot query path:

- `wo_id` foreign keys
- `priority`, `status`, `target_date`, `completed_at`, `dispatch_status`
- Anything that drives a dashboard count or list

Indexes are cheap on this data scale. Missing them shows up as slow page loads at 50+ rows.

### 9.3 Foreign keys

Use `REFERENCES parent(id) ON DELETE CASCADE` for child rows that have no meaning without their parent (stages → work order, attachments → comment). Use no `ON DELETE` clause when the child should block parent deletion.

### 9.4 Type choices

| Use                        | Type                  |
|----------------------------|-----------------------|
| Primary key                | `SERIAL PRIMARY KEY`  |
| User-facing identifier     | `VARCHAR(20) UNIQUE`  |
| Free-text name             | `VARCHAR(255)`        |
| Long-form notes / body     | `TEXT`                |
| Calendar date (no time)    | `DATE`                |
| Real timestamp             | `TIMESTAMP`           |
| Bounded enum               | `VARCHAR(20) CHECK (… IN (…))` |
| Boolean flag               | `BOOLEAN DEFAULT FALSE` |
| Auto-stamped audit field   | `TIMESTAMP DEFAULT NOW()` |

Don't store dates as `VARCHAR` for "easier display" — except for the case where the user is typing a free-form date string (`"15 Apr 10:00"`). Real timestamps go in `TIMESTAMP` columns; if you need both (display string + computed duration), keep them in separate columns. See production-tracker's `started_at` (text) vs `started_ts` (timestamp) for the pattern.

### 9.5 Seed data

`scripts/init-db.js`:
1. Reads `schema.sql` and runs it.
2. Checks `SELECT COUNT(*) FROM <main_table>` — if non-zero, skips seeding.
3. Otherwise inserts a small set of representative rows so the app is testable on a fresh deploy.

Seed data should cover the canonical states (one of each status, priority, etc.) so screenshots and bug reports are easy.

---

## 10. File uploads

If your app needs photo / file attachments, use this pattern (see production-tracker for working code):

1. **Storage:** filesystem under `<app-folder>/uploads/`. Add `uploads/*` and `!uploads/.gitkeep` to `.gitignore`. Commit the empty `uploads/.gitkeep`.

2. **Multer config:** disk storage, content-addressed filenames (timestamp + random hex), 10 MB per file, mime allowlist (`image/jpeg`, `image/png`, `image/webp`):

   ```js
   const upload = multer({
     storage: multer.diskStorage({ destination: UPLOADS_DIR, filename: contentAddressed }),
     limits: { fileSize: 10 * 1024 * 1024, files: 8 },
     fileFilter: (req, file, cb) => allowed.has(file.mimetype) ? cb(null, true) : cb(new Error(...)),
   });
   ```

3. **Static serve:** mount under the app's sub-path so URLs are predictable and 7-day immutable cache works:

   ```js
   router.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d', immutable: true }));
   ```

4. **DB row:** keep the on-disk filename (unique) AND the original filename (for display) AND mime + size. Don't store image bytes in Postgres.

5. **Cleanup:** when the parent row is deleted, unlink the on-disk files in the API handler. Triggers can't unlink filesystem files.

6. **Self-healing:** `fs.mkdirSync(UPLOADS_DIR, { recursive: true })` on startup so the deploy works even if someone manually removed the folder on the VPS.

---

## 11. Deployment & ops

The cycle is documented in detail in `OPERATIONS_PORTAL_APP_UPDATE_GUIDE.md`. Summary:

```bash
# 1. Mac (or via GitHub Desktop)
cd /path/to/<app-folder>
git add . && git commit -m "<what changed>" && git push

# 2. VPS — pick the variant matching your change
cd /var/www/<app-folder> && git pull && pm2 restart 5s-tracker                                # code-only
cd /var/www/<app-folder> && git pull && npm install --omit=dev && pm2 restart 5s-tracker      # new dep
cd /var/www/<app-folder> && git pull && npm run init-db && pm2 restart 5s-tracker             # schema change
cd /var/www/<app-folder> && git pull && npm install --omit=dev && npm run init-db && pm2 restart 5s-tracker  # both

# 3. Browser hard-refresh: Cmd+Shift+R
```

What success looks like:
- `git pull`: `Updating <oldsha>..<newsha>`, `Fast-forward`, files-changed line. Never `Already up to date.` if you just pushed.
- `pm2 restart`: `[5s-tracker](N) ✓`, fresh PID, uptime in **seconds** (proves it actually restarted), all other apps still online.

Rollback: `git reflog -5 && git reset --hard HEAD@{1} && pm2 restart 5s-tracker`. The bad commit stays on GitHub for analysis.

---

## 12. Naming conventions

### 12.1 Files & folders

- App folder: `kebab-case` matching the GitHub repo and `/var/www/<folder>` (`production-tracker`, `simple-installation-scheduler`).
- Routes file: `server.js` at the repo root (always).
- Schema file: `schema.sql` at the repo root.
- Init script: `scripts/init-db.js`.
- Public assets: `public/index.html` (one file).

### 12.2 CSS classes

`kebab-case`. Domain-specific classes get a context prefix (`kanban-card`, `dash-card`, `eff-tile`). State variants append `-<state>`:

```
.stage-cell .stage-completed
.priority   .priority-high
.eff-tile   .eff-tile.bad
.kanban-card.overdue-4d
```

Shared atoms (`.btn`, `.chip`, `.pill`) live without a prefix.

### 12.3 JavaScript

`camelCase` functions and variables. Names are descriptive — `getOverFourDayOrders`, not `getOver4d` or `getOFD`. Render functions start with `render` (`renderTable`, `renderKanban`); fetch handlers start with `load` (`loadOrders`); modal openers start with `open` (`openCommentsModal`).

Helpers stay top-level. No classes, no modules. State globals are `let`; lookups are `const`.

### 12.4 Database columns

`snake_case`. Booleans start with `has_` or `is_` (`has_outsourced_printing`, `is_archived`). Timestamps end in `_at` for human-readable strings, `_ts` for real `TIMESTAMP` columns when both exist. Foreign keys are `<parent>_id`.

API field names are `camelCase` in JSON; the conversion happens in the handler:

```js
res.json({ targetDate: row.target_date, hasOutsourcedPrinting: row.has_outsourced_printing });
```

### 12.5 Status values

Always `snake_case`, always lowercase (`not_started`, `in_progress`, `completed`, `delayed`, `outsourced`). The CSS class names depend on this — don't deviate.

---

## 13. Accessibility minimums

- Every clickable surface has a `cursor: pointer`.
- Every icon-only button has a `title` attribute describing what it does.
- Every form input has a `<label>` element above it (not just placeholder).
- Tab order should make sense — let the natural DOM order do the work; don't add `tabindex` unless you have to.
- Modals close on `&times;`, on overlay click, and on Cancel button. Provide all three.
- Don't rely on colour alone. The age pill says "5d" + has a 🔴 emoji + a halo + a pulse + a tooltip. A red row also flips the Overall column to "Delayed". Layered signals.
- Maintain WCAG AA contrast: white on `#16a34a` is fine; white on `#fef3c7` is not.

---

## 14. Reusable scaffold checklist

When building a new sub-app, copy production-tracker as a starting point and tick these off:

- [ ] Repo cloned, `package.json` rewritten with new app name and version `1.0.0`.
- [ ] `db.js` uses the dotenv isolation pattern.
- [ ] `.env.example` committed; `.env` in `.gitignore`.
- [ ] `schema.sql` exists and is idempotent; all `CREATE` and `ALTER` are `IF NOT EXISTS`.
- [ ] `scripts/init-db.js` runs the schema and seeds representative data only on an empty DB.
- [ ] `server.js` exports a `Router`, with a standalone-mode tail for local dev.
- [ ] `GET /api/health` returns `{ ok: true }`.
- [ ] CRUD endpoints follow the REST conventions in §8.3.
- [ ] `public/index.html` follows the foundations + components + layouts from §2–§5.
- [ ] App shell has `[🏠 Portal]` link, brand-navy header, four standard tabs.
- [ ] All clickable WO titles open a comments modal (§4.5 + §10).
- [ ] Status / priority / age uses the canonical colours from §3.
- [ ] Dashboard has summary cards + at least one efficiency / health section.
- [ ] `OPERATIONS_PORTAL_APP_UPDATE_GUIDE.md` deploy commands tested locally end-to-end before first push.
- [ ] `OPERATIONS_PORTAL_NEW_APP_GUIDE.md` Phase 4 mount added to the parent `5s-tracker/server.js`.
- [ ] Currently-deployed-apps registry updated.
- [ ] First deploy on the VPS produces an `online` PM2 process with seconds of uptime, all other apps untouched.

End of guide.
