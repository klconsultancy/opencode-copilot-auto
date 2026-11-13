# Cascade judge experiment (parked)

`auto-cascade` (opencode 2 >= 2.2.7, `"cascade": true` or `{ judge, draft }`) drafts on the
efficiency tier. When a turn ends, a judge model from another family reviews it through
`session.generate`. The cascade only observes: verdicts go to `cascade.jsonl` in the
state directory, and nothing escalates.

## Benchmarks

Each task has a repo, a prompt and hidden tests. The tests were checked against a
reference solution (`make_bench3.py --verify`). The judge was `claude-haiku-4.5` in every
round.

| Round | Tasks | Draft | Hidden tests | Verdicts | Judge cost |
|---|---|---|---|---|---|
| 1 | 13 simple (`make_bench.py`) | `gpt-6-luna` via /auto | 13/13 | 13 accept | $0.13 |
| 2 | same 13 | `mai-code-1.1-flash` (pinned) | 13/13 | 12 accept, 1 escalate (false) | $0.14 |
| 3 | 8 harder × 2 (`make_bench3.py`) | `mai-code-1.1-flash` (pinned) | 16/16 | 11 accept, 4 escalate (all false) | $0.32 |

## Conclusion

- **No run failed, so the judge never had a real failure to catch.** Even a flash model
  passed every well-specified task, including timezone, cron, JSON Patch, semver and
  Unicode-width traps.
- **All 5 escalations were false alarms.** The judge reacted to noise in the transcript:
  the draft's own ad-hoc checks with wrong expectations, "not enough tests", or a misread
  of the code.
- **The reported confidence carries no signal.** It was 0.85–0.95 regardless of the
  verdict.
- **Each verdict costs about 1–6 cents and 2–5 s.** The cost grows with turn length.

The cascade is not worth building out, and acting on these verdicts would mostly redo
correct work. If escalation is ever wanted, a deterministic signal is cheaper and more
precise, for example the last test command in the turn failing.

Results: `results/round*.jsonl`. Summarize one with `python3 summarize.py results/round3.jsonl`.
