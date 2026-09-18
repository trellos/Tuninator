# Changelog

## Unreleased

- On a direct input, a same-pitch re-articulation over which no energy
  arrived — the envelope after it no louder than the 80ms before it, with no
  pick-contact dip under it — now has to outlast half the local note interval
  before it is announced, the same rate gate that already held back a
  boundary with no dip. Fourteen fewer phantom Notes on the DI same-pitch
  takes; the amped renders are unchanged. `tracking.rateFragmentNoRiseRatio`
  and its two companions in `src/engine/config.ts`; DECISION-045.

## 0.2.0 — 2026-09-16

First release on npm.

Tuninator turns guitar microphone input into a stream of `Note`s that start
as soon as there is evidence something was played and are then revised as
the evidence improves — pitch refined, a bend recognised as a bend, a chord
blooming out of what first looked like a single string — every change
delivered as a typed `NoteChange`. UI-free, ESM, TypeScript, zero runtime
dependencies. Capture runs in an `AudioWorklet`; the recognition engine
runs on the main thread or, optionally, in a Web Worker.

- What it is and how to get a first Note out of it:
  [README](https://github.com/trellos/Tuninator#readme).
- The public surface — options, methods, events, error codes, the worklet
  asset, the Worker host:
  [docs/API.md](https://github.com/trellos/Tuninator/blob/v0.2.0/docs/API.md).
- Why a bend is one Note and a re-pick is two:
  [docs/NOTE-MODEL.md](https://github.com/trellos/Tuninator/blob/v0.2.0/docs/NOTE-MODEL.md).
- How well it does, measured against 459 hand-labelled events:
  [docs/EVALUATION.md](https://github.com/trellos/Tuninator/blob/v0.2.0/docs/EVALUATION.md).
- The reasoning behind every architectural choice:
  [DECISION_LOG.md](https://github.com/trellos/Tuninator/blob/v0.2.0/DECISION_LOG.md).

### About the version number

0.2.0 is the first version published. The 0.1 series existed only in this
repository's history — a per-frame pitch detector with caller-declared modes
— and 0.2 is a ground-up rewrite of it with no compatibility layer. If you
were building against a 0.1 checkout,
[docs/MIGRATION.md](https://github.com/trellos/Tuninator/blob/v0.2.0/docs/MIGRATION.md)
maps every old symbol to its replacement.

### Packaging

- ESM only, built for the browser. There is no `engines` field, because
  nothing in the package runs on Node.
- Entry points: `tuninator` (the library and its types), `tuninator/worklet`
  (the `AudioWorklet` capture bundle, to serve as a static asset) and
  `tuninator/engine-worker` (the engine as a module Worker, same again).
- No sourcemaps: the two maps were 70% of the unpacked package, and install
  weight was chosen over debugging the library inside a consumer's app.
  Build from source to step through it.
- Provenance: releases are published from GitHub Actions on a `v*` tag, so
  each version on npm is attested to the commit that built it.
