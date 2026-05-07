-- shopfloor-mistake-tracker schema.
-- Use IF NOT EXISTS so init-db.js stays idempotent and can be re-run safely
-- on every deploy. See OPERATIONS_PORTAL_NEW_APP_GUIDE.md §"Future updates".

-- ---------------------------------------------------------------------------
-- mistakes: one row per submitted defect entry.
-- ---------------------------------------------------------------------------
-- Identifying / pipeline fields
--   project_number / project_name come from the Projects Table typeahead
--   (PROJECT_LOOKUP_GUIDE Pattern A). project_number is what we display and
--   filter on; project_name is the wo_name snapshot from the lookup.
-- Capture fields
--   uploaded_by          : free-text operator name
--   entry_date           : the date the operator selected (vs. created_at server time)
--   notes                : free-text observations
-- OCR results
--   spelling_issues_text : human-readable summary (e.g. "wrng -> wrong | mispel -> misspell")
--                          kept for compatibility with the original Sheet schema; the
--                          structured form lives in spelling_issues_json.
--   spelling_issues_json : JSONB array of { word, chosen } objects.
-- Image storage
--   file_name, mime_type, file_size : metadata as captured at upload time
--   file_path                       : path RELATIVE to the app root (e.g. uploads/abc.png)
--                                      The Express router serves this under
--                                      `${MOUNT}/uploads/...` (see server.js).
-- Cross-app reference (per OPERATIONS_PORTAL_INTEGRATION_GUIDE.md)
--   customer_id              : foreign key to customer-list (TEXT — not enforced as FK)
--   customer_name_snapshot   : denormalised display field, refreshed from customer.updated event
--   idempotency_key, source, source_ref : Pattern B groundwork

CREATE TABLE IF NOT EXISTS mistakes (
  id                      SERIAL PRIMARY KEY,
  project_number          TEXT NOT NULL,
  project_name            TEXT,
  uploaded_by             TEXT NOT NULL,
  entry_date              DATE NOT NULL,
  notes                   TEXT,
  spelling_issues_text    TEXT,
  spelling_issues_json    JSONB,
  file_name               TEXT,
  mime_type               TEXT,
  file_size               INTEGER,
  file_path               TEXT,
  customer_id             TEXT,
  customer_name_snapshot  TEXT,
  idempotency_key         TEXT,
  source                  TEXT,
  source_ref              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mistakes_created_at      ON mistakes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mistakes_entry_date      ON mistakes (entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_mistakes_project_number  ON mistakes (project_number);
CREATE INDEX IF NOT EXISTS idx_mistakes_uploaded_by     ON mistakes (uploaded_by);
CREATE INDEX IF NOT EXISTS idx_mistakes_customer_id     ON mistakes (customer_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_mistakes_idempotency_key
  ON mistakes (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Auto-update updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION mistakes_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mistakes_updated_at ON mistakes;
CREATE TRIGGER trg_mistakes_updated_at
  BEFORE UPDATE ON mistakes
  FOR EACH ROW EXECUTE FUNCTION mistakes_set_updated_at();
