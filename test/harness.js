'use strict';
// Everything the providers expect Nuvio to have put in scope, and nothing they
// do not.  Two loaders, because the port has two things to prove:
//
//   loadGlobals()  evaluates a file bare, so every top-level declaration lands
//                  on the context's global object and the unit tests can reach
//                  the internals directly.
//   loadPlugin()   reproduces the host's own wrapping and returns what
//                  module.exports ends up as - the same entry point Nuvio
//                  calls, so the live tests exercise the real path.
//
// The fetch here is the host bridge's, not Node's: the same shape
// ({ok, status, headers:{get}, text(), json(), arrayBuffer()}), the same
// lowercased response header names, and the same default User-Agent when the
// caller sets none.  A provider that only works against Node's richer fetch
// would be a provider that does not work on the device.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// PluginRuntime.wrapPluginModule, verbatim in shape: `module` is declared
// outside the IIFE, which is why a provider can assign to module.exports from
// inside it and why its own top-level names stay private.
function wrapPluginModule(code) {
  return 'var module = { exports: {} };\n' +
    'var exports = module.exports;\n' +
    '(function() {\n' + code + '\n})();\n';
}

function bridgeFetch() {
  return async function fetch(url, options) {
    options = options || {};
    const headers = Object.assign({}, options.headers || {});
    const named = Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent');
    if (!named) headers['User-Agent'] = 'Nuvio';

    const init = {
      method: String(options.method || 'GET').toUpperCase(),
      headers,
    };
    if (options.body !== undefined && options.body !== null) init.body = options.body;
    init.redirect = options.redirect === 'manual' ? 'manual' : 'follow';

    const res = await globalThis.fetch(url, init);
    const buf = Buffer.from(await res.arrayBuffer());
    const body = buf.toString('utf8');

    // FetchBridge lowercases response header names before the polyfill sees
    // them, and the polyfill's get() is `parsed.headers[name] || null` - so an
    // empty header is null here too, not "".
    const lower = {};
    res.headers.forEach((v, k) => { lower[k.toLowerCase()] = v; });

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      headers: {
        get(name) {
          if (name === null || name === undefined) return null;
          return lower[String(name).toLowerCase()] || null;
        },
      },
      arrayBuffer: async () =>
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      text: async () => body,
      // The polyfill wraps JSON.parse in a try and resolves null on a bad or
      // empty body rather than rejecting.  A provider here must not be relying
      // on a throw that never comes on the device.
      json: async () => {
        if (!body) return null;
        try {
          return JSON.parse(body);
        } catch (e) {
          return null;
        }
      },
    };
  };
}

function sandbox(extra) {
  const s = Object.assign({
    console,
    fetch: bridgeFetch(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    AbortSignal,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    SCRAPER_ID: 'test',
    SCRAPER_SETTINGS: {},
    TMDB_API_KEY: process.env.TMDB_API_KEY || '',
    // A generated provider ends with module.exports, which the host supplies.
    // Here it only has to exist.
    module: { exports: {} },
    exports: {},
  }, extra || {});
  return vm.createContext(s);
}

// Every top-level declaration of a file, on the context's global object.
function loadGlobals(relPath, extra) {
  const s = sandbox(extra);
  vm.runInContext(fs.readFileSync(path.join(ROOT, relPath), 'utf8'), s, {
    filename: relPath,
  });
  return s;
}

// The provider as Nuvio runs it: wrapped, then module.exports read back.
function loadPlugin(relPath, options) {
  const s = sandbox(options);
  vm.runInContext(
    wrapPluginModule(fs.readFileSync(path.join(ROOT, relPath), 'utf8')) +
    '\nmodule.exports;',
    s, { filename: relPath });
  return s;
}

module.exports = {
  ROOT, loadGlobals, loadPlugin, wrapPluginModule, bridgeFetch, sandbox,
};
