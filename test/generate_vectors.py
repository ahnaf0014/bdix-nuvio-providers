#!/usr/bin/env python3
"""Generate test/vectors.json - expected outputs from the Python original.

This is the half of the port's verification that does not need the sites.  The
JS providers are a re-implementation of bdix/common.py in another language, and
the risk in that is not a crash - it is a helper that quietly computes something
slightly different, so a request returns a different film than the Stremio addon
does for the same title.  Nothing about that fails loudly.

So every shared helper is exercised here over a corpus, and the JS is asserted
against these vectors in test/units.js.  The title corpus is the cross product
of real names taken from these libraries, which is what makes the coverage
meaningful rather than illustrative: those are the strings the matcher actually
meets.

difflib is standard library, so the SequenceMatcher vectors are reproducible
anywhere.  The rest are read out of the real bdix package, which lives in a
sibling directory - set BDIX_ADDON if it is somewhere else:

    python test/generate_vectors.py

The output is committed.  CI re-runs test/units.js against it, and never needs
the Python side at all.
"""
from __future__ import annotations

import difflib
import html
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADDON = Path(os.environ.get("BDIX_ADDON", ROOT.parent / "bdix-stremio-addons"))

sys.path.insert(0, str(ADDON))
try:
    from bdix import common as C
except ImportError as e:                                    # pragma: no cover
    sys.stderr.write(
        f"generate_vectors.py: cannot import bdix.common from {ADDON}\n"
        f"  ({e})\n"
        "  Set BDIX_ADDON to the bdix-stremio-addons checkout.\n")
    raise SystemExit(1)


# Titles these libraries actually file, plus the near-misses the matcher exists
# to judge.  The cross product is the test: the interesting cases are the ones
# nobody would think to write down.
TITLES = [
    "Dune", "Dune: Part One", "Dune: Part Two", "Dune 2",
    "Avatar", "Avatar: The Way of Water", "Avatar: Fire and Ash",
    "Avatar: The Last Airbender", "Avatar - The Last Airbender",
    "The Shawshank Redemption", "Shawshank Redemption",
    "It Ends with Us", "It Ends", "Soneriada 4: It Ends Now",
    "3 Idiots", "3 Idiotas", "12 Monkeys", "Twelve Monkeys",
    "Toy Story", "Toy Story 2", "Toy Story 3",
    "Saw", "SAW II", "Saw X",
    "Back to the Future", "Back to the Future Part II",
    "Gangs of Wasseypur", "Gangs of Wasseypur II",
    "American History X", "American Psycho",
    "Breaking Bad", "Breaking Bread", "Bad Breaking",
    "The Office", "The Officer", "Office Space",
    "Demon City", "KPop Demon Hunters",
    "Mayday", "May Day", "The Mayday",
    "Spirited Away", "Sen to Chihiro no Kamikakushi",
    "Interstellar", "Oppenheimer", "Fight Club", "Fight Club (1999)",
    "Face/Off", "9", "9/11", "$9.99", "Up", "Her",
    "The Lord of the Rings", "The Lord of the Rings: The Fellowship of the Ring",
    "Rick and Morty", "American Horror Story",
]

LABELS = [
    "Fight Club (1999) (4K)",
    "Fight Club (1999) 1080p BluRay",
    "3 Idiots (3 idiotas) (2017) 1080p",
    "Dune (2021) (3D)",
    "Breaking Bad Season 03 (2010) Completed",
    "Chernobyl Season 01 (2019) Completed",
    "Back to the Future I",
    "12 Monkeys (1995) 720p",
    "Foo (US) (1995) 720p",
    "No Year Here",
    "SAW II (2005)",
    "The Lord of the Rings (2001)",
    "band of brothers (2001)",
    "Interstellar (2014)",
]

TEXTS = [
    "Drifting Home (2022) [1080p] [WEBRip] [YTS.MX]",
    "The Shawshank Redemption (1994)",
    "Season 3", "Generator Rex Season 3 Complete 1080p",
    "S01E02", "S:1E:1", "S6.E0", "s1 e1", "S01", "E05",
    "1080p BluRay x265", "4K HDR", "720p", "no tag here",
    "The Godfather Part II (1974) 2160p",
]

SIZES = [
    0, 1, 512, 1023, 1024, 1536, 1048575, 1048576, 1073741824,
    1234567, 736160525, 1214810000, 1073217536, 1099511627776,
    68200000000, 999, 1000000000, 1587200000,
]

URLS = [
    "http://h/file.mkv", "http://h/file.MKV", "http://h/file.mp4?x=1",
    "http://h/a.b/file.mkv", "http://h/", "http://h", "http://h/noext",
    "http://h/3%20idiots%20(2009)%201080p.mkv", "http://h/.hidden",
    "http://h/file.mkv#frag", "http://h/dir.v2/file",
]


def jsonable(value):
    """Tuples become lists; nothing else in these helpers returns one."""
    if isinstance(value, tuple):
        return [jsonable(v) for v in value]
    return value


CASES = []


def case(fn, args, expect):
    CASES.append({"fn": fn, "args": list(args), "expect": jsonable(expect)})


def raw(fn, args, expect):
    """A case whose expectation is not a bdix helper - difflib itself."""
    CASES.append({"fn": fn, "args": list(args), "expect": expect})


# ---- SequenceMatcher: the one helper ported rather than transcribed -----
#
# Checked against difflib directly, so these vectors stay reproducible without
# the bdix package at all.

pairs = [(a, b) for a in TITLES for b in TITLES]
for a, b in pairs:
    raw("seqRatio", [C.norm(a), C.norm(b)],
        difflib.SequenceMatcher(None, C.norm(a), C.norm(b)).ratio())
# A few explicitly awkward ones, to reach branches the corpus may not.
for a, b in [("", ""), ("a", ""), ("", "a"), ("a", "a"), ("ab", "ba"),
             ("aaaa", "aa"), ("abcabc", "abc"), ("x", "y" * 300),
             ("the quick brown fox", "the quick brown fix")]:
    raw("seqRatio", [a, b], difflib.SequenceMatcher(None, a, b).ratio())


# ---- the matcher and its helpers ----------------------------------------

for a in TITLES:
    case("norm", [a], C.norm(a))
    case("headWord", [a], C.head_word(a))

for a, b in pairs:
    case("similar", [a, b], C.similar(a, b))

for a in TITLES:
    for b in TITLES:
        for ya, yb in [(None, None), (1999, None), (None, 1999),
                       (1999, 1999), (2009, 2009), (1999, 2000), (1999, 2001),
                       (1999, 2003), (2021, 2024)]:
            case("matchScore", [a, ya, b, yb], C.match_score(a, ya, b, yb))

for gap in range(0, 7):
    case("yearBonus", [gap], C.year_bonus(gap))
case("matchFloor", [], C.MATCH_FLOOR)
case("yearTolerance", [], C.YEAR_TOLERANCE)


# ---- episode and quality markers ----------------------------------------

for t in TEXTS:
    case("episodeMarker", [t], C.episode_marker(t))
    case("qualityTag", [t], C.quality_tag(t))
    case("qualityScore", [t], C.quality_score(t))


# ---- sizes ---------------------------------------------------------------

for n in SIZES:
    case("sizeText", [n], C.size_text(n))
for n in SIZES:
    case("sizeText", [str(n)], C.size_text(str(n)))


# ---- media files ---------------------------------------------------------

for u in URLS:
    case("fileExt", [u], C.file_ext(u))
    case("isVideo", [u], C.is_video(u))


# ---- years ---------------------------------------------------------------

for v in [1999, 0, 1900, 1901, "2014-11-07", "2014", "", None, "n/a",
          "released 1995 maybe", 2024.7]:
    case("intYear", [v], C.int_year(v))


# ---- labels --------------------------------------------------------------

sys.path.insert(0, str(ADDON / "bdix" / "sources"))
from bdix.sources.dhakaflix import _split_label as dhaka_split      # noqa: E402
from bdix.sources.iccftp import _split_label as icc_split, \
    _split_show as icc_split_show                                    # noqa: E402

for label in LABELS:
    case("splitLabel", [label], dhaka_split(label))
    # dhakaflix and iccftp carry this verbatim; if they ever diverge the
    # generator fails rather than picking one silently.
    if jsonable(dhaka_split(label)) != jsonable(icc_split(label)):
        raise SystemExit(f"split_label diverged between sources on {label!r}")
    case("splitShow", [label], icc_split_show(label))


# ---- RSC flight decoding -------------------------------------------------

FLIGHT = (
    'self.__next_f.push([1,"7:[\\"$\\",\\"$L8\\",null,{\\"initialResults\\":'
    '{\\"movies\\":[{\\"title\\":\\"Dune\\",\\"year\\":2021,\\"slug\\":\\"dune\\"}],'
    '\\"tv\\":[]}}]\\n"])'
    'self.__next_f.push([1,"8:[\\"$\\",\\"div\\",null,{\\"links\\":['
    '{\\"url\\":\\"http://h/f.mkv\\",\\"quality\\":\\"1080p\\",'
    '\\"size_bytes\\":1234,\\"movie_id\\":7}]}]\\n"])'
)
case("decodeFlight", [FLIGHT], C.decode_flight(FLIGHT))

# match_balanced / json_after over the decoded text.
decoded = C.decode_flight(FLIGHT)
case("jsonAfter", [decoded, "initialResults"], C.json_after(decoded, "initialResults"))
case("jsonAfter", [decoded, "links"], C.json_after(decoded, "links"))
case("jsonAfter", [decoded, "missing"], C.json_after(decoded, "missing"))
case("jsonAfter", ['{"links": [1,2,{"a":"}"}]}', "links"],
     C.json_after('{"links": [1,2,{"a":"}"}]}', "links"))

for text in ['{"a": 1}', 'xx', '"a string with { and [ in it"',
             '{"nested": {"deep": [1, {"x": 2}]}} tail']:
    for i in [0]:
        if text[i:i + 1] in "{[":
            case("matchBalanced", [text, i, text[i], "}" if text[i] == "{" else "]"],
                 C.match_balanced(text, i, text[i], "}" if text[i] == "{" else "]"))


# ---- url and text helpers ------------------------------------------------

for base, rel in [
    ("http://h/a/b/", "c.mkv"),
    ("http://h/a/b/", "/c.mkv"),
    ("http://h/a/b/f.html", "c.mkv"),
    ("http://h/a/b/", "http://other/c.mkv"),
    ("http://h/a/b/", "//other/c.mkv"),
    ("http://h:5000/a/", "c.mkv"),
]:
    case("urlJoin", [base, rel], C.urllib.parse.urljoin(base, rel))

for s in ["A &amp; B", "&lt;tag&gt;", "&quot;q&quot;", "&#39;s", "&nbsp;x",
          "a &amp;lt; b", "&#65;&#x42;", "plain", ""]:
    case("unescapeHtml", [s], html.unescape(s))

case("hostOf", ["http://h:5000/a/b"], "h:5000")
case("hostOf", ["https://cdn.nagordola.com.bd/api"], "cdn.nagordola.com.bd")

for s in ["Fight Club (1999)", "3 Idiots", "Face/Off", "a b c", "50%",
          "x&y=1", "ü ñ", "", "100% legit"]:
    case("quote", [s], C.urllib.parse.quote(s))
    case("unquote", [C.urllib.parse.quote(s)], C.urllib.parse.unquote(
        C.urllib.parse.quote(s)))
    case("formEncode", [{"token": s, "psearch": s}],
         C.urllib.parse.urlencode({"token": s, "psearch": s}))


# ---- write ---------------------------------------------------------------

out = ROOT / "test" / "vectors.json"
# Compact on purpose: 31k cases of generated fixture, and indent=1 triples the
# file for no one's benefit - nothing reads this by eye, and a mismatch prints
# the case it failed on.
out.write_text(json.dumps({"cases": CASES}, separators=(",", ":")) + "\n",
               encoding="utf-8")

by_fn: dict[str, int] = {}
for c in CASES:
    by_fn[c["fn"]] = by_fn.get(c["fn"], 0) + 1
print(f"wrote {out.relative_to(ROOT)}: {len(CASES)} cases")
for fn in sorted(by_fn):
    print(f"  {fn:16} {by_fn[fn]}")
