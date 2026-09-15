# A path to perfect accuracy on the direct input

What the four direct-input takes get wrong today, what their audio was
measured to support, which algorithms from the literature apply under this
project's constraints, and a staged path — with a falsifier per stage — to
every played event coming out as exactly one correctly named Note on a DI.

Every number here came from running code against the committed fixtures at
`f3bf223` (`npm run eval` PASS). The four new scripts that produced them are
listed at the end. The DI takes are HELD-OUT material; every ceiling below is
read on them and none of it has been fitted into the engine. The path says,
stage by stage, what has to be recorded so that the constants it needs can be
derived honestly instead of tuned on the takes they will be graded on.

---

## 1. What "perfect" means, and how far away it is

The corpus has four DI takes: one performer, one Les Paul, one interface,
127 labelled events. Against the labels as they stand, perfect is: 126 or
127 detections, zero extra Notes, every detection carrying the label's name,
onsets within a few tens of milliseconds. One label (`s14` on the sixteenths)
is placed by subdivision because the labeller's own flux found no stroke
there; it is the documented exception `DECISION-002` provides for, and the
audio ceiling below agrees with the labeller.

Where the shipping engine stands on those four takes:

| take | labels | Notes | missed | extra | named exactly | pitch class | onset median |
|---|---|---|---|---|---|---|---|
| `cowboy-chords-di` (D Em G C ×2) | 8 | 12 | 0 | 4 | 6/8 | 8/8 | 52ms |
| `power-chords-di` (16 strums) | 16 | 16 | 0 | 0 | 15/16 | 16/16 | 19ms |
| `lead-line-di` quarters/eighths/triplets | 55 | 76 | 0 | 21 | 54/55 | 54/55 | 12ms |
| `lead-line-di` sixteenths | 48 | 42 | 6 | 0 | 42/48 | 42/48 | 15ms |
| **total** | **127** | **146** | **6** | **25** | **117/127** | **120/127** | |

So the DI is 6 missed strokes, 25 extra Notes, and 4 wrong names away from
perfect (the 4 names: `c1` D read as the note "D2", `c2` Em read as Em7,
`p14` G5 read as Gsus2, `t12` B4 paired with an A#4 transition stub). The
onset timing is already inside every gate.

Every one of those 35 defects has a named mechanism, and they fall into six
shapes. Section 3 gives the counts; section 2 gives the measurements that say
each shape is repairable from the audio.

---

## 2. What the DI audio supports — measured ceilings

Four measurements, each a script under `scripts/`, each read on the held-out
DI takes with the constants chosen ON the take measured. That is the
fit-on-test number `AGENTS.md` forbids as a *result*; its use here is the
other way round — a function that cannot reach a label at any threshold
cannot reach it once tuned honestly, and a function that reaches every label
at some threshold tells us the information is in the signal.

### 2.1 Onsets: a fine-hop log-flux sees 126 of 127, and every miss-fire has a shape

`scripts/measure-di-onset-ceiling.ts` runs seven causal detection functions
at a 128-sample hop (2.67ms) and sweeps each over its whole threshold range,
scoring labelled onsets covered within ±30ms under NEAREST-label attribution
against candidates inside the played span nearest to no label ("off-label").
The window is narrower than the 63ms rushed pair on the sixteenths; a ±60ms
window has produced a false 48/48 on this material before.

| function (best point per take, summed over the 4 DI takes) | covered | off-label | covered at 0 off-label |
|---|---|---|---|
| linear flux / frame magnitude (the shipping kernel's shape) | 126/127 | 88 | 50/127 |
| band-limited flux 1.5–6kHz | 126/127 | 72 | 11/127 |
| log-compressed flux (Böck) | 126/127 | 23 | 90/127 |
| SuperFlux (log flux, ±1-bin max-filtered reference) | 126/127 | 17 | 90/127 |
| **SuperFlux minus its trailing 100ms median** | **126/127** | **15** | **107/127** |
| 1.5kHz-highpassed 1ms envelope rise (the labeller's witness) | 114/127 | 179 | 23/127 |
| order-16 LPC prediction residual | 125/127 | 189 | 69/127 |

The shipping kernel, at its 13.3ms hop and 60ms dead time, reaches 42 of the
48 sixteenths; the same physics at a 2.67ms hop with log compression reaches
47 of 48 (the 48th is `s14`). Three properties of that reading matter more
than the count:

- **Every off-label candidate has a shape.** Listed one by one on the
  sixteenths, the eleven off-label firings at the 47/48 point are nine
  candidates 32–51ms BEFORE a downstroke, each followed within 65ms by a
  candidate 13–30× stronger, one candidate 43ms before the interpolated
  `s14`, and the terminal hand mute. On the triplet take the three are
  52–65ms before an eighth note with the envelope collapsing behind them.
  They are the pick landing on the string before the stroke.
  With one contextual veto — *a candidate followed within 65ms by one at
  least 4× stronger is a preparation, not a stroke* — the triplet take reads
  **55/55 with zero off-label**, power chords **16/16 with zero**, the
  sixteenths 47/48 with two (the terminal mute and a candidate 43ms before
  the interpolated `s14`), and the cowboy take 8/8 with one, a strum-internal
  transient 68ms after the strum that the existing 80ms articulation burst
  already absorbs. Total: **126/127 covered, 6 off-label, all six accounted
  for.**
- **The veto needs a 65ms look past the candidate.** In this architecture
  that is not a fast-lane decision; it is the region lane vetoing a fast-lane
  proposal, which is the direction the tracker already runs in
  (`attackSamples` → `segmentRegion` → `isRealBoundary`).
- **One threshold does not span the takes.** With the preparation veto the
  best points sit at 0.145 (sixteenths), 1.86 (triplet), 0.49 (power chords)
  and 3.0 (cowboy chords) on the median-subtracted SuperFlux. At a single
  0.25 the sixteenths and the power chords hold (47/48 with 2 off-label,
  16/16 with 1) while the triplet take fires 27 times and the cowboy take 65
  times off-label — 27 and 48 of those with the envelope falling behind
  them: the pick landing on the string before quarter and eighth notes, and
  the fretting hand on a ringing chord. A second veto keyed on that fall
  (the 20ms envelope 35ms later under half of what it was 5ms before) takes
  the triplet take to 55/55 with zero off-label at 0.25 and leaves the
  cowboy take's 65 untouched, and it removes `s6` and `s40`, two real strokes
  picked and damped inside 40ms (§2.5); refined to require no rise at all in
  the 5ms envelope within 16ms, it still removes them, because their rebound
  comes 25–35ms after the label. So the fine function is the *proposal*
  stage; whether energy followed stays the tracker's question, decided where
  the tracker already decides it, on the Note's own decay — exactly as now.

### 2.2 Pitch: given the pick, the engine's own estimator names the note by +15ms

`scripts/measure-di-pitch-ceiling.ts` runs the YIN kernels and the engine's
dual-window `YinEstimator` (fresh median) on windows ending a fixed distance
after each labelled onset, with the boundary taken from the LABEL:

| take, pitch class correct at onset + | +10ms | +15ms | +20ms | +30ms | +45ms | +60ms |
|---|---|---|---|---|---|---|
| lead-line-di triplet (55), engine estimator | 64% | 96% | 98% | 100% | 100% | 98% |
| lead-line-di sixteenths (48), engine estimator | 60% | 100% | 96% | 96% | 100% | 100% |

Exact (octave included) reads the same. Median first-correct offset is +10ms
on both takes; no label is unnamed by +90ms. **On a direct input the naming
problem does not exist once the boundary is right.** Every wrong name on the
DI lead takes is a boundary or attribution defect, and every one of them
sits on an extra Note (§3).

The same script reads the pitch 15ms BEFORE each pick: on the triplet take 46
of 55 read nothing at all (the string is already damped by the pick's
contact), 8 read a pitch that is neither this label's nor the previous one's
(the transition stubs of §3), and 1 reads this label's. On the sixteenths 21
read nothing and 21 the previous stroke's pitch (same string, same note).

### 2.3 The extra Notes are the fretting hand, the strum's spread, and nothing else

`scripts/measure-di-extras-census.ts` classifies every extra Note by what
opened it, what closed it, and what the matched Note after it was:

| shape | DI triplet | cowboy DI | mechanism |
|---|---|---|---|
| step-opened, no transient at its start, same pitch class as the picked Note that follows, 72–196ms before the pick | 8 | – | the next note fretted (hammer-on / pull-off) before it is picked; the string changes pitch, the tracker's "a legato step is two Notes" contract opens a Note, the pick then re-articulates it |
| step-opened, a pitch that is neither neighbour's, ending on the pick: four stubs of 53–67ms (D#5, F5, G5, F4 at confidence 0.7–0.8) and one of 107ms | 5 | 1 | the transition itself: the string half-stopped as the finger moves |
| attack-opened by a transient 40–130ms before the pick, then re-articulated by the pick | 7 | – | the pick's contact or the fretting hand's noise fired the 13ms-hop kernel; the fine-hop function with the preparation veto (§2.1) produces none of these |
| same-pitch tail fragment after the last note | 1 | – | the take's final ring-out |
| the first string(s) of a strum as their own Note, 133–160ms, then the chord | – | 3 | `absorbAttackFragments` refuses a Note the fast lane ended on an accepted re-articulation and announced (`restruck && announced`), which is right for a second strum 450ms later and wrong for the same strum's later strings |
| **total** | **21** | **4** | |

The matched Notes on these takes are opened by an attack 28 of 55 times and
by a pitch step 27 of 55 on the triplet take, 34 and 8 on the sixteenths —
so the trigger alone does not separate a played note from a prefix. What
does is the pairing: a step-opened Note that ENDS on an accepted attack
within a quarter second, at the pitch that attack then plays.

### 2.4 Chords: both wrong names are the same octave error

`scripts/measure-di-chord-evidence.ts` prints the harmonic-sum fundamentals
and the interpreted name for a 4096-point window at successive offsets into
each chord:

- `c2` Em reads **Em at +120, +200, +300ms** (confidence 0.99–1.00) and
  **Em7 at +500ms and +1200ms**, where D5 appears at salience 3.7–4.8 while
  G4 (3.3) has overtaken G3 (1.1–1.4). D5 is the third partial of G3; once the
  cancellation names G4 rather than G3, nothing claims 3×G3 and it survives
  as a fundamental. The Note's name is a vote over its life, so the late
  windows win.
- `p14` G5 reads **Gsus2 at +40 and +120ms** (D4 at 4.8–5.1 over D3 at 1.45;
  A4 at 2.1–2.2) and G5 from +200ms. A4 is the third partial of D3; D4 won
  the first cancellation step over D3 (the pickup hears the wound D string's
  second partial louder than its first), so 3×D3 was never claimed.
- `c1` D reads **D at +40 and +120ms** and abstains afterwards with D3, A3,
  F#4 all present — but the Note never bloomed at all and was emitted as the
  note "D2" at confidence 0.96. The open D voicing D3 A3 D4 F#4 IS the
  harmonic series of D2 (partials 2, 3, 4, 5), so YIN finds a confident
  period at 73Hz, the mean confidence exceeds `maxMonophonicConfidence`, and
  the bloom is vetoed. The second D chord (`c5`) blooms because the room's
  harmonic context is already high by then; the first chord of a take has no
  such help.

One repair covers the first two: octave consistency inside the cancellation
loop, so a candidate at f is replaced by f/2 when the odd partials of f/2 are
present — the logic `kernels/missing-fundamental.ts` already applies to the
bass, applied to every candidate. The third needs the bloom test to notice
that YIN's period lies an octave below the lowest detected fundamental,
which is a chord, not a note.

### 2.5 An observation the literature could not confirm: the pick damps the string before it plays it

Reading the 5ms envelope around the strokes the kernel loses:

```
s6  @4269   36 → 5.2 (−17dB by +10ms) → 14 at +40ms      a −20dB upstroke out of a dip
s40 @7826   94 → 4.6 (−26dB by +30ms) → 13 at +60ms      a −26dB upstroke out of a dip
s20 @5673   70 → 15  (−13dB by +25ms) → 65 at +30ms      the same-level re-pick, 63ms after s19
mute @9003  72 → 2.9 (−28dB)          → nothing           the hand
```

On this take a re-pick is preceded by the string being damped 13–26dB inside
~15ms as the pick lands on it; the stroke is the rebound out of the dip, and
a hand mute is the dip with no rebound. That is a witness with a different
physical basis from every one in the tracker's same-pitch decision, which are
all energy-increase detectors read against a decaying baseline
(`DECISION-009`..`-015`, `-018`). Built as a standalone detection function
here (`dip-rebound dB`, level-gated), it does NOT stand alone — 97/127
covered, 90 off-label, because sustain and room tone dip 6dB constantly — so
it is recorded as an observation and a candidate witness for the decision
table, with the bar every witness there has had to clear (0.73 AUC on the
derivation rows, `measure-decision-separability.ts`), not as a result.

---

## 3. The six shapes, counted

| # | shape | missed | extra | wrong name | where it lives |
|---|---|---|---|---|---|
| 1 | a quiet stroke the 13ms-hop kernel never fires on (`s6`, `s16`, `s20`, `s22`, `s40`) | 5 | | | `kernels/onset.ts`: hop, 60ms dead time, 3-hop reference |
| 2 | a stroke that is not in the audio (`s14`, interpolated label) | 1 | | | the documented exception |
| 3 | the fretting hand arriving before the pick: prefixes and transition stubs | | 14 | 1 (`t12`) | `note-tracker.ts` (b): a pitch step opens a Note; nothing later says the pick claimed it |
| 4 | a preparation transient opening a Note the pick then re-articulates | | 8 | | the kernel fires on the pick's contact; the tracker's burst window is 80ms and the pick lands 40–133ms later |
| 5 | the first strings of a strum kept as their own Note | | 3 | | `absorbAttackFragments`: `restruck && announced` |
| 6 | octave-up in harmonic cancellation; a harmonic-series voicing vetoed from blooming | | | 3 (`c1`, `c2`, `p14`) | `kernels/chroma.ts` cancellation; `applyHarmony` monophonic veto |

---

## 4. Algorithms from the literature, assessed for this problem

Two literature surveys were run for this document (onset detection and
re-articulation; pitch, multi-pitch and note transcription); the sources are
listed in §8. What follows is the assessment against the DI defects above
and the constraints in `AGENTS.md` §4 (plain TypeScript, no runtime
dependency, learned weights ≤ ~25k parameters, causal fast lane, deep lane
over ≤4s). Numbers quoted from papers whose full text was unreachable from
this environment are taken from their abstracts or from secondary sources
and are marked as such in §8.

### 4.1 Onset detection

| approach | what it would fix here | fit | verdict |
|---|---|---|---|
| **SuperFlux** (Böck & Widmer 2013: log-compressed magnitude, ±1-bin max-filtered reference, ~5ms hop) with median-adaptive peak picking (Böck 2012) | shapes 1 and 4: measured 126/127 on the DI takes, and the preparation clicks become separable by context | one 1024-point FFT every 2.67ms is ~375 FFTs/s; the kernel already has the max filter (`fluxMaxFilterSemitones`), the log compression and the fine hop are the change | **adopt** as the proposal stage (Stage 1) |
| Stowell–Plumbley adaptive whitening | scale invariance across input gain | already measured in this project: confirmed as a scale fix, rejected as a decision input (`DECISION-014`); log compression plus median subtraction gives the same invariance | not needed beyond what Stage 1 carries |
| ComplexFlux (Böck & Widmer 2013b, local-group-delay weighting) | vibrato and tremolo false positives | it attenuates amplitude jumps on steady partials, which is the signature of a same-pitch re-pick; untested on plucked strings | no |
| NINOS² spectral sparsity (Mounir et al. 2016/2021, designed on guitar) | quiet attacks | one sort per frame; its authors report a 50% swing in F1 with a global annotation shift | worth one falsifier run on the derivation set only if Stage 1 leaves a residue |
| high-passed fine envelope (the labeller's own witness) | quiet upstrokes | measured here: 114/127, 179 off-label — the trailing floor is set by the previous downstroke's own high-frequency tail | no, as a detector; keep for boundary PLACEMENT (its offsets are +3ms against +10ms for flux) |
| LPC prediction residual | pick impulse vs predictable decay | measured here: 125/127 but 189 off-label; the residual spikes on every partial beat | no |
| dip-then-rebound (this document, §2.5) | the same-pitch re-pick (shapes 1 and the 0.73 ceiling) | trivially causal and cheap; not a standalone detector | test as a decision witness, bar 0.73 AUC |
| Schlüter–Böck CNN (≈290k parameters), madmom online RNN | state of the art F≈0.90 on mixed material | 12× over the weight budget; centred 15-frame context | out of bounds |
| Basic Pitch onset head (≈17k parameters, ICASSP 2022) | learned onsets | fits the weight budget but is non-causal by ±~100ms through a harmonic CQT, and its default 128ms minimum note length merges 107ms sixteenths | deep-lane candidate only; the learned-head route here already ran to its falsifier (`DECISION-021`) |

### 4.2 Pitch and naming

| approach | what it would fix here | fit | verdict |
|---|---|---|---|
| YIN, dual window (shipping) | nothing needed: 96–100% correct by +15ms given the boundary (§2.2) | — | keep |
| pYIN pitch HMM / Tony note HMM (Mauch & Dixon 2014, 2015) | smoothing of octave flips | the note HMM can only leave a stable state through silence, so gapless same-pitch repeats merge — the opposite of what the sixteenths need; Viterbi is offline | no |
| MPM/NSDF, SWIPE′, SHS | alternative monophonic estimators | the retired lineage measured a four-estimator fusion end to end and lost to YIN (`DECISION-023`, "a bench ranking is not a pipeline ranking") | no |
| CREPE / PESTO / SwiftF0 | learned monophonic pitch | 22M / 28k–130k (unresolved) / 96k parameters; monophonic; the DI has no pitch problem to solve | no |

### 4.3 Chords and multi-pitch

| approach | what it would fix here | fit | verdict |
|---|---|---|---|
| octave-consistent iterative cancellation (Klapuri 2003/2006 salience with a sub-octave check) | shape 6: `c2` Em7 and `p14` Gsus2 are both a third partial escaping because f/2 lost to f | a few lines in the cancellation loop; the sub-harmonic summation already exists for the bass (`missing-fundamental.ts`) | **adopt** (Stage 3) |
| harmonic NMF / PLCA with fixed templates (Vincent 2010; Dessein 2010 online) | polyphonic transcription | templates are instrument-specific and 88 free templates exceed the weight budget; the same-pitch re-pluck is unsolved there too | no |
| Basic Pitch note/contour heads | polyphonic notes | non-causal; its published guitar number (note F 79% on GuitarSet, acoustic hex mix) is far below what the DI chord takes already do (31 of 32 named) | no |

### 4.4 What the commercial mono-DI systems say

The public record on mono-input polyphonic pitch-to-MIDI (Jam Origin) is
"spectral processing combined with deep machine learning", patent-pending and
undisclosed; the hexaphonic systems (Fishman TriplePlay 7–14ms per string,
Axon's "transient early recognition" from the first ~3ms of a pick) solve a
different, monophonic-per-channel problem. The one transferable idea is
Axon's: pitch from the attack transient, learned from examples. The DI
measurements here say the attack is not where this project's residue is.

---

## 5. The path, stage by stage

Each stage names what it changes, what it is expected to move, the falsifier
stated before the measurement, and what has to be true to derive its
constants honestly. Stages 1–3 are independent of each other and can land in
any order; Stage 0 is the precondition for all of them being *derived* rather
than fitted.

### Stage 0 — semantics, and derivation material recorded on a direct input

**Two semantic decisions the owner has to make**, because the labels and the
Note contract disagree and no measurement settles a definition:

1. *The fretting hand arriving before the pick is not a Note.* Eight of the
   DI triplet take's extras are a hammer-on or pull-off 72–196ms before the
   pick that then plays the same note, and the labels count one event. The
   proposed rule — a step-opened Note ended by an accepted attack within
   250ms whose Note carries the same pitch class is absorbed into that Note,
   boundary at the attack — keeps a real hammer-on that is held or that
   moves on to another pitch, and merges only the case the pick re-plays.
   A trill faster than 250ms into a re-pick of the same note is the one
   figure it would mis-read.
2. *A stroke that is picked and immediately damped is a Note.* `s6` and
   `s40` are −20 and −26dB strokes out of a dip (§2.5) that the labels
   count and that a mute veto keyed on energy falling afterwards would
   remove. `chords-a-bm-g-d` already stands on this semantics (its muted
   upstrums count).

**Recording.** Every constant the stages below need lives in a place the
derivation set does not exercise (`DECISION-022`): the five 120bpm takes
contain seven same-pitch repeats, no quiet alternate-picked upstrokes at
107ms, no legato that is then re-picked, and no direct-input chord changes.
Recorded on the same DI chain as the held-out takes, labelled by the recipe
the DI label files already document, and added to `fixtures/eval.config.json`
as **derivation** entries:

- alternate-picked sixteenths, one pitch, at 120, 140 and 160bpm, with the
  upstrokes deliberately quiet, two passes each (~1 min);
- same-pitch re-picks at eighths and sixteenths, plus a run of staccato
  (picked-and-damped) strokes (~30s);
- a legato passage: hammer-ons and pull-offs HELD for at least 150ms, and
  the same figure with each note re-picked after it is fretted (~30s) — this
  is what makes the 250ms window in Stage 2 a derived number;
- open-chord changes with the fretting hand audible between chords, and a
  bar of power chords with muted second strums (~45s).

Roughly three minutes of playing and one labelling pass. Without it the
stages below can only be *checked* on the held-out DI takes; with it they
can be *derived*, and the held-out takes stay what they are for.

### Stage 1 — a fine-hop onset front end, as proposals

**Change.** A second `OnsetDetector` instance (or a mode of the existing
one) at a 128-sample hop over a 1024-point window: log-compressed magnitude,
reference = per-bin maximum over the frames 8–24ms back, max-filtered over
±1 bin (`maxFilterSemitones` already implements the filter), rectified sum,
minus the trailing 100ms median; candidates are local maxima over ±13ms above
a threshold, 40ms dead time. Each candidate carries its strength. The fast
lane records every candidate on `attackSamples` for the region lane and acts
on one only after the **preparation veto** — no candidate at least 4×
stronger within the following 65ms — which in the fast lane is a 65ms hold
before a Note may open on a candidate the broadband kernel did not also
fire on, and in the region lane is a veto on the proposal.

**Expected.** Sixteenths 42 → 45–47 of 48 (`s14` excepted; `s6` and `s40`
depend on the threshold the Stage 0 material derives); the seven
preparation-opened extras on the triplet take gone; chord and power takes
unchanged.

**Falsifier, stated now.** (a) `measure-onset-coverage.ts` on the five
derivation takes: coverage not below 70/78 at an off-label rate not above
1.81%; (b) `npm run eval` PASS; (c) `measure-splits.ts` not up on any
derivation take; (d) on the held-out DI takes, read once: sixteenths ≥ 45
detections with 0 extra, triplet extras ≤ 14 (the 7 preparation Notes gone,
the step-opened ones untouched until Stage 2). If (a) fails at every
threshold the Stage 0 material supports, the fine hop is not the repair and
the finding is written up.

**Cost.** ~375 1024-point FFTs per second: under one percent of a core in a
worklet. Latency: 13ms for the local maximum, plus the 65ms hold only on a
candidate the broadband kernel disagrees with.

### Stage 2 — the direct input's transitions belong to the pick

**Change.** Three structural rules in the tracker, all of the kind
`DECISION-008` provides for (the Note is delivered, then absorbed by a
`structuralRevision`):

1. *Pre-pick prefix.* A step-opened Note (trigger `pitchChange`, no transient
   at its own start) that is ended by an accepted attack ≤ 250ms after it
   opened, where the Note the attack opens carries the same pitch class, is
   absorbed into the attack's Note with the boundary at the attack.
2. *Transition stub.* A step-opened Note shorter than `articulationMs` ended
   by an accepted attack, whose pitch class is neither its predecessor's nor
   its successor's, is absorbed likewise. `cannotDefendReading` already
   holds half of this test.
3. *Strum spread.* `absorbAttackFragments` keeps its `restruck && announced`
   refusal for Notes older than a strum's spread and drops it for a Note
   that was re-articulated within 150ms of its own start, before any chord
   bloomed. The muted upstrums this refusal protects arrive 450–560ms after
   their downstrum.

**Expected.** DI triplet 21 → ≤ 3 extras (the tail fragment and whatever
Stage 1 leaves); cowboy DI 12 → 8–9 Notes; `t12` named B4.

**Falsifier.** No derivation label lost (`clean-lead` keeps 42/43 and its
15 step-opened matched Notes; `chords-a-bm-g-d` keeps 16/16 with its muted
upstrums); no derivation take up on extras; the Stage 0 legato take keeps
every held hammer-on. Rule 1's window is derived on the Stage 0 legato take,
not on the DI triplet take.

### Stage 3 — chord naming: octave consistency, and blooming on a virtual pitch

**Change.** (a) In `kernels/chroma.ts`'s cancellation loop, before a
candidate f is accepted, test f/2: if the partials at 1×, 3× and 5× of f/2
are present with support comparable to f's own, take f/2 — the
`missing-fundamental.ts` sub-harmonic check, applied to every candidate
rather than the bass alone. (b) In `applyHarmony`, the monophonic veto
(`maxMonophonicConfidence`) does not apply when the fast lane's period lies
an octave or more below the lowest detected fundamental: a confident period
that no string is sounding is a chord's virtual pitch.

**Expected.** `c2` Em, `p14` G5, `c1` D. Likely also movement on the mic
power chords, whose `p14`/`p16` errors have the same shape.

**Falsifier.** `chords-a-bm-g-d` exact not below 11/12; `spicy-chords`
`maxFalseLabels` stays 0; `cowboy-chords-120` exact not down; `clean-lead`
false positives ≤ 1 (a single note whose period IS its lowest fundamental is
untouched by (b)).

### Stage 4 — onsets on the strum's first string

With Stage 1's proposals and Stage 2's rule 3, a chord Note begins at its
first string rather than at its bloom or its backdate; the cowboy take's
52ms median should fall under 20ms. No new constant. Falsifier:
`power-chords-120` onset median stays under its 120ms gate; no derivation
take's median moves the wrong way.

### Stage 5 — hold the line

The DI takes are informational in `fixtures/eval.config.json` and that file
is read-only for agents. Once Stages 1–3 are in and the Stage 0 material is
the derivation side, the owner can promote the four DI takes to `required`
with `maxMissed: 1` (`s14`), `maxFalsePositives: 0`, and exact-label gates
at 8/8, 16/16, 55/55 and 47/48 — which is the definition of perfect this
document set out with, made permanent.

### What the path is expected to read at the end

| take | detections | missed | extra | named |
|---|---|---|---|---|
| cowboy-chords-di | 8 | 0 | 0 | 8/8 |
| power-chords-di | 16 | 0 | 0 | 16/16 |
| lead-line-di triplet | 55 | 0 | 0 | 55/55 |
| lead-line-di sixteenths | 47 | 1 (`s14`) | 0 | 47/47 |

---

## 6. What this path does not claim

- **The room mic and the amp sim are not on it.** Their residue is the
  decision the record calls the same-pitch ceiling (0.73 AUC on mixed
  paths); the DI measurements here say that on a direct input the problem
  was upstream of that decision, in a kernel too coarse to see the pick.
  The dip-then-rebound witness (§2.5) is the one new thing this work offers
  the mixed-path decision, and it is untested there.
- **The pre-pick prefix rule is a semantic choice.** It is measured to be
  the right one for the labels this corpus has; a consumer who wants every
  legato pitch change as its own Note would want it off. It should ship as
  a documented default, not as an unconditional truth about guitar playing.
- **The numbers in §2 are ceilings.** Every threshold in them was chosen on
  the take measured. The stages turn ceilings into results only with Stage
  0's recordings on the derivation side.

---

## 7. Reproduction

```bash
npx tsx scripts/measure-di-onset-ceiling.ts                       # §2.1, the four DI takes
npx tsx scripts/measure-di-onset-ceiling.ts --contextual=prep     # with the preparation veto
npx tsx scripts/measure-di-onset-ceiling.ts di-sixteenths --detail --candidates=superflux-median
npx tsx scripts/measure-di-pitch-ceiling.ts --detail              # §2.2
npx tsx scripts/measure-di-extras-census.ts                       # §2.3 (--all for every take)
npx tsx scripts/measure-di-chord-evidence.ts --labels=c1,c2,p14   # §2.4
npx tsx scripts/measure-downstream-ledger.ts --all --detail       # the baseline in §1
npx tsx scripts/measure-splits.ts
```

---

## 8. Sources

Onset detection and the physics of the pick. Entries marked † were read from
abstracts, search excerpts or released source code because the full text
was unreachable from the environment this was written in.

- Bello, Daudet, Abdallah, Duxbury, Davies, Sandler (2005). A tutorial on
  onset detection in music signals. IEEE TSAP 13(5). †
- Dixon (2006). Onset detection revisited. DAFx-06. †
- Böck & Widmer (2013). Maximum filter vibrato suppression for onset
  detection (SuperFlux). DAFx-13. Reference implementation:
  github.com/CPJKU/SuperFlux and madmom `bin/SuperFlux` (200 fps, log(1+x),
  ±1-bin max filter, median-based peak picking). †
- Böck & Widmer (2013). Local group delay based vibrato and tremolo
  suppression for onset detection (ComplexFlux). ISMIR 2013. †
- Böck, Krebs & Schedl (2012). Evaluating the online capabilities of onset
  detection methods. ISMIR 2012. †
- Stowell & Plumbley (2007). Adaptive whitening for improved real-time audio
  onset detection. ICMC. †
- Mounir, Karsmakers & van Waterschoot (2016, 2021). Guitar note onset
  detection based on a spectral sparsity measure (NINOS²). EUSIPCO; EURASIP
  JASMP. †
- Schlüter & Böck (2014). Improved musical onset detection with
  convolutional neural networks. ICASSP. (≈290k parameters, derived from
  the published architecture.) †
- Abeßer et al. (2010). Feature-based extraction of plucking and expression
  styles of the electric bass guitar. ICASSP. (Pre-onset energy slope as a
  feature.) †
- Kehling, Abeßer, Dittmar & Schuller (2014). Automatic tablature
  transcription of electric guitar recordings (IDMT-SMT-Guitar). DAFx-14. †
- US Patent 9,646,591. Determining the fretted positions and note onsets of a
  stringed musical instrument. (Describes missed plucks at high same-fret
  rates and phase change as the detection criterion.) †
- Cycfi Research (2021). Onset detection; Onset detection: DSP adventures.
  cycfi.com. †
- Weinreich (1977). Coupled piano strings. JASA 62:1474. †
- Woodhouse (2004). Plucked guitar transients: comparison of measurements
  and synthesis. Acta Acustica 90:945. †
- Paté, Le Carrou & Fabre (2014). Predicting the decay time of solid body
  electric guitar tones. JASA 135:3045. †
- Zollner. Physics of the Electric Guitar, ch. 1.5, the plucking process.
  gitec-forum-eng.de. †

Pitch, multi-pitch and transcription.

- de Cheveigné & Kawahara (2002). YIN, a fundamental frequency estimator for
  speech and music. JASA 111:1917.
- Mauch & Dixon (2014). pYIN: a fundamental frequency estimator using
  probabilistic threshold distributions. ICASSP. Source: github.com/c4dm/pyin
  (the note HMM leaves a stable state only through silence).
- Mauch et al. (2015). Computer-aided melody note transcription using the
  Tony software. TENOR. †
- McLeod & Wyvill (2005). A smarter way to find pitch (MPM). ICMC.
- Camacho & Harris (2008). A sawtooth waveform inspired pitch estimator
  (SWIPE). JASA 124:1638. †
- Kim, Salamon, Li & Bello (2018). CREPE. ICASSP. †
- Riou, Lattner, Hadjeres & Peeters (2023). PESTO. ISMIR. †
- Klapuri (2003). Multiple fundamental frequency estimation based on
  harmonicity and spectral smoothness. IEEE TSAP 11:804; Klapuri (2006),
  ISMIR. †
- Vincent, Bertin & Badeau (2010). Adaptive harmonic spectral decomposition
  for multiple pitch estimation. IEEE TASLP 18:528. †
- Dessein, Cont & Lemaitre (2010). Real-time polyphonic music transcription
  with NMF and beta-divergence. ISMIR. †
- Bittner, Bosch, Rubinstein, Meseguer-Brocal & Ewert (2022). A lightweight
  instrument-agnostic model for polyphonic note transcription (Basic Pitch).
  ICASSP. Source: github.com/spotify/basic-pitch (≈17k parameters derived
  from `models.py`; 127.7ms default minimum note length). †
- Xi, Bittner, Pauwels, Ye & Bello (2018). GuitarSet. ISMIR. †
- Chen, Hsiao, Hsieh, Jang & Yang (2022). EGDB: a dataset for electric
  guitar transcription. ICASSP. †
- Riley, Edwards & Dixon (2024). High resolution guitar transcription via
  domain adaptation. ICASSP. †
- Sound On Sound reviews of the Blue Chip / Terratec Axon AX100 (transient
  early recognition) and of Jam Origin MIDI Guitar; Fishman TriplePlay
  latency benchmarks (tripletalk.fishman.com). †
