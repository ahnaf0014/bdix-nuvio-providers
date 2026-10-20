// Dflix(Dot) - the dflix.live specifics, and nothing else.
//
// A plain JSON search, then the Next.js RSC payload of a /title/<id> page for
// the file list.  The interesting part is picking the right title object out of
// that payload: the page carries several records that share an id prefix, and
// the one with the most filled-in media fields is the real title rather than a
// stub from a carousel.
//
// Unlike the FTP mirrors, this host answers from any network.

var KEY = "dflix";
var LABEL = "Dflix(Dot)";

var BASE = "https://dflix.live";

// The media fields a real title record carries.  A payload holds several
// objects whose id starts the same way, and the fullest one is the title.
var _WANTED = ["overview", "tmdbId", "posterPath", "backdropPath",
               "genres", "rating", "runtime", "kind", "year", "trailerKey"];


// ---- reading the payload ------------------------------------------------

// The title record with this id, or null.
function _pickTitleObject(text, titleId) {
  var marker = '{"id":' + titleId + ',';
  var best = null, bestScore = -1, start = 0;

  while (true) {
    var pos = text.indexOf(marker, start);
    if (pos < 0) break;
    start = pos + 1;

    var end = matchBalanced(text, pos, "{", "}");
    if (end === null) continue;
    var obj;
    try { obj = JSON.parse(text.slice(pos, end)); } catch (e) { continue; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;

    var score = 0;
    for (var i = 0; i < _WANTED.length; i++) {
      if (obj[_WANTED[i]] != null) score++;
    }
    if (score > bestScore) { best = obj; bestScore = score; }
  }
  return best;
}

// [title record, file records] from one title page's payload.
function _extractTitle(titleId, text) {
  var title = _pickTitleObject(text, titleId);
  var files = [], seen = new Set();

  arraysAfterKey(text, "episodes").forEach(function (arr) {
    for (var i = 0; i < arr.length; i++) {
      var rec = arr[i];
      if (!rec || typeof rec !== "object") continue;
      if (rec.titleId != null && rec.titleId !== titleId) continue;
      if (seen.has(rec.id)) continue;      // the page repeats its own records
      seen.add(rec.id);
      files.push(rec);
    }
  });
  return [title, files];
}


// ---- episode numbers ----------------------------------------------------

// The episode number in a filename, for the records the site left null.
//
// Three digits at most, and not the start of a decimal: after a dash here a
// long run is a resolution or a year ("-1080p", "-2021") and "5.1" is an audio
// channel count, none of which is an episode.  The site does fill `episode`
// itself for most titles, so this is only the fallback.
var _EP_IN_NAME = /-[_\s]*(\d{1,3})(?!\.\d)[_\s(.]/;

function _episodeOf(f) {
  if (f.episode != null) return f.episode;
  var marked = episodeMarker(f.path);          // S01E02 in the filename
  if (marked[1] != null) return marked[1];
  var m = _EP_IN_NAME.exec(String(f.path || ""));
  return m ? parseInt(m[1], 10) : null;
}


// ---- site calls ---------------------------------------------------------

async function _search(q, limit) {
  var url = BASE + "/api/search?q=" + quote(q) + "&limit=" + (limit || 60);
  var body = await fetchJson(url);
  return (body && body.results) || [];
}

async function _resolveTitle(id) {
  var text = decodeFlight(await fetchText(BASE + "/title/" + id));
  var got = _extractTitle(id, text);
  var title = got[0], files = got[1];
  if (title === null) throw new Error("could not resolve title " + id);
  if (files.length) title.files = files;
  return title;
}

// Exact lookup, not a search: this site writes a bare "1080p" or nothing at
// all, and "1080p BluRay" scoring as 1080p here would rank a file the other
// sources rank differently.
function _qualRank(q) {
  var key = String(q == null ? "" : q).toLowerCase().trim();
  return _QUALITY_RANK[key] || 0;
}

function _streamUrl(fid) {
  return BASE + "/api/stream/" + fid;
}


// ---- picking + stream building -----------------------------------------

function _bestResult(results, kind, name, year) {
  var best = null, bestScore = 0.0;
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!r || typeof r !== "object") continue;
    if (String(r.kind || "").toLowerCase() !== kind) continue;
    var score = matchScore(name, year, r.title, r.year);
    if (score === null) continue;
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

// One file per quality, best qualities first, at most `limit` of them.
//
// A Map rather than an object, so the order the qualities were met in is kept
// exactly - that order is what decides the tie between two files of equal rank,
// and an object would reorder any key that looks like an integer.
function _pickByQuality(files, keep, limit) {
  var chosen = new Map();
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (!keep(f)) continue;
    var q = String(f.quality || "").toLowerCase();
    if (!chosen.has(q)) chosen.set(q, f);
  }
  var list = Array.from(chosen.values());
  // A stable sort, so equal ranks keep the order the page listed them in.
  list.sort(function (a, b) { return _qualRank(b.quality) - _qualRank(a.quality); });
  return list.slice(0, limit);
}

function _build(files, media, marker) {
  return files.map(function (f) {
    return stream(_streamUrl(f.id), LABEL, {
      quality: f.quality || "",
      marker: marker,
      size: f.size,
      media: media,
      provider: KEY,
    });
  });
}

function _movieStreams(title, media) {
  return _build(_pickByQuality(title.files || [], function (f) {
    return f.season == null && f.episode == null;   // a whole-movie file
  }, 3), media, "");
}

// `absolute` is set when TMDB records one season for this show.
//
// Then the site's season number is not a season at all: it files the show by
// arc ("Season 1 Battle of Gods Arc", "Season 2 Resurrection F Arc", ...) and
// numbers the episodes absolutely across them, while TMDB has a single season
// to ask for.  Comparing the season there returns nothing for every arc after
// the first - which is how Dragon Ball Super came back empty for every
// episode even though the library has all of them.
function _episodeStreams(title, media, season, episode, absolute) {
  return _build(_pickByQuality(title.files || [], function (f) {
    if (_episodeOf(f) !== episode) return false;
    return absolute || f.season === season;
  }, 2), media, episodeTag(season, episode));
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

  var title;
  try {
    var row = _bestResult(await _search(name), kind, name, year);
    if (!row) return [];
    title = await _resolveTitle(row.id);
  } catch (e) {
    console.error("[bdix/" + KEY + "] lookup failed for " + media + ": " + e);
    return [];
  }

  // The search row and the title page can disagree about the kind, and the
  // page is the one that is right.
  if (kind !== (title.kind || "movie")) return [];

  return kind === "movie"
    ? _movieStreams(title, media)
    : _episodeStreams(title, media, season, episode, meta.seasons === 1);
}
