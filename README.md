# bdix

Streams from BDIX-connected libraries, for [Nuvio](https://github.com/NuvioMedia/NuvioMobile).

Nuvio runs providers **on your device**: it downloads the JavaScript in
`providers/` and executes it there. There is no server, nothing to host, and
nothing to run. You add one repository URL and the sources appear inside the
titles you already have.

## Install

In Nuvio: **Settings → Plugins → Add repository**, and paste

```
https://raw.githubusercontent.com/ahnaf0014/bdix-nuvio-providers/main/manifest.json
```

Then open any film or series and the streams are there. Each source has its own
on/off switch on the Plugins screen, so you can keep the ones you want and drop
the rest.

Nuvio needs a **TMDB API key** for the titles it looks up. Set one in Nuvio's
settings under TMDB — without it, streams come back empty.

## Sources

| Source | Films | Series |
|---|:--:|:--:|
| CircleFTP | ✓ | ✓ |
| CTGMovies | ✓ | ✓ |
| Dflix(Dot) | ✓ | ✓ |
| DhakaFlix | ✓ | ✓ |
| ICC FTP | ✓ | ✓ |
| Nagordola | ✓ | ✓ |

## What you get

Each result carries the source, the quality and the file size, and series
results carry the episode they belong to:

```
Dflix(Dot)   1080p   4.4 GB
Dune (2021)
```

```
Nagordola   1080p   1.2 GB
Breaking Bad (2008)   S01E01
```

Quality and size are sent as their own fields rather than packed into the
heading, so Nuvio renders them as columns.

## How it works

Each file in `providers/` is self-contained and reads one library, using only
what the plugin runtime gives it — `fetch`, timers, and the standard globals.
No third-party libraries, no build step on your side, nothing downloaded at
runtime other than the pages being read.

Titles are matched by name and year against what the library actually files:
tolerating the year being off by one, preferring an exact title, and refusing a
near-miss that names a different work — so a request for *Saw* does not come
back with *SAW II*.

## Repository layout

```
manifest.json      the source list Nuvio reads
src/               the hand-written providers
providers/         GENERATED - src/common.js + src/<id>.js, this is what Nuvio downloads
build.py           regenerates providers/ and validates the manifest
test/              unit vectors and live checks
```

`providers/` is committed so that what a client downloads is reviewable. It is
built by `build.py`, which concatenates the shared helpers in `src/common.js`
ahead of each provider — so there is one copy of the matcher, not six.

```sh
python build.py            # regenerate
python build.py --check    # fail if providers/ is out of date
```

## Tests

```sh
node test/units.js         # helpers against 31,683 vectors
node test/run.js           # live checks against the six sources
node test/run.js --contract   # plus getStreams end to end
```

`test/units.js` is the important one. The shared helpers were ported from a
Python implementation of the same addon, and `test/vectors.json` holds that
implementation's own output — including 3,145 `difflib.SequenceMatcher` ratios,
which is the part that could not be transcribed and had to be rewritten. A
helper that quietly computes something slightly different would return a
different film for the same title, and nothing about that fails loudly.

`test/run.js` reads the real sources. It is not run in CI, which has no route to
them.

## Licence

MIT.
