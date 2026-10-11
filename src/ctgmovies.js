// CTGMovies - the ctgmovies.com specifics, and nothing else.
//
// The site publishes no JSON API, so both the search results and a title's
// links are read out of the Next.js RSC payload its own pages ship.  That is
// why there is no browser here: the payload is in the HTML, and decoding it is
// string work.
//
// Unlike the FTP mirrors, this host answers from any network.

var KEY = "ctgmovies";
var LABEL = "CTGMovies";

var BASE = "https://ctgmovies.com";

// A title carries one entry per mirror of the same file, and entries repeat.
// Two is plenty: they are normally the same encode on two hosts, and a mirror
// is worth exactly as much as it is when the first one is down.
var MAX_STREAMS = 2;


// ---- site calls ---------------------------------------------------------

// The decoded RSC flight text for a site path.  The decode can throw on a page
// that is not the app (a maintenance page, a redirect), and that is the
// caller's to handle.
function _flight(path) {
  return fetchText(BASE + path).then(decodeFlight);
}

// {"movies": [...], "tv": [...]} for a query, {} when nothing matched.
async function _search(name) {
  var found = jsonAfter(await _flight("/search?q=" + quote(name)), "initialResults");
  return (found && typeof found === "object" && !Array.isArray(found)) ? found : {};
}

// /movies/<slug> for a film, /tv/<slug> for a series.
function _detail(kind, slug) {
  return _flight("/" + (kind === "movie" ? "movies" : "tv") + "/" + slug);
}


// ---- parsing ------------------------------------------------------------

// Usable links, best quality first, one entry per distinct URL.
//
// The URL is the identity: a page lists the same encode once per mirror and
// repeats some entries, so deduping on it keeps the mirrors and drops the
// repeats.
function _usable(links) {
  var list = (links || []).filter(function (l) {
    return l && typeof l === "object";
  });
  list.sort(function (a, b) {
    return qualityScore(b.quality) - qualityScore(a.quality);
  });

  var out = [], seen = {};
  for (var i = 0; i < list.length; i++) {
    var l = list[i];
    var url = l.url || l.hls_url;
    if (!url || seen[url] || l.broken) continue;
    seen[url] = true;
    out.push(l);
  }
  return out;
}

// Best matching search result of the wanted kind.
//
// Films are filed under "movies" with a "title"/"year"; series under "tv" with
// a "name" and a first air date, so each is matched on its own fields.
function _best(results, kind, name, year) {
  var key = kind === "movie" ? "movies" : "tv";
  var nameKey = kind === "movie" ? "title" : "name";
  var yearKey = kind === "movie" ? "year" : "first_air_date";

  var best = null, bestScore = 0.0;
  var rows = results[key] || [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || typeof r !== "object") continue;
    var score = matchScore(name, year, r[nameKey], r[yearKey]);
    if (score !== null && score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

// Streams for one title, or for one episode of one.
function _build(links, media, season, episode) {
  var series = season != null && episode != null;
  var marker = series ? episodeTag(season, episode) : "";

  return _usable(links).slice(0, MAX_STREAMS).map(function (l) {
    var url = l.url || l.hls_url;
    // The host goes on the second line, not the heading: these are mirrors of
    // one file, so without it the rows would be identical and the choice
    // arbitrary.
    return stream(url, LABEL, {
      quality: l.quality || "",
      marker: marker,
      note: hostOf(url),
      size: l.size_bytes,
      media: media,
      provider: KEY,
    });
  });
}

// This movie's own links.
//
// Guarded by id because a page is free to carry other link blocks (a "similar
// titles" shelf would); an entry that records no id is still taken, as there is
// nothing to contradict it.
function _movieLinks(page, movieId) {
  var links = jsonAfter(page, "links");
  if (!Array.isArray(links)) return [];
  return links.filter(function (l) {
    return l && typeof l === "object" &&
      (l.movie_id == null || l.movie_id === movieId);
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

  var row, page;
  try {
    row = _best(await _search(name), kind, name, year);
    if (!row) return [];
    page = await _detail(kind, row.slug || row.id);
  } catch (e) {
    console.error("[bdix/" + KEY + "] lookup failed for " + media + ": " + e);
    return [];
  }

  if (kind === "movie") return _build(_movieLinks(page, row.id), media, null, null);

  // Episodes carry their own season and episode numbers, so the requested one
  // is found by number rather than by position in the list.
  var episodes = jsonAfter(page, "episodes");
  var list = Array.isArray(episodes) ? episodes : [];
  for (var i = 0; i < list.length; i++) {
    var ep = list[i];
    if (!ep || typeof ep !== "object") continue;
    if (ep.season_number === season && ep.episode_number === episode) {
      return _build(ep.links || [], media, season, episode);
    }
  }
  return [];
}
