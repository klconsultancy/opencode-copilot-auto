"""Writes the cascade benchmark: one directory per task with repo/ (what the agent
sees), prompt.txt and check.sh (the hidden ground truth, run from the repo dir)."""
import os
import sys
import textwrap

ROOT = sys.argv[1]

TASKS = {}


def task(name, prompt, files, hidden_test=None, check=None):
    TASKS[name] = dict(prompt=prompt, files=files, hidden_test=hidden_test, check=check)


d = textwrap.dedent

task(
    "t01-fix-add",
    "Fix the bug in math_utils.py so add() returns the sum.",
    {"math_utils.py": "def add(a, b):\n    return a - b\n"},
    d("""
    from math_utils import add
    def test_add():
        assert add(2, 3) == 5
        assert add(-1, 1) == 0
    """),
)

task(
    "t02-slugify",
    "Implement slugify(text) in text_utils.py: lowercase, replace every run of characters that are not a-z or 0-9 "
    "with a single '-', and strip leading and trailing '-'. Accented letters must be transliterated to ASCII first "
    "(é becomes e, ü becomes u).",
    {"text_utils.py": "def slugify(text):\n    raise NotImplementedError\n"},
    d("""
    from text_utils import slugify
    def test_basic():
        assert slugify("Hello, World!") == "hello-world"
    def test_runs_and_edges():
        assert slugify("  --a__b--  ") == "a-b"
    def test_accents():
        assert slugify("Crème Brûlée") == "creme-brulee"
        assert slugify("Über Straße 12") in ("uber-strasse-12", "uber-strae-12", "uber-stra-e-12")
    def test_empty():
        assert slugify("") == ""
        assert slugify("!!!") == ""
    """),
)

task(
    "t03-duration",
    "Implement parse_duration(s) in duration.py. It returns the total number of seconds for strings like '1h30m', "
    "'45s', '2h5s' or '1h30m15s'. The units h, m and s each appear at most once, in that order, each after a "
    "positive integer. Raise ValueError for an empty string, an unknown unit, units out of order, a repeated unit, "
    "or a number without a unit.",
    {"duration.py": "def parse_duration(s):\n    raise NotImplementedError\n"},
    d("""
    import pytest
    from duration import parse_duration
    def test_values():
        assert parse_duration("1h30m") == 5400
        assert parse_duration("45s") == 45
        assert parse_duration("2h5s") == 7205
        assert parse_duration("1h30m15s") == 5415
        assert parse_duration("90m") == 5400
    @pytest.mark.parametrize("bad", ["", "1x", "30m1h", "1h1h", "h", "10", "1h 30m", "-1h"])
    def test_invalid(bad):
        with pytest.raises(ValueError):
            parse_duration(bad)
    """),
)

task(
    "t04-lru",
    "Implement class LRUCache in lru.py. LRUCache(capacity) creates it; get(key) returns the value or -1; "
    "put(key, value) stores it. When the cache is full, put evicts the least recently used key. Both get and put "
    "count as a use of the key.",
    {"lru.py": "class LRUCache:\n    def __init__(self, capacity):\n        raise NotImplementedError\n"},
    d("""
    from lru import LRUCache
    def test_sequence():
        c = LRUCache(2)
        c.put(1, 1); c.put(2, 2)
        assert c.get(1) == 1
        c.put(3, 3)
        assert c.get(2) == -1
        c.put(4, 4)
        assert c.get(1) == -1
        assert c.get(3) == 3
        assert c.get(4) == 4
    def test_update_existing_does_not_evict():
        c = LRUCache(2)
        c.put(1, 1); c.put(2, 2); c.put(1, 10)
        c.put(3, 3)
        assert c.get(1) == 10
        assert c.get(2) == -1
    def test_capacity_one():
        c = LRUCache(1)
        c.put(1, 1); c.put(2, 2)
        assert c.get(1) == -1 and c.get(2) == 2
    """),
)

task(
    "t05-paginate",
    "paginate() in pagination.py returns the wrong items. Fix it. Pages are 1-based. A page or per_page below 1 "
    "must raise ValueError.",
    {
        "pagination.py": d('''
        def paginate(items, page, per_page):
            """Return the items on a 1-based page."""
            start = page * per_page
            return items[start:start + per_page]
        ''').lstrip()
    },
    d("""
    import pytest
    from pagination import paginate
    def test_pages():
        items = list(range(10))
        assert paginate(items, 1, 3) == [0, 1, 2]
        assert paginate(items, 4, 3) == [9]
        assert paginate(items, 5, 3) == []
    @pytest.mark.parametrize("page,per", [(0, 3), (1, 0), (-1, 2)])
    def test_invalid(page, per):
        with pytest.raises(ValueError):
            paginate([1, 2], page, per)
    """),
)

task(
    "t06-roman",
    "Implement to_roman(n) and from_roman(s) in roman.py for 1 to 3999, using standard subtractive notation. "
    "Raise ValueError for numbers out of range and for invalid or non-canonical numerals such as 'IIII', 'VX' or 'IC'.",
    {"roman.py": "def to_roman(n):\n    raise NotImplementedError\n\n\ndef from_roman(s):\n    raise NotImplementedError\n"},
    d("""
    import pytest
    from roman import to_roman, from_roman
    def test_roundtrip():
        for n in range(1, 4000):
            assert from_roman(to_roman(n)) == n
    def test_known():
        assert to_roman(1994) == "MCMXCIV"
        assert from_roman("MMMCMXCIX") == 3999
    @pytest.mark.parametrize("n", [0, 4000, -5])
    def test_out_of_range(n):
        with pytest.raises(ValueError):
            to_roman(n)
    @pytest.mark.parametrize("s", ["IIII", "VX", "IC", "MMMM", "", "abc", "VV", "XM", "IIV"])
    def test_invalid(s):
        with pytest.raises(ValueError):
            from_roman(s)
    """),
)

task(
    "t07-intervals",
    "Implement merge_intervals(intervals) in intervals.py: given a list of [start, end] pairs in any order, return "
    "the merged intervals sorted by start. Intervals that touch, such as [1, 2] and [2, 3], are merged too.",
    {"intervals.py": "def merge_intervals(intervals):\n    raise NotImplementedError\n"},
    d("""
    from intervals import merge_intervals
    def norm(x):
        return [list(i) for i in x]
    def test_cases():
        assert norm(merge_intervals([])) == []
        assert norm(merge_intervals([[1, 3], [2, 6], [8, 10]])) == [[1, 6], [8, 10]]
        assert norm(merge_intervals([[8, 10], [1, 3], [2, 6]])) == [[1, 6], [8, 10]]
        assert norm(merge_intervals([[1, 2], [2, 3]])) == [[1, 3]]
        assert norm(merge_intervals([[1, 10], [2, 3], [4, 5]])) == [[1, 10]]
        assert norm(merge_intervals([[5, 5]])) == [[5, 5]]
    """),
)

task(
    "t08-question",
    "What does top_words() in wordfreq.py return when several words have the same count? Just explain it; do not "
    "change any files.",
    {
        "wordfreq.py": d('''
        from collections import Counter

        def top_words(text, n=3):
            counts = Counter(text.lower().split())
            return [w for w, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:n]]
        ''').lstrip()
    },
    check="sha=$(sha256sum wordfreq.py | cut -c1-16); test \"$sha\" = \"$EXPECTED_SHA\"",
)

task(
    "t09-csv",
    "Implement parse_csv_line(line) in csvline.py, returning the list of fields. Fields are separated by commas. A "
    "field may be enclosed in double quotes; inside quotes a comma is literal and two double quotes (\"\") stand for "
    "one double quote. Raise ValueError for an unterminated quote. Do not use the csv module.",
    {"csvline.py": "def parse_csv_line(line):\n    raise NotImplementedError\n"},
    d('''
    import pytest
    from csvline import parse_csv_line
    def test_cases():
        assert parse_csv_line("a,b,c") == ["a", "b", "c"]
        assert parse_csv_line('"a,b",c') == ["a,b", "c"]
        assert parse_csv_line('"he said ""hi""",x') == ['he said "hi"', "x"]
        assert parse_csv_line("a,,b") == ["a", "", "b"]
        assert parse_csv_line(",") == ["", ""]
        assert parse_csv_line('""') == [""]
    def test_unterminated():
        with pytest.raises(ValueError):
            parse_csv_line('"abc')
    def test_no_csv_module():
        import csvline, inspect
        assert "import csv" not in inspect.getsource(csvline)
    '''),
)

task(
    "t10-leap",
    "is_leap_year() in dates.py gives wrong answers for some years. Fix it and make sure days_in_month() stays correct.",
    {
        "dates.py": d('''
        def is_leap_year(year):
            return year % 4 == 0

        def days_in_month(year, month):
            if month == 2:
                return 29 if is_leap_year(year) else 28
            return 30 if month in (4, 6, 9, 11) else 31
        ''').lstrip()
    },
    d("""
    from dates import is_leap_year, days_in_month
    def test_leap():
        assert is_leap_year(2024) and is_leap_year(2000)
        assert not is_leap_year(1900) and not is_leap_year(2023) and not is_leap_year(2100)
    def test_days():
        assert days_in_month(1900, 2) == 28
        assert days_in_month(2000, 2) == 29
        assert days_in_month(2023, 4) == 30
        assert days_in_month(2023, 12) == 31
    """),
)

task(
    "t11-write-tests",
    "Add pytest tests for mean() and median() in stats.py to test_stats.py, covering normal and edge cases, and run them.",
    {
        "stats.py": d('''
        def mean(values):
            if not values:
                raise ValueError("mean of empty list")
            return sum(values) / len(values)

        def median(values):
            if not values:
                raise ValueError("median of empty list")
            s = sorted(values)
            mid = len(s) // 2
            return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2
        ''').lstrip()
    },
    check="test -f test_stats.py && n=$(grep -c '^def test_\\|^    def test_' test_stats.py) && test \"$n\" -ge 4 && python3 -m pytest -q -p no:cacheprovider test_stats.py",
)

task(
    "t12-median",
    "Make median() in stats.py correct for even-length lists (the average of the two middle values) and make it "
    "raise ValueError for an empty list.",
    {
        "stats.py": d('''
        def median(values):
            s = sorted(values)
            return s[len(s) // 2]
        ''').lstrip()
    },
    d("""
    import pytest
    from stats import median
    def test_median():
        assert median([3, 1, 2]) == 2
        assert median([4, 1, 3, 2]) == 2.5
        assert median([5]) == 5
        assert median([1, 1]) == 1
    def test_empty():
        with pytest.raises(ValueError):
            median([])
    def test_does_not_mutate():
        v = [3, 1, 2]
        median(v)
        assert v == [3, 1, 2]
    """),
)

task(
    "t13-orders",
    "Removing more items than are in stock should raise InsufficientStock (define it in inventory.py). place_order() "
    "in orders.py must leave the stock completely unchanged when any line of the order cannot be fulfilled.",
    {
        "inventory.py": d('''
        class Inventory:
            def __init__(self):
                self.stock = {}

            def add(self, sku, qty):
                self.stock[sku] = self.stock.get(sku, 0) + qty

            def remove(self, sku, qty):
                self.stock[sku] = self.stock.get(sku, 0) - qty
        ''').lstrip(),
        "orders.py": d('''
        def place_order(inventory, lines):
            """lines: list of (sku, qty)."""
            for sku, qty in lines:
                inventory.remove(sku, qty)
            return True
        ''').lstrip(),
    },
    d("""
    import pytest
    from inventory import Inventory, InsufficientStock
    from orders import place_order
    def make():
        inv = Inventory(); inv.add("a", 5); inv.add("b", 1)
        return inv
    def test_remove_too_many():
        inv = make()
        with pytest.raises(InsufficientStock):
            inv.remove("a", 6)
        assert inv.stock["a"] == 5
    def test_unknown_sku():
        inv = make()
        with pytest.raises(InsufficientStock):
            inv.remove("zzz", 1)
    def test_order_ok():
        inv = make()
        assert place_order(inv, [("a", 2), ("b", 1)])
        assert inv.stock == {"a": 3, "b": 0}
    def test_order_atomic():
        inv = make()
        with pytest.raises(InsufficientStock):
            place_order(inv, [("a", 2), ("b", 2)])
        assert inv.stock == {"a": 5, "b": 1}
    def test_order_same_sku_twice():
        inv = make()
        with pytest.raises(InsufficientStock):
            place_order(inv, [("a", 3), ("a", 3)])
        assert inv.stock == {"a": 5, "b": 1}
    """),
)

for name, t in TASKS.items():
    base = os.path.join(ROOT, name)
    os.makedirs(os.path.join(base, "repo"), exist_ok=True)
    for fname, content in t["files"].items():
        with open(os.path.join(base, "repo", fname), "w") as f:
            f.write(content)
    with open(os.path.join(base, "prompt.txt"), "w") as f:
        f.write(t["prompt"])
    if t["hidden_test"]:
        with open(os.path.join(base, "hidden_test.py"), "w") as f:
            f.write(t["hidden_test"].lstrip())
        check = f"PYTHONPATH=. python3 -m pytest -q -p no:cacheprovider {os.path.join('/home/node/bench', name, 'hidden_test.py')}"
    else:
        check = t["check"]
    with open(os.path.join(base, "check.sh"), "w") as f:
        f.write(check + "\n")
print(f"{len(TASKS)} tasks in {ROOT}")
