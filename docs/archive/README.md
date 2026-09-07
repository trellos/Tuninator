# Archive

Records from lines of work that are closed, kept because the measurements and
the reasoning in them are still worth having. **Nothing in this directory
describes the shipping library**, and nothing in it is guidance: paths, scripts
and commands in these files refer to trees that no longer exist.

| File | Provenance | Why it is kept |
| --- | --- | --- |
| `detection-rearchitecture-handoff.md` | `claude/tuninator-code-review-q5yzz2` @ `053526b` | The measurement that motivated the current architecture, the four-estimator comparison, ten negative results, and four methodology mistakes worth not repeating. |
| `pre-rewrite-agents-guide.md` | `claude/tuninator-orchestration-agent-phcm0m` @ `67d2fa2` | The pre-rewrite lane structure and the `src/core/` purity rule, ancestor of today's `src/engine/**` isolation invariant. |

The live equivalents are `AGENTS.md` (guidance), `docs/DETECTION-FINDINGS.md`
(measured experiments) and `DECISION_LOG.md` (decisions). The lessons from this
material that still bind the current engine are lifted out into
`docs/DETECTION-FINDINGS.md` ("Lessons carried over from the retired lineage"),
because this directory is explicitly not read as guidance.

---

## What is preserved here, and what is not

These two branches were retired by DECISION-023. **Their prose is preserved
here in full; their source code is not.** If the branches are deleted, what is
lost is the implementation only:

- the `src/core/` tree (~5,800 lines): the single-active-event `EventTracker`,
  `note-activation.ts` (NNLS over a harmonic-comb dictionary), `policy.ts`,
- four `PitchEstimator` implementations — YIN, MPM/NSDF, SWIPE-prime, and an
  onset-weighted estimator — plus the weighted-vote fusion over them,
- the bench harness (`scripts/strict.ts`, `label-alignment.ts`,
  `bench-estimator.ts`, `bench-fusion.ts`).

Every *number* those produced, and the reasoning around them, is in
`detection-rearchitecture-handoff.md`. Nothing in the shipping engine imports
any of it, and the head-to-head in DECISION-023 is the reason it was not
carried forward. Re-implementing SWIPE-prime from the published description
would be cheaper than the argument for keeping a branch alive to hold it.

## Open item this material leaves behind

§3 of the handoff proposes **two label corrections** (`t24` labelled B5 and
measured B4; `s12` labelled A4 over 500ms and measured B4 → A4 → B4) and
explicitly asks that they be *presented*, not assumed. `fixtures/labels/**` is
read-only ground truth and neither was changed — by that session or by the
consolidation. They remain a decision for the project owner.

## Branch ledger

Kept because the branches themselves may not survive; the commit subjects are
the shape of the work.

### `claude/tuninator-code-review-q5yzz2` — 25 commits after `d8e4141`

| commit | subject |
| --- | --- |
| `8a436a9` | Split EventTracker by mode, and make chord abstention reachable again |
| `fafb097` | Separate the Tuninator library from its platform workers |
| `2d75678` | Move channel selection out of the library and into the host |
| `beb6a44` | Add CI, and rewrite the README around the library/worker split |
| `4a80463` | Correct numbers in the README and in the comments they came from |
| `9256eb5` | Clear out what the refactor left behind |
| `198b884` | Correct an accuracy claim I got half right, and the docs my own change staled |
| `dc650fc` | Remove type fields the library never fills |
| `7542624` | Segment chords by root and by re-strike, not by label |
| `4baa798` | Retune the pitch front-end, and stop splitting notes on octave slips |
| `2984a6d` | Refresh the README against the retuned detector |
| `c487c88` | Make the test suite fail when the detector mis-hears the fixtures |
| `a0345b1` | Transcribe the notes before naming the chord |
| `00dc073` | Suppress unresolved semitone leaks, and drop two knobs the fixtures cannot use |
| `d0bc654` | Re-measure the margin rule's asymmetry against the new front end |
| `6e720bd` | Fix YIN's octave-up error, and stop gating away legato notes |
| `1a4080b` | Measure the estimator directly, against timing taken from the audio |
| `dd2dcd6` | Fuse estimators by weighted vote rather than by picking the loudest |
| `928969a` | Drop the top-level await from label-alignment's CLI guard |
| `4dee4bf` | Add a SWIPE-prime estimator, in progress |
| `dea52e5` | Add the McLeod Pitch Method as a second opinion on the lag axis |
| `9cb6f38` | Add SWIPE-prime and attack-aware estimators, in progress |
| `080d15b` | Visit bench frames in time order, and add an attack-aware estimator |
| `b105fc7` | Decide pitch by a vote of four methods rather than by YIN alone |
| `053526b` | Add a handoff for the detection rearchitecture |

### `claude/tuninator-orchestration-agent-phcm0m` — 1 commit after `d8e4141`

| commit | subject |
| --- | --- |
| `67d2fa2` | Add AGENTS.md for contributors and coding agents |
