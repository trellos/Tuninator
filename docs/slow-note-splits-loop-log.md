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
| C2a | HPSS percussive-component flux at fine hop as a re-pick witness | fast/deep | 1–6kHz attack band; click witness (DECISION-018) | 0.80 AUC on the outcome-shaped population, amped takes, derivation | open (door 2) |
| C2b | Band-limited (1–6kHz) envelope dip | fast | DECISION-028 (d) varied window length, not band | 0.80 AUC as above | open (door 2) |
| C2c | Octave displacement of the fragment as a retrospective witness | deep | none; observation above | 0.80 AUC as above, or usable as the rate gate's second witness | open (door 2) |
| C2d | Spectral-shape (centroid / flatness) novelty at fine hop | fast | DECISION-014, DECISION-015 measured spectral change, not shape | 0.80 AUC as above | open (door 2) |
| C3 | Retrospective learned classifier (≤25k params) judged on the OUTCOME target, trained on GuitarSet rows labelled by the matcher | deep | DECISION-021, DECISION-031 (both boundary-target; group R weak there) | LOTO AUC above the shipped rate feature's 0.826 on the same rows; pipeline beats the shipped gate at +0 missed on derivation | open (door 3) |
| C4 | Pace absorb at 0.40 — the named measurement only (estimator / oracle ratio per take) | — | DECISION-037: "not yet decidable" | ratio ≈ 0.82 ⇒ 0.50 is derived | blocked on the label review (owner) |
| C5 | Rate gate restricted by the PREDECESSOR's `harmonyBloomed` | tracker | DECISION-030 amendment (room-context flag regressed) | chord-take extras fall, nothing else moves | open (door 5) |
| C6 | Lower the amplitude gate so decayed slow strings reach the witnesses | fast | DECISION-035 names it, unmeasured | ledger `rejected: gated` falls at no extras cost | open (door 6, misses not splits) |

## Owner-side blockers (living)

| item | what it unblocks | asked | answered |
|---|---|---|---|
| Phone-microphone recordings of the GOATerizer tutorial passage, phone capture plus a DI of the same performance, constraints named (brief §10) | any claim that a fix transfers to the owner's rig; derivation material for slow same-pitch notes | 2026-09-18 (this file) | — |
| Label review of the eight 120bpm same-pitch takes: the 33 A3 grid placeholders; carrying the DI times to the amped files at +2.5ms | C4; reading the amped fast takes to better than ±65ms | earlier (`docs/SAME-PITCH-MATERIAL.md`) | — |
| Does GOATerizer honour `structuralRevision` with `relation: "absorbed"`? | which form of C1 to build (retract vs never-announce) | 2026-09-18 | — |
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

*(No iterations yet. The baseline above is iteration 0.)*
