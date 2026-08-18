# Handoff: rearchitecting detection

Written at the end of a long session spent measuring the existing detector
rather than redesigning it. The measurements are the deliverable. This document
exists so the next session can change the architecture without re-deriving
what is already known, and without repeating the specific mistakes below.

Branch: `claude/tuninator-code-review-q5yzz2`. Everything described here is
committed and pushed.

---

## 1. Where the numbers actually are

`npx tsx scripts/strict.ts` — the honest score. Every labelled event, named
exactly right; `unknown` counts as wrong.

```
clean-lead-120bpm                           35/43    81%
power-chords-c-a-g-e-c-d-fsharp-e-120bpm     8/8    100%
cowboy-chords-c-d-em-g-c-d-em-am-120bpm      6/8     75%
chords-a-bm-g-d-2x-120bpm                   12/16    75%
spicy-chords-cmaj9-g-am11                    2/3     67%
TOTAL                                       63/78  80.8%
```

`npm run eval` reports something kinder and less useful — it scores label
accuracy over the events the detector was *willing* to name, so abstaining on
half the file can post 100%. Use `strict.ts` for "did it hear the recording".

**CI is red and has been for several commits.** `npm test` fails, which
*skips* Build library, all four Demo steps, and Eval. Last green run was
`c487c88`. The failures are `tests/fixtures.test.ts`, which is red **by
design** — see §5. This was raised with the user and left unresolved; it needs
a decision, not a fix.

---

## 2. The single most important finding

**Seven of the eight remaining misses on the lead fixture are one mechanism,
and it is not a bug in any pitch algorithm.**

When the player hammers on, pulls off, or picks lightly inside a run, the
previous note is *still sounding*, often louder than the new one. A monophonic
estimator reports the loudest periodicity. It is correct, and it is marked
wrong.

This is measured, not inferred. A bare DFT over note `t4`'s span puts E5 at
relative magnitude **1.000** and D5 at **0.985**. The E is genuinely there. It
simply is not the loudest thing there.

```
miss   reads   what it is
t4     D5      E5 sounds while the D is still ringing (E5 1.000 vs D5 0.985)
t10    D5      same, E5 at 0.290 of the D
t16    D5      same, E5 at 0.387 — never dominant at any alignment
t6     D5      pull-off to C#5 never breaks the D. YIN reports this at 0.95 conf
t2     B4      previous B4 still at 60–115% of the C#5
t20    C#4     octave down, same blend
```

**Implication for a rearchitecture:** the lead path is solving the wrong
problem. The input at these moments is polyphonic, and the question is not
"what is the pitch" but "which note just *arrived*". Only temporal information
separates them — no better monophonic estimator can win these, and four have
now been measured to confirm it.

The repo already contains a polyphonic transcriber (`src/core/note-activation.ts`,
NNLS over a harmonic-comb dictionary) that the *chord* path uses and the lead
path does not. That asymmetry is the obvious thing to question first.

---

## 3. Two label errors, measured, not yet corrected

Ground truth was not edited. The user's standing position is that they will
change `fixtures/labels/*.json` when analysis proves something is genuinely
undetectable. These two qualify. **Please present them rather than assuming.**

**`t24` is labelled B5 and is B4.** Over its span, B4 measures 1.000 at 494Hz
and the energy at 988Hz measures 0.209 — *exactly* B4's independently measured
second harmonic. There is no independent B5. The label file's own header says
"Octaves are first-pass estimates".

**`s12` is labelled A4 over 500ms and is really B4 → A4 → B4.** The sixteenth
run contains thirteen notes — three full `B C# B A` cycles plus a final B4
resolving the phrase — and the label file has twelve, stretching the last to
cover all three.

A third note, `t16` (E5), is present but never louder than the ringing D5 at
any alignment. It is real, and unwinnable monophonically.

---

## 4. The labels' *timing* is arithmetic, and this matters a lot

`fixtures/labels/clean-lead-120bpm.json` computes note boundaries by dividing a
waveform-estimated section start evenly by the note count. Its own
`timingNotes` field says so. Nobody plays a perfect grid.

Measured with a bare DFT, sliding each labelled span and scoring how far its
own fundamental stands above the other notes of the piece:

- sixteenths sit a median **+90ms** later than labelled
- triplets **+60ms**
- quarters **+40ms**
- per-note spread *inside one section* runs **-100ms to +200ms**, so no single
  global shift repairs it

`scripts/label-alignment.ts` measures each note's real span, deliberately blind
to any pitch tracker, so an estimator is never scored against a target it
helped position. Identities stay ground truth; only timing is measured.

**Knock-on nobody has acted on yet:** `src/eval/matcher.ts` scores onset
alignment as `1 - |delta| / 300ms`. With labels systematically 90ms early and
sixteenths ~130ms apart, a correct detection sits 90ms from its own label and
40ms from the *next* one, so the greedy pairing can hand a detection to the
wrong label. This does not inflate the totals above, but it makes `strict.ts`
noisier on fast passages than it looks. Worth fixing before trusting small
deltas on the lead fixture.

---

## 5. What the tests do

`tests/fixtures.test.ts` demands **complete identification** and is **expected
to be red** until every event is named. `unknown` counts exactly as a wrong
label does. A `SHORTFALL` map lists every remaining miss with its reason, and a
companion test fails if `SHORTFALL` names an event that now passes — so a stale
entry cannot quietly become a licence.

`SHORTFALL` is a worklist, not permission. The only sanctioned edit is deleting
an entry once the detector names that event. **It is currently stale** — it
still lists lead misses that the fusion work fixed, and its lead entries were
written before §3 and §4 were known.

---

## 6. Measurement tooling built this session (use it, don't rebuild it)

| tool | what it does |
|---|---|
| `scripts/strict.ts` | the honest end-to-end score; takes `policy.path=value` overrides |
| `scripts/label-alignment.ts` | measures each note's true span with a bare DFT, no tracker |
| `scripts/bench-estimator.ts` | measures ONE estimator on note interiors, isolated from tracking/onsets/gating |
| `scripts/bench-fusion.ts` | measures a combination, and prints what it gained and lost against its best member |
| `src/core/pitch/estimator.ts` | the `PitchEstimator` contract |

The bench deliberately excludes tracking, segmentation, onsets and the
amplitude gate. That is its value and its limit — see §7.

---

## 7. Estimators built and measured

All four implement `PitchEstimator`. Bench = note interiors only; pipeline =
end-to-end via `strict.ts`.

| estimator | bench notes | bench frames | pipeline (lead) |
|---|---|---|---|
| YIN (incumbent, `src/core/yin.ts`) | 35/43 | 425/617 (68.9%) | 34/43 alone |
| MPM / NSDF | 35/43 | 426/617 (69.0%) | — |
| SWIPE-prime | **36/43** | **438/617 (71.0%)** | **29/43 alone** |
| onset-weighted (arriving energy) | 33/43 | 351/617 (56.9%) | — |
| fused, weights 4/1/0/1 | — | — | **35/43** |

**The row that matters most is SWIPE.** It is the best single estimator on the
bench — miss set a strict subset of YIN's, confidence honestly calibrated
(0.712 mean reported for 71.0% correct, where YIN reports 0.84 for 68.9%) — and
it scores **29/43 in the pipeline against YIN's 34**. The bench samples note
interiors; the pipeline runs every frame including silence, attacks and decay,
and YIN's path carries a 384-sample short window that resolves fast notes and
that SWIPE has no equivalent of.

**Do not port a bench ranking into the pipeline without re-measuring.** This is
the second time this project has been burned by that exact move (§9).

Cost note: SWIPE builds a 3.2MB kernel bank and costs ~1.0ms/frame (~7% of a
core at the 640-sample hop). It currently ships at **weight 0** — inert — kept
only because it is the strongest standalone method and the likeliest to matter
under a different architecture. If the rearchitecture does not use it, delete
it rather than leaving it building a kernel bank for nothing.

---

## 8. Negative results — measured, and deliberately not kept

Re-deriving these costs hours. They are all in commit messages too.

- **Viterbi decoding over NNLS activations** (pYIN-style, three variants):
  27–30 against YIN's 31 through the real tracker. Reverted entirely.
- **Using the NNLS transcription as an octave arbiter:** 28/43.
- **Chroma temporal smoothing:** unhelpful; `smoothingFrames: 1`.
- **Sparsity prior on the NNLS solve:** changes nothing the fixtures can
  distinguish. Knob removed; the negative result is documented in
  `note-activation.ts`.
- **Extra spectral-envelope variants:** no gain past 3.
- **Symmetric margin rule** in the chord matcher: re-measured, old
  justification no longer holds, gains nothing.
- **Weighting the note tracker's label vote by frame confidence** instead of
  one count per frame: exactly neutral, 63/78 with an identical per-fixture
  breakdown. Reverted. It is the same argument that motivates the frame-level
  vote, so it may well matter under a different architecture — but it does not
  here.
- **ERB frequency warp in SWIPE** (the published axis): 35/43 vs linear's
  36/43, and the gap does not close at any ERB step. An ERB axis spends four
  fifths of its points below 1kHz; on guitar the partials that separate a note
  from its octave are the high ones.
- **Prime-harmonic restriction in SWIPE:** buys nothing measurable on this
  fixture (36/43 either way). Kept because it halves the kernel bank and is
  what SWIPE′ *is*. Needs re-measuring on material that actually confuses
  octaves.
- **Naive max-confidence fusion:** scores *below* the best single member,
  because YIN is overconfident and wins ties it should lose.

---

## 9. Mistakes made this session — please don't repeat them

**A bench can be wrong in ways that look like a label error.** The analysis
window *trails* the sample point: asking for the pitch at time T shows the
estimator the audio *ending* at T. Sampling from a note's start therefore
answers from a window mostly containing the *previous* note. YIN scored 1 of 12
sixteenths that way. I nearly rewrote the label file before finding it.

**The same bench was wrong a second time.** It walked notes in label order, and
the measured spans overlap, so the clock jumped *backwards* at note boundaries
by up to 160ms. Stateless estimators can't tell; the stateful one had its
history drawn from the future on four of the eight notes it exists to fix.
Found by a subagent, not by me.

**An over-segmented measurement inflated a result to 88%.** An offline decoder
emitted 139 events for 43 labels, and the one-to-one matcher found
correct-looking events in the haystack. Through the real tracker it was 29
against YIN's 31. **Always check end-to-end before reporting a number.**

**A refactor that "obviously" preserves behaviour, twice did not.** Both were
caught only by asserting that a single witness voting alone reproduces the old
result exactly. It did not: an octave-leak term was counting as a rival to the
member that cast it, and a `√strength` factor turned a lone witness's 0.5 into
0.71 — which, since the pipeline gates on that number, silently *lowered the
confidence gate*. The first weight sweep was therefore measured against an
inflated baseline and was meaningless. **Build the identity check first.**

**Do not deflect to "we need more samples."** The user rejected this and was
right to: if the existing code cannot handle the lead line, more failures will
not improve it.

---

## 10. Constraints that carry forward

- Develop and push **only** on `claude/tuninator-code-review-q5yzz2`.
- **Do not open a pull request** unless explicitly asked.
- GitHub access is scoped to `trellos/tuninator` only.
- No model identifier in commit messages, PR text, code comments, or any
  pushed artifact.
- `src/core/` rules: no DOM, no globals, no npm imports, and `estimate()` /
  per-hop paths must be allocation-free — this code runs in an AudioWorklet
  render quantum.
- The same code runs in the worklet, in Node and in Vitest. The offline eval is
  trustworthy *only* because there is no separate offline detector. Keep it
  that way.
- Comments explain **why**, with the measured numbers that justify the
  constant. Dead machinery is worse than none — if a knob changes nothing the
  fixtures can distinguish, delete it and write down the negative result.
- The standard is a human listener: they can name every chord and note in these
  recordings, so the detector has to. "Honest abstention" is not success.

---

## 11. Suggested starting point

1. Fix the `matcher.ts` onset-window bias (§4) so small deltas on the lead
   fixture mean something.
2. Present the two label errors (§3) and get a decision.
3. Then attack §2 — the lead path treats polyphonic input as monophonic. The
   NNLS transcriber already exists and is already used by the chord path.
   "Which note just arrived" is a tracking question, and the bench cannot see
   tracking, so expect to need a new measurement for it.
