# training/ — the learned onset head's pipeline

Everything here is dev-side tooling: **nothing under `src/` imports from this
directory**, and the engine-isolation test keeps it that way. What ships is a
generated weights module of `Float32Array` literals inside `src/engine/`
(≤ ~25,000 parameters, per the amended AGENTS.md §4 constraint and
DECISION-016), executed by plain TypeScript.

## Why this exists

The same-pitch re-articulation decision has a measured ceiling under
everything hand-built (best single witness 0.728 AUC; a fitted twelve-witness
logistic collapses 0.808 → 0.434 leave-one-take-out; eight closed directions —
`DECISION_LOG.md` 009–015). The collapse means 78 derivation events cannot
support fitting anything. The unlock is data, not architecture: GuitarSet
contains thousands of labelled same-pitch re-articulations against sustained
context. See `docs/learned-onset-head-prompt.md` for the full brief and
`docs/DETECTION-FINDINGS.md` for the outcome.

## The population rule

Rows are NOT "onsets vs steady decay in the abstract" — that framing produced
DECISION-015's false start. Rows are the engine's own `rearticulation` trace
events, produced by driving the real `RecognitionEngine` over the external
audio, labelled by the exact target rule of
`scripts/measure-decision-separability.ts` (`collect()`): positive iff a
ground-truth onset begins within 70ms and no already-open Note (accumulated
in trace order) accounts for it.

## Data preparation

GuitarSet (Zenodo record 3371780; Xi et al., ISMIR 2018), the `annotation`,
`audio_mono-mic` and `audio_mono-pickup_mix` archives:

```bash
mkdir -p <root> && cd <root>
for f in annotation.zip audio_mono-mic.zip audio_mono-pickup_mix.zip; do
  curl -O "https://zenodo.org/api/records/3371780/files/$f/content"; done
python3 -m zipfile -e annotation.zip annotation/
python3 -m zipfile -e audio_mono-mic.zip audio_mic/
python3 -m zipfile -e audio_mono-pickup_mix.zip audio_pickup/
mkdir -p wav48/mic wav48/pickup      # 48kHz mono, the fixture pipeline's rate
for f in audio_mic/*.wav;    do b=$(basename "$f" .wav); ffmpeg -i "$f" -ar 48000 -ac 1 -sample_fmt s16 "wav48/mic/${b%_mic}.wav"; done
for f in audio_pickup/*.wav; do b=$(basename "$f" .wav); ffmpeg -i "$f" -ar 48000 -ac 1 -sample_fmt s16 "wav48/pickup/${b%_mix}.wav"; done
```

EGDB was named by the brief as the closest-domain core; its official host
(a Google Drive folder linked from the paper) was unreachable under this
environment's network egress policy, so the pipeline is GuitarSet-only, with
the pickup mix standing in as the DI-adjacent flavour.

## Pipeline

```bash
bun training/extract-rows.ts --data <root> --out training/out/rows
    # engine over 360 takes x {mic,pickup} x {clean,amp,room} -> row shards

bun training/extract-corpus-rows.ts --out training/out/corpus
    # the same row format for THIS repo's decision table (collect(), untouched)

bun training/train.ts --selftest          # finite-difference gradient check
bun training/train.ts --rows training/out/rows --corpus training/out/corpus \
    --out training/out/model
    # grouped split by GuitarSet player (04,05 held out for validation);
    # early stopping reads the external validation AUC only; the corpus rows
    # are loaded with every 140bpm take FILTERED OUT AT LOAD and provide a
    # printed curve, nothing more

bun training/score-falsifiers.ts --model training/out/model
    # falsifiers 1-2, model frozen: the derivation bar is 0.73

bun training/export-weights.ts --model training/out/model
    # codegen: src/engine/kernels/onset-head-weights.ts + provenance JSON.
    # ONLY for a model that passed its falsifiers — the 2026-08 run did not
    # (0.7157 against the 0.73 bar; see docs/DETECTION-FINDINGS.md and
    # DECISION-017), so nothing is currently exported or wired.
```

Features per row: a 9-hop × 60-band causal patch of the adaptively whitened
(m = 0.99, floor = 0.01; DECISION-014) log-band spectrogram ending AT the
decision hop, on the engine's own hop grid; the twelve existing witnesses;
four whitened flux readings. `src/engine/kernels/whitened-bands.ts` computes
the patch on both sides of the fence, so training input and live input are
the same code path.

## Split discipline

- Grouped by player, always. Nothing from a validation player is trained on.
- The five 120bpm derivation takes may calibrate the decision threshold and
  appear as a printed curve; they never influence training or early stopping.
- The twelve 140bpm held-out takes are never loaded by anything in this
  directory. They are scored once, at the end, by the falsifier-3 ledger run,
  and that read is spent.

## Also here

- `solitito-phase1.ts` — the Phase 1 record for `greblus/solitito-ai`
  (DECISION-085): the published model's time resolution, read from its own
  source and DSP kernel at pinned revisions. It needs no weights, touches no
  network and imports nothing from `src/`; its header has the fetch commands.
- `muscriptor/phase1.ts` — the Phase 1 record for
  `MuScriptor/muscriptor-small` (DECISION-086): its token time grid, chunking,
  front end and parameter count, read from its own source at pinned revisions.
  Its weights are gated and were not fetched; the script needs none, touches
  no network, and imports only `DEFAULT_ENGINE_CONFIG` (for the deep lane's
  ring). Its header has the fetch commands, including the sparse checkout that
  keeps the source's own TypeScript out of this repository's typecheck.
- `hft-transformer/` — the full record for `cstr/hft-transformer-GGUF`
  (DECISION-087), Phases 1 to 3.
  - `build.sh` fetches every pinned input and builds CrispASR's CLI and the
    activation reader `hft-read.cpp` with the local toolchain.
  - `read-ckpt.py` and `ckpt-vs-gguf.ts` check the weights against their
    source checkpoint. The first is stdlib Python with a restricted unpickler,
    and it checks the file's SHA-256 before reading it.
  - `phase1.ts` prints the time axis; `phase2.ts` holds the pre-registered
    questions.
  - `phase3.ts`, `phase3-hook.patch` and `phase3-summary.ts` are the end-to-end
    veto. The hook is applied, run and reverted, and never committed to `src/`.
  - Outputs go to `training/out/hft-transformer/`.
- `basic-pitch/` — the full record for `spotify/basic-pitch` (DECISION-088),
  Phases 1 to 3.
  - It is its own npm project: `onnxruntime-node` at an exact version, install
    scripts off. Run `npm ci` inside it; the root `npm ci` does not install it.
  - `runtime.ts` is the one place that runtime is loaded, through a dynamic
    import, so the root typecheck passes without it, as in CI.
  - `phase1.ts` prints the time axis from the pinned source and weights, and
    `parity.ts` reproduces the authors' two published reference outputs.
  - `phase2-rows.ts` and `phase2.ts` hold the pre-registered questions; the
    held-out read is `--heldout`, once.
  - `phase3-*.ts` and `phase3-hook.patch` are the end-to-end gate. The hook is
    applied, run and reverted, and never committed to `src/`.
  - Outputs go to `training/out/basic-pitch/`.
