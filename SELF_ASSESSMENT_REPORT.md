# Self-assessment — IA#2

Submitted by: 23127128 — Nguyễn Thành Tiến

Total I claim: 100 / 100

Line numbers below are lines of `traffic-log.txt` (T) and `check-log.txt` (C) at the repository root.

| Criterion | Max | I claim | Evidence |
|---|---|---|---|
| 1. The plan | 20 | 20 | `MIGRATION.md` §1: ten rows (steps 0, 1, 2, 3, 4, 4a, 4b, 5, 6), each with schema after the step, code version, a literal undo command and the earlier versions that still run safely. Point of no return named in §3 (migration `003`) with its reason. §2 maps every step to the tags `v1`–`v5` and to `migrations/002_*` and `003_*`; §0 is a replay sequence. The labels in `check-log.txt` use the same step numbers (C 27, 33, 42, 51, 60, 69, 78, 87, 96). |
| 2. Expand and dual write | 20 | 20 | `migrations/002_add_price_vnd.up.sql` is its own migration, nullable; `v1` kept serving after it (C 33–40, T lines 12–27 show no failure). Tag `v2`, `src/app.js`: `POST /menu` and `PATCH /menu/:id` write both columns in one statement, accept `price` or `priceVnd`, respond with both. Every migration has a `.down.sql`; `migrate:down` was run once for each of `003`, `002`, `001` on a scratch database: C 1–26. |
| 3. Backfill | 15 | 15 | `scripts/backfill_price_vnd.js`: batches of 500, each its own `BEGIN IMMEDIATE … COMMIT`, keyset by `id`. It ran under traffic after both instances ran `v2` (T 76–88 then backfill), 77 batches, 3,992 ms (`MIGRATION.md` §7), and C 51 is `CONSISTENT` right after (`price_vnd_null 0`, `disagree 0`). Stop and rerun with the same result: `backfill-rerun-log.txt`. |
| 4. Zero failed requests | 20 | 20 | `traffic-log.txt` is one run: start T 2, final `RESULT: zero failed requests` at T 197 (`FINAL … error=0 contract=0 stale=0 unavailable=0` at T 196). Ten rolling restarts, one instance at a time, `down`/`back` at T 28/30, 75/76, 111/113, 120/121, 127/128, 139/141, 147/148, 159/160, 168/169, 180/181. `NEW_CLIENTS -> 0.3` at T 88, after the API offered `priceVnd` (v2), on until the end. The `traffic.js` change that makes this possible is declared in `MIGRATION.md` §6.1. |
| 5. The way back | 15 | 15 | `v3` (reads `price_vnd`) → `v2` → `v3` under traffic: T 127–160, no failure line. `CONSISTENT` before (C 60, step 4), after the rollback (C 69, 4a) and after going forward again (C 78, 4b). `MIGRATION.md` §4 says why it is safe (v3 still writes both columns) and why `v4 → v2` is not (C 87: `disagree 1898`). |
| 6. Contract | 10 | 10 | `migrations/003_drop_price.up.sql` applied from tag `v5` only after `v4` (neither reads nor writes `price`, see `src/app.js` at `v4`) ran on both instances (T 168–181, C 87), after a verified backup. `price` is still returned by every endpoint that returned it: `GET /menu`, `GET /menu/:id`, `POST /menu`, `PATCH /menu/:id` (`MIGRATION.md` §8). After the drop: C 96 `CONSISTENT`, T 183–197 clean. |

## What I did not manage

- **I changed `scripts/traffic.js`** (a runtime switch for `NEW_CLIENTS`, `SIGUSR2`), so the measuring tool is not the starter's. The counting of failures is untouched and the change is declared in `MIGRATION.md` §6.1, but I made that call without asking the instructor, and a grader may weigh it differently from me.
- **The assistant typed every command of the real run**, at my request and with my approval after each step. This is not the session-3 tier ("the assistant writes, you run"); it is declared in `AI-LOG.md`. I wrote none of the code in this repository by hand.
- **The bug I found in the backfill was seen only in a rehearsal.** The slide's `WHERE price_vnd IS NULL` leaves rows wrong when `v1` and `v2` run side by side (`MIGRATION.md` §6.2). In the real run those 34 rows had been overwritten before the backfill started, so its repair branch changed 0 rows. The fix rests on the rehearsal and on the reasoning, not on a failure in the final log.
- **The backfill's stop-and-rerun is not in the real log.** It could not be repeated on the live database after `price` was dropped, so it is shown on a scratch database (`backfill-rerun-log.txt`). The real run's backfill summary is quoted in `MIGRATION.md` §7 from the terminal, not from a submitted log.
- **The point of no return is arguable.** `003_drop_price.down.sql` rebuilds `price` from `price_vnd`, as session 4 slide 18 says; I name the drop as the point of no return because that rebuild recomputes the column and only the backup holds the original values (`MIGRATION.md` §3).
- **`migrate:down` was run on a scratch database, not on the live one,** and not under traffic.
- Rolling restarts run on one machine; there is no real load balancer, `traffic.js` plays its part. The seeded database has no row with `price` NULL, so the handling of such rows (skipped and counted) was tested only on a scratch database.

## What I would do differently

Rehearse the whole sequence earlier and read the first `check` after the dual-write step more carefully: the first backfill I wrote followed the slide and failed on a case the slide does not mention (rows that `v1` leaves wrong while `v2` is already on one instance).
