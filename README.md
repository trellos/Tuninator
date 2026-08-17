# Tuninator

A UI-free browser library that turns guitar microphone input into two streams:

- **`pitchFrame`** — a low-level continuous stream, one frame every ~12ms, suitable for building
  a tuner.
- **`MusicEvent`** — a higher-level stream of notes and chords with start/update/end lifecycles,
  suitable for games, practice tools, and scoring.

ESM, TypeScript, zero runtime dependencies. Detection runs in an `AudioWorklet`, off the main
thread.

The detector is graded against **recorded guitar**, not synthetic sine waves. `npm run eval`
decodes four labelled fixtures, runs the real detection chain over them, and fails loudly on
regression. See [Evaluation](#evaluation) for the actual numbers.

## Install

```bash
npm install tuninator
```

## Worklet asset setup — read this first

This is the #1 integration failure mode.

Tuninator's detector runs inside an `AudioWorklet`, and `AudioWorklet.addModule()` needs a **URL
your server actually serves**. The library ships that file as a prebuilt, self-contained bundle:

```
node_modules/tuninator/dist/tuninator-worklet.js
```

Copy it into your static assets and pass its URL as `workletUrl`:

```bash
cp node_modules/tuninator/dist/tuninator-worklet.js public/assets/
```

```ts
const tuninator = createTuninator({
  workletUrl: "/assets/tuninator-worklet.js",
});
```

Bundlers do not copy this file for you, because it is loaded at runtime by URL rather than
imported. If `workletUrl` is omitted the library falls back to resolving the asset next to its
own `dist/index.js`, which works only when the package is served unbundled.

A wrong or missing URL surfaces as a `worklet-load-failed` error event rather than an exception,
so handle the `error` event and you will see it immediately.

The bundle is deliberately a single file with **no `import`/`export` statements** —
`AudioWorkletGlobalScope` has no module loader on older targets. The build asserts this
(`scripts/assert-worklet-bundle.mjs`) so a stray import cannot reach a release.

## Usage

```ts
import { createTuninator } from "tuninator";

const tuninator = createTuninator({
  mode: "lead",
  workletUrl: "/assets/tuninator-worklet.js",
});

tuninator.on("stateChange", (state) => console.log("state:", state));
tuninator.on("error", (error) => console.error(error.code, error.message));

// Continuous stream — build a tuner on this.
tuninator.on("pitchFrame", (frame) => {
  if (frame.frequencyHz === null) return;
  console.log(frame.nearest!.name, frame.nearest!.cents.toFixed(1), "cents");
});

// Musical interpretation — build a game or practice tool on this.
tuninator.on("musicEventStart", (event) => console.log("start", event.label.name));
tuninator.on("musicEventEnd", (event) => console.log("end", event.label.name));

// Must be called from a user gesture: the browser will not open a microphone
// or resume an AudioContext without one.
await tuninator.start();
```

`on()` returns its own unsubscribe function:

```ts
const off = tuninator.on("pitchFrame", handler);
off();
```

## Modes

`setMode()` is safe to call while listening — it swaps the detection policy and posts it to the
worklet without restarting the audio graph. Modes change detection *policy*, never the event
model, so a consumer written against `MusicEvent` keeps working in all four.

| Mode | Behaviour |
|---|---|
| `lead` | Monophonic, high stability requirement, chord detection off. The default. |
| `chords` | Chroma path primary, longer stability windows, polyphony estimate populated. |
| `rhythm` | Onset-driven; emits events on attacks even when pitch is uncertain (`kind: "unknown"`). |
| `raw` | Minimal interpretation, tiny stability window — close to a passthrough of frames to events. |

## API

The full type surface lives in [`src/types.ts`](src/types.ts). The shapes worth knowing:

### `PitchFrame`

One analysis hop, emitted continuously while listening — **including during silence**, with
`frequencyHz: null`. That continuity is what a tuner UI needs.

```ts
{
  timestamp: number;              // ms, monotonic, comparable with MusicEvent times
  frequencyHz: number | null;     // null when gated or unvoiced
  confidence: number;             // 0..1
  nearest: PitchNote | null;      // snapped to the nearest equal-tempered note
  amplitude: { rms: number; peak?: number };
  detector: {                     // internals, exposed for debugging and eval
    tau?: number | null;
    cmnd?: number | null;
    zeroCrossingHz?: number | null;
    effectiveSampleRate?: number | null;
  };
}
```

### `MusicEvent`

A musical interpretation spanning many frames. Notes and chords are both `MusicEvent`s; a
consumer that only cares about notes can ignore `kind !== "note"`.

State machine: `attack` → `sustain` → (`bend`) → `release` → `ended`.

Three behaviours worth relying on:

- **A re-picked note is two events.** An onset forces a new event even when the pitch has not
  changed, so a repeated note does not read as one long sustain.
- **A legato pitch step is also two events.** In a fast run the pick never re-attacks, so onset
  detection alone would merge the notes.
- **A bend is ONE event.** `label.name` keeps the origin note and `bend` records the excursion:
  `isActive`, `centsFromStart`, `semitonesFromStart`. A note bent from A3 up to B3 is a single
  event labelled `A3` with `bend.centsFromStart ≈ 200`, never two events.

Total displacement cannot distinguish a 200-cent bend from a 200-cent legato step — both are two
semitones. The discriminator is the per-hop rate: a bend glides through the intermediate cents
over tens of frames, a fretted step jumps within one or two.

### Chords, and honest abstention

Chord detection reports `label.name: "unknown"` rather than a confident wrong label. When the top
two template candidates are within `margin` of each other, or the best score is below `floor`, the
event is labelled `unknown` and the candidates are surfaced in `ambiguity.alternatives`.

This is a deliberate product guarantee, not a limitation. Extended voicings share most of their
chroma with simpler chords — `Cmaj9` (C E G B D) contains `Em`, `G`, and `C`; `Am11` (A C D E G)
contains `Am7`, `C6`, and `Dsus` — so on a strummed guitar an honest `unknown` is the correct
answer far more often than a coin-flip between them.

### Errors

Failures set the state to `error` and emit an `error` event with a `TuninatorErrorCode`:

| Code | Cause |
|---|---|
| `mic-permission-denied` | The user denied microphone access (`NotAllowedError`). |
| `mic-unavailable` | No usable microphone (`NotFoundError`, `NotReadableError`, `OverconstrainedError`). |
| `audio-context-failed` | `AudioContext` could not be created. |
| `worklet-unavailable` | The browser has no `AudioWorklet` support. |
| `worklet-load-failed` | `addModule()` rejected — almost always a wrong `workletUrl`. |
| `unknown` | Anything else, including a worklet processor crash. |

### Options and defaults

```ts
createTuninator({
  mode: "lead",
  workletUrl: "/assets/tuninator-worklet.js",
  input:    { deviceId, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  analysis: { minFrequencyHz: 70, maxFrequencyHz: 1400, pitchHopMs: 12, rmsGate: 0.008, confidenceGate: 0.5 },
  tracking: { minStableMs: 45, releaseGraceMs: 90, bendThresholdCents: 45 },
});
```

| Option | Default | Why |
|---|---|---|
| `analysis.minFrequencyHz` | `70` | Below E2 (82.4Hz), with headroom for flat tuning. |
| `analysis.maxFrequencyHz` | `1400` | Above E6 (1319Hz). |
| `analysis.pitchHopMs` | `12` | ~576 samples at 48kHz. Snapped to whole 128-sample render quanta. |
| `analysis.rmsGate` | `0.008` | Below this the frame is treated as silence. |
| `analysis.confidenceGate` | `0.5` | Below this `frequencyHz` is reported as `null`. |
| `tracking.minStableMs` | `45` | Note identity settles slower than the frame rate. |
| `tracking.releaseGraceMs` | `90` | Survives pick noise and brief dropouts. |
| `tracking.bendThresholdCents` | `45` | Below a semitone, above vibrato. |

The microphone processors default to **off**. `echoCancellation`, `noiseSuppression`, and
`autoGainControl` are tuned for speech and will chew holes in a sustained guitar note.

## Architecture

```
src/core/     the shared DSP kernel — ZERO imports, zero globals, zero DOM
src/worklet/  AudioWorkletProcessor wrapping the kernel
src/offline/  the same kernel, driven from Node for evaluation
```

The load-bearing rule: **`src/core/` must be importable by the browser worklet, by Node, and by
Vitest with byte-identical behaviour.** No `window`, no `AudioContext`, no `performance`, no npm
imports, no top-level side effects — pure functions and classes over `Float32Array`, with sample
rate and timestamps passed in.

The offline evaluation is trustworthy *only* because it runs this exact code. There is no separate
"offline detector"; the eval feeds samples through the same `PitchEngine` and `EventTracker` in the
same 128-sample render quanta the `AudioWorklet` delivers.

### How the detector works

Window and hop are **decoupled**. A ring buffer accumulates input and every hop the detector
analyses the most recent N samples. One period of low E (82.4Hz) is ~582 samples and YIN needs
roughly two, so the long window is 2048 samples (~43ms) even though the hop is 12ms.

A **dual-window** YIN runs every hop — 512 samples and 2048 samples — and the short window wins
whenever it is confident above ~300Hz, where it genuinely spans two periods. This gives ~7×
better time resolution on fast high passages while keeping low notes reliable.

Octave errors are YIN's known failure mode on guitar, so four mitigations stack:

- prefer the *first* CMND dip below threshold, not the global minimum;
- a sub-harmonic check that prefers the higher octave when half the lag is equally periodic;
- an independent zero-crossing estimate — a ~2× disagreement halves confidence, because ZCR fails
  differently than YIN does;
- a temporal median over recent voiced frames, so one bad frame cannot create a spurious event.

Onsets use **spectral flux** (positive half-wave rectified difference of successive magnitude
spectra) with an adaptive median threshold. An RMS envelope alone cannot see a re-picked note at
the same pitch.

## Development

```bash
npm install
npm run build      # library ESM+dts, and dist/tuninator-worklet.js as one self-contained file
npm test           # vitest
npm run typecheck
npm run eval       # decode fixtures, grade the detector, exit nonzero on required failures
```

## Evaluation

<!-- EVAL-NUMBERS -->
*Populated from a real `npm run eval` run — see below.*

## License

MIT
