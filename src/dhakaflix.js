// DhakaFlix - the DhakaFlix hosts' specifics, and nothing else.
//
// This is not a search site like the others: it is an h5ai v0.29 file index
// spread over several hosts, and h5ai has no server-side search at all - it
// answers ERR_UNSUPPORTED when asked for one.  So a lookup cannot ask a
// question.  It walks the tree instead: list a category, match the folder whose
// name is the title, descend into it, take the video file.
//
// What makes that work without a browser is that h5ai renders a plain <table>
// of <a href> rows into <div id="fallback"> for clients that do not run
// JavaScript.  That table is the whole interface read here; nothing depends on
// the JS app or on h5ai's own JSON API, which wants a setup token the front end
// never hands out.
//
// Three folder layouts are in play, so every category declares its own shape:
//     year   English Movies/(1995)/<Title (1995) 720p>/<file>.mkv
//     flat   Animation Movies (1080p)/<Title (2012) 1080p>/<file>.mkv
//     all    Foreign Language Movies/<Language>/<Title (1973)>/<file>.mkv
//
// The hosts answer only from the network they sit on, so off that network this
// provider contributes nothing.  Nuvio runs providers concurrently and each
// one's failure is its own, so the other five are unaffected either way.

var KEY = "dhakaflix";
var LABEL = "DhakaFlix";

// Per request.  The hosts are on the same network as the caller, so a request
// that takes seconds is a host that is not answering.
var TIMEOUT = 6000;

// For the whole lookup.
//
// Python budgeted 8s because the *server* gave a source ten, and the ten
// category listings were fetched one after another.  Nuvio gives a plugin sixty
// and runs the categories at once, so the budget here is only a backstop
// against a host that answers slowly rather than not at all - the parallel walk
// is where the time actually came from.
var BUDGET = 45000;

// key, shape, kind, base url.  The ten shelves this provider covers, and
// nothing else on the site - the games, software and documentary shelves are
// not something a player will ever ask this addon for.
var CATEGORIES = [
  { key: "english", shape: "year", kind: "movie",
    url: "http://172.16.50.7/DHAKA-FLIX-7/English%20Movies/" },
  { key: "english1080", shape: "year", kind: "movie",
    url: "http://172.16.50.14/DHAKA-FLIX-14/English%20Movies%20%281080p%29/" },
  { key: "foreign", shape: "all", kind: "movie",
    url: "http://172.16.50.7/DHAKA-FLIX-7/Foreign%20Language%20Movies/" },
  { key: "hindi", shape: "year", kind: "movie",
    url: "http://172.16.50.14/DHAKA-FLIX-14/Hindi%20Movies/" },
  { key: "southdub", shape: "year", kind: "movie",
    url: "http://172.16.50.14/DHAKA-FLIX-14/SOUTH%20INDIAN%20MOVIES/Hindi%20Dubbed/" },
  { key: "south", shape: "year", kind: "movie",
    url: "http://172.16.50.14/DHAKA-FLIX-14/SOUTH%20INDIAN%20MOVIES/South%20Movies/" },
  { key: "animation", shape: "year", kind: "movie",
    url: "http://172.16.50.14/DHAKA-FLIX-14/Animation%20Movies/" },
  { key: "animation1080", shape: "flat", kind: "movie",
    url: "http://172.16.50.14/DHAKA-FLIX-14/Animation%20Movies%20%281080p%29/" },
  { key: "tv", shape: "all", kind: "series",
    url: "http://172.16.50.12/DHAKA-FLIX-12/TV-WEB-Series/" },
  { key: "korean", shape: "flat", kind: "series",
    url: "http://172.16.50.14/DHAKA-FLIX-14/KOREAN%20TV%20%26%20WEB%20Series/" },
];


// ---- reading a listing --------------------------------------------------

// Scoped to the fallback block rather than the whole document: the page head
// carries its own <link> elements, and a whole-document scan reads those as
// entries.  There are no nested divs inside that block, so the first </div>
// closes it.
var _FALLBACK = /<div id="fallback">([\s\S]*?)<\/div>/;
var _ROW = /<tr>([\s\S]*?)<\/tr>/g;
var _LINK = /<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/;
var _TAGS = /<[^>]+>/g;

// The table's last cell, which is where the listing writes a file's size.  The
// unit is a thousand bytes whatever the letter says: h5ai divides by 1000 and
// still calls the result KB, and the files confirm it rather than the other way
// round - the 12 Monkeys encode is listed as 1214810 KB and answers a HEAD with
// a Content-Length of exactly 1214810 * 1000.  Reading it as 1024 would put
// every size here 2.4% above the same file's size in the other providers, and
// these rows are read side by side with theirs, so the number is brought back
// to bytes and handed to the same sizeText() they use.
var _SIZE_CELL = /<td class="fb-s">([\s\S]*?)<\/td>/;
var _SIZE = /([\d.]+)\s*(B|KB|MB|GB|TB)/i;

// The byte count in one row's size cell, or null.
//
// A folder's cell is there but empty, so an empty cell is the normal answer
// rather than a fault.  A unit not in the table is refused instead of guessed
// at: a size is one of the two things a person weighs two rows against each
// other on, and a wrong one is worse than a missing one.
function _sizeOf(row) {
  var cell = _SIZE_CELL.exec(row);
  if (!cell) return null;
  var got = _SIZE.exec(cell[1].replace(_TAGS, "").trim());
  if (!got) return null;
  var unit = _SIZE_UNITS[got[2].toUpperCase()];
  if (unit === undefined) return null;
  return Math.trunc(parseFloat(got[1]) * unit) || null;
}

// [{label, url, isDir, size}] for one directory.
//
// The hrefs arrive root-relative and already percent-encoded, so joining them
// to the listing's own url rebuilds an absolute one without any guesswork about
// encoding - which matters, because these names carry stars, hearts, em dashes
// and apostrophes.
//
// `size` is the file's byte count and is null for a folder and for anything the
// size cell does not spell out; see _sizeOf.  Reading it costs nothing extra -
// it is in the same table, in the same request that names the file.
async function _listing(url) {
  var html = await fetchText(url, { timeout: TIMEOUT });
  var block = _FALLBACK.exec(html);
  if (!block) return [];

  var out = [];
  findAll(_ROW, block[1]).forEach(function (m) {
    var row = m[1];
    var link = _LINK.exec(row);
    if (!link) return;
    var label = unescapeHtml(link[2].replace(_TAGS, "")).trim();
    if (!label || label === "Parent Directory") return;
    out.push({
      label: label,
      url: urlJoin(url, link[1]),
      isDir: row.indexOf("folder.png") >= 0,
      size: _sizeOf(row),
    });
  });
  return out;
}


// ---- reading a name -----------------------------------------------------

var _YEAR_ALL = /(?:19|20)\d{2}/g;
var _BEFORE = /\bbefore\b/i;

// Does a year bucket hold `year`?  Buckets are written five ways.
//
// "(1995)", "(1995) 1080p", "(1995) & Before", "2000 & Before" (no
// parentheses) and "(1960-1994)" all appear, so the range is read out of the
// label rather than assumed from its shape.
function _covers(label, year) {
  var found = findAll(_YEAR_ALL, label || "").map(function (m) {
    return parseInt(m[0], 10);
  });
  if (!found.length) return false;
  var lo = Math.min.apply(null, found), hi = Math.max.apply(null, found);
  if (_BEFORE.test(label)) return year <= hi;
  if (found.length > 1) return lo <= year && year <= hi;
  return year === found[0];
}

// Trailers on a title: the words this site hangs off the first entry of a
// series, which the real title does not carry.  "Back to the Future I" is the
// 1985 film; "SAW I" is "Saw".
var _SERIES_TAIL = new Set([
  "part", "pt", "vol", "volume", "chapter", "chap", "episode", "ep",
  "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii",
]);

// `title` with a trailing series marker removed, or null if it has none.
//
// Only a marker, and only from the end, so "Gangs of Wasseypur II" gives
// "gangs of wasseypur" while "American History X" is left alone to match on its
// own name - it is the real title, and the direct pass finds it.
function _bareTitle(title) {
  var words = norm(title).split(" ").filter(Boolean);
  var kept = words.slice();
  while (kept.length && _SERIES_TAIL.has(kept[kept.length - 1])) kept.pop();
  if (!kept.length || kept.length === words.length) return null;
  return kept.join(" ");
}


// ---- walking the tree ---------------------------------------------------

// Every listing that could hold the wanted title.
//
// `flat` is the category itself.  `year` narrows to the buckets covering
// year-1..year+1 - that window is the one matchScore already allows for between
// the site's year and TMDB's, and allowing it there is no use if the folder
// turns out to sit in the bucket next door.  `all` searches every group, which
// is a language under Foreign and a letter range under TV.
async function _titleListings(base, shape, year, deadline) {
  if (shape === "flat") return [await _listing(base)];

  var groups = await _listing(base);
  var chosen;
  if (shape === "year") {
    if (year == null) return [];
    chosen = groups.filter(function (g) {
      return g.isDir && [year - 1, year, year + 1].some(function (y) {
        return _covers(g.label, y);
      });
    });
  } else {
    chosen = groups.filter(function (g) { return g.isDir; });
  }

  var out = [];
  for (var i = 0; i < chosen.length; i++) {
    if (Date.now() > deadline) break;
    try {
      out.push(await _listing(chosen[i].url));
    } catch (e) {
      // One dead group is not a dead shelf.
    }
  }
  return out;
}

// [url, label] of the folder naming this work, or [null, null].
//
// Two passes.  The first is matchScore on the split label, the same call every
// other provider makes.  The second exists because this site hangs a series
// marker on the first entry of a series: the folder for the 1985 film is "Back
// to the Future I", and similar() reads a site name that goes on from the
// wanted one as naming something else - correctly, since that is what "It Ends
// with Us" is to "It Ends".  So a request for "Back to the Future" matches
// nothing at all and the film is simply missing.
//
// The second pass relaxes exactly that one word, and is kept narrow enough not
// to reopen the hole the first one closes:
//
//   * the folder's title must be the wanted one *exactly* once the marker is
//     off - not merely similar;
//   * the years must be equal, not merely within a year, so a request for "Saw"
//     (2004) cannot take "SAW II" (2005);
//   * and it must be the only folder in the category that qualifies.  That last
//     one is not paranoia: "Gangs of Wasseypur I" and "... II" are both filed
//     under 2012 in Hindi Movies, and without it a request for the first film
//     would take whichever the listing happened to put first.  Ambiguity
//     returns nothing, the way it did before.
//
// The relaxed pass is consulted only when the first finds nothing, so a title
// that matches today cannot start matching differently.
function _bestTitle(listings, name, year) {
  var direct = [], relaxed = [], want = norm(name);

  listings.forEach(function (entries) {
    entries.forEach(function (e) {
      if (!e.isDir) return;
      var got = splitLabel(e.label);
      var title = got[0], titleYear = got[1];

      var score = matchScore(name, year, title, titleYear);
      if (score !== null) {
        direct.push([score, e.url, e.label]);
        return;
      }

      var bare = _bareTitle(title);
      if (bare === null || norm(bare) !== want || !year || titleYear !== year) return;
      relaxed.push([e.url, e.label]);
    });
  });

  if (direct.length) {
    // Python's max() over (score, url, label) tuples, ties and all.
    direct.sort(function (a, b) {
      if (a[0] !== b[0]) return a[0] - b[0];
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
      if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
      return 0;
    });
    var top = direct[direct.length - 1];
    return [top[1], top[2]];
  }
  if (relaxed.length === 1) return relaxed[0];
  return [null, null];
}


// ---- streams ------------------------------------------------------------

// Up to three encodes from the film's folder, best quality first.
//
// A folder often holds several - 3 Idiots carries an x265 and an x264 - and
// they are genuinely different files, so more than one is worth offering.  The
// cap is the one the other providers use.
async function _movieStreams(url, label, media) {
  var quality = qualityTag(label);
  var found = (await _listing(url)).filter(function (e) {
    return !e.isDir && isVideo(e.url);
  }).map(function (e) {
    return [qualityTag(e.label) || quality, e.url, e.size];
  });

  found.sort(function (a, b) { return qualityScore(b[0]) - qualityScore(a[0]); });
  return found.slice(0, 3).map(function (f) {
    return stream(f[1], LABEL, {
      quality: f[0], size: f[2], media: media, provider: KEY,
    });
  });
}

var _SEASON_DIR = /season\s*0*(\d+)/i;

async function _seriesStreams(url, label, media, season, episode) {
  var entries = await _listing(url);
  var quality = qualityTag(label);
  var marker = episodeTag(season, episode);

  var seasonUrls = entries.filter(function (e) {
    if (!e.isDir) return false;
    var m = _SEASON_DIR.exec(e.label);
    return m && parseInt(m[1], 10) === season;
  }).map(function (e) { return e.url; });

  // Some shows keep their episodes loose in the show folder instead of under a
  // season.  The episode marker still identifies them.
  var groups = seasonUrls.length
    ? await Promise.all(seasonUrls.map(function (u) { return _listing(u); }))
    : [entries];

  var out = [];
  groups.forEach(function (files) {
    files.forEach(function (e) {
      if (e.isDir || !isVideo(e.url)) return;
      var m = episodeMarker(e.label);
      if (m[0] !== season || m[1] !== episode) return;
      out.push(stream(e.url, LABEL, {
        quality: qualityTag(e.label) || quality,
        marker: marker,
        size: e.size,
        media: media,
        provider: KEY,
      }));
    });
  });
  return out;
}


// ---- contract -----------------------------------------------------------

async function getStreams(tmdbId, mediaType, season, episode) {
  var meta = await mediaMeta(tmdbId, mediaType);
  if (!meta || !meta.name) {
    console.error("[bdix/" + KEY + "] no metadata for tmdb id " + tmdbId);
    return [];
  }
  var name = meta.name, year = meta.year;
  // The one place Nuvio's vocabulary meets this provider's.  Nuvio says "tv";
  // CATEGORIES is tagged "series", which is what the Stremio side called it and
  // what the Python this was ported from matched on.  Translated here, once,
  // rather than by retagging the shelves: everything below this line is the port.
  var kind = mediaType === "tv" ? "series" : "movie";
  if (kind !== "movie" && (season == null || episode == null)) return [];
  var media = mediaLabel(name, year);

  var deadline = Date.now() + BUDGET;
  var shelves = CATEGORIES.filter(function (c) { return c.kind === kind; });
  if (!shelves.length) {
    console.error("[bdix/" + KEY + "] no shelves tagged " + kind);
    return [];
  }

  // Walked together rather than one after another.  Each shelf is independent -
  // its own host, its own tree - so a shelf being slow costs the lookup the time
  // of the slowest one instead of the sum of all ten, and one shelf failing
  // costs the lookup only that shelf.
  var walks = await Promise.all(shelves.map(async function (cat) {
    try {
      var listings = await _titleListings(cat.url, cat.shape, year, deadline);
      var found = _bestTitle(listings, name, year);
      if (!found[0]) return [];
      return kind === "movie"
        ? await _movieStreams(found[0], found[1], media)
        : await _seriesStreams(found[0], found[1], media, season, episode);
    } catch (e) {
      console.error("[bdix/" + KEY + "] shelf " + cat.key + " failed: " + e);
      return [];
    }
  }));

  var streams = [], seen = new Set();
  walks.forEach(function (got) {
    got.forEach(function (s) {
      if (seen.has(s.url)) return;
      seen.add(s.url);
      streams.push(s);
    });
  });
  return streams;
}
