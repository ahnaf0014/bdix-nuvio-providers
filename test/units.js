'use strict';
// Assert the JS port against test/vectors.json, which was generated from the
// Python original (test/generate_vectors.py).
//
// This is the check that matters most, because it covers the failure mode the
// port is actually exposed to.  A provider that crashes is loud and gets fixed;
// a helper that computes something slightly different is silent, and shows up
// weeks later as "the Nuvio addon returns a different film than the Stremio one
// for the same title".  Both read the same library, so any divergence here is a
// divergence a person can see.
//
//   node test/units.js            summary, first few mismatches per function
//   node test/units.js --all      every mismatch
//   node test/units.js similar    only these functions

const fs = require('fs');
const path = require('path');
const { loadGlobals } = require('./harness');

const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'vectors.json'), 'utf8')).cases;

// The internals are reached through a bare evaluation of the generated files,
// which is the only way to see a provider's own top-level names - Nuvio wraps
// them in an IIFE on purpose.
const COMMON = loadGlobals('src/common.js');
const ICC = loadGlobals('providers/iccftp.js');

// One loader per vector name.  A name with no entry here is a hole in the
// test, not a pass, so it is reported as such.
const IMPL = {
  seqRatio: () => COMMON.seqRatio,
  norm: () => COMMON.norm,
  headWord: () => COMMON.headWord,
  similar: () => COMMON.similar,
  matchScore: () => COMMON.matchScore,
  yearBonus: () => COMMON.yearBonus,
  matchFloor: () => () => COMMON.MATCH_FLOOR,
  yearTolerance: () => () => COMMON.YEAR_TOLERANCE,
  episodeMarker: () => COMMON.episodeMarker,
  qualityTag: () => COMMON.qualityTag,
  qualityScore: () => COMMON.qualityScore,
  sizeText: () => COMMON.sizeText,
  fileExt: () => COMMON.fileExt,
  isVideo: () => COMMON.isVideo,
  intYear: () => COMMON.intYear,
  splitLabel: () => COMMON.splitLabel,
  splitShow: () => ICC._splitShow,
  decodeFlight: () => COMMON.decodeFlight,
  jsonAfter: () => COMMON.jsonAfter,
  matchBalanced: () => COMMON.matchBalanced,
  urlJoin: () => COMMON.urlJoin,
  unescapeHtml: () => COMMON.unescapeHtml,
  hostOf: () => COMMON.hostOf,
  quote: () => COMMON.quote,
  unquote: () => COMMON.unquote,
  formEncode: () => COMMON.formEncode,
};

// Numbers are compared with a tolerance rather than exactly.  Python's json
// emits the shortest repr that round-trips, and IEEE-754 parses it back to the
// identical double, so equality would in fact hold - but a helper that comes
// back 1e-16 out is not the bug this test exists to find, and failing on it
// would train whoever reads this to ignore red.
function same(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return ka.length === kb.length &&
      ka.every((k, i) => k === kb[i] && same(a[k], b[k]));
  }
  return false;
}

// undefined and null are the same answer here: JSON has one spelling for
// absence and JS has two, which is a fact about the languages, not the port.
function show(v) {
  return v === undefined ? 'null' : JSON.stringify(v);
}

const argv = process.argv.slice(2);
const showAll = argv.includes('--all');
const only = argv.filter((a) => !a.startsWith('-'));

const byFn = new Map();
for (const c of vectors) {
  if (only.length && !only.includes(c.fn)) continue;
  if (!byFn.has(c.fn)) byFn.set(c.fn, []);
  byFn.get(c.fn).push(c);
}

if (!byFn.size) {
  console.error('units: no cases selected - known functions are:\n  ' +
    Object.keys(IMPL).sort().join(' '));
  process.exit(2);
}

let checked = 0, failed = 0;
const unknown = new Set();
const broken = new Map();

for (const fn of [...byFn.keys()].sort()) {
  const cases = byFn.get(fn);
  const resolve = IMPL[fn];
  if (!resolve) { unknown.add(fn); continue; }

  let impl;
  try {
    impl = resolve();
  } catch (e) {
    broken.set(fn, 'could not load: ' + e.message);
    continue;
  }
  if (typeof impl !== 'function') {
    broken.set(fn, 'not a function (got ' + typeof impl + ')');
    continue;
  }

  const bad = [];
  for (const c of cases) {
    checked++;
    let got;
    try {
      got = impl.apply(null, c.args);
    } catch (e) {
      bad.push({ c, err: e.message });
      continue;
    }
    if (!same(got, c.expect)) bad.push({ c, got });
  }
  failed += bad.length;

  if (!bad.length) {
    console.log(`  ok    ${fn.padEnd(16)} ${String(cases.length).padStart(6)}`);
    continue;
  }

  console.log(`  FAIL  ${fn.padEnd(16)} ${String(cases.length).padStart(6)}` +
    `  ${bad.length} wrong`);
  for (const b of (showAll ? bad : bad.slice(0, 3))) {
    const args = b.c.args.map(show).join(', ');
    console.log(`          ${fn}(${args})`);
    console.log(`            want ${show(b.c.expect)}`);
    console.log(`            got  ${b.err ? 'threw: ' + b.err : show(b.got)}`);
  }
  if (!showAll && bad.length > 3) {
    console.log(`          ... ${bad.length - 3} more (--all)`);
  }
}

for (const [fn, why] of broken) {
  console.log(`  FAIL  ${fn.padEnd(16)}   ${why}`);
  failed++;
}
for (const fn of unknown) {
  console.log(`  FAIL  ${fn.padEnd(16)}   no implementation mapped in units.js`);
  failed++;
}

console.log(`\n${checked} cases against ${byFn.size} functions: ` +
  (failed ? `${failed} WRONG` : 'all match'));
process.exit(failed ? 1 : 0);
