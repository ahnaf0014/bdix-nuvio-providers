// CircleFTP - the new.circleftp.net specifics, and nothing else.
//
// The live search, the per-post resolve, the site's link cleanup, its
// season/episode naming and its post-kind mapping.  Everything shared - the
// matcher, quality tags, sizes, TMDB - is concatenated in front of this file by
// build.py, so this file is only what is true of this one site.
//
// The FTP mirrors it returns only resolve from the network the user's ISP
// provides, so off that network this provider contributes nothing.  Nuvio runs
// the providers concurrently and each one's failure is its own, so the other
// five are unaffected either way.

var KEY = "circleftp";
var LABEL = "CircleFTP";

var API = "http://new.circleftp.net:5000/api";


// ---- site calls ---------------------------------------------------------

// The site writes the occasional "ttp://" for "http://".
function _cleanUrl(u) {
  if (!u) return u;
  if (!/^http/.test(u) && /^ttp/.test(u)) u = "h" + u;
  return u;
}

// Live backend search; ~60 posts max, limit/page are ignored.
async function _searchPosts(q) {
  var url = API + "/posts?searchTerm=" + quote(q) + "&order=desc";
  var body = await fetchJson(url);
  return (body && body.posts) || [];
}

function _resolvePost(pid) {
  return fetchJson(API + "/posts/" + pid);
}


// ---- parsing ------------------------------------------------------------

function _seasonNumber(seasonName) {
  var m = /season\s*(\d+)/i.exec(seasonName || "");
  return m ? parseInt(m[1], 10) : null;
}

// "singleVideo" -> "movie"; "series" -> "tv"; anything else is not streamable.
function _postKind(postType) {
  if (postType === "series") return "tv";
  if (postType === "singleVideo") return "movie";
  return null;
}

// Best matching post of the wanted kind.
function _bestPost(posts, kind, name, year) {
  var best = null, bestScore = 0.0;
  for (var i = 0; i < (posts || []).length; i++) {
    var p = posts[i];
    if (!p || typeof p !== "object") continue;
    if (_postKind(p.type) !== kind) continue;
    var pname = p.name || p.title || "";
    var score = matchScore(name, year, pname, p.year);
    if (score === null) continue;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

// content -> {"season:episode": clean url}
function _episodeMap(content) {
  var out = {};
  var groups = Array.isArray(content) ? content : [];
  var single = groups.length === 1;

  for (var gi = 1; gi <= groups.length; gi++) {
    var g = groups[gi - 1];
    if (!g || typeof g !== "object") continue;
    var season = _seasonNumber(g.seasonName) || (single ? 1 : gi);
    var eps = Array.isArray(g.episodes) ? g.episodes : [];

    for (var i = 1; i <= eps.length; i++) {
      var ep = eps[i - 1];
      if (!ep || typeof ep !== "object") continue;
      var link = _cleanUrl(ep.link || "");
      if (!link) continue;
      var m = episodeMarker(ep.title);
      // Tested against null, not truthiness: episode 0 is a real number, and a
      // falsy 0 would fall back to the list position - which is what put season
      // 6's E00 special on episode 1 and shifted the whole season by one.
      var s = m[0] !== null ? m[0] : season;
      var e = m[1] !== null ? m[1] : i;
      out[s + ":" + e] = link;
    }
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
  var kind = mediaType === "tv" ? "tv" : "movie";
  if (kind === "tv" && (season == null || episode == null)) return [];
  var media = mediaLabel(name, year);

  var post;
  try {
    post = _bestPost(await _searchPosts(name), kind, name, year);
  } catch (e) {
    console.error("[bdix/" + KEY + "] search failed: " + e);
    return [];
  }
  if (!post) return [];

  var resolved;
  try {
    resolved = await _resolvePost(post.id);
  } catch (e) {
    console.error("[bdix/" + KEY + "] could not resolve post " + post.id + ": " + e);
    return [];
  }
  if (!resolved) return [];

  var quality = resolved.quality || post.quality || "";

  if (kind === "movie") {
    var link = typeof resolved.content === "string" ? _cleanUrl(resolved.content) : "";
    if (!link || !isVideo(link)) return [];
    // The size is one HEAD, for the one stream that was asked for.
    return [stream(link, LABEL, {
      quality: quality,
      size: await contentLength(link),
      media: media,
      provider: KEY,
    })];
  }

  var epLink = _episodeMap(resolved.content)[season + ":" + episode];
  if (!epLink || !isVideo(epLink)) return [];
  return [stream(epLink, LABEL, {
    quality: quality,
    marker: episodeTag(season, episode),
    size: await contentLength(epLink),
    media: media,
    provider: KEY,
  })];
}
