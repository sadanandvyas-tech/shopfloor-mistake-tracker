/**
 * server.js — shopfloor-mistake-tracker Express Router.
 *
 * Per OPERATIONS_PORTAL_NEW_APP_GUIDE.md §1.3, this file MUST export a Router
 * (not a full app) and MUST NOT call app.listen(). The main 5s-tracker process
 * mounts this router under `/shopfloor-mistakes` (see Phase 4 of the guide).
 *
 * For local development, `local.js` wraps this router in a standalone app and
 * binds it to PORT.
 */
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const multer  = require('multer');
const db      = require('./db');

const router = express.Router();

// ---------------------------------------------------------------------------
// Image uploads — files land in ./uploads/. Path stored in mistakes.file_path.
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  // Stable, collision-resistant filename: <timestamp>-<random>.<ext>
  filename: (_req, file, cb) => {
    const ext   = (path.extname(file.originalname) || '.png').toLowerCase();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rand  = crypto.randomBytes(4).toString('hex');
    cb(null, `${stamp}-${rand}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB hard cap; OCR images are small
});

// ---------------------------------------------------------------------------
// JSON body parsing. The image upload route uses multipart/form-data and
// won't go through these parsers, but the rest of the API is JSON.
// ---------------------------------------------------------------------------
router.use(express.json({ limit: '5mb' }));     // generous for embedded base64
router.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Static files. Both /uploads (raw image bytes) and the SPA frontend (public/).
// Per OPERATIONS_PORTAL_NEW_APP_GUIDE Pitfall 4, the frontend uses ${API} =
// '/shopfloor-mistakes' and prefixes every URL — so when the browser asks for
// /shopfloor-mistakes/uploads/xyz.png it lands on this static handler.
// ---------------------------------------------------------------------------
router.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  etag: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=604800'),
}));
router.use(express.static(path.join(__dirname, 'public')));

// ===========================================================================
// API routes — every public endpoint lives under /api/...
// ===========================================================================

// Health check — used by the integration-guide's /api/integrations/health
// dashboards and by browser smoke tests after deployment.
router.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'shopfloor-mistake-tracker', time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// POST /api/mistakes — submit a new entry with image upload.
//
// Multipart fields:
//   image           : the annotated PNG/JPEG (required, max 25 MB)
//   uploadedBy      : operator name (required)
//   projectNumber   : work-order # (required)
//   projectName     : free-text job name (optional)
//   date            : entry date in YYYY-MM-DD (required)
//   notes           : free-text notes (optional)
//   misspellings    : JSON-stringified array of { word, chosen } (optional)
//   idempotencyKey  : optional string to dedupe accidental double-submits
// ---------------------------------------------------------------------------
router.post('/api/mistakes', upload.single('image'), async (req, res, next) => {
  try {
    const {
      uploadedBy,
      projectNumber,
      projectName,
      date,
      notes,
      idempotencyKey,
    } = req.body || {};

    // Validate required fields. Mirror the field names the original Apps
    // Script expected, so any other client of this endpoint stays happy.
    const missing = [];
    if (!uploadedBy)    missing.push('uploadedBy');
    if (!projectNumber) missing.push('projectNumber');
    if (!date)          missing.push('date');
    if (!req.file)      missing.push('image');
    if (missing.length) {
      // If multer wrote a file but other fields are missing, clean it up so we
      // don't leak orphaned bytes on disk.
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ ok: false, error: 'Missing field: ' + missing.join(', ') });
    }

    // Idempotency check (per INTEGRATION_GUIDE Pattern B / Pitfall 3).
    if (idempotencyKey) {
      const { rows } = await db.query(
        `SELECT * FROM mistakes WHERE idempotency_key = $1 LIMIT 1`,
        [idempotencyKey]
      );
      if (rows[0]) {
        // Discard the duplicate upload, return the existing record.
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.json({ ok: true, mistake: rowToApi(rows[0]), duplicate: true });
      }
    }

    // Parse misspellings — frontend sends a JSON-stringified array.
    let misspellings = [];
    if (req.body.misspellings) {
      try { misspellings = JSON.parse(req.body.misspellings); }
      catch { misspellings = []; }
    }
    if (!Array.isArray(misspellings)) misspellings = [];

    const issuesText = misspellings.map((m) => {
      const correction = m && (m.chosen || (Array.isArray(m.suggestions) && m.suggestions[0]));
      return correction ? `${m.word} -> ${correction}` : (m && m.word) || '';
    }).filter(Boolean).join(' | ');

    // Path stored RELATIVE to the app root so the same DB row works whether
    // we move /var/www/<app> or rename uploads/. The frontend builds the URL
    // by prefixing ${API} (e.g. '/shopfloor-mistakes/').
    const relPath = path.posix.join('uploads', path.basename(req.file.path));

    const { rows } = await db.query(
      `INSERT INTO mistakes
         (project_number, project_name, uploaded_by, entry_date, notes,
          spelling_issues_text, spelling_issues_json,
          file_name, mime_type, file_size, file_path,
          idempotency_key, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        projectNumber,
        projectName || null,
        uploadedBy,
        date,
        notes || null,
        issuesText || null,
        JSON.stringify(misspellings),
        req.file.originalname,
        req.file.mimetype,
        req.file.size,
        relPath,
        idempotencyKey || null,
        'shopfloor-mistake-tracker',
      ]
    );

    res.status(201).json({ ok: true, mistake: rowToApi(rows[0]) });
  } catch (err) {
    // Clean up the orphan upload on insert failure.
    if (req.file) fs.unlink(req.file.path, () => {});
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/mistakes — list with optional filters.
// Query params: q (free-text), uploadedBy, projectNumber, from, to, limit.
// ---------------------------------------------------------------------------
router.get('/api/mistakes', async (req, res, next) => {
  try {
    const { q, uploadedBy, projectNumber, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

    const params = [];
    const where = [];
    if (q) {
      params.push(`%${String(q).toLowerCase()}%`);
      const i = params.length;
      where.push(`(
        LOWER(project_number) LIKE $${i} OR
        LOWER(COALESCE(project_name,'')) LIKE $${i} OR
        LOWER(uploaded_by) LIKE $${i} OR
        LOWER(COALESCE(notes,'')) LIKE $${i} OR
        LOWER(COALESCE(spelling_issues_text,'')) LIKE $${i} OR
        LOWER(COALESCE(file_name,'')) LIKE $${i}
      )`);
    }
    if (uploadedBy) {
      params.push(uploadedBy);
      where.push(`uploaded_by = $${params.length}`);
    }
    if (projectNumber) {
      params.push(projectNumber);
      where.push(`project_number = $${params.length}`);
    }
    if (from) {
      params.push(from);
      where.push(`entry_date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      where.push(`entry_date <= $${params.length}`);
    }

    const sql = `SELECT * FROM mistakes
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC
                 LIMIT ${limit}`;
    const { rows } = await db.query(sql, params);
    res.json({ ok: true, entries: rows.map(rowToApi), total: rows.length });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/mistakes/:id — single record.
// ---------------------------------------------------------------------------
router.get('/api/mistakes/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT * FROM mistakes WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, mistake: rowToApi(rows[0]) });
  } catch (err) { next(err); }
});

// ===========================================================================
// PROJECTS — live search proxy to the Projects Table sub-app.
//
// Per OPERATIONS_PORTAL_PROJECT_LOOKUP_GUIDE.md §A.1. Loopback to the same
// Node process so we get sub-100 ms response and zero networking. Normalises
// the upstream's row shape to {id, name, customer, sales_rep, status, ...}
// so frontend code never has to know about projects-table column names.
// ===========================================================================
const PROJECTS_API_CANDIDATES = ['http://localhost:3010/projects/api/work-orders'];

async function fetchProjectsUpstream(q, limit) {
  const explicit = db.get('PROJECTS_API_URL');
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
      const list = Array.isArray(json.data)        ? json.data
                 : Array.isArray(json)             ? json
                 : Array.isArray(json.work_orders) ? json.work_orders
                 : [];
      const total = (json.pagination && Number(json.pagination.total)) || list.length;

      const normalised = list.map((r) => ({
        id:        r.work_order_no != null ? String(r.work_order_no) : '',
        name:      r.wo_name        || '',
        customer:  r.company_name   || '',
        sales_rep: r.project_owner  || '',
        status:    r.wo_status      || '',
        description: [r.work_category, r.wo_status, r.work_priority]
          .filter(Boolean).join(' · ') || null,
        due_date:  r.completion_date || null,
      })).filter((r) => r.id && r.id.trim());

      return { ok: true, projects: normalised, total };
    } catch {
      // try next candidate
    }
  }
  return null;
}

router.get('/api/projects/search', async (req, res) => {
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
    console.error('[shopfloor-mistake-tracker] projects search error', e);
    res.json({ ok: false, projects: [], total: 0, message: e.message });
  }
});

router.get('/api/projects/:id', async (req, res) => {
  try {
    const data = await fetchProjectsUpstream(req.params.id, 50);
    if (!data || !data.projects.length) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const exact = data.projects.find((p) => p.id === req.params.id);
    if (!exact) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: exact });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===========================================================================
// SPA fallback — any unmatched GET serves index.html so deep links work.
// MUST come AFTER all /api/* routes.
// ===========================================================================
router.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler — last middleware. Logs with the app prefix so cross-app
// log filtering works (see INTEGRATION_GUIDE Quick-reference snippets).
router.use((err, _req, res, _next) => {
  console.error('[shopfloor-mistake-tracker]', err);
  res.status(500).json({ ok: false, error: err.message || 'internal error' });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Convert a DB row to the API shape the frontend already understands.
// Keeps backward-compat with the original Apps Script payload (timestamp,
// fileUrl, spellingIssues, etc.) so the existing logs.html UI works as-is.
function rowToApi(r) {
  return {
    id:             r.id,
    timestamp:      r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    date:           r.entry_date instanceof Date
                      ? r.entry_date.toISOString().slice(0, 10)
                      : (r.entry_date || ''),
    uploadedBy:     r.uploaded_by,
    projectNumber:  r.project_number,
    projectName:    r.project_name || '',
    notes:          r.notes || '',
    spellingIssues: r.spelling_issues_text || '',
    misspellings:   safeJson(r.spelling_issues_json) || [],
    fileName:       r.file_name || '',
    fileSize:       r.file_size || null,
    mimeType:       r.mime_type || '',
    // file_path is relative (e.g. "uploads/xyz.png"). The frontend prefixes
    // it with ${API} so the full URL becomes /shopfloor-mistakes/uploads/xyz.png.
    filePath:       r.file_path ? '/' + r.file_path.replace(/^\/+/, '') : '',
    fileUrl:        r.file_path ? '/' + r.file_path.replace(/^\/+/, '') : '',
    customerId:     r.customer_id || null,
  };
}

function safeJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

module.exports = router;
