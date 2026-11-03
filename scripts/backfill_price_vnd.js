// Backfill menu_items.price_vnd (dong, integer) from price (thousands, float).
//
//   DB_PATH=/abs/path/app.db node scripts/backfill_price_vnd.js
//   BATCH=500       rows per transaction
//   PAUSE_MS=50     sleep between batches, so request traffic is never starved
//
// Rules this script follows (see MIGRATION.md §7):
//  * Start it only when no running instance writes `price` alone: every instance
//    must already run v2 or later. A v1 write after the backfill would leave a
//    row with a NULL (or stale) price_vnd that nothing repairs.
//  * Small batches: each is its own short transaction, so one write lock is held
//    for a few milliseconds, never for the whole table.
//  * Re-runnable: it only touches rows where price_vnd IS NULL, and walks the
//    table by id, so stopping it (Ctrl+C) and starting it again gives the same
//    end result. A second run on a finished table changes nothing.
//  * Rows whose `price` is NULL (the 2025 half-done cleanup) cannot be converted;
//    they are skipped and counted, not retried forever.
import { open } from '../src/db.js';

const BATCH = Number(process.env.BATCH ?? 500);
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 50);

const db = open();
const cols = new Set(db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name));
if (!cols.has('price') || !cols.has('price_vnd')) {
  console.error('need both price and price_vnd: run migration 002 first, and do not run after the drop');
  process.exit(2);
}

// The next batch: ids that still need a value, after the last id we handled.
const nextIds = db.prepare(
  'SELECT id FROM menu_items WHERE id > ? AND price_vnd IS NULL AND price IS NOT NULL ORDER BY id LIMIT ?');
// Same formula as scripts/check.js. The IS NULL guard means a row written by a
// dual-writing instance between our SELECT and this UPDATE is left alone.
const fill = db.prepare(
  `UPDATE menu_items SET price_vnd = CAST(round(price * 1000) AS INTEGER)
   WHERE id BETWEEN ? AND ? AND price_vnd IS NULL AND price IS NOT NULL`);

let stop = false;
process.on('SIGINT', () => { stop = true; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let last = 0, batches = 0, filled = 0;
const t0 = Date.now();
while (!stop) {
  const ids = nextIds.all(last, BATCH);
  if (!ids.length) break;
  db.exec('BEGIN IMMEDIATE');
  try {
    const { changes } = fill.run(ids[0].id, ids.at(-1).id);
    db.exec('COMMIT');
    filled += Number(changes);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  last = ids.at(-1).id;
  batches++;
  if (batches % 10 === 0) console.log(`batch ${batches}  up to id ${last}  filled ${filled}`);
  await sleep(PAUSE_MS);
}

const left = db.prepare('SELECT count(*) n FROM menu_items WHERE price_vnd IS NULL AND price IS NOT NULL').get().n;
const noPrice = db.prepare('SELECT count(*) n FROM menu_items WHERE price IS NULL').get().n;
console.log(`${stop ? 'stopped' : 'done'}: ${batches} batches, ${filled} rows filled in ${Date.now() - t0} ms; ` +
  `${left} still to do, ${noPrice} rows have no price at all (skipped)`);
process.exit(0);
