#!/usr/bin/env bash
# Round 3: each task REPS times on auto-cascade, then its hidden check.
set -u
BENCH=/home/node/bench3
RUNS=/home/node/runs3
REPS=${REPS:-2}
MODEL=${MODEL:-github-copilot/auto-cascade}
mkdir -p "$RUNS"
: > "$RUNS/results.jsonl"
for rep in $(seq 1 "$REPS"); do
  for dir in "$BENCH"/h*/; do
    name=$(basename "$dir")
    work="$RUNS/$name-r$rep"
    rm -rf "$work" && cp -r "$dir/repo" "$work"
    cd "$work" || continue
    start=$(date +%s)
    timeout 600 oc2 run --standalone --archived --auto -m "$MODEL" "$(cat "$dir/prompt.txt")" > "$work.out" 2>&1
    code=$?
    secs=$(( $(date +%s) - start ))
    if bash "$dir/check.sh" > "$work.check" 2>&1; then passed=true; else passed=false; fi
    printf '{"task":"%s","rep":%s,"passed":%s,"run_exit":%s,"secs":%s}\n' "$name" "$rep" "$passed" "$code" "$secs" >> "$RUNS/results.jsonl"
    echo "$name r$rep passed=$passed exit=$code ${secs}s $(tail -1 "$work.check")"
  done
done
echo DONE
