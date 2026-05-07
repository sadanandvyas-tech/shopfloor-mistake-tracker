# Operations Portal — Sub-App Update Guide

**Version 1.0** · Companion to `OPERATIONS_PORTAL_NEW_APP_GUIDE.md`.
That guide covers building and deploying a new app from scratch. **This** guide covers the routine cycle of pushing code changes to an app that is already deployed.

---

## Table of Contents

1. [When to use this guide](#when-to-use-this-guide)
2. [Architecture refresher](#architecture-refresher)
3. [Pre-flight checks](#pre-flight-checks)
4. [The standard 3-step update cycle](#the-standard-3-step-update-cycle)
   - [Step 1 — Commit and push from your Mac](#step-1--commit-and-push-from-your-mac)
   - [Step 2 — Pull and restart on the VPS](#step-2--pull-and-restart-on-the-vps)
   - [Step 3 — Verify in the browser](#step-3--verify-in-the-browser)
5. [Conditional Step 4 — Edits to main 5s-tracker server.js](#conditional-step-4--edits-to-main-5s-tracker-serverjs)
6. [Rollback procedures](#rollback-procedures)
7. [Common gotchas](#common-gotchas)
8. [Quick-reference cheat sheet](#quick-reference-cheat-sheet)
9. [Convenience: per-app shell aliases](#convenience-per-app-shell-aliases)
10. [Document maintenance](#document-maintenance)

---

## When to use this guide

Use this for any change to an already-deployed sub-app on `operation.yotser.in`:

- Bug fix, copy change, layout tweak in `public/index.html`
- New or changed API route or backend logic in `server.js`
- New npm package added to `package.json`
- Schema change (new column, new table, new index)
- Seed-data adjustment in `scripts/init-db.js`

Do **not** use this guide if you are:

- Deploying a brand-new app for the first time → use `OPERATIONS_PORTAL_NEW_APP_GUIDE.md`
- Editing `/var/www/5s-tracker/server.js` to mount a new sub-app → covered in Phase 4 of the new-app guide
- Touching the main portal landing page (`/var/www/5s-tracker/portal/index.html`) → see [Conditional Step 4](#conditional-step-4--edits-to-main-5s-tracker-serverjs) below for the safety pattern, but the bulk of the procedure is in the new-app guide

**Time required:** 2–5 minutes for a routine code change. Schema changes or new dependencies add a minute or two for the extra command.

---

## Architecture refresher

Each sub-app is an Express **Router** that lives in its own folder under `/var/www/<app-folder>` on the VPS, with its own GitHub repo and its own Postgres database. The main `5s-tracker` PM2 process (port 3010) `require()`s every sub-app's `server.js` and mounts it at a sub-path (e.g. `/quotation/`, `/installation/`).

**A consequence worth knowing:** static files in each sub-app's `public/` folder are served directly by Express on every request — meaning a static-only change goes live the moment `git pull` lands on the VPS, even before the PM2 restart. The PM2 restart is still done as a habit so the same procedure works for both static and code changes, and so any cached JS modules in Node's require-cache are flushed for backend changes.

---

## Pre-flight checks

Before starting, confirm:

- [ ] You can identify the app's folder name (e.g. `quotation-tracker`) and its mount path (e.g. `/quotation/`). The [Currently deployed apps registry](#) in the new-app guide is the source of truth.
- [ ] Your local clone is on `main` and clean — only the files you intended to change are modified. `git status` should agree.
- [ ] You can SSH into the VPS via the Hostinger web terminal at hpanel.hostinger.com → VPS `srv1479112` → Browser SSH.

If `git pull` on the VPS still prompts for a GitHub PAT every time (Pitfall 6 in the new-app guide), fix it once and never see it again:

```bash
git config --global credential.helper store
# the next git pull prompts once and caches the PAT in ~/.git-credentials
```

---

## The standard 3-step update cycle

### Step 1 — Commit and push from your Mac

**Option A — GitHub Desktop:**

1. Open GitHub Desktop and select the repo for the app.
2. The **Changes** tab on the left should show only the file(s) you intended to change. Review the diff in the centre pane to be sure.
3. In the bottom-left commit box, put a one-line summary in the **Summary** field and (optionally) a longer explanation in the **Description** field. Conventional shape: imperative mood, present tense — "Highlight active leads in red after 72h" rather than "Highlighted…".
4. Click **Commit N file(s) to main**.
5. Click the **Push origin** button that appears in the top bar (it has a small "1" badge for one unpushed commit).
6. The top bar should return to **Fetch origin** with no badge — push complete.

**Option B — Command line (Terminal):**

```bash
cd "/path/to/your-app-folder"
git status                                  # confirm only intended files
git diff                                    # eyeball the actual change
git add .
git commit -m "Short description of what changed"
git push
```

Either way, you are done with the Mac. Everything else happens on the VPS and in the browser.

### Step 2 — Pull and restart on the VPS

Open the Hostinger web terminal (hpanel.hostinger.com → VPS `srv1479112` → Browser SSH).

For a **code-only change** (no new dependencies, no schema change):

```bash
cd /var/www/<app-folder> && git pull && pm2 restart 5s-tracker
```

Replace `<app-folder>` with the actual folder name (e.g. `quotation-tracker`).

**Variants for non-trivial changes:**

If you added new npm packages to `package.json`:

```bash
cd /var/www/<app-folder> && git pull && npm install --omit=dev && pm2 restart 5s-tracker
```

If you changed the database schema (new table, new column, new index — anything in `schema.sql` or `scripts/init-db.js`):

```bash
cd /var/www/<app-folder> && git pull && npm run init-db && pm2 restart 5s-tracker
```

If you did both:

```bash
cd /var/www/<app-folder> && git pull && npm install --omit=dev && npm run init-db && pm2 restart 5s-tracker
```

**What success looks like.** For `git pull`:

- `From https://github.com/<owner>/<app-folder>`
- `Updating <oldsha>..<newsha>`
- `Fast-forward`
- A files-changed line, e.g. `public/index.html | 15 ++++++++++++---`
- `1 file changed, X insertions(+), Y deletions(-)`

If you see **"Already up to date."**, your push from Step 1 didn't reach GitHub. Go back to Step 1, confirm the push completed, and re-run.

For `pm2 restart 5s-tracker`:

- `[PM2] Applying action restartProcessId on app [5s-tracker](ids: [ N ])`
- `[PM2] [5s-tracker](N) ✓`
- A PM2 process table where the `5s-tracker` row shows status `online` and uptime in **seconds** (proving the process actually restarted, not days/hours). The PID will also be different from before.
- All other apps (`drive-schedule`, `ehs-display`, `installation-scheduler`, etc.) still `online`, untouched.

What you do **NOT** want to see:

- `5s-tracker` showing `errored`, `stopped`, or any restart count climbing.
- A stack trace in the output — particularly `Cannot find module`, `SyntaxError`, or `relation "X" does not exist`.

If anything looks wrong, **do not browse to the app** — go straight to [Rollback](#rollback-procedures) below.

### Step 3 — Verify in the browser

1. Hard-refresh the app page to bust the local browser cache:
   - **Mac:** `Cmd + Shift + R`
   - or DevTools (`Cmd + Option + I`) → right-click the refresh button → **"Empty Cache and Hard Reload"**
2. Confirm the change is visible.
3. Run the smoke checks for the surfaces your change touched — at minimum:
   - `https://operation.yotser.in/<mount>/api/health` returns `{"ok":true}`
   - One CRUD flow (create → reload → confirm persists)
   - Any new feature you just added

#### Verifying when you don't have test data on hand

Sometimes the change only matters under conditions you can't easily reproduce — for example, a row only turning red after 72 hours of inactivity. Two tricks:

**Trick 1 — Inspect the served HTML/JS directly.**
Open DevTools → **Sources** tab → expand `operation.yotser.in` → `<mount>` → open `index.html` (or whichever file you changed). Press `Cmd + F` and search for a unique string from your diff (e.g. `3 * 86400`, a new function name, a new comment). If the new string is there, the file was deployed. If you still see only the old version, either the browser is caching aggressively (hard-refresh again with DevTools open) or the deploy did not land (re-check Step 2).

**Trick 2 — Force the rendered state via DevTools Elements.**
For visual changes that depend on a CSS class, right-click the relevant DOM element → **Inspect** → in the Elements panel, double-click on the element's `class="…"` attribute and add the class your change targets. The CSS should apply immediately, proving the new style shipped — no need to wait for real data to trigger the class. Refresh the page when you're done to undo the edit.

These two tricks together let you confirm both halves of a change (the JS condition and the CSS rule) without any test data.

---

## Conditional Step 4 — Edits to main 5s-tracker server.js

Most updates touch only the sub-app's own files and never need this step. **Only** follow it if your update modified `/var/www/5s-tracker/server.js` itself — for example, when adding or removing a sub-app mount (which is normally a new-app or app-removal task, not a routine update).

A syntax error in the main `server.js` will crash the **entire** portal — every sub-app, not just the one you were trying to update. The procedure below catches that before PM2 ever sees it.

```bash
# 1. Backup with a timestamp
cp /var/www/5s-tracker/server.js \
   /var/www/5s-tracker/server.js.bak.$(date +%Y%m%d-%H%M%S)

# 2. Make the edit
#    (use the Python scripts from new-app-guide Phase 4 for mount add/remove,
#     or hand-edit if you know exactly what you're doing)

# 3. Syntax-check BEFORE restart. Do not restart if this fails.
node --check /var/www/5s-tracker/server.js && echo "OK"

# 4. Restart only after the OK
pm2 restart 5s-tracker
```

If `node --check` prints a `SyntaxError`, restore from the backup with the timestamp you just created and investigate the diff:

```bash
ls /var/www/5s-tracker/server.js.bak.*
cp /var/www/5s-tracker/server.js.bak.YYYYMMDD-HHMMSS /var/www/5s-tracker/server.js
```

The same backup-and-syntax-check rhythm applies to any edit of the portal landing page (`/var/www/5s-tracker/portal/index.html`) — though there `node --check` doesn't apply; eyeball the diff carefully and reload the portal in a browser as soon as you're done.

---

## Rollback procedures

### Roll back the sub-app to the previous commit

On the VPS:

```bash
cd /var/www/<app-folder>
git log --oneline -5                        # find the last good SHA
git reset --hard <good-sha>
pm2 restart 5s-tracker
```

`git reset --hard` only rewrites the VPS's local checkout — your bad commit stays on GitHub for analysis. Once the production VPS is stable, fix the bug locally on your Mac and re-push a corrected commit.

### Roll back to "the version before this push"

If you pushed bad code less than a few minutes ago and just want to undo the most recent pull on the VPS, the reflog has you covered:

```bash
cd /var/www/<app-folder>
git reflog -5                               # shows recent HEAD positions
git reset --hard HEAD@{1}                   # the position before the last update
pm2 restart 5s-tracker
```

### Roll back changes to main 5s-tracker server.js

```bash
ls /var/www/5s-tracker/server.js.bak.*      # find the most recent backup
cp /var/www/5s-tracker/server.js.bak.YYYYMMDD-HHMMSS \
   /var/www/5s-tracker/server.js
pm2 restart 5s-tracker
```

This is exactly why every edit to that file should start with the backup step in [Conditional Step 4](#conditional-step-4--edits-to-main-5s-tracker-serverjs).

---

## Common gotchas

### "Already up to date" on the VPS pull

You forgot to push from your Mac. After a successful push, GitHub Desktop's top bar reads **"Fetch origin"** (no badge). From the CLI, `git push` prints `Writing objects: 100% ... main -> main`, not `Everything up-to-date`.

### Browser still shows the old version after a successful deploy

The browser cached the HTML/JS. `Cmd + Shift + R` to force-refresh. If that doesn't help, open DevTools → Network tab → tick **"Disable cache"** → refresh once with DevTools still open.

### `relation "X" does not exist` after a schema change

You ran `git pull` but skipped `npm run init-db`. Re-run with the schema-change variant from Step 2.

### `Cannot find module 'X'` after a code change

You added a new dependency to `package.json` but skipped `npm install --omit=dev` on the VPS. Re-run with the npm-install variant from Step 2.

### `relation "X" does not exist` for tables you definitely created

Different bug — your sub-app's `db.js` is reading from the parent (`5s-tracker`) database instead of its own. This is Pitfall 1 in the new-app guide: the sub-app's `db.js` must use the `dotenv.parse(fs.readFileSync(...))` isolation pattern, not `require('dotenv').config()`. Check that the deployed `db.js` matches the template in the new-app guide Section 1.2.

### PM2 shows `errored` after restart

The new code crashed at startup. View the error:

```bash
pm2 logs 5s-tracker --lines 50 --nostream
```

Read the stack trace, then roll back via the procedure above. Fix locally, push again, re-deploy.

### Other apps went down after my deploy

Should never happen for a sub-app code change — but it can if you accidentally edited `/var/www/5s-tracker/server.js` on the VPS. Roll back the main server.js using the timestamped backup, then `pm2 restart 5s-tracker`. The sub-apps come back automatically because they're `require()`d from the main server.

### My change is in production but my Mac shows the old code

You edited the file directly on the VPS. The VPS is now ahead of GitHub and your Mac. Three options:

1. **Preferred:** discard the VPS edit, reproduce it locally, and push through the standard cycle. On the VPS: `cd /var/www/<app-folder> && git checkout -- <file>`. Then re-do the change locally.
2. **Acceptable for emergencies:** copy the changed file from VPS to Mac via SCP or by pasting the contents, commit on the Mac, push, then `git pull` on the VPS to align history.
3. **Avoid:** committing on the VPS. The VPS is a deployment target, not a development environment — keeping it pristine means rollbacks always work.

---

## Quick-reference cheat sheet

```bash
# === MAC ===
# Make changes, then:
cd "/path/to/<app-folder>"
git add . && git commit -m "<what changed>" && git push

# === VPS (Hostinger web terminal) ===
# Code-only:
cd /var/www/<app-folder> && git pull && pm2 restart 5s-tracker

# New npm packages:
cd /var/www/<app-folder> && git pull && npm install --omit=dev && pm2 restart 5s-tracker

# Schema change:
cd /var/www/<app-folder> && git pull && npm run init-db && pm2 restart 5s-tracker

# Both:
cd /var/www/<app-folder> && git pull && npm install --omit=dev && npm run init-db && pm2 restart 5s-tracker

# === BROWSER ===
# Hard-refresh: Cmd+Shift+R
# Verify served code: DevTools → Sources → Cmd+F for a unique string from your diff
# Force-test a CSS class: DevTools → Elements → edit class attribute on a row

# === ROLLBACK (VPS) ===
cd /var/www/<app-folder> && git reflog -5             # find previous HEAD
cd /var/www/<app-folder> && git reset --hard HEAD@{1} # undo last pull
pm2 restart 5s-tracker
```

---

## Convenience: per-app shell aliases

To avoid retyping the deploy line, add aliases to `~/.bashrc` on the VPS — one per deployed app:

```bash
alias deploy-quotation='cd /var/www/quotation-tracker && git pull && pm2 restart 5s-tracker'
alias deploy-installation='cd /var/www/simple-installation-scheduler && git pull && pm2 restart 5s-tracker'
alias deploy-production='cd /var/www/production-tracker && git pull && pm2 restart 5s-tracker'
# add one for every app as you deploy it
```

Reload the shell after editing:

```bash
source ~/.bashrc
```

Then any future deploy is just one word: `deploy-quotation`. Variants for npm-install or init-db deploys are easy to add as separate aliases (`deploy-quotation-deps`, `deploy-quotation-schema`) if a particular app's update pattern warrants it.

---

## Document maintenance

When something here turns out to be wrong, outdated, or incomplete, fix this document **before** the next deploy. The whole point of writing it down is that lessons from one deploy carry over to the next; if it stops being accurate it stops being useful.

Common reasons to update:

- A new gotcha is discovered → add a section to [Common gotchas](#common-gotchas)
- A new app is deployed → make sure the [Currently deployed apps registry](#) in the **new-app** guide is updated; this guide stays generic
- The PM2 process name changes (e.g. multi-process split) → update every command that says `pm2 restart 5s-tracker`
- The Hostinger VPS hostname or access flow changes → update the [Pre-flight checks](#pre-flight-checks) section

End of guide.
