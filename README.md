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
  channelRms?: number[];          // level of each INPUT channel, before they are mixed
  selectedChannel?: number | null; // channel being analysed; null = summed; absent = unknown
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
  input:    { deviceId, channelCount: 2, channels: "auto", echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  analysis: { minFrequencyHz: 70, maxFrequencyHz: 1400, pitchHopMs: 12, rmsGate: 0.008, confidenceGate: 0.35 },
  tracking: { minStableMs: 45, releaseGraceMs: 90, bendThresholdCents: 45 },
});
```

| Option | Default | Why |
|---|---|---|
| `analysis.minFrequencyHz` | `70` | Below E2 (82.4Hz), with headroom for flat tuning. |
| `analysis.maxFrequencyHz` | `1400` | Above E6 (1319Hz). |
| `analysis.pitchHopMs` | `12` | ~576 samples at 48kHz. Snapped to whole 128-sample render quanta. |
| `analysis.rmsGate` | `0.008` | Below this the frame is treated as silence. |
| `analysis.confidenceGate` | `0.35` | Below this `frequencyHz` is reported as `null`. Measured, not guessed: at `0.5` the detector dropped frames mid-note on decaying low strings, which read as note-offs and split notes in two. |
| `tracking.minStableMs` | `45` | Note identity settles slower than the frame rate. |
| `tracking.releaseGraceMs` | `90` | Survives pick noise and brief dropouts. |
| `tracking.bendThresholdCents` | `45` | Below a semitone, above vibrato. |

The microphone processors default to **off**. `echoCancellation`, `noiseSuppression`, and
`autoGainControl` are tuned for speech and will chew holes in a sustained guitar note.

### Multi-channel interfaces

A 2-in interface is a single **stereo** device to the browser — macOS and Windows both list the
Audient iD4 as one input called "Analogue 1/2". A guitar in input 2 therefore exists only on
channel 1, and nothing on channel 0.

Three things follow, and all three are handled:

- `input.channelCount` defaults to **2**. Chrome opens a capture device in mono unless a channel
  count is asked for, and a channel that never reaches the page cannot be recovered later. It is
  requested as an *ideal* constraint, so a genuinely mono microphone still opens and reports `1`.
- The worklet **selects the loudest channel** rather than reading channel 0 (`input.channels`,
  below).
- `PitchFrame.channelRms` reports the level of each channel *before* they are mixed, so a UI can
  show which input is actually carrying signal. `channelRms.length` is the channel count the
  browser handed over — `1` there means the capture is mono and input 2 never arrived.
- `PitchFrame.selectedChannel` reports which channel is being analysed (`null` when they are
  being summed). This cannot be inferred from `channelRms`: selection is hysteretic, so the
  loudest channel in any single frame is routinely not the selected one.

If a guitar is inaudible to the detector but audible through the interface's own monitoring,
`channelRms` is the thing to look at first: direct monitoring is analogue and proves nothing
about what the browser received.

#### `input.channels` — selection, not summing

| Value | Behaviour |
|---|---|
| `"auto"` *(default)* | Analyse the loudest channel, decided over a window and with hysteresis. Sums until a decision has latched. |
| `"sum"` | Always sum every channel. |
| a number | Always analyse that channel index. Out of range falls back to summing. |

Summing looks like the safe default and is not. Two captures of **one** source — a DI into input 1
and a mic on the cab into input 2, an entirely ordinary rig — are separated by the mic's acoustic
delay, and adding them produces a comb filter: a spectrum with periodic notches. One metre of air
is ~3ms, which is half a period of 166.7Hz, so around E3 the odd harmonics cancel outright and the
strongest remaining periodicity is the second harmonic. The detector then reports E4 for an E3,
confidently, with nothing anywhere looking broken. Selecting one channel cannot do this.

The rules `"auto"` follows, and why:

- **Decided over a window, not per hop.** Per-hop argmax jitters — a 12ms hop lands anywhere in a
  note's attack. Energy accumulates over **250ms** and the decision is taken on the total.
- **Hysteresis.** A challenger must beat the incumbent by **6dB** (a factor of two in amplitude)
  for **3 consecutive windows** — 750ms — before the selection moves. Switching splices two
  uncorrelated waveforms together in the analysis ring buffer, which is a worse input than either
  channel alone, so the bar sits above anything a genuine stereo pair produces and far below an
  unplugged input (30dB or more down). The *first* choice has no margin requirement; only switches
  do.
- **Silence never latches.** Before anyone plays, every channel is noise floor and "loudest" means
  "worse preamp". Windows whose loudest channel is under `analysis.rmsGate` are discarded — they
  neither latch a decision nor challenge one. Until then the channels are **summed**: a sum can be
  a poor signal, but it cannot miss an instrument, which is the right way to be wrong while
  waiting.
- **A latched choice survives silence**, so pauses between phrases do not re-open the question.
- **Mono is a no-op.** One channel, nothing to decide, no per-hop work at all.

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

`npm run eval` decodes the four recorded fixtures in `fixtures/audio/`, runs the real detection
chain over them, matches detected events one-to-one against the hand-written ground truth in
`fixtures/labels/`, and exits nonzero when a fixture marked `required` misses a threshold.

**`npm run eval` currently exits 1.** These are the real numbers, not a target:

| Fixture | Mode | Labels | Detected | Matched | Missed | False pos. | Exact | Pitch class | Onset median |
|---|---|---|---|---|---|---|---|---|---|
| clean-lead-120bpm *(required)* | lead | 43 | 46 | 36 | 7 | 10 | 72.1% | **76.7%** | 103.2ms |
| power-chords *(required)* | chords | 8 | 9 | 8 | 0 | 1 | **75.0%** | 75.0% | 153.3ms |
| cowboy-chords | chords | 8 | 13 | 8 | 0 | 5 | 40.0% | 80.0% | 196.7ms |
| spicy-chords | chords | 3 | 6 | 3 | 0 | 3 | 0.0% | 66.7% | 36.7ms |

Per-section breakdown of the lead fixture, which is where the difficulty lives:

| Section | Notes | Shortest | Pitch range | Pitch class | Onset median |
|---|---|---|---|---|---|
| quarters | 7 | 500ms | 123–220Hz | **100.0%** | 70.0ms |
| triplets | 24 | 166ms | 494–988Hz | 70.8% | 93.7ms |
| sixteenths* | 12 | 125ms | 440–554Hz | 75.0% | 124.2ms |

\* Excluded from the required gate in `fixtures/eval.config.json`, visibly and by configuration.
Its numbers are still reported. No label file was edited to achieve any of this.

### What passes and what does not

**Passing:** onset timing on the gated lead subset (88.5ms median, threshold 100ms); every chord
fixture matched all of its labels with zero misses; the quarter-note section is at 100% pitch
class.

**Failing, honestly:**

- `clean-lead` pitch-class accuracy is **77.4%** on the gated subset against a 90% threshold, and
  produces **9 false positives** against a limit of 3. Both come from the same root cause: fast
  legato runs still over-segment, because separating "one note, re-picked" from "two notes
  slurred" comes down to a flux spike that may not be there.
- `power-chords` exact accuracy is **75%** against 80% — six of eight correct — and its onset
  median is **153ms** against 120ms. Chord onsets are measured against 2s bars of continuous
  strumming with no silence between them, so the detector must segment on chord *change*.
- `spicy-chords` produces **1 confidently wrong label** against a limit of 0.

### Chords abstain rather than guess

Abstention rate — the share of detections that said `unknown` instead of committing:

| Fixture | Abstention | Confidently wrong |
|---|---|---|
| power-chords | 44.4% | 1 |
| spicy-chords | 33.3% | 1 |
| cowboy-chords | 23.1% | 1 |

Abstentions are **not** counted as wrong answers; they are reported separately. The accuracy
denominator is labels in scope minus abstentions, so a detector cannot win by staying quiet on the
hard notes — a missed label still counts against it.

Per-chord, measured across 866 analysis frames of the recorded fixtures — **45.2%
confident-correct, 9.9% confident-wrong, 44.9% `unknown`**:

| Chord | Result |
|---|---|
| A5, E5 | 100%, 97% correct |
| C5, D5, G5 | 81/69%, 78%, 47% correct (G5 abstains 47% of the time) |
| Am, Em, C | 100%, 92/75%, 78/72% correct |
| G | 42% correct, plus 25% read as `G5` |
| **F#5** | **42% correct, but 44% confidently `E5`** |
| **D** | **0% — 92% `unknown` on the first pass, 56% confidently `D5` on the second** |
| Cmaj9 | 100% `unknown` (best score 0.794, margin 0.027 — just inside the abstention rule) |
| Am11 | 90% `unknown`, 10% `Am` (the parent triad) |

Two of these are real defects rather than honest abstention, and are worth knowing about:

- **F#5 is confidently mislabelled `E5`.** Bass detection splits 47/42 between F# and E, and the
  chord label follows whichever the bass picked.
- **D major is never identified.** Its F#4 third — high E string, 2nd fret — decays below the
  peak floor about 250ms in, so the third is genuinely absent from the spectrum and the chord
  reads as `D5` or `unknown`.

The `G → G5` and `Em → E5` confusions share that root cause: guitar voicings sound the third once
while doubling the root and fifth, so a decayed third makes any triad look like a power chord.

`Cmaj9` and `Am11` abstaining is the **expected** outcome, not a defect. The `x32430` voicing
sounds E twice and never sounds G, so the chroma contains neither a root nor a fifth and the bass
is the only evidence for C. Abstaining is the correct answer there.

### The labels are estimates, and the eval says so

The fixture labels state their own uncertainty: *"Octaves are first-pass estimates; pitch-class
intent comes from the player's description."* That is why exact and pitch-class accuracy are
reported **separately** — a large gap between them points at the labels, while a low pitch-class
number points at the detector.

Where the detector confidently disagrees with a label, the evidence is written to
`.cache/proposed-label-corrections.json` rather than applied. The strongest current candidate is
`q1`, labelled `B2`: the detector reads a clean 245.7Hz (`B3`) at confidence 0.89 with a CMND of
0.022, and the independent zero-crossing estimate agrees at 247.8Hz. `B3` is also an open string
in the fixture's stated tuning. That is evidence, not a verdict — **`fixtures/labels/` is
read-only and was never modified.**

### Reproducing and debugging

```bash
npm run eval                              # full run, writes .cache/eval-report.json
npx tsx scripts/eval.ts --trace clean-lead-120bpm   # per-hop CSV of detector internals
```

The trace dumps timestamp, frequency, confidence, rms, `tau`, `cmnd`, `zeroCrossingHz`, and the
onset flag per hop. Every tuned constant in `src/core/policy.ts` was chosen by measuring against
these fixtures, not picked a priori.

## License

MIT
