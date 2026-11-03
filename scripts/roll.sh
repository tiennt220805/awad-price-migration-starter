#!/usr/bin/env bash
# Rolling restart of ONE instance onto one tagged version of the code.
#
#   DB_PATH=/abs/path/data/app.db scripts/roll.sh <tag> <port>
#
# Stops whatever listens on <port> (SIGTERM: the server finishes in-flight
# requests first), starts the code of <tag> from its own git worktree on that
# port against the shared database, and returns only once /health answers.
# Run it for one port, look at traffic-log.txt, then run it for the next port:
# never two at once.
#
#   WORKTREES  where the per-version worktrees live (default: ../wt next to the repo)
#   LOGS       where instance stdout goes            (default: ../instance-logs)
set -euo pipefail

TAG=${1:?usage: roll.sh <tag> <port>}
PORT=${2:?usage: roll.sh <tag> <port>}
: "${DB_PATH:?set DB_PATH to the absolute path of the shared database}"
case "$DB_PATH" in /*) ;; *) echo "DB_PATH must be absolute" >&2; exit 1;; esac

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WT="${WORKTREES:-$ROOT/../wt}/$TAG"
LOGS="${LOGS:-$ROOT/../instance-logs}"
mkdir -p "$LOGS"
[ -d "$WT" ] || git -C "$ROOT" worktree add --detach "$WT" "$TAG" >/dev/null

old=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN || true)
if [ -n "$old" ]; then
  kill -TERM $old
  for _ in $(seq 1 100); do                      # wait up to 10 s for the port to free
    lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.1
  done
  lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT still busy" >&2; exit 1; }
fi

(cd "$WT" && PORT=$PORT DB_PATH=$DB_PATH nohup node src/server.js >>"$LOGS/$PORT.log" 2>&1 &)

for _ in $(seq 1 100); do                         # wait up to 10 s for /health
  if curl -sf "http://localhost:$PORT/health" >/dev/null; then
    echo "port $PORT now runs $TAG (pid $(lsof -ti "tcp:$PORT" -sTCP:LISTEN))"
    exit 0
  fi
  sleep 0.1
done
echo "port $PORT did not come up; see $LOGS/$PORT.log" >&2
exit 1
