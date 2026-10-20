// Shared framework helpers - no site logic in here.
//
// Concatenated ahead of every provider by build.py, so each file in providers/
// is standalone: Nuvio evaluates one file per scraper and there is no require()
// across them.  This mirrors bdix/common.py, and the two are meant to stay in
// step - the title matcher in particular is the same algorithm, because a
// difference here would show up as a provider returning a different film than
// the Stremio addon does for the same request.
//
// The runtime is QuickJS, so async/await, const/let and template literals are
// all available.  fetch() is a bridge to the host: it ignores options.signal
// and there is no cookie jar, which is why nothing here relies on either.

var UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) bdix/2.0" };

var TMDB = "https://api.themoviedb.org/3";


// ======================================================================
// HTTP
// ======================================================================

// A fetch that gives up waiting after `ms`.
//
// The runtime's fetch ignores options.signal and the host bridge takes no
// timeout, so the request itself cannot be cancelled - but the *await* can be
// released, and that is the part that matters: a host that has gone quiet must
// not be able to spend the whole lookup.  The abandoned request is left for the
// runtime to reap.
//
// If the runtime's timer never fires, this degrades to a plain fetch rather
// than to a wrong answer, which is why it is safe to use anywhere.
function fetchWithTimeout(url, init, ms) {
  if (!ms || ms <= 0) return fetch(url, init);

  var timer = null;
  function done() { if (timer !== null) { clearTimeout(timer); timer = null; } }

  return Promise.race([
    fetch(url, init).then(
      function (r) { done(); return r; },
      function (e) { done(); throw e; }
    ),
    new Promise(function (_resolve, reject) {
      timer = setTimeout(function () {
        timer = null;
        reject(new Error("timed out after " + ms + "ms"));
      }, ms);
    }),
  ]);
}

function request(url, opts) {
  opts = opts || {};
  var init = {
    method: opts.method || "GET",
    headers: Object.assign({}, UA, opts.headers || {}),
  };
  if (opts.body !== undefined && opts.body !== null) init.body = opts.body;
  return fetchWithTimeout(url, init, opts.timeout);
}

function fetchText(url, opts) {
  return request(url, opts).then(function (r) { return r.text(); });
}

function fetchJson(url, opts) {
  return request(url, opts).then(function (r) { return r.json(); });
}

// A file's size in bytes, from its own Content-Length header, or null.
//
// Only ever called for a stream that is about to be returned, never once per
// file in a listing - these are extra round trips to a second host, and a host
// that has gone quiet has to cost this provider the size and nothing else.
function contentLength(url) {
  return request(url, { method: "HEAD" })
    .then(function (r) {
      var n = parseInt(r.headers.get("content-length") || "0", 10);
      return n > 0 ? n : null;
    })
    .catch(function () { return null; });
}


// ======================================================================
// TMDB: turn the id Nuvio hands us back into name/year
// ======================================================================
//
// Stremio passes an IMDb id and the Stremio build reads Cinemeta.  Nuvio passes
// a TMDB id and injects the key as TMDB_API_KEY, so this is the one place the
// two builds genuinely diverge - everything downstream matches on a title
// either way.

var _metaCache = {};

function mediaMeta(tmdbId, mediaType) {
  var kind = mediaType === "tv" ? "tv" : "movie";
  var key = kind + ":" + tmdbId;
  if (Object.prototype.hasOwnProperty.call(_metaCache, key)) {
    return Promise.resolve(_metaCache[key]);
  }

  var apiKey = typeof TMDB_API_KEY === "string" ? TMDB_API_KEY : "";
  if (!apiKey) {
    // Said out loud because a plugin's failure is silent by design: anything
    // thrown becomes an empty list, which is indistinguishable from a title
    // the sites simply do not have.
    console.error("[bdix] no TMDB api key - set one in Nuvio's settings");
    return Promise.resolve(null);
  }

  var url = TMDB + "/" + kind + "/" + encodeURIComponent(tmdbId) +
    "?api_key=" + encodeURIComponent(apiKey);

  return fetchJson(url).then(function (d) {
    if (!d) return null;
    var meta = {
      name: kind === "tv" ? (d.name || "") : (d.title || ""),
      year: intYear(kind === "tv" ? d.first_air_date : d.release_date),
      kind: kind,
      // Excluding season 0 (specials), because what this decides is whether
      // the season numbers a site files by are TMDB seasons at all - see the
      // arc folders in dflix.
      seasons: kind === "tv"
        ? (d.seasons || []).filter(function (s) { return s.season_number > 0; }).length
        : 0,
    };
    _metaCache[key] = meta;
    return meta;
  }).catch(function () { return null; });
}


// ======================================================================
// Years
// ======================================================================

function intYear(v) {
  if (typeof v === "number" && isFinite(v) && v > 1900) return Math.floor(v);
  // Anchored: Python's re.match only looks at the start, so "released 1995
  // maybe" is not a year and a date string "2014-11-07" is.
  var m = /^(\d{4})/.exec(String(v === null || v === undefined ? "" : v));
  return m ? parseInt(m[1], 10) : null;
}


// ======================================================================
// Title matching
// ======================================================================

var _ASIDE = /\([^)]*\)/g;

// Lowercased, punctuation-free comparison form of a title.
//
// Parenthesised asides go with the punctuation, because they are the *site's*
// annotations rather than part of the title - a year, "(US)", "(TV Series)",
// "(Hindi Dubbed)" - and leaving them in makes the site's "Breaking Bad (TV
// Series)" only a partial match for TMDB's "Breaking Bad", which is the same
// work recorded with a note attached.
function norm(s) {
  return String(s === null || s === undefined ? "" : s)
    .toLowerCase()
    .replace(_ASIDE, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Words that carry none of a title's identity.  Two titles sharing only these
// have not been shown to be the same work, whatever their spelling looks like.
var STOP_WORDS = {};
["the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with",
 "at", "by", "as", "is", "be", "it", "its", "from", "that", "this"
].forEach(function (w) { STOP_WORDS[w] = true; });

// The first word of a title that carries any of its identity.
//
// It is the word a work is filed under.  A library that shortens a name keeps
// the front of it - "Dune" for "Dune: Part One" - and one that means a
// different work changes it: "Fear Street Part One" is not "Dune: Part One",
// and "Demon City" is not "KPop Demon Hunters", however alike the rest looks.
function headWord(s) {
  var words = norm(s).split(" ").filter(function (w) {
    return w && !STOP_WORDS[w];
  });
  return words.length ? words[0] : null;
}


// ---- difflib.SequenceMatcher ------------------------------------------
//
// Ported faithfully rather than substituted.  similar() reaches for this only
// when two names share a head word and neither contains the other - exactly the
// near-miss spellings the matcher exists to judge - and a lookalike metric
// (Levenshtein, or a token overlap) would score those differently and move
// titles across MATCH_FLOOR.  That would not fail loudly; it would quietly
// change which film a request returns.
//
// Only the parts ratio() needs are here.  isjunk is never supplied, so the junk
// machinery is absent; autojunk is kept, though it can only engage on a string
// of 200 characters or more and these are titles.

function SequenceMatcher(a, b) {
  this.a = a;
  this.b = b;
  this.b2j = null;
  this.matchingBlocks = null;
}

SequenceMatcher.prototype._chainB = function () {
  var b = this.b;
  var b2j = new Map();
  for (var i = 0; i < b.length; i++) {
    var elt = b[i];
    if (!b2j.has(elt)) b2j.set(elt, []);
    b2j.get(elt).push(i);
  }

  // autojunk: elements appearing in more than 1% of b (minimum 200 chars) are
  // dropped.  Unreachable for a title, kept so the port stays a port.
  var n = b.length;
  if (n >= 200) {
    var ntest = Math.floor(n / 100) + 1;
    var popular = [];
    b2j.forEach(function (idxs, elt) {
      if (idxs.length > ntest) popular.push(elt);
    });
    popular.forEach(function (elt) { b2j.delete(elt); });
  }

  this.b2j = b2j;
};

SequenceMatcher.prototype._findLongestMatch = function (alo, ahi, blo, bhi) {
  var a = this.a, b = this.b, b2j = this.b2j;
  var besti = alo, bestj = blo, bestsize = 0;
  var j2len = new Map();

  for (var i = alo; i < ahi; i++) {
    var newj2len = new Map();
    var indices = b2j.get(a[i]);
    if (indices) {
      for (var x = 0; x < indices.length; x++) {
        var j = indices[x];
        if (j < blo) continue;
        if (j >= bhi) break;
        var k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }

  while (besti > alo && bestj > blo &&
         a[besti - 1] === b[bestj - 1]) {
    besti--; bestj--; bestsize++;
  }
  while (besti + bestsize < ahi && bestj + bestsize < bhi &&
         a[besti + bestsize] === b[bestj + bestsize]) {
    bestsize++;
  }

  return [besti, bestj, bestsize];
};

SequenceMatcher.prototype.getMatchingBlocks = function () {
  if (this.matchingBlocks !== null) return this.matchingBlocks;
  // difflib builds b2j lazily behind a property; here it is explicit, and this
  // is the only door in.
  if (this.b2j === null) this._chainB();

  var la = this.a.length, lb = this.b.length;
  // A stack, popped from the end, left range pushed before right - the order
  // matters, because it decides how ties inside find_longest_match decompose.
  var queue = [[0, la, 0, lb]];
  var blocks = [];

  while (queue.length) {
    var range = queue.pop();
    var alo = range[0], ahi = range[1], blo = range[2], bhi = range[3];
    var m = this._findLongestMatch(alo, ahi, blo, bhi);
    var i = m[0], j = m[1], k = m[2];
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }

  blocks.sort(function (x, y) {
    return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);
  });

  var out = [];
  var i1 = 0, j1 = 0, k1 = 0;
  for (var n = 0; n < blocks.length; n++) {
    var b = blocks[n];
    if (i1 + k1 === b[0] && j1 + k1 === b[1]) {
      k1 += b[2];
    } else {
      if (k1) out.push([i1, j1, k1]);
      i1 = b[0]; j1 = b[1]; k1 = b[2];
    }
  }
  if (k1) out.push([i1, j1, k1]);
  out.push([la, lb, 0]);

  this.matchingBlocks = out;
  return out;
};

SequenceMatcher.prototype.ratio = function () {
  var blocks = this.getMatchingBlocks();
  var matches = 0;
  for (var i = 0; i < blocks.length; i++) matches += blocks[i][2];
  var total = this.a.length + this.b.length;
  return total ? (2.0 * matches) / total : 1.0;
};

function seqRatio(a, b) {
  return new SequenceMatcher(a, b).ratio();
}


// ---- the matcher proper ------------------------------------------------

// How alike two names are; 0.0 when they are not the same work at all.
//
// Ordered by how strong the evidence is, because the *shape* of a partial
// match is what decides its meaning:
//
//   * equal names are the same work;
//   * the site's name being part of the wanted one is the site filing it
//     short, which these libraries do constantly;
//   * the wanted name sitting *inside* the site's is how an international
//     title travels inside a release title - "It Ends" inside "Soneriada 4:
//     It Ends Now" - so that is the same work, and the year still has to
//     agree;
//   * but the wanted name being the *front* of the site's means the site went
//     on from it, and going on is naming something else: a sequel, a subtitle,
//     a longer name.  "It Ends with Us" is not "It Ends", and "Avatar: Fire
//     and Ash" is not "Avatar".  Nothing may follow but the site's own
//     annotations, a stop word or the year;
//   * a name made only of digits has nothing else to be told apart by, so a
//     name that continues it is a longer number rather than this title written
//     long: "$9.99" normalises to "9 99", whose tail is a digit and so reads as
//     an annotation, and a request for "9" (2009) played it;
//   * anything left is judged on the letters, but only between names that
//     agree on their first real word.
function similar(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0.0;
  if (a === b) return 1.0;
  if (/^\d+$/.test(a)) return 0.0;
  if (a.indexOf(b) >= 0) return 0.9;              // the site filed it short
  if (b.indexOf(a) >= 0) {
    if (b.indexOf(a) !== 0) return 0.9;           // wanted title inside a longer one
    var added = b.slice(a.length).split(" ").filter(function (w) {
      return w && !STOP_WORDS[w] && !/^\d+$/.test(w);
    });
    return added.length ? 0.0 : 0.9;
  }
  if (headWord(a) !== headWord(b)) return 0.0;
  return seqRatio(a, b);
}

function yearBonus(gap) {
  return ({ 0: 0.30, 1: 0.25, 2: 0.18, 3: 0.10, 4: 0.04 })[gap] || 0.0;
}

var MATCH_FLOOR = 0.5;      // below this the titles aren't the same work at all
var YEAR_TOLERANCE = 1;     // site year vs source year may legitimately differ
var YEARLESS_FLOOR = 0.9;   // ... and a name with no year has to carry it alone

// Score a candidate title against the wanted one, null if it cannot be it.
//
// Name similarity alone is not enough.  It is only a *gate*, and yearBonus only
// ever rewards a close year, so an exact-title match from any year used to
// score full marks - asking for the 2026 "Mayday" returned the 2019 post that
// is also called exactly "Mayday".
//
// So when both years are known they must agree within YEAR_TOLERANCE.  That
// tolerance is for one work recorded differently, so it is only spent on a name
// that agrees outright: a name which merely *contains* the wanted one is a
// different work often enough to matter, so a differing year needs an exact
// name match.
//
// When either year is missing there is nothing to weigh the name against, so
// the name has to carry the match by itself.  similar() returns 0.9 for a title
// the site filed short and 1.0 for the same name, and the band below that is
// only lookalike-but-different works: every pair in the test corpus scoring
// 0.5..0.9 is two different titles.  "Dragon Ball Super" against the yearless
// folder "Dragon Ball Z" scores 0.8, and accepting that played the wrong series
// for every episode.
function matchScore(name, year, otherName, otherYear) {
  var sim = similar(name, otherName);
  if (sim < MATCH_FLOOR) return null;
  var y = intYear(year), oy = intYear(otherYear);
  if (!(y && oy)) return sim >= YEARLESS_FLOOR ? sim : null;
  var gap = Math.abs(y - oy);
  if (gap > YEAR_TOLERANCE || (gap && sim < 1.0)) return null;
  return sim + yearBonus(gap);
}


// ======================================================================
// Episode and quality markers
// ======================================================================

// Sites write season/episode markers in several shapes for the same show -
// "S01E02", "S:1E:1", "S6.E0" - so allow an optional separator in each slot.
// Missing one is not harmless: the caller falls back to the position in the
// list, which silently shifts every episode when the site lists an E00 first.
var _SEASON_EP = /s\s*[:.]?\s*(\d+)\s*[:.]?\s*e\s*[:.]?\s*(\d+)/i;

// [season, episode] from a title, or [null, null] when it has none.
//
// Episode 0 is a real number (specials are listed as E00), so callers must test
// the result against null rather than for truthiness.
function episodeMarker(text) {
  var m = _SEASON_EP.exec(String(text === null || text === undefined ? "" : text));
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  return [null, null];
}

// "S01E02" - the marker every provider puts on an episode row.  Shared so the
// six cannot drift into writing it five different ways.
function episodeTag(season, episode) {
  return "S" + String(season).padStart(2, "0") +
         "E" + String(episode).padStart(2, "0");
}

var _QUALITY_RANK = { "2160p": 6, "4k": 6, "1080p": 5, "720p": 4,
                      "480p": 3, "360p": 2, "240p": 1 };

var _QUALITY_RE = /(2160p|4k|1080p|720p|480p|360p|240p)/i;

// The quality tag in a title, lowercased, or "" when it carries none.
function qualityTag(text) {
  var m = _QUALITY_RE.exec(String(text === null || text === undefined ? "" : text));
  return m ? m[1].toLowerCase() : "";
}

// Rank a stream by the quality tag in its title (0 when unknown).
function qualityScore(text) {
  return _QUALITY_RANK[qualityTag(text)] || 0;
}


// ======================================================================
// Sizes
// ======================================================================

// A byte count as "1.4 GB", or "" when there is nothing to show.
//
// Binary units, because that is what these libraries mean when they name a file
// 700MB: the ctgmovies entry whose URL ends "700MB.MkvCage" is 736,160,525
// bytes, which is 702 MiB and would be 736 MB in decimal units - so reading it
// in decimal would print a number that contradicts the filename printed right
// beside it.
function sizeText(n) {
  n = typeof n === "string" ? parseInt(n, 10) : n;
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return "";
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + " GB";
  if (n >= 1048576) {
    var mb = n / 1048576;
    // 1023.6 MB rounds to "1024 MB", which is not a unit anyone writes.
    if (mb >= 1023.5) return (n / 1073741824).toFixed(1) + " GB";
    return Math.round(mb) + " MB";
  }
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

// h5ai divides by 1000 and still calls the result KB, so a listing's own number
// is brought back to bytes to be handed to sizeText() with everything else's.
var _SIZE_UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };


// ======================================================================
// Media files
// ======================================================================

var VIDEO_EXTS = { ".mkv": 1, ".mp4": 1, ".avi": 1, ".webm": 1, ".mov": 1,
                   ".ts": 1, ".m4v": 1, ".flv": 1, ".wmv": 1, ".mpeg": 1,
                   ".mpg": 1, ".m3u8": 1 };

// Lowercased extension of a path or URL, query and fragment dropped.
function fileExt(url) {
  if (!url) return "";
  var path = String(url).split("?")[0].split("#")[0].replace(/\/+$/, "");
  var slash = path.lastIndexOf("/");
  var base = slash >= 0 ? path.slice(slash + 1) : path;
  var dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function isVideo(url) {
  return VIDEO_EXTS[fileExt(url)] === 1;
}


// ======================================================================
// Small URL/text helpers
// ======================================================================
//
// Deliberately not the runtime's URL polyfill: this has to behave identically
// under Node for the tests, and the polyfill's relative-path handling is its
// own thing.

function hostOf(url) {
  var m = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]+)/i.exec(String(url || ""));
  return m ? m[1] : "";
}

// re.findall for a global regex, as match objects rather than strings, so
// callers can reach every group.  lastIndex is reset first: these patterns are
// module-level constants, and leaving it set is how a /g regex silently skips
// matches on the next call.
function findAll(re, text) {
  re.lastIndex = 0;
  var out = [], m;
  while ((m = re.exec(text)) !== null) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex++;   // zero-length match guard
  }
  return out;
}

function urlJoin(base, rel) {
  rel = String(rel === null || rel === undefined ? "" : rel);
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return rel;                 // absolute
  var m = /^([a-z][a-z0-9+.-]*:\/\/[^\/?#]*)/i.exec(String(base || ""));
  var origin = m ? m[1] : "";
  if (rel.slice(0, 2) === "//") {
    return (origin.split(":")[0] || "http") + ":" + rel;
  }
  if (rel.charAt(0) === "/") return origin + rel;
  var cut = String(base || "").replace(/[?#].*$/, "").replace(/\/[^\/]*$/, "/");
  return cut + rel;
}

// urllib.parse.quote, near enough.  Two differences from encodeURIComponent,
// both to match Python: it leaves !'()* alone where Python encodes them, and it
// encodes the slash where Python's default `safe='/'` does not.  The slash is
// the one that shows up - these titles are full of "Face/Off" and "9/11" - and
// a path segment is where the results land, so it has to be spelled the way the
// site spells it.
function quote(s) {
  return String(s === null || s === undefined ? "" : s)
    .split("/")
    .map(function (part) {
      return encodeURIComponent(part).replace(/[!'()*]/g, function (c) {
        return "%" + c.charCodeAt(0).toString(16).toUpperCase();
      });
    })
    .join("/");
}

// urllib.parse.urlencode, for a form POST: quote_plus, which is quote() with
// safe='' - so the slash IS escaped here, unlike in the query values above -
// and a space written as "+" rather than "%20".
function formEncode(fields) {
  return Object.keys(fields).map(function (k) {
    return _plus(k) + "=" + _plus(fields[k]);
  }).join("&");
}

function _plus(s) {
  return encodeURIComponent(String(s === null || s === undefined ? "" : s))
    .replace(/[!'()*]/g, function (c) {
      return "%" + c.charCodeAt(0).toString(16).toUpperCase();
    })
    .replace(/%20/g, "+");
}

// urllib.parse.unquote, including its leniency: decodeURIComponent throws on a
// stray percent sign, and a listing that writes a bare "%" in a file name is
// not a reason to lose the file.
function unquote(s) {
  var text = String(s === null || s === undefined ? "" : s);
  try {
    return decodeURIComponent(text);
  } catch (e) {
    return text.replace(/%([0-9a-fA-F]{2})/g, function (_m, h) {
      return String.fromCharCode(parseInt(h, 16));
    });
  }
}

// Python's html.unescape, for the entities these listings actually write.
// &amp; is last so that "&amp;lt;" ends up as "&lt;" rather than "<".
function unescapeHtml(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, function (_m, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&amp;/g, "&");
}


// ======================================================================
// Reading a library's name for a title
// ======================================================================

var _YEAR_ANY = /(?:19|20)\d{2}/;

// "Fight Club (1999) (4K)" -> ["Fight Club", 1999].
//
// Splitting is required, not cosmetic.  norm() strips a parenthesised aside and
// nothing else, so that label normalises to "fight club 4k" - the wanted title
// *plus* a word, which is the case similar() scores 0.0, since a library that
// goes on from a name is naming something else.  These libraries hang a
// quality, a language cut or a series marker off nearly every folder they file,
// so matching a raw label would reject almost everything there is.  The bare
// title matches.
//
// The title is everything before the first parenthesised group holding a year,
// so an aside that is not one ("Foo (US) (1995) 720p") stays where it belongs
// and norm() drops it later.
//
// Shared by dhakaflix and iccftp, which carry it verbatim in Python too - it
// reads a naming convention rather than a site.
function splitLabel(label) {
  var text = String(label === null || label === undefined ? "" : label).trim();
  var re = /\(([^)]*)\)/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    var year = _YEAR_ANY.exec(m[1]);
    if (year) return [text.slice(0, m.index).trim(), parseInt(year[0], 10)];
  }
  return [text, null];
}


// ======================================================================
// Next.js RSC flight payloads
// ======================================================================
//
// A Next.js App Router page streams its data as a run of
// self.__next_f.push([1,"<escaped chunk>"]) calls.  Joining the chunks and
// unescaping them turns the page back into its payload as plain text, so a
// source can read a server-rendered React page without a browser and without a
// private JSON API that may not exist.

var _FLIGHT_PUSH = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

// Unescaped concatenated RSC flight text from SSR HTML.
function decodeFlight(html) {
  _FLIGHT_PUSH.lastIndex = 0;
  var chunks = [];
  var m;
  while ((m = _FLIGHT_PUSH.exec(String(html || ""))) !== null) chunks.push(m[1]);
  return JSON.parse('"' + chunks.join("") + '"');
}

// End index (exclusive) of the balanced literal starting at text[i].
//
// Scanned string-aware: a bracket inside a quoted string is not a bracket,
// which matters here because these payloads are full of prose that contains
// braces and quotes.  Returns null if the literal never closes.
function matchBalanced(text, i, openCh, closeCh) {
  var depth = 0, inStr = false, esc = false;
  for (var j = i; j < text.length; j++) {
    var c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === openCh) depth++;
      else if (c === closeCh) {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
  }
  return null;
}

// The first JSON value following "key": in the flight text, or null.
//
// The first, because a page repeats a key once per record - an episode list
// carries a "links" array for every episode - and the caller wants the one it
// asked for.
function jsonAfter(text, key) {
  var re = new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"\\s*:\\s*');
  var m = re.exec(text);
  if (!m) return null;
  var i = m.index + m[0].length;
  if (i >= text.length || (text[i] !== "{" && text[i] !== "[")) return null;
  var end = matchBalanced(text, i, text[i], text[i] === "{" ? "}" : "]");
  if (end === null) return null;
  try { return JSON.parse(text.slice(i, end)); } catch (e) { return null; }
}

// Every balanced array after each occurrence of "key":.
function arraysAfterKey(text, key) {
  var out = [];
  var marker = '"' + key + '":';
  var start = 0;
  while (true) {
    var pos = text.indexOf(marker, start);
    if (pos < 0) break;
    start = pos + 1;
    var open = pos + marker.length;
    if (text[open] !== "[") continue;
    var end = matchBalanced(text, open, "[", "]");
    if (end === null) continue;
    try {
      var val = JSON.parse(text.slice(open, end));
      if (Array.isArray(val)) out.push(val);
    } catch (e) { /* a payload that will not parse is not a payload */ }
  }
  return out;
}


// ======================================================================
// Stream objects
// ======================================================================
//
// Nuvio's fields are its own, and they are not Stremio's: `title` is the
// primary line and `name` the secondary, where Stremio draws `name` on top.
// `quality` and `size` are also first-class here rather than text packed into a
// heading, so they are set as fields *and* kept in `name` - Nuvio renders the
// fields, and a client that ignores them still gets a readable row.
//
// There is no bingeGroup: Nuvio's result model has no such field, so emitting
// one would be dead weight.

function stream(url, label, opts) {
  opts = opts || {};
  var quality = opts.quality || "";
  var size = sizeText(opts.size);

  var head = [label, quality, size].filter(Boolean).join("  ");
  var line = [opts.media || "", opts.marker || "", opts.note || ""]
    .filter(Boolean).join("  ");

  var out = { url: url, name: head, title: line || head, provider: opts.provider || "" };
  if (quality) out.quality = quality;
  if (size) out.size = size;
  return out;
}

// "Title (Year)" - the media label Nuvio shows for a stream row.
function mediaLabel(name, year) {
  if (!name) return "";
  return year ? name + " (" + year + ")" : name;
}
