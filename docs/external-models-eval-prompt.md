# Brief: evaluate three external models as boundary witnesses, one subagent each

> **STATUS: RUN (2026-09-25)** on `claude/fervent-noether-158e0t`.
> - `MuScriptor/muscriptor-small` stopped at Phase 1 on its licence gate and on
>   PyPI, which the environment refuses (DECISION-086). It reopens only if the
>   owner lifts both.
> - `cstr/hft-transformer-GGUF` ran through Phase 3 and is rejected
>   (DECISION-087).
> - `spotify/basic-pitch` ran through Phase 3: its ghost reading cleared, and
>   no gate on it won end to end (DECISION-088).
>
> Findings are in `docs/DETECTION-FINDINGS.md`, one-paragraph verdicts in
> `docs/external-models-log.md`, ledger rows C31–C33 in
> `docs/slow-note-splits-loop-log.md`, and the code in `training/muscriptor/`,
> `training/hft-transformer/` and `training/basic-pitch/`. **Do not re-run it
> for these three models**: the held-out read is spent for two of them. It is
> kept as the record of what was asked and what the bars were, and it can
> serve as a template for other models.

You are the ORCHESTRATOR. Read `AGENTS.md` in full, then
`docs/external-models-log.md` and the section "A published guitar model read
as a boundary witness" in `docs/DETECTION-FINDINGS.md` (DECISION-085). That
entry is the worked example of this evaluation: follow its shape.

Run the same evaluation on each of these models, one subagent per model, in
parallel:

1. https://huggingface.co/spotify/basic-pitch
2. https://huggingface.co/cstr/hft-transformer-GGUF
3. https://huggingface.co/MuScriptor/muscriptor-small

## The question each subagent answers

Tuninator's remaining errors are about note boundaries, not pitch:

- SPLITS: one played note emitted as two or more Notes (`scripts/measure-splits.ts`)
- GHOSTS: Notes with no label behind them (extras and false positives in `npm run eval`)
- LOST FAST NOTES: 140bpm sixteenths the onset kernel sees and the tracker
  absorbs, ends too young or merges (`scripts/measure-downstream-ledger.ts --all`)

Does this model carry boundary information the engine's witnesses lack,
everywhere or in conditions that can be named? Pitch accuracy is secondary.

## Phase 1: the gate. Stop here if the answer is "no"

1. Get the model and its source repository. Record, briefly: architecture,
   parameter count, input (sample rate, window, hop), training data, licence,
   runtime.
2. THE DECIDING FACT, read from the model's source and training targets, not
   its README: what does it output over time? (a) onset activations, (b)
   per-frame pitch including "no note", (c) one label per clip. Record the
   time resolution of the TARGET each output was trained on, not just the
   hop. It must also answer promptly: a model that is real time but blurs a
   second of audio into each answer fails. A sixteenth at 140bpm is 107ms. If
   the output is (c), or its target is coarser than about 50ms, report that
   and stop.
3. Reproduce the model's own advertised example, so we know it runs correctly.
4. Flag any overlap between its training data and GuitarSet or our fixtures.

## Phase 2: only for a model that passed Phase 1

State every bar in writing before running anything. Use the targets
DECISION-032 requires: OUTCOME-shaped questions ("is this emitted Note
surplus?") for splits and ghosts, BOUNDARY-shaped questions ("should this cut
have been made?") for segmentation. Take the rows from the engine's own trace
and outputs, the way `scripts/measure-decision-separability.ts` and
`scripts/measure-rate-relative-merge.ts` do. Read the model on the same audio:
only audio up to the decision point for a fast-lane decision (causal), or the
deep lane's ring window for a deep-lane one. Derivation takes only.

- Q1 GHOSTS: over emitted Notes, matched vs extra, does the model's "a note is
  sounding" confidence (or its pitch agreeing with the Note) separate them?
  Bar: AUC ≥ 0.80.
- Q2 SPLITS, pitch unchanged: across each cut between two same-pitch Notes,
  does the model say one continuous note or a new articulation? Bar: beat
  0.698 AUC as a boundary witness, AND add information on top of
  DECISION-030's rate gate (report a conditional AUC on the rows the gate lets
  through, not the raw AUC).
- Q3 LOST FAST NOTES: for each missed label in the ledger, does the model see a
  distinct note in that label's span where the tracker absorbed or ended it?
  Count per ledger branch. Bar: at least half the misses in some branch, with
  a false-alarm rate on matched labels stated in advance.
- Q4 (secondary) PITCH: exact vs pitch-class accuracy against the deep lane on
  identical windows, by signal path, single note vs chord, and register.

Always show the 2×2 agreement table (only model right / only engine right /
both / neither) by signal path. Check every window against 107ms.

Read the held-out 140bpm takes ONCE, only after the bars and subsets are fixed,
and label that section as held-out.

## Phase 3: end to end, only for a question that cleared its bar

Precompute the model's readings per take. In a dev-only harness, gate the
matching tracker decision on them. Report `npm run eval`,
`measure-downstream-ledger.ts --all` and `measure-splits.ts` (overall and
`--subset=slow`) before and after. Missed labels and extra Notes both count; a
gain on one paid for on the other is a finding, not a win. Do not commit the
switch to `src/`.

## Rules for the subagents

- Model code goes under `training/<model-name>/`, never imported by `src/**`.
  Scripts get header comments like the existing `measure-*.ts` files and pin
  every download (revision hash and SHA-256).
- Never edit `fixtures/labels/**` or `fixtures/eval.config.json`. Never use
  `git stash`.
- A subagent does NOT edit `DECISION_LOG.md`, `docs/external-models-log.md`,
  `docs/DETECTION-FINDINGS.md` or `docs/slow-note-splits-loop-log.md`. It
  returns its write-up to the orchestrator as text: the Phase 1 facts, each
  falsifier, the numbers, a verdict per question, and one plain-language
  paragraph in the style of the solitito entry in
  `docs/external-models-log.md`.
- If a host is blocked, stop and report which one. Do not route around it.
- A clean negative is a result.

## What the orchestrator does

1. Spawn the three subagents in parallel, each with this brief and its one
   model URL.
2. When all three return, write the shared files yourself, one model at a time,
   so decision IDs do not collide:
   - one paragraph per model in `docs/external-models-log.md`;
   - one findings section per model in `docs/DETECTION-FINDINGS.md`;
   - one ledger row per model in `docs/slow-note-splits-loop-log.md`
     (continuing from C30);
   - one `DECISION_LOG.md` entry per model in the `AGENTS.md` §6 schema,
     numbered from the next free ID.
3. If any model won anything: say what shipping it would take (at most about
   25,000 parameters in plain TypeScript), or which feature the engine's own
   kernels should compute instead.
4. Commit and push to your branch; don't open a PR unless asked. Finish with a
   short summary for the owner: per model, one or two sentences on why it does
   or does not help. No model trivia.

## Environment

Needs huggingface.co and its LFS/CDN host `us.aws.cdn.hf.co`, the models'
GitHub repositories, PyPI, and `registry.npmjs.org` (so `npm ci` can finish
and the measurement scripts run).
