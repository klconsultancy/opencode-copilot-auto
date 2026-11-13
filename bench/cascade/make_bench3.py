"""Round 3 of the cascade benchmark: harder tasks with traps a weak draft model is
likely to miss. Same layout as make_bench.py (repo/, prompt.txt, check.sh,
hidden_test.py) plus reference/ (a known-good solution, used only to validate the
hidden tests: `python3 make_bench3.py OUT --verify`)."""
import os
import shutil
import subprocess
import sys
import textwrap

ROOT = sys.argv[1]
BENCH_DIR = "/home/node/bench3"
d = textwrap.dedent
TASKS = {}


def task(name, prompt, files, hidden_test, reference, keep_tests=()):
    TASKS[name] = dict(prompt=" ".join(prompt.split()), files=files, hidden_test=hidden_test, reference=reference, keep_tests=keep_tests)


# --- h01: free slots across UTC offsets ------------------------------------------------
task(
    "h01-slots",
    """Implement free_slots(busy, day_start, day_end, min_minutes) in slots.py. All timestamps are ISO 8601
    strings that carry a UTC offset or end in 'Z' (for example '2026-03-29T09:00:00+02:00'); a timestamp without an
    offset raises ValueError. busy is a list of (start, end) pairs in any order; they may overlap, touch, lie partly
    or fully outside the window, and a pair whose end is not after its start is ignored. Return the free gaps inside
    [day_start, day_end) that no busy interval covers, sorted, as (start, end) tuples formatted in UTC as
    'YYYY-MM-DDTHH:MM:SSZ', keeping only gaps of at least min_minutes minutes.""",
    {"slots.py": "def free_slots(busy, day_start, day_end, min_minutes):\n    raise NotImplementedError\n"},
    d("""
    import pytest
    from slots import free_slots
    W = ("2026-03-29T09:00:00Z", "2026-03-29T17:00:00Z")
    def z(h, m=0):
        return f"2026-03-29T{h:02d}:{m:02d}:00Z"
    def test_basic():
        assert free_slots([(z(10), z(11))], *W, 30) == [(z(9), z(10)), (z(11), z(17))]
    def test_offsets():
        busy = [("2026-03-29T12:00:00+02:00", "2026-03-29T13:00:00+02:00")]
        assert free_slots(busy, *W, 30) == [(z(9), z(10)), (z(11), z(17))]
    def test_overlap_touch_unsorted():
        busy = [(z(12), z(13)), (z(10), z(11)), (z(10, 30), z(12))]
        assert free_slots(busy, *W, 1) == [(z(9), z(10)), (z(13), z(17))]
    def test_clipping():
        busy = [(z(16, 30), "2026-03-29T18:00:00Z"), ("2026-03-29T08:00:00Z", z(9, 30))]
        assert free_slots(busy, *W, 1) == [(z(9, 30), z(16, 30))]
    def test_min_length():
        busy = [(z(10), z(11)), (z(11, 20), z(12))]
        assert free_slots(busy, *W, 30) == [(z(9), z(10)), (z(12), z(17))]
        busy = [(z(10), z(11)), (z(11, 30), z(12))]
        assert free_slots(busy, *W, 30) == [(z(9), z(10)), (z(11), z(11, 30)), (z(12), z(17))]
    def test_invalid_pair_ignored():
        assert free_slots([(z(12), z(11))], *W, 30) == [(z(9), z(17))]
    def test_naive_raises():
        with pytest.raises(ValueError):
            free_slots([("2026-03-29T10:00:00", z(11))], *W, 30)
    def test_dst_window():
        got = free_slots([], "2026-03-29T00:00:00+01:00", "2026-03-30T00:00:00+02:00", 0)
        assert got == [("2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z")]
    """),
    d("""
    from datetime import datetime, timedelta, timezone
    def _p(s):
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if d.tzinfo is None:
            raise ValueError(s)
        return d.astimezone(timezone.utc)
    def _f(d):
        return d.strftime("%Y-%m-%dT%H:%M:%SZ")
    def free_slots(busy, day_start, day_end, min_minutes):
        ws, we = _p(day_start), _p(day_end)
        iv = sorted((max(_p(a), ws), min(_p(b), we)) for a, b in busy)
        out, cur, need = [], ws, timedelta(minutes=min_minutes)
        for a, b in iv:
            if b <= a:
                continue
            if a > cur and a - cur >= need:
                out.append((_f(cur), _f(a)))
            cur = max(cur, b)
        if we > cur and we - cur >= need:
            out.append((_f(cur), _f(we)))
        return out
    """),
)

# --- h02: split money by weights --------------------------------------------------------
task(
    "h02-split",
    """Implement split_amount(total_cents, weights) in money.py. total_cents is an int (possibly negative or huge)
    and weights a list of non-negative ints. Return a list of ints, one per weight, that sums exactly to total_cents.
    Use the largest remainder method: each share first gets the floor of its exact proportional share of
    abs(total_cents); the cents left over go one each to the shares with the largest remainders, ties going to the
    lower index. For a negative total, split abs(total_cents) and negate every share. Raise ValueError when weights
    is empty, contains a negative weight, or sums to zero.""",
    {"money.py": "def split_amount(total_cents, weights):\n    raise NotImplementedError\n"},
    d("""
    import random
    import pytest
    from money import split_amount
    def test_examples():
        assert split_amount(100, [1, 1, 1]) == [34, 33, 33]
        assert split_amount(10, [1, 2, 3, 4]) == [1, 2, 3, 4]
        assert split_amount(7, [0, 1, 1]) == [0, 4, 3]
        assert split_amount(1, [1, 1]) == [1, 0]
    def test_largest_remainder_not_first_index():
        assert split_amount(5, [3, 3, 1, 1]) == [2, 2, 1, 0]
        assert split_amount(10, [1, 5, 5]) == [1, 5, 4]
    def test_negative():
        assert split_amount(-100, [1, 1, 1]) == [-34, -33, -33]
    def test_huge_exact():
        assert split_amount(10**18 + 1, [1, 1]) == [5 * 10**17 + 1, 5 * 10**17]
        assert split_amount(10**20, [1, 2]) == [33333333333333333333, 66666666666666666667]
    def test_errors():
        for w in ([], [1, -1], [0, 0]):
            with pytest.raises(ValueError):
                split_amount(10, w)
    def test_sum_property():
        rng = random.Random(7)
        for _ in range(300):
            w = [rng.randint(0, 9) for _ in range(rng.randint(1, 6))]
            if not sum(w):
                continue
            t = rng.randint(-10**6, 10**6)
            got = split_amount(t, w)
            assert sum(got) == t and len(got) == len(w)
    """),
    d("""
    def split_amount(total_cents, weights):
        if not weights or any(w < 0 for w in weights) or sum(weights) == 0:
            raise ValueError("bad weights")
        sign = -1 if total_cents < 0 else 1
        t, total = abs(total_cents), sum(weights)
        base = [t * w // total for w in weights]
        rem = [t * w % total for w in weights]
        order = sorted(range(len(weights)), key=lambda i: (-rem[i], i))
        for i in order[: t - sum(base)]:
            base[i] += 1
        return [sign * b for b in base]
    """),
)

# --- h03: fix an expression evaluator ---------------------------------------------------
CALC_BUGGY = d("""
from fractions import Fraction
import re

TOKEN = re.compile(r"\\s*(?:(\\d+)|(.))")


def tokenize(s):
    out = []
    for num, op in TOKEN.findall(s):
        if num:
            out.append(Fraction(int(num)))
        elif op.strip():
            out.append(op)
    return out


class Parser:
    def __init__(self, tokens):
        self.t = tokens
        self.i = 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def take(self):
        tok = self.peek()
        self.i += 1
        return tok

    def expr(self):
        v = self.term()
        while self.peek() in ("+", "-"):
            if self.take() == "+":
                v += self.term()
            else:
                v -= self.term()
        return v

    def term(self):
        v = self.power()
        while self.peek() in ("*", "/"):
            if self.take() == "*":
                v *= self.power()
            else:
                v = self.power() / v
        return v

    def power(self):
        v = self.unary()
        while self.peek() == "^":
            self.take()
            v = v ** self.unary()
        return v

    def unary(self):
        if self.peek() == "-":
            self.take()
            return -self.atom()
        return self.atom()

    def atom(self):
        tok = self.take()
        if tok == "(":
            v = self.expr()
            self.take()
            return v
        return tok


def evaluate(s):
    return Parser(tokenize(s)).expr()
""")

task(
    "h03-calc",
    """evaluate() in calc.py gets several cases wrong. Make it follow these rules: integers, + - * / ^ and parentheses;
    whitespace is ignored; results are exact fractions.Fraction values; * and / are left-associative and bind
    tighter than + and -; ^ is right-associative and binds tighter than unary minus (so -2^2 is -4 and 2^3^2 is 512);
    unary minus may repeat and may follow an operator (--3 is 3, 2*-3 is -6, 2^-1 is 1/2); a non-integer exponent
    raises ValueError; division by zero raises ZeroDivisionError; a malformed expression (empty input, a dangling
    operator, unbalanced parentheses, two numbers in a row, an unknown character) raises ValueError.""",
    {"calc.py": CALC_BUGGY},
    d("""
    from fractions import Fraction
    import pytest
    from calc import evaluate
    @pytest.mark.parametrize("expr,want", [
        ("1+2*3", 7), ("(1+2)*3", 9), ("8/2/2", 2), ("7/2", Fraction(7, 2)), ("10-4-3", 3),
        ("2^3^2", 512), ("-2^2", -4), ("(-2)^2", 4), ("--3", 3), ("2*-3", -6), ("2^-1", Fraction(1, 2)),
        (" 1 +  2 ", 3), ("2^(1+1)", 4), ("-(1+2)*2", -6),
    ])
    def test_values(expr, want):
        got = evaluate(expr)
        assert isinstance(got, Fraction) and got == want
    @pytest.mark.parametrize("expr", ["", "2+", "(1", "1)", "2 3", "a", "4^(1/2)", "*2", "()"])
    def test_malformed(expr):
        with pytest.raises(ValueError):
            evaluate(expr)
    def test_zero_division():
        with pytest.raises(ZeroDivisionError):
            evaluate("1/(2-2)")
    """),
    d("""
    from fractions import Fraction
    import re
    TOKEN = re.compile(r"\\s*(?:(\\d+)|(\\S))")
    def tokenize(s):
        out, pos = [], 0
        for m in TOKEN.finditer(s):
            num, op = m.groups()
            if num:
                out.append(Fraction(int(num)))
            elif op in "+-*/^()":
                out.append(op)
            else:
                raise ValueError(op)
        return out
    class Parser:
        def __init__(self, t):
            self.t, self.i = t, 0
        def peek(self):
            return self.t[self.i] if self.i < len(self.t) else None
        def take(self):
            tok = self.peek(); self.i += 1; return tok
        def expr(self):
            v = self.term()
            while self.peek() in ("+", "-"):
                v = v + self.term() if self.take() == "+" else v - self.term()
            return v
        def term(self):
            v = self.unary()
            while self.peek() in ("*", "/"):
                v = v * self.unary() if self.take() == "*" else v / self.unary()
            return v
        def unary(self):
            if self.peek() == "-":
                self.take(); return -self.unary()
            return self.power()
        def power(self):
            v = self.atom()
            if self.peek() == "^":
                self.take()
                e = self.unary()
                if e.denominator != 1:
                    raise ValueError("non-integer exponent")
                v = v ** int(e)
            return v
        def atom(self):
            tok = self.take()
            if tok == "(":
                v = self.expr()
                if self.take() != ")":
                    raise ValueError("unbalanced")
                return v
            if isinstance(tok, Fraction):
                return tok
            raise ValueError(f"unexpected {tok!r}")
    def evaluate(s):
        p = Parser(tokenize(s))
        v = p.expr()
        if p.peek() is not None:
            raise ValueError("trailing input")
        return Fraction(v)
    """),
)

# --- h04: truncate to a display width ---------------------------------------------------
task(
    "h04-truncate",
    """Implement display_width(s) and truncate_display(s, width) in textwidth.py. A character's display width is 0
    when unicodedata.combining() is non-zero for it, 2 when its unicodedata.east_asian_width() is 'W' or 'F', and 1
    otherwise; a string's width is the sum. truncate_display returns s unchanged when it fits in width; otherwise it
    returns the longest prefix of s that, followed by '…' (width 1), fits in width, plus '…'. It must never separate a
    character from the combining characters that follow it. A width below 1 raises ValueError.""",
    {"textwidth.py": "def display_width(s):\n    raise NotImplementedError\n\n\ndef truncate_display(s, width):\n    raise NotImplementedError\n"},
    d("""
    import pytest
    from textwidth import display_width, truncate_display
    E = "e\\u0301"
    def test_width():
        assert display_width("日a" + E) == 4
        assert display_width("") == 0
    def test_fits():
        assert truncate_display("hello", 10) == "hello"
        assert truncate_display("hello", 5) == "hello"
        assert truncate_display(E * 5, 5) == E * 5
    def test_ascii():
        assert truncate_display("hello world", 8) == "hello w…"
        assert truncate_display("abc", 1) == "…"
    def test_wide():
        assert truncate_display("日本語テキスト", 7) == "日本語…"
        assert truncate_display("日本語テキスト", 6) == "日本…"
        assert truncate_display("ab日本", 4) == "ab…"
    def test_combining_kept_together():
        assert truncate_display(E * 3 + "xyz", 4) == E * 3 + "…"
        assert truncate_display(E * 6, 3) == E * 2 + "…"
    def test_bad_width():
        with pytest.raises(ValueError):
            truncate_display("abc", 0)
    """),
    d("""
    import unicodedata
    def _w(c):
        if unicodedata.combining(c):
            return 0
        return 2 if unicodedata.east_asian_width(c) in ("W", "F") else 1
    def display_width(s):
        return sum(_w(c) for c in s)
    def truncate_display(s, width):
        if width < 1:
            raise ValueError("width")
        if display_width(s) <= width:
            return s
        clusters = []
        for c in s:
            if clusters and _w(c) == 0:
                clusters[-1] += c
            else:
                clusters.append(c)
        out, used = "", 0
        for cl in clusters:
            w = display_width(cl)
            if used + w > width - 1:
                break
            out, used = out + cl, used + w
        return out + "…"
    """),
)

# --- h05: semver precedence ------------------------------------------------------------
task(
    "h05-semver",
    """Implement sort_versions(versions) in semver.py: return the list sorted ascending by Semantic Versioning 2.0.0
    precedence. Major, minor and patch compare numerically. A version with a pre-release is lower than the same
    version without one. Pre-release identifiers compare left to right: numeric identifiers numerically,
    alphanumeric ones lexically in ASCII order, a numeric identifier is lower than an alphanumeric one, and when all
    preceding identifiers are equal the shorter list is lower. Build metadata (after '+') is ignored; versions of
    equal precedence keep their input order. Raise ValueError for an invalid version: not exactly
    MAJOR.MINOR.PATCH, a leading 'v', a leading zero in a numeric part or numeric pre-release identifier, an empty
    identifier, or a character other than [0-9A-Za-z-] in an identifier.""",
    {"semver.py": "def sort_versions(versions):\n    raise NotImplementedError\n"},
    d("""
    import pytest
    from semver import sort_versions
    def test_spec_example():
        want = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2",
                "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"]
        assert sort_versions(list(reversed(want))) == want
    def test_numeric_core():
        assert sort_versions(["1.10.0", "1.2.0", "1.9.0", "0.99.99"]) == ["0.99.99", "1.2.0", "1.9.0", "1.10.0"]
    def test_build_ignored_stable():
        assert sort_versions(["1.0.0+b", "1.0.0+a", "0.9.0"]) == ["0.9.0", "1.0.0+b", "1.0.0+a"]
    def test_ascii_order():
        assert sort_versions(["1.0.0-alpha", "1.0.0-Beta"]) == ["1.0.0-Beta", "1.0.0-alpha"]
    def test_numeric_vs_alnum():
        assert sort_versions(["1.0.0-0a", "1.0.0-1"]) == ["1.0.0-1", "1.0.0-0a"]
        assert sort_versions(["1.0.0-x-y", "1.0.0-x"]) == ["1.0.0-x", "1.0.0-x-y"]
    @pytest.mark.parametrize("bad", ["01.0.0", "1.0", "v1.0.0", "1.0.0-", "1.0.0-01", "1.0.0-a..b", "1.0.0+", "1.0.0.0", "1.0.0-a_b"])
    def test_invalid(bad):
        with pytest.raises(ValueError):
            sort_versions(["1.0.0", bad])
    """),
    d("""
    import re
    NUM = re.compile(r"0|[1-9][0-9]*")
    ID = re.compile(r"[0-9A-Za-z-]+")
    def _key(v):
        core, plus, build = v.partition("+")
        if plus and not all(ID.fullmatch(x) for x in build.split(".")):
            raise ValueError(v)
        core, dash, pre = core.partition("-")
        parts = core.split(".")
        if len(parts) != 3 or not all(NUM.fullmatch(p) for p in parts):
            raise ValueError(v)
        ids = []
        if dash:
            for x in pre.split("."):
                if not ID.fullmatch(x):
                    raise ValueError(v)
                if x.isdigit():
                    if not NUM.fullmatch(x):
                        raise ValueError(v)
                    ids.append((0, int(x), ""))
                else:
                    ids.append((1, 0, x))
        return (tuple(int(p) for p in parts), 0 if dash else 1, ids)
    def sort_versions(versions):
        keys = {v: _key(v) for v in versions}
        return sorted(versions, key=lambda v: keys[v])
    """),
)

# --- h06: cron next run ----------------------------------------------------------------
task(
    "h06-cron",
    """Implement next_run(expr, after) in cron.py. expr has exactly 5 whitespace-separated fields: minute (0-59), hour
    (0-23), day of month (1-31), month (1-12), day of week (0-7, where both 0 and 7 are Sunday). Each field is a
    comma-separated list of '*', a number, a range 'a-b', or a step '*/n' or 'a-b/n'. If both day of month and day of
    week are restricted (anything other than exactly '*'), a day matches when either matches; otherwise both must
    match. after is a naive datetime; return the first matching naive datetime strictly after it, with seconds and
    microseconds zero. Raise ValueError for a wrong field count, a value out of range, a range whose start exceeds
    its end, a step below 1, or when nothing matches within 5 years after `after`.""",
    {"cron.py": "def next_run(expr, after):\n    raise NotImplementedError\n"},
    d("""
    from datetime import datetime as dt
    import pytest
    from cron import next_run
    def test_step():
        assert next_run("*/15 * * * *", dt(2026, 1, 1, 10, 7)) == dt(2026, 1, 1, 10, 15)
        assert next_run("*/15 * * * *", dt(2026, 1, 1, 10, 15)) == dt(2026, 1, 1, 10, 30)
    def test_seconds_dropped():
        assert next_run("* * * * *", dt(2026, 1, 1, 10, 0, 30)) == dt(2026, 1, 1, 10, 1)
    def test_weekdays():
        assert next_run("0 9 * * 1-5", dt(2026, 1, 2, 9, 0)) == dt(2026, 1, 5, 9, 0)
    def test_sunday_0_and_7():
        assert next_run("0 0 * * 0", dt(2026, 1, 1)) == dt(2026, 1, 4)
        assert next_run("0 0 * * 7", dt(2026, 1, 1)) == dt(2026, 1, 4)
    def test_dom_or_dow():
        assert next_run("0 0 13 * 5", dt(2026, 1, 1)) == dt(2026, 1, 2)
        assert next_run("0 0 13 * 5", dt(2026, 1, 10)) == dt(2026, 1, 13)
    def test_dom_and_star_dow():
        assert next_run("0 0 13 * *", dt(2026, 1, 1)) == dt(2026, 1, 13)
    def test_lists_ranges_steps():
        assert next_run("5,10-20/5 8 * * *", dt(2026, 1, 1, 8, 6)) == dt(2026, 1, 1, 8, 10)
        assert next_run("5,10-20/5 8 * * *", dt(2026, 1, 1, 8, 20)) == dt(2026, 1, 2, 8, 5)
    def test_leap_day_and_rollover():
        assert next_run("0 0 29 2 *", dt(2026, 3, 1)) == dt(2028, 2, 29)
        assert next_run("30 23 31 12 *", dt(2026, 12, 31, 23, 30)) == dt(2027, 12, 31, 23, 30)
    def test_never():
        with pytest.raises(ValueError):
            next_run("0 0 30 2 *", dt(2026, 1, 1))
    @pytest.mark.parametrize("bad", ["60 * * * *", "* * * *", "* 24 * * *", "* * 0 * *", "5-1 * * * *", "*/0 * * * *", "* * * 13 *", "* * * * 8"])
    def test_invalid(bad):
        with pytest.raises(ValueError):
            next_run(bad, dt(2026, 1, 1))
    """),
    d("""
    from datetime import timedelta
    def _field(s, lo, hi):
        vals = set()
        for part in s.split(","):
            rng, slash, step = part.partition("/")
            if slash:
                if not step.isdigit() or int(step) < 1:
                    raise ValueError(part)
                step = int(step)
            else:
                step = 1
            if rng == "*":
                a, b = lo, hi
            elif "-" in rng:
                x, y = rng.split("-", 1)
                if not (x.isdigit() and y.isdigit()):
                    raise ValueError(part)
                a, b = int(x), int(y)
            else:
                if not rng.isdigit() or slash:
                    raise ValueError(part)
                a = b = int(rng)
            if a < lo or b > hi or a > b:
                raise ValueError(part)
            vals.update(range(a, b + 1, step))
        return vals
    def next_run(expr, after):
        f = expr.split()
        if len(f) != 5:
            raise ValueError(expr)
        mins, hrs = _field(f[0], 0, 59), _field(f[1], 0, 23)
        doms, mons = _field(f[2], 1, 31), _field(f[3], 1, 12)
        dows = {x % 7 for x in _field(f[4], 0, 7)}
        both = f[2] != "*" and f[4] != "*"
        def day_ok(t):
            dm, dw = t.day in doms, t.isoweekday() % 7 in dows
            return (dm or dw) if both else (dm and dw)
        t = (after + timedelta(minutes=1)).replace(second=0, microsecond=0)
        end = after + timedelta(days=366 * 5)
        while t <= end:
            if t.month not in mons or not day_ok(t):
                t = (t + timedelta(days=1)).replace(hour=0, minute=0)
            elif t.hour not in hrs:
                t = (t + timedelta(hours=1)).replace(minute=0)
            elif t.minute not in mins:
                t += timedelta(minutes=1)
            else:
                return t
        raise ValueError("no match within 5 years")
    """),
)

# --- h07: JSON Patch --------------------------------------------------------------------
task(
    "h07-jsonpatch",
    """Implement apply_patch(doc, ops) in jsonpatch.py following RFC 6902 (JSON Patch) with RFC 6901 pointers. Support
    add, remove, replace, move, copy and test. Pointers unescape ~1 to '/' and ~0 to '~'; '' is the whole document.
    For arrays, add accepts an index from 0 to the length or '-' (append); other operations need an existing index;
    an index with a leading zero is invalid. replace and remove require the target to exist. move may not move a
    location into one of its own children. test compares JSON values: numbers by value, but a boolean never equals a
    number. Return the patched document; never mutate doc or the values in ops. Any failure (including an unknown op
    or a missing member) raises PatchError, and the patch is all-or-nothing.""",
    {"jsonpatch.py": "class PatchError(Exception):\n    pass\n\n\ndef apply_patch(doc, ops):\n    raise NotImplementedError\n"},
    d("""
    import copy
    import pytest
    from jsonpatch import PatchError, apply_patch
    def test_add_array():
        assert apply_patch({"a": [1, 3]}, [{"op": "add", "path": "/a/1", "value": 2}]) == {"a": [1, 2, 3]}
        assert apply_patch({"a": [1]}, [{"op": "add", "path": "/a/-", "value": 2}]) == {"a": [1, 2]}
        assert apply_patch({"a": [1]}, [{"op": "add", "path": "/a/1", "value": 2}]) == {"a": [1, 2]}
    @pytest.mark.parametrize("path", ["/a/5", "/a/01", "/a/x", "/b/c"])
    def test_add_bad(path):
        with pytest.raises(PatchError):
            apply_patch({"a": [1, 2]}, [{"op": "add", "path": path, "value": 0}])
    def test_escaping():
        doc = {"a/b": 1, "m~n": 2, "~1": 5}
        ops = [{"op": "test", "path": "/a~1b", "value": 1}, {"op": "replace", "path": "/m~0n", "value": 3},
               {"op": "test", "path": "/~01", "value": 5}]
        assert apply_patch(doc, ops) == {"a/b": 1, "m~n": 3, "~1": 5}
    def test_remove_replace_missing():
        for op in ("remove", "replace"):
            with pytest.raises(PatchError):
                apply_patch({"a": 1}, [{"op": op, "path": "/b", "value": 1}])
        with pytest.raises(PatchError):
            apply_patch({"a": [1]}, [{"op": "remove", "path": "/a/1"}])
    def test_move():
        doc = {"a": {"b": 1}, "c": []}
        assert apply_patch(doc, [{"op": "move", "from": "/a/b", "path": "/c/-"}]) == {"a": {}, "c": [1]}
        with pytest.raises(PatchError):
            apply_patch(doc, [{"op": "move", "from": "/a", "path": "/a/x"}])
    def test_copy_is_deep():
        out = apply_patch({"a": {"x": 1}}, [{"op": "copy", "from": "/a", "path": "/b"},
                                            {"op": "replace", "path": "/b/x", "value": 2}])
        assert out == {"a": {"x": 1}, "b": {"x": 2}}
    def test_bool_vs_number():
        with pytest.raises(PatchError):
            apply_patch({"x": 1}, [{"op": "test", "path": "/x", "value": True}])
        with pytest.raises(PatchError):
            apply_patch({"x": False}, [{"op": "test", "path": "/x", "value": 0}])
        assert apply_patch({"x": 1}, [{"op": "test", "path": "/x", "value": 1.0}]) == {"x": 1}
        assert apply_patch({"x": [1, {"y": True}]}, [{"op": "test", "path": "/x", "value": [1, {"y": True}]}])
    def test_atomic_and_no_mutation():
        doc = {"a": [1], "b": {"c": 1}}
        before = copy.deepcopy(doc)
        with pytest.raises(PatchError):
            apply_patch(doc, [{"op": "add", "path": "/a/-", "value": 2}, {"op": "test", "path": "/b/c", "value": 2}])
        assert doc == before
        value = {"k": [1]}
        out = apply_patch(doc, [{"op": "add", "path": "/v", "value": value}, {"op": "add", "path": "/v/k/-", "value": 2}])
        assert doc == before and value == {"k": [1]} and out["v"] == {"k": [1, 2]}
    def test_root_and_unknown():
        assert apply_patch({"a": 1}, [{"op": "replace", "path": "", "value": [1]}]) == [1]
        with pytest.raises(PatchError):
            apply_patch({}, [{"op": "frob", "path": "/a"}])
    """),
    d("""
    import copy
    import re
    class PatchError(Exception):
        pass
    IDX = re.compile(r"0|[1-9][0-9]*")
    def _ptr(p):
        if p == "":
            return []
        if not isinstance(p, str) or not p.startswith("/"):
            raise PatchError(p)
        return [t.replace("~1", "/").replace("~0", "~") for t in p[1:].split("/")]
    def _idx(tok, n, allow_end):
        if allow_end and tok == "-":
            return n
        if not IDX.fullmatch(tok):
            raise PatchError(tok)
        i = int(tok)
        if i > n or (i == n and not allow_end):
            raise PatchError(tok)
        return i
    def _child(cur, t):
        if isinstance(cur, dict):
            if t not in cur:
                raise PatchError(t)
            return cur[t]
        if isinstance(cur, list):
            return cur[_idx(t, len(cur), False)]
        raise PatchError(t)
    def _get(doc, toks):
        for t in toks:
            doc = _child(doc, t)
        return doc
    def _add(doc, toks, val):
        if not toks:
            return val
        par, t = _get(doc, toks[:-1]), toks[-1]
        if isinstance(par, dict):
            par[t] = val
        elif isinstance(par, list):
            par.insert(_idx(t, len(par), True), val)
        else:
            raise PatchError(t)
        return doc
    def _remove(doc, toks):
        if not toks:
            raise PatchError("remove root")
        par, t = _get(doc, toks[:-1]), toks[-1]
        if isinstance(par, dict):
            if t not in par:
                raise PatchError(t)
            return par.pop(t)
        if isinstance(par, list):
            return par.pop(_idx(t, len(par), False))
        raise PatchError(t)
    def _replace(doc, toks, val):
        if not toks:
            return val
        _get(doc, toks)
        par, t = _get(doc, toks[:-1]), toks[-1]
        if isinstance(par, dict):
            par[t] = val
        else:
            par[_idx(t, len(par), False)] = val
        return doc
    def _eq(a, b):
        if isinstance(a, bool) or isinstance(b, bool):
            return type(a) is type(b) and a == b
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            return a == b
        if isinstance(a, dict) and isinstance(b, dict):
            return a.keys() == b.keys() and all(_eq(a[k], b[k]) for k in a)
        if isinstance(a, list) and isinstance(b, list):
            return len(a) == len(b) and all(_eq(x, y) for x, y in zip(a, b))
        return type(a) is type(b) and a == b
    def apply_patch(doc, ops):
        doc = copy.deepcopy(doc)
        for op in ops:
            try:
                kind, path = op["op"], _ptr(op["path"])
                if kind == "add":
                    doc = _add(doc, path, copy.deepcopy(op["value"]))
                elif kind == "remove":
                    _remove(doc, path)
                elif kind == "replace":
                    doc = _replace(doc, path, copy.deepcopy(op["value"]))
                elif kind == "move":
                    src = _ptr(op["from"])
                    if len(path) > len(src) and path[: len(src)] == src:
                        raise PatchError("move into child")
                    val = _remove(doc, src) if src else doc
                    doc = _add(doc, path, val)
                elif kind == "copy":
                    doc = _add(doc, path, copy.deepcopy(_get(doc, _ptr(op["from"]))))
                elif kind == "test":
                    if not _eq(_get(doc, path), op["value"]):
                        raise PatchError("test failed")
                else:
                    raise PatchError(kind)
            except (KeyError, TypeError, IndexError) as e:
                raise PatchError(str(e))
        return doc
    """),
)

# --- h08: discount codes in an existing cart -------------------------------------------
CART = d("""
from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")


class Cart:
    def __init__(self, catalog):
        # sku -> price as a string such as "19.99"
        self.catalog = catalog
        self.lines = {}

    def add(self, sku, qty=1):
        if sku not in self.catalog:
            raise KeyError(sku)
        if qty < 1:
            raise ValueError("qty must be positive")
        self.lines[sku] = self.lines.get(sku, 0) + qty

    def subtotal(self):
        return sum((Decimal(self.catalog[s]) * q for s, q in self.lines.items()), Decimal("0"))

    def total(self):
        return self.subtotal().quantize(CENT, ROUND_HALF_UP)
""")
CODES = d("""
# Discount codes. percent: value is a percentage of the subtotal; fixed: an amount off.
# min: the subtotal from which the code counts.
CODES = {
    "SAVE10": {"kind": "percent", "value": "10"},
    "SAVE25": {"kind": "percent", "value": "25", "min": "100.00"},
    "FIVEOFF": {"kind": "fixed", "value": "5.00"},
    "WELCOME2": {"kind": "fixed", "value": "2.00"},
}
""")
CART_TESTS = d("""
from decimal import Decimal
import pytest
from cart import Cart

def make():
    return Cart({"pen": "1.15", "book": "40.00", "lamp": "99.99"})

def test_total():
    c = make()
    c.add("pen", 3)
    c.add("book")
    assert c.total() == Decimal("43.45")

def test_unknown_and_qty():
    c = make()
    with pytest.raises(KeyError):
        c.add("car")
    with pytest.raises(ValueError):
        c.add("pen", 0)
""")
task(
    "h08-cart",
    """Add Cart.apply_code(code) to cart.py, using the codes in codes.py. Rules: codes are case-insensitive and
    surrounding whitespace is ignored; an unknown code raises ValueError. At most one percent code is active:
    applying another percent code replaces it. Fixed codes stack, but applying the same code twice raises ValueError.
    total() is the subtotal minus the percent discount, then minus all fixed discounts, never below zero, and rounded
    half-up to cents only once, at the very end. A code with a 'min' stays attached but only counts while the
    subtotal is at least that minimum. The existing tests in test_cart.py must keep passing.""",
    {"cart.py": CART, "codes.py": CODES, "test_cart.py": CART_TESTS},
    d("""
    from decimal import Decimal as D
    import pytest
    from cart import Cart
    def make(*items):
        c = Cart({"pen": "1.15", "book": "40.00", "lamp": "99.99"})
        for sku in items:
            c.add(sku)
        return c
    def test_percent_rounds_at_end():
        c = make("pen"); c.apply_code("SAVE10")
        assert c.total() == D("1.04")
        c = make(); c.add("pen", 3); c.apply_code("SAVE10")
        assert c.total() == D("3.11")
    def test_case_and_space():
        c = make("book"); c.apply_code("  save10 ")
        assert c.total() == D("36.00")
    def test_unknown():
        with pytest.raises(ValueError):
            make("book").apply_code("NOPE")
    def test_fixed_stack_and_duplicate():
        c = make("book"); c.apply_code("FIVEOFF"); c.apply_code("welcome2")
        assert c.total() == D("33.00")
        with pytest.raises(ValueError):
            c.apply_code("FIVEOFF")
    def test_percent_before_fixed():
        c = make("book"); c.apply_code("FIVEOFF"); c.apply_code("SAVE10")
        assert c.total() == D("31.00")
    def test_percent_replaces():
        c = make("book", "lamp"); c.apply_code("SAVE10"); c.apply_code("SAVE25")
        assert c.total() == D("104.99")
        c = make("book", "lamp"); c.apply_code("SAVE25"); c.apply_code("SAVE10")
        assert c.total() == D("125.99")
    def test_min_attached():
        c = make("book"); c.apply_code("SAVE25")
        assert c.total() == D("40.00")
        c.add("lamp")
        assert c.total() == D("104.99")
    def test_floor_zero():
        c = make("pen"); c.apply_code("FIVEOFF")
        assert c.total() == D("0.00")
    """),
    d("""
    from decimal import ROUND_HALF_UP, Decimal
    from codes import CODES
    CENT = Decimal("0.01")
    class Cart:
        def __init__(self, catalog):
            self.catalog = catalog
            self.lines = {}
            self.percent = None
            self.fixed = []
        def add(self, sku, qty=1):
            if sku not in self.catalog:
                raise KeyError(sku)
            if qty < 1:
                raise ValueError("qty must be positive")
            self.lines[sku] = self.lines.get(sku, 0) + qty
        def subtotal(self):
            return sum((Decimal(self.catalog[s]) * q for s, q in self.lines.items()), Decimal("0"))
        def apply_code(self, code):
            key = code.strip().upper()
            if key not in CODES:
                raise ValueError(code)
            if CODES[key]["kind"] == "percent":
                self.percent = key
            else:
                if key in self.fixed:
                    raise ValueError(code)
                self.fixed.append(key)
        def _counts(self, key, sub):
            m = CODES[key].get("min")
            return m is None or sub >= Decimal(m)
        def total(self):
            sub = self.subtotal()
            t = sub
            if self.percent and self._counts(self.percent, sub):
                t -= sub * Decimal(CODES[self.percent]["value"]) / 100
            for k in self.fixed:
                if self._counts(k, sub):
                    t -= Decimal(CODES[k]["value"])
            return max(t, Decimal("0")).quantize(CENT, ROUND_HALF_UP)
    """),
    keep_tests=("test_cart.py",),
)


def write():
    for name, t in TASKS.items():
        base = os.path.join(ROOT, name)
        shutil.rmtree(base, ignore_errors=True)
        os.makedirs(os.path.join(base, "repo"))
        os.makedirs(os.path.join(base, "keep"))
        for fname, content in t["files"].items():
            with open(os.path.join(base, "repo", fname), "w") as f:
                f.write(content.lstrip())
        for fname in t["keep_tests"]:
            shutil.copy(os.path.join(base, "repo", fname), os.path.join(base, "keep", fname))
        with open(os.path.join(base, "prompt.txt"), "w") as f:
            f.write(t["prompt"])
        with open(os.path.join(base, "hidden_test.py"), "w") as f:
            f.write(t["hidden_test"].lstrip())
        with open(os.path.join(base, "reference.py"), "w") as f:
            f.write(t["reference"].lstrip())
        tests = [os.path.join(BENCH_DIR, name, "hidden_test.py")] + [os.path.join(BENCH_DIR, name, "keep", k) for k in t["keep_tests"]]
        with open(os.path.join(base, "check.sh"), "w") as f:
            f.write(f"PYTHONPATH=. python3 -m pytest -q -p no:cacheprovider {' '.join(tests)}\n")
    print(f"{len(TASKS)} tasks in {ROOT}")


def verify():
    # Reference solution in place of the module under test; hidden + kept tests must pass.
    ok = True
    for name, t in TASKS.items():
        base = os.path.join(ROOT, name)
        work = os.path.join(ROOT, "_verify", name)
        shutil.rmtree(work, ignore_errors=True)
        shutil.copytree(os.path.join(base, "repo"), work)
        target = next(f for f in t["files"] if not f.startswith("test_") and f != "codes.py")
        shutil.copy(os.path.join(base, "reference.py"), os.path.join(work, target))
        tests = [os.path.join(base, "hidden_test.py")] + [os.path.join(base, "keep", k) for k in t["keep_tests"]]
        r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", *tests], cwd=work,
                           env={**os.environ, "PYTHONPATH": "."}, capture_output=True, text=True)
        print(name, "OK" if r.returncode == 0 else "FAIL")
        if r.returncode:
            ok = False
            print(r.stdout[-3000:])
        # The untouched starter must fail the hidden tests.
        r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", tests[0]],
                           cwd=os.path.join(base, "repo"), env={**os.environ, "PYTHONPATH": "."}, capture_output=True, text=True)
        if r.returncode == 0:
            ok = False
            print(name, "starter passes the hidden tests!")
    shutil.rmtree(os.path.join(ROOT, "_verify"), ignore_errors=True)
    sys.exit(0 if ok else 1)


write()
if "--verify" in sys.argv:
    verify()
