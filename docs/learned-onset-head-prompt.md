# Task prompt: a tiny learned onset head, trained on external data, shipped as plain TypeScript

Self-contained brief for a fresh session on `trellos/Tuninator`. Everything
needed is here — do not assume any prior conversation. Read `AGENTS.md` in
full and the final section of `docs/DETECTION-FINDINGS.md` ("Three candidate
features from the onset literature, measured to their verdicts") before the
first edit.

A companion brief, `docs/ceiling-click-tracker-prompt.md`, is being run in a
SEPARATE session. Do not do its work here, do not assume its results exist,
and expect its session to be pushing to the same repository — do **not** use
`git stash` (repo-wide across worktrees; it has destroyed concurrent work
here before), and rebase onto `main` rather than force-pushing shared refs.

---

## 0. Orientation

Work from the latest `main`. Develop and push on the branch your session
designates.

```bash
npm install
npx tsc --noEmit && npm test        # 494 tests
npm run eval                        # PASS expected, 0 required failures; 16/17 fixtures
npx tsx scripts/measure-downstream-ledger.ts --all    # missed labels, baseline 32
npx tsx scripts/measure-splits.ts                     # baseline 99 split / 107 extras / 10 strays
npx tsx scripts/measure-decision-separability.ts      # the witness AUC study (0.728 best single)
```

**Baseline any change must beat: 32 missed / 99 events split, 107 extra
Notes.** Both axes count; trading one for the other is a finding, not a
commit.

### Step zero, before any other work: amend the constraint, on the record

`AGENTS.md` §4 currently reads "No npm runtime dependencies, no
neural-network runtime." The project owner has approved amending it for this
work. Make the amendment first, in its own commit, and log it as the next
`DECISION_LOG.md` entry (continue from the highest number present; the
companion session appends to the same log, so fetch `main` before pushing and
renumber if your number was taken; state "approved by project owner" in the
Owner/Context fields):

> **No npm runtime dependencies.** A learned component is shippable only as
> fixed weights (≤ ~25,000 parameters) executed by plain TypeScript over
> `Float32Array` inside `src/engine/**` — no runtime dependency, no dynamic
> loading, no training at runtime. The training pipeline lives outside the
> shipped library (`training/`), may use any tooling, and is never imported
> by `src/**`. A trained model larger than this, or one requiring a runtime,
> remains out of bounds.

If anything in this brief conflicts with a fresher `AGENTS.md` on `main`,
the repo wins.

### Invariants that do NOT change

- **`src/engine/**` imports nothing outside itself and `src/types.ts`** —
  the isolation test must keep passing with the inference code in place.
- **`fixtures/labels/**` and `fixtures/eval.config.json` are read-only.**
- **The twelve 140bpm held-out takes are scored, never fitted, and now also
  NEVER TRAINED OR VALIDATED ON.** They must not appear in any training set,
  validation split, early-stopping criterion, or hyperparameter choice. The
  five 120bpm derivation takes may inform threshold calibration only, as
  always. External datasets are where the training data comes from.
- Causal: at decision time the model sees past audio only.
- Determinism: same audio in, same Notes out, offline and live.
- No AI or model identifiers in commit messages, code comments, or any pushed
  artifact.
- State falsifiers before measuring; report negatives plainly.

---

## 1. Why this, and why now

The same-pitch re-articulation decision — "was the string picked again, or is
this the decay of what is already sounding?" — has a measured ceiling under
everything hand-built: best single witness 0.728 AUC, a fitted twelve-witness
logistic collapsing 0.808 in-sample → 0.434 leave-one-take-out, and eight
closed directions including three literature features measured in the
previous pass (`DECISION_LOG.md` 009–015).

The decisive number is the collapse. It does not say the witnesses carry no
information; it says **78 derivation events cannot support fitting
anything**. The field hit this exact wall — repeated same-pitch notes,
shared harmonics, insufficient magnitude increase — and its standing answer
is a small learned function trained on large external labelled corpora:

- Spotify **Basic Pitch** (ICASSP 2022): ~17K parameters, CQT at 3
  bins/semitone with harmonic stacking, ~11ms hop (nearly this engine's
  12ms), note F₅₀ ≈ 79 on GuitarSet — competitive with far larger models,
  and it runs comfortably in real time on CPU (the NeuralNote audio plugin
  ships it).
- This project's engine already achieves comparable framewise machinery
  (whitened spectra, YIN, chroma); what it lacks is exactly the learned
  *decision*, because it had no data to learn from.

The unlock is data, not architecture: **GuitarSet** (360 excerpts, ~3 hours,
six players, comping and soloing, per-string note annotations derived from
hexaphonic pickups) and **EGDB** (electric guitar DI recordings with
annotations, plus re-amped renderings) contain thousands of labelled
same-pitch re-articulations against sustained context — the exact decision
this project has 78 examples of.

**Scope discipline:** this brief replaces nothing. The engine, tracker, and
all existing witnesses stay. The deliverable is one learned scoring function
for the re-articulation decision (and, if it earns it, the onset accept
path), fused at the decision level like any other witness.

---

## 2. Environment check (do this before designing anything)

The container's network egress is policy-controlled. Verify early:

```bash
curl -sSI https://zenodo.org/records/3371780 | head -3          # GuitarSet home (audio ~10GB total; annotations much smaller)
curl -sSI https://github.com/spotify/basic-pitch | head -3
python3 --version; pip3 --version
df -h .                                                          # disk allowance — plan the download budget
```

GuitarSet's `annotation/` archive and `audio_mono-mic` / `audio_hex-pickup`
archives are separate downloads — you likely need only `annotation` plus ONE
audio flavour (start with `audio_mono-mic`; add the debleeded hex or the
pickup mix only if needed). EGDB is linked from its paper ("Towards Automatic
Transcription of Polyphonic Electric Guitar Music", 2022); locate the current
official host before downloading. If the network policy blocks the datasets,
**stop and report** — say exactly which URLs were blocked so the owner can
enable them — and do not substitute synthetic training data; a model fitted
to synthesis is how this project would quietly re-enter the take-scale trap.

Python with numpy (and torch if available; plain numpy SGD is acceptable at
this parameter count) is for `training/` only. Nothing under `src/` may
import from it, reference it, or need it at runtime.

## 3. Method

### 3.1 Build the training population by running THIS engine over the external audio

The decisive lesson from the cycle-dissimilarity failure (DECISION-015): a
feature that separates "onset vs steady decay" in the abstract can be at
chance on the real decision population, because every row there is a moment
an energy witness ALREADY fired. Train on the same population you will
decide on:

1. Drive the actual `RecognitionEngine` (via `src/offline/analyzer.ts` and
   the `trackerTrace` hook — the same machinery
   `scripts/measure-decision-separability.ts` uses) over each external
   recording.
2. Every `rearticulation` trace event is one training row; label it positive
   iff the dataset's ground truth has a note onset within 70ms not already
   covered by an open Note — port the exact target rule from
   `measure-decision-separability.ts` (`collect()`), including its
   trace-order covered-check, rather than reinventing it.
3. Keep, per row: the twelve existing witnesses, and a small local
   time-frequency patch as the learned input (below).

Expect and record a yield figure: how many decision rows per hour of
external audio, and the positive rate, compared to this corpus's (the
baseline study has 725 rows / 369 positives over ~17 minutes).

### 3.2 Domain gap, named and handled

GuitarSet is ACOUSTIC guitar with a mono mic; this corpus is electric —
DI, amp sim, room mic. EGDB is electric DI. Handle it, don't hope:

- Prefer EGDB DI as the closest-domain core; use GuitarSet for volume.
- Augment offline: convolve/EQ/compress GuitarSet-and-EGDB audio through a
  few amp-sim-like chains and mild room IRs, at varied gains, BEFORE feature
  extraction, so the model sees the three signal-path families this corpus
  contains. (Precedent: the 2024 "High Resolution Guitar Transcription via
  Domain Adaptation" line.) Keep augmentation code in `training/`.
- The per-bin adaptive whitening measured in DECISION-014
  (`scripts/measure-whitening-separability.ts`, m=0.99, floor=0.01) exists
  precisely to eat level/roll-off differences: whiten the model's
  spectrogram input with the same causal recurrence the engine can run live.

### 3.3 The model

Input per decision: the whitened magnitude patch around the decision hop —
suggested 9 hops (~100ms; check the 107ms sixteenth spacing before widening;
causal: the patch ends AT the decision hop, no future frames) × a reduced
frequency axis (log-spaced ~60 bands or harmonically stacked bins per Basic
Pitch), plus the twelve existing witnesses and the whitened flux readings as
scalar side inputs. Architecture: small — one or two conv layers over the
patch + a dense head merging the scalars, **≤ 25K parameters total**, sigmoid
output. Resist making it bigger before the falsifier says the small one
fails; the whole bet is that the DATA, not capacity, was the constraint.

Training: standard supervised fit in `training/` with a **grouped** split —
all rows from one performer/progression stay on one side, mirroring
leave-one-take-out; early-stop on the external validation groups; the five
derivation takes may be an additional validation curve but nothing from the
twelve held-out takes is ever loaded. Class imbalance: weight or subsample,
report base rates.

### 3.4 Ship it

- Export weights to a generated TypeScript module of `Float32Array`
  literals (a `training/export-weights.ts`-style codegen), checked in, with
  the training-run hash and dataset manifest in a comment-free adjacent JSON
  so provenance survives without violating the no-identifiers rule.
- Implement inference in `src/engine/` as plain loops (conv as matmul is
  fine at this size); unit-test it against saved reference activations from
  the trainer on a handful of fixed inputs (tolerance ~1e-5).
- Budget check: at ~83 decisions/second worst case, a 25K-parameter forward
  pass is microseconds; still, measure and record it.
- Fuse at the DECISION level: the learned score enters
  `RearticulationDetector.verdict` as an independently thresholded witness
  (threshold derived on the five 120bpm takes only), not as a replacement
  for the existing cascade — Holzapfel-style decision fusion, and the
  reasons stay named for the ledger.

## 4. Falsifiers, stated before the run

1. **Ranking:** the learned score must clear **0.73 AUC** (the best existing
   single witness) on THIS repo's derivation decision table, model frozen,
   nothing tuned on those rows. If it cannot, the external-data bet failed —
   write it up, log the decision, stop.
2. **Generalisation shape:** its leave-one-take-out AUC on the derivation
   table must be materially above the 0.434 collapse and not far below its
   own in-sample number (the whitened-feature study's 0.723 → 0.608 profile
   is the shape to beat).
3. **The ledger, which is the only bar that matters:** wired at decision
   level with a derivation-derived threshold, the full corpus must come out
   **strictly better on at least one axis and no worse on the other** versus
   32 missed / 107 extras, per-path breakdown included, eval still PASS.
   Score the twelve held-out takes ONCE, at the end, after the model and
   threshold are frozen — treat that read as spent thereafter.

A model that wins on external validation and fails falsifier 3 is a finding:
report which rows it loses and why (the ledger names them), do not iterate
against the held-out takes to fix it. Iterate against external data and the
derivation five only.

## 5. Verification bar — before ANY commit

```bash
npx tsc --noEmit && npm test        # includes the engine-isolation test, with inference code in place
npm run eval                        # PASS, 0 required failures
git diff --stat -- fixtures/        # EMPTY
```

Report before/after on both axes, per fixture, per signal chain:

```bash
npx tsx scripts/measure-downstream-ledger.ts --all
npx tsx scripts/measure-splits.ts
```

Also verify: no `training/` import reachable from `src/**`; `npm pack`
contents unchanged except intended engine files; the weights module's size
noted in the write-up. Document the outcome — win or negative — in
`docs/DETECTION-FINDINGS.md`, log decisions in `DECISION_LOG.md`, commit and
push, including the full `training/` pipeline so the run is reproducible.

## 6. Sources

- Bittner et al., *A Lightweight Instrument-Agnostic Model for Polyphonic
  Note Transcription and Multipitch Estimation* (Basic Pitch), ICASSP 2022 —
  https://arxiv.org/abs/2203.09893 · code https://github.com/spotify/basic-pitch
  · engineering post https://engineering.atspotify.com/2022/6/meet-basic-pitch
- NeuralNote (Basic Pitch real-time in a plugin; CPU feasibility proof) —
  https://github.com/DamRsn/NeuralNote
- Xi et al., *GuitarSet: A Dataset for Guitar Transcription*, ISMIR 2018 —
  https://ismir2018.ircam.fr/doc/pdfs/188_Paper.pdf · data
  https://zenodo.org/records/3371780 · loader docs
  https://mirdata.readthedocs.io/en/stable/source/mirdata.html
- Chen et al., *Towards Automatic Transcription of Polyphonic Electric
  Guitar Music: A New Dataset (EGDB) and a Multi-Loss Transformer*, 2022 —
  https://arxiv.org/abs/2202.09907
- *High Resolution Guitar Transcription via Domain Adaptation*, 2024 —
  https://arxiv.org/abs/2402.15258 (the GuitarSet comparison table: Basic
  Pitch 79.0 note-F, MT3 ≈ 90)
- Holzapfel et al., *Three Dimensions of Pitched Instrument Onset
  Detection*, IEEE TASLP 2010 (decision-level fusion) —
  https://www.csd.uoc.gr/~hannover/MMILab-Andre_files/HolzapfelIEEEOnset.pdf
- This repo: `docs/DETECTION-FINDINGS.md` (final section);
  `DECISION_LOG.md` 009–015; `scripts/measure-decision-separability.ts`
  (the target rule to port); `scripts/measure-whitening-separability.ts`
  (the whitening recurrence and its constants)
