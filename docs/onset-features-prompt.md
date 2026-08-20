# Task prompt: three new onset features for same-pitch re-articulation

Self-contained brief for a fresh session on `trellos/Tuninator`. Everything needed
is here — do not assume any prior conversation.

---

## 0. Orientation

Branch: **`claude/guitar-event-recognizer-refactor-t5g5yr`**, at `c20fb69` when this
was written. Develop and push only there.

```bash
npm install
npx tsc --noEmit && npm test        # 492 tests
npm run eval                        # decodes fixtures, scores, exits nonzero on required failures
npx tsx scripts/measure-downstream-ledger.ts --all    # every missed label + the branch that lost it
npx tsx scripts/measure-splits.ts                     # events that came out as more than one Note
npx tsx scripts/measure-onset-coverage.ts             # what the onset kernel SAW, before the tracker
npx tsx scripts/measure-decision-separability.ts      # the AUC study described in §2
```

**Current state, which is the baseline any change must beat:**

| metric | value |
|---|---|
| missed labels | **32** of 459 |
| events split into more than one Note | **99** of 459, **107 extra Notes**, 10 strays |
| tests | 492 pass |
| `npm run eval` | PASS, 0 required failures; 16 of 17 fixtures pass |
| the one failure | `power-chords-b-a-g-fsharp-...` (room mic), `minLabelAccuracy (exact)` — a chord *naming* problem, not detection |

### Invariants — breaking any of these invalidates the work

- **`src/engine/**` imports nothing outside itself and `src/types.ts`.** No DOM, no
  globals, no clock reads, no npm imports, no top-level side effects. A test asserts
  it. This is what makes the offline eval trustworthy: the eval drives the *same*
  `RecognitionEngine` in the same 128-sample render quanta the AudioWorklet delivers.
- **`fixtures/labels/**` is read-only ground truth.** Never edit it. Never use the
  detector's output to decide what a label should be.
- **`fixtures/eval.config.json` thresholds are read-only.**
- **Derivation vs held-out.** The five 120bpm takes are the derivation set (78 labelled
  events); every tuned constant must be chosen against those alone. The twelve 140bpm
  Les Paul takes (381 events) are **held out** — scored every run, never fitted. That
  separation is the only reason any number here means anything.
- Real-time constraint: causal, browser, TypeScript over `Float32Array`, **no npm
  dependencies and no neural-network runtime**. Fitted constants or a small weight
  vector are shippable; a trained deep model is not.
- Do **not** use `git stash` — it is repo-wide across worktrees and has destroyed
  concurrent work in this repo before.

### The corpus

```
DERIVATION (constants come from here only)          78 events
  chords-a-bm-g-d-2x-120bpm                  16   chords
  clean-lead-120bpm                          43   notes
  cowboy-chords-c-d-em-g-c-d-em-am-120bpm     8   chords
  power-chords-c-a-g-e-c-d-fsharp-e-120bpm    8   chords
  spicy-chords-cmaj9-g-am11                   3   chords

HELD OUT (scored, never fitted)                    381 events
  four Les Paul performances x three signal paths — DI, amp sim, room mic
  cowboy chords 8 each, power chords 16 each,
  lead line quarters/eighths/triplets 55 each, lead line sixteenths 48 each
```

Note the held-out set is **four performances heard three ways**, not twelve
independent samples.

---

## 1. The problem

The recognizer must decide, at a transient landing over a Note that is already
sounding: **was the string picked again, or is this the ringing decay of what is
already there?**

The hard sub-case, and the one that defeats everything tried so far: the re-pick is
at the **same pitch**, and is often **muted** — the player damps the strings, so the
total energy goes *down* while the chord is plainly re-articulated. The mirror error
is a single sustained note shedding a spurious second event.

This is a named, acknowledged-hard problem in the literature. It is distinguished
from *interval onsets* (where pitch changes) as **steady-pitch onsets**, and
frame-based methods are documented to degrade exactly when successive notes share
harmonics or a re-attack brings insufficient magnitude increase.

**Why it is hard here, measured:** attack contrast varies **2.0x–24.2x across the
corpus and up to 106x within a single take**. No fixed threshold on any witness
separates everywhere.

**The evidence is nearly all present** — this is a selection problem, not a detection
problem. On the held-out twelve takes the onset kernel puts a transient within 60ms
of **372 of 381 labels**, with only 130 off-label firings over 9710 above-gate hops
(1.34%). The recognizer turns that candidate set into 351 found and 94 extra Notes:
it drops ~6% of the true candidates and keeps ~72% of the false ones.

Per signal path, across the four Les Paul performances (127 events each):

| path | missed | events split | extra Notes |
|---|---|---|---|
| DI | 6 | 27 | 29 |
| room mic | 11 | 26 | 27 |
| amp sim | 13 | 35 | 38 |

The amp sim is worst on both axes — compression flattens the real attacks while the
sustain keeps churning the spectrum. But note the DI splits 23 of 55 events on the
triplet take with no compression, speaker or room to blame, so **over-segmentation is
not a signal-chain artefact**.

---

## 2. What has already been measured and REFUTED

`docs/DETECTION-FINDINGS.md` records ~75 experiments in full. Read it before
proposing anything. The five that matter most for this task:

**(a) The twelve existing witnesses do not separate this decision.**
Witnesses: `sharpness`, `heldSharpness`, `fluxRatio`, `heldFluxRatio`, `riseRatio`,
`envelopeOverBaseline`, `decayExcess`, `soundedMs`, `pitchDiffers`, `gliding`,
`kernelOnset`, `bloomed`.

| model | AUC |
|---|---|
| best single witness (`sharpness`) | 0.728 |
| all twelve, L2 logistic, in-sample | 0.808 |
| all twelve, 5-fold with folds MIXING takes | 0.758 |
| all twelve, **leave-one-TAKE-out** | **0.434** — worse than chance |
| all twelve, fit on 5 derivation takes, scored on 12 held out | 0.647 — *below* the single witness at 0.667 |

At the operating point that costs zero labels, the best witness still admits **94 of
102 false candidates**. Correlations say there are about four witnesses, not twelve:
`sharpness`/`heldSharpness` r=0.954, `riseRatio`/`envelopeOverBaseline` 0.881,
`fluxRatio`/`heldFluxRatio` 0.867.

The 0.808 → 0.434 collapse is the signature of features whose **scale is
take-dependent**. This matters for task 2 below.

**(b) Judging boundaries jointly instead of one at a time does not help.**
A dynamic-programming optimal partition over each region, cost = per-segment misfit +
price per cut, swept across 22 prices: no price is inside the baseline on both axes,
and the best point holding extras under 107 misses 234 of 454 reachable labels. It is
worse than the existing greedy rule at matched recall. The per-segment cost terms
scored: decay residual **0.469** (chance), pitch stability 0.689, chroma stability
0.713. **A joint decision does not create information the local witnesses lacked.**

**(c) Per-rig calibration does not help.** A `RigProfileEstimator` (already in the
tree, `src/engine/rig-profile.ts`, wired to nothing by default) finds a real rig
signature — flux floors run 1.6x within a chain against 3.0x between, fitted
`sharpness` multipliers 1.001 / 1.234 / 1.957 / 2.795 for original / DI / mic / amp.
But scaling the witnesses by it, measured end to end at the **fit-on-test ceiling**,
gives 39 missed / 90 extras against the baseline 32 / 107 — it trades 7 played events
for 17 fewer duplicates. The honest cross-take version is worse (40 / 91). Decisively:
the same amp-sim profile removes 9 duplicates at zero cost on the triplet take and
costs 5 played events on the sixteenths take, **same guitar, same session**. What
varies is the passage, not the rig.

**(d) Local-rate ratio gating.** With an *oracle* rate it removes spurious Notes at
zero label cost, but the true prize is 8 emitted Notes, not the 64 first reported
(most merge candidates were never announced). The causal estimator cannot reach the
useful band: the gate only bites when the rate reads ≥138ms, oracle median at those
candidates is 154ms and the causal median is 120ms. Widening the estimator's ring
8→12→16→24 leaves the distribution identical — the rate is genuinely multi-valued
because the passages mix quarters, eighths, triplets and sixteenths, and it is
corrupted by the over-segmentation it exists to fix.

**(e) Other confirmed dead ends.** Textbook broadband phase deviation scored *worse*
than plain flux. A highpass attack band won only by measuring room hiss (mic takes
have 0.20–0.43 of magnitude above 12kHz against 0.0006–0.003 for the clean fixtures).
Pace/tempo-adaptive time constants buy nothing even with oracle tempo.

**The conclusion:** every one of the twelve witnesses is an energy-increase detector
in some disguise, plus pitch-change detectors that are definitionally blind to
same-pitch. **We need different features, not better logic over the same ones.**

---

## 3. The three tasks

Do them in this order. Each is cheap, each has a stated falsifier, and each makes the
next one easier to measure. **State the falsifier before you run, and report a
negative plainly if you get one** — five directions were closed this way and the
method is working.

### Task 1 — Move the maximum filter from the time axis to the frequency axis

**What we do now.** `src/engine/kernels/onset.ts` builds its flux reference as the
per-bin **maximum over the last `REFERENCE_FRAMES` hops** — the *time* axis — and
diffs the arriving frame against it.

Its own doc comment records why: at `fftSize` 1024 and 44.1kHz the harmonics of a low
E (82.4Hz, 1.9 bins apart) are unresolved and their main lobes beat against each
other, so on a *perfectly steady synthetic low E* successive-frame flux swings
between 0.003 and 0.68 — as large as a real pick attack. The time-max removes that
ripple.

It also records the cost. An earlier **decaying** per-bin peak hold (0.95 a hop, half
a second of memory) meant that during a ringing note the reference stayed high and a
quiet pick landing on top could not raise any bin above it: on the three sixteenths
takes it put a transient within 60ms of only **131 of 144** strokes. The memory was
shortened to a few hops. That is a symptom treated, not a cause fixed — **any time
memory makes the reference the loudest recent frame, which raises the bar for a
quieter re-attack, and a quieter re-attack is exactly the case we are failing.**

**What SuperFlux does instead** (Böck & Widmer, DAFx-13, *Maximum Filter Vibrato
Suppression for Onset Detection*). The maximum filter runs across **frequency bins of
the previous frame**, not over time:

```
diff[t] = spec[t] − maxfilter_over_frequency(spec[t − 1])      # keep positive part, sum over bins
```

Its purpose is to let a partial wander in frequency between frames without generating
flux — which suppresses vibrato and, for us, the beating and drift of decaying
partials. Reported: **up to 60% fewer false positives without missing additional
events**, measured on violin and operatic voice, i.e. sustained instruments with
drifting partials. We have 107 extra Notes.

Exact parameters from the reference implementation
(https://github.com/CPJKU/SuperFlux, `SuperFlux.py`):

```
frame size          2048
frame rate          200 fps  (5 ms hop)
filterbank          triangular, 24 bands per octave, 30 Hz – 17 kHz
magnitude           log10(mul * spec + add), mul = 1, add = 1
max filter          size = [1, max_bins], max_bins = 3      # 3 FREQUENCY bins, 1 frame
diff                spec[diff_frames:] − max_spec[0:-diff_frames], diff_frames typically 1
rectify             maximum(diff, 0), then sum across frequency
peak picking        threshold 1.1, pre_max 0.01 s, post_max 0.05 s,
                    pre_avg 0.15 s, post_avg 0 s, combine 0.03 s, delay 0
```

**The filterbank is not incidental.** 3 bins at 24 bands/octave is roughly ±1.5
semitones of tolerance — musically meaningful. A 3-bin max on our *linear* FFT bins
would be a fixed **Hz** tolerance: far too loose at the top, far too tight at the
bottom. Either add a log-spaced triangular filterbank before the max, or make the
max-filter width scale with bin index. Say which you chose and why.

**What to measure.** Whether the frequency-axis max lets `REFERENCE_FRAMES` drop
toward 1 while keeping the low-E ripple suppressed; then the full ledger and splits.
The synthetic steady low-E case in the existing tests is the direct check that the
ripple is still handled.

**Falsifier:** if flux on a steady synthetic low E still swings comparably to a real
pick attack with the frequency max in place and no time memory, the frequency max is
not substituting for the time max and the change should be reverted rather than
stacked on top.

### Task 2 — Adaptive whitening, then re-run the leave-one-take-out study

**Why.** The 0.808 in-sample → 0.434 leave-one-take-out collapse in §2(a) is the
classic signature of features whose *scale* differs per recording, and attack contrast
varies 106x *within* one take. Any threshold or weight fitted on one take is close to
meaningless on another.

**Mechanism** (Stowell & Plumbley, ICMC 2007, *Adaptive Whitening for Improved
Real-Time Audio Onset Detection*). Maintain a per-bin running peak and divide by it:

```
P[f] ← max( |X[f]| , m * P[f] , floor )        # m slightly below 1
X̃[f] = |X[f]| / P[f]
```

Each bin then occupies a similar dynamic range regardless of spectral roll-off and
playing dynamics. No training, lightweight, real-time. Reported to improve peak
F-measure by **more than ten percentage points in some cases**, across detectors based
on power, spectral flux, phase deviation and complex deviation.

The 106x-within-take figure says the memory coefficient `m` needs to be fairly short.
Derive it on the five 120bpm fixtures only.

**What to measure.** Re-run `scripts/measure-decision-separability.ts` with whitening
in place and report the same table as §2(a) — in-sample, take-mixing folds, and
**leave-one-take-out**. The LOTO number is the one that matters.

**Falsifier:** if leave-one-take-out AUC does not move materially above 0.434,
whitening is not addressing the generalisation failure and should be reverted. Note
that even a large LOTO improvement is not by itself a win — it must also show up in
the ledger and splits, or it is a better-behaved feature that still cannot make the
distinction.

**Whatever the outcome, this task makes tasks 1 and 3 measurable more cleanly**, so
run it even if you suspect it will not help on its own.

### Task 3 — Period-to-period dissimilarity (the one feature that is not an energy detector)

**The mechanism, and why it is the right shape.** A freely decaying plucked string is
a sum of exponentially decaying quasi-harmonic partials with **fixed relative
phases**, so `x[n] ≈ α · x[n−T]` for the period `T`, with `α` slightly below 1 and
slowly varying. A pluck is a new excitation: it changes the amplitude ratios across
partials and, decisively, **resets their relative phases**. The invariant that breaks
at a re-pick is therefore not energy but the *shape-and-phase continuation* of the
waveform — and that holds whether the new pick is louder, equal, or muted and
quieter.

Per hop, with `T` from YIN (prefer the 2048-window estimate, it is more stable) and
`N ≈ 2T`:

```
num = Σ x[n] · x[n−T]                       # n over the last N samples
den = sqrt( Σ x[n]²  ·  Σ x[n−T]² )
r   = num / (den + ε)                       # normalised cross-correlation at lag T, in [−1, 1]
D   = 1 − r                                 # cycle dissimilarity
```

**`D` is amplitude-invariant by construction** — the normalisation divides out both
the decay factor and any compressor gain. That is precisely the property all twelve
existing witnesses lack, and it is why this is worth a day.

Two refinements worth having:

- **Split into gain and shape.** `g = num / (Σ x[n−T]² + ε)` is the best-fit gain, i.e.
  the decay factor ≈ `exp(−hop/τ)`; `D_shape = 1 − r` is what remains after the best
  gain is removed. During free decay `g` tracks the decay and `D_shape ≈ 0`. At a
  **muted** re-pick `g` drops *below* the decay prediction **and** `D_shape` spikes.
  That joint pattern is the muted-repick signature and no single energy feature can
  express it.
- **Period search.** A YIN period error of even one sample at high f0 destroys `r`. Do
  a ±2-sample local search around `T` and take the maximum `r` — five extra
  correlations per hop, trivial.

**Spectral equivalent, if staying in the existing STFT is preferable:** restrict a
complex-domain prediction error to bins within ±40–60 cents of `k·f0` for `k = 1..8`,
weighted by each partial's own magnitude, and report the *median* absolute
phase-prediction residual across the partials so one bad partial (the fundamental, on
the room mic) cannot dominate. **This is not the broadband phase deviation already
refuted here** — that one is dominated by thousands of low-energy bins whose phase is
noise, which is exactly why it lost to plain flux. Restricting to the harmonic comb of
the *currently sounding* f0 and magnitude-weighting removes that noise floor.

**Prior art describing this exact failure.** US 9,646,591, *System, method, and
apparatus for determining the fretted positions and note onsets of a stringed musical
instrument*, describes an envelope-follower pluck detector plus a secondary
**pitch-synchronous** detector for the case the envelope detector cannot see. On when
the envelope detector fails: missed plucks occur "when a low frequency string is being
plucked at a very rapid rate … especially if the player is not changing frets",
because "the mass of the string and same-fret high frequency plucking tend to cause
the envelopes to sustain between plucks rather than decay." Its stated assumption:
"during the 'steady state' of a waveform, adjacent cycles are very similar, but during
a pluck, the amplitude and/or the phase of the input waveform will change. In
particular, **in the absence of sufficient envelope follower amplitude changes, phase
changes become a critical detection criteria**."
https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9646591

Academic support for the general strategy — use stable pitch to separate transient
from steady state, then look for change only inside the transient part, explicitly
because "the energy-based detection algorithm does not perform well for detecting soft
onsets": Zhou & Reiss,
https://www.eecs.qmul.ac.uk/~josh/documents/2007/ZhouReiss-MIREX2007-onsetdetection.pdf
and http://eecs.qmul.ac.uk/~josh/documents/2010/Zhou%20Reiss%20-%20Music%20Onset%20Detection%202010.pdf

**Known weaknesses — measure these, do not discover them late.**

- **Polyphony breaks it.** A chord has no single period and the NCC-at-lag-T trick
  degenerates. Gate the feature on YIN aperiodicity being low and **test the
  monophonic subset first**. If `D_shape` does not beat 0.73 AUC there, abandon the
  line quickly rather than trying to rescue it on chords.
- **Room mic.** Reverberation superimposes a delayed copy of the previous note, which
  lowers baseline `r` and smears the discontinuity. A per-take running baseline will
  be needed — but note that "deviation from a rolling baseline" is a family that has
  already failed here on the envelope, so budget for it failing again.
- **Vibrato and bends** break cycle similarity too. Use the existing glide flags as a
  **veto**, not as a competing feature.

**Also nearly free, and not currently among the twelve witnesses:** YIN's own
aperiodicity, `cmnd[τ*]`. It is already computed — `confidence = 1 − cmnd[τ]` in
`src/engine/kernels/yin.ts` — is bounded in [0,1] and therefore scale-free, and should
rise at a re-excitation. Add it to the separability study; it costs nothing.

**Falsifier for task 3:** if `D_shape` does not clear 0.73 AUC (the best existing
single witness) on the *monophonic* derivation subset under leave-one-take-out, stop.
The whole argument for this feature is that amplitude-invariance beats the take-scale
problem; if it does not show up there, it will not show up anywhere.

---

## 4. How to fuse whatever survives — do NOT repeat the mistake in §2(a)

If two or three of these features work, **fuse at the decision level, not the feature
level.** Holzapfel et al., *Three Dimensions of Pitched Instrument Onset Detection*
(IEEE TASLP 2010) fuse independently-thresholded phase, magnitude and pitch detectors
rather than fitting one weight vector, and report that the phase-slope detector "is
able to reach good performance when considering **soft onsets**", with high precision,
and that decision fusion improved results independently of signal type.
https://www.csd.uoc.gr/~hannover/MMILab-Andre_files/HolzapfelIEEEOnset.pdf

At 78 derivation events, three separately-calibrated thresholds are affordable; twelve
fitted weights measurably are not — that is what the 0.808 → 0.434 collapse *is*.

---

## 5. Traps specific to this corpus

- **The room-hiss trap.** Anything keying on broadband high-frequency noise energy, or
  on the low-magnitude bins *between* partials, will be won or lost by the room mic's
  hiss and the amp sim's churn rather than by the playing. The highpass attack band
  already failed here for exactly this reason. This is a live risk for spectral
  sparsity measures (NINOS²) and for harmonic/percussive separation without whitening
  first — noted here because those are the obvious next candidates after these three.
- **Never build a discriminant by comparing ACROSS files.** Recording levels differ by
  orders of magnitude between the DI, amped and mic paths, so any cross-file contrast
  measures the recording, not the playing. This has caught this project more than once.
- **Windows wider than the event spacing.** Four separate measurement bugs in this
  repo came from a window wider than the spacing of the events it was discriminating —
  a 120ms ownership tolerance against a 140ms triplet, a 150ms attack search against a
  107ms sixteenth, and two more. A sixteenth at 140bpm is **107ms**. Check every
  window against that.
- **Annotation noise is a real part of the ceiling.** The literature reports that
  non-percussive onsets show high variance in human annotations. Some fraction of the
  0.73 AUC ceiling may be label noise rather than feature failure. If a feature
  plateaus just short, that is worth raising rather than tuning against.

---

## 6. Verification bar — before ANY commit

```bash
npx tsc --noEmit && npm test        # both pass, no exceptions
npm run eval                        # PASS, 0 required failures
git diff --stat -- fixtures/        # EMPTY
```

Then report before/after for **both** axes, per fixture:

```bash
npx tsx scripts/measure-downstream-ledger.ts --all   # MISSED, baseline 32
npx tsx scripts/measure-splits.ts                    # baseline 99 split / 107 extras / 10 strays
```

Misses down at the cost of extras is **not** automatically a win. The standard is that
48 played notes read as 48 — both numbers count. A net loss is a finding, not a
commit; write it up in `docs/DETECTION-FINDINGS.md` and report it rather than shipping
it.

Break held-out results out **per signal chain** (DI / room mic / amp sim). A gain that
appears only on one path is a different result from one that appears everywhere.

No AI or model identifiers in commit messages, code comments, or any pushed artifact.

---

## 7. Sources

- Böck & Widmer, *Maximum Filter Vibrato Suppression for Onset Detection*, DAFx-13 — https://www.dafx.de/paper-archive/details/0oee-99Z88WL7pSo749gcA · reference implementation https://github.com/CPJKU/SuperFlux
- Böck & Widmer, *Local Group Delay Based Vibrato and Tremolo Suppression for Onset Detection*, ISMIR 2013 — https://archives.ismir.net/ismir2013/paper/000175.pdf
- Stowell & Plumbley, *Adaptive Whitening for Improved Real-Time Audio Onset Detection*, ICMC 2007 — http://epubs.surrey.ac.uk/811731/
- US 9,646,591, fretted positions and note onsets of a stringed instrument — https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9646591
- Zhou & Reiss, *Music Onset Detection Combining Energy-Based and Pitch-Based Approaches*, MIREX 2007 — https://www.eecs.qmul.ac.uk/~josh/documents/2007/ZhouReiss-MIREX2007-onsetdetection.pdf
- Holzapfel et al., *Three Dimensions of Pitched Instrument Onset Detection*, IEEE TASLP 2010 — https://www.csd.uoc.gr/~hannover/MMILab-Andre_files/HolzapfelIEEEOnset.pdf
- Bello et al., *A Tutorial on Onset Detection in Music Signals* — https://hajim.rochester.edu/ece/sites/zduan/teaching/ece472/reading/Bello_2005.pdf
- Dixon, *Onset Detection Revisited*, DAFx-06 (annotation variance) — https://www.dafx.de/paper-archive/2006/papers/p_133.pdf
- Mounir et al., *Guitar note onset detection based on a spectral sparsity measure*, EUSIPCO 2016 — https://new.eurasip.org/Proceedings/Eusipco/Eusipco2016/papers/1570256369.pdf · journal version https://asmp-eurasipjournals.springeropen.com/articles/10.1186/s13636-021-00214-7
- Fitzgerald, *Harmonic/Percussive Separation Using Median Filtering*, DAFx-10 — https://arrow.tudublin.ie/argart/9/ · librosa implementation https://raw.githubusercontent.com/librosa/librosa/main/librosa/decompose.py
- Driedger, Müller & Disch, *Extending Harmonic-Percussive Separation*, ISMIR 2014 — https://www.audiolabs-erlangen.de/resources/2014-ISMIR-ExtHPSep/2014_DriedgerMuellerDisch_ExtensionsHPSeparation_ISMIR.pdf
- Röbel, *Onset Detection by Transient Peak Classification*, MIREX 2005 — http://articles.ircam.fr/textes/Roebel05d/index.pdf
- Hawthorne et al., *Onsets and Frames*, ISMIR 2018 — https://archives.ismir.net/ismir2018/paper/000019.pdf
- Spotify Basic Pitch (guitar-validated, harmonic-stacked CQT, <17K params) — https://github.com/spotify/basic-pitch
- pYIN note tracking, on repeated notes — https://code.soundsoftware.ac.uk/projects/pyin
