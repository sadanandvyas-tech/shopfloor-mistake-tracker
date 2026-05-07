# Shopfloor Mistake Tracker

An Operations Portal sub-app for printing-shop operators to log mistakes
found on printed products. Operators upload (or capture) a photo of the
defective print, the app runs OCR on the image and flags possible spelling
errors with suggested corrections, and operators can also draw circles or
arrows on the image to mark non-spelling defects. Each submission is saved to
Postgres with the image stored in `uploads/` on the VPS.

This app conforms to the architecture defined in
`OPERATIONS_PORTAL_NEW_APP_GUIDE.md`: it is an Express **Router** mounted as a
sub-path of the main 5s-tracker process at `operation.yotser.in/shopfloor-mistakes/`.
It does NOT call `app.listen()` and does NOT bind to a port in production —
its requests come in via the parent process's listener on port 3010.

## Architecture in one paragraph

The frontend is a single-file HTML/CSS/JS app served from `public/`. OCR runs
in the browser via Tesseract.js; spell-check uses a built-in English +
print-shop dictionary in `public/js/dictionary.js`. On submit, the annotated
image is POSTed as multipart/form-data to `/shopfloor-mistakes/api/mistakes`;
the Express handler in `server.js` writes the bytes to `uploads/` (multer)
and inserts metadata into the `mistakes` table. The Project Number field is
the typeahead pattern from `OPERATIONS_PORTAL_PROJECT_LOOKUP_GUIDE.md`
(Pattern A): the frontend calls `${API}/api/projects/search`, which is a thin
in-process proxy to `/projects/api/work-orders` on the same Node process. If
the upstream is unavailable the typeahead degrades to a free-text input.

## Project layout

```
shopfloor-mistake-tracker/
├── server.js              Express Router — exports module.exports = router
├── db.js                  Postgres pool with the dotenv-isolated pattern
├── schema.sql             mistakes table + indexes + updated_at trigger
├── scripts/
│   └── init-db.js         Idempotent schema initializer
├── public/
│   ├── index.html         Submit form + image capture + OCR + annotate
│   ├── logs.html          Searchable history of submissions
│   ├── css/styles.css     Per STYLE_GUIDE.md (brand-navy header, etc.)
│   └── js/
│       ├── api.js         FormData POST + GET wrappers; ${API} prefix helper
│       ├── app.js         Submit-flow wiring
│       ├── projects.js    Project Number typeahead (PROJECT_LOOKUP_GUIDE A)
│       ├── annotate.js    Canvas circle / arrow / freehand
│       ├── camera.js      getUserMedia capture
│       ├── ocr.js         Tesseract.js wrapper
│       ├── dictionary.js  Word list + Levenshtein suggestions
│       └── logs.js        Logs page wiring
├── uploads/               Image bytes (gitignored except .gitkeep)
├── package.json           dotenv, express, multer, pg
├── .env.example           Documents PORT (local only) + DATABASE_URL + PROJECTS_API_URL
├── .gitignore             node_modules, .env, uploads/*, !uploads/.gitkeep
└── local.js               Local-dev wrapper (mounts router on /shopfloor-mistakes)
```

## Sub-app contract (production)

When mounted at `/shopfloor-mistakes` inside the 5s-tracker process:

| Endpoint                                 | Description                                      |
|------------------------------------------|--------------------------------------------------|
| `GET  /shopfloor-mistakes/`              | Submit form (public/index.html)                  |
| `GET  /shopfloor-mistakes/logs.html`     | Submission history page                          |
| `GET  /shopfloor-mistakes/uploads/...`   | Static image bytes                               |
| `GET  /shopfloor-mistakes/api/health`    | `{ ok: true, app, time }`                        |
| `POST /shopfloor-mistakes/api/mistakes`  | multipart/form-data upload + insert              |
| `GET  /shopfloor-mistakes/api/mistakes`  | Filtered list (q, uploadedBy, projectNumber, …)  |
| `GET  /shopfloor-mistakes/api/mistakes/:id` | Single record                                  |
| `GET  /shopfloor-mistakes/api/projects/search` | Loopback proxy to /projects (PROJECT_LOOKUP A) |

## Running locally

Per Phase 1 of `OPERATIONS_PORTAL_NEW_APP_GUIDE.md`:

```bash
# 1. Create local Postgres database
createdb shopfloor_mistake_tracker

# 2. Set up environment
cp .env.example .env
# Edit .env with your local Postgres credentials

# 3. Install + init
npm install
npm run init-db

# 4. Start
npm start
# Visit http://localhost:3001/shopfloor-mistakes/
```

The Project Number typeahead will gracefully say "Projects app unavailable"
in local dev (because the projects-table sub-app isn't running on
`localhost:3010`). The form still submits — Project Number becomes a plain
text input.

## Deploying to operation.yotser.in

Follow `OPERATIONS_PORTAL_NEW_APP_GUIDE.md` Phases 2–6. In short:

```bash
#### LOCAL — push the repo ####
git push -u origin main

#### VPS — Hostinger browser terminal as root ####
sudo -u postgres psql -c "CREATE DATABASE shopfloor_mistake_tracker OWNER fivesuser;"
cd /var/www && git clone https://github.com/<owner>/shopfloor-mistake-tracker.git
cd /var/www/shopfloor-mistake-tracker
cat > .env << 'EOF'
DATABASE_URL=postgres://fivesuser:<password>@localhost:5432/shopfloor_mistake_tracker
EOF
npm install --omit=dev && npm run init-db

#### VPS — mount in main server.js (Phase 4 Python script) ####
cp /var/www/5s-tracker/server.js /var/www/5s-tracker/server.js.bak.$(date +%Y%m%d-%H%M%S)
# … run the Phase 4 Python helper with:
#   APP_FOLDER=shopfloor-mistake-tracker
#   MOUNT_PATH=/shopfloor-mistakes
#   ROUTER_VAR=shopfloorMistakesRouter
node --check /var/www/5s-tracker/server.js && echo OK

#### VPS — add portal card (Phase 5 Python script) ####
# … APP_NAME="Shopfloor Mistake Tracker"
#   APP_DESC="Log printing defects with photo, OCR, and annotation."
#   MOUNT_PATH=/shopfloor-mistakes/
#   EMOJI=📋
#   ICON_BG=#fef2f2

#### VPS — restart and verify ####
pm2 restart 5s-tracker && sleep 2 && pm2 logs 5s-tracker --lines 30 --nostream
```

Then in the browser, visit `https://operation.yotser.in/`, click the new
card, submit a test entry, and verify it appears in the logs page.

## Future updates

Standard cycle once deployed:

```bash
# On your Mac after code changes
git push

# On the VPS
cd /var/www/shopfloor-mistake-tracker && git pull && pm2 restart 5s-tracker
```

If you change `schema.sql`, run `npm run init-db` after the pull. If you add
npm packages, run `npm install --omit=dev` after the pull.

## Customizing the dictionary

`public/js/dictionary.js` ships with common English plus print-shop
vocabulary. To extend:

- Add words at the bottom of `COMMON_WORDS`, or
- Call `Dictionary.addWords([...])` from the browser console.

For maximum coverage, swap `COMMON_WORDS` for a SCOWL-derived word list and
`fetch()` it at startup.

## Privacy

OCR and annotation run entirely in the operator's browser. Only the final
submit (annotated image bytes + form fields) leaves the browser, going to
the same origin's `/shopfloor-mistakes/api/mistakes` endpoint.
