# Operations Portal — New Sub-App Deployment Guide

**Version 1.0** · Distilled from the installation-scheduler deployment, April 2026.
This guide is the practical companion to `Operations-Portal-Deployment-Guide.docx`. The original document covers the *architecture*; this one covers the exact, step-by-step *procedure* for adding a new sub-app, with all the lessons learned on the first deployment baked in.

---

## Table of Contents

1. [When to use this guide](#when-to-use-this-guide)
2. [Architecture in one paragraph](#architecture-in-one-paragraph)
3. [Naming conventions](#naming-conventions)
4. [Prerequisites checklist](#prerequisites-checklist)
5. [Phase 1 — Build the app locally](#phase-1--build-the-app-locally)
6. [Phase 2 — GitHub repo and first push](#phase-2--github-repo-and-first-push)
7. [Phase 3 — VPS setup (database, clone, install)](#phase-3--vps-setup-database-clone-install)
8. [Phase 4 — Mount the router in the main server.js](#phase-4--mount-the-router-in-the-main-serverjs)
9. [Phase 5 — Add the portal card](#phase-5--add-the-portal-card)
10. [Phase 6 — Restart, verify, smoke test](#phase-6--restart-verify-smoke-test)
11. [Future updates to the same app](#future-updates-to-the-same-app)
12. [Rollback procedures](#rollback-procedures)
13. [Pitfalls and lessons learned](#pitfalls-and-lessons-learned)
14. [Boilerplate templates](#boilerplate-templates)
15. [Currently deployed apps registry](#currently-deployed-apps-registry)
16. [Quick-reference command sequence](#quick-reference-command-sequence)

---

## When to use this guide

Use this when you are:

- Building a new shopfloor / EHS / operations app from scratch (e.g. Safety Incident Log, Quality Audit, Maintenance Tracker)
- Adding it as a clickable card on the `operation.yotser.in` landing page
- Mounting it as a sub-path of the operations portal (e.g. `/safety/`, `/quality/`)

Do **not** use this guide for apps that should run on their own domain with their own PM2 process (like the standalone `installation-scheduler` on `installation.yotser.in`). For those, see the original `Operations-Portal-Deployment-Guide.docx` Section 4.2 (Option B).

**Time required:** 30–45 minutes for an experienced developer following this guide on the second app onwards. The first one took longer because we had to debug environment isolation; that fix is now baked into the templates below.

---

## Architecture in one paragraph

Every sub-app is an Express **Router** (not a full app) that exports `module.exports = router`. The main 5s-tracker app at `/var/www/5s-tracker/server.js` requires the sub-app's `server.js` via an absolute path and mounts it with `app.use('/your-path', subRouter)`. The sub-app uses its own Postgres database, its own `.env`, its own folder, but shares the 5s-tracker process and port (3010). Static files, photo uploads, and everything served by the sub-app are handled by Express within that one Node process. PM2 supervises the main process under the name `5s-tracker`. Nginx (running inside a Docker container) proxies port 80/443 to localhost:3010. Each app gets a card on `operation.yotser.in`'s landing page, defined in the `apps` array in `/var/www/5s-tracker/portal/index.html`.

---

## Naming conventions

These conventions ensure consistency across apps and keep mount paths, folder names, repo names, and database names in sync:

| Item | Convention | Example |
|---|---|---|
| App name (display) | Title Case | `Installation Scheduler` |
| Folder name (local + VPS) | `kebab-case` | `simple-installation-scheduler` |
| GitHub repo name | matches folder | `simple-installation-scheduler` |
| Mount path | `/lowercase/` | `/installation/` |
| Postgres DB name | `snake_case` matching folder | `simple_installation_scheduler` |
| Postgres user | shared `fivesuser` | (don't create new users) |
| Router variable in main server.js | `camelCase` + `Router` | `installationRouter` |
| PM2 process name | `5s-tracker` (shared) | (sub-apps don't get their own PM2) |

The folder name typically embeds a clarifier word so it doesn't collide with future apps. We chose `simple-installation-scheduler` because there was already an `installation-scheduler` running on its own domain.

---

## Prerequisites checklist

Run through this before starting:

- [ ] Local Mac with Node.js v20 or higher and Git installed
- [ ] You can SSH to the VPS (or use Hostinger's web terminal at hpanel.hostinger.com → VPS → Browser SSH)
- [ ] You have a GitHub account with push permission to the org/account that will own the repo
- [ ] You know your GitHub Personal Access Token, or know how to mint a new one (Settings → Developer Settings → Tokens (classic) → `repo` scope)
- [ ] You know the Postgres `fivesuser` password used in the main 5s-tracker `.env` (see `/var/www/5s-tracker/.env`)
- [ ] You've picked an emoji icon and accent background color for the portal card

---

## Phase 1 — Build the app locally

The goal of Phase 1 is to produce a working app that runs locally on your Mac, with all the conventions ready for production. Estimated time: 1–4 hours for a real app, depending on scope.

### 1.1 Folder structure

Create a folder named `<your-app-name>` somewhere on your Mac. The structure must look like this (the same as Section 3.1 of the original deployment guide):

```
your-app-name/
├── server.js              # Express Router with all API + static-file routes
├── db.js                  # PostgreSQL pool — uses the ISOLATED env pattern
├── schema.sql             # Database table definitions
├── scripts/
│   └── init-db.js         # Creates tables and seeds initial data
├── public/
│   └── index.html         # Single-file frontend (HTML/CSS/JS)
├── uploads/
│   └── .gitkeep           # Empty placeholder so the folder is tracked
├── package.json
├── .env.example           # Template documenting required env vars
├── .gitignore             # Must exclude node_modules, .env, uploads/*
└── local.js               # Local-dev wrapper (mounts the router on /your-path)
```

Use the templates in [Boilerplate templates](#boilerplate-templates) at the bottom of this guide to start any of these files. You can copy them verbatim from the `simple-installation-scheduler` repo as a starting point, then customize.

### 1.2 The critical `db.js` pattern (do not skip this)

This is the single most important section of this guide. Get this wrong and you will spend hours debugging "relation does not exist" errors that look like database misconfiguration but are actually environment-variable issues.

**Why this matters.** When your sub-app is required by the main 5s-tracker process, the parent has already called `require('dotenv').config()` and `process.env.DATABASE_URL` already points at the parent's database (`fives_tracker`). dotenv refuses to override existing environment variables by default. So if your `db.js` does the obvious `require('dotenv').config()`, your code silently connects to the wrong database. Inserts into your tables fail with `relation "X" does not exist`. The init-db script always works because it runs in a fresh Node process where the parent's env hasn't been set yet — so the bug only appears in production.

**The fix.** Read your own `.env` file directly with `dotenv.parse(fs.readFileSync(...))`. Don't touch `process.env` at all. Use a small `get()` helper that prefers your local env values over the parent's.

The pattern (copy this verbatim into every new sub-app's `db.js`):

```js
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Read THIS app's .env directly into a local object — do NOT touch process.env.
// When mounted as a sub-router inside another app (e.g. /var/www/5s-tracker),
// the parent has already called dotenv.config() and process.env.DATABASE_URL
// points at the parent's database. dotenv.config() refuses to override existing
// env vars by default, so we'd silently use the wrong DB. Reading our own
// .env directly with dotenv.parse() avoids the conflict entirely.
const envPath = path.join(__dirname, '.env');
const localEnv = fs.existsSync(envPath)
  ? dotenv.parse(fs.readFileSync(envPath))
  : {};
const get = (k) => (localEnv[k] !== undefined ? localEnv[k] : process.env[k]);

const pool = new Pool(
  get('DATABASE_URL')
    ? { connectionString: get('DATABASE_URL') }
    : {
        host:     get('PGHOST')     || 'localhost',
        port:     get('PGPORT')     || 5432,
        user:     get('PGUSER')     || 'postgres',
        password: get('PGPASSWORD'),
        database: get('PGDATABASE') || 'your_app_database_name',
      }
);

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
```

The only thing you need to change between apps is the fallback `database:` value at the bottom — and that fallback only fires if `DATABASE_URL` isn't set, which it always will be in practice.

### 1.3 server.js (Express Router pattern)

The sub-app's `server.js` must export a `Router`, not call `app.listen()`. The app.listen for the 5s-tracker process is already there in `/var/www/5s-tracker/server.js`. If your sub-app calls listen, it'll either fail (port already taken) or open a phantom second listener that nobody can reach.

Skeleton (see [Boilerplate templates](#boilerplate-templates) for a fuller example):

```js
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');           // only if you need file uploads
const db      = require('./db');

const router = express.Router();

// File uploads (skip if not needed)
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

// Body parsing
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// Static files — uploads first, then public
router.use('/uploads', express.static(UPLOAD_DIR));
router.use(express.static(path.join(__dirname, 'public')));

// Health check
router.get('/api/health', (_req, res) => res.json({ ok: true }));

// Your API routes here — all prefixed with /api/
// router.get('/api/widgets', ...);
// router.post('/api/widgets', ...);

// SPA fallback — sends index.html for any unmatched GET
router.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
router.use((err, _req, res, _next) => {
  console.error('[your-app-name]', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

module.exports = router;
```

### 1.4 Frontend `public/index.html`

The frontend is a single-file HTML/CSS/JS document. The most important convention is the API base path:

```js
// At the top of your frontend script
const API = '/your-path';   // matches your sub-path mount, e.g. '/installation'

// Use it for every fetch call
fetch(`${API}/api/widgets`)

// Use it for image URLs from the backend
img.src = `${API}${item.photo_path}`;
```

This way the same HTML works at `localhost:3001/your-path/` during local dev (when run via `local.js`) and at `operation.yotser.in/your-path/` in production.

### 1.5 Local testing

Before committing anything, test on your Mac:

```bash
# Create local Postgres database
createdb your_app_database_name

# Set up environment
cp .env.example .env
# Edit .env and put in real local Postgres credentials

# Install + init
npm install
npm run init-db

# Run with the local-dev wrapper (mounts at /your-path on PORT)
npm start
# Visit http://localhost:3001/your-path/
```

Test thoroughly: every CRUD operation, file uploads, every page in the frontend. The deployment cycle (push, pull, restart) is fast but fixing a regression in production is more disruptive than fixing it locally.

---

## Phase 2 — GitHub repo and first push

Estimated time: 5 minutes.

### 2.1 Create the empty repo on GitHub

1. Go to https://github.com/new
2. Owner: your account or org (we used `sadanandvyas-tech`)
3. Repository name: same as your folder (`your-app-name`)
4. Description: one-line summary
5. Visibility: **Private** (the apps hold customer data)
6. Initialize: leave **all** init options unchecked (no README, no .gitignore, no license — your local folder already has these)
7. Click **Create repository**
8. Copy the HTTPS URL from the next page: `https://github.com/<owner>/<repo>.git`

### 2.2 Initialize git locally and push

In your Mac Terminal, in the project folder:

```bash
cd "/path/to/your-app-name"
git init
git add .
git status                 # verify all files are listed, nothing unwanted
git commit -m "Initial <your-app-name>"
git branch -M main
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

When `git push` prompts for credentials:

- Username: your GitHub username
- Password: your **Personal Access Token** (not your GitHub account password — GitHub stopped accepting account passwords in 2021)

To create a new PAT if you don't have one: https://github.com/settings/tokens → Generate new token (classic) → `repo` scope → Generate.

### 2.3 Verify on GitHub

Refresh the repo page in your browser. You should see all your files, "1 commit", and your initial commit message. Confirm there is no `node_modules/`, no `.env`, no `*.log`, no files inside `uploads/` other than `.gitkeep`.

---

## Phase 3 — VPS setup (database, clone, install)

Estimated time: 5–10 minutes. Everything from here onwards happens on the VPS.

### 3.1 Get into the VPS

Two options. Pick whichever works.

**Option A — direct SSH** (only if SSH from your Mac is configured):

```bash
ssh <user>@187.127.128.19
```

Note: root SSH from outside is disabled. You'd need an SSH key on a non-root account.

**Option B — Hostinger web terminal** (the reliable fallback):

1. Log in at hpanel.hostinger.com
2. Navigate to your VPS (srv1479112)
3. Open the Browser SSH / Browser Terminal feature
4. You're in as root

### 3.2 Verify VPS state before any changes

This is a defensive step. Before touching anything, confirm everything that's already running is healthy. If it isn't, fix that first — don't deploy on top of a broken state.

```bash
ls /var/www && echo "---" && pm2 list && echo "---" && psql --version && echo "---" && which node
```

You should see:

- `/var/www` containing `5s-tracker`, plus folders for any other deployed apps. Your new folder `your-app-name` should NOT yet exist
- All current PM2 processes `online`
- Postgres 16.x
- Node at `/usr/bin/node`

If any existing app is in `errored` or `stopped` state, stop. Investigate that before deploying anything new.

### 3.3 Look at the existing `5s-tracker/.env` to copy the credential pattern

```bash
cat /var/www/5s-tracker/.env
```

You'll see something like:

```
PORT=3010
DATABASE_URL=postgres://fivesuser:<password>@localhost:5432/fives_tracker
```

Copy the `fivesuser:<password>` portion — you'll use it in your new app's `.env` (with a different database name at the end).

### 3.4 Create the new database

```bash
sudo -u postgres psql -c "CREATE DATABASE your_app_database_name OWNER fivesuser;"
```

The `OWNER fivesuser` clause grants the existing app user full permission on the new database. This means your app reuses the existing Postgres credentials — no new role to manage.

Verify it landed:

```bash
sudo -u postgres psql -l | grep your_app_database_name
```

### 3.5 Verify port availability (sanity check)

Since your sub-app mounts inside the 5s-tracker process, it doesn't need its own port. But run this to confirm — if you accidentally call `app.listen()` somewhere, you'll want to know what's free:

```bash
ss -tlnp | grep -E ':(3000|3001|3010|4000|5432|80|443)\s' | sort -k4
```

Expected entries: 3010 (5s-tracker), 5432 (Postgres), 80/443 (Docker Nginx), plus whatever existing sub-domain apps you have. **3010 is the only port that matters for sub-apps** — everything else flows through it.

### 3.6 Clone the repo

```bash
cd /var/www && git clone https://github.com/<owner>/<repo>.git
```

When prompted: username + PAT. Same as during the push.

### 3.7 Verify the clone

```bash
cd /var/www/your-app-name && ls -la
```

Confirm the file list matches what's in your local folder. The `.git/` directory should be present (proof it's a working git checkout — important for future `git pull` updates).

### 3.8 Create the production `.env`

```bash
cat > /var/www/your-app-name/.env << 'EOF'
DATABASE_URL=postgres://fivesuser:<password>@localhost:5432/your_app_database_name
EOF
cat /var/www/your-app-name/.env
```

Replace `<password>` with the actual password from `/var/www/5s-tracker/.env`. Replace `your_app_database_name` with your actual database name.

Note: do **not** include a `PORT=` line. It's dead code in production (the router doesn't bind to a port) and including it gives a false impression that the app is owning a port.

### 3.9 Install dependencies and initialize the database

```bash
cd /var/www/your-app-name && npm install --omit=dev && npm run init-db
```

You should see:

- `npm install`: ~100 packages, 0 vulnerabilities
- `init-db.js` output: `Applying schema...`, `Seeding sample data...`, `Done.`

If you see `password authentication failed for user "fivesuser"`, your `.env` password is wrong — re-check against `/var/www/5s-tracker/.env`.
If you see `database "your_app_database_name" does not exist`, you skipped Step 3.4.

---

## Phase 4 — Mount the router in the main server.js

Estimated time: 5 minutes. **Critical step** — a syntax error here will crash the whole portal.

### 4.1 Back up the main server.js first

Always do this before any edit to the main server file:

```bash
cp /var/www/5s-tracker/server.js /var/www/5s-tracker/server.js.bak.$(date +%Y%m%d-%H%M%S)
ls -la /var/www/5s-tracker/server.js*
```

The timestamped filename means multiple backups can co-exist if you deploy multiple apps in one session.

### 4.2 Insert the two mount lines using the Python script below

Set the variables at the top, then paste the whole block. The script is **idempotent** (safe to re-run — it detects and skips if already inserted) and content-based (it finds the right insertion point by searching for an existing mount, so it works regardless of line numbers).

```bash
# === Set these for your app ===
APP_FOLDER="your-app-name"             # the folder under /var/www/
MOUNT_PATH="/your-path"                # the URL sub-path
ROUTER_VAR="yourAppRouter"             # camelCase variable name + "Router"
# ==============================

python3 << PYEOF
import re
fn = '/var/www/5s-tracker/server.js'
folder    = "${APP_FOLDER}"
mount     = "${MOUNT_PATH}"
router_v  = "${ROUTER_VAR}"

with open(fn) as f: text = f.read()
if folder in text:
    print(f'Mount for {folder} already present, skipping')
else:
    # Find the existing /production mount and insert after it
    pattern = r"(app\.use\('\/production',\s*productionRouter\);\s*\n)"
    new_block = (
        f"\nconst {router_v} = require('/var/www/{folder}/server');\n"
        f"app.use('{mount}', {router_v});\n"
    )
    new_text, n = re.subn(pattern, r"\1" + new_block, text, count=1)
    if n != 1:
        # Fallback: insert before app.listen
        pattern = r"(app\.listen\()"
        new_text, n = re.subn(pattern, new_block + "\n" + r"\1", text, count=1)
    if n != 1:
        raise SystemExit('Could not find an insertion point in server.js')
    with open(fn, 'w') as f: f.write(new_text)
    print(f'Mounted {folder} at {mount}')

# Show the area around the mount section so we can eyeball it
with open(fn) as f: lines = f.readlines()
for i, l in enumerate(lines):
    if folder in l:
        for j in range(max(0, i-3), min(len(lines), i+3)):
            print(f'{j+1:>4}: {lines[j].rstrip()}')
        break
PYEOF
```

### 4.3 Verify with `node --check`

This is the absolutely critical sanity check. **Do not restart PM2 if this fails.**

```bash
node --check /var/www/5s-tracker/server.js && echo "OK"
```

If it prints `OK`, the file is syntactically valid and safe to load. If it prints a `SyntaxError`, you have a problem — restore from backup:

```bash
ls /var/www/5s-tracker/server.js.bak.*    # find your most recent backup
cp /var/www/5s-tracker/server.js.bak.YYYYMMDD-HHMMSS /var/www/5s-tracker/server.js
```

Then investigate — usually it's a typo in the env vars at the top of the script, or the file already had a similar mount that broke the regex.

---

## Phase 5 — Add the portal card

Estimated time: 3 minutes. This adds the visible card to the operations portal landing page.

### 5.1 Pick an emoji and accent color

Look at existing cards in `/var/www/5s-tracker/portal/index.html` (the `apps` array) to see what's been used. Pick something distinct and meaningful:

- Industrial / safety: 🏭 🛡️ ⚠️ 🦺
- Documents / records: 📋 📑 📊 🗂️
- Scheduling / calendar: 🗓️ 📅 ⏰ ⌛
- Quality / inspection: 🔍 ✅ 🧪
- Maintenance / tools: 🔧 🔩 🛠️
- People / training: 👷 🧑‍🏫 👥

For the `iconBg` color, use a soft pastel that contrasts with the white card background. Common ones already used: `#eef2ff` (cool blue), `#eff6ff` (lighter blue), `#dbeafe` (sky blue), `#fef2f2` (rose), `#fef3c7` (amber), `#d1fae5` (mint), `#f3e8ff` (lavender).

### 5.2 Insert the card using the Python script below

Same pattern as Phase 4 — set vars, paste script. Idempotent.

```bash
# === Set these for your app ===
APP_NAME="Your App Name"               # display title, Title Case
APP_DESC="Brief description of what the app does."
MOUNT_PATH="/your-path/"               # MUST end with trailing slash
EMOJI="🛡️"                              # pick an emoji
ICON_BG="#fef2f2"                      # pastel hex
# ==============================

python3 << PYEOF
import re
fn = '/var/www/5s-tracker/portal/index.html'
name     = "${APP_NAME}"
desc     = "${APP_DESC}"
url_path = "${MOUNT_PATH}"
emoji    = "${EMOJI}"
icon_bg  = "${ICON_BG}"

with open(fn) as f: text = f.read()
if f"url: '{url_path}'" in text:
    print(f'Card for {url_path} already present, skipping')
else:
    # Detect indentation from an existing card
    m = re.search(r'(?P<brace>[ \t]+)\{\s*\n(?P<prop>[ \t]+)name:', text)
    if not m: raise SystemExit('Could not detect card indentation')
    bi, pi = m.group('brace'), m.group('prop')

    new_card = (
        f"{bi}{{\n"
        f"{pi}name: '{name}',\n"
        f"{pi}icon: '{emoji}',\n"
        f"{pi}iconBg: '{icon_bg}',\n"
        f"{pi}description: '{desc}',\n"
        f"{pi}url: '{url_path}',\n"
        f"{pi}status: 'live'\n"
        f"{bi}}},\n"
    )

    # Insert before the "// To add a new app" comment if present, otherwise before "];"
    new_text, n = re.subn(r'([ \t]*//\s*To add a new app)', new_card + r'\1', text, count=1)
    if n != 1:
        new_text, n = re.subn(r'(\n\s*\];)', '\n' + new_card.rstrip('\n') + r'\1', text, count=1)
    if n != 1:
        raise SystemExit('Could not find an insertion point in portal/index.html')

    with open(fn, 'w') as f: f.write(new_text)
    print(f'Inserted card for {name}')

# Print the apps array for visual confirmation
with open(fn) as f: lines = f.readlines()
start = end = None
for i, l in enumerate(lines):
    if start is None and 'const apps' in l: start = i
    if start is not None and l.strip().startswith('];'):
        end = i; break
if start is not None and end is not None:
    print('\n--- apps array ---')
    for i in range(start, end + 1):
        print(f'{i+1:>4}: {lines[i].rstrip()}')
PYEOF
```

The portal page renders cards reactively from this array, so no further frontend rebuild is needed.

---

## Phase 6 — Restart, verify, smoke test

Estimated time: 2 minutes plus however long you spend testing in the browser.

### 6.1 Restart PM2 and tail logs

```bash
pm2 restart 5s-tracker && sleep 2 && pm2 list && echo "---" && pm2 logs 5s-tracker --lines 30 --nostream
```

What to look for:

- `[PM2] [5s-tracker](4) ✓` — restart acknowledged
- `5s-tracker` showing `online` with a fresh uptime (seconds, not days)
- The `out.log` boot lines: `Operations Portal running on http://localhost:3010`, `Portal: /`, `5S Tracker: /5s/`
- **No** `Cannot find module`, `SyntaxError`, or stack trace
- **No** `relation "X" does not exist` — that would indicate the dotenv isolation pattern wasn't applied correctly in `db.js`

If you see a startup crash, roll back immediately (see [Rollback procedures](#rollback-procedures)).

### 6.2 Browser smoke test

Open Chrome and verify, in order:

1. **Portal** — `https://operation.yotser.in/` shows your new card alongside existing ones, with the right title, emoji, color, description, and a green LIVE badge
2. **App loads** — clicking the card opens `https://operation.yotser.in/your-path/` with full styling, no white screen, no console errors
3. **API health** — open `https://operation.yotser.in/your-path/api/health` directly — returns `{"ok":true}`
4. **Static assets** — DevTools → Network → reload the app; nothing returns 404, all CSS/JS comes from `your-path/...`
5. **CRUD** — create one record through the UI, verify it persists by reloading the page
6. **File uploads** (if your app has them) — upload one small file, confirm it renders back. Photos should use the URL pattern `${API}${path}` so they correctly include the sub-path prefix
7. **Reload survival** — refresh the app at a deep URL (e.g. `your-path/something/123`); the SPA fallback should serve `index.html` without a 404

### 6.3 Pre-launch cleanup

- Delete any test records you created during the smoke test
- Confirm the seed technician/category/whatever data is what you actually want in production (some seeds make sense, others should be cleared)

---

## Future updates to the same app

Once the app is deployed, future code changes follow this lightweight cycle:

**On your Mac** (after making code changes):

```bash
cd "/path/to/your-app-name"
git add .
git commit -m "<what changed>"
git push
```

**On the VPS** (Hostinger web terminal or SSH):

```bash
cd /var/www/your-app-name && git pull && pm2 restart 5s-tracker
```

That's it. The mount in the main server.js doesn't change — it's just a `require()` and your file gets reloaded when PM2 restarts the process.

**If you added new npm packages:**

```bash
cd /var/www/your-app-name && git pull && npm install --omit=dev && pm2 restart 5s-tracker
```

**If you changed the database schema** (added a column, new table, etc.):

```bash
cd /var/www/your-app-name && git pull && npm run init-db && pm2 restart 5s-tracker
```

The `init-db` script is idempotent if you wrote it with `IF NOT EXISTS` clauses (recommended). For destructive migrations, write a separate `scripts/migrate-XYZ.js` file you can run once.

**Recommended VPS shell alias** — add to `~/.bashrc` to save typing:

```bash
alias deploy-yourapp='cd /var/www/your-app-name && git pull && pm2 restart 5s-tracker'
```

Then any future deploy is just `deploy-yourapp`.

---

## Rollback procedures

### Roll back a single sub-app to a previous commit

```bash
cd /var/www/your-app-name
git log --oneline -10                # find the last good commit
git reset --hard <good-sha>
pm2 restart 5s-tracker
```

### Roll back changes to the main 5s-tracker server.js

```bash
ls /var/www/5s-tracker/server.js.bak.*           # find recent backups
cp /var/www/5s-tracker/server.js.bak.YYYYMMDD-HHMMSS /var/www/5s-tracker/server.js
pm2 restart 5s-tracker
```

### Roll back changes to portal/index.html

The portal HTML doesn't get backed up by default the way `server.js` does. Use git on the 5s-tracker repo itself:

```bash
cd /var/www/5s-tracker
git log --oneline -- portal/index.html | head -5
git checkout <good-sha> -- portal/index.html
pm2 restart 5s-tracker        # not strictly needed for HTML changes, but harmless
```

### Remove a sub-app entirely (without deleting code)

1. In `/var/www/5s-tracker/server.js`, comment out (don't delete) the two mount lines for the app
2. In `/var/www/5s-tracker/portal/index.html`, comment out (don't delete) the card object
3. `pm2 restart 5s-tracker`

The app's code, database, and uploads remain on disk; you can revive it later by uncommenting.

To **delete** completely:

```bash
pm2 stop 5s-tracker
# remove mount + card edits in 5s-tracker
rm -rf /var/www/your-app-name
sudo -u postgres psql -c "DROP DATABASE your_app_database_name;"
pm2 start 5s-tracker
```

---

## Pitfalls and lessons learned

These are the bugs we hit on the first deployment. The templates in this guide already work around them — but understanding why they exist helps you debug new issues.

### Pitfall 1 — `dotenv.config()` won't override the parent process's env vars

**Symptom:** `relation "X" does not exist` errors when your sub-app tries to query its own tables, even though `npm run init-db` created them successfully.

**Cause:** When the 5s-tracker process starts, it calls `require('dotenv').config()` which loads `/var/www/5s-tracker/.env` and sets `process.env.DATABASE_URL` to the 5s-tracker's database URL. When your sub-app is later required and *its* `db.js` calls `require('dotenv').config({ path: 'your/.env' })`, dotenv sees `DATABASE_URL` is already set and refuses to override it (this is dotenv's documented default behavior). Your sub-app silently uses the parent's database.

**Fix:** Use `dotenv.parse(fs.readFileSync(...))` to read your `.env` into a local variable instead of going through `process.env`. The `db.js` template above does exactly this. Don't deviate from the pattern.

### Pitfall 2 — `PORT` in the sub-app's `.env` is dead code in production

**Symptom:** Confusion about port conflicts. You worry that your sub-app's `PORT=3001` collides with another app on 3001.

**Cause:** Your sub-app exports a Router, which doesn't bind to any port. The actual port (3010) is owned by the 5s-tracker process. The `PORT` env var is only read by `local.js` for local development.

**Fix:** Don't include `PORT=` in the production `.env`. Keep it in `.env.example` for the local-dev wrapper, but skip it on the VPS to avoid misleading future readers.

### Pitfall 3 — Calling `app.listen()` in the sub-app

**Symptom:** Either the sub-app silently does nothing, or you get `EADDRINUSE` on PM2 restart.

**Cause:** `app.listen()` is for full Express apps. A sub-router doesn't and shouldn't listen — its requests come in via the parent app's listener.

**Fix:** In sub-app `server.js`, only call `module.exports = router` at the bottom. No `app.listen()` anywhere. Use `local.js` for the local-dev listener (it lives outside `server.js` so production never sees it).

### Pitfall 4 — Static-file paths missing the sub-path prefix

**Symptom:** App loads but images, photos, or uploads return 404. Or a CSS file 404s.

**Cause:** Frontend code references absolute paths like `/uploads/file.jpg` instead of `/your-path/uploads/file.jpg`. The browser fetches the wrong URL, the request hits 5s-tracker's root path, and 5s-tracker returns 404.

**Fix:** In your frontend JS, define `const API = '/your-path'` and prefix every URL with `${API}`. For example: `img.src = ${API}${item.photo_path}`. The same code then works in local dev (where the wrapper mounts at `/your-path` too).

### Pitfall 5 — UI filters being sticky

**Symptom:** "I created a record but it's not showing up."

**Cause:** A filter dropdown (status, technician, etc.) was set, and the new record doesn't match it.

**Fix:** Always test with all filters set to "All" first. If a filter set to "All" still hides the record, then it's an actual bug.

### Pitfall 6 — GitHub PAT not cached on VPS

**Symptom:** Every `git pull` on the VPS prompts for username + password.

**Cause:** Git credential helper isn't configured.

**Fix:** Run once on the VPS:

```bash
git config --global credential.helper store
# Then do one git pull, enter username + PAT once. Future pulls won't prompt.
```

The PAT is stored plain-text in `~/.git-credentials` — fine on a single-user VPS, problematic on a multi-tenant box.

### Pitfall 7 — Forgetting to take backups before editing main server.js

**Symptom:** A typo in the mount lines crashes the entire portal. All apps go down. Panic.

**Fix:** Always run `cp server.js server.js.bak.$(date +%Y%m%d-%H%M%S)` before any edit. The backup with the timestamp is harmless to keep around (a few KB) and gets you out of trouble in seconds.

### Pitfall 8 — Multi-line paste mangling in Hostinger web terminal

**Symptom:** A multi-line shell command pastes as something like `>cd /var/www/...` and fails. The web terminal interprets stray characters as input.

**Fix:** Combine multi-line commands into a single line with `&&` between them, or use `\` line-continuation only if you're confident the paste is clean. When in doubt, paste one command at a time.

---

## Boilerplate templates

Copy these verbatim as starting points for any new sub-app. Replace `your-app-name`, `/your-path`, `your_app_database_name` placeholders.

### package.json

```json
{
  "name": "your-app-name",
  "version": "0.1.0",
  "description": "Brief description of what the app does.",
  "main": "server.js",
  "scripts": {
    "start": "node local.js",
    "init-db": "node scripts/init-db.js"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "multer": "^1.4.5-lts.1",
    "pg": "^8.11.5"
  },
  "engines": {
    "node": ">=20"
  }
}
```

### .gitignore

```
node_modules
.env
uploads/*
!uploads/.gitkeep
*.log
.DS_Store
```

### .env.example

```
# Local dev only — production VPS .env should NOT include PORT
PORT=3001
DATABASE_URL=postgres://postgres:postgres@localhost:5432/your_app_database_name
```

### db.js

See [Section 1.2](#12-the-critical-dbjs-pattern-do-not-skip-this) above. Use that exact pattern.

### scripts/init-db.js

```js
const fs = require('fs');
const path = require('path');
const db = require('../db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  console.log('Applying schema...');
  await db.query(sql);

  // Optional seed data — uncomment and customize as needed
  // const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM your_table');
  // if (rows[0].n === 0) {
  //   console.log('Seeding initial data...');
  //   await db.query(`INSERT INTO your_table (...) VALUES (...)`);
  // }

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => { console.error('init-db failed:', err); process.exit(1); });
```

### local.js

```js
require('dotenv').config();
const express = require('express');
const router  = require('./server');

const app  = express();
const PORT = process.env.PORT || 3001;
const MOUNT = '/your-path';

app.get('/', (_req, res) => res.redirect(MOUNT + '/'));
app.use(MOUNT, router);

app.listen(PORT, () => {
  console.log(`your-app-name running at http://localhost:${PORT}${MOUNT}/`);
});
```

### schema.sql skeleton

```sql
-- your-app-name schema
-- Use IF NOT EXISTS so init-db.js stays idempotent.

CREATE TABLE IF NOT EXISTS your_main_table (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_your_main_table_created_at ON your_main_table (created_at);

-- Auto-update updated_at trigger (recommended)
CREATE OR REPLACE FUNCTION your_main_table_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_your_main_table_updated_at ON your_main_table;
CREATE TRIGGER trg_your_main_table_updated_at
  BEFORE UPDATE ON your_main_table
  FOR EACH ROW EXECUTE FUNCTION your_main_table_set_updated_at();
```

### public/index.html minimal starter

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Your App — Operations Portal</title>
<style>
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#f5f6f8; color:#1f2937; }
  header { background:linear-gradient(90deg,#1e3a8a,#2563eb); color:#fff; padding:18px 24px;
           display:flex; justify-content:space-between; align-items:center; }
  header h1 { margin:0; font-size:20px; }
  main { max-width:1100px; margin:0 auto; padding:20px; }
</style>
</head>
<body>
<header>
  <div><h1>Your App</h1></div>
  <a href="/" style="color:#fff;text-decoration:none;font-size:13px;">← Operations Portal</a>
</header>
<main>
  <div id="content">Loading...</div>
</main>
<script>
  const API = '/your-path';

  async function load() {
    const res = await fetch(`${API}/api/health`);
    const data = await res.json();
    document.getElementById('content').textContent = JSON.stringify(data);
  }
  load();
</script>
</body>
</html>
```

---

## Currently deployed apps registry

Keep this table up to date as you deploy new apps. It's the single source of truth for "what's mounted where".

| App display name | Folder | Mount path | Database | PM2 | Notes |
|---|---|---|---|---|---|
| 5S Daily Tracker | `5s-tracker` | `/5s/` | `fives_tracker` | `5s-tracker` | Main app — also hosts portal at `/` |
| Projects Table | (subfolder of `5s-tracker`) | `/projects/` | (shared) | (shared) | Zoho Creator integration |
| Production Tracker | `production-tracker` | `/production/` | (TBD) | (shared) | Work-order pipeline |
| Installation Scheduler | `simple-installation-scheduler` | `/installation/` | `simple_installation_scheduler` | (shared) | Graphics/boards/LED installs |

Sibling standalone apps (their own domains, not sub-paths):

| App | Folder | Domain | Port | DB | PM2 |
|---|---|---|---|---|---|
| (legacy) installation-scheduler | `installation-scheduler` | `installation.yotser.in` | 3001 | (TBD) | `installation-scheduler` |
| EHS Display | `ehs-display` | `ehssavli.yotser.in` | 4000 | (TBD) | `ehs-display` |
| Drive Schedule | (next-server) | (TBD) | 3000 | (TBD) | `drive-schedule` |

---

## Quick-reference command sequence

Once you've done one deployment with this guide, future ones can be driven by this condensed checklist. Refer back to the detailed sections when something doesn't behave as expected.

```bash
#### LOCAL — build & push ####
cd "<your-app-folder>"
git init && git add . && git commit -m "Initial <app>"
git branch -M main
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main

#### VPS — database, clone, install ####
sudo -u postgres psql -c "CREATE DATABASE your_app_database_name OWNER fivesuser;"
cd /var/www && git clone https://github.com/<owner>/<repo>.git
cd /var/www/<your-app-folder>
cat > .env << 'EOF'
DATABASE_URL=postgres://fivesuser:<password>@localhost:5432/your_app_database_name
EOF
npm install --omit=dev && npm run init-db

#### VPS — mount in main server.js ####
cp /var/www/5s-tracker/server.js /var/www/5s-tracker/server.js.bak.$(date +%Y%m%d-%H%M%S)
# (run the Phase 4 Python script with APP_FOLDER, MOUNT_PATH, ROUTER_VAR set)
node --check /var/www/5s-tracker/server.js && echo OK

#### VPS — add portal card ####
# (run the Phase 5 Python script with APP_NAME, APP_DESC, MOUNT_PATH, EMOJI, ICON_BG set)

#### VPS — restart and verify ####
pm2 restart 5s-tracker && sleep 2 && pm2 logs 5s-tracker --lines 20 --nostream

#### Browser ####
# 1. Visit https://operation.yotser.in/             — see new card
# 2. Click card → app loads at /your-path/
# 3. Visit /your-path/api/health → {"ok":true}
# 4. Smoke-test CRUD
```

---

## Document maintenance

When something in this guide turns out to be wrong, outdated, or incomplete, fix it in this document **before** the next deployment. The whole point of this guide is to compound learning across deployments — if it stays out of date it stops being useful.

Common reasons for updates:

- A new pitfall is discovered → add to [Pitfalls and lessons learned](#pitfalls-and-lessons-learned)
- The boilerplate gets a useful improvement → update [Boilerplate templates](#boilerplate-templates) and consider whether existing apps should adopt it
- New app deployed → update [Currently deployed apps registry](#currently-deployed-apps-registry)
- Postgres password rotated → all `.env` files need updating; document the rotation procedure

End of guide.
