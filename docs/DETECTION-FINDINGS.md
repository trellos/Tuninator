# Where the recogniser stands, and what the audio will and will not support

Measured on the committed fixtures. Every number here came from running the
code, not from reasoning about it. `fixtures/` is untouched — no label edited,
no gate lowered (`git diff d8e4141..HEAD -- fixtures/` is empty).

## Against the frozen baseline (docs/BASELINE.md)

| metric | baseline | now | gate |
|---|---|---|---|
| labels missed | 12 / 78 | **3 / 78** | 0 |
| required fixtures failing | 2 | **1** | 0 |
| clean-lead pitch class (gated) | 77.4% | **89.66%** | 90% |
| power-chords onset median | 140ms FAIL | **113ms PASS** | 120ms |
| chords-a-bm missed | 3 | **0** | — |
| spurious Notes | 23 | 35 | — |

Four of five fixtures pass every gate they are held to.

## What was wrong, and what fixed it

A strummed chord shed contiguous fragments — one Em strum became three Em
Notes 500ms apart. Two causes, both now fixed:

1. **The decay fit lived on the Note.** Splitting a Note discarded the only
   evidence that could reject the *next* split, so each fragment was too young
   to say no and split again. The fit now carries across a split.
2. **The level test used a rolling baseline that falls with the decay**, so
   sustain ripple cleared it every few hundred milliseconds. Over a chord that
   has named itself, the decay curve and the transient's sharpness now carry
   the case alone.
3. **Octave jumps were only treated as artefacts under harmonic context.** On a
   clean lead line nothing stopped them, so a sustained note flipped octave and
   split, and the matcher then paired the label with the wrong-octave half.

Spurious Notes: 51 → 35. No labelled event was lost to any of these.

## What the audio will not support

### t10 (E5, 13360-13527ms) is not recoverable

The label is honest — a player did pick an E5 there — but nothing in the signal
carries it. Swept both analysis windows across the whole span:

```
fftSize=2048 (43ms) and 4096 (85ms), windows ending 13400..13540ms
  every position:  strongest = D5 at salience 1.00
  E5:              ABSENT (one 0.333 blip at 13440ms, 85ms window)
```

The fast lane agrees: across t10 it reports D5 at 576-598Hz with confidence
0.83-0.97 and never approaches E5 (659Hz). The preceding D5 is still ringing
and its harmonic series swamps a weakly-picked neighbour (t10's own fundamental
measures 0.0007 against 0.0036 for t9).

This is the documented exception: analysis shows the label is not recoverable.
It costs no gate — clean-lead has no `maxMissed` check.

### s4 and s11 are recoverable in principle, but not monophonically

The sixteenths run has an open B ringing under the melody, so the passage is
polyphonic even though it reads as a lead line. Multi-pitch sees the melody
note plainly — at s4 it reports `A4 salience 0.986` beside `B4 1.000` — but the
*loudest* fundamental is the ringing open string, not the note just played.

Resolving these needs the deep lane to pick the fundamental that is NEW at the
Note's onset rather than the strongest, which is the Voices-versus-Notes
distinction (architecture §21) applied to pitch rather than to harmony. Both
labels sit in the `sixteenths` section, which `eval.config.json` already marks
`required: false`.

## The remaining required failure

`clean-lead` fails two checks:

- **pitch class 89.66% against 90%** — 26 correct of 29 scored; one label short.
  The two wrong ones in the gated sections are t12 (C#5 read as D#5) and t15
  (D5 read as C#5). Both are boundary-placement failures, not pitch failures:
  across t12 the estimator reports D5 for the first 94ms and then C#5 correctly
  for the rest, so the right answer is in the signal and the Note boundary is
  landing in the wrong place.
- **13 spurious Notes against a limit of 3.** This check also failed at baseline
  (8 against 3); it has never passed. Two of them are the 2.7 seconds of real
  ring-out after the bend at 7950ms, where RMS runs 0.044 down to 0.022 against
  a gate of 0.008 — the recogniser is reporting audio that is genuinely
  sounding and that the ground truth stops annotating.

## Hypotheses tested and rejected

Each was implemented, measured on the fixtures, and reverted. Recorded so they
are not tried again:

| change | result |
|---|---|
| backdate step boundaries by estimator group delay | onset error 90→77ms, accuracy unchanged, +1 spurious |
| let a frame vote only once its window is inside the Note | no change at all |
| delay voting until the estimate settles (40/70/95ms) | neutral at 40, accuracy 0.897→0.862 at 70+ |
| give the deep lane a vote on a monophonic Note's pitch | no accuracy change (it is fooled by the same ringing note) |
| median smoothing 3→2 / 3→1 | 3→2: +11 spurious; 3→1: +2 missed |
| require a transient for same-pitch re-articulation | spurious 11→9 but accuracy 0.897→0.786 |
| restrum sharpness 1.1 instead of 0.9 | −4 spurious, +2 missed, second fixture fails |

The common thread: the pitch path is systematically ~90ms late relative to the
hand-annotated onsets, while the transient path is not. Closing the last gate
needs one coherent latency model spanning both, so that boundary placement and
pitch attribution move together — not another threshold.
