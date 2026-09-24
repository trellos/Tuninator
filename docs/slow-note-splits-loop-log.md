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
6. Numbers in entries dated before 2026-09-19 were read under the split
   instrument's old ownership rule; DECISION-063 changed it. Compare across
   that date only through the re-read table in "The instrument re-read".

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
| C1 | Joint decode over the fast lane's accepted boundaries in a region, scored by IOI regularity across the phrase with the boundary witnesses as a prior; a dropped boundary is an absorption | deep | DECISION-011 (DP over windows, decay-residual cost at chance — no such term here); DECISION-037 (one fragment vs one scalar rate — no rate estimate here); the gap shape (0.779, +7 missed — must beat its exchange rate) | more derivation extras removed than the shipped rate gate at +0 missed; held-out not worse; slow subset per path | **closed, iteration 18** (DECISION-065): best -13 fp at +0 missed against the gate's -44; frontier -16 at +1, -42 at +8; held-out 27 / 67 → 27 / 65 at the chosen setting |
| C2a | HPSS percussive-component flux at fine hop as a re-pick witness | fast/deep | 1–6kHz attack band; click witness (DECISION-018) | 0.80 AUC on the outcome-shaped population, amped takes, derivation | **closed, iteration 2**: percussive flux 0.58 (1kHz+, 11 and 15 hop medians), percussive fraction 0.65–0.68 on the amped column; 0.81 on DI, where the envelope rise already reads 0.91 |
| C2b | Band-limited (1–6kHz) envelope dip | fast | DECISION-028 (d) varied window length, not band | 0.80 AUC as above | **closed, iteration 2**: 0.507 on the amped slow subset, 0.511 on all emitted amped; 0.506 on DI |
| C2c | Octave displacement of the fragment as a retrospective witness | deep | none; observation above | 0.80 AUC as above, or usable as the rate gate's second witness | **closed, iteration 2**: 0.49–0.51 everywhere; no fragment is octave-displaced on this material |
| C2d | Spectral-shape (centroid / flatness) novelty at fine hop | fast | DECISION-014, DECISION-015 measured spectral change, not shape | 0.80 AUC as above | **closed, iteration 2**: centroid jump 0.58, flatness 0.52 on the amped slow subset (centroid after/before 0.83 on DI, where it is the rise again) |
| C3 | Retrospective learned classifier (≤25k params) judged on the OUTCOME target, trained on GuitarSet rows labelled by the matcher | deep | DECISION-021, DECISION-031 (both boundary-target; group R weak there) | LOTO AUC above the shipped rate feature's 0.826 on the same rows; pipeline beats the shipped gate at +0 missed on derivation | open (door 3) |
| C4 | Pace absorb at 0.40 — the named measurement only (estimator / oracle ratio per take) | — | DECISION-037: "not yet decidable" | ratio ≈ 0.82 ⇒ 0.50 is derived | blocked on the label review (owner) |
| C5 | Rate gate restricted by the PREDECESSOR's `harmonyBloomed` | tracker | DECISION-030 amendment (room-context flag regressed) | chord-take extras fall, nothing else moves | open (door 5) |
| C6 | Lower the amplitude gate so decayed slow strings reach the witnesses | fast | DECISION-035 names it, unmeasured | ledger `rejected: gated` falls at no extras cost | open (door 6, misses not splits) |
| C7 | Instrument only: the slow subset re-measured with `analysis.rmsGate` overridden to the values GOATerizer can pass (0.002, 0.0005, 0.00008) — does lowering the gate raise splits, and by which accepting site? | measurement | none; the consumer runs the engine here and the corpus never has | a stated split count per gate value; if splits rise, the loop's target moves to the gate the player actually plays at | **spent, iteration 1**: 260 / 286 / 293 split at 0.002 / 0.0005 / 0.00008; all of it `held-then-picked-di` 8 → 45 as its gated misses become splits |
| C8 | Instrument only: the slow subset at 44.1kHz (resample the decoded fixtures, run the same engine) — does the hop grid move the numbers? | measurement | none | bit-identical is the hope; a moved count is a finding about every ms-denominated constant | open — needs a resampler the repository does not have (`decode-fixtures.ts` refuses any rate but 48kHz); not run at the pause (iteration 17) |
| C9 | DI: the `envelope-rise` acceptance. On the outcome-shaped population, DI takes only, read `riseRatio` and `rms / sustainedRms` at the phantoms against the real re-picks; then whether a note past `ringOutMs` with a trustworthy decay fit should reach the ring-out branch instead of the rolling-baseline test | fast | the sweep that set `rearticulationRiseRatio` 1.2 (swept DOWN on the five originals for sensitivity; raising it was not the question asked); "Hypotheses tested and rejected" rows on `restrumSharpness` | separation ≥ 0.80 AUC on DI rows, then a bar that removes DI fragments at +0 missed on derivation | **spent, iteration 1**: `riseRatio` 0.909 on emitted DI rows (0.502 amped); shipped as the rate gate's second witness, DECISION-045, at +1 on an overlap credit; the emitted DI phantoms are `sharpness`-accepted, not `envelope-rise` |
| C9b | A PROSPECTIVE bar on the predecessor's age over the local interval, so the fragment is refused rather than opened | tracker | DECISION-030 (announce bar on the fragment's own span) | 0.80 AUC on the outcome-shaped population | **closed, iteration 1**: 0.45–0.55 AUC on every population; the predecessor is a normal-length note |
| C10 | The DI slow splits the no-rise witness stops at: the E5 take's 13 survivors read rise 0.8–1.0 against real re-picks from 1.01, the quarters DI take's 9 are `fine-onset` and near-unity rise. A witness other than the envelope's level (C2a/C2b band-limited, or the owner's own recordings) | fast | DECISION-045 (rise bar at 0.9 costs three real re-picks whose predecessor was still loud) | DI slow split below 42 of 365 at +0 missed; amped not worse | **spent, iteration 2**: the survivors were a TIMING error, not phantoms — 27 of 35 open on the pick's contact, 45–70ms before the release the labels sit on. DECISION-046 moves the boundary; slow DI 35 → 30 on derivation at +0 missed, amped one extra better. What is left is C11–C13 |
| C11 | The burst rule's boundary when the burst's FIRST attack was refused for carrying no energy (`no-energy-not-sharp`, `ring-out-not-sharp`, rise 0.56–0.93) and a later attack in the same burst was accepted: on a strum the first transient is the boundary; on a single string it is the pick's landing, and the accepted attack 67–80ms later is the release. 9 of the 30 remaining DI slow splits, 5 of them on the held-then-picked take | tracker | DECISION-046 (same mechanism, read at the burst-backdate site in step (a)); the burst rule itself ("the boundary is the FIRST attack of this burst") | DI slow split below 30 at +0 derivation missed; the amped burst behaviour on the cowboy and power-chord takes bit-identical | **built and reverted, iteration 3** (DECISION-047): 22 of 23 boundaries land within 33ms of their labels, score worse (slow DI 30 → 33, missed +2, fp +2) through C14 and two overlap credits. **Re-run and reverted, iteration 5** (DECISION-049): the estimator holds (E5 fp 2 → 2), slow DI 30 → 30, missed +2 on the same two overlap credits, held-out fp 66 → 64; the held-then-picked take reads 8 → 10 because `measure-splits.ts` charges a Note 67ms early to the label before it and the rule moves the charge along the chain to the C12 shapes; and one moved start reopened the rolling-baseline test on a held note (C15). Spent: reads clean only after C12 and C15. **Reopened 2026-09-19 under DECISION-063's instrument**, which reads the tuning DI takes at 8: the row's falsifier is now the tuning DI slow split below 8 at +0 derivation missed, fp not up, with C12 and C15 as read (C15 closed clean, DECISION-051); the burst boundaries it moved are the ones the old count could not see |
| C12 | The release arriving on a hop the amplitude gate refuses (`gated`): the muted string is under `analysis.rmsGate` when the release begins, `rearticulation.ts` never sees it, the Note keeps the contact. 3 of the 30; plus 1 at 80ms, the edge of the window DECISION-046 reuses from `transient.articulationMs`, and 2 inside the window and over the bar that did not move (`a3`, `e830`), unread | tracker | DECISION-046; C7 (lowering the gate turns gated misses into splits, so the gate is not the lever) | the 3 + 1 + 2 fall at +0 derivation missed | **spent, iteration 6** (DECISION-050): read on the trace, only 2 of the 6 are reachable at the release test — `e851` sits six hops after its contact, which is 80.0000000000018ms in doubles, and `e815`'s release hop is under the gate. Both fixed (`tracking.releaseOnGatedHop`, window in samples): slow DI 30 → 29, +0 missed, +0 fp, held-out identical; three boundaries right, one label's charge moved along the chain to `e818` (C16). The rest: `e839` release 91ms after a fine-opened contact (past the window); `e830` the fine witness delivering the contact after its release; `e835`, `a3` region-lane Notes at the contact |
| C14 | The pace estimator's cliff: `localIoiMs` is the median of the last eight opening gaps, and on material whose gaps sit in two clusters (the E5 take: eighths ~227ms, sixteenths ~120ms) one gap shortened by a 67ms boundary move tips it 227 → 160ms, so every bar denominated in it — DECISION-030's 0.35, DECISION-045's 0.5 — moves by a third. Reproduction: E5 DI take, 15907ms, `announceBarMs` 113 → 80 under DECISION-047's build. Candidates: gaps read from ATTACK times (which a boundary move does not change) rather than Note openings; a percentile or trimmed median that one gap cannot tip; or the bar denominated in the predecessor's own length | tracker | DECISION-030 (the estimator as built), DECISION-037 (estimator / oracle ratio "not yet decidable") | under DECISION-047's build re-applied, the two E5 false positives do not appear and derivation is not worse; the estimator/oracle ratio per take does not fall | **spent, iteration 4** (DECISION-048): retracted openings struck out; derivation fp 223 → 211, extras 281 → 271, missed 114 → 114, amped slow 188 → 182; estimate / labels 0.85 → 0.96 at the median. The E5 stubs' bars read 133 and 140ms (were 113 and 100). C11 re-run next |
| C13 | A sharpness ceiling on the CONTACT opening for DECISION-046: the two moves that cost something on held-out had a broadband transient of sharpness 9.9 and 12.8 at the "contact" (a mic sixteenth at 140bpm, a mic strum), the direct-input contacts read 0.5–6.6. A contact does not scrape. Read on held-out material, so not a constant this iteration | tracker | DECISION-046 (d) | derived on the DERIVATION predicate alone: an edge between the DI contacts and the loudest derivation openings the rule moves; then held-out read once — `lead-line-sixteenths` missed 10 → 8 is the prediction | **spent, iteration 17** (DECISION-061), falsified by count: 54 release moves on the tuning takes; the contacts sharper than 6.6 are five DI moves of 0–14ms on the E5 eighths take (up to 10.5), the amped and mic moves carry no broadband contact; no ceiling from 6.6 to 12 changes a derivation count. A constant only held-out sees, as DECISION-060 |
| C15 | The ring-out clock runs from the Note's START: `rearticulation.ts` reaches the decay-fit branch at `soundedMs >= ringOutMs` (250), so a boundary moved 67ms later (DECISION-046 at two sites, C11 at a third) delays that branch by 67ms and a transient in the window is read by the rolling-baseline test instead. Reproduction: held-then-picked DI, 9213ms, `soundedMs` 280 → 213, `ring-out-not-sharp` → `sharpness`, a third Note on `p1c2q3`. Candidate: the clock the ring-out branch reads is the burst's first attack (the contact, where the string was excited and the decay the fit measures began), not the moved start | fast + tracker | DECISION-049; DECISION-046 (the moves it applies to first); the ring-out branch itself (`ringOutMs`) | first read, no build: on the derivation DI takes at the shipped engine, the `sharpness` acceptances 250–320ms after a moved start against those after an unmoved start, per take; then the anchored clock at +0 derivation missed, fp not up, and the E5 / held-then-picked DI phantom counts down by the number that read | **spent, iteration 7** (DECISION-051): read on the four derivation DI takes at DECISION-050's engine, no build: 47 moved starts, 23 transients in the reopened window (all on the E5 take), 2 changed verdicts (`e817` at 5893ms, `e853` at 14893ms: a ring-out refusal → `sharpness`, then onto the release by the unsettled path, 10ms and 12ms from their labels), 0 phantoms. Nothing for an anchored clock to fix on derivation; the 9213ms case is C11's |
| C16 | The announce bar for a Note the fine witness opened on a CONTACT: it gets `minStableMs` (55ms) where an attack-opened same-pitch contact gets the rate-fragment bar (half the local interval, 121ms on the E5 take), so it is announced before its own release arrives and the release test, which never moves an announced start, cannot reach it. `e818` on the E5 eighths DI take: fine-opened at 6122.67ms, announced at 55ms, gated release at +77ms. Candidate: a fine-opened Note whose fine onset read as a contact (`contactTimes`) takes the same suspected-fragment bar as an attack-opened no-rise split | tracker | DECISION-046 (the release test), DECISION-045 (the fragment bar), `handleFineOnset` | the fine-opened contacts on the DI takes counted, with how many are announced before a release arrives inside the window; then the bar applied at +0 derivation missed and the E5 take's `e817` charge cleared | **built and reverted, iteration 7** (DECISION-051): the premise was wrong — the fine witness delivers the contact 65ms late, so `e818`'s Note is born on the release's own hop, settled at 77ms and not yet announced, and DECISION-050's `!settled` refused it, not the announce bar. Built as the gated path without `!settled` (`isRelease` keeps `!announced`, so it reaches a fine-opened Note on its birth frame only): slow DI 29 → 27 (`e817`, `e35`), fp 211 → 210, missed 114 → 115 — `e36` on the quarters DI take, a stroke whose release re-excited the string to the gate's own level, has 13ms on its clock after the move and dies unannounced where it was announced with 75ms from the contact. Spent: the reachable rule is C17 |
| C17 | The gated release on a Note the fine witness opened keeps the announce clock on the CONTACT: `handleFineOnset` opens a Note born settled on the contact, so the fine witness has already decided the stroke is a Note; the release (C16's path, reaching that Note on its birth frame) relocates its boundary and must not re-decide it, which it does today because `announceSoundedMs` reads from the moved `startTime`. Candidate: the clock reads from `ownStartTime` for a Note the gated release moved, as it already reads a different start than `startTime` for a Note that absorbed a stub. Reproduction: `e36`, quarters DI, 35445 → 35520ms, 13.33ms on the clock after the move | tracker | DECISION-051 (the path); DECISION-050 (the gated release); `announceSoundedMs` | derivation slow DI 29 → 27 with missed 114 → 114 (`e36` regained on overlap, its Note 35520–35547ms inside the label) and fp not up; every Note the rule announces that would otherwise die unannounced counted on the derivation takes, each matched to a label or charged as a false positive; held-out read once after | **spent, iteration 8** (DECISION-052): built as `tracking.releaseOnFineOpenedFrame`; slow DI 29 → 27, missed 114 → 114, fp 211 → 210, extras 270 → 268, amped/mic and held-out bit-identical; four Notes moved on their birth frame, `e36`'s newly announced and matched, none a false positive |
| C18 | The region lane's envelope-rise boundary sits at the START of the first 85ms window whose RMS clears `segmentRiseRatio` (`resegment.ts`, `boundarySample`), which on a DI same-pitch stroke is in the mute; the fast lane's release transient inside that window is unread because the `attack` branch only reads the hop before the window's start. 4 of the 27: `a2`, `a4`, `a15` (quarters DI), `e825` (A3 eighths DI), Notes 55–63ms early | deep | the `attack` branch of `resegment.ts`; DECISION-046 (the same shape in the fast lane) | slow DI 27 → 23 or fewer at +0 missed and fp; amped and mic not worse | **built and reverted, iteration 9** (DECISION-053): the first transient inside the window — slow DI 27 → 34, fp 210 → 220, missed 114 → 109, amped/mic bit-identical. `attackSamples` carries band-only onsets (which fire at the mute's onset) and no rise, so the boundary lands on the mute or the contact as often as the release and leaves `minSegmentMs` of muted string as a Note. Spent: the reachable rule is C19 |
| C19 | The transient list the deep lane reads carries each transient's kind (broadband or band-only) and the fast lane's rise on that hop, and an envelope-rise boundary is placed on the first BROADBAND transient inside its window whose rise clears `tracking.releaseRiseRatio`, else at the window's start as today. Reproduction: `a4`, quarters DI — window start 3427ms, band-only mute onset none, release transient 3466.67ms rise 2.00, label 3490ms; `e837`, E5 DI — contact 10983ms rise 0.56, release +67ms rise 3.41 | deep + tracker (the list) | DECISION-053 (the first transient); the `attack` branch of `resegment.ts` | derivation slow DI 27 → 23 or fewer, missed 114 → 109 or fewer kept, fp 210 not up, the ten extras of iteration 9 named and absent; amped and mic not worse; held-out read once after | **built and reverted, iteration 10** (DECISION-054): slow DI 27 → 27, missed 114 → 111, extras 268 → 269 (one duplicate Note), fp 210 → 210, amped/mic bit-identical, DECISION-053's ten extras absent. `a4` and `e836` moved onto their releases and the charge moved along the chain; `a2`, `a15`, `e825` unmoved because the rise lags the transient by one hop. Spent: the reachable rules are C20 and C21 |
| C20 | The rise the region lane reads for a transient is the larger of its own hop's and the next hop's: the rise witness reads the long window, which lags the flux by one hop, so the hop carrying the transient reads the rise of the hop before it. `a2` 2520ms: 1.03 then 2.67; `a15` 9000ms: 0.91 then 2.00; `e825` 7973ms: 1.68 then 4.35; `a4` 3467ms read 2.0041 on its own hop and moved | tracker (the list) + deep | DECISION-054 (the rise on the transient's hop only) | derivation slow DI 27 → 24 or fewer with `a2`, `a15`, `e825` moved to within 40ms of their labels, missed 114 → 111 or fewer kept, fp not up, extras not up once C21 holds; amped and mic not worse; held-out read once after | **spent, iteration 11** (DECISION-055): `pendingRise` folds the next hop's rise into the newest transient; alone, slow DI 27 → 24, missed 114 → 110, fp 210 → 210, extras 268 → 266, amped/mic bit-identical; `a2`, `a4`, `e825`, `e836` onto their releases, `a15` unmoved at 1.997 against the bar of 2 (C24); the duplicate reproduced and C21 was built with it |
| C21 | A segment the region lane carves whose start coincides with a Note that already begins there (within one hop) is that Note, not a new one: `splitAtSegments` takes `from = max(segment.from, record.startTime)` and never asks whether another Note starts at `from`. Before C19 an envelope boundary was a window start and never met a fast-lane boundary. Reproduction: A3 eighths DI, region 32040–32533ms, `attack@32293` beside `n135` starting 32293.33ms, duplicate `n137` 32293–32531ms | tracker | DECISION-054; DECISION-008 (structural revision) | under C19 or C20, the A3 duplicate absent and derivation extras not up; no label that a fast-lane Note already matched lost | **spent, iteration 11** (DECISION-055): the cause was `carveAfter`, not `splitAtSegments` — a Note that began inside the region and ended past its edge is not a candidate and was out of the neighbour scan's sight. `deep.regionCarveSeesEveryNote`: the scan reads every Note the tracker holds and carves nothing within a hop of an existing start. Alone on derivation fp 210 → 203, split 216 → 209, seven duplicates on four takes (three amped), missed 114 → 115 (`s161`, C22); with C20 slow DI 27 → 21, missed 114 → 112. Held-out: `s44` on the amped sixteenths take lost, its credit a wrong-pitch carve |
| C22 | An unannounced stub the pitch tracker split off the first hops of an attack lends its start to the Note the pitch change then opened: `s161`, A3 eighths DI — attack at 20026.67ms read 885 then 553Hz on an A3, the pitch change opened the A3 Note at 20053.33ms, the 27ms stub died unannounced and lent nothing, the label is at 20011ms and the Note reads 42ms late. The region's carve had been crediting it from 20024ms as a wholly overlapping duplicate, which C21 removes | tracker | DECISION-055 (the carve it replaces); DECISION-046 (a stub the release split off is absorbed and lends its start) | on the tuning takes, the count of unannounced stubs ended by a pitch change onto the same pitch class or its octave within two hops of an attack; then `s161` regained at +0 derivation missed and fp not up; held-out read once after | **spent, iteration 12** (DECISION-056), falsified by its read: 101 such stubs on the tuning takes, 82 the successor's pitch or its octave; DI stubs 0–13ms with successors on time; `s161` cannot be regained, one Note stands for two picks there and the miss moves to `s162`. Restated for the amped column: nine amped successors 42–77ms late would read within 40ms of their labels with the stub's start lent (seven on the E5 eighths amped take); falsifier those nine within 40ms at +0 derivation missed, fp and extras not up, DI takes bit-identical. **Amped restatement falsified by count, iteration 17** (DECISION-061): every such start lent on the tuning takes reads slow 168 → 170, extras 255 → 259, DI not bit-identical; an onset row for the amped column, not this loop's |
| C23 | A carved prefix of no pitch between a note's end and the next stroke's release — the string under the hand, level fallen to 1% — is offered to that stroke as its contact stub, the way the fast lane offers one, rather than declined as `prefix:unpitched`. Its two sites are HELD-OUT (the DI triplet take, 5693–5787ms and 6989–7080ms, where the shipped engine's window-start boundary produced the same Note and absorbed it), so the row reads on the tuning takes first | tracker | DECISION-055; `tryClaimPrefix` | on the tuning takes: every carved prefix declined `unpitched` under DECISION-055 listed with what sounds under it; a rule derived from those alone at +0 derivation missed and fp not up; held-out read once after, the two triplet Notes the prediction | **spent, iteration 14** (DECISION-058): the count found no `unpitched` decline on the tuning takes — the row as written falsified — and the shape standing twice there under `region-attack` (the held-then-picked DI take, 17413 and 41893ms, the attack branch's boundary on the contact). Rebuilt on the witness that separates them from the twenty-one real notes under the same decline, the fast lane's unvoiced hops (0.57 and 0.83 against 0 to 0.33): `tracking.prefixUnderHand`. Kept: slow DI 21 → 20, amped 149 → 148, fp 203 → 200, missed flat; held-out the two triplet Notes absorbed as predicted, and `t6` lost on the mic triplet take to a Note the detector lost the pitch of while its level held (C26) |
| C24 | The rise a transient carries is read over the two hops after it, not one: `a15` (quarters DI, 9000ms) reads 0.91, 1.997, 2.05 against the release bar of 2, and stays in the mute. The bar is not the lever (a lower one reads the contact, DECISION-053) | tracker (the list) | DECISION-055 (one hop) | `a14`'s charge cleared with nothing else on the DI takes moving, fp and extras not up; the count of transients whose rise peaks on the second hop after them, on the tuning takes | **built and reverted, iteration 12** (DECISION-056): `deep.transientRiseHops` 2 and 3 leave the quarters DI take bit-identical — the deep lane reads 9000ms at 2.053 and the boundary is the ATTACK branch's on the band-only mute onset at 8960ms, which the envelope-branch rule never sees — and cost `t17` on the clean-lead take (an earlier transient outranks the release under a longer reading). Spent: the reachable rule is C25 |
| C25 | The attack branch of `resegment.ts` places its boundary on the transient in the hop before a window's start, and `attackSamples` carries band-only onsets, so on a direct-input same-pitch stroke that transient is the mute's onset, 40–55ms before the release. Candidate: when that transient is band-only and a broadband transient whose rise clears `tracking.releaseRiseRatio` sits inside the window, the boundary is the latter — DECISION-055's envelope-branch rule applied to the branch that placed `a15`'s boundary. Reproduction: quarters DI, region 8507–9680ms, `attack@8960` on the band-only onset, broadband 9000ms rise 1.997, label 9015ms | deep | DECISION-055 (the envelope branch); DECISION-053 (the first transient, which read the mute) | on the tuning takes, the count of attack-branch boundaries standing on a band-only onset and how many have a rising broadband transient in their window; then `a14`'s charge cleared at +0 derivation missed, fp and extras not up, amped and mic not worse; held-out read once after | **built and reverted, iteration 13** (DECISION-057): `deep.segmentAttackOnRisingTransient`; count 648 attack-branch windows, 335 on a band-only onset, 163 with a rising transient in reach, 41 contacts; `a15` not reachable (1.997 under the bar on one hop). Slow DI 21 → 22, amped 149 → 148, fp 203 → 201, missed flat; the one DI change is two boundaries right (80 and 107ms early → 27ms) and the chain charge on `p1c3q4`. Spent: reads right, the count cannot see it. **Reopened 2026-09-19 under DECISION-063's instrument**: the falsifier is `a14`'s bar, the tuning DI slow split below 8 at +0 derivation missed, fp and extras not up, amped and mic not worse; `deep.segmentAttackOnRisingTransient` is in the commit history at DECISION-057 |
| C26 | The under-the-hand witness (DECISION-058) reads only the pitch's absence, and on the mic a sustained note the detector loses reads the same as a damped string: the mic triplet take's Note at 24973ms, no pitch on 9 of 12 hops with its level holding at 0.02–0.04 RMS, was absorbed and cost `t6`. Candidate: the level's fall read alongside — the fraction of the Note's hops under `analysis.rmsGate` (the two direct-input Notes under the hand on the tuning takes sit there on 4 of 8 and 5 of 8 hops), or its RMS at its end over its own peak (the amped one on the A3 eighths take falls to 6%; the mic Note holds) | tracker | DECISION-058 (the witness it completes); DECISION-046 (`CONTACT_RISE`, a level witness on the fast lane's own opening) | derived on the tuning takes alone: an edge with the three absorptions kept and every one of the twenty-one real notes under `region-attack` still refused; then held-out read once — `t6` regained with the two DI triplet absorptions kept is the prediction | **built and reverted, iteration 15** (DECISION-059): the gate in place of the pitch, `tracking.underHandReadsGate`. Keeps the two DI absorptions, regains `t6` on held-out (missed 28 → 27), and lets the amped duplicate on the A3 eighths take go (amped 148 → 149, fp 200 → 201) because an amp's floor sits above the gate; reverted on the letter. Spent: the level must be read relative to the Note, not the gate (C27) |
| C27 | The under-the-hand witness as two readings together: no pitch on at least half the Note's hops (DECISION-058) and the level fallen to at most half — its lowest hop over its loudest, or its RMS at its end over its own peak. On the tuning takes the three Notes DECISION-058 absorbs read 0.75 / 0.09, 0.50 / 0.37 and 0.75 / 0.06 (no pitch / lowest over loudest); the twenty-one real notes under `region-attack` read no pitch on at most 0.33 whatever their fall; the mic triplet Note that cost `t6` reads 0.73 / about 0.7 | tracker | DECISION-058 (the pitch half); DECISION-059 (the gate, which an amp's floor sits over) | on the tuning takes: bit-identical to DECISION-058's engine (the three absorptions kept, the twenty-one refused); then held-out read once — `t6` back with the two DI triplet absorptions kept is the prediction | **built and reverted, iteration 16** (DECISION-060): `tracking.underHandLevelFall` 0.5. Derivation bit-identical to DECISION-058's on every take; held-out `t6` back and nothing else moved — the prediction exactly. Reverted on the letter: better on no derivation path, a constant only a held-out take can see. Spent; **kept 2026-09-19 on the owner's decision** (PR decision 5, option 2; DECISION-062), outside the keep rule |

## Owner-side blockers (living)

| item | what it unblocks | asked | answered |
|---|---|---|---|
| Recordings of the tutorial passage from the owner's failing setup — his direct input into his computer's browser, through the game's capture path, with and without the gate calibration — then the phone when tried (brief §10) | any claim that a fix transfers to the owner's rig; derivation material for slow same-pitch notes on DI, which DECISION-033 also names as its precondition | 2026-09-18 (this file) | — |
| Has the owner run GOATerizer's input-gate calibration on the DI rig, and what gate is in force during the tutorial? | whether the DI failure is gated misses (`held-then-picked-di`'s shape) or splits; which of C6/C7/C9 to run first | 2026-09-18 | — |
| Label review of the eight 120bpm same-pitch takes: the 33 A3 grid placeholders; carrying the DI times to the amped files at +2.5ms; and, from iteration 2, the held-then-picked DI labels, which the envelope shows sitting 20–90ms AHEAD of the pick's contact on the five strokes probed (every other DI label sits on the release); and, from iteration 7, `e36` on the quarters DI take (35450ms), whose label sits on the pick's contact at 35445ms with the release at 35520ms, on a stroke whose release re-excited the string only to the gate's level — the one probed same-pitch DI label that sits on the contact | C4; reading the amped fast takes to better than ±65ms; the held-then-picked DI onset error, which reads worse under DECISION-046 for that reason | earlier (`docs/SAME-PITCH-MATERIAL.md`) | — |
| Does GOATerizer honour `structuralRevision` with `relation: "absorbed"`? | which form of C1 to build (retract vs never-announce) | 2026-09-18 | **Yes** (read from `trellos/goaterizer`, `src/input/tuninator-provider.ts`, its DECISION-105/110): an absorbed id becomes a `retract` that un-draws the bar, refunds a wrong-note charge and reopens an unjudged target. A verdict already shown is kept. Both forms of C1 therefore reach the game; see "What the consumer does with a split" below for why latency still matters. |
| A raw-capture switch in GOATerizer (dump the worklet input to WAV) | the recordings above being what the recognizer really hears, DI first | 2026-09-18 | No such switch exists yet; GOATerizer has no `MediaRecorder` or file capture anywhere in `src/`. Its labels editor reads this repository's `fixtures/`, it does not record. Briefed as `docs/goaterizer-capture-and-judgment-prompt.md`, to run in parallel in that repository. |
| A tempo hint on `EngineTuning` (product decision; the record bounds its value at about twice the shipped gate's reach, and not free) | nothing in the loop; a consumer-side lever | 2026-09-18 | — |
| The split instrument's forward reach: `measure-splits.ts` charges a Note that starts more than 40ms before its label to the label before it, so on a passage where every Note opens early (the DI same-pitch takes) fixing one boundary moves the charge to its neighbour and the column cannot fall one boundary at a time (iterations 5, 7, 10). Charge by nearest label start, or by most overlap? Every number in this journal moves with the answer | whether the DI slow-split column can read the boundary moves the loop is making | 2026-09-18 | — Iteration 13 (DECISION-057) adds a fourth: two boundaries on the held-then-picked DI take moved from 80ms and 107ms early to 27ms, and the count read one worse. With C11 also blocked on it, no open row targets the direct-input column until this is decided. **Decided 2026-09-19: most overlap with 40ms leeway (DECISION-063).** C11 and C25 reopened; see "The instrument re-read" below |

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

### Iteration 6 — 2026-09-18 — KEPT — the release test reads the hop the gate refuses, and its window is six hops, not 80.0000000000018ms

- Candidate: **C12**, the release arriving on a hop the amplitude gate
  refuses. Nearest closed relative: DECISION-046, the release test itself;
  the difference is that the test is reached on a gated hop, and that its
  window is measured in samples.
- Falsifier, stated before measuring: derivation slow DI split 30 → 28,
  the two labels the trace read as reachable (`e851` at the window's
  edge, `e815` under the gate); derivation missed and false positives not
  up; amped and mic takes not worse; held-out read once after. Nothing to
  sweep: a boolean and an exact comparison.
- Built: `tracking.releaseOnGatedHop` (true; false = DECISION-046 as
  shipped) in `config.ts`; step (a) of `note-tracker.ts` reads
  `isRelease` when the verdict was `gated` and the Note is unsettled,
  traced `released` via `gated`; `isRelease` compares
  `attack.atSample - startSample` with `clock.durationSamples(80)`; two
  tests on a synthesized stroke whose release begins under a raised gate.
- Sweep (derivation predicate: not 140bpm): off → on, slow DI 30 → 29 of
  327, E5 eighths DI 9 → 8; window fix alone reads the same 29 (`e851`);
  the gated path moves `e816`'s and `e817`'s boundaries to within 10ms and
  the split charge on `e815` moves to `e817`.
- Numbers, before → after:
    slow subset      DI 30/327 → 29/327     amped+mic 152/334 → 152/334 (bit-identical per take)
    corpus           289 / 346 / 19 → 288 / 345 / 19; slow subset 216 / 268 → 215 / 267
    tail fragments   238 / 258, same pitch 235 / detached 0 / other 23 — unchanged
    ledger MISSED    141 — unchanged
    by material      derivation missed 114 → 114, fp 211 → 211, extras 271 → 270, split 219 → 218, |onset| med 25 → 23; held-out (read once, after) split 70, extras 75, fp 66, missed 27 — identical on every take
    eval             PASS; required 0 failures; informational the one pre-existing
    consumer view    not retracting — the start moves before the Note is announced
    tests            530 passing (528 + 2)
- Read before building, at the current engine: the shape classification
  of the 30 is unchanged from iteration 2, and the trace at each of C12's
  "3 + 1 + 2" says two are reachable here. `e839`'s release is 91ms after
  a fine-opened contact; `e835`'s and `a3`'s early Notes are the region
  lane's; `e830`'s contact was delivered by the fine witness after the
  release had passed. Recorded in the findings and the C12 row.
- Why 29 and not 28: `e817`'s contact at 5893ms, refused at the ring-out
  branch before, now reaches the rolling-baseline test because the Note
  before it is 80ms younger (C15's coupling, this time in the rule's
  favour), is accepted, and the unsettled release then moves it onto the
  release; `e818`'s fine-opened contact (announced at 55ms, gated release
  at +77ms) is then charged to `e817`. Three boundaries right instead of
  one; the count credits one.
- Verdict and why: kept. Every keep line holds with nothing against it,
  the amped, mic and held-out takes are bit-identical, and the window
  comparison was a defect in DECISION-046's own rule whatever the gate
  does.
- What a GOATerizer player would notice: **on a direct input**, two more
  eighth notes on the E5 take begin when the string sounds rather than
  when the pick lands, one of them a note that used to read as two.
  **Through an amp**, nothing.
- Findings section: "The release can land on a hop the amplitude gate
  refuses, and the window it must land in is six hops, not
  80.0000000000018 milliseconds"; DECISION-050; commit on
  `claude/project-thread-46x8sd`.
- Ledger changes: C12 spent, with its remaining sub-shapes named; C16
  added (the announce bar for a fine-opened contact). Noted, not acted
  on: `articulationMs` is compared in milliseconds at two other sites
  (the burst `continues` test, the articulation-fragment length test),
  which have the same edge.
- Exit rule: continue. C15's first read next (the ring-out clock on
  DECISION-046's own moves), then C16.

### Iteration 7 — 2026-09-18 — REVERTED — the gated release on a fine-opened Note's birth frame: two boundaries right, one stroke whose release barely sounded lost; C15 closed by its read

- Candidate: **C15** first, read only: on the four derivation DI takes at
  the shipped engine, 47 starts moved by the release test, 23 transients
  in the reopened window, 2 changed verdicts (`e817`, `e853`: ring-out
  refusal → `sharpness`, then onto the release by the unsettled path), 0
  phantoms. Closed without a build. Then **C16**, the fine-opened
  contact's release. Nearest closed relative: DECISION-050 (d); the
  difference is that the read corrected the row — `e818`'s Note is not
  announced before its release arrives, it is BORN on the release's hop
  (the fine witness delivers the contact 65ms late), settled at 77ms and
  unannounced, and `!settled` refused it, not the announce bar.
- Falsifier, stated before measuring: derivation slow DI split 29 → 28,
  `e817`'s charge cleared; derivation missed and false positives not up;
  amped and mic not worse; held-out read once after.
- Built: `tracking.releaseOnGatedHopSettled` (true; false = DECISION-050
  as shipped) in `config.ts`; step (a) of `note-tracker.ts` reads
  `(!settled || releaseOnGatedHopSettled)`; `isRelease`'s `!announced`
  guard kept, so the path reaches a fine-opened Note on its birth frame
  only; a frame-driven `NoteTracker` test with a fine onset delivered on
  a gated hop.
- Sweep (derivation predicate: not 140bpm): off → on, slow DI 29 → 27 of
  327; E5 eighths DI 8 → 7 (`e817`: 6122.67 → 6200ms, 10ms from
  `e818`); quarters DI 8 → 7 (`e35`: the release's own fine onset no
  longer splits a Note that now starts on the release; one false positive
  gone) and missed 1 → 2 (`e36`); held-then-picked DI one boundary moved
  67ms (`p6c4q2`), counts unchanged.
- Numbers, before → after:
    slow subset      DI 29/327 → 27/327     amped+mic 152/334 → 152/334 (bit-identical per take)
    corpus (deriv)   split 218 → 216, extras 270 → 268, strays 9, missed 114 → 115, fp 211 → 210, det 1308 → 1306
    tail fragments   not re-run: reverted on the derivation result
    ledger MISSED    not re-run: reverted on the derivation result
    by material      derivation missed 114 → 115, extras 270 → 268; held-out NOT read
    eval             not re-run on the candidate; PASS on the reverted engine (DECISION-050's)
    consumer view    not retracting — the start moves before the Note is announced
    tests            533 with the candidate; 530 after the revert
- The lost label: `e36`, quarters DI, 35450–35930ms. Contact at 35445ms
  (fine dip −29dB) muted the string to 0.0019 RMS; the release at
  35506–35520ms (rise 2.1, gated) re-excited it to 0.0080, which is the
  gate, so the fast lane heard one voiced hop. Born at the contact the
  Note had 75ms on its clock and was announced, matched by 5ms; started
  at the release it had 13.33ms and died unannounced. The move re-decides
  the Note because the announce clock reads from the moved start. A
  mechanism, on every stroke this path reaches.
- Verdict and why: reverted; missed up by one, and the keep rule has no
  exception for the count that would be 27. `src/` is DECISION-050's,
  bit-identical (`git diff HEAD -- src/` empty; splits 29/327, corpus
  288 / 345 / 19, tests 530).
- What a GOATerizer player would notice: nothing changed this iteration.
  Had it been kept: on a direct input, two more notes begin when the
  string sounds, and one very soft stroke on the quarters take would not
  register at all.
- Findings section: "The release test reaches a Note the fine witness
  opened only on the frame that opens it, and moving that Note loses a
  stroke whose release barely sounded"; DECISION-051; commit on
  `claude/project-thread-46x8sd`.
- Ledger changes: C15 spent (closed by the read, no derivation case reads
  wrong); C16 spent (built and reverted, premise corrected); C17 added:
  the gated release on a fine-opened Note keeps the announce clock on the
  contact, so the move relocates the boundary and does not re-decide the
  Note. New owner-side item, not a blocker: `e36`'s label sits on its
  contact (35450ms) where the other probed same-pitch DI labels sit on the release;
  the release on that stroke is the quietest thing in it.
- Exit rule: continue. One built-and-reverted iteration since the last
  kept one, and C17 is a new row with a stated falsifier. C17 next, as
  one mechanism (the C16 path with the clock kept).

### Iteration 8 — 2026-09-18 — KEPT — the release moves a fine-opened Note on its birth frame and keeps its announce clock on the contact

- Candidate: **C17**, the gated release on a Note the fine witness
  opened, with the announce clock kept on the contact. Nearest closed
  relative: iteration 7's build (DECISION-051), the same move without the
  clock; the difference is that `announceSoundedMs` reads from
  `ownStartTime` for the moved Note, so the move places the boundary and
  does not re-decide the Note.
- Falsifier, stated before measuring: derivation slow DI split 29 → 27
  (`e817`, `e35`) with missed 114 → 114 (`e36` regained on overlap);
  false positives and extras not up; amped and mic not worse; every Note
  the rule newly announces counted, each matched or charged; held-out
  read once after. Nothing to sweep: a boolean.
- Built: `tracking.releaseOnFineOpenedFrame` (true; false = DECISION-050
  as shipped) in `config.ts`; step (a) of `note-tracker.ts` reads the
  gated release on `(!settled || (fineOpened && key))` and sets
  `releasedFromContact` on a settled move; `note-record.ts`
  `announceSoundedMs` reads from `ownStartTime` for it; four frame-driven
  tests in `release-clock.test.ts`, one of which fails with the clock
  line removed.
- Sweep (derivation predicate: not 140bpm): off → on, slow DI 29 → 27 of
  327; E5 eighths DI 8 → 7 (`e817` → 6200ms); quarters DI 8 → 7 (`e35`,
  and the phantom its release's own fine onset opened is gone: fp 4 → 3,
  det 75 → 74); held-then-picked DI one boundary moved, counts unchanged.
  Four Notes moved on their birth frame; `e36`'s is the one newly
  announced, 35520–35546.67ms inside its label, matched on overlap.
- Numbers, before → after:
    slow subset      DI 29/327 → 27/327     amped+mic 152/334 → 152/334 (bit-identical per take)
    corpus           288 / 345 / 19 → 286 / 343 / 19; slow subset 215 / 267 → 213 / 265
    tail fragments   238 / 258 → 237 / 257, same pitch 235 → 234 (the phantom on `e35`)
    ledger MISSED    141 — unchanged
    by material      derivation missed 114 → 114, fp 211 → 210, extras 270 → 268, split 218 → 216; held-out (read once, after) split 70, extras 75, fp 66, missed 27 — identical on every take
    eval             PASS; required 0 failures; informational the one pre-existing
    consumer view    not retracting — the start moves before the Note is announced
    tests            534 passing (530 + 4)
- Verdict and why: kept. Every keep line holds with nothing against it,
  and the one label iteration 7 lost is back where it was, with its Note
  now starting on the release.
- What a GOATerizer player would notice: **on a direct input**, two more
  notes begin when the string sounds rather than when the pick lands, one
  of them a note that used to read as two; a very soft stroke still
  registers. **Through an amp**, nothing.
- Findings section: "The release moves a Note the fine witness opened
  without re-deciding it: the announce clock stays on the contact";
  DECISION-052; commit on `claude/project-thread-46x8sd`.
- Ledger changes: C17 spent (kept). No new rows: the 27 left on the DI
  column are the shapes the C12 and C11 rows already name, 10 phantoms,
  and 4 with no release-shaped onset in the window.
- Exit rule: continue. Nothing built and reverted since iteration 7, and
  the ledger still has rows with stated falsifiers (C13 to derive on the
  tuning takes, C14). The C11 shape, 9 of the 27, needs the chain
  reading in `measure-splits.ts` addressed before a third build.

### Iteration 9 — 2026-09-18 — REVERTED — the region lane's envelope boundary moved onto the transient inside its window: the transient is the mute as often as the release

- Candidate: **C18**, added this iteration from a read of the seven sites
  the fast lane never placed: four are region-lane Notes whose
  envelope-rise boundary sits at the START of the 85ms window that
  noticed the rise, in the mute, with the fast lane's release transient
  inside that window unread. Nearest closed relative: the `attack` branch
  of `resegment.ts` (its own rule that the boundary is the
  transient), which reads only the hop before the window's start.
- Falsifier, stated before measuring: derivation slow DI split 27 → 23
  or fewer (`a2`, `a4`, `a15`, `e825`); missed, false positives and
  extras not up; amped and mic not worse; held-out read once after.
- Built: `deep.segmentRiseOnTransient` (true; false = as shipped) in
  `config.ts`, `riseOnTransient` on `SegmentOptions`; the envelope branch
  of `segmentRegion` takes the first transient inside its window as the
  boundary; two tests on a handwritten sequence in `resegment.test.ts`.
- Sweep (derivation predicate: not 140bpm): off → on, slow DI 27 → 34;
  `a4` moved 3427 → 3467ms as designed; five labels regained (three E5
  sixteenths, two A3); ten extras, four of 93–96ms at mute onsets and
  contacts, six of 227–386ms in sixteenth runs.
- Numbers, before → after:
    slow subset      DI 27/327 → 34/327     amped+mic 152/334 → 152/334 (bit-identical per take)
    corpus (deriv)   split 216 → 224, extras 268 → 276, strays 9, missed 114 → 109, fp 210 → 220, det 1307 → 1322
    tail fragments   not re-run: reverted on the derivation result
    ledger MISSED    not re-run: reverted on the derivation result
    by material      derivation missed 114 → 109, extras 268 → 276; held-out NOT read
    eval             not re-run on the candidate; the reverted engine is DECISION-052's
    consumer view    region-lane Notes, announced ended; not retracting
    tests            536 with the candidate; 534 after the revert
- Why: `NoteTracker.attackSamples` records every hop energy arrived on,
  band-only onsets included, with no rise attached; on a DI same-pitch
  stroke the band witness fires at the mute's onset and the burst's first
  broadband attack is often the contact, so the first transient in a
  window that begins in the mute is the mute or the contact as often as
  the release, and `minSegmentMs` of muted string becomes a Note.
- Verdict and why: reverted; every count but missed went the wrong way.
  `src/` bit-identical (`git diff HEAD -- src/` empty; splits 286 / 343
  / 19 re-measured).
- What a GOATerizer player would notice: nothing changed this iteration.
- Findings section: "The region lane's envelope boundary sits at the
  start of the window that noticed the rise, and the transient inside
  that window is as often the mute as the release"; DECISION-053; commit
  on `claude/project-thread-46x8sd`.
- Ledger changes: C18 added and spent; C19 added — the transient list
  carries kind and rise, and the envelope boundary goes on the first
  broadband transient in its window whose rise clears the release bar.
- Exit rule: continue. One built-and-reverted iteration since the last
  kept one, and C19 is a new row with a stated falsifier.

### Iteration 10 — 2026-09-18 — REVERTED — the region lane's boundary on the transient that rose: two boundaries right, the count flat through the chain, three sites short by one hop, one duplicate Note

- Candidate: **C19**, the transient list carrying each transient's
  witness and rise, and the envelope boundary on the first broadband
  transient inside its window whose rise clears
  `tracking.releaseRiseRatio`. Nearest closed relative: DECISION-053
  (the first transient); the difference is the witness and the bar.
- Falsifier, stated before measuring: derivation slow DI split 27 → 23 or
  fewer (`a2`, `a4`, `a15`, `e825`); missed, fp and extras not up;
  iteration 9's ten extras absent; amped and mic not worse; held-out
  read once after.
- Built: `RegionTransient` in `contracts.ts`; `attackRises` and
  `transientsIn` in `note-tracker.ts`; `transients` on
  `DeepRegionRequest` from both request sites in `engine.ts`, merged in
  `deep-lane.ts`; `riseOnRisingTransient`, `transients`,
  `transientRiseRatio` on `SegmentOptions`; `deep.segmentRiseOnRisingTransient`
  (true; false = as shipped); two tests in `resegment.test.ts`.
- Sweep (derivation predicate: not 140bpm): off → on, slow DI 27 → 27;
  `a4` 3427 → 3467ms and `e836` moved onto their releases, charges moved
  to `a4` and `e855`; `a2`, `a15`, `e825` unmoved (rise on the transient's
  hop 1.03 / 0.91 / 1.68, next hop 2.67 / 2.00 / 4.35); one duplicate
  Note at 32293ms on the A3 take.
- Numbers, before → after:
    slow subset      DI 27/327 → 27/327     amped+mic 152/334 → 152/334 (bit-identical per take)
    corpus (deriv)   split 216 → 217, extras 268 → 269, strays 9, missed 114 → 111, fp 210 → 210, det 1307 → 1310
    tail fragments   not re-run: reverted on the derivation result
    ledger MISSED    not re-run: reverted on the derivation result
    by material      derivation missed 114 → 111, extras 268 → 269; held-out NOT read
    eval             not re-run on the candidate; the reverted engine is DECISION-052's
    consumer view    region-lane Notes, announced ended; not retracting
    tests            536 with the candidate; 534 after the revert
- Verdict and why: reverted; extras up by one (the duplicate) and the
  column flat. `src/` bit-identical to DECISION-052's (`git diff HEAD --
  src/` empty).
- What a GOATerizer player would notice: nothing changed this iteration.
- Findings section: "The region lane's boundary on the transient that
  rose: right where it reaches, unseen by the count, and short of three
  sites by one hop"; DECISION-054; commit on
  `claude/project-thread-46x8sd`.
- Ledger changes: C19 spent; C20 added (the transient's rise is the
  larger of its hop's and the next hop's); C21 added (a carved segment
  whose start coincides with an existing Note's merges with it). New
  owner-side item: the split instrument's 40ms forward reach charges an
  early Note to the label before it, so a chain of early boundaries
  cannot read better one boundary at a time; charging by nearest label
  start or by most overlap is the owner's call, since every number moves.
- Exit rule: two consecutive built-and-reverted iterations, each with a
  new ledger row carrying a stated falsifier, so the rule's first clause
  does not fire; C20 next, built together with C21 only if C20 alone
  reproduces the duplicate.

### Iteration 11 — 2026-09-18 — KEPT — the rise read on the transient's hop or the next, and a carve that sees every Note: six boundaries right, seven duplicates gone

- Candidates: **C20**, the transient's rise as the larger of its own
  hop's and the next hop's; and **C21**, built with it because C20 alone
  reproduced the duplicate, as iteration 10 said it would be. Nearest
  closed relative: DECISION-054 (the rise on the transient's hop only;
  the carve as shipped).
- Falsifier, stated before measuring: C20 — derivation slow DI split 27
  → 24 or fewer with `a2`, `a15`, `e825`, `a4` each within 40ms of their
  labels, missed 114 → 111 or fewer kept, fp not up, extras not up, amped
  and mic not worse, the A3 duplicate named. C21 — the duplicate absent,
  extras not up, no label a fast-lane Note already matched lost.
  Held-out read once after, for the pair.
- Built: `pendingRise` in `note-tracker.ts` folds the next frame's
  `riseRatio` into the newest `RegionTransient` before that frame's onset
  block runs; `carveAfter` scans every Note the tracker holds
  (candidates, open, closing, ended) and returns where one begins within
  a hop (`hopMs`, the snapped fast hop) of the boundary;
  `deep.regionCarveSeesEveryNote` (true; false = the carve as shipped)
  beside `deep.segmentRiseOnRisingTransient` (true; false = as shipped).
  Tests: `region-transients.test.ts` (one, the list with witness and the
  lagged rise), two in `region-reconcile.test.ts` (nothing carved where
  the successor already begins; the duplicate carved with the key off),
  iteration 10's two in `resegment.test.ts`.
- Sweep (derivation predicate: not 140bpm), all four settings, both off
  bit-identical to DECISION-052's engine:
    rise alone       slow DI 27 → 24, amped+mic 152 → 152, split 216 → 214, extras 268 → 266, missed 114 → 110, fp 210 → 210
    carve alone      slow DI 27 → 24, amped+mic 152 → 149, split 216 → 209, extras 268 → 260, missed 114 → 115, fp 210 → 203
    both             slow DI 27 → 21, amped+mic 152 → 149, split 216 → 206, extras 268 → 257, missed 114 → 112, fp 210 → 203
  `a2`, `a4`, `e825`, `e836` onto their releases (`a1`, `a3`, `e824`,
  `e835` cleared; the charge on `a4` from `a5`'s C11 contact); `a15`
  unmoved at a rise of 1.997 on the next hop, 2.05 on the one after.
  Seven duplicates gone, each a Note that began within a hop of another,
  three of them on amped takes. `s161` lost to the carve rule (its credit
  was a wholly overlapping carve; C22).
- Numbers, before → after:
    slow subset      DI 27/327 → 21/327     amped+mic 152/334 → 149/334
    corpus           286 / 343 / 19 → 277 / 333 / 20; slow subset 213 / 265 → 206 / 257
    tail fragments   237 / 257 → 233 / 250, same pitch 234 → 227
    ledger MISSED    141 → 139
    by material      derivation missed 114 → 112, fp 210 → 203, extras 268 → 257, split 216 → 206; held-out (read once, after) split 70 → 71, extras 75 → 76, strays 10 → 11, fp 66 → 69, missed 27 → 27
    eval             PASS; required 0 failures; informational the one pre-existing; `docs/EVALUATION.md` refreshed from the report (four held-out rows, two sentences)
    consumer view    region-lane Notes, announced ended; not retracting
    tests            539 passing (534 + 5)
- Held-out, attributed on the four-way listing of the final Notes at each
  site: the rise adds two 91–94ms unpitched Notes on the DI triplet take
  (the string under the hand before the D5 at 5787ms and the A4 at
  7080ms, which the shipped engine carved too and absorbed as contact
  stubs; C23) and one A#4 Note in the mic power-chord take's tail, and
  regains `s6` on the DI sixteenths take with a Note named B3 where the
  label says F#5; the carve loses `s44` on the amped sixteenths take,
  whose credit was an E5 carved 8ms after the label ended beside the
  fast lane's F#5.
- Verdict and why: kept on the derivation rule (slow subset better on
  both paths, worse on neither; extras down; missed down; eval PASS). The
  held-out trade — three false positives and one label for one label —
  is the owner's at review, as iteration 2's was.
- What a GOATerizer player would notice: on a direct input, six more slow
  strokes register for their full length; through an amp, seven doubled
  strokes on the same-pitch takes register once.
- Findings section: "The region lane's boundary on the transient that
  rose, read one hop late, and a carve that sees every Note: six
  boundaries right, seven duplicates gone, one site short by 0.003";
  DECISION-055; commit on `claude/project-thread-46x8sd`.
- Ledger changes: C20 spent (kept); C21 spent (kept; its cause was
  `carveAfter`, not `splitAtSegments`); C22 added (the octave-misread
  stub lends its start); C23 added (the unpitched carved prefix offered
  as the contact stub; derive on the tuning takes first); C24 added (the
  rise over the two hops after the transient).
- Exit rule: not reached; a kept iteration. Next: C22 (`s161`, one site
  on the tuning takes and a count to take first), then C24, C13, C14;
  C23 only after its tuning-take read.

### Iteration 12 — 2026-09-18 — REVERTED — the octave stub read (nothing for the direct input) and the rise read two hops out (`a15`'s boundary was the attack branch's all along)

- Candidates: **C22** first, falsified on the bench by a count; then
  **C24**, built. Nearest closed relative: DECISION-055 (the rise on the
  transient's hop or the next).
- Falsifier, stated before measuring: C22 — the stubs counted with their
  pitch against the successor's, then `s161` regained at +0 derivation
  missed, fp not up. C24 — `a14`'s charge cleared, slow DI 21 → 20 or
  fewer, missed, fp, extras not up, amped and mic not worse; held-out
  read once after.
- C22 read (`stubs.ts`): 101 unannounced attack stubs ended by a pitch
  change within three hops; 82 the successor's pitch or its octave; 21
  successors matched more than 40ms late, 9 of them with the stub's
  start within 40ms, all amped. On the DI takes the stubs are 0–13ms and
  the successors on time; `s161` sits where one Note stands for two
  picks, so the miss moves to `s162` under any start. Falsified as
  stated; restated for the amped column.
- C24 built: `deep.transientRiseHops` (2; 1 = DECISION-055), one tracker
  test; 540 tests. Sweep at 1, 2, 3 hops:
    hops 1   slow DI 21/327, other 149/334, split 206, extras 257, missed 112, fp 203
    hops 2   slow DI 21/327, other 149/334, split 206, extras 257, missed 113, fp 203
    hops 3   identical to 2
  Quarters DI bit-identical: the deep lane read 9000ms at 2.053 and the
  boundary stayed, because it is the attack branch's on the band-only
  mute onset at 8960ms, not an envelope boundary. Clean-lead loses `t17`
  (an earlier transient outranks the release under two hops).
- Numbers, before → after: none kept; `src/` bit-identical to
  DECISION-055's (`git diff HEAD -- src/` empty). Held-out not read.
- What a GOATerizer player would notice: nothing changed this iteration.
- Findings section: "The octave stub read and the rise read two hops out:
  nothing for the direct input in either, and `a15`'s boundary was never
  the envelope's"; DECISION-056; commit on
  `claude/project-thread-46x8sd`.
- Ledger changes: C22 spent (falsified by its read; restated for the
  amped column); C24 spent (built and reverted); C25 added (the attack
  branch's band-only transient replaced by the broadband rising transient
  in the window), with `a15`'s reproduction and a falsifier.
- Exit rule: one built-and-reverted iteration after a kept one, with a
  new row carrying a stated falsifier; the rule does not fire. C25 next.

### Iteration 13 — 2026-09-18 — REVERTED — the attack branch on the transient that rose: right on both boundaries it moved on the direct input, and the count reads one worse

- Candidate: **C25**, the attack branch of `resegment.ts` preferring the
  broadband transient whose rise clears the release bar inside its
  window over the band-only onset (or contact) it read. Nearest closed
  relative: DECISION-055 (the same rule in the envelope branch).
- Falsifier, stated before measuring: the count first; then `a14`'s
  charge cleared at +0 derivation missed, fp and extras not up, amped and
  mic not worse. The count showed `a15` unreachable (release at 1.997
  under the bar on DECISION-056's one-hop reading), so before the sweep
  the falsifier became: slow DI 21 → 20 or fewer, missed, fp, extras not
  up, amped and mic not worse; held-out read once after.
- Count (`atkcount.ts`): 648 attack-branch windows on the tuning takes;
  335 on a band-only onset, 163 with a rising broadband transient in the
  window; 201 on a transient that rose; 41 on a contact with a rising
  transient later.
- Built: `risingTransientIn` factored out of the envelope branch and
  applied in the attack branch under `deep.segmentAttackOnRisingTransient`
  (true; false = as shipped); two tests in `resegment.test.ts`; 541 tests.
- Sweep (derivation predicate: not 140bpm), rise and carve on:
    off   slow DI 21/327, other 149/334, split 206, extras 257, missed 112, fp 203, det 1302
    on    slow DI 22/327, other 148/334, split 206, extras 257, missed 112, fp 201, det 1300
  Two takes change. Held-then-picked DI: `p1c3q3`'s Note 12960 → 13013ms
  and `p1c3q4`'s 13453 → 13533ms (labels 13040, 13560), the 94ms Note at
  17413ms gone (placed on the release at 17507ms where the fast lane's
  Note begins); the charge lands on `p1c3q4` because `p1c4h`'s Note
  starts 88ms early on a refused contact. A3 eighths amped: one fp fewer.
- Numbers, before → after: none kept; `src/` bit-identical to
  DECISION-055's (`git diff HEAD -- src/` empty). Held-out not read.
- Verdict and why: reverted on the keep rule's letter (DI path worse by
  one). The read: right where it reaches, unseen by the count — the split
  instrument's chain reading for the fourth time.
- What a GOATerizer player would notice: nothing changed this iteration.
- Findings section: "The attack branch on the transient that rose: two
  boundaries right on the held-then-picked take, two false positives
  fewer, and the count reads one worse"; DECISION-057; commit on
  `claude/project-thread-46x8sd`.
- Ledger changes: C25 spent (built and reverted, blocked on the
  instrument like C11). No new mechanism row. The owner-side blocker row
  on the forward reach carries iteration 13's evidence.
- Exit rule: not fired by its letter — iteration 12 added a row, and
  C13, C22 (amped onsets) and C23 (a count first) still carry stated
  falsifiers — but every row that targets the direct-input column (C11,
  C25) is blocked on the owner's decision about the split instrument's
  forward reach, and the loop's direct-input work stops here until it
  lands. What continues without it is the amped column's (C22) and the
  held-out sites' count (C23).

### Iteration 14 — 2026-09-18 — KEPT — the string under the hand as the next stroke's preparation: C23's count found no site as written, the shape stood twice under another refusal, and the witness that separates it from real notes is the fast lane's own unvoiced hops

- Candidate: **C23**, first as written (a carved prefix of no pitch offered
  as the stroke's contact stub rather than declined `unpitched`), then
  restated on the count. Nearest closed relative: DECISION-055 (the carve
  that produces the Note), DECISION-046 (a stub the release split off is
  absorbed and lends nothing).
- Falsifier, stated before measuring: the count first — every carved
  prefix declined `unpitched` on the tuning takes, with what sounds under
  it. Zero such declines, so the row as written fell to its count. The
  restated candidate's falsifier, stated before the sweep: the two
  direct-input Notes under the hand absorbed (fp 203 → 201 or better),
  derivation missed +0, extras and fp not up, amped and mic not worse;
  held-out read once after, the two triplet Notes the prediction.
- Count (`prefix-unpitched.ts`, `prefix-kind.ts`): declines on the tuning
  takes by reason — `trigger` 838, `stroke` 134, `too-long` 77,
  `region-attack` 35, `decided` 13, `pitch` 1, `unpitched` 0. Of the 35
  `region-attack`: 21 matched real notes (5 opened by the rising branch,
  16 by the shipped attack branch, 9 of those band-only), 14 false
  positives: two under the hand (held-then-picked DI, 17413 and 41893ms,
  93ms each, the boundary at their start a broadband contact at rise
  0.94 and 0.84), three sustained amped E5 Notes, nine held amped D5/G4
  Notes another row's. The fast lane's unvoiced hops under the Note: 0.57
  and 0.83 for the two; 0 to 0.33 for the twenty-one; 0.71 for one amped
  Note holding `e864`'s credit.
- Built: `tracking.prefixUnderHand` (true; false = as shipped),
  `tracking.underHandUnvoicedFraction` 0.5; `voicedLog` and
  `unvoicedFractionIn` on the tracker; the offer made past the region's
  attack boundary, `strokeNear` reading only transients whose rise cleared
  the release bar for a Note under the hand, the claim regardless of
  pitch class; two tests in `region-reconcile.test.ts`; 541 tests.
- Sweep (derivation predicate: not 140bpm):
    off   slow DI 21/327, other 149/334, split 206, extras 257, strays 9, missed 112, fp 203, det 1302
    on    slow DI 20/327, other 148/334, split 204, extras 255, strays 9, missed 112, fp 200, det 1299
  Three Notes absorbed, the three the count named; nothing else moved.
  Held-out, read once: missed 27 → 28, fp 69 → 67, split 71 → 69, extras
  76 → 74, slow 36 → 34. DI triplet: the two Notes absorbed as predicted
  (fp 10 → 8). Mic triplet: the Note at 24973ms (147ms, no pitch on 9 of
  12 hops, level holding at 0.02–0.04 RMS) absorbed into the C5 Note at
  25133ms, which then holds `t5` by overlap; `t6` unmatched.
- Numbers, before → after: derivation as above; corpus 277 / 333 / 20 →
  273 / 329 / 20; ledger MISSED 139 → 140; eval PASS, the same
  informational failure; `docs/EVALUATION.md` refreshed.
- Verdict and why: kept on the keep rule (slow subset better on both
  paths, extras down, derivation missed flat, eval PASS). The held-out
  label is the owner's item (PR decision 5); its cause, the witness
  reading a lost pitch as a damped string, is ledger row C26.
- What a GOATerizer player would notice: on the direct input, a note
  damped and re-picked no longer shows a ghost note of the muted string
  between the two; through the mic, one sustained note in the triplet
  passage now reads as the preparation of the one after it.
- Findings section: "The string under the hand as the next stroke's
  preparation: the row's count found no site as written, and the shape it
  named stood twice under another refusal"; DECISION-058; commit on
  `claude/project-thread-46x8sd`.
- Ledger changes: C23 spent (kept, restated). C26 new: the level's fall
  alongside the pitch's absence, derived on the tuning takes first.
- Exit rule: not fired — this iteration added a row with a falsifier
  (C26), and C13 and C22 (amped onsets) still stand. The direct-input
  rows C11 and C25 remain blocked on the owner's instrument decision.

### Iteration 15 — 2026-09-19 — REVERTED — the under-the-hand witness read on the gate: `t6` back, the amped duplicate let go, reverted on the letter

- Candidate: **C26**, the level's fall alongside the pitch's absence,
  built in its simplest form: hops under `analysis.rmsGate` in place of
  hops without a pitch. Nearest closed relative: DECISION-058.
- Falsifier, stated before measuring: the row's, first — the three
  DECISION-058 absorptions kept and the twenty-one real notes refused on
  the tuning takes; then held-out once, `t6` back. The derivation table
  (the 35 candidates read on no-pitch, under-gate and lowest-over-loudest)
  showed the gate reading 0 on the amped duplicate, so the falsifier was
  restated before the sweep: the two DI absorptions kept, the amped one
  let go (fp 200 → 201), DI takes bit-identical, missed +0; held-out
  `t6` back.
- Built: `tracking.underHandReadsGate` (true; false = DECISION-058's
  reading); `voicedLog` carries `gated`; one test; 542 tests.
- Sweep (derivation predicate: not 140bpm):
    off   slow DI 20/327, other 148/334, split 204, extras 255, strays 9, missed 112, fp 200, det 1299
    on    slow DI 20/327, other 149/334, split 205, extras 256, strays 9, missed 112, fp 201, det 1300
  One take changes, the A3 eighths amped, its duplicate at 17912ms kept.
  Held-out, read once: missed 28 → 27 (`t6`), fp 67 → 67, split and
  extras unchanged; only the mic triplet take moves.
- Numbers, before → after: none kept; `src/` and `tests/` bit-identical
  to DECISION-058's (`git diff HEAD -- src/ tests/` empty).
- Verdict and why: reverted on the keep rule's letter — the slow subset
  worse on the amped path by one. The read: the gate is an absolute an
  amp's floor sits above; the level must be read relative to the Note.
- What a GOATerizer player would notice: nothing changed this iteration.
- Findings section: "The under-the-hand witness read on the gate: the mic
  label back, the amped duplicate let go, and the letter of the keep
  rule"; DECISION-059; commit on `claude/project-thread-46x8sd`.
- Ledger changes: C26 spent (built and reverted). C27 new: no pitch on
  half the hops and the level fallen to half of the Note's own peak, with
  the tuning-take table as its derivation.
- Exit rule: not fired — this iteration added a row with a stated
  falsifier (C27). C13 and C22 (amped onsets) still stand; C11 and C25
  remain blocked on the owner's instrument decision.

### Iteration 16 — 2026-09-19 — REVERTED — the under-the-hand witness as pitch and level together: the prediction exactly, and a constant only a held-out take can see

- Candidate: **C27**, no pitch on half the hops and the level fallen to
  half of the Note's own peak. Nearest closed relative: DECISION-058 (the
  pitch half), DECISION-059 (the gate).
- Falsifier, stated before measuring: derivation bit-identical to
  DECISION-058's engine (the three absorptions kept, the twenty-one real
  notes refused); held-out read once, `t6` back with the two DI triplet
  absorptions kept.
- Built: `tracking.underHandLevelFall` (0.5; 1 = DECISION-058's
  reading); the hop log carries RMS; `levelFallIn`; one test; 542 tests.
- Sweep (derivation predicate: not 140bpm): fall 1 and fall 0.5
  identical on every take line — slow DI 20/327, other 148/334, split
  204, extras 255, strays 9, missed 112, fp 200, det 1299. Held-out, read
  once: missed 28 → 27 (`t6`, mic triplet take, onset p90 98 → 89ms), fp
  67 → 67, split and extras unchanged.
- Numbers, before → after: none kept; `src/` and `tests/` bit-identical
  to DECISION-058's (`git diff HEAD -- src/ tests/` empty).
- Verdict and why: reverted on the keep rule's letter — better on no
  derivation path. The read: the level half is right as far as either
  set can say, but nothing on the tuning takes is refused by it, so its
  constant is checkable only on held-out (§6.6; the iteration 2
  precedent). Put to the owner as option 3 on PR decision 5.
- What a GOATerizer player would notice: nothing changed this iteration.
- Findings section: "The under-the-hand witness as pitch and level
  together: the mic label back, the tuning takes bit-identical, and a
  constant only a held-out take can see"; DECISION-060; commit on
  `claude/project-thread-46x8sd`.
- Ledger changes: C27 spent (built and reverted). No new mechanism row.
- Exit rule: not fired by its letter — iteration 15 added C27 between the
  two reverts, and C13 and C22 (amped onsets) still carry stated
  falsifiers. C11 and C25 remain blocked on the owner's instrument
  decision. Next: C22 for the amped column.

### Iteration 17 — 2026-09-19 — two rows closed by their counts, no build; the tuning-only run paused on the owner

- Candidates: **C22** restated for the amped column (DECISION-056), then
  **C13** (the sharpness ceiling on the contact), both read on the bench.
- Falsifiers, stated before measuring: C22 — the nine late amped onsets
  within 40ms at +0 derivation missed, fp and extras not up, DI takes
  bit-identical. C13 — an edge on the derivation predicate alone between
  the DI contacts' sharpness and the loudest derivation openings the
  release rule moves.
- Counts: C22 (`c22-count.ts`) — 77 starts lent across nine tuning
  takes; slow 168 → 170, split 204 → 206, extras 255 → 259, missed 112 →
  112, fp 200 → 200, onsets over 40ms off 390 → 389; the E5 eighths DI
  take lends 29 and reads 6 → 7. Falsified. C13 (`c13-count.ts`) — 54
  release moves (51 DI, 3 amped/mic); DI contacts read up to 10.5, the
  five above 6.6 all 0–14ms stub-path moves on the E5 eighths DI take
  holding their labels; the amped/mic moves have one broadband contact
  (0.9); ceilings at 6.6, 8, 9.9 and 12 all leave every derivation count
  as it is. Falsified: the constant is visible only on held-out.
- Built: nothing. Engine bit-identical to DECISION-058's.
- Verdict and why: both rows spent by count. No open row the loop can
  measure alone remains: C11 and C25 wait on the split instrument
  (decision 3), C27 on the owner keeping a held-out-only gain (decision
  5), C8 on a resampler, and C1, C3, C5, C6 are new mechanisms or outside
  the slow subset, beyond the tuning the owner asked for.
- What a GOATerizer player would notice: nothing changed this iteration.
- Findings section: "Two rows read without a build, and where the loop
  stands"; DECISION-061; commit on `claude/project-thread-46x8sd`.
- Ledger changes: C22's amped restatement and C13 spent; C8 annotated.
- Exit rule: not fired by its letter (C1 and C3 remain with stated
  falsifiers). The tuning-only run pauses here; the report below is the
  one §9 asks for at exit, written now so the owner has it.

## Where the loop stands — 2026-09-19, paused on the owner (after iteration 17)

**Numbers at the pause against the baseline.** Engine at DECISION-058
(commit `2f4f9fb`); 541 tests; eval PASS with the same one informational
failure as at baseline.

| slow subset (`--subset=slow`, 754 labels) | baseline split / extras | now split / extras |
|---|---|---|
| DI (365 labels) | 52 / 54 | 24 / 26 |
| amped + room mic (389 labels) | 189 / 245 | 178 / 227 |
| total | 241 / 299 | 202 / 253 |

| the corpus, both axes | baseline | now |
|---|---|---|
| split events / extra Notes / strays (1592 labels) | 316 / 379 / 20 | 273 / 329 / 20 |
| ledger MISSED | 137 | 140 |
| derivation missed / false positives | 113 / 241 | 112 / 200 |
| held-out missed / false positives (read once per iteration) | 24 / 70 | 28 / 67 |

**The ceiling as it stands, per path.** Direct input, tuning takes: 20 of
327 slow labels split — ten refused-contact bursts (C11), six phantoms
the witnesses cannot separate from re-picks, `a15` and `e824` at rises of
1.997 and 1.98 against the release bar of 2, `e830`, `e839` (a release
91ms after its contact) and `p1c1q1` (a label on the review list). Every
row that reaches them is blocked on the split instrument's forward
reach. Amped and mic: 178 of 389; door 2 (a second witness off the amped
audio) was benched and closed at 0.69 AUC, so this column needs door 1
or door 3, a new mechanism rather than a witness.

**Every candidate spent, one line each.** C7 the gate sweep (misses, not
splits). C9 the rise witness, kept as the rate gate's second half (045).
C10 the contact-to-release move, kept (046). C11 the refused-contact
burst, built twice, right on the boundary and unseen by the count. C12
the release on a gated hop, kept (050). C14 the pace estimator's cliff,
kept (048). C15 the ring-out clock, read clean, closed. C16 the fine
witness's late contact, reverted (051) then kept with the clock on the
contact as C17 (052). C18 the first transient in the window, reverted
(053). C19 the rising transient read one hop late, reverted (054). C20
and C21 the rise on its hop or the next and the carve that sees every
Note, kept (055). C22 the octave stub, falsified twice by count. C23 the
string under the hand, kept restated (058). C24 the two-hop rise,
reverted (056). C25 the attack branch on the rising transient, reverted
(057). C26 the gate reading, reverted (059). C27 the level half,
reverted on the letter (060). C13 the sharpness ceiling, falsified by
count. Door 2, closed.

**What reopens the loop** (as written at the pause; the first two items were decided on 2026-09-19, see the two sections after this report). The split instrument's forward reach decided
(charge to the nearest label start, or to the label most overlapped, or
left as is): C11 and C25 rerun on the new count the same day. The
owner's yes on the level half (decision 5, option 2): one commit. A
recording of the tutorial's own shape, a note picked, damped for a rest
and picked again, on the direct input: a transfer check for 046 and 058.
The label review of the 33 grid placeholders on the A3 sixteenth section
and of `e36`, `p1c4q4`, `t12`, `s7`, `s16`, `s44`, `s6`, `s161`, `t6`:
each moves one number in this journal. Door 1 or door 3 for the amped
column, as a new brief.

**In plain words, for the owner.** On the direct input the engine now
hears a slowly re-picked note as one note almost every time: of the
notes that used to come out split, more than half no longer do, the
boundary sits on the moment the note sounds rather than the moment the
pick touches the string, and the ghost note of muted string between a
damped note and its re-pick is gone. What is left on the direct input is
mostly the score's own reading, which charges a right boundary to the
wrong note when the note before it started early, and that is your call
to change. Through the amp the engine is a little better and no more;
the audio gives the current witnesses nothing to separate a phantom from
a re-pick, and the next step there is a different kind of mechanism, not
more tuning.

## Owner's decisions applied — 2026-09-19 — the level half of the under-the-hand witness kept (DECISION-062)

The owner decided the PR's decision 5 on 2026-09-19: option 2, keep
iteration 14 with iteration 16's level half, outside the loop's rule.
Rebuilt as DECISION-060 had it, `tracking.underHandLevelFall` 0.5.

- Numbers, before → after: derivation bit-identical on every take
  (missed 112, fp 200; slow DI 20 of 327, amped and mic 148); corpus
  273 / 329 / 20 unchanged; ledger MISSED 140 → 139; held-out, read once, missed 28 → 27 (`t6` back), fp 67, split 69
  and extras 74 unchanged; eval PASS, the same informational failure;
  542 tests. DECISION-060's prediction, exactly.
- The keep rule is not amended. This is the one constant in the engine
  set on a held-out reading, held on the owner's word, and the held-out
  mic triplet take is no longer independent of it.
- Ledger: C27 kept by the owner's decision (row updated). Findings
  section: "The level half of the under-the-hand witness, kept on the
  owner's decision"; DECISION-062; `docs/EVALUATION.md` refreshed.

## The instrument re-read — 2026-09-19 — the ownership rule changed to most overlap (DECISION-063)

The owner decided the PR's decision 3 on 2026-09-19: `measure-splits.ts`
now charges a Note to the label it overlaps most, each bar widened by
40ms at both ends, a Note filling no bar a stray. The engine did not
change. Every number in the entries above stands as it was read under
the old rule; this section is the bridge. Full reading in
`docs/DETECTION-FINDINGS.md`, "The split instrument's ownership rule,
read three ways".

**Three rules on DECISION-058's engine, tuning takes, slow subset
split.** Shipped: DI 20, amped and mic 148. Nearest label start: 9 and
146. Most overlap, 40ms leeway: 8 and 144 (0 reads the same; 80 reads
144 → 142 by merging neighbours). Held-out DI 4 under every rule, amped
and mic 30 (28 at 80).

**The baseline and every kept iteration, re-read.** Split / extras, the
new script run in a checkout of each commit.

| | DI, tuning takes (327) | DI, held-out (38) | DI (365) | amped + mic, tuning (245) | amped + mic, held-out (144) | amped + mic (389) | slow subset (754) | corpus split / extras / strays (1592) |
|---|---|---|---|---|---|---|---|---|
| main (`1c5e632`) | 32 / 33 | 5 / 5 | 37 / 38 | 153 / 194 | 32 / 32 | 185 / 226 | 222 / 264 | 277 / 323 / 13 |
| after 1 | 18 / 19 | 5 / 5 | 23 / 24 | 153 / 194 | 31 / 31 | 184 / 225 | 207 / 249 | 262 / 308 / 13 |
| after 2 | 15 / 16 | 4 / 4 | 19 / 20 | 153 / 194 | 31 / 31 | 184 / 225 | 203 / 245 | 256 / 302 / 12 |
| after 4 | 14 / 15 | 4 / 4 | 18 / 19 | 148 / 183 | 30 / 30 | 178 / 213 | 196 / 232 | 249 / 289 / 12 |
| after 6 | 14 / 15 | 4 / 4 | 18 / 19 | 148 / 183 | 30 / 30 | 178 / 213 | 196 / 232 | 249 / 289 / 12 |
| after 8 | 13 / 14 | 4 / 4 | 17 / 18 | 148 / 183 | 30 / 30 | 178 / 213 | 195 / 231 | 248 / 288 / 12 |
| after 11 | 10 / 11 | 6 / 6 | 16 / 17 | 145 / 179 | 30 / 30 | 175 / 209 | 191 / 226 | 242 / 281 / 13 |
| after 14 | 8 / 9 | 4 / 4 | 12 / 13 | 144 / 178 | 30 / 30 | 174 / 208 | 186 / 221 | 237 / 276 / 13 |

Old rule, the same commits: DI 52 → 42 → 34 → 34 → 33 → 31 → 27 → 24;
amped and mic 189 → 188 → 188 → 182 → 182 → 182 → 179 → 178; corpus 316
/ 379 / 20 → 273 / 329 / 20.

**What moves in the ledger.** C11 and C25 reopen: their falsifiers were
stated on the old count, and each is restated on the new one in its
row. The owner-side blocker row on the forward reach is decided. The
ceiling paragraph of the report below now reads eight on the tuning DI
takes (`p1c1h`, `p2c3q2`, `p2c4q3`, `p3c4q1`, `e865`, `e821`, `e5`,
`e26`), each two or more Notes filling one bar, and four held-out on
the DI triplet take, each a Note at another pitch beside the right one.

## The owner's third listening pass — 2026-09-23 — labels only (DECISION-064)

The owner answered the label review list and chose to copy the E5 DI
labels to the amped file. Applied on his word; the engine did not move.
Slow subset 186 / 221 → 187 / 220, corpus 237 / 276 / 13 → 240 / 277 /
13 (1592 → 1594 labels), ledger MISSED 139 → 140, all on the E5 amped
take. The numbers in iteration 18 are read against these labels.

### Iteration 18 — 2026-09-23 — CLOSED ON THE BENCH — door 1, the phrase-regularity decode

- Candidate: **C1** (brief §5 door 1). The owner said go on 2026-09-23.
- Falsifier, stated before measuring (and in the bench's header): on the
  derivation takes, more extra Notes removed than the shipped rate gate
  removes on the current engine, at +0 missed; then held-out once, not
  worse on either axis.
- Bar: shipped missed 113, fp 199; gate off missed 112, fp 243. The gate
  removes 44 at +1.
- Bench (`scripts/measure-phrase-regularity-decode.ts`): 126 settings,
  three grids by six margins by seven variants, on top of the shipped
  engine and in place of the gate. Best at +0 missed: halves, accepted
  boundaries only, dip weight 1, abstain under a 200ms median interval,
  margin 0.5: fp 199 → 186 (-13) on three takes. Frontier -16 at +1,
  -22 at +3, -42 at +8. In place of the gate nothing reaches 199 at +1
  or less. Held-out, read once: missed 27 → 27, fp 67 → 65.
- Built: nothing. Engine bit-identical to DECISION-062's.
- Verdict and why: falsified. 13 is well under 44, and the settings that
  approach 44 each lose six to eight real notes, first in the sixteenth
  sections.
- What a GOATerizer player would notice: nothing changed this iteration.
- Findings section: "Door 1 on the bench"; DECISION-065; commit on
  `claude/project-thread-wqhzta`.
- Ledger changes: C1 closed.
- Exit rule: not fired by its letter. C3 (door 3, a small learned
  classifier) remains with a stated falsifier and is the brief's next
  door for the amped column; it is a training pipeline and shipped
  weights, not tuning, so it goes to the owner first. C5 and C6 remain
  open outside the same-pitch splits.

**In plain words, for the owner.** The idea was to catch ghost notes by
rhythm: if cutting out one short note makes a run of notes evenly
spaced again, that note was probably a ghost. It does work a little. On
the practice recordings it removes 13 ghost notes without losing a real
one, and on the test recordings it removes 2. But the check the engine
already has removes 44, and every attempt to get more than 13 from the
rhythm idea started deleting real notes, mostly in fast sixteenth-note
runs where real playing is not perfectly even. So the rhythm idea is
not the big fix for the amp and microphone recordings. The 13 can still
be added on top if you want them.

## The rest-and-repick take and the damp — 2026-09-24 (DECISION-066, DECISION-067)

The owner recorded the take the corpus lacked (pick, ring, damp, rest,
re-pick; G2, DI and re-amped) and asked that recognition be calibrated
to it, so both renders are derivation material and in the slow subset.
Not a loop iteration on the same-pitch splits: the new failure it showed
is a different shape.

- On the DI render all eight picks were found, and every one of the five
  extra Notes was a 90-170ms G#2 at a damp. The hand pushes the string
  sharp as it stops it (98 → 104.6Hz), and the region lane cut that off
  as a pitch-change Note. `deep.dampTailMs` (300) refuses a pitch-change
  boundary within a whole tone in the last 300ms of a Note that fell
  silent. Derivation missed 113 → 113, fp 209 → 204; held-out, read
  once, missed 27 → 27, fp 67 → 65; 542 tests.
- Same session, on the owner's word: `quarters-a3-e5-di` `e26`-`e40`
  moved onto the note sounding (DECISION-067), sent to him on the "E5
  Quarters Label Check" page. No count moves.
- Totals now: slow subset 190 / 222 of 770; corpus 243 / 279 / 14 of
  1610; ledger MISSED 140.
- Still open on the new amped render: stubs before three picks, a Note
  on one pick contact, one after a damp, and five picks named G5.

**In plain words, for the owner.** On the plugged-in recording, each
time you stopped a note with your hand the string went slightly sharp
for a split second, and the engine heard that as a new, higher note.
It now knows that a small pitch wobble just before a note goes silent
is your hand, not a note. All five of those fake notes are gone, and no
real note was lost anywhere in the other recordings.

