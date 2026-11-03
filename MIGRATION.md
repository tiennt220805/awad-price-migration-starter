# MIGRATION.md — IA#2 zero-downtime migration

Course CSC13114 · 23KTPM1 · individual assignment · 23127128 — Nguyễn Thành Tiến

Goal: change `menu_items.price` (thousands of dong, REAL) into `menu_items.price_vnd` (dong, INTEGER) in the menu service, then drop `price`, while two instances keep serving traffic: no failed request at any step, and a way back at every step until the point of no return (step 6).

Conventions used below.

- Instances: `:3001` and `:3002`, one database file. Every command below is run from the repository root (`work/`) with `export DB_PATH="$PWD/data/app.db"`; `../wt/<tag>` are `git worktree` checkouts of the tags.
- A "rolling restart onto vN" is `scripts/roll.sh vN 3001`, wait until `traffic-log.txt` shows `3001 back`, then `scripts/roll.sh vN 3002`. `roll.sh` stops the old process (SIGTERM, in-flight requests finish), starts the code of the tag from its worktree, and returns once `/health` answers. It does nothing to the running instance if the new one cannot be prepared.
- `migrate` always applies every pending migration of the tree it is run from, so each migration is applied from the worktree of the tag that holds exactly the migrations wanted: `002` from `../wt/v2` (which has 001 and 002 only), `003` from `../wt/v5`. `migrate:down` reads the `.down.sql` from the tree it is run in, so undo commands name the same worktrees.

## 0. How to replay this (for a grader)

The tags are code versions of the service; the tooling always comes from `main`. Do not run `npm run migrate` from `main` (it would apply `003` too). Tag `v2` has no backfill script and tag `v3` has an older, `IS NULL` only version of it; `traffic.js` of `v1` cannot switch `NEW_CLIENTS`. So: instances and migrations come from tag worktrees, while `traffic`, `check`, `backfill`, `roll.sh` and `backup.js` come from `main`.

```bash
export DB_PATH="$PWD/data/app.db"; mkdir -p ../wt
for v in v1 v2 v5; do git worktree add --detach ../wt/$v $v; done          # v3, v4: roll.sh adds them
(cd ../wt/v1 && npm run migrate && npm run seed)                            # 001, 20,000 rows
scripts/check-step.sh "0 start: v1 on both, before traffic"
scripts/roll.sh v1 3001; scripts/roll.sh v1 3002
npm run traffic                                                             # second terminal; leave it running
(cd ../wt/v2 && npm run migrate)                                            # step 1: 002
scripts/check-step.sh "1 expand: 002 applied, v1 still serving"
scripts/roll.sh v2 3001; scripts/roll.sh v2 3002                            # step 2
scripts/check-step.sh "2 dual write: v2 on both"
kill -USR2 $(pgrep -f '^node scripts/traffic.js')                           # NEW_CLIENTS -> 0.3
node scripts/backfill_price_vnd.js; scripts/check-step.sh "3 backfill"      # step 3
scripts/roll.sh v3 3001; scripts/roll.sh v3 3002                            # step 4
scripts/check-step.sh "4 v3 reads price_vnd"
scripts/roll.sh v2 3001; scripts/roll.sh v2 3002                            # 4a: rollback
scripts/check-step.sh "4a rollback v3 -> v2"
scripts/roll.sh v3 3001; scripts/roll.sh v3 3002                            # 4b: forward again
scripts/check-step.sh "4b forward v2 -> v3"
scripts/roll.sh v4 3001; scripts/roll.sh v4 3002                            # step 5
scripts/check-step.sh "5 v4 neither reads nor writes price"                 # INCONSISTENT is expected
node scripts/backup.js "$PWD/../backup-before-003.db"                       # before the contract step
(cd ../wt/v5 && npm run migrate)                                            # step 6: 003
scripts/check-step.sh "6 contract: 003 dropped price"
# Ctrl+C in the traffic terminal -> RESULT line
```

The `migrate:down` drill (§1, step 1 and 6 undo) was run once for every migration on a scratch `DB_PATH` before this sequence; its output is at the top of `check-log.txt` (lines 1–26). Timing between restarts was a few seconds each; the traffic log is wall-clock and not byte-identical between runs.

## 1. Plan

Undo commands are run from the repository root with `DB_PATH` exported, one instance at a time (the second only after the log shows the first `back`).

| # | Step | Schema after the step | Code every instance runs | Exact undo command | Earlier versions that still run safely on this schema |
|---|---|---|---|---|---|
| 0 | Starting point | `price REAL` | `v1` | n/a | `v1` |
| 1 | **Expand**: migration `002_add_price_vnd` | `price REAL`, `price_vnd INTEGER NULL` | `v1` (never selects the new column) | `(cd ../wt/v2 && npm run migrate:down)` (runs `002_add_price_vnd.down.sql`; only while all instances run v1) | `v1` |
| 2 | **Dual write**: rolling restart onto `v2` | unchanged | `v2`: `POST /menu` and `PATCH /menu/:id` write both columns; accepts `price` or `priceVnd`; reads `price`; responds with both | `scripts/roll.sh v1 3001` then `scripts/roll.sh v1 3002` | `v1` until the backfill (a v1 write changes `price` only; the backfill repairs that, §6.2); `v2` |
| 3 | **Backfill**: `node scripts/backfill_price_vnd.js` | every row has `price_vnd` equal to `round(price*1000)` | `v2` | Nothing to undo: the values are derived from `price` and nobody reads them yet. To discard them: `scripts/roll.sh v1 3001`, `scripts/roll.sh v1 3002`, then `(cd ../wt/v2 && npm run migrate:down)` (drops the column) | `v2` only: v1 is out from here, because its writes would leave `price_vnd` stale again |
| 4 | **Switch reads**: rolling restart onto `v3` | unchanged | `v3`: reads `price_vnd` (`price = price_vnd/1000` in responses), still writes both | `scripts/roll.sh v2 3001` then `scripts/roll.sh v2 3002` (safe: v3 kept `price` up to date) | `v2`, `v3` |
| 4a | **Rollback exercise**: `v3` → `v2` under traffic | unchanged | `v2` | `scripts/roll.sh v3 3001` then `scripts/roll.sh v3 3002` (this is step 4b) | `v2`, `v3` |
| 4b | **Forward again**: `v2` → `v3` | unchanged | `v3` | `scripts/roll.sh v2 3001` then `scripts/roll.sh v2 3002` (this is step 4a) | `v2`, `v3` |
| 5 | **Stop touching `price`**: rolling restart onto `v4` | unchanged (`price` now goes stale) | `v4`: reads and writes only `price_vnd`; responses still contain `price` | `scripts/roll.sh v3 3001` then `scripts/roll.sh v3 3002` (safe). Not v2: `price` is stale | `v3`, `v4`; **not `v2`** |
| 6 | **Contract**: migration `003_drop_price` | `price_vnd INTEGER` only | `v4` (tag `v5` = same code plus the migration) | **None that restores the data: point of no return, §3.** The nearest things: `(cd ../wt/v5 && npm run migrate:down)` only rebuilds a derived `price` from `price_vnd`; restoring `../backup-before-003.db` brings the original values back but loses every later write | `v4` only: v3 still writes `price` and would fail |

Step 4 (`v3`) is the version that **reads** `price_vnd`. The rollback exercise (§4) is done right after it and is labelled `4a` (`v3` → `v2`) and `4b` (`v2` → `v3`) in `check-log.txt`; it changes no schema. The labels in `check-log.txt` use the step numbers of this table: `0 start`, `1 expand`, `2 dual write`, `3 backfill`, `4 v3 reads price_vnd`, `4a`, `4b`, `5 v4 …`, `6 contract`.

## 2. Mapping to the repository

| Step | Tag | Migration (up / down) | Script |
|---|---|---|---|
| 0 | `v1` (the starter, untouched) | `001_init` | — |
| 1 | (commit `migration 002`, contained in `v2`) | `002_add_price_vnd.up.sql` / `.down.sql` | — |
| 2 | `v2` | — | `scripts/roll.sh` |
| 3 | — | — | `scripts/backfill_price_vnd.js` |
| 4 | `v3` | — | — |
| 4a / 4b | `v2` then `v3` again (no new tag) | — | — |
| 5 | `v4` | — | — |
| 6 | `v5` (= `v4` code + migration) | `003_drop_price.up.sql` / `.down.sql` | `scripts/backup.js` |

Evidence files at the repository root: `traffic-log.txt`, `check-log.txt`, `backfill-rerun-log.txt` (stop-and-rerun demonstration of the backfill on a scratch database, §7).

Tooling commits that are not a code version: `traffic.js` can switch `NEW_CLIENTS` at runtime (§6.1), `scripts/roll.sh`, `scripts/backup.js`, `scripts/check-step.sh`. `v1` is exactly the starter commit.

## 3. Point of no return

**Step 6, migration `003_drop_price`.**

Why it cannot be undone: the column is physically removed, together with the values that were stored in it. `003_drop_price.down.sql` adds a `price` column again and **recomputes** it as `price_vnd / 1000.0`; it does not bring back what was stored. After the drop:

- the only copy of the original `price` values is the backup `../backup-before-003.db` taken just before, and restoring it throws away every write made after that moment (the service keeps taking writes);
- `v3` and everything older can no longer run on this schema: `v3` writes `price`, and `v2`/`v1` read it, so after the drop `v3` fails on every write (missing column) and `v2`/`v1` fail on every read; after `down` has rebuilt the column, `v3` works again (it reads `price_vnd`), but `v2`/`v1` would read a `price` that `v4` no longer keeps current;
- a rollback past `v4` is therefore not offered after this step, and it was already unsafe for `v2` once `v4` had run (§4).

How the risk was reduced before the step: `v4` ran on both instances first, so no running version touches `price` (checked in `traffic-log.txt` and by the absence of `price` in any SQL of `v4`, see `src/app.js`); `check-log.txt` is `CONSISTENT` right after the backfill (label `3 backfill`); `scripts/backup.js` took a consistent copy (SQLite `VACUUM INTO`) while traffic kept running.

## 4. The way back (criterion 5)

Rollback performed under traffic: the version that reads `price_vnd` (`v3`) was rolled back to the version before it (`v2`) on both instances, one instance at a time, and rolled forward again to `v3`.

- `traffic-log.txt`: lines 127–160 (`v3 → v2`: `3001` down/back at lines 127–128, `3002` at 139–141; `v2 → v3`: `3001` at 147–148, `3002` at 159–160). No failure line anywhere in the log; the statistic lines in this stretch all read `error=0 contract=0 stale=0 unavailable=0`.
- `check-log.txt` (line numbers of the headers): `4 v3 reads price_vnd` (line 60, before), `4a rollback v3 -> v2` (line 69) and `4b forward v2 -> v3` (line 78), all three `CONSISTENT`.

**Why this rollback is safe.** `v3` reads `price_vnd` but still writes both columns, in the same statement, so `price` is always as new as `price_vnd`. `v2` reads `price`, which is therefore correct for every row, including rows written by `v3` or by new clients (`priceVnd`). Both versions answer with the same `price` and `priceVnd`, so neither a client nor `traffic.js` sees a difference. The backfill finished earlier, so no row lacks `price_vnd` that `v3` would read.

**Which later rollback would not be safe.**

- `v4 → v2` is not safe: from `v4` on, writes change only `price_vnd`, so `price` is stale, and `v2` reads `price`. This was observed: with `v4` on both instances, `npm run check` reports `INCONSISTENT` (`disagree` > 0) and a `v2` read would show the old price as a `stale` failure. This is why the check after step 5 is labelled as expected to be `INCONSISTENT`, and why the window is kept short.
- `v4 → v3` is safe: `v3` reads `price_vnd`, which `v4` keeps current, and `v3` restores dual writing.
- Any rollback after migration `003` below `v4`: not possible (§3).

## 5. Rolling restarts and traffic (criterion 4)

- One continuous `npm run traffic` run (`traffic-log.txt`, 197 lines): started at line 2 (`traffic start 2026-11-03T07:05:19Z`) with both instances on `v1` and `NEW_CLIENTS=0`; stopped only after migration `003` had been applied and checked (the single `FINAL` line is at line 196).
- Instances were restarted one at a time (`down` / `back` lines of the log), never both: ten restarts, at lines 28/30 (`3001` → v2), 75/76 (`3002` → v2), 111/113 (`3001` → v3), 120/121 (`3002` → v3), 127/128 and 139/141 (rollback to v2), 147/148 and 159/160 (forward to v3), 168/169 (`3001` → v4), 180/181 (`3002` → v4). Consecutive restarts are at least 20 s apart, so the other instance was always up. A `back` line sometimes appears twice at the same second: two workers noticed the same instance returning.
- `NEW_CLIENTS` was switched on at line 88 (`405.5s NEW_CLIENTS -> 0.3 (SIGUSR2)`), right after both instances ran `v2` (the first version whose API offers `priceVnd`), and stayed on until the end of the run.
- Final lines: `864.3s FINAL ok=3602993 error=0 contract=0 stale=0 unavailable=0 rerouted=86` (line 196) and `RESULT: zero failed requests` (line 197). `rerouted=86` counts requests that were sent to the other instance while one was restarting; they are not failures.

## 6. Problems found and how they were fixed

These were found in a full rehearsal on a scratch database (same steps, other ports) before the real run. The rehearsal logs are not part of the evidence.

### 6.1 `NEW_CLIENTS` can only be set when `traffic.js` starts

- Symptom: the rubric asks for one continuous run in which new clients are on for part of the time, after the API offers `priceVnd`. `traffic.js` reads `NEW_CLIENTS` once at start. Turned on from the start, new clients meet `v1` (no `priceVnd`) and the log fills with `contract` failures; turned on later by restarting traffic, the log is split into several runs.
- Fix: a small change in `scripts/traffic.js` (own commit, after `v1`): `kill -USR2 <pid>` switches the share between 0 and `NEW_CLIENTS_ON` (default 0.3) and logs a line `NEW_CLIENTS -> …`. The counting of failures is untouched. `v1` is still the unmodified starter; the instances run from worktrees of the tags, only the traffic script comes from the main working tree. `SIGUSR2` is used because Node reserves `SIGUSR1` for its debugger.

### 6.2 A backfill that only fills `NULL` leaves wrong rows (found in the rehearsal)

- Symptom: right after `v2` was on both instances (no `v1` left), `npm run check` said `INCONSISTENT` with `disagree 57`. After the backfill the rows stayed wrong, and as soon as `v3` read `price_vnd`, `traffic.js` reported two `stale` failures (same row, `GET /menu/90 … price 199.5, last write was 185.5`).
- Cause: during the rolling restart onto `v2` there is a few seconds in which one instance runs `v2` and the other still `v1`. `v2` writes both columns of a row; then `v1` re-prices the same row and changes `price` only. The row now has a non-NULL `price_vnd` that is wrong. A backfill with `WHERE price_vnd IS NULL` (the form on the session 4 slide) never looks at it.
- Fix: `scripts/backfill_price_vnd.js` handles two kinds of row, `price_vnd IS NULL` and `price_vnd <> CAST(round(price*1000) AS INTEGER)`, computing the value inside the `UPDATE` from the row's current `price`. This is safe because the backfill starts only when no `v1` is serving, so every writer keeps both columns together and `price` is the newer value. After the fix the rehearsal printed `before: 19206 rows with price_vnd NULL, 7 rows where it disagrees`, `CONSISTENT` right after, and `zero failed requests`.
- Consequence: the check after step 2 may print `INCONSISTENT`. It is expected and repaired by step 3.
- **What happened in the real run.** The check after step 2 did print `INCONSISTENT` with `disagree 34` (`check-log.txt` line 42). By the time the backfill started, about a minute later, `v2` had overwritten those 34 rows (both columns written together), so the backfill printed `before: 38092 rows with price_vnd NULL, 0 rows where it disagrees` and the repair branch changed nothing. The bug itself was observed only in the rehearsal (two `stale` failures), so the fix rests on that rehearsal and on the reasoning above, not on a failure in the final log.

### 6.3 `npm run migrate` applies everything pending

- Symptom: from the final working tree, `migrate` would apply `002` and `003` together and drop `price` at step 1.
- Fix: each migration is applied from the worktree of the tag with exactly the migrations wanted (`../wt/v2` for 002, `../wt/v5` for 003). `migrate:down` reads the `.down.sql` from the tree it is run in, so the undo commands in §1 name the same worktrees. The `migrate:down` drill for all three migrations is done on a separate database file.

### 6.4 `INCONSISTENT` is normal between `v4` and the drop

- `check.js` compares the two columns whenever both exist. `v4` stops writing `price`, so after step 5 (label `5 v4 …`) it prints `disagree` > 0 and exits 1 (real run: `disagree 1898`, `check-log.txt` line 87; rehearsal: 1842). It is the evidence for §4, not a bug. The label in `check-log.txt` says so, and the window before step 6 is short.

### 6.5 Rows with `price` NULL

- `001_init.up.sql` allows NULL ("half-done cleanup"). Such a row cannot be converted, so the backfill skips and counts it, and `check.js` would never print a plain `CONSISTENT`. The seeded database has none (`check` after seeding, and the backfill summary line `0 rows have no price at all`).

### 6.6 Dropping a column with a CHECK constraint

- Tested before writing `003`: SQLite 3.53.4 (the one bundled with the Node used here) executes `ALTER TABLE … DROP COLUMN price` even though `price` has `CHECK (price > 0)`. No table rebuild is needed.

## 7. Backfill (criterion 3)

- Script: `scripts/backfill_price_vnd.js`.
- Batches: 500 rows (`BATCH`), each its own `BEGIN IMMEDIATE … COMMIT`, 50 ms pause between batches (`PAUSE_MS`), walking the table by `id` (keyset), so no long lock and no repeated scan.
- Re-runnable and stoppable: it only touches rows that are NULL or disagree, and `Ctrl+C` stops it between batches. This could not be repeated on the live database after the drop, so it was demonstrated on a scratch database (schema 001+002, 20,000 rows) and kept in `backfill-rerun-log.txt`: run 1 interrupted with SIGINT after 6 batches (3,000 rows filled, 17,000 still NULL, `check` says `CONSISTENT, but 17000 rows have no price_vnd yet`), run 2 finished the remaining 17,000, run 3 on the finished table reported `0 batches, 0 rows filled`, and `check` was `CONSISTENT` at the end.
- Runs only when no version that writes `price` alone is serving: started after both instances run `v2`.
- Result: `check-log.txt`, label `3 backfill` (line 51), `CONSISTENT`.
- The summary the script printed in the real run (copied from the terminal; the script's own output is not in `traffic-log.txt` or `check-log.txt`):
  `before: 38092 rows with price_vnd NULL, 0 rows where it disagrees with price`
  `done: 77 batches, 38092 rows filled in 3992 ms; 0 still to do, 0 rows have no price at all (skipped)`

## 8. API compatibility (criterion 6)

- Every response that returned `price` (`GET /menu`, `GET /menu/:id`, `POST /menu`, `PATCH /menu/:id`) still contains `price` in thousands of dong, in every version including `v4` and after the drop (`price = price_vnd / 1000`), plus `priceVnd` in dong.
- Requests accept `price` or `priceVnd`; if both are sent and disagree the answer is 400.
- `POST /orders` has no price in its response and keeps `order_items.unit_price` in thousands (out of scope), computed from `price_vnd / 1000` in `v3` and `v4`.
- `traffic-log.txt` after migration `003`: the last check before the drop is at line 182 (`5 v4 …`), the check after it at line 191 (`6 contract`), the run ends at line 197; every statistic line in 183–196 reads `error=0 contract=0 stale=0 unavailable=0`. Two requests made by hand right after the drop (`GET /menu/1` returned `price 118, priceVnd 118000`; `PATCH /menu/60 {"price":45.5}` returned `price 45.5, priceVnd 45500`) are not part of the traffic log.

## 9. Limits of this work

- The real run was done once and is clean. Before it, four rehearsal runs on a scratch database found two problems (§6.2 and a bug in my own rehearsal script); a clean rehearsal is not a proof, the real run is the evidence.
- Rolling restarts are done by `roll.sh` on a single machine; there is no real load balancer, `traffic.js` plays its part.
- No lock tuning was needed on SQLite; on PostgreSQL the same plan would need `lock_timeout`, `NOT VALID` constraints and `CREATE INDEX CONCURRENTLY` (session 4, slide 21).
- The `traffic.js` change (§6.1) means the measuring tool is not the starter's; the counting is unchanged, but this is a judgement call I made without asking.
- The assistant (not I) typed every command of the real run, at my request and with my approval of each step (`AI-LOG.md`).
