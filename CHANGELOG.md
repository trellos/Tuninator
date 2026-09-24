# Changelog

## Unreleased

- On a direct input, a note damped nearly silent and then picked again is
  now split at the pick even when its first transient lands on a hop the
  amplitude gate refuses: the Note ends there once the level comes back.
  With it, a split whose burst began on the pick's contact is placed on
  the release instead of backdated onto the contact. Sixteen more labels
  found on the derivation takes, none lost; two fewer slow DI splits; the
  amped renders are unchanged. `tracking.gatedRepickDipRatio`,
  `tracking.burstContactRiseRatio`; DECISION-080, DECISION-081.
- On a direct input, a stroke whose release lands under the amplitude gate
  now starts at that release even when the fine onset witness reports the
  pick's contact only afterwards; it used to start on the contact, 56 to
  61ms early, and split again. Two fewer slow DI splits on the quarters
  take. `tracking.releaseBeforeFineContact`; DECISION-082.
- A label marked `required: false` is now optional in the evaluation: a
  Note on it is not an extra, and missing it is not a miss. The A3 eighths
  DI take gains six picks from the owner's fourth listening pass, two of
  them optional; the one DI slow split there was a real pick. DECISION-083.

## 0.21.0 — 2026-09-24

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
- The region lane's envelope-rise boundary, which sat at the start of the
  85ms window that noticed the rise — in the mute on a slow direct-input
  stroke, 45–65ms before the string sounds — now sits on the first
  broadband transient inside that window whose rise over the muted string
  clears `tracking.releaseRiseRatio`, with the rise read on the
  transient's hop or the one after it, since the rise witness lags the
  flux by a hop. And when the region lane carves a successor out of the
  end of a Note, it now sees every Note the tracker still holds, so a
  boundary that coincides with a Note the fast lane already opened carves
  nothing instead of a second Note beside it — seven such duplicates on
  the 120bpm same-pitch takes, three of them through the amp. Six more
  direct-input boundaries on the release, two labels regained, seven false
  positives fewer; on the held-out takes three short Notes appear and one
  label trades for another. `deep.segmentRiseOnRisingTransient`,
  `deep.regionCarveSeesEveryNote`; DECISION-055.
- A Note the region lane carved out of the stretch between a note's end and
  the next stroke's release, on which the fast lane heard no pitch for at
  least half its hops — the string half-stopped under the fretting hand —
  is now that stroke's preparation, absorbed into it, whatever boundary the
  region put at its start and whatever pitch it read. Before, the region's
  attack boundary on the pick's contact kept the offer from being made and
  93ms of muted string stood as a Note. Two such Notes gone on the
  direct-input held-then-picked take and two on the held-out DI triplet
  take, one amped duplicate gone; one label on the held-out mic triplet
  take is lost to a Note whose pitch the detector dropped while the string
  still sounded. `tracking.prefixUnderHand`,
  `tracking.underHandUnvoicedFraction`; DECISION-058.
- The string-under-the-hand witness now reads the level as well as the
  pitch: a carved Note is absorbed into the next stroke only when it also
  fell to at most half its own peak. Through a microphone a sustained note
  whose pitch the detector lost while it still rang had read as muted
  string and taken a real note with it; it no longer does. The direct-input
  and amped tuning takes are unchanged. `tracking.underHandLevelFall`;
  DECISION-062.

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
