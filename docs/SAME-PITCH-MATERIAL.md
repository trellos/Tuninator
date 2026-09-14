# The 120bpm same-pitch material

Eight new fixtures — four takes, each captured as DI and through an amp sim —
recorded to close the gap DECISION-022 named: **the derivation set contains
about seven same-pitch re-articulations, all of them inside one take**, so every
derivation-set reading of the same-pitch decision has been a reading of a
mostly-different population.

This material is deliberately nothing but that phenomenon.

> **The labels in this set are PROVISIONAL.** They were generated, not
> hand-annotated by ear. Read "How the labels were made" before trusting a
> number computed against them, and see "What still needs confirming".

---

## The takes

| fixture stem | pitch | content | events |
|---|---|---|---|
| `same-pitch-quarters-a3-e5-120bpm-{di,amped}` | A3 then E5 | 8 measures of quarter notes on A3, then **10** measures on E5 | 72 |
| `same-pitch-eighths-a3-120bpm-{di,amped}` | A3 | **16 measures of eighth notes** | 128 |
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
(quarters), +45ms (eighths A3), +30ms (eighths+sixteenths E5) and +80ms
(held-then-picked), each derived from the DI render and applied to both, since
the pair is one performance.

### What `npx tsx scripts/verify-fixtures.ts` says about them

| fixture | labels | concerns | p10 | median Δ | p90 |
|---|---|---|---|---|---|
| `same-pitch-quarters-a3-e5-120bpm-di` | 72 | **0** | −35 | **0** | 25 |
| `same-pitch-quarters-a3-e5-120bpm-amped` | 72 | 68 | −60 | −35 | 0 |
| `same-pitch-eighths-a3-120bpm-di` | 128 | 6 | −40 | **10** | 50 |
| `same-pitch-eighths-a3-120bpm-amped` | 128 | 126 | 40 | 80 | 80 |
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

Three labels are flagged as unsupported by the audio, all in the A3 eighths take
(`e882`, `e899`, `e8100`) — the same take whose structure is in question below.

## What the recognizer does on it today

`npx tsx scripts/measure-splits.ts`, with the material landed and nothing in
`src/` changed:

| fixture | labels | split | extras | worst |
|---|---|---|---|---|
| `same-pitch-quarters-a3-e5-120bpm-di` | 72 | 6 | 6 | 2 |
| `same-pitch-quarters-a3-e5-120bpm-amped` | 72 | **51** | **81** | 4 |
| `same-pitch-eighths-a3-120bpm-di` | 128 | 11 | 11 | 2 |
| `same-pitch-eighths-a3-120bpm-amped` | 128 | **85** | **95** | 3 |
| `same-pitch-eighths-sixteenths-e5-120bpm-di` | 192 | 21 | 21 | 2 |
| `same-pitch-eighths-sixteenths-e5-120bpm-amped` | 192 | 29 | 37 | 3 |
| `held-then-picked-six-strings-120bpm-di` | 120 | 8 | 8 | 2 |
| `held-then-picked-six-strings-120bpm-amped` | 120 | **60** | **77** | 5 |

Corpus total moves from 99 of 459 events split to **370 of 1483, 443 extra
Notes**.

**The signal path dominates.** These are pairs: the same performance, the same
label timings, differing only in whether the capture is direct or through an amp
sim. Split rates go 8% → 71% on the quarters take, 9% → 66% on the A3 eighths,
and 7% → 50% on held-then-picked. Up to five Notes on a single played event.

That is a sharper statement of the problem than the corpus could previously
make, and it points somewhere specific: whatever separates a real re-pick from a
spurious boundary is surviving a direct input and collapsing under compression
and distortion. It also fits the standing measurement that attack contrast varies
2.0×–24.2× across the corpus and up to 106× within one take.

Two cautions before building on these numbers. The labels are provisional, and
the amped labels carry the most `verify-fixtures.ts` concerns — though note the
timings are identical to the DI ones, so the 8-vs-60 gap on one performance
cannot be a labelling difference. And `same-pitch-eighths-a3` has an open
structural question below.

## What still needs confirming

Two places where the audio does not match what was described. Both need the
player's answer, and until they have one the affected labels are guesses:

1. **`quarters`: the E5 section is 10 measures, not 8.** The pitch changes at
   17.970s; A3 runs 32 notes (8 measures) and E5 runs 40 (10 measures), 72 in
   total, evenly spaced at 0.500s throughout. The labels follow the audio.
2. **`eighths A3`: no sixteenth section could be found.** It was described as 8
   measures of eighths then 8 of sixteenths. Three independent measurements
   disagree, and all three say eighths throughout: onset spacing stays at a
   median of 0.245s in the second half (the E5 take drops to 0.140s there);
   envelope modulation never favours 8Hz over 4Hz (peak ratio 0.80, against 1.09
   and 1.15 on the E5 take); and envelope autocorrelation in the second half
   peaks at 0.5s with the 0.125s lag *negative*. The labels are written as 16
   measures of eighths, 128 events. If a sixteenth section was intended and
   played, these labels are wrong and the take should be relabelled or re-cut.

`eighths-sixteenths E5` was confirmed as described by the same three measures.

## Before relying on this material

```bash
npx tsx scripts/verify-fixtures.ts        # audible / attack-aligned / pitch-supported
npx tsx scripts/measure-same-pitch-population.ts   # re-run DECISION-022's count
```

`verify-fixtures.ts` is the one that matters: it checks each label against the
audio independently, and it is the cheapest way to catch a systematic error in
a generated label set before anything is derived from it.
