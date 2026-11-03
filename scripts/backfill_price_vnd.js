// Backfill menu_items.price_vnd (dong, integer) from price (thousands, float).
//
//   DB_PATH=/abs/path/app.db node scripts/backfill_price_vnd.js
//   BATCH=500       rows per transaction
//   PAUSE_MS=50     sleep between batches, so request traffic is never starved
//
// Rules this script follows (see MIGRATION.md §7):
//  * Start it only when no running instance writes `price` alone: every instance
//    must already run v2 or later. A v1 write after the backfill would again
//    leave a NULL or stale price_vnd (re-running this script would repair it).
//  * Small batches: each is its own short transaction, so one write lock is held
//    for a few milliseconds, never for the whole table.
//  * It fixes two kinds of row, both computed from `price`, which is the truth
//    until the read switch: rows with price_vnd NULL (never converted), and rows
//    whose price_vnd DISAGREES with price. The second kind is real, not
//    theoretical: during the rolling restart onto v2 one instance still runs v1,
//    and a v1 PATCH changes `price` only, leaving the price_vnd that v2 wrote
//    earlier stale. Found in the rehearsal (traffic reported `stale` once v3 read
//    price_vnd). That is safe to repair here because every instance now writes
//    both columns, so `price` is always the newer value.
//  * Re-runnable: it walks the table by id and only touches rows that are NULL or
//    disagree, so stopping it (Ctrl+C) and starting it again gives the same end
//    result. A second run on a finished table changes nothing.
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

// Same formula as scripts/check.js.
const WANT = 'CAST(round(price * 1000) AS INTEGER)';
const TODO = `price IS NOT NULL AND (price_vnd IS NULL OR price_vnd <> ${WANT})`;
// The next batch: ids that still need work, after the last id we handled.
const nextIds = db.prepare(`SELECT id FROM menu_items WHERE id > ? AND ${TODO} ORDER BY id LIMIT ?`);
// The value is computed inside the UPDATE from the row's current price, so a
// dual-writing instance that changes the row between our SELECT and this UPDATE
// cannot leave it wrong: the guard is re-evaluated on the current row.
const fill = db.prepare(`UPDATE menu_items SET price_vnd = ${WANT} WHERE id BETWEEN ? AND ? AND ${TODO}`);
const count = (where) => db.prepare(`SELECT count(*) n FROM menu_items WHERE ${where}`).get().n;
console.log(`before: ${count('price IS NOT NULL AND price_vnd IS NULL')} rows with price_vnd NULL, ` +
  `${count(`price IS NOT NULL AND price_vnd <> ${WANT}`)} rows where it disagrees with price`);

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

const left = count(TODO);
const noPrice = count('price IS NULL');
console.log(`${stop ? 'stopped' : 'done'}: ${batches} batches, ${filled} rows filled in ${Date.now() - t0} ms; ` +
  `${left} still to do, ${noPrice} rows have no price at all (skipped)`);
process.exit(0);
