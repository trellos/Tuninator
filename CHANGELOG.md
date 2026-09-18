# Changelog

## Unreleased

- On a direct input, a same-pitch re-articulation over which no energy
  arrived — the envelope after it no louder than the 80ms before it, with no
  pick-contact dip under it — now has to outlast half the local note interval
  before it is announced, the same rate gate that already held back a
  boundary with no dip. Fourteen fewer phantom Notes on the DI same-pitch
  takes; the amped renders are unchanged. `tracking.rateFragmentNoRiseRatio`
  and its two companions in `src/engine/config.ts`; DECISION-045.
- A Note that opened on a pick's contact — the fine witness's transient, or an
  attack with no rise over the 80ms before it — now moves its boundary to the
  pick's release: the first attack inside one articulation window whose rise
  over the muted string clears `tracking.releaseRiseRatio`. On the direct
  input a slow stroke's Note used to start 45–70ms before the note sounded,
  and the note before it ended as early; on the E5 eighths DI take 22
  boundaries move to within 25ms of their labels and five fewer slow events
  split. A stub the release split off is still absorbed. DECISION-046.
- The local note-rate estimate, which sets how long a suspected tail
  fragment must outlast before it is announced, no longer counts an opening
  that never became a Note: a stub absorbed into its successor or a
  fragment dropped before announcement is struck out once that is known.
  The estimate read 0.85 of the true interval before and 0.96 after; eight
  fewer phantom Notes on the amped quarters take and none lost.
  `tracking.paceIgnoresRetracted`; DECISION-048.
- The release test that moves a contact-opened Note's start now reads the
  hop the amplitude gate refused, since on a direct input the string under
  the pick can still be under the gate when its release begins, and
  measures its 80ms window in samples, where six hops is inside it rather
  than 0.0000000000018ms past it. Two more direct-input boundaries sit on
  the release; nothing lost on either set. `tracking.releaseOnGatedHop`;
  DECISION-050.
- That release test now also reads a Note the fine witness opened, on the
  frame that opens it — the witness confirms a contact 65ms late, so the
  contact can arrive on the release's own hop, in a Note born settled — and
  the move keeps the Note's announce clock on the contact, so a stroke whose
  release barely re-excites the string is still a Note where it was one
  before. Two more direct-input boundaries sit on the release, one phantom
  fewer, nothing lost on either set. `tracking.releaseOnFineOpenedFrame`;
  DECISION-052.

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
