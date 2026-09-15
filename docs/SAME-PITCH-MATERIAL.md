# The 120bpm same-pitch material

Eight new fixtures — four takes, each captured as DI and through an amp sim —
recorded to close the gap DECISION-022 named: **the derivation set contains
about seven same-pitch re-articulations, all of them inside one take**, so every
derivation-set reading of the same-pitch decision has been a reading of a
mostly-different population.

This material is deliberately nothing but that phenomenon.

> **The labels in this set are PROVISIONAL.** They were generated, not
> hand-annotated by ear. Read "How the labels were made" before trusting a
> number computed against them, and see "Where the structure came from".

---

## The takes

| fixture stem | pitch | content | events |
|---|---|---|---|
| `same-pitch-quarters-a3-e5-120bpm-{di,amped}` | A3 then E5 | 8 measures of quarter notes on A3, then **10** measures on E5 | 72 |
| `same-pitch-eighths-a3-120bpm-{di,amped}` | A3 | eighth notes, then sixteenths from 20.0s | 184 |
| `same-pitch-eighths-sixteenths-e5-120bpm-{di,amped}` | E5 | 8 measures of eighths, then 8 measures of sixteenths | 192 |
| `held-then-picked-six-strings-120bpm-{di,amped}` | F#2 C3 G3 C4 G4 D5 | per pitch: 4 cycles of [one measure held, one measure of quarter notes] | 120 |

All at 120bpm, so a sixteenth is 125ms — just above the corpus's tightest
subdivision (a sixteenth at 140bpm is 107ms).

**`held-then-picked` is the one to reach for first.** It puts the positive and
the negative class on identical material: a measure where one pick must produce
exactly one Note, immediately followed by a measure where four picks must produce
exactly four, at the same pitch, on the same string, through the same signal
chain. Nothing else in the corpus separates "a boundary the player put there"
from "a boundary the recognizer invented" that cleanly, and it covers all six
strings from F#2 to D5.

## Why these are not in `fixtures/eval.config.json`

Deliberately. A fixture with no config entry is reported by `npm run eval` and
**gates nothing** — the eval prints a warning naming it and scores it with an
empty config. That is the correct state for material whose labels have not been
reviewed. Adding thresholds is a decision for after the labels are confirmed.

They are also **not yet assigned to derivation or held-out.** That assignment is
the point of DECISION-022 and should be made deliberately, take by take — and
note that the DI and amped renders of one take are the *same performance*, so
they must land on the same side of the split or the split leaks.

Also note: three scripts decide derivation-vs-held-out three different ways —
`measure-decision-separability.ts` and `measure-same-pitch-population.ts` both
test `stem.includes("140bpm")`, while `measure-dp-segmentation.ts` matches an
explicit `DERIVATION` list by `startsWith`. These stems contain no "140bpm", so
the first two file them as derivation and the third files them as held out.
**Whichever way the split is decided, all three predicates need updating
together.**

## How the labels were made

Two inputs, neither of them the detector:

1. **Structure** — the player's own description of what he played.
2. **Onsets** — a plain broadband RMS envelope (20ms window, 5ms hop) with an
   envelope-rise onset rule, written specifically for this job.

**Tuninator was not used to place any label.** Using the detector's output to
decide what a label should be is circular, and `AGENTS.md` §3 calls it out by
name.

Pitches were confirmed independently by autocorrelation of the raw audio:
A3 ≈ 220.5Hz, E5 ≈ 658.2Hz, and the six strings of `held-then-picked` at
F#2 ≈ 92.8, C3 ≈ 130.9, G3 ≈ 196.0, C4 ≈ 260.9, G4 ≈ 390.3, D5 ≈ 588.0Hz.

Two placement methods, per take:

- **`quarters` and `held-then-picked`** — the envelope detector found *exactly*
  as many onsets as the structure predicts (72 and 120), so events are mapped
  one-to-one onto measured onsets. These carry real onset times, not a grid.
- **`eighths` and `eighths-sixteenths`** — the runs are too fast for the
  envelope rule to resolve every pick, so events sit on a fixed subdivision grid
  anchored on the first measured onset, with a single median-offset correction
  fitted across the take. The subdivision is musical; only the anchor is
  measured.

Each take was then **calibrated once** against `verify-fixtures.ts`'s own attack
search — which is deliberately cruder than, and independent of, the engine's
spectral flux — by shifting the whole label set so its median offset lands near
zero, where the rest of the corpus already sits. The shifts were +55ms
(quarters), +20ms (eighths A3), +30ms (eighths+sixteenths E5) and +80ms
(held-then-picked), each derived from the DI render and applied to both, since
the pair is one performance.

### What `npx tsx scripts/verify-fixtures.ts` says about them

| fixture | labels | concerns | p10 | median Δ | p90 |
|---|---|---|---|---|---|
| `same-pitch-quarters-a3-e5-120bpm-di` | 72 | **0** | −35 | **0** | 25 |
| `same-pitch-quarters-a3-e5-120bpm-amped` | 72 | 68 | −60 | −35 | 0 |
| `same-pitch-eighths-a3-120bpm-di` | 184 | 61 | — | **10** | — |
| `same-pitch-eighths-a3-120bpm-amped` | 184 | 182 | — | 65 | — |
| `same-pitch-eighths-sixteenths-e5-120bpm-di` | 192 | 48 | −25 | **0** | 30 |
| `same-pitch-eighths-sixteenths-e5-120bpm-amped` | 192 | 116 | −5 | 25 | 55 |
| `held-then-picked-six-strings-120bpm-di` | 120 | **2** | −50 | 50 | 130 |
| `held-then-picked-six-strings-120bpm-amped` | 120 | 59 | −5 | 45 | 115 |

For scale, existing fixtures on the same measure: `chords-a-bm-g-d` median −20,
`clean-lead-120bpm` +27, `lead-line-di-sixteenths` −9.

**The DI renders are in good shape.** Two of the four have essentially no
concerns; `held-then-picked-di` in particular went from 61 concerns to 2 under
calibration, which is the take that matters most.

**The amped renders carry far more concerns, and that is mostly the verifier, not
the labels.** An amp sim compresses the envelope until a crude rise test can
barely locate a pick, and its distortion crowds the chroma so pitch support reads
badly. Same "attack contrast varies 2.0×–24.2× across the corpus" problem the
evaluation already documents — worth having in the corpus, and a reason not to
read the amped rows as a verdict on the labels. Their timings are the DI
timings, and the two renders are time-aligned: first-audible differs by 50ms on
`held-then-picked` and 10ms on `quarters`, with identical file lengths.

The A3 eighths take's DI concern count rose from 6 to 61 when its sixteenth
section was labelled, which is the verifier finding fast quiet picks over a
ringing note hard to confirm — the same difficulty the take exists to capture.

## What the recognizer does on it today

`npx tsx scripts/measure-splits.ts`, with the material landed and nothing in
`src/` changed:

| fixture | labels | split | extras | worst |
|---|---|---|---|---|
| `same-pitch-quarters-a3-e5-120bpm-di` | 72 | 6 | 6 | 2 |
| `same-pitch-quarters-a3-e5-120bpm-amped` | 72 | **51** | **81** | 4 |
| `same-pitch-eighths-a3-120bpm-di` | 184 | 6 | 6 | 2 |
| `same-pitch-eighths-a3-120bpm-amped` | 184 | **56** | **60** | 3 |
| `same-pitch-eighths-sixteenths-e5-120bpm-di` | 192 | 21 | 21 | 2 |
| `same-pitch-eighths-sixteenths-e5-120bpm-amped` | 192 | 29 | 37 | 3 |
| `held-then-picked-six-strings-120bpm-di` | 120 | 8 | 8 | 2 |
| `held-then-picked-six-strings-120bpm-amped` | 120 | **60** | **77** | 5 |

Corpus total moves from 99 of 459 events split to **336 of 1595, 403 extra
Notes**.

**The signal path dominates.** These are pairs: the same performance, the same
label timings, differing only in whether the capture is direct or through an amp
sim. Split rates go 8% → 71% on the quarters take, 3% → 30% on the A3 eighths,
and 7% → 50% on held-then-picked. Up to five Notes on a single played event.

That is a sharper statement of the problem than the corpus could previously
make, and it points somewhere specific: whatever separates a real re-pick from a
spurious boundary is surviving a direct input and collapsing under compression
and distortion. It also fits the standing measurement that attack contrast varies
2.0×–24.2× across the corpus and up to 106× within one take.

### What SHAPE those splits are

Measured in DECISION-027, on an instrument that reads no label onset —
`measure-tail-fragments.ts`, added because this material's amped labels carry up
to 65ms of placement offset and the existing shape classifier's buckets are 45ms
wide:

| fixture | extras | same pitch, contiguous | detached | other pitch |
|---|---|---|---|---|
| `same-pitch-quarters-a3-e5-120bpm-amped` | 63 | **63** | 0 | 0 |
| `same-pitch-eighths-a3-120bpm-amped` | 53 | **53** | 0 | 0 |
| `same-pitch-eighths-sixteenths-e5-120bpm-amped` | 36 | **36** | 0 | 0 |
| `same-pitch-eighths-sixteenths-e5-120bpm-di` | 19 | **19** | 0 | 0 |
| `same-pitch-eighths-a3-120bpm-di` | 3 | **3** | 0 | 0 |
| `same-pitch-quarters-a3-e5-120bpm-di` | 1 | **1** | 0 | 0 |

Every extra Note on all six, without exception, is at the label's own pitch
class and butted against its neighbour. This material does exactly what it was
recorded to do. Note also that the median SHORTEST Note in a split event across
the corpus is 93ms — above `tracking.minStableMs` (55) and `deep.minSegmentMs`
(90) — so these are not sub-threshold blips.

Beware `measure-split-shape.ts` on this material specifically: until
DECISION-027 it tested the previous label's name before the label's own, which
makes its `same pitch twice` bucket unreachable whenever consecutive labels
share a pitch — which here is almost every label. It reported one such split on
a 184-label take where all 184 labels are A3.

Two cautions before building on these numbers. The labels are provisional, and
the amped labels carry the most `verify-fixtures.ts` concerns — though note the
timings are identical to the DI ones, so the 8-vs-60 gap on one performance
cannot be a labelling difference. And `same-pitch-eighths-a3` has an open
structural question below.

## Where the structure came from

Both open questions have been answered by the player, and one of my answers was
wrong. Recorded here because the correction is instructive.

1. **`quarters`: the E5 section really is 10 measures, not 8** — confirmed.
   Verified twice, independently: pitch is A3 for exactly 32 onsets and changes
   at 17.980s, leaving 40 onsets after it, evenly spaced at 0.500s throughout.
   32/4 = 8.00 measures and 40/4 = 10.00 measures exactly. The labels follow the
   audio.
2. **`eighths A3` does contain a sixteenth section, starting at 20.0s** — the
   player listened and said so, and the labels now say so: 72 eighths, then 112
   sixteenths from 19.960s, ending at 33.835s against a last measured onset of
   33.870s.

   **I had previously reported that this take had no sixteenth section at all,
   on three converging measurements. That was a false negative.** Worth the space,
   because the failure is the kind this repository already documents. Onset
   spacing said eighths because the envelope rule drops roughly half the picks in
   a fast same-pitch run — exactly the material it is worst at. Envelope
   modulation and autocorrelation said eighths because I compared this take's
   absolute figures against *the E5 take's*, when the two are voiced differently:
   in the E5 take the strongest envelope periodicity sits at the note period,
   while in the A3 take it sits at twice it, on the accent. Measured against
   itself over time the A3 take does drop from a 0.5s peak lag to 0.25s after
   20s, which is the boundary — but I read the cross-take comparison first and
   stopped.

   Three statistics agreeing is not three pieces of evidence when they share a
   premise. The ear settled it in one listen.

Neither take's subdivision can be resolved reliably by the crude envelope tools
used here. Treat any future claim about subdivision in this material as needing
a human listen, and note that this difficulty is itself the property the
material was recorded for.

## Before relying on this material

```bash
npx tsx scripts/verify-fixtures.ts        # audible / attack-aligned / pitch-supported
npx tsx scripts/measure-same-pitch-population.ts   # re-run DECISION-022's count
```

`verify-fixtures.ts` is the one that matters: it checks each label against the
audio independently, and it is the cheapest way to catch a systematic error in
a generated label set before anything is derived from it.

## The amped re-timing pass: two takes proposed, two refused

`scripts/propose-amped-onsets.ts` derives onsets for the four amped renders from
the amped audio itself — a plain signal measurement, sharing no constant and no
line of code with Tuninator, which is never consulted. It writes a proposal to a
`--out` directory, has no `--write` mode, and refuses any path under `fixtures/`.
Proposals are scored by importing `verifyFixture` from `verify-fixtures.ts`, so
the before/after numbers come from that script's own code, constants and concern
wording rather than a lookalike.

| take | events in → out | median shift | placement |
|---|---|---|---|
| `quarters-a3-e5-amped` | 72 → 72 | 0ms | no change proposed; still matches DI |
| `eighths-a3-amped` | 183 → 183 | **−187ms** | proposed (p10 −240, p90 −137) |
| `eighths-sixteenths-e5-amped` | 190 → 190 | **−215ms** | proposed (p10 −241, p90 −187) |
| `held-then-picked-amped` | 120 → 120 | — | **refused, see below** |

Event counts are identical in and out everywhere; no pitch, name, id or ordering
was touched.

**Where the evidence is real.** On `e5-amped` — the only amped render with
enough findable attacks to measure placement at all — the proposal takes the
error against the independent attack search from **|Δ| median 25ms to 8ms**, p90
55ms to 20ms. That is better than the DI render's own 13ms. It was computed
after the method was fixed, with nothing tuned on it.

**`held-then-picked-amped` is a clean no.** The prominence method fails its own
DI control at a 105ms interquartile spread on clean audio — 2s held notes defeat
an envelope peak-picker, which is the same class of error as a window wider than
the spacing it discriminates. The only move on offer was −15ms, inside the
40.7ms spread of the measurement that would justify it, and applying it made the
concern count worse (59 → 61). Refusing is the result.

**The concern count is not the target, and this is the measurement behind that.**
Every concern on all eight renders is "no energy rise near `startMs`". The
verifier's rule fires legitimately only 10, 7, 80 and 75 times against 72, 183,
190 and 120 labels; the rest is a head noise floor above the engine's `rmsGate`,
at 14.3% and 31.3% of envelope peak on two amped renders. The floors below which
no label placement can take these counts are 62, 176, 110 and 45. This is what
"that is mostly the verifier, not the labels" above was asserting, now measured.

**Structural disagreement, untouched and the owner's.** `e5` carries 191 DI
events against 190 amped for one performance, and the two sets disagree about
which picks exist — DI-only `s1626` and `s16128`, amped-only `s1628`; on
`eighths-a3`, DI-only `e838` and amped-only `s1692`. Both cannot be true. No
proposal changes a count, so this is unresolved.

### What applying the proposal does to the reported numbers — and why that is not a validation

Measured in a throwaway detached worktree with the two proposals overlaid;
nothing under `fixtures/` in the repository was touched. The twenty-three
untouched fixtures read bit-identically, as they must.

| | labels | Notes | missed | false pos | pitch class | exact | onset median abs |
|---|---|---|---|---|---|---|---|
| `eighths-a3-amped` now | 183 | 218 | 9 | 44 | 95.1% | 87.4% | 31ms |
| `eighths-a3-amped` proposed | 183 | 218 | **10** | **45** | **94.5%** | 87.4% | **37ms** |
| `eighths-sixteenths-e5-amped` now | 190 | 209 | 13 | 32 | 92.6% | 92.6% | 27ms |
| `eighths-sixteenths-e5-amped` proposed | 190 | 209 | 13 | 32 | 92.6% | 92.6% | **18ms** |

Corpus-wide: 137 missed to 138, 345 false positives to 346, pitch class 89.9%
unchanged, exact 84.9% unchanged. `measure-splits.ts` goes 340 split / 410
extras to 354 / 421, because moving a label changes which Note it pairs with.

**Read the direction of inference carefully, because it is the trap this
material exists to avoid.** None of the above is evidence about whether the
labels are right. Judging a label by whether the recognizer scores better
against it is precisely the circularity `AGENTS.md` §3 forbids — a detector and
a label set can agree because both are wrong in the same direction, which on a
DI-derived label set applied to an amped render is the expected failure, not an
unlikely one. The non-circular instrument is `verify-fixtures.ts`'s independent
attack search, and it says `e5-amped` improves from 25ms to 8ms while
`a3-amped` **has no measurable anchor at all** — the hiss swamps the rise, so
its proposal rests on a whole-render cross-correlation rather than on located
attacks.

Two conclusions follow.

**The corpus numbers were never being held back by this.** A 187–215ms label
error on two amped takes moves the corpus by one missed label and one false
positive. Anyone hoping a label review would unlock an accuracy gain should
stop hoping: it will not, and that is worth knowing before the review rather
than after.

**Propose `e5-amped`; hold `a3-amped` for a listening pass.** `e5` improves on
the independent measure and costs nothing on the dependent one. `a3` improves on
neither: its independent anchor is unmeasurable and the recognizer's own onset
error gets *worse* (31ms to 37ms) while it loses a label. That disagreement does
not prove the proposal wrong — the detector is not a judge here — but a proposal
with no independent support and a dependent measure pointing the other way is
exactly the one a human should place by ear.
