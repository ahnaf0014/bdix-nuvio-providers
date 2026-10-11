// ICC FTP - the 10.16.100.244 dashboard specifics, and nothing else.
//
// ICC FTP is a PHP dashboard in front of eight FTP shares.  Unlike dhakaflix it
// has a search, so a lookup is a handful of small requests instead of a walk:
// fetch the dashboard for its CSRF token, POST a query or two, then open the
// player page of each result that survived matching, for the file urls.
//
// The dashboard has to be reached as `dashboard.php?session=...`.  The bare
// host redirects off-network to the ISP's notice page, and the session
// parameter is what stands between the two: without it the same notice comes
// back from the dashboard as well.  The *value* is not checked - the site
// serves the full dashboard for any number - so SESSION below is a placeholder
// to replace when the real link is settled, and nothing here depends on its
// contents, only on its being present.
//
// The search is a plain substring match over the site's own titles, and it
// stops at twelve results.  That one fact is the whole reason this provider
// runs two queries per lookup instead of one; see _results.
//
// The files themselves sit on whichever share holds them, one host per share,
// so the urls that come back are used exactly as written and never rebuilt from
// BASE.  They answer Range requests with 206 and a byte range, which is what
// lets a player seek in them.
//
// The host answers only from the network it sits on, so off that network this
// provider contributes nothing.  Nuvio runs providers concurrently and each
// one's failure is its own, so the other five are unaffected either way.

var KEY = "iccftp";
var LABEL = "ICC FTP";

var BASE = "http://10.16.100.244";

// Required - the dashboard wants a session parameter and serves only that page
// without one - but not validated: any value gets the same dashboard.  The
// placeholder that was asked for, and the one line to edit when the real link
// is fixed.  A bare host and a bare dashboard.php both redirect away.
var SESSION = "999";

// Per request.  The host is on the same network as the caller, so the whole
// dance measures well under a second and a request that takes seconds is a host
// that is not answering.
var TIMEOUT = 6000;

// For the whole lookup, and only spent on the size requests at the very end.
var BUDGET = 45000;

// A film is one file, so this only ever binds on a title the site files several
// times over - Dune as a 4K and as a 3D, The Exorcist as a 4K and a 1080p - and
// on a season that exists in two language cuts.
var MAX_STREAMS = 3;

// Player pages opened per lookup, before the streams are ranked and cut down to
// MAX_STREAMS.  The two are separate because a lookup can open a page whose
// only file is a different work than the one asked for, and cutting to three
// *before* ranking would let such a page fill the list with the wrong film and
// hide the right one.
var MAX_TARGETS = 6;

// How long one size request may take.  Measured at about a twentieth of a
// second on these shares, so two is already generous - and a share that cannot
// answer a HEAD in that time will not be answering the byte-range requests the
// player is about to make of it either.
var SIZE_TIMEOUT = 2000;


// ---- the three requests -------------------------------------------------

function _dashboard() {
  return BASE + "/dashboard.php?session=" + SESSION;
}

function _get(url, timeout) {
  return fetchText(url, { timeout: timeout || TIMEOUT });
}

// POST one query; the results are in the page that comes back.
async function _search(token, query) {
  var page = await fetchText(_dashboard(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({ token: token, psearch: query }),
    timeout: TIMEOUT,
  });
  return findAll(_ITEM, page).map(function (m) {
    return [m[1], unescapeHtml(m[2]).trim()];
  });
}

// The search token, or null if the dashboard did not carry one.
//
// Fetched once per lookup and reused for both queries.  The POST is not tied to
// the PHPSESSID cookie the dashboard also sets - the same token works from a
// bare request, which is why this provider carries no cookie jar.
async function _token() {
  var m = _TOKEN.exec(await _get(_dashboard()));
  return m ? m[1] : null;
}

// [[media url, label]] on one player page.
//
// The page carries one <source> per file - a film has one, a season has one per
// episode, and each is written out twice, so the urls are deduped - and the
// element's own `title` is the label to use: the encode ("1080p BluRay") for a
// film, the episode ("S03E01") for a series.  Both are read here and sorted out
// by the caller, since the same page shape serves both.
async function _sources(pid) {
  var page = await _get(BASE + "/player.php?session=" + SESSION + "&play=" + pid);
  var out = [], seen = new Set();
  findAll(_SOURCE, page).forEach(function (m) {
    var url = unescapeHtml(m[1]).trim();
    if (seen.has(url) || !isVideo(url)) return;
    seen.add(url);
    out.push([url, unescapeHtml(m[2]).trim()]);
  });
  return out;
}

// The file's size in bytes, from the share's own header, or null.
//
// Nothing on the dashboard records a size: the search row carries a title, a
// hit count and an age, and the player page carries one <source> per file with
// a label and a type and nothing else.  So the only place the number exists is
// the file.
//
// Called once per stream actually returned, after the ranking has cut the list
// down, so it is never one request per file in the library.  Skipped once the
// lookup is out of budget, and on its own short clock otherwise: this is a
// share reached after the dashboard has already answered, so one that has gone
// quiet has to cost this provider the size and nothing else.
function _contentLength(url, deadline) {
  var left = deadline - Date.now();
  if (left <= 0) return Promise.resolve(null);
  return request(url, { method: "HEAD", timeout: Math.min(SIZE_TIMEOUT, left) })
    .then(function (r) {
      var n = parseInt(r.headers.get("content-length") || "0", 10);
      return n > 0 ? n : null;
    })
    .catch(function () { return null; });
}


// ---- reading the results ------------------------------------------------

var _TOKEN = /name="token"\s+value="([^"]+)"/;

// The anchor and its title, matched as one unit so that the many other play=
// ids a dashboard page carries - its own carousels, its "recently added" rows -
// cannot be read as results.  An anchor of this exact shape with an UpdateHits
// call in front of it is a search hit and nothing else is.
var _ITEM = /UpdateHits\('(\d+)','visit'\)"\s+href="player\.php[^"]*">\s*<img[^>]*alt="([^"]*)"/g;

// src, title and type in the order the page writes them.
var _SOURCE = /<source\s+src='([^']+)'\s+title='([^']*)'\s+type='([^']*)'/gi;

// Every result either query form returns, deduped, best form first.
//
// Two forms, because the site stores its titles inconsistently and neither one
// alone finds everything.  The search is a literal substring of the stored
// title, which cuts both ways:
//
//   * "Fight Club (1999)" finds exactly the film.  "Fight Club 1999" finds
//     nothing at all - the year has to be parenthesised to appear in a title -
//     and "Dune 2021" finds nothing for the same reason.
//   * but "3 Idiots (2009)" finds nothing either, because that title is stored
//     *without* a year, and "Interstellar (2014)" and "Oppenheimer (2023)" are
//     the same.  Plain "3 Idiots" finds them.
//
// So both are asked, targeted first and plain second, and the answers are
// unioned.  The order matters because of the second half of the problem: the
// search stops at twelve results, and a short common word reaches the cap on
// noise - "a" and "the" both return exactly twelve - which can crowd the wanted
// title out of the plain form entirely.  The targeted form returns few results
// and returns the right ones, so it goes first and its hits win the dedupe; the
// plain form then adds what it alone can find.
//
// A failed query is skipped rather than fatal: one form coming back empty is
// the normal case for half the titles on the site.
async function _results(token, name, year) {
  var queries = [];
  if (year) queries.push(name + " (" + year + ")");
  queries.push(name);

  var out = [], seen = new Set();
  for (var i = 0; i < queries.length; i++) {
    var rows;
    try {
      rows = await _search(token, queries[i]);
    } catch (e) {
      continue;
    }
    rows.forEach(function (row) {
      if (seen.has(row[0])) return;
      seen.add(row[0]);
      out.push(row);
    });
  }
  return out;
}


// ---- reading a name -----------------------------------------------------

var _SEASON = /\bseason\s*0*(\d+)/i;

// "Breaking Bad Season 03 (2010) Completed" -> ["Breaking Bad", 3, 2010].
//
// Or null when the label names no season - which is how a show filed as one
// folder rather than by season is told apart.
function _splitShow(label) {
  label = label || "";
  var m = _SEASON.exec(label);
  if (!m) return null;
  var show = label.slice(0, m.index).trim();
  if (!show) return null;
  return [show, parseInt(m[1], 10), splitLabel(label)[1]];
}


// ---- choosing what to open ----------------------------------------------

// The best-scoring hits, all of them, or [].
//
// Ties are kept rather than broken, because the same work is filed more than
// once on this site and the matcher scores those copies identically:
// "Chernobyl Season 01 (2019) Completed" and the same season with
// "(Hindi & English)" appended score the same and are two different files, so
// keeping one would hide a real encode.
//
// A *lower* score is not kept, and that is what stops a sequel answering for
// the film asked for: "Toy Story 2" scores 0.9 against "Toy Story" where the
// film itself scores 1.0.  The comparator is the shared one, so a search that
// finds nothing returns nothing.
function _best(hits) {
  if (!hits.length) return [];
  var best = Math.max.apply(null, hits.map(function (h) { return h[0]; }));
  return hits.filter(function (h) {
    return h[0] >= best - 1e-9;
  }).map(function (h) { return [h[1], h[2]]; });
}

function _movieTargets(rows, name, year) {
  var hits = [];
  rows.forEach(function (row) {
    var got = splitLabel(row[1]);
    var score = matchScore(name, year, got[0], got[1]);
    if (score !== null) hits.push([score, row[0], row[1]]);
  });
  return _best(hits);
}

// [[play id, label]] for the requested season, best entry first.
//
// The name is matched with **no year**, which is not an oversight.  TMDB dates
// a series by its first season, but this site puts each season's *own* year in
// the label - Breaking Bad runs 2008, 2009, 2010, 2011, 2012 across five
// folders - and matchScore allows a gap of one.  Passing the show's year would
// therefore reject every season but the first, so a request for season 3 of a
// 2008 show would return nothing.  The season number is what identifies the
// folder; the year is no longer doing any work.
function _seriesTargets(rows, name, season, year) {
  var hits = [];
  rows.forEach(function (row) {
    var got = _splitShow(row[1]);
    if (got === null) return;
    if (got[1] !== season) return;
    var score = matchScore(name, null, got[0], null);
    if (score !== null) hits.push([score, row[0], row[1], got[2]]);
  });

  if (hits.length) {
    // Only reachable when two shows share a name - the US and UK Offices -
    // since every candidate is already the season asked for.  Closest year
    // wins; an entry with no year sorts first on nothing and is left to the
    // order the site gave it.
    if (year != null && hits.length > 1) {
      hits.sort(function (a, b) {
        return (a[3] ? Math.abs(a[3] - year) : 0) - (b[3] ? Math.abs(b[3] - year) : 0);
      });
    }
    return _best(hits);
  }

  return _best(_wholeShow(rows, name));
}

// Entries for a show filed as one folder instead of by season.
//
// "band of brothers (2001)" is the whole series in a single entry, so there is
// no season to pick and the episode has to be found among the files themselves,
// which is what the player page's own labels allow.
//
// Matched on the name exactly rather than by similarity: with no season to
// disambiguate, a near name is a different show, and this pass only runs at all
// once the season pass has found nothing, so it cannot change the answer for a
// show that is filed normally.
function _wholeShow(rows, name) {
  var want = norm(name);
  if (!want) return [];
  var out = [];
  rows.forEach(function (row) {
    if (_SEASON.test(row[1] || "")) return;
    if (norm(splitLabel(row[1])[0]) === want) out.push([1.0, row[0], row[1], null]);
  });
  return out;
}


// ---- streams ------------------------------------------------------------

// How well a file's own name matches, taken from its url, or null.
//
// The last path segment is the better name to judge by, and it is already in
// hand from the same request that produced the stream.  null means the name is
// a different work, or carries a year that rules this one out - both are
// answers, not ignorance, which is what the caller needs to tell apart.
function _fileScore(name, year, url) {
  var base = unquote(url.slice(url.lastIndexOf("/") + 1));
  var got = splitLabel(base.replace(/\.[^.]*$/, ""));
  return matchScore(name, year, got[0], got[1]);
}

// Drop the files that name a different work than the one asked for.
//
// The search row alone cannot always tell two works apart.  The site files the
// 2009 "3 Idiots" as bare "3 Idiots" and the Spanish remake as "3 Idiots
// (3 idiotas)"; norm() strips the aside and reduces both to the same string, so
// both score 1.0 and the rule above keeps them both - rightly, because a tie is
// exactly how two encodes of one film are recognised, and Dune's 4K and 3D have
// to survive that same rule.
//
// The file's own name separates them, and only this can: the remake's url ends
// in "3 idiots (3 idiotas) (2017) 1080p", the film's in "3 idiots (2009) 1080p
// BluRay".  The year the search row dropped is still on the file, so the remake
// is scored against 2017 instead of 2009, fails the year check, and comes back
// as null - which is a rejection, not a gap in the data, and is why null counts
// as worse here rather than as unknown.
//
// Only a lower score drops a file, so a tie keeps every encode.  If nothing
// scores at all, every file is kept: there is then nothing to prefer, and
// losing the only file there is would be the worse mistake.
function _rankMovies(name, year, files) {
  if (files.length < 2) return files;
  var scored = files.map(function (f) {
    return [f, _fileScore(name, year, f[0])];
  });
  var scores = scored.map(function (s) { return s[1]; })
    .filter(function (s) { return s !== null; });
  if (!scores.length) return files;
  var best = Math.max.apply(null, scores);
  return scored.filter(function (s) {
    return s[1] !== null && s[1] >= best - 1e-9;
  }).map(function (s) { return s[0]; });
}

// [season, episode] for a file, read from its name before its label.
//
// The player page's title attribute is not trustworthy on its own: every one of
// the sixteen files in Breaking Bad's season 5 folder is labelled S01E01
// through S01E16 - the season number in the label is simply wrong there - while
// the files underneath are S05E01 through S05E16.  Reading the label alone
// therefore answers nothing for that season at all.
//
// The file name is the real one, so it is asked first and the label is the
// fallback, for a folder whose files are named without a marker.
function _episodeOf(url, label) {
  var base = unquote(url.slice(url.lastIndexOf("/") + 1));
  var got = episodeMarker(base);
  if (got[0] !== null) return got;
  return episodeMarker(label);
}

// One stream, in the shape the other providers use.
//
// The quality is read from the page's label first and the file name second: the
// label is where this site puts the encode for a film ("1080p BluRay") and the
// file name is where it puts it for an episode.
function _stream(url, label, media, kind, season, episode, size) {
  var series = kind !== "movie";
  return stream(url, LABEL, {
    quality: qualityTag(label) || qualityTag(url),
    marker: series ? episodeTag(season, episode) : "",
    size: size,
    media: media,
    provider: KEY,
  });
}


// ---- contract -----------------------------------------------------------

async function getStreams(tmdbId, mediaType, season, episode) {
  var meta = await mediaMeta(tmdbId, mediaType);
  if (!meta || !meta.name) {
    console.error("[bdix/" + KEY + "] no metadata for tmdb id " + tmdbId);
    return [];
  }
  var name = meta.name, year = meta.year;
  var kind = mediaType === "tv" ? "tv" : "movie";
  if (kind === "tv" && (season == null || episode == null)) return [];
  var media = mediaLabel(name, year);
  var deadline = Date.now() + BUDGET;

  var token;
  try {
    token = await _token();
  } catch (e) {
    console.error("[bdix/" + KEY + "] dashboard unreachable: " + e);
    return [];
  }
  if (!token) {
    console.error("[bdix/" + KEY + "] no search token on the dashboard");
    return [];
  }

  var rows, targets;
  try {
    rows = await _results(token, name, year);
    targets = kind === "tv"
      ? _seriesTargets(rows, name, season, year)
      : _movieTargets(rows, name, year);
  } catch (e) {
    console.error("[bdix/" + KEY + "] search failed for " + media + ": " + e);
    return [];
  }

  // The player pages are independent of one another, so they are opened
  // together; Promise.all keeps them in the order the ranking put them in,
  // which is what decides the dedupe below.
  var pages = await Promise.all(
    targets.slice(0, MAX_TARGETS).map(function (t) {
      return _sources(t[0]).catch(function () { return []; });
    })
  );

  var found = [], seen = new Set();
  pages.forEach(function (files) {
    files.forEach(function (f) {
      if (seen.has(f[0])) return;
      if (kind === "tv") {
        var got = _episodeOf(f[0], f[1]);
        if (got[0] !== season || got[1] !== episode) return;
      }
      seen.add(f[0]);
      found.push(f);
    });
  });

  if (kind === "movie") found = _rankMovies(name, year, found);

  // The size is fetched last, one HEAD per stream that survived both cuts
  // above, so the budget is only ever spent on a row that is returned.
  var chosen = found.slice(0, MAX_STREAMS);
  var sizes = await Promise.all(chosen.map(function (f) {
    return _contentLength(f[0], deadline);
  }));

  return chosen.map(function (f, i) {
    return _stream(f[0], f[1], media, kind, season, episode, sizes[i]);
  });
}
