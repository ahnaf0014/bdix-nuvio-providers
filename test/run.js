'use strict';
// Live checks against the six sites.
//
// units.js proves the helpers agree with the Python.  This proves the *site*
// half - that the regexes still match what the sites still serve, which is the
// half that rots on its own and the half no fixture can cover.
//
//   node test/run.js                 every check this machine can reach
//   node test/run.js circleftp       one provider
//   node test/run.js --contract      also drive getStreams end to end
//   TMDB_API_KEY=... node test/run.js --contract   ...against the real TMDB
//
// A host this machine cannot reach is reported as skip, not as a failure: three
// of the six answer only from their own network, and running this file anywhere
// else would otherwise be six red lines that mean nothing.  The same file on a
// machine inside that network runs them for real.
//
// Nothing here is part of CI.  The runner has no route to these hosts.

const fs = require('fs');
const path = require('path');
const { ROOT, loadGlobals, bridgeFetch } = require('./harness');

const argv = process.argv.slice(2);
const contract = argv.includes('--contract');
const only = argv.filter((a) => !a.startsWith('-'));

// ---- reporting ----------------------------------------------------------

let ok = 0, failed = 0, skipped = 0;
const failures = [];

// A connection that never got there.  This is the expected answer on a machine
// outside the host's network, and the *unexpected* answer on one inside it -
// which is why the reason is printed either way.
function unreachable(e) {
  const msg = String((e && e.message) || e);
  const code = (e && e.cause && e.cause.code) || (e && e.code) || '';
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|timed out|aborted|other side closed/i
    .test(msg + ' ' + code);
}

async function check(id, label, fn) {
  if (only.length && !only.includes(id)) return;
  const t0 = Date.now();
  let note;
  try {
    note = await fn();
  } catch (e) {
    const ms = Date.now() - t0;
    if (unreachable(e)) {
      skipped++;
      console.log(`  skip  ${id.padEnd(10)} ${label.padEnd(38)} ` +
        `${ms}ms  unreachable from here`);
      return;
    }
    failed++;
    failures.push(`${id} / ${label}: ${(e && e.stack) || e}`);
    console.log(`  FAIL  ${id.padEnd(10)} ${label.padEnd(38)} ${ms}ms  ${e.message || e}`);
    return;
  }
  ok++;
  console.log(`  ok    ${id.padEnd(10)} ${label.padEnd(38)} ` +
    `${Date.now() - t0}ms  ${note || ''}`);
}

function need(cond, why) {
  if (!cond) throw new Error(why);
  return true;
}

// ---- the providers ------------------------------------------------------

const G = {};
function load(id) {
  if (!G[id]) G[id] = loadGlobals(`providers/${id}.js`);
  return G[id];
}

// A film and a series that these libraries really file, per provider, with the
// year TMDB gives them.  Only the site-specific functions are called, so no
// TMDB key and no metadata fixture is involved - which is the point: a failure
// here is a failure of the parsing and nothing else.
const FILM = { name: 'Dune', year: 2021 };
const SERIES = { name: 'Breaking Bad', year: 2008, season: 1, episode: 1 };

// A name no library holds, for the check that says a lookup still comes back
// empty rather than latching onto the nearest thing.
const ABSENT = { name: 'Zzyzx Quux Nonexistent', year: 1899 };

function checks() {
  return [
    // ---- CircleFTP: JSON search, then a post lookup --------------------
    ['circleftp', `search "${FILM.name}"`, async () => {
      const posts = await load('circleftp')._searchPosts(FILM.name);
      need(posts.length, 'no posts came back');
      return `${posts.length} posts`;
    }],
    ['circleftp', `best movie "${FILM.name}" (${FILM.year})`, async () => {
      const g = load('circleftp');
      const post = g._bestPost(await g._searchPosts(FILM.name), 'movie',
                               FILM.name, FILM.year);
      need(post, 'no post matched');
      const detail = await g._resolvePost(post.id != null ? post.id : post._id);
      need(detail, 'post did not resolve');
      return `post ${post.id != null ? post.id : post._id}`;
    }],
    ['circleftp', `best series "${SERIES.name}"`, async () => {
      const g = load('circleftp');
      const post = g._bestPost(await g._searchPosts(SERIES.name), 'tv',
                               SERIES.name, SERIES.year);
      need(post, 'no series post matched');
      return `post ${post.id != null ? post.id : post._id}`;
    }],

    // ---- CTGMovies: RSC flight decode on search and detail -------------
    ['ctgmovies', `search "${FILM.name}"`, async () => {
      const found = await load('ctgmovies')._search(FILM.name);
      const n = (found.movies || []).length + (found.tv || []).length;
      need(n, 'initialResults came back empty');
      return `${n} results`;
    }],
    ['ctgmovies', `detail for "${FILM.name}"`, async () => {
      const g = load('ctgmovies');
      const best = g._best(await g._search(FILM.name), 'movie', FILM.name, FILM.year);
      need(best, 'no movie matched');
      const page = await g._detail('movie', best.slug);
      need(page, 'detail page decoded to nothing');
      return `slug ${best.slug}`;
    }],

    // ---- Dflix(Dot): JSON search, then an RSC title page ---------------
    ['dflix', `search "${FILM.name}"`, async () => {
      const results = await load('dflix')._search(FILM.name);
      need(results.length, 'no results');
      return `${results.length} results`;
    }],
    ['dflix', `resolve title "${FILM.name}"`, async () => {
      const g = load('dflix');
      const best = g._bestResult(await g._search(FILM.name), 'movie',
                                 FILM.name, FILM.year);
      need(best, 'no movie matched');
      const title = await g._resolveTitle(best.id != null ? best.id : best.tmdb_id);
      need(title && (title.files || []).length, 'title resolved with no files');
      return `${title.files.length} files`;
    }],

    // ---- Nagordola: AList API, folder walk -----------------------------
    ['nagordola', `search "${FILM.name}"`, async () => {
      const rows = await load('nagordola')._search(FILM.name);
      need(rows.length, 'no rows');
      return `${rows.length} rows`;
    }],
    ['nagordola', `folder for "${SERIES.name}"`, async () => {
      const folder = await load('nagordola')
        ._findFolder(SERIES.name, SERIES.year, 'series');
      need(folder, 'no folder matched');
      return typeof folder === 'string' ? folder : JSON.stringify(folder);
    }],

    // ---- DhakaFlix: h5ai fallback table, ten shelves -------------------
    ['dhakaflix', 'listing "English Movies"', async () => {
      const out = await load('dhakaflix')
        ._listing('http://172.16.50.7/DHAKA-FLIX-7/English%20Movies/');
      need(out.length, 'the fallback table came back empty');
      return `${out.length} entries`;
    }],
    ['dhakaflix', 'year buckets cover 2021', async () => {
      const g = load('dhakaflix');
      const groups = await g._listing('http://172.16.50.7/DHAKA-FLIX-7/English%20Movies/');
      const buckets = groups.filter((e) => e.isDir && g._covers(e.label, FILM.year));
      need(buckets.length, 'no bucket claims 2021');
      return buckets.map((b) => b.label).join(', ');
    }],

    // ---- ICC FTP: dashboard token, POST search, player page ------------
    ['iccftp', 'dashboard token', async () => {
      const token = await load('iccftp')._token();
      need(token, 'the dashboard carried no token');
      return `token ${token.slice(0, 8)}…`;
    }],
    ['iccftp', `search "${FILM.name}" (${FILM.year})`, async () => {
      const g = load('iccftp');
      const rows = await g._results(await g._token(), FILM.name, FILM.year);
      need(rows.length, 'both query forms came back empty');
      return `${rows.length} rows`;
    }],
    ['iccftp', `player page for "${FILM.name}"`, async () => {
      const g = load('iccftp');
      const rows = await g._results(await g._token(), FILM.name, FILM.year);
      const targets = g._movieTargets(rows, FILM.name, FILM.year);
      need(targets.length, 'no target matched');
      const files = await g._sources(targets[0][0]);
      need(files.length, 'the player page carried no video source');
      return `${files.length} files on ${targets[0][1]}`;
    }],
  ];
}

// ---- the whole contract, end to end -------------------------------------

// Serves TMDB from test/meta.json so getStreams can run without a key, or lets
// the call through when one is set.  Either way the sites are real.
function metaFrom(title, base) {  return (url, options) => {
    const m = /^https?:\/\/api\.themoviedb\.org\/3\/(movie|tv)\/(\d+)/.exec(url);
    if (!m) return base(url, options);
    const t = title;
    const body = m[1] === 'movie'
      ? { title: t.name, release_date: `${t.year}-01-01` }
      : { name: t.name, first_air_date: `${t.year}-01-01` };
    // `seasons` on an entry is how many seasons TMDB records for the show, and
    // it is load-bearing rather than decoration: a show TMDB records as one
    // season is filed by the sites in some other way, so a fixture without it
    // exercises the ordinary path and never the other one.
    if (m[1] === 'tv' && t.seasons) {
      body.seasons = [];
      for (let i = 1; i <= t.seasons; i++) body.seasons.push({ season_number: i });
    }
    const text = JSON.stringify(body);
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK', url,
      headers: { get: () => null },
      text: async () => text,
      json: async () => body,
      arrayBuffer: async () => Buffer.from(text),
    });
  };
}

async function contractChecks(meta) {
  const out = [];

  // Before the positive cases, the one that says the matcher still says no.
  // Every provider here is looking for a title in a library of near-misses -
  // "Dune" against "Dune: Part Two", "Saw" against "SAW II" - and a matcher
  // loosened far enough to find everything finds these too.  This is the check
  // that would go red first if that happened.
  for (const id of ['circleftp', 'ctgmovies', 'dflix', 'nagordola']) {
    out.push(['absent', id, async () => {
      const g = loadGlobals(`providers/${id}.js`, {
        TMDB_API_KEY: 'fixture',
        fetch: metaFrom(ABSENT, bridgeFetch()),
      });
      const got = await g.getStreams(1, 'movie');
      need(Array.isArray(got) && got.length === 0,
        `a title that does not exist returned ${got.length} streams`);
      return 'nothing, as it should';
    }]);
  }

  // The reported wrong show, kept as a check rather than a note.
  //
  // Nagordola's search asks the library for every word of the query, and its
  // "Dragon Ball Z" episode files are titled "... Super ...", so a request for
  // "Dragon Ball Super" comes back holding Dragon Ball Z's folder.  That folder
  // has no year to weigh the name against, and playing it put a different
  // series at the requested one's place.  The library does not have Dragon Ball
  // Super, so nothing is the only right answer here.
  out.push(['wrong show', 'dragon ball super', async () => {
    const t = { name: 'Dragon Ball Super', year: 2015 };
    const g = loadGlobals('providers/nagordola.js', {
      TMDB_API_KEY: 'fixture',
      fetch: metaFrom(t, bridgeFetch()),
    });
    const got = await g.getStreams(62715, 'tv', 1, 1);
    need(Array.isArray(got), 'getStreams did not return an array');
    need(got.length === 0,
      `returned ${got.length} stream(s) for a series this library does not have`);
    return 'nothing, as it should';
  }]);

  for (const t of meta.titles) {
    out.push([t.type === 'movie' ? 'film' : 'series', String(t.id), async () => {
      const id = t.provider || (t.type === 'movie' ? 'dflix' : 'nagordola');
      const g = loadGlobals(`providers/${id}.js`, {
        TMDB_API_KEY: 'fixture',
        fetch: metaFrom(t, bridgeFetch()),
      });
      const got = await g.getStreams(t.id, t.type, t.season, t.episode);
      need(Array.isArray(got), 'getStreams did not return an array');
      for (const s of got) {
        need(s.url && s.name, 'a stream came back without a url or a name');
        need(s.provider === id, `provider is ${s.provider}, expected ${id}`);
      }
      return `${got.length} streams`;
    }]);
  }
  return out;
}

// ---- run ----------------------------------------------------------------

(async function main() {
  console.log('bdix providers - live checks' +
    (contract ? ' (contract)' : '') + '\n');

  for (const [id, label, fn] of checks()) await check(id, label, fn);

  if (contract) {
    const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'meta.json'), 'utf8'));
    console.log('\ncontract - getStreams end to end, metadata from test/meta.json\n');
    for (const [kind, tid, fn] of await contractChecks(meta)) {
      await check('contract', `${kind} ${tid}`, fn);
    }
  }

  console.log(`\n${ok} ok, ${failed} failed, ${skipped} skipped`);
  if (failures.length) {
    console.log('\n' + failures.join('\n\n'));
  }
  process.exit(failed ? 1 : 0);
})();
