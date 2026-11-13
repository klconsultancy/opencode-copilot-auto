import json
import sys

total_cost = 0.0
for line in open(sys.argv[1]):
    r = json.loads(line)
    t = r.get("tokens") or {}
    cache = t.get("cache", {})
    inp = t.get("input", 0) + cache.get("read", 0) + cache.get("write", 0)
    cost = r.get("cost") or 0
    total_cost += cost
    ms = (r.get("ms") or 0) / 1000
    print(
        f"{r['prompt'][:38]:38} req={r['requests']:2} draft={','.join(r['draftModels']):12} "
        f"judge={r.get('judgeModel', '-'):16} {r['verdict']:9} conf={str(r.get('confidence', '-')):4} "
        f"in={inp:5} out={t.get('output', 0):4} ${cost:.4f} {ms:.1f}s"
    )
    if r["verdict"] != "accept":
        for reason in r["reasons"]:
            print("      -", reason[:260])
print(f"total judge cost ${total_cost:.4f}")
