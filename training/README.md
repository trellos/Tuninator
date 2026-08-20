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
