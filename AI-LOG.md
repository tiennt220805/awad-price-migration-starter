# AI-LOG — IA#2 Zero-downtime migration (price → price_vnd)

Course CSC13114 · 23KTPM1 · individual assignment · Nguyễn Thành Tiến (23127128).

Tool used throughout: Claude Code (Sonnet 5.5, with an Opus 5.5 advisor).

Rule I follow (session 3 tiers): the assistant may write a migration file or a script, and I run it. **Deviation, declared:** for the real run I asked the assistant to execute the runbook for me, one command at a time, and to explain each result before I said `next`; so the assistant, not I, typed every command of the real run (see the entry of the real run below). I did not run any of them myself. The assistant also ran commands on scratch databases (tests, migration up/down drills, a full rehearsal on other ports); those runs are not evidence and their logs are not submitted. Entries below say who ran what. Nothing is copied into `traffic-log.txt` or `check-log.txt` by hand: both are real tool output.

---

## 2026-11-03 — reading the assignment

Tool: Claude Code (Sonnet 5.5).

Asked for: read every file in the IA2 folder (`requirement.md`, `IA#2-rubric.pdf`, `references.md`) and explain what I have to do.

Kept: the summary of the task (expand → migrate → contract), the six rubric criteria with their points, the list of deliverables and the due date (2026-11-05 22:00).

Changed: nothing yet.

Rejected: nothing.

By hand: nothing yet. To do by me: check the summary against the rubric PDF and against the starter README, which the assistant had not read at that point.

## 2026-11-03 — theory of zero-downtime migration

Tool: Claude Code (Sonnet 5.5).

Asked for: an explanation of how zero-downtime migration works, including rollback.

Kept: the expand / migrate / contract pattern; why dual write makes each step reversible; why backfill must wait until no price-only writer is serving; why dropping the column is the point of no return.

Changed: nothing yet.

Rejected: nothing.

By hand: nothing yet. To do by me: confirm every claim against the starter code and the session 4 slides before I rely on it in `MIGRATION.md`.

## 2026-11-03 — summary of deliverables and set-up of the `submission/` templates

Tool: Claude Code (Sonnet 5.5, Opus 5.5 advisor).

Asked for: a summary of the files to hand in and what each must contain; then empty templates for them, modelled on the IA1 templates, with my details filled in.

Kept: `MIGRATION.md`, `SELF_ASSESSMENT_REPORT.md`, this file and `CHECKLIST.md` as templates with `<TODO>` placeholders.

Changed: the IA1 log was written in Vietnamese; the IA2 brief requires English, so these files are in English.

Rejected: sample content for the two log files (`traffic-log.txt`, `check-log.txt`). They must contain real output only, so no placeholder file was created.

By hand: nothing yet. To do by me: fill every `<TODO>`, `<FILL>` and every score, after the real run.

---

## 2026-11-03 — read the starter repository

Tool: Claude Code (Sonnet 5.5).

Asked for: clone the starter and read the README and all code, then say where the traps are.

Kept: the list of write paths (`POST /menu`, `PATCH /menu/:id`) and read paths (`GET`, list, `POST /orders`); that `migrate` applies everything pending; that `price` is nullable ("half-done cleanup"); that the starter tests assert the exact response body.

Changed: nothing.

Rejected: nothing.

By hand: I ran `node -v`, `npm test` (4 pass on Node v26.5.0) and the one-line `DROP COLUMN` check on SQLite myself, because the assistant's attempt was blocked. Result: SQLite 3.53.4 drops a column that has a CHECK constraint.

## 2026-11-03 — design of the plan, review by the advisor model, slide check

Tool: Claude Code (Sonnet 5.5) with an Opus 5.5 advisor; the assistant also read the session 4 slides through the link in `references.md`.

Asked for: a step plan with the four rubric columns, then a review of it by the advisor.

Kept: the six-step order (expand, dual write, backfill, read switch, stop writing, drop); `v3 → v2 → v3` as the rollback exercise; `v4 → v3` is safe but `v4 → v2` is not; the drop as the point of no return; down of `003` re-derives `price` (slide 18).

Changed: the advisor found the compatibility column wrong for `v1` after step 2 (a v1 write leaves a stale `price_vnd`), and that `check` would say `INCONSISTENT` between `v4` and the drop; both were written into the plan.

Rejected: running two traffic processes to get `NEW_CLIENTS` on part of the time (each keeps its own expected prices, so they would report false `stale`). I decided not to ask the instructor and told the assistant to take the route that scores highest and to document each problem and its fix; the assistant then chose to change `traffic.js` and declare it (`MIGRATION.md` §6.1).

By hand: nothing was written by me in this entry. The assistant proposed the `NEW_CLIENTS` approach and naming migration `003` as the point of no return, and I accepted both. I have to be able to explain both at the oral.

## 2026-11-03 — implementation: tags v1–v5, migrations, backfill, scripts

Tool: Claude Code (Sonnet 5.5).

Asked for: write `traffic.js` runtime switch, `002`/`003` migrations with downs, `v2`, `v3`, `v4` code and tests, the backfill script, `roll.sh`, `backup.js`, `check-step.sh`.

Kept: all of it as committed in the repository (one commit per version, see `git log` and the tags).

Changed: the assistant first wrote the backfill with `WHERE price_vnd IS NULL` (as on the slide); the rehearsal below showed this was wrong and it was changed. The assistant also rewrote the comment of `003_drop_price.down.sql` after finding it contradictory.

Rejected: nothing else.

By hand: nothing so far. The assistant wrote and committed all code in the repository under my git identity; I still have to read each file, and the real run is mine to execute.

## 2026-11-03 — rehearsal on a scratch database found a real bug

Tool: Claude Code (Sonnet 5.5); the assistant ran the rehearsal script (outside the repository, other ports, scratch database).

Asked for: the same sequence as the real run, to find problems before it.

Kept: the finding and the fix. With the first backfill, `check` said `INCONSISTENT` right after step 2 and after the backfill (`disagree 57`), and traffic reported two `stale` reads once `v3` read `price_vnd`. Cause: while one instance runs `v2` and the other still `v1`, a `v1` write changes `price` only and leaves the `price_vnd` that `v2` wrote stale; `IS NULL` never repairs it. The backfill now also repairs rows where the two columns disagree. The second rehearsal printed `RESULT: zero failed requests` and `CONSISTENT` after the backfill (written up in `MIGRATION.md` §6.2).

Changed: the harness itself had a bug (stale registered worktrees made `git worktree add` fail silently, so one run never deployed `v2`; its `contract` failures came from that, not from the plan). Fixed the harness and ran it again.

Rejected: the logs of the rehearsal. They are not evidence and are not in the zip.

By hand: nothing in this entry. I have not seen the rehearsal logs, only the assistant's summary of them.

---

## 2026-11-03 — the real run (migrations 002 and 003, rolling restarts, rollback, one traffic run)

Tool: Claude Code (Sonnet 5.5), running the commands of `RUNBOOK.md`.

Asked for: execute the runbook one command at a time, show each output, explain it, and wait for me to say `next` before the next command.

Kept: everything it produced, unedited: `traffic-log.txt` (197 lines, one run: start 07:05:19Z, `NEW_CLIENTS -> 0.3` at line 88, final `RESULT: zero failed requests` at line 197) and `check-log.txt` (103 lines: the `migrate:down` drill on a scratch database, then one labelled check per step). The two logs are the raw output of `npm run traffic` and `scripts/check-step.sh`; no line was typed or edited by hand.

Changed: nothing in the plan. One thing differed from what the plan expected and is written up in `MIGRATION.md` §6.2: the 34 rows that disagreed after step 2 had been overwritten by `v2` before the backfill started, so the repair branch of the backfill changed 0 rows in the real run.

Rejected: nothing.

By hand: nothing typed by me. I approved each step by writing `next` after reading the assistant's explanation of the output. Two requests were made by the assistant by hand against the live service after the drop (`GET /menu/1`, `PATCH /menu/60 {"price":45.5}`), to show an old client still gets `price`; they are not part of the traffic log. Row 60 now has price 45.5.

## 2026-11-03 — documentation from the real logs, review by the advisor model, packaging

Tool: Claude Code (Sonnet 5.5) with an Opus 5.5 advisor.

Asked for: fill `MIGRATION.md` and write `SELF_ASSESSMENT_REPORT.md` from the real logs; then ask the advisor for small improvements that could raise the mark.

Kept: the advisor's list, all done without touching the evidence (no new traffic run, no edit to either log, no re-tag): a replay section in `MIGRATION.md` (§0); literal undo commands and rows `4a`/`4b` in the plan table; the point-of-no-return row no longer offers an undo as if it were safe; every cited line number re-read against the logs; `backfill-rerun-log.txt`, a stop-and-rerun demonstration of the backfill on a scratch database (the live one cannot be used any more after the drop); `What I did not manage` kept frank.

Changed: the assistant had drafted a score of 88; I decided to claim 100 and the report says 100. The assistant told me the honesty adjustment applies to the gap between that claim and the mark.

Rejected: removing the statements about the modified `traffic.js` and about the assistant having typed every command, so that the page would look more consistent with 100.

By hand: I chose the total (100). Everything else was written by the assistant; I still have to read it.

## Entries still to write (as I go)

Add one entry per task in which the assistant helps from now on, using this format:

```md
## <YYYY-MM-DD> — <what you were working on>

Tool: <Claude Code / Copilot / Cursor / something else / none>
Asked for: <the task you gave it, in one sentence>
Kept: <what you took as it came>
Changed: <what you rewrote, and why>
Rejected: <what you threw away, and why>
By hand: <the parts you wrote yourself, and which commands you ran>
```

Nothing further is planned. Anything the assistant does after this point must be logged here before the zip is made.
