/**
 * scripts/init-db.js
 *
 * Idempotent schema initializer. Re-run on every deploy; safe to run on a
 * fresh database or one that already has the schema applied.
 *
 * Per OPERATIONS_PORTAL_INTEGRATION_GUIDE Pitfall 10, this script must NEVER
 * make cross-app calls. It only creates schema and (optionally) seeds local
 * lookup data. Cross-app data hydration belongs in a separate one-off script.
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');

async function main() {
  const sqlPath = path.join(__dirname, '..', 'schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Applying schema from', sqlPath);
  await db.query(sql);
  console.log('Schema applied.');

  // No seed data needed for the mistakes table — the operator creates rows.
  // (If we ever add a `users` or `defect_categories` table, seed it here.)

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('init-db failed:', err);
  process.exit(1);
});
