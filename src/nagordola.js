// Nagordola - the cdn.nagordola.com.bd specifics, and nothing else.
//
// The host runs AList, whose public API needs neither a key nor a signature,
// and whose paths are plain filesystem paths rather than ids - so a title's
// folder is reached by walking names, not by resolving an id.  The library is
// Jellyfin shaped: a title is a folder called "Title (Year)" under a category
// folder, a film's folder holds one video plus its subtitles, and a series'
// folder holds "Season N" folders - or, when the library filed a season pack,
// the episode files themselves.
//
// Unlike the FTP mirrors, this host answers from any network.

var KEY = "nagordola";
var LABEL = "Nagordola";

var BASE = "https://cdn.nagordola.com.bd";

// Where each kind of title is filed, as [category path, depth below it].  The
// anime shelves mirror the same shape one level up, so a film is a film
// wherever it is filed and only the walk above it differs.
var ROOTS = {
  movie: [["movies", 2], ["anime/movies-anime", 1]],
  series: [["tv-series", 2], ["anime/tvshows-anime", 1]],
};

// A title folder holds one encode; a cap of two covers the folders that carry a
// second one without turning a title into a wall of near-identical rows.
var MAX_STREAMS = 2;


// ---- site calls ---------------------------------------------------------

// One AList call, decoded.
//
// AList reports failure in the body with HTTP 200 still on the wire
// ({"code": 500, "message": "failed get storage..."}), so the code is checked
// rather than trusted to the transport.
async function _api(endpoint, payload) {
  var body = await fetchJson(BASE + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!body || (body.code !== 0 && body.code !== 200)) {
    throw new Error((body && body.message) || ("alist code " + (body && body.code)));
  }
  return body.data || {};
}

// Rows matching a search term, anywhere in the library.
//
// Every word of the term has to appear in a basename, so this only reaches the
// title's folder - which row is really the title is matchScore's call.  The
// page is wide because a term as ordinary as "9" matches thousands of rows, and
// the folder it is after can lie past a narrow page's edge.
async function _search(name) {
  var data = await _api("/api/fs/search", {
    parent: "/", keywords: name, scope: 0, page: 1,
    per_page: 500, password: "",
  });
  return _rows(data.content);
}

// One folder's entries ("per_page": 0 means all of them).
async function _ls(path) {
  var data = await _api("/api/fs/list", {
    path: path, password: "", page: 1, per_page: 0, refresh: false,
    order_by: "name", order_direction: "asc",
  });
  return _rows(data.content);
}

// The playable URL for one file, or "" when it cannot be resolved.
async function _raw(path) {
  var data = await _api("/api/fs/get", { path: path, password: "" });
  return data.raw_url || "";
}

function _rows(content) {
  return (Array.isArray(content) ? content : []).filter(function (r) {
    return r && typeof r === "object";
  });
}


// ---- parsing ------------------------------------------------------------

var _YEAR_IN_NAME = /\((\d{4})\)/;
var _SEASON_DIR = /season\s*[.\-_]?\s*(\d+)/i;

// ["The Shawshank Redemption", 1994] from a title folder's name.
//
// The year is not always last: the anime shelves file release tags after it
// ("Drifting Home (2022) [1080p] [WEBRip] [YTS.MX]"), so it is found anywhere
// and the title is whatever precedes it.  A folder that records no year - "9"
// on the anime shelf - keeps its whole name and matches on the name alone.
function _titleYear(dirName) {
  dirName = dirName || "";
  var m = _YEAR_IN_NAME.exec(dirName);
  if (!m) return [dirName, null];
  return [dirName.slice(0, m.index).replace(/^[ \-_.]+|[ \-_.]+$/g, ""),
          parseInt(m[1], 10)];
}

function _sameSlice(parts, head) {
  if (parts.length < head.length) return false;
  for (var i = 0; i < head.length; i++) {
    if (parts[i] !== head[i]) return false;
  }
  return true;
}

// [title folder path, its name] for a path inside one, else [null, null].
//
// A title folder sits at a fixed depth under its category, and that depth is
// what separates it from the category above it and from a "Season 1" below it.
// Anything deeper belongs to the title it descends from, which is what recovers
// a series whose folder row fell off the search page while its episodes did
// not: the episodes name the season, and the season names the show.
function _titleOf(path, roots) {
  var parts = String(path || "").split("/").filter(Boolean);
  for (var i = 0; i < roots.length; i++) {
    var head = String(roots[i][0]).split("/").filter(Boolean);
    var depth = roots[i][1];
    if (!_sameSlice(parts, head) || parts.length < head.length + depth) continue;
    var cut = parts.slice(0, head.length + depth);
    return ["/" + cut.join("/"), cut[cut.length - 1]];
  }
  return [null, null];
}

// The title folders among search rows, deduped, in a stable order.
//
// Search answers with folders and with the files inside them, so both are read:
// a file's own path climbs back to the folder that holds it.
function _folders(rows, roots) {
  var seen = new Set(), out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var path = r.is_dir
      ? (r.parent || "") + "/" + (r.name || "")
      : (r.parent || "");
    var got = _titleOf(path, roots);
    var full = got[0], dirName = got[1];
    if (full && !seen.has(full)) {
      seen.add(full);
      out.push([full, dirName]);
    }
  }
  return out;
}

// Best matching title folder among search rows, as [path, name].
//
// `head` is the term this attempt searched with.  Every attempt after the first
// has had its tail cut off, so the evidence is thinner and the rule is
// stricter: the folder's own name has to start with that head.  Without it a
// one-word head drags in whatever the site's substring matching happens to like
// - "rick" reaches a folder holding an episode with a Patrick in it, and by
// spelling alone "Rick and Morty" against "American Horror Story" clears the
// similarity floor.
function _bestFolder(rows, kind, name, year, head) {
  var best = null, bestScore = 0.0;
  var roots = ROOTS[kind];
  // A kind with no roots is a wiring mistake, not an empty library, and the two
  // are indistinguishable from the outside: Nuvio turns any throw into a
  // console.error and an empty array.  So it says which one it is.
  if (!roots) throw new Error("no roots for kind " + JSON.stringify(kind));
  var candidates = _folders(rows, roots);

  for (var i = 0; i < candidates.length; i++) {
    var path = candidates[i][0], dirName = candidates[i][1];
    if (head && !norm(dirName).startsWith(head)) continue;
    var got = _titleYear(dirName);
    var score = matchScore(name, year, got[0], got[1]);
    if (score === null) continue;
    // Equal scores are broken on the path so that a title the library filed
    // twice - the same show under the English and the Hindi-dubbed category,
    // which is common here - does not alternate between calls.
    if (best === null || score > bestScore ||
        (score === bestScore && path < best[0])) {
      best = [path, dirName];
      bestScore = score;
    }
  }
  return best;
}

// Search terms to try for a title, narrowest first.
//
// TMDB punctuates names the library does not ("Avatar: The Last Airbender"
// against a folder called "Avatar - The Last Airbender"), and every word of a
// term has to be present for a row to match at all, so the punctuation has to
// come off before a search can find anything.
//
// What is left can still miss, when the library holds the same work under a
// different tail: the Philosopher's Stone rather than the Sorcerer's, a bare
// "Dune" rather than "Dune: Part One".  The head of a title is the part that is
// the same everywhere, so each later attempt keeps a shorter head - and
// matchScore, on a name that has to start with that head, still decides whether
// what came back is really the title.
//
// The stop-word list is shared with the matcher, which needs the same notion of
// a word that identifies nothing.
function _queries(name) {
  var words = norm(name).split(" ").filter(Boolean);
  var meat = words.filter(function (w) {
    return !STOP_WORDS[w] && w.length > 1;
  });

  var out = [];
  [words, meat, meat.slice(0, 3), meat.slice(0, 2), meat.slice(0, 1)]
    .forEach(function (seq) {
      var q = seq.join(" ");
      if (q && out.indexOf(q) < 0) out.push(q);
    });
  return out;
}

// Best matching title folder, searched as narrowly as the site allows.
async function _findFolder(name, year, kind) {
  var terms = _queries(name);
  for (var i = 0; i < terms.length; i++) {
    // Only the full title is matched on similarity alone; anything shorter is a
    // guess at a name the library shortened, and is held to it.
    var folder = _bestFolder(await _search(terms[i]), kind, name, year,
                             i === 0 ? null : terms[i]);
    if (folder !== null) return folder;
  }
  return null;
}

// Name of the folder holding this season, or null for a season pack.
//
// Matched anywhere in the name, not only as a bare "Season 3": the library also
// files them as "Generator Rex Season 3 Complete 1080p".
function _seasonDir(entries, season) {
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e.is_dir) continue;
    var m = _SEASON_DIR.exec(e.name || "");
    if (m && parseInt(m[1], 10) === season) return e.name;
  }
  return null;
}

// [path, name, size] of a folder's video files, best quality first.
function _videos(entries, path) {
  var out = entries.filter(function (e) {
    return !e.is_dir && isVideo(e.name);
  }).map(function (e) {
    return [path + "/" + e.name, e.name || "", e.size];
  });
  out.sort(function (a, b) { return qualityScore(b[1]) - qualityScore(a[1]); });
  return out.slice(0, MAX_STREAMS);
}

// [path, name, size] of this episode's video files, by their own markers.
//
// By marker, never by position in the listing: an E00 special listed ahead of
// E01 would otherwise shift the whole season by one.
function _episodeFiles(entries, path, season, episode) {
  return entries.filter(function (e) {
    if (e.is_dir || !isVideo(e.name)) return false;
    var m = episodeMarker(e.name);
    return m[0] === season && m[1] === episode;
  }).map(function (e) {
    return [path + "/" + e.name, e.name || "", e.size];
  });
}

// Streams for the chosen files of one title, or one episode.
async function _build(files, media, season, episode) {
  var series = season != null && episode != null;
  var marker = series ? episodeTag(season, episode) : "";
  var out = [];

  for (var i = 0; i < files.length && i < MAX_STREAMS; i++) {
    var path = files[i][0], fileName = files[i][1], size = files[i][2];
    var url;
    try {
      url = await _raw(path);
    } catch (e) {
      continue;                 // one file the library cannot resolve must not sink
    }
    if (!url) continue;         // the episode's other encodes
    out.push(stream(url, LABEL, {
      quality: qualityTag(fileName),
      marker: marker,
      size: size,
      media: media,
      provider: KEY,
    }));
  }
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
  // ROOTS is keyed "series", which is what the Stremio side called it and what
  // the Python this was ported from matched on.  Translated here, once, rather
  // than by renaming the map: everything below this line is the port.
  var kind = mediaType === "tv" ? "series" : "movie";
  if (kind !== "movie" && (season == null || episode == null)) return [];
  var media = mediaLabel(name, year);

  var folder;
  try {
    folder = await _findFolder(name, year, kind);
  } catch (e) {
    console.error("[bdix/" + KEY + "] lookup failed for " + media + ": " + e);
    return [];
  }
  if (folder === null) return [];
  var path = folder[0];

  try {
    if (kind === "movie") {
      // A film's folder holds one video and its subtitles.
      return await _build(_videos(await _ls(path), path), media, null, null);
    }

    var entries = await _ls(path);
    var seasonName = _seasonDir(entries, season);
    var epDir = path;                 // a season pack, loose in the title folder
    if (seasonName) {
      epDir = path + "/" + seasonName;
      entries = await _ls(epDir);
    }
    return await _build(_episodeFiles(entries, epDir, season, episode),
                        media, season, episode);
  } catch (e) {
    console.error("[bdix/" + KEY + "] listing failed for " + media + ": " + e);
    return [];
  }
}
