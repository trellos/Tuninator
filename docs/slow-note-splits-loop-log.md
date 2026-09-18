# Slow-note splits loop — journal

The hand-off between iterations of `docs/slow-note-splits-loop-prompt.md`.
Each iteration is a fresh session; this file is the only thing it inherits.
Newest iteration at the bottom, so the file reads as a history; the ledger and
the blockers sections are living and edited in place.

## How to use this file

1. Reproduce the latest numbers before doing anything (the brief, §11 step 1).
2. Read the candidate ledger and the blockers. Do not re-run a spent row.
3. Append an iteration entry using the template. Fill in every line; "not
   measured" is an acceptable value, a missing line is not.
4. Update the ledger (mark rows spent, add new ones) and the blockers.
5. If the exit rule fires, write the exit report at the end.

## Baseline — 2026-09-18, `main` at `1c5e632`

`npm ci` (Node 22.22 in the environment that took these; `.nvmrc` says 20),
`npx tsc --noEmit`, `npm test` 511 passing (30 files, ~17s), `npm run eval`
**PASS** with zero required failures and the one pre-existing informational
failure (`power-chords-b-a-g-fsharp-b-a-g-e-140bpm`, exact 72.7% against an
80% informational bar). Eval takes about 1m45s here; each `measure-*` script
about 1m30s.

### The slow subset — `npx tsx scripts/measure-splits.ts --subset=slow`

754 quarter- and eighth-note labels. The subset rule is in the script header.

| fixture | slow labels | split | extras | worst | strays (whole take) |
|---|---|---|---|---|---|
| `held-then-picked-six-strings-120bpm-amped` | 120 | 47 | 59 | 5 | 0 |
| `held-then-picked-six-strings-120bpm-di` | 120 | 8 | 8 | 2 | 1 |
| `lead-line-amped-quarter-eighth-triplet-140bpm` | 31 | 21 | 22 | 3 | 1 |
| `lead-line-di-quarter-eighth-triplet-140bpm` | 31 | 7 | 8 | 3 | 0 |
| `lead-line-quarter-eighth-triplet-140bpm` (room mic) | 31 | 10 | 11 | 3 | 1 |
| `clean-lead-120bpm` quarters | 7 | 0 | 0 | 1 | 0 |
| `same-pitch-eighths-a3-120bpm-amped` eighths | 71 | 37 | 42 | 4 | 2 |
| `same-pitch-eighths-a3-120bpm-di` eighths | 71 | 6 | 6 | 2 | 0 |
| `same-pitch-eighths-sixteenths-e5-120bpm-amped` eighths | 64 | 24 | 32 | 3 | 2 |
| `same-pitch-eighths-sixteenths-e5-120bpm-di` eighths | 64 | 22 | 22 | 2 | 0 |
| `same-pitch-quarters-a3-e5-120bpm-amped` | 72 | 50 | 79 | 4 | 4 |
| `same-pitch-quarters-a3-e5-120bpm-di` | 72 | 9 | 10 | 3 | 0 |
| **DI (365 labels)** | | **52** | **54** | | |
| **amped + room mic (389 labels)** | | **189** | **245** | | |
| **total (754)** | | **241** | **299** | | |

Of the 241, 213 come out with every Note at the label's own pitch class — the
same-pitch tail-fragment shape. The other 28 carry a Note at another pitch
class (a neighbour's name, `unknown`, or a harmonic the estimator locked onto).

### The corpus — both axes

```
measure-splits.ts             316 of 1592 events split, 379 extra Notes, 20 strays
                              (overlap rule: 1095 split, 1459 extra)
measure-tail-fragments.ts     267 split events, 290 extra: 267 same pitch, 0 detached, 23 other pitch
                              median shortest Note in a split event 93ms, median longest 227ms
measure-downstream-ledger.ts  MISSED 137 of 1592, detections 1766
```

Ledger MISSED by fixture (non-zero only): clean-lead 2; held-then-picked amped
1, DI **14** (7 `rejected: gated`, 3 `ring-out-not-sharp`, 3 `band-only
transient`, 1 no transient); amped sixteenths 12; DI sixteenths 2; mic triplet
2; mic sixteenths 8; same-pitch eighths A3 amped 9, DI **63** (38 no transient,
8 never announced, 6 band-only, 4 gated, 3 ring-out-not-sharp); E5 amped 13,
DI 8; quarters amped 2, DI 1.

By material (the derivation predicate is "not 140bpm" — the five originals
plus the eight same-pitch takes, per DECISION-028; held-out is the twelve
140bpm takes): derivation 2 + 111 = 113 missed; held-out 24 missed.

### Where the wrong boundaries are accepted — `measure-split-cause.ts`

Same-pitch contiguous fragments by the site that accepted the boundary,
corpus-wide: **sharpness 175**, envelope-rise 35, no accepted re-articulation
within 60ms 27, new-pitch 21, ring-out-sharpness 4, fine-onset 3,
chord-decay-excess 2 (total 267). Sharpness at those boundaries: p10 1.86,
median 3.85, p90 10.06, against a bar of 1.6. On the amped quarters take 53 of
60 are `sharpness`; on the amped A3 eighths 46 of 51; on held-then-picked
amped 18 of 30.

### Shape — `measure-split-shape.ts`

267 split events: `predecessor's own` 127 (an upper bound on the amped
same-pitch takes, whose labels carry up to 65ms of offset), `same pitch twice`
106, `named as neither` 27, `named as before` 7.

### An observation taken while building the baseline — unmeasured, a lead

On the amped renders the phantom is often named an octave or two above the
label: `A3 + A5`, `F#2 + F#5`, `C3 + C5`, `G3 + G5`. Counted over
`measure-splits.ts --detail`, 38 of 249 same-pitch-class split events carry an
octave-displaced Note (amped quarters 7 of 49, amped A3 eighths 16 of 55,
held-then-picked amped 11 of 40, every DI take 0 or 1). The eval report's
`octaveOnlyCount` puts MATCHED Notes octave-off at 15 of 363 on those three
amped takes. About 15% against 4%. It is the brief's door 2, third bullet: one
bench row on the outcome-shaped population, and not a gate on its own.

### The direct input, specifically — the owner's failing setup

**Correction, 2026-09-18, from the owner:** the tutorial fails on a direct
input into a computer. The phone-microphone setup has not been tried. The DI
column above is therefore the target, and it has two shapes:

- **Same-pitch splits accepted by `envelope-rise`.** `measure-split-cause.ts`,
  whole takes, the five DI takes with slow material (40 same-pitch
  fragments): `envelope-rise` 20, `sharpness` 8, `fine-onset` 3,
  `ring-out-sharpness` 3, no re-articulation decision 4, `new-pitch` 2. The
  amped renders are `sharpness` 53 of 60, 46 of 51, 18 of 30. Different test,
  different mechanism. The E5 eighths DI take is the worst slow DI cell, 22
  of 64, every one `E5 + E5`.
- **Low-string re-picks refused at the gate, not split.**
  `held-then-picked-di` misses 14 of 120; the seven `rejected: gated` are
  re-picks of F#2, C3 and C4 at 413–1400ms into the note with the kernel
  fired and sharpness 1.9–6.9 (`measure-downstream-ledger.ts --all --detail`).
  The tutorial's steps 1 and 2 are the low root and the high root picked on 1
  and 3 with a rest between — a same-pitch re-pick over a string still
  ringing, this take's shape. Whether the owner's rig is gated is unknown
  (blockers).
- The lead-line DI take's seven slow splits all carry a neighbour's name
  (`A4 + A#4 + B4`, `C5 + B4`): the pitch-lag / prefix shape, not the tail.

### What the consumer does with a split — read from GOATerizer on 2026-09-18

`trellos/goaterizer` at `d903ccc`, on `tuninator@0.2.0` (the engine measured
above). Its capture path IS this library's: `createRecognizer()` opens the
microphone itself, with `echoCancellation`, `noiseSuppression` and
`autoGainControl` all explicitly `false`, `channels: "auto"`, on an
`AudioContext` the game creates with `latencyHint: "interactive"` and no
sample rate. Three things about that path are NOT what the eval runs:

- **The gate.** After a calibration the game passes `engine.rmsGate` as low
  as 0.00008, a hundredth of the shipped 0.008 (`src/game/input-gate.ts`,
  `persistence/input-gate.ts`). Every re-articulation witness then sees hops
  of sustain tail and noise the eval never lets through. Nothing in this
  corpus has been measured at a lowered gate. Ledger row C7.
- **The sample rate.** The context runs at the device's rate; every fixture
  here is 48kHz. At 44.1kHz `snapHop(12ms)` is 512 samples = 11.6ms (13.3ms
  at 48kHz), the 2048-sample YIN window is 46.4ms and the deep window 92.9ms;
  every millisecond-denominated constant is honoured but the hop grid, the
  17-hop flux median and the 128-sample fine-onset kernel all read audio on a
  different grid. Ledger row C8.
- **Diagnostics on** (`pitchFrames`, `contour`), which changes nothing in the
  tracker but does mean the game reads `rms` on every hop.

What a split costs the player (`src/game/judgment.ts`): a target is claimed at
the attack and **judged at the release**. A release inside the target's Good
window of its end keeps the attack's verdict; a note held for less than half
its written length settles as a **Miss**; held longer but let go outside the
window, a Good. So a quarter split 130ms in at 120bpm (0.26 beat against a
1-beat target) is a Miss for a note played on time, and the same-pitch
fragment that follows either claims the next target early or is charged as a
wrong note. Absorption would refund all of that, but the engine never absorbs
a same-pitch tail today, so the refund never comes. The tutorial asks for
exactly this material: quarters, then eighths, then eighth triplets, at the
player's chosen tempo (60, 90, 106, 120 or 140bpm), on one lane per step.

### Eval end-time error, for the consumer's duration question

Signed median end error on the slow takes: amped quarters **-237ms** (the
first Note of a split pair ends at the phantom boundary), amped triplet -40,
DI triplet -42, held-then-picked amped -57, DI -42, quarters DI -55. The
duration a rhythm game reads is the first Note's, and on the amped quarters it
is half a beat short at the median.

---

## Candidate ledger (living)

| id | mechanism | lane | nearest closed relative and the difference | falsifier | status |
|---|---|---|---|---|---|
| C1 | Joint decode over the fast lane's accepted boundaries in a region, scored by IOI regularity across the phrase with the boundary witnesses as a prior; a dropped boundary is an absorption | deep | DECISION-011 (DP over windows, decay-residual cost at chance — no such term here); DECISION-037 (one fragment vs one scalar rate — no rate estimate here); the gap shape (0.779, +7 missed — must beat its exchange rate) | more derivation extras removed than the shipped rate gate at +0 missed; held-out not worse; slow subset per path | open (brief §5 door 1) |
| C2a | HPSS percussive-component flux at fine hop as a re-pick witness | fast/deep | 1–6kHz attack band; click witness (DECISION-018) | 0.80 AUC on the outcome-shaped population, amped takes, derivation | **closed, iteration 2**: percussive flux 0.58 (1kHz+, 11 and 15 hop medians), percussive fraction 0.65–0.68 on the amped column; 0.81 on DI, where the envelope rise already reads 0.91 |
| C2b | Band-limited (1–6kHz) envelope dip | fast | DECISION-028 (d) varied window length, not band | 0.80 AUC as above | **closed, iteration 2**: 0.507 on the amped slow subset, 0.511 on all emitted amped; 0.506 on DI |
| C2c | Octave displacement of the fragment as a retrospective witness | deep | none; observation above | 0.80 AUC as above, or usable as the rate gate's second witness | **closed, iteration 2**: 0.49–0.51 everywhere; no fragment is octave-displaced on this material |
| C2d | Spectral-shape (centroid / flatness) novelty at fine hop | fast | DECISION-014, DECISION-015 measured spectral change, not shape | 0.80 AUC as above | **closed, iteration 2**: centroid jump 0.58, flatness 0.52 on the amped slow subset (centroid after/before 0.83 on DI, where it is the rise again) |
| C3 | Retrospective learned classifier (≤25k params) judged on the OUTCOME target, trained on GuitarSet rows labelled by the matcher | deep | DECISION-021, DECISION-031 (both boundary-target; group R weak there) | LOTO AUC above the shipped rate feature's 0.826 on the same rows; pipeline beats the shipped gate at +0 missed on derivation | open (door 3) |
| C4 | Pace absorb at 0.40 — the named measurement only (estimator / oracle ratio per take) | — | DECISION-037: "not yet decidable" | ratio ≈ 0.82 ⇒ 0.50 is derived | blocked on the label review (owner) |
| C5 | Rate gate restricted by the PREDECESSOR's `harmonyBloomed` | tracker | DECISION-030 amendment (room-context flag regressed) | chord-take extras fall, nothing else moves | open (door 5) |
| C6 | Lower the amplitude gate so decayed slow strings reach the witnesses | fast | DECISION-035 names it, unmeasured | ledger `rejected: gated` falls at no extras cost | open (door 6, misses not splits) |
| C7 | Instrument only: the slow subset re-measured with `analysis.rmsGate` overridden to the values GOATerizer can pass (0.002, 0.0005, 0.00008) — does lowering the gate raise splits, and by which accepting site? | measurement | none; the consumer runs the engine here and the corpus never has | a stated split count per gate value; if splits rise, the loop's target moves to the gate the player actually plays at | **spent, iteration 1**: 260 / 286 / 293 split at 0.002 / 0.0005 / 0.00008; all of it `held-then-picked-di` 8 → 45 as its gated misses become splits |
| C8 | Instrument only: the slow subset at 44.1kHz (resample the decoded fixtures, run the same engine) — does the hop grid move the numbers? | measurement | none | bit-identical is the hope; a moved count is a finding about every ms-denominated constant | open, cheap |
| C9 | DI: the `envelope-rise` acceptance. On the outcome-shaped population, DI takes only, read `riseRatio` and `rms / sustainedRms` at the phantoms against the real re-picks; then whether a note past `ringOutMs` with a trustworthy decay fit should reach the ring-out branch instead of the rolling-baseline test | fast | the sweep that set `rearticulationRiseRatio` 1.2 (swept DOWN on the five originals for sensitivity; raising it was not the question asked); "Hypotheses tested and rejected" rows on `restrumSharpness` | separation ≥ 0.80 AUC on DI rows, then a bar that removes DI fragments at +0 missed on derivation | **spent, iteration 1**: `riseRatio` 0.909 on emitted DI rows (0.502 amped); shipped as the rate gate's second witness, DECISION-045, at +1 on an overlap credit; the emitted DI phantoms are `sharpness`-accepted, not `envelope-rise` |
| C9b | A PROSPECTIVE bar on the predecessor's age over the local interval, so the fragment is refused rather than opened | tracker | DECISION-030 (announce bar on the fragment's own span) | 0.80 AUC on the outcome-shaped population | **closed, iteration 1**: 0.45–0.55 AUC on every population; the predecessor is a normal-length note |
| C10 | The DI slow splits the no-rise witness stops at: the E5 take's 13 survivors read rise 0.8–1.0 against real re-picks from 1.01, the quarters DI take's 9 are `fine-onset` and near-unity rise. A witness other than the envelope's level (C2a/C2b band-limited, or the owner's own recordings) | fast | DECISION-045 (rise bar at 0.9 costs three real re-picks whose predecessor was still loud) | DI slow split below 42 of 365 at +0 missed; amped not worse | **spent, iteration 2**: the survivors were a TIMING error, not phantoms — 27 of 35 open on the pick's contact, 45–70ms before the release the labels sit on. DECISION-046 moves the boundary; slow DI 35 → 30 on derivation at +0 missed, amped one extra better. What is left is C11–C13 |
| C11 | The burst rule's boundary when the burst's FIRST attack was refused for carrying no energy (`no-energy-not-sharp`, `ring-out-not-sharp`, rise 0.56–0.93) and a later attack in the same burst was accepted: on a strum the first transient is the boundary; on a single string it is the pick's landing, and the accepted attack 67–80ms later is the release. 9 of the 30 remaining DI slow splits, 5 of them on the held-then-picked take | tracker | DECISION-046 (same mechanism, read at the burst-backdate site in step (a)); the burst rule itself ("the boundary is the FIRST attack of this burst") | DI slow split below 30 at +0 derivation missed; the amped burst behaviour on the cowboy and power-chord takes bit-identical | **built and reverted, iteration 3** (DECISION-047): 22 of 23 boundaries land within 33ms of their labels, score worse (slow DI 30 → 33, missed +2, fp +2) through C14 and two overlap credits. **Re-run and reverted, iteration 5** (DECISION-049): the estimator holds (E5 fp 2 → 2), slow DI 30 → 30, missed +2 on the same two overlap credits, held-out fp 66 → 64; the held-then-picked take reads 8 → 10 because `measure-splits.ts` charges a Note 67ms early to the label before it and the rule moves the charge along the chain to the C12 shapes; and one moved start reopened the rolling-baseline test on a held note (C15). Spent: reads clean only after C12 and C15 |
| C12 | The release arriving on a hop the amplitude gate refuses (`gated`): the muted string is under `analysis.rmsGate` when the release begins, `rearticulation.ts` never sees it, the Note keeps the contact. 3 of the 30; plus 1 at 80ms, the edge of the window DECISION-046 reuses from `transient.articulationMs`, and 2 inside the window and over the bar that did not move (`a3`, `e830`), unread | tracker | DECISION-046; C7 (lowering the gate turns gated misses into splits, so the gate is not the lever) | the 3 + 1 + 2 fall at +0 derivation missed | open |
| C14 | The pace estimator's cliff: `localIoiMs` is the median of the last eight opening gaps, and on material whose gaps sit in two clusters (the E5 take: eighths ~227ms, sixteenths ~120ms) one gap shortened by a 67ms boundary move tips it 227 → 160ms, so every bar denominated in it — DECISION-030's 0.35, DECISION-045's 0.5 — moves by a third. Reproduction: E5 DI take, 15907ms, `announceBarMs` 113 → 80 under DECISION-047's build. Candidates: gaps read from ATTACK times (which a boundary move does not change) rather than Note openings; a percentile or trimmed median that one gap cannot tip; or the bar denominated in the predecessor's own length | tracker | DECISION-030 (the estimator as built), DECISION-037 (estimator / oracle ratio "not yet decidable") | under DECISION-047's build re-applied, the two E5 false positives do not appear and derivation is not worse; the estimator/oracle ratio per take does not fall | **spent, iteration 4** (DECISION-048): retracted openings struck out; derivation fp 223 → 211, extras 281 → 271, missed 114 → 114, amped slow 188 → 182; estimate / labels 0.85 → 0.96 at the median. The E5 stubs' bars read 133 and 140ms (were 113 and 100). C11 re-run next |
| C13 | A sharpness ceiling on the CONTACT opening for DECISION-046: the two moves that cost something on held-out had a broadband transient of sharpness 9.9 and 12.8 at the "contact" (a mic sixteenth at 140bpm, a mic strum), the direct-input contacts read 0.5–6.6. A contact does not scrape. Read on held-out material, so not a constant this iteration | tracker | DECISION-046 (d) | derived on the DERIVATION predicate alone: an edge between the DI contacts and the loudest derivation openings the rule moves; then held-out read once — `lead-line-sixteenths` missed 10 → 8 is the prediction | open — derive, do not tune |
| C15 | The ring-out clock runs from the Note's START: `rearticulation.ts` reaches the decay-fit branch at `soundedMs >= ringOutMs` (250), so a boundary moved 67ms later (DECISION-046 at two sites, C11 at a third) delays that branch by 67ms and a transient in the window is read by the rolling-baseline test instead. Reproduction: held-then-picked DI, 9213ms, `soundedMs` 280 → 213, `ring-out-not-sharp` → `sharpness`, a third Note on `p1c2q3`. Candidate: the clock the ring-out branch reads is the burst's first attack (the contact, where the string was excited and the decay the fit measures began), not the moved start | fast + tracker | DECISION-049; DECISION-046 (the moves it applies to first); the ring-out branch itself (`ringOutMs`) | first read, no build: on the derivation DI takes at the shipped engine, the `sharpness` acceptances 250–320ms after a moved start against those after an unmoved start, per take; then the anchored clock at +0 derivation missed, fp not up, and the E5 / held-then-picked DI phantom counts down by the number that read | open — read first |

## Owner-side blockers (living)

| item | what it unblocks | asked | answered |
|---|---|---|---|
| Recordings of the tutorial passage from the owner's failing setup — his direct input into his computer's browser, through the game's capture path, with and without the gate calibration — then the phone when tried (brief §10) | any claim that a fix transfers to the owner's rig; derivation material for slow same-pitch notes on DI, which DECISION-033 also names as its precondition | 2026-09-18 (this file) | — |
| Has the owner run GOATerizer's input-gate calibration on the DI rig, and what gate is in force during the tutorial? | whether the DI failure is gated misses (`held-then-picked-di`'s shape) or splits; which of C6/C7/C9 to run first | 2026-09-18 | — |
| Label review of the eight 120bpm same-pitch takes: the 33 A3 grid placeholders; carrying the DI times to the amped files at +2.5ms; and, from iteration 2, the held-then-picked DI labels, which the envelope shows sitting 20–90ms AHEAD of the pick's contact on the five strokes probed (every other DI label sits on the release) | C4; reading the amped fast takes to better than ±65ms; the held-then-picked DI onset error, which reads worse under DECISION-046 for that reason | earlier (`docs/SAME-PITCH-MATERIAL.md`) | — |
| Does GOATerizer honour `structuralRevision` with `relation: "absorbed"`? | which form of C1 to build (retract vs never-announce) | 2026-09-18 | **Yes** (read from `trellos/goaterizer`, `src/input/tuninator-provider.ts`, its DECISION-105/110): an absorbed id becomes a `retract` that un-draws the bar, refunds a wrong-note charge and reopens an unjudged target. A verdict already shown is kept. Both forms of C1 therefore reach the game; see "What the consumer does with a split" below for why latency still matters. |
| A raw-capture switch in GOATerizer (dump the worklet input to WAV) | the recordings above being what the recognizer really hears, DI first | 2026-09-18 | No such switch exists yet; GOATerizer has no `MediaRecorder` or file capture anywhere in `src/`. Its labels editor reads this repository's `fixtures/`, it does not record. Briefed as `docs/goaterizer-capture-and-judgment-prompt.md`, to run in parallel in that repository. |
| A tempo hint on `EngineTuning` (product decision; the record bounds its value at about twice the shipped gate's reach, and not free) | nothing in the loop; a consumer-side lever | 2026-09-18 | — |

---

## Iterations

### Iteration template

```
### Iteration N — YYYY-MM-DD — <KEPT | REVERTED | BENCH-FALSIFIED | BLOCKED> — <one line>
- Candidate: <ledger id and mechanism>; nearest closed relative and the difference.
- Falsifier, stated before measuring: <number>.
- Built: <files>; gate: <config key, default = shipped behaviour>.
- Sweep (derivation predicate: <which>): <constant> <values> → <what moved at each>.
- Numbers, before → after:
    slow subset      DI a/b → c/d     amped+mic e/f → g/h
    corpus           split/extra/strays
    tail fragments   same pitch / detached / other
    ledger MISSED    total; fixtures that moved, with cause
    by material      derivation missed/extra; held-out missed/extra (read once, after)
    eval             PASS/FAIL; required; informational
    consumer view    announced-then-absorbed n; latency median / p90   (if retracting)
    tests            n passing
- Verdict and why, in two sentences.
- What a GOATerizer player would notice (per signal path, plain words).
- Findings section title; DECISION id; commit.
- Ledger changes; new blockers.
- Exit rule: <continue | exit, reason>.
```

### Iteration 1 — 2026-09-18 — KEPT (pending the owner's call on one label) — the rate gate gains a DI-shaped second witness: a same-pitch boundary over which no energy arrived

- Candidate: **C9** (the DI column's accepting site and `riseRatio`), built as
  a second witness on DECISION-030's rate gate rather than a boundary gate.
  Nearest closed relative: the single-witness boundary gates of DECISION-028
  (`riseRatio` among them, ≤ 0.698 AUC on the whole corpus). The difference:
  read per signal path on EMITTED Notes, `riseRatio` separates DI phantoms
  from DI re-picks at 0.909 while being 0.502 through an amp; and it acts only
  on a Note also too short for the local pace, which is what keeps it off the
  amped column where the boundary reading is worthless.
- Falsifier, stated before measuring: derivation missed up by no more than 1
  (bench predicted +1 on `held-then-picked-amped`, to be diagnosed); slow DI
  split events down by ≥ 10; amped+mic column not worse; held-out not worse,
  read once; eval PASS.
- Built: `src/engine/config.ts` (`tracking.rateFragmentNoRiseRatio` 0.8,
  `rateFragmentNoRiseDipRatio` 0.4, `rateFragmentNoRiseSpanFraction` 0.5),
  `src/engine/tracker/note-tracker.ts` (`rateFragmentSpanFraction()`, the
  rise captured beside the dip at a same-pitch split),
  `tests/engine/rate-fragment.test.ts` (11 tests on corpus vectors); gate:
  `rateFragmentNoRiseRatio` = 0 is bit-identical to `main` (verified in the
  pipeline, every fixture).
- Sweep (derivation predicate: not 140bpm — 5 originals + 8 same-pitch
  takes): rise bar 0.75 / 0.8 / 0.85 → slow DI split 39 / 35 / 35 of 327,
  amped 158 / 158 / 157, missed 114 at all three (0.85 starts to reach the
  amped column; the bench's nearest real re-picks sit at 0.82–0.89); span
  0.45 / 0.5 / 0.55 → 36 / 35 / 35, missed 114 / 114 / **115**; dip floor
  0.3 / 0.4 / 0.5 → flat (35, 114 each). Off: 45, 158, 113.
- Numbers, before → after:
    slow subset      DI 52/54 → 42/44     amped+mic 189/245 → 188/244     total 241/299 → 230/288
    corpus           316 / 379 / 20 → 305 / 368 / 20
    tail fragments   267 same pitch / 0 detached / 23 other → 252 / 0 / 23 (extras 290 → 275)
    ledger MISSED    137 → 138; `held-then-picked-six-strings-120bpm-amped` 1 → 2, cause `chord-not-sharp` (the label's own onset, unchanged; what moved is the late phantom that had credited it — below)
    by material      derivation missed 113 → 114, fp 241 → 227, extras 298 → 288; held-out missed 24 → 24, fp 70 → 69, split 75 → 74 (read once, after)
    eval             PASS; required 0 failures; informational the one pre-existing (`power-chords-b-a-g-fsharp-b-a-g-e-140bpm` exact 72.7%)
    consumer view    not retracting — the fragment is never announced
    tests            522 passing (511 + 11)
- Per take, DI: `same-pitch-eighths-sixteenths-e5-120bpm-di` 22 → 13 of 64,
  `same-pitch-eighths-a3-120bpm-di` 6 → 5, held-then-picked DI 8 → 8,
  quarters DI 9 → 9, lead-line DI 7 → 7. Amped+mic: bit-identical on every
  derivation take; `lead-line-amped-quarter-eighth-triplet-140bpm` (held-out)
  21 → 20.
- The one label that moved, by instrument (`--detail`, trace): `p1c4q4` F#2
  at 17535ms on the amped held-then-picked take. Its own onset at 17506ms is
  refused `chord-not-sharp` on `main` and still is. On `main` the label was
  credited by Note `n31`, opened at 17840ms — 305ms late, outside the
  matcher's 300ms onset window, paired on 133ms of overlap — from a boundary
  reading rise 0.51, dip 0.79 inside an 853ms chord. The new witness holds it
  to 253ms (0.5 × 507ms), it lives 120ms, `end()` drops it. Nothing played on
  time is lost on the derivation set; the label is PROVISIONAL.
- Verdict and why: kept, with the call left to the owner. The falsifier as
  stated passes on every line (+1 exactly, −10 exactly, amped and held-out
  not worse, PASS); the letter of §2's "MISSED may not rise" is broken by one,
  and the one is an overlap credit standing in for a label the engine had
  already missed. The trade is fourteen emitted phantoms on the direct input
  for that.
- What a GOATerizer player would notice: **on a direct input**, E5 eighths at
  120bpm split 22 of 64 before and 13 of 64 after — nine more notes held on
  time are read as one Note instead of two; A3 eighths 6 → 5; quarters and
  the held-then-picked passage unchanged at 9 and 8. **Through an amp or a
  room mic**, nothing changes: quarters at 120bpm still split 50 of 72,
  eighths 37 of 71 and 24 of 64. Nothing played on time is lost on either
  path. The tutorial's own shape — a note re-picked out of a rest — is still
  not in the corpus, so this is the nearest measured thing, not the thing.
- Findings section: "The rate gate's second witness: a same-pitch boundary
  over which no energy arrived, read on the direct input"; DECISION-045;
  commit on `claude/project-thread-46x8sd`.
- Ledger changes: C7 spent (result below), C9 spent (this iteration), the
  predecessor-age form added as closed, C10 added for what remains on DI.
  New blocker: none; the owner's call on the +1 is the PR review.
- Exit rule: continue. The DI column still splits 42 of 365 and the amped
  column is untouched; doors 1–3 remain unrun.

**C7, run this iteration (instrument only, no source change):** with
`analysis.rmsGate` overridden to 0.002 / 0.0005 / 0.00008 (shipped 0.008), the
slow subset reads 260 / 286 / 293 of 754 split (baseline 241), corpus extras
434 / 463 / 468 (379), strays 206 / 311 / 465 (20), MISSED 116 / 112 / 111
(137). The whole effect is one take: `held-then-picked-six-strings-120bpm-di`
goes 8 → 18 → 37 → 45 split while its misses fall 14 → 7 → 5 → 3 — lowering
the gate turns the DI re-picks the ledger records as `rejected: gated` into
splits, not into clean Notes, because the quiet re-pick then meets the same
sharpness fallback the phantoms come through. The other four DI slow takes
move by 0–6. So if the owner's rig runs a gate the game calibrated low, his
held-then-picked passage is a split problem there rather than a miss problem,
and the witness shipped in this iteration is the one that acts on it.

**A negative worth recording:** a PROSPECTIVE bar — refuse the boundary when
the predecessor's age over the local interval is short, so the fragment is
never opened — reads 0.45–0.55 AUC on every population (whole corpus, slow DI,
slow amped). The phantom's predecessor is a normal-length note; it is the
fragment that is short, and that is only known after it ends. The
announce-bar form is the right shape and stays.

**Premise corrected:** the DI paragraph above puts `envelope-rise` first among
DI same-pitch splits (20 of 40, whole takes, `measure-split-cause.ts`). Among
EMITTED Notes on the slow subset, `envelope-rise` accepts none of the 26 DI
phantoms; 24 are `sharpness`, 2 `fine-onset`. The envelope-rise fragments are
refused before announcement by bars that already exist.

### Iteration 2 — 2026-09-18 — KEPT (pending the owner's call on the held-out +3) — a Note opened on the pick's contact moves its boundary to the release

- Candidate: **door 2** first (C2a–C2d, a re-pick witness that survives
  compression), benched and closed — see the ledger. Then **C10**, read
  from the other side: the DI slow splits the no-rise witness stopped at are
  not phantoms but a TIMING error with a physical cause, the pick's contact
  opening the Note 45–70ms before the release the labels sit on. Nearest
  closed relative: DECISION-018's fine witness, built to fire on the contact
  and backdate the Note onto it, and the burst rule ("the boundary is the
  first attack of the burst"). The difference: on a single string the
  contact is not where the note begins, and the release 45–70ms later has a
  witness the contact never has — a rise over an 80ms baseline that spans the
  muted string.
- Falsifier, stated before measuring: derivation DI onset error must fall;
  derivation missed may not rise; amped column not worse; held-out read once
  after the bar was chosen; eval PASS; and the one take the simulation showed
  going the wrong way (`held-then-picked-di`) explained before shipping.
- Built: `src/engine/config.ts` (`tracking.releaseRiseRatio` 2),
  `src/engine/tracker/note-record.ts` (the opening hop's rise and dip, and
  whether the fine witness opened it), `src/engine/tracker/note-tracker.ts`
  (`isRelease()` in step (a) on the unsettled Note; the stub path in
  `absorbArticulationFragment`; `CONTACT_RISE`; the `released` trace event),
  `tests/engine/release-boundary.test.ts` (3 tests on a synthesized
  contact-then-release stroke); gate: `releaseRiseRatio` = 0 is bit-identical
  to the branch before it (verified in the pipeline, every fixture).
- Sweep (derivation predicate: not 140bpm): bar 1.5 / 2 / 2.5 / 3 / 4 →
  slow DI split 30 / 30 / 31 / 31 / 32 of 327 (off: 35), fp 222 / 223 / 224 /
  224 / 225 (227), missed 114 at every bar, amped 158 at every bar, onset
  median 25 / 23.7 / 24 / 24 / 25ms. 2 is the middle of the plateau.
- Numbers, before → after:
    slow subset      DI 42/44 → 34/36     amped+mic 188/244 → 188/243     total 230/288 → 222/279
    corpus           305 / 368 / 20 → 295 / 357 / 18
    tail fragments   252 same pitch / 0 detached / 23 other → 246 / 0 / 23 (extras 275 → 269)
    ledger MISSED    138 → 141; `lead-line-di-quarter-eighth-triplet-140bpm` 0 → 1, `lead-line-sixteenths-e-fsharp-140bpm` 8 → 10 (both held-out; below)
    by material      derivation missed 114 → 114, fp 227 → 223, extras 288 → 281, |onset| med 25 → 23.7ms; held-out missed 24 → 27, fp 69 → 67, split 74 → 70, extras 80 → 76, |onset| p90 71 → 67ms (read once, after)
    eval             PASS; required 0 failures; informational the one pre-existing (`power-chords-b-a-g-fsharp-b-a-g-e-140bpm` exact 72.7%)
    consumer view    not retracting — the boundary moves before the Note is announced; a stub the release split is absorbed as before
    tests            525 passing (522 + 3)
- Per take, DI: `same-pitch-eighths-sixteenths-e5-120bpm-di` 13 → 9 of 64
  (extras 15 → 10, |onset| p90 51 → 25ms), quarters DI 9 → 8, A3 eighths DI
  5 → 5, held-then-picked DI 8 → 8; held-out `lead-line-di-quarter-eighth-
  triplet-140bpm` slow 7 → 4, extras 12 → 9, |onset| p90 53 → 21ms. Amped+mic:
  E5 amped extras 37 → 36, quarters amped one stray fewer, everything else on
  derivation bit-identical.
- The three held-out labels, by instrument (trace, 2ms envelope): `t12` on the
  DI triplet take — its own pick (+18dB at the label) was never detected; the
  Note credited to it was a 40ms stub in the NEXT stroke's mute, 66ms late,
  which the rule folds into the release it belongs to; an overlap credit for
  a label already missed, DECISION-045's shape. `s7` and `s16` on the mic
  sixteenths take at 140bpm — the boundary at `s7` moved 67ms onto the
  release (the envelope shows the contact-then-release shape under a pick
  with a real transient, sharpness 12.8, and no rise because the previous
  sixteenth was still loud); the region lane's reconciliation then read the
  next sixteenth, 62ms later, as agreeing with the fast-lane boundary within
  `deep.minSegmentMs` and carved no second Note. `s16` is the same one bar
  later, credited before by a duplicate Note 117ms ahead of it. One real
  note, one duplicate credit, one overlap credit.
- `held-then-picked-di`, explained: the five moved boundaries land 12–15ms
  after the biggest envelope jump in the window — the release — and the
  labels sit 20–90ms AHEAD of the contact's mute. PROVISIONAL labels from an
  RMS-envelope tool; the rule is right there and the labels are not. Added to
  the label-review blocker.
- Verdict and why: kept, with the call left to the owner. Every derivation
  line of the falsifier passes (onset error down, missed +0, amped one extra
  better, PASS, the wrong-way take explained as label placement); held-out is
  better on splits, extras and false positives and worse by three missed,
  one of them a real sixteenth on a room mic at 140bpm, which is the shape
  where the stroke's own gap is more than half the note interval. The three
  guards that would keep it (pace, dip, contact sharpness) were each read on
  the moved-boundary population and none has an edge that is not tuned to
  held-out events; C13 records the one worth deriving properly.
- What a GOATerizer player would notice: **on a direct input**, a quarter or
  eighth note now begins when the string sounds instead of when the pick
  lands on it, so the note before it is no longer cut 45–70ms short and the
  hit window opens on the note, not the click: on E5 eighths at 120bpm 9 of
  64 events split instead of 13, and 22 notes that were read 42–93ms early
  are read within 25ms; quarters 8 of 72 instead of 9. **Through an amp or a
  room mic**, nothing a player would notice: one phantom fewer on the E5
  amped take, and at sixteenths at 140bpm on a room mic one note in 48 that
  used to be found is now folded into its neighbour. The tutorial's own
  shape — a note re-picked out of a rest — is still not in the corpus.
- Findings section: "The boundary of a slow direct-input stroke is the pick's
  release, not its contact"; DECISION-046; commit on
  `claude/project-thread-46x8sd` (PR #8, second commit).
- Ledger changes: C2a–C2d closed with their numbers; C10 spent; C11 (the
  burst rule backdating onto a refused contact, 9 of the 30 remaining), C12
  (the release on a gated hop, 3, plus the window edge and two unread), C13
  (a sharpness ceiling on the contact opening — derive, do not tune) added.
  Blockers: the held-then-picked DI label placement added to the label
  review row.
- Exit rule: continue. The direct input still splits 30 of 327 on derivation,
  and 12 of those are this mechanism at two sites it does not yet reach (C11,
  C12); door 1 and door 3 remain unrun.

### Iteration 3 — 2026-09-18 — REVERTED — a split whose burst began on a refused contact moved to the release: right on 22 of 23 boundaries, worse on the score through the pace estimator

- Candidate: **C11**, the burst rule backdating a same-pitch split onto a
  contact that was refused as a re-articulation (9 of the 30 remaining DI
  slow splits). Nearest closed relative: DECISION-046, the same mechanism at
  the unsettled-Note and absorbed-stub sites. The difference: here the
  contact was refused, so the Note it landed in was still open, the release
  split it, and the split took the burst's first attack as its boundary.
- Falsifier, stated before measuring: derivation slow DI split down by at
  least 6 of the 9; derivation missed and false positives not up; chord
  takes bit-identical; held-out read once after the bar was chosen.
- Built: `tracking.burstContactRiseRatio` (0 = off) in `config.ts`; step
  (a)'s `rearticulated && settled` branch in `note-tracker.ts` (boundary =
  the accepting attack when the burst's first rose under the bar, the
  accepting attack rose by `releaseRiseRatio` or more, same pitch class);
  two tests on a synthesized soft-click stroke. Reverted to bit-identical
  (`git diff -- src/` empty against the iteration 2 commit); the tests went
  with the code.
- Sweep (derivation predicate: not 140bpm): bar 1.0 / 1.1 / 1.2 / 1.3 →
  slow DI split 33 / 33 / 33 / 33 of 327 (off: 30), missed 116 (114), fp
  225 (223), extras 284 (281), |onset| p90 90 (95). Flat — every refused
  contact reads under 1.0 — and worse on every falsifier line.
- Numbers, before → after: unchanged (reverted). At 1.2 for the record:
    slow subset      DI 30 → 33 of 327 on derivation; quarters DI 8 → 7, held-then-picked DI 8 → 10, E5 eighths DI 9 → 11
    by material      derivation missed 114 → 116, fp 223 → 225; held-out (read once) split 70 → 69, fp 67 → 65, missed 27 → 27, |onset| p90 67 → 63
    eval             not run at 1.2 (reverted before verification)
    tests            525 (the two added tests removed with the build)
- The moves, by label: 23 `released` via `burst` on the three DI takes;
  22 go from 40–107ms early to within 33ms of the label (held-then-picked
  13, E5 5, quarters 5), one goes 10 → 77 on a label sitting on the
  contact. Nothing the rule touched is a strum.
- Why the score is worse: (1) `localIoiMs`, the median of the last eight
  opening gaps, is tipped 227 → 160ms on the E5 take by one gap the move
  shortened, so DECISION-045's announce bar for a no-rise fragment falls
  113 → 80ms and two 80ms contact stubs (a contact the sharpness fallback
  accepted, release on a gated hop — C12) are announced instead of dropped
  (trace at 15907 and 16147ms: `announceBarMs` 113 → 80, `announced` false
  → true). (2) Two overlap credits for labels the engine had not found at
  their own onset (`e843` credited by an 80ms stub 177ms late; `p2c3q4`
  credited across an octave by the C5 reading of a held C3) rest on stubs
  the rule shortens to 13 and 40ms, which are then absorbed.
- Verdict and why: reverted. The falsifier failed on every derivation line
  and the loop's bar is the score, not the moves; the failure names a real
  fragility — a pace estimate that one 67ms boundary move can shift by 67ms,
  which applies to DECISION-046's moves as much as to these — and that is
  the next candidate, ahead of re-running this one.
- What a GOATerizer player would notice: nothing changed. On a direct
  input a note re-picked while the previous one is still ringing (the
  held-then-picked passage, five of its eight splits) still begins on the
  pick's landing, 60–100ms before it sounds. Through an amp, nothing.
- Findings section: "A burst that began on a refused contact: the boundary
  belongs on the release, and moving it there reads worse through the pace
  estimator"; DECISION-047 (rejected); commit on
  `claude/project-thread-46x8sd`.
- Ledger changes: C11 built and reverted, re-run after C14; C14 added (the
  pace estimator's cliff on bimodal gaps, with a reproduction). No new
  blockers.
- Exit rule: continue. C14 next, then C11 again, then C12.

### Iteration 4 — 2026-09-18 — KEPT — the pace estimate strikes out openings that never became Notes

- Candidate: **C14**, opened by iteration 3: `localIoiMs` counts every
  opening, and on the E5 take half the gaps in its window are pieces of a
  250ms eighth cut by a contact stub or a dropped fragment, so the median
  sits on a cliff. Nearest closed relative: DECISION-030 (e), a lower
  percentile and a two-pass re-estimate, which "fixed the bias without
  improving the end-to-end trade". The difference: not choosing among the
  pieces, but removing them once the tracker knows they were pieces.
- Falsifier, stated before measuring: derivation missed, false positives
  and extras not up; slow subset not worse on either path; held-out read
  once; the two E5 stubs at 15907 and 16147ms keep a bar a 67ms move cannot
  bring under them.
- Built: `tracking.paceIgnoresRetracted` (true) in `config.ts`; openings
  kept with ids and `retractOpening()` at the four absorption sites and the
  unannounced drop in `end()`, `note-tracker.ts`; the tracker's pace reading
  added to the `rearticulation` trace event; `tests/engine/pace-retracted.test.ts`
  (3 tests). Gate false is bit-identical to iteration 2's commit.
- Sweep (derivation predicate: not 140bpm): a boolean, off / on → fp 223 /
  211, extras 281 / 271, split 225 / 219, missed 114 / 114, slow DI 30 / 30,
  amped+mic 158 / 152.
- Numbers, before → after:
    slow subset      DI 34/36 → 34/36     amped+mic 188/243 → 182/232     total 222/279 → 216/268
    corpus           295 / 357 / 18 → 289 / 346 / 19
    tail fragments   246 / 0 / 23 → 235 / 0 / 23 (extras 269 → 258)
    ledger MISSED    141 → 141, no fixture moved
    by material      derivation missed 114 → 114, fp 223 → 211, extras 281 → 271; held-out missed 27 → 27, fp 67 → 66, extras 76 → 75 (read once, after)
    eval             PASS; required 0 failures; informational the one pre-existing
    consumer view    not retracting — fragments the longer bar holds are never announced
    tests            528 passing (525 + 3)
- Per take: quarters amped 50 → 46 of 72, fp 77 → 69; held-then-picked
  amped 47 → 46, fp 52 → 50; E5 amped and DI one phantom fewer each; A3
  eighths amped 56 → 55 with one more stray (a 93ms Note at 2133ms, the
  take's first gap, where the estimator abstains by design). DI column
  unchanged.
- The estimate against the labels' local interval (new instrument, the
  `localIoiMs` on the trace): off p10 0.37 / med 0.85 / p90 1.09, on 0.48 /
  0.96 / 1.17 over 1,235 same-pitch re-articulations on derivation. The
  quarters amped take stays at 0.47 because its phantoms are announced and
  stay in the estimate.
- Verdict and why: kept. Every falsifier line passes with margin, it is the
  first move on the amped column since DECISION-030, and the E5 stubs' bars
  read 133 and 140ms against their 80 and 93ms, which a 67ms move cannot
  reach.
- What a GOATerizer player would notice: **through an amp**, on quarter
  notes at 120bpm, four fewer of 72 events split and eight fewer phantom
  Notes reach the game; on the held-then-picked passage one fewer. **On a
  direct input**, nothing changes; the remaining DI splits are timing
  shapes this bar does not act on.
- Findings section: "The pace estimate reads the openings that never became
  Notes, and striking them out is the first move on the amped column since
  DECISION-030"; DECISION-048; commit on `claude/project-thread-46x8sd`.
- Ledger changes: C14 spent. Two observations recorded in the findings and
  not acted on: `RATE_PERCENTILE`'s comment describes a low percentile and
  the value is the median; the span bars now act on an estimate 13% longer
  than the one they were tuned on, a §6.6 sweep not run.
- Exit rule: continue. C11 re-run on the corrected estimate next, then C12.

### Iteration 5 — 2026-09-18 — REVERTED — the refused-contact burst rule re-run on the corrected pace estimate: the estimator holds, the score still cannot see the moves

- Candidate: **C11** again, as DECISION-048 left it ("re-run after C14").
  Nearest closed relative: DECISION-047, the same build; the difference is
  the estimator under it, which a 67ms boundary move can no longer tip.
- Falsifier, stated before measuring: iteration 3's, unchanged —
  derivation slow DI split down by at least 6 of the 9; derivation missed
  and false positives not up; chord takes bit-identical; held-out read
  once after the bar was chosen. Bar 1.2 only, since iteration 3's sweep
  was flat from 1.0 to 1.3.
- Built: DECISION-047's build character for character —
  `tracking.burstContactRiseRatio` (0 = off) in `config.ts`, the branch at
  the split's backdate site in step (a) of `note-tracker.ts`, the two
  soft-click tests. Reverted to bit-identical (`git diff -- src/` empty
  against the iteration 4 commit); the tests went with the code.
- Sweep (derivation predicate: not 140bpm): 1.2 only → slow DI 30 of 327
  (off: 30), missed 116 (114), fp 211 (211), extras 271 (271), split 218
  (219), |onset| p90 93 (95).
- Numbers, before → after: unchanged (reverted). At 1.2 for the record:
    slow subset      DI 30 → 30 of 327 on derivation; quarters DI 8 → 7, E5 eighths DI 9 → 8, held-then-picked DI 8 → 10; amped+mic unchanged
    chord takes      cowboy-chords derivation take split 3 → 2, fp 4 → 3; the rest bit-identical
    by material      derivation missed 114 → 116 (`e843`, `p2c3q4`, the same overlap credits as iteration 3), fp 211 → 211; held-out (read once) split 70 → 69, extras 75 → 73, fp 66 → 64, missed 27 → 27, |onset| p90 67 → 63
    eval             not run at 1.2 (reverted before verification); PASS at the head, unchanged from iteration 4
    tests            528 (the two added tests removed with the build)
- What DECISION-048 bought: the two E5 false positives DECISION-047 traced
  to the tipped estimate do not return; the E5 DI take reads 2 on and
  off, its stubs' bars 133 and 140ms. Against iteration 3 at the same
  bar: slow DI 33 → 30, fp 225 → 211, E5 DI 11 → 8.
- Why the held-then-picked take reads 8 → 10 with every boundary the rule
  touched moved right: `measure-splits.ts` reaches 40ms ahead of a label,
  so a Note 67ms early is charged to the label before it; on this take
  every re-pick opens early, a label reads split where two early Notes
  meet, and fixing the refused-contact positions moves the charge along
  the chain to the six neighbours whose own boundary is a C12 shape
  (`p1c1q3`, `p1c2q2`, `p1c2q3`, `p1c3q2`, `p1c4q3`, `p2c2q4` gained;
  `p1c2q1`, `p1c3q1`, `p2c3q2`, `p2c4q1` cleared). The count is the number
  of chain positions still wrong, not a verdict on the rule.
- Why one of those is a real phantom: `p1c2q3` reads three Notes, the
  third accepted `sharpness` at 9213ms where the same transient was refused
  `ring-out-not-sharp` before. The ring-out branch is reached at
  `soundedMs >= ringOutMs` (250) and `soundedMs` runs from the Note's
  start: 280ms with the start on the contact, 213ms with it on the
  release. Every moved boundary delays the ring-out branch by the move;
  DECISION-046's moves do the same and were not read for it. The region
  lane also emits its own contact-opened Note beside the moved one there
  (`prefix:region-attack` declined), the fold seen on held-out in
  iteration 2, now on a derivation take.
- Verdict and why: reverted. The falsifier fails on its first line
  (30 → 30), its second (missed +2) and, on the letter, its third; the
  moves are right and the score has two things in front of it besides the
  estimator, both now named and one of them (the ring-out clock) a real
  phantom the move creates.
- What a GOATerizer player would notice: nothing changed. On a direct
  input the held-then-picked passage still begins its refused-contact
  re-picks on the pick's landing. Through an amp, nothing.
- Findings section: "The refused-contact burst rule, re-run on the
  corrected pace estimate: the estimator holds, and the score still cannot
  see the moves"; DECISION-049 (rejected); commit on
  `claude/project-thread-46x8sd`.
- Ledger changes: C11 spent (reads clean only after C12 and C15); C15
  added (the ring-out clock runs from the Note's start; read first on
  DECISION-046's moves, then anchor it to the burst's first attack). No
  new blockers.
- Exit rule: continue. One built-and-reverted iteration since a kept one,
  and C12 and C15 are open with stated falsifiers. C12 next (the release
  on a gated hop; its shapes are the chain positions C11 cannot reach),
  then C15's first read.
