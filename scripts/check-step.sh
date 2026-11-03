#!/usr/bin/env bash
# Run `npm run check` and append its output to check-log.txt under a label.
#
#   DB_PATH=/abs/app.db scripts/check-step.sh "2 dual write: v2 on both"
#
# The header records the wall-clock time and how many lines traffic-log.txt has
# at that moment, so a step can later be pointed at as a line range of the
# traffic log. The output is the real output of `npm run check`; nothing is edited.
set -uo pipefail
cd "$(dirname "$0")/.."
: "${DB_PATH:?set DB_PATH to the absolute path of the database}"
label=${1:?usage: check-step.sh "<label>"}
tl=0; [ -f traffic-log.txt ] && tl=$(wc -l < traffic-log.txt | tr -d ' ')
{
  echo "=== after step: $label · $(date '+%Y-%m-%d %H:%M:%S') · traffic-log.txt has $tl lines ==="
  npm run -s check
  echo "(npm run check exit code: $?)"
  echo
} 2>&1 | tee -a check-log.txt
