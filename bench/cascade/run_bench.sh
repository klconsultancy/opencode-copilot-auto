#!/usr/bin/env bash
# Runs every benchmark task on auto-cascade inside the dev container, then its
# hidden check. Results: ~/runs/results.jsonl (one line per task).
set -u
BENCH=/home/node/bench
RUNS=/home/node/runs
MODEL=${MODEL:-github-copilot/auto-cascade}
mkdir -p "$RUNS"
: > "$RUNS/results.jsonl"
for dir in "$BENCH"/t*/; do
  name=$(basename "$dir")
  work="$RUNS/$name"
  rm -rf "$work" && cp -r "$dir/repo" "$work"
  cd "$work" || continue
  export EXPECTED_SHA=$(sha256sum wordfreq.py 2>/dev/null | cut -c1-16)
  start=$(date +%s)
  timeout 420 oc2 run --standalone --archived --auto -m "$MODEL" "$(cat "$dir/prompt.txt")" > "$RUNS/$name.out" 2>&1
  code=$?
  secs=$(( $(date +%s) - start ))
  if bash "$dir/check.sh" > "$RUNS/$name.check" 2>&1; then passed=true; else passed=false; fi
  printf '{"task":"%s","passed":%s,"run_exit":%s,"secs":%s}\n' "$name" "$passed" "$code" "$secs" >> "$RUNS/results.jsonl"
  echo "$name passed=$passed exit=$code ${secs}s"
done
echo DONE
