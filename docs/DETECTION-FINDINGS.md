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

## The one that mattered

`currentLabel()` returned the newest frame's pitch. The tracker had always
accumulated a confidence-weighted vote per pitch — with a comment explaining
that naming a Note from its last frame hands it its neighbour's name — and the
label never read the votes. Naming a Note from its own accumulated evidence took
the lead take from 89.7% to **93.1%** pitch class and 79.3% to **86.2%** exact,
clearing a gate that fixture had never met.

That is also why every experiment above that adjusted *voting* measured as
neutral: the votes were not reaching the label. They are worth re-testing now
that they do.

## The remaining required failure

`clean-lead` fails two checks:

- **pitch class — now passing at 93.1%.**
- **12 spurious Notes against a limit of 3.** This check also failed at baseline
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
| attribute each frame's pitch retrospectively, to the Note sounding when that audio happened | no change at 45ms, accuracy 0.931→0.862 beyond it |
| absorb an identically-named stub into the Note it runs out of | clean-lead spurious 12→4, but eats genuine repeats: +4 missed, accuracy 0.931→0.828. Guarding Notes that began on their own attack makes it inert — the stubs all begin on attacks too |
| widen the glide window so a slow bend registers as gliding | does not stop the bend splitting; breaks two other fixtures |
| past the ring-out, require energy above the decay with no sharpness escape | missed 4→12, three fixtures failing, one unit test broken |
| subtract the lag from *reported* times only, leaving voting untouched | onset error 90→36ms, but accuracy 0.897→0.862 and +2 missed: moving every Note earlier re-pairs detections onto their neighbours' labels |

What is left is one shape of error: a transient fires inside a Note that is
already sounding, passes both the decay test and the sharpness test, and splits
one played note into two identically-named ones. Seven of the lead take's twelve
spurious Notes are exactly that, and two more are the bend at 6950ms coming
apart into A3, A#3 and B3 — a bend is supposed to stay one Note.

Every threshold that catches them costs genuine re-picks somewhere else, which
is the ten rows above. They are not distinguishable by level or by flux
sharpness, because a decaying string genuinely produces sharp transients — finger
noise, the string re-seating against the fret — that no pick made. Separating
those from a real pick wants the transient's spectral shape, which the detector
does not currently look at: a pick excites the whole spectrum at once, while
finger noise is narrowband and mostly high. That is a new witness, not a
constant.

The older observation still stands: the pitch path is systematically ~90ms late
relative to the hand-annotated onsets, while the transient path is not. Closing the last gate
needs one coherent latency model spanning both, so that boundary placement and
pitch attribution move together — not another threshold.

The last row is the clearest evidence for that. Correcting only the reported
times fixes the onset error almost completely (90ms to 36ms) and makes the
labelling worse, because the boundaries and the pitch evidence then disagree
about where a Note is. Either both move or neither does. That is a change to how
segmentation works, not a constant to tune, and it wants its own pass with the
articulation tests extended first — a Note's boundary and the frames that name
it have to be derived from the same clock.
