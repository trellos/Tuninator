# Task prompt: the label ceiling, the millisecond click witness, and the tracker harvest

Self-contained brief for a fresh session on `trellos/Tuninator`. Everything needed
is here — do not assume any prior conversation. Read `AGENTS.md` in full and the
final section of `docs/DETECTION-FINDINGS.md` ("Three candidate features from the
onset literature, measured to their verdicts") before the first edit.

A companion brief, `docs/learned-onset-head-prompt.md`, is being run in a
SEPARATE session. Do not do its work here, and do not assume its results exist.

---

## 0. Orientation

Work from the latest `main`. Develop and push on the branch your session
designates. Do **not** use `git stash` — it is repo-wide across worktrees here
and has destroyed concurrent work before; this matters doubly with a second
session running against the same repo.

```bash
npm install
npx tsc --noEmit && npm test        # 494 tests
npm run eval                        # decodes fixtures, scores, exits nonzero on required failures
npx tsx scripts/measure-downstream-ledger.ts --all    # every missed label + the branch that lost it
npx tsx scripts/measure-splits.ts                     # events that came out as more than one Note
npx tsx scripts/measure-onset-coverage.ts             # what the onset kernel SAW, before the tracker
npx tsx scripts/measure-decision-separability.ts      # the witness AUC study
npx tsx scripts/measure-whitening-separability.ts     # same rows, whitened witnesses (the harness pattern to copy)
```

**Current state — the baseline any change must beat:**

| metric | value |
|---|---|
| missed labels | **32** of 459 |
| events split into more than one Note | **99** of 459, **107 extra Notes**, 10 strays |
| tests | 494 pass |
| `npm run eval` | PASS, 0 required failures; 16 of 17 fixtures pass |
| the one failure | `power-chords-b-a-g-fsharp-...` (room mic), `minLabelAccuracy (exact)` — chord *naming*, not detection |

### Invariants — breaking any of these invalidates the work

- **`src/engine/**` imports nothing outside itself and `src/types.ts`.** A test
  asserts it. The eval drives the same `RecognitionEngine` in the same
  128-sample quanta the AudioWorklet delivers.
- **`fixtures/labels/**` is read-only ground truth. `fixtures/eval.config.json`
  is read-only.** Task 1 below produces a SECOND, separate annotation set for
  comparison — it never edits, "corrects", or merges into the shipped labels.
- **Derivation vs held-out.** The five 120bpm takes (78 events) are the
  derivation set; every tuned constant comes from them alone. The twelve
  140bpm Les Paul takes (381 events; four performances heard through DI, amp
  sim, and room mic) are held out — scored every run, never fitted.
- Real-time constraint: causal, browser, TypeScript over `Float32Array`, no
  npm dependencies, no neural-network runtime.
- **State each falsifier before measuring, and report a negative plainly.**
  Eight directions on this decision have been closed this way; the method is
  the project's main asset.
- No AI or model identifiers in commit messages, code comments, or any pushed
  artifact.
- Log decisions in `DECISION_LOG.md` per `AGENTS.md` §6, continuing from the
  highest number present. The companion session appends to the same log:
  fetch `main` before pushing, and if your number was taken in the meantime,
  renumber yours and merge rather than force-pushing.

### Where the problem stands

The recognizer must decide, at a transient landing over a sounding Note:
**was the string picked again, or is this the decay of what is already there?**
The twelve existing witnesses are energy detectors in disguise; their best
single AUC on this decision is 0.728 (`sharpness`), a fitted twelve-witness
model collapses 0.808 → 0.434 under leave-one-take-out, and three literature
features (SuperFlux frequency max, adaptive whitening, cycle dissimilarity)
were measured to their verdicts without moving the ledger
(`docs/DETECTION-FINDINGS.md`, final section; DECISION-012..015).

Two load-bearing facts for this brief:

1. **The evidence is nearly all present.** The onset kernel puts a transient
   within 60ms of 372 of the 381 held-out labels. The losses are selection
   and bookkeeping, not detection.
2. **Every witness so far lives on a 12ms hop over 23ms windows.** Nothing in
   this repository has ever measured the signal at the timescale of the pick
   itself (1–5ms).

---

## 1. Task 1 — Measure the label ceiling (do this first)

**Why.** The literature reports high inter-annotator variance for
non-percussive onsets (Dixon DAFx-06; the 2022 soft-onset string-ensemble
study measured 24 annotators disagreeing at 25ms tolerance, agreement tracking
musical experience). Some unknown fraction of the 0.73 AUC ceiling may be
label noise rather than feature failure — every experiment planned after this
one is graded against these labels, so bound this first. The counter-argument
is also live: picked electric guitar is far sharper than bowed strings, so
agreement may be near-perfect and the headroom real. Either answer changes
what to do next; that is what makes the measurement cheap and decisive.

**Protocol.**

1. **Extract the contested set.** From the current baseline: every missed
   label (32), every extra-Note boundary (the 107, from
   `measure-splits.ts` internals), and every decision-table row within 70ms of
   a label where the detector and the target disagree
   (`measure-decision-separability.ts` exports `collect()`). Deduplicate by
   time. Add ~20% uncontested control points (clear hits, randomly chosen) so
   an annotator cannot learn "everything here is a trick question".
2. **Render a listening kit.** For each point, write a WAV snippet (~1.5s,
   centred on the moment, from `fixtures/audio/`; a minimal PCM16 WAV writer
   in the script is fine — `src/offline/wav.ts` reads, it does not write) into
   `.cache/relabel/`, named by an opaque randomized id. Write a manifest
   (id → fixture, time) kept SEPARATE from the answer sheet, and a blank
   answer sheet (CSV: id, "new note starts in the middle third: yes/no/unsure",
   optional onset offset in ms). Nothing in the kit may reveal what the
   detector or the shipped label says. Do not commit the audio; commit the
   scripts that generate and score it.
3. **Independent machine pass.** The session completes the answer sheet once
   itself, from signal evidence only — waveform, fine envelope, spectrogram
   readings computed fresh in the scoring script — WITHOUT consulting
   `fixtures/labels/`, the recognizer's output, or the manifest while
   answering. This is annotator M.
4. **Human pass.** The kit is built so the user can be annotator H in ~20–30
   minutes for two or three takes. If the user is available mid-session, hand
   it over and wait; otherwise finish everything else, leave the kit and a
   one-command scorer (`npx tsx scripts/score-relabel.ts <answers.csv>`)
   ready, and say so in the final report.
5. **Score.** Agreement of M (and H when present) with the shipped labels and
   with each other, at 25/50/70ms tolerances, overall and split by: contested
   vs control, derivation vs held-out, signal path, and ledger cause. Report
   the implied ceiling: if annotators disagree with the labels on X% of
   exactly the contested rows, the reachable AUC on those rows is bounded
   accordingly.

**Decision rule, stated in advance.** On the CONTROL points, any annotator
must agree with the shipped labels ≥95% — below that the kit or the pass is
broken, fix it before reading anything else. On the CONTESTED points: if
disagreement with the shipped labels is under ~10%, label noise is not the
binding constraint — say so, and the 0.73 ceiling stands as real headroom. If
it exceeds ~30% and concentrates on the muted strums and the room-mic path,
the ceiling is substantially annotation noise: log a decision that
threshold-tuning against those specific rows is unfounded, and grade Task 2
against the consensus subset as well as the full set.

**This task never edits `fixtures/labels/`.** If the measurement suggests
specific labels are wrong, list them in the findings write-up as proposals —
the eval already emits `.cache/proposed-label-corrections.json`; compare
against it — and leave the decision to the maintainer.

---

## 2. Task 2 — The millisecond click witness

**The hypothesis.** A pick striking a string produces a broadband click 1–5ms
long. Every existing witness measures it after dilution into a 23ms window on
a 12ms grid — a 5–20x smearing of the most discriminative moment. The human
ear, which resolves envelopes at sub-millisecond scale in its high-frequency
channels, plausibly separates "pick" from "sustain churn" by temporal
**compactness**, which no amount of churn, beating, or compressor pumping can
fake: churn is spread in time, a click is not. This is the one physical cue
in the corpus no experiment has yet touched.

**Method — measure first, engine untouched.** Follow the pattern of
`scripts/measure-whitening-separability.ts`: a standalone pass over the audio,
joined to the unchanged decision table by hop timestamp, so the row population
is identical to the baseline study's and every AUC is comparable to 0.728.

Per candidate hop, over the raw samples of the last ~120ms:

1. Causal bandpass ~2–8kHz (hand-rolled biquad cascade; no npm imports even
   in scripts if the filter is destined for the engine — put it in
   `src/engine/kernels/` from the start with its own unit test).
2. Rectify and smooth to a fine envelope at 0.5–1ms resolution (22–44 samples
   at 44.1kHz).
3. Candidate witnesses, all level-free by construction:
   - **peak-to-surround**: envelope peak in the hop's ±10ms, divided by the
     median of a surrounding ring (see the window rule below);
   - **compact duration**: time the envelope stays above half that peak —
     a click is short, churn is long;
   - **rise slope**: peak over the envelope 3ms earlier;
   - **local kurtosis** of the fine envelope in ±20ms;
   - each also in a whitened form where sensible — DECISION-014 established
     that un-whitened LOTO numbers understate every candidate.

**The window rule, applied before trusting anything.** A sixteenth at 140bpm
is **107ms**. Four separate measurement bugs in this repo came from windows
wider than the event spacing. The surround ring must therefore live inside
±53ms of the candidate (suggested: 8–45ms each side, excluding the click
itself), and the scoring script must assert that no ring overlaps an adjacent
label on the sixteenths takes. State the windows chosen and this check's
result explicitly in the write-up.

**Named traps.**

- **Room-mic hiss** carries 0.20–0.43 of magnitude above 12kHz and has killed
  every high-frequency ENERGY feature here. Compactness should be immune —
  hiss is stationary — but that is a claim to verify, not assume: report the
  witness AUCs per signal path, and if the room-mic path wins or loses purely
  on its noise floor, the witness is measuring the rig.
- **Amp-sim compression** attacks in ~1–10ms and can shave the click. The
  amp-sim path is the worst performer on both axes; if compactness dies only
  there, report it per-path rather than averaging it away.
- **Alignment**: the click's true time is sub-hop; when joining to decision
  rows, search the fine envelope inside the hop's full ±12ms, not at the grid
  point alone.

**Falsifier, stated before the run.** The best single compactness witness
must clear **0.73 AUC** on the derivation decision rows (and if Task 1
produced a consensus subset, also on that subset), and must not collapse on
the room-mic path specifically. Below the bar: write it up, close the line
(DECISION-0xx), stop — do not stack rescue variants beyond the listed set.

**If it survives:** wire it causally — the fast lane already reads raw
samples from the ring each hop, so the fine envelope of the last hop is
available at decision time — expose it as a new field on `AttackEvidence`,
fuse at the DECISION level (an independently-thresholded witness in
`RearticulationDetector.verdict`, threshold derived on the five 120bpm takes
only; per Holzapfel, decision fusion, never a refit of all witnesses — the
0.808→0.434 collapse is what feature-level fusion does here). Then the full
bar: ledger and splits, both axes, per signal path, against 32 / 99 / 107.

---

## 3. Task 3 — The tracker bookkeeping harvest

**Why this is worth a day even with no new feature.** The kernel sees 372 of
381 held-out labels; the ledger says most of the 32 misses die in
*bookkeeping* after the evidence arrived. The baseline cause table
(`measure-downstream-ledger.ts --all`):

| cause | count | where |
|---|---|---|
| too young to be ended | 8 | `note-tracker.ts` `settled`: soundedMs < minStableMs |
| split made; successor paired with a neighbouring label | 8 | the split happened; its Note took the label either side |
| no transient within the window | 4 | the kernel genuinely never fired (real detection losses) |
| absorbed, then paired with a neighbouring label | 3 | absorption/attribution |
| never announced | 2 | `end()`: soundedMs < announceThreshold |
| rejected: no-energy-not-sharp | 2 | `rearticulation.ts` final branch |
| absorbed, then never announced | 2 | absorption/attribution |
| gated / band-only / neighbour's boundary | 3 | assorted |

Roughly 23 of 32 are attribution and timing, not evidence. The matching
`split-pairing` entries also generate extra Notes, so a fix here can move BOTH
axes in the right direction — the only shape of change this project accepts.

**How to work it.** One cause at a time, smallest diff first:

1. Reproduce: pick the individual labels behind one cause (the ledger names
   fixture and time), trace the exact decision sequence with
   `trackerTrace`, and write down — before changing anything — what different
   bookkeeping would have paired the stroke correctly and what it would have
   done to the neighbouring strokes.
2. **Read the prior art first**; several of these have been attempted and the
   attempts are documented with the numbers that killed them:
   `docs/DETECTION-FINDINGS.md` §"The `settled` bar is two milliseconds off,
   and closing it costs more than it buys", §"one onset, two readings"
   (built, measured, NOT kept — twice), §"Where the remaining evidence-side
   losses actually are", §"A same-pitch boundary the next attack contradicts:
   built, measured, reverted". Do not re-run a documented failure unchanged.
3. Candidate directions the findings leave open (verify against the current
   code before believing this list): the *pairing* step, not the split — a
   split whose boundary is off by one hop pairs with the wrong label even
   though both Notes exist, so matching/backdating tolerance at the point the
   successor inherits its `startTime` may be repairable without touching any
   detection bar; the absorption paths ("absorbed, then …", 5 labels) where
   the fragment was real and the absorber took credit at the wrong time; and
   the announce threshold interacting with `too young` on 107ms strokes. If
   Task 2's click witness survived, its sub-hop localization is the natural
   input for boundary placement.
4. **Per-change bar, stated in advance:** each tracker change must strictly
   improve at least one axis on the full corpus and be no worse on the other,
   with `npm run eval` still PASS and all tests green — otherwise revert that
   change and record it. No constants tuned on held-out takes; if a change
   needs a constant, derive it on the five 120bpm fixtures and say how.

Do Task 3 after Task 2's verdict is known, so any boundary-placement work can
use the click if it survived — but do not couple them: every Task 3 change
must stand on its own numbers with Task 2's feature disabled.

---

## 4. Verification bar — before ANY commit

```bash
npx tsc --noEmit && npm test        # all pass, no exceptions
npm run eval                        # PASS, 0 required failures
git diff --stat -- fixtures/        # EMPTY — including from Task 1
```

Then report before/after for **both** axes, per fixture, broken out per
signal chain (DI / room mic / amp sim):

```bash
npx tsx scripts/measure-downstream-ledger.ts --all   # MISSED, baseline 32
npx tsx scripts/measure-splits.ts                    # baseline 99 split / 107 extras / 10 strays
```

Misses down at the cost of extras is **not** a win; both numbers count. A net
loss is a finding, not a commit: write it into `docs/DETECTION-FINDINGS.md`
and report it. Log every accepted or rejected direction in `DECISION_LOG.md`
(continuing from DECISION-016). Commit and push everything, including
negative results and the Task 1 listening kit scripts.

---

## 5. Sources

- Dixon, *Onset Detection Revisited*, DAFx-06 (annotation variance) — https://www.dafx.de/paper-archive/2006/papers/p_133.pdf
- *Annotation of Soft Onsets in String Ensemble Recordings* (24-annotator agreement study) — https://arxiv.org/abs/2211.08848
- *On the Importance of Temporally Precise Onset Annotations for Real-Time MIR* (AG-PT-set) — https://dl.acm.org/doi/fullHtml/10.1145/3678299.3678325
- Holzapfel et al., *Three Dimensions of Pitched Instrument Onset Detection*, IEEE TASLP 2010 (decision-level fusion; phase-slope precision on soft onsets) — https://www.csd.uoc.gr/~hannover/MMILab-Andre_files/HolzapfelIEEEOnset.pdf
- Böck & Widmer, *Local Group Delay Based Vibrato and Tremolo Suppression*, ISMIR 2013 — https://archives.ismir.net/ismir2013/paper/000175.pdf
- *Chirp Group Delay based Onset Detection in Instruments with Fast Attack* (2024) — https://arxiv.org/abs/2408.13734
- Klapuri, *Sound Onset Detection by Applying Psychoacoustic Knowledge*, ICASSP 1999 — the band-wise relative-difference framing behind the compactness idea
- This repo: `docs/DETECTION-FINDINGS.md` final section; `DECISION_LOG.md` 009–015; `docs/onset-features-prompt.md` for the method this brief continues
