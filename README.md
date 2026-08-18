# Tuninator

A library that turns an audio stream into two streams:

- **`PitchFrame`** — a low-level continuous stream, one frame every ~12ms, suitable for building
  a tuner.
- **`MusicEvent`** — a higher-level stream of notes and chords with start/update/end lifecycles,
  suitable for games, practice tools, and scoring.

ESM, TypeScript, zero runtime dependencies.

The library itself is platform-free: mono `Float32Array` in, results out. It has no clock, no
I/O, and no DOM — you push audio and it hands back analysis. **Workers** are the thin adapters
that get audio out of one particular host and into it; `tuninator/web` runs the detector in an
`AudioWorklet`, off the main thread.

The detector is graded against **recorded guitar**, not synthetic sine waves. `npm run eval`
decodes five labelled fixtures, runs the real detection chain over them, and fails loudly on
regression. See [Evaluation](#evaluation) for the actual numbers.

## Install

```bash
npm install tuninator
```

## Entry points

| Import | What it is |
|---|---|
| `tuninator` | The library. `class Tuninator` — audio in, analysis out. Works anywhere JavaScript does. |
| `tuninator/web` | The browser worker. Microphone, `AudioContext`, `AudioWorklet`, event subscription. |
| `tuninator/worklet` | The prebuilt worklet asset. Not imported — served. See below. |

If you are writing a web page, you almost certainly want `tuninator/web`. If you have audio
already — a decoded file, a Node stream, another audio host — use the library directly.

## Worklet asset setup — read this first

This is the #1 integration failure mode, and it applies only to `tuninator/web`.

The web worker runs the detector inside an `AudioWorklet`, and `AudioWorklet.addModule()` needs a
**URL your server actually serves**. The package ships that file as a prebuilt, self-contained
bundle:

```
node_modules/tuninator/dist/tuninator-worklet.js
```

Copy it into your static assets and pass its URL as `workletUrl`:

```bash
cp node_modules/tuninator/dist/tuninator-worklet.js public/assets/
```

```ts
const worker = createWorkerWebAudio({
  workletUrl: "/assets/tuninator-worklet.js",
});
```

Bundlers do not copy this file for you, because it is loaded at runtime by URL rather than
imported. If `workletUrl` is omitted the worker falls back to resolving the asset next to its own
`dist/` output, which works only when the package is served unbundled.

A wrong or missing URL surfaces as a `worklet-load-failed` error event rather than an exception,
so handle the `error` event and you will see it immediately.

The bundle is deliberately a single file with **no `import`/`export` statements** —
`AudioWorkletGlobalScope` has no module loader on older targets. The build asserts this
(`scripts/assert-worklet-bundle.mjs`) so a stray import cannot reach a release.

## Usage — in a browser

```ts
import { createWorkerWebAudio } from "tuninator/web";

const worker = createWorkerWebAudio({
  mode: "lead",
  workletUrl: "/assets/tuninator-worklet.js",
});

worker.on("stateChange", (state) => console.log("state:", state));
worker.on("error", (error) => console.error(error.code, error.message));

// Continuous stream — build a tuner on this.
worker.on("pitchFrame", (frame) => {
  if (frame.frequencyHz === null) return;
  console.log(frame.nearest!.name, frame.nearest!.cents.toFixed(1), "cents");
});

// Musical interpretation — build a game or practice tool on this.
worker.on("musicEventStart", (event) => console.log("start", event.label.name));
worker.on("musicEventEnd", (event) => console.log("end", event.label.name));

// Must be called from a user gesture: the browser will not open a microphone
// or resume an AudioContext without one.
await worker.start();
```

`on()` returns its own unsubscribe function:

```ts
const off = worker.on("pitchFrame", handler);
off();
```

## Usage — anywhere else

```ts
import { Tuninator } from "tuninator";

const tuninator = new Tuninator({ sampleRate: 48000, mode: "lead" });

// Any block length. The caller owns the clock: `timestampMs` is the time of the
// FIRST sample, and every timestamp coming back out is on that same clock.
for (const { block, timeMs } of myAudioSource) {
  for (const result of tuninator.analyze(block, timeMs)) {
    console.log(result.frame.nearest?.name);
    for (const emission of result.emissions) {
      console.log(emission.type, emission.event.label.name);
    }
  }
}

// Ends anything still sounding, or the last note never gets its `end`.
tuninator.flush(endTimeMs);
```

`analyze()` returns one result per hop boundary crossed — usually zero or one for a small block,
several for a large one. Input must be **mono**; see [Input is mono](#input-is-mono).

## Modes

`setMode()` is safe to call while listening — it swaps the detection policy in place without
restarting anything. Modes change detection *policy*, never the event model, so a consumer
written against `MusicEvent` keeps working in all four.

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
  timestamp: number;              // ms, on the caller's clock, comparable with MusicEvent times
  frequencyHz: number | null;     // null when gated or unvoiced
  confidence: number;             // 0..1
  nearest: PitchNote | null;      // snapped to the nearest equal-tempered note
  amplitude: { rms: number; peak?: number };
  channelRms?: number[];          // level of each channel that reached the worklet, unmixed
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

Chord detection reports `label.name: "unknown"` rather than a confident wrong label, and it does
so at two levels.

Per hop, `matchChord` abstains when the top candidate is below `floor`, or when the best rival
with a *different root* is within `margin` of it. Per event, the same question is asked of the
pooled evidence: an event is named only when enough distinct chroma readings agreed on a root,
their mean score clears `floor`, and that root outweighs the best rival root. Otherwise the event
is `unknown` and the candidates are surfaced in `ambiguity.alternatives`.

Both levels are needed. A single hop can be confident and wrong; an event whose readings are
split between two roots would otherwise be named after whichever happened to lead at the end.
Extended voicings are exactly that case — `Cmaj9` (C E G B D) contains `Em`, `G`, and `C` — so on
a strummed guitar an honest `unknown` is the correct answer far more often than a coin flip.

Pooling is by **root**, not by label: a decayed `B5` and a full `Bm` are the same chord seen at
two moments, and they reinforce each other rather than splitting the vote.

### Errors

Failures set the worker's state to `error` and emit an `error` event with a `TuninatorErrorCode`:

| Code | Cause |
|---|---|
| `mic-permission-denied` | The user denied microphone access (`NotAllowedError`, `SecurityError`). |
| `mic-unavailable` | No usable microphone (`NotFoundError`, `NotReadableError`, `OverconstrainedError`). |
| `audio-context-failed` | `AudioContext` could not be created. |
| `worklet-unavailable` | The browser has no `AudioWorklet` support. |
| `worklet-load-failed` | `addModule()` rejected — almost always a wrong `workletUrl`. |
| `unknown` | Anything else, including a worklet processor crash. |

### Options and defaults

```ts
createWorkerWebAudio({
  mode: "lead",
  workletUrl: "/assets/tuninator-worklet.js",
  input:    { source, deviceId, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  analysis: { minFrequencyHz: 70, maxFrequencyHz: 1400, pitchHopMs: 12, rmsGate: 0.008, confidenceGate: 0.35 },
  tracking: { minStableMs: 45, releaseGraceMs: 90, bendThresholdCents: 45 },
});
```

`mode`, `analysis` and `tracking` belong to the library and mean the same thing whichever worker
is driving it. `input` and `workletUrl` are the web worker's alone.

| Option | Default | Why |
|---|---|---|
| `analysis.minFrequencyHz` | `70` | Below E2 (82.4Hz), with headroom for flat tuning. |
| `analysis.maxFrequencyHz` | `1400` | Above E6 (1319Hz). |
| `analysis.pitchHopMs` | `12` | A *request*, snapped up or down to whole 128-sample render quanta: 640 samples (13.3ms) at 48kHz, 512 (11.6ms) at 44.1kHz. `Tuninator.hopSamples` reports what you actually got. |
| `analysis.rmsGate` | `0.008` | Below this the frame is treated as silence. |
| `analysis.confidenceGate` | `0.35` | Below this `frequencyHz` is reported as `null`. Measured, not guessed: at `0.5` the detector dropped frames mid-note on decaying low strings, which read as note-offs and split notes in two. |
| `tracking.minStableMs` | `45` | Note identity settles slower than the frame rate. |
| `tracking.releaseGraceMs` | `90` | Survives pick noise and brief dropouts. |
| `tracking.bendThresholdCents` | `45` | Below a semitone, above vibrato. |
| `input.channelCount` | `1` | Analysis input is mono, and the worker does not choose channels. Ask for more if you intend to split it yourself. |

The microphone processors default to **off**. `echoCancellation`, `noiseSuppression`, and
`autoGainControl` are tuned for speech and will chew holes in a sustained guitar note.

### Input is mono

The library analyses one channel. Which channel that is, is **the host's decision**, and
`input.source` is how you make it:

```ts
// Two physical inputs arrive as one stereo device. Split it and hand over the
// channel your instrument is actually plugged into.
const context = new AudioContext();
const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 2 } });
const splitter = context.createChannelSplitter(2);
context.createMediaStreamSource(mic).connect(splitter);

const chosen = context.createGain();
splitter.connect(chosen, 1);        // channel 1 == physical input 2

const worker = createWorkerWebAudio({
  workletUrl: "/assets/tuninator-worklet.js",
  input: { source: chosen },        // no microphone is opened; this graph is used as-is
});
```

This is not an arbitrary division of labour. A 2-in interface presents to the browser as a single
**stereo** device — macOS and Windows both list the Audient iD4 as one input called
"Analogue 1/2" — so a guitar in input 2 exists only on channel 1, and nothing is on channel 0.
Which input it is plugged into is a fact about your rig, on your machine, right now. A library
cannot know it, and guessing has a bad failure mode: summing two captures of *one* source (a DI
into input 1 and a mic on the cab into input 2, an entirely ordinary rig) produces a comb filter.
One metre of air is ~3ms, half a period of 166.7Hz, so around E3 the odd harmonics cancel and the
strongest remaining periodicity is the second harmonic. The detector then reports E4 for an E3,
confidently, with nothing anywhere looking broken.

`examples/browser-demo` does the whole job — split, meter each channel, pick the loudest with
hysteresis, hand one channel over — in
[`channel-input.ts`](examples/browser-demo/src/channel-input.ts) and
[`channel-select.ts`](examples/browser-demo/src/channel-select.ts). Copy it if you want the
behaviour; it used to live in this library and was moved out, not deleted.

Notes on the contract:

- When `input.source` is present, the worker opens **no** microphone and closes **nothing** it did
  not create. An `AudioNode` brings its own `AudioContext`, which is reused rather than replaced —
  nodes cannot cross contexts.
- If something wider than mono arrives anyway, it is **summed** rather than silently read from
  channel 0: a sum can be a poor signal, but it cannot miss an instrument entirely.
- `PitchFrame.channelRms` reports each channel's level *before* that fold, so a host that wired it
  wrong can see so. If a guitar is inaudible to the detector but audible through the interface's
  own monitoring, this is the thing to look at first — direct monitoring is analogue and proves
  nothing about what the browser received.

## Architecture

```
src/core/      the shared DSP kernel — no npm imports, no globals, no DOM
src/tuninator.ts   the library: composes the kernel into audio-in/results-out
src/workers/   platform adapters — web-audio, its AudioWorklet processor, offline (Node)
src/eval/      harness-only: the scoring matcher and a WAV codec
```

The load-bearing rule: **`src/core/` must be importable by the browser worklet, by Node, and by
Vitest with byte-identical behaviour.** No `window`, no `AudioContext`, no `performance`, no npm
imports, no top-level side effects — pure functions and classes over `Float32Array`, with sample
rate and timestamps passed in.

`Tuninator` sits directly on top of that and adds nothing platform-specific: it is the block loop
(push a block, get a frame, feed the tracker, collect emissions) and nothing else. Every worker
drives that same class. The offline evaluation is trustworthy *only* because of this — there is no
separate "offline detector", and the eval feeds samples through the same `Tuninator` in the same
128-sample render quanta the `AudioWorklet` delivers.

### How the detector works

Window and hop are **decoupled**. A ring buffer accumulates input and every hop the detector
analyses the most recent N samples. One period of low E (82.4Hz) is ~582 samples and YIN needs
roughly two, so the long window is 2048 samples (~43ms) even though the hop is ~13ms.

A **dual-window** YIN runs every hop — 512 samples and 2048 samples — and the short window wins
whenever it is confident above ~300Hz, where it genuinely spans two periods. At a quarter the
length that is 4× better time resolution on fast high passages, while low notes keep the long
window they need.

Octave errors are YIN's known failure mode on guitar, so five mitigations stack:

- prefer the *first* CMND dip below threshold, not the global minimum;
- a sub-harmonic check that prefers the higher octave when half the lag is equally periodic;
- a cross-check between the two windows: the long window searches lags all the way down to
  `minFrequencyHz`, so on a high note its CMND dips at every multiple of the true period and it
  can lock onto one. The short window's search range physically excludes those lags, so when the
  long window reports an exact octave-multiple *below* the short one, the short one wins;
- an independent zero-crossing estimate that *corrects* the reading when the two disagree by a
  whole number of octaves. Only gaps of two octaves or more qualify: zero-crossing counts run high
  on a harmonic-rich string, so a one-octave disagreement is genuinely ambiguous and acting on it
  turned correct readings into octave-up errors;
- a temporal median over recent voiced frames, so one bad frame cannot create a spurious event.

Onsets use **spectral flux** (positive half-wave rectified difference against a decaying per-bin
peak hold) with an adaptive median threshold. An RMS envelope alone cannot see a re-picked note at
the same pitch.

## Development

```bash
npm install
npm run build      # library + worker ESM/dts, and dist/tuninator-worklet.js as one self-contained file
npm test           # vitest
npm run typecheck
npm run eval       # decode fixtures, grade the detector, exit nonzero on required failures

cd examples/browser-demo && npm install && npm test   # the demo's own tests, incl. channel selection
```

## Evaluation

`npm run eval` decodes the five recorded fixtures in `fixtures/audio/`, runs the real detection
chain over them, matches detected events one-to-one against the hand-written ground truth in
`fixtures/labels/`, and exits nonzero when a fixture marked `required` misses a threshold.

**`npm run eval` currently exits 1.** These are the real numbers, not a target:

| Fixture | Mode | Labels | Detected | Matched | Missed | False pos. | Exact | Pitch class | Onset median |
|---|---|---|---|---|---|---|---|---|---|
| clean-lead-120bpm *(required)* | lead | 43 | 40 | 36 | 7 | 4 | 72.1% | **79.1%** | 86.8ms |
| chords-a-bm-g-d *(required)* | chords | 16 | 17 | 14 | 2 | 3 | **76.9%** | 84.6% | 0.3ms |
| power-chords *(required)* | chords | 8 | 9 | 8 | 0 | 1 | **100.0%** | 100.0% | 153.3ms |
| cowboy-chords | chords | 8 | 19 | 8 | 0 | 11 | 85.7% | 100.0% | 40.3ms |
| spicy-chords | chords | 3 | 16 | 3 | 0 | 13 | 50.0% | 100.0% | 80.0ms |

Per-section breakdown of the lead fixture, which is where the difficulty lives:

| Section | Notes | Shortest | Pitch class | Onset median |
|---|---|---|---|---|
| quarters | 7 | 500ms | **100.0%** | 63.3ms |
| triplets | 24 | 166ms | 70.8% | 86.7ms |
| sixteenths* | 12 | 125ms | 83.3% | 120.0ms |

\* Excluded from the required gate in `fixtures/eval.config.json`, visibly and by configuration.
Its numbers are still reported. No label file was edited to achieve any of this.

### What passes and what does not

**Passing:** `power-chords` names all eight chords exactly right; `cowboy-chords` and
`spicy-chords` are at 100% pitch class; `chords-a-bm-g-d` clears every gate it has; and the
lead fixture's quarter-note section is at 100% pitch class. No chord fixture misses a label.

**Failing, honestly:**

- `clean-lead` pitch-class accuracy is **77.4%** on the gated subset against a 90% threshold. It
  now clears its false-positive limit (3 of 3), so accuracy is the only gate it misses. The gap
  lives in the triplet section (70.8%), and the cause is not segmentation but the pitch track
  itself: in a fast run the previously-played string is still ringing, and a monophonic detector
  follows the loudest periodicity rather than the newest note. Traced on the B4-C#5-D5-E5 run, the
  detector holds D5 for 270ms at 0.9 confidence while the player has already moved through C#5 to
  B4. The chroma analyser can see the newer note underneath (C# rises 0.64 -> 0.99 across those two
  triplets while D stays at 1.00), so the information is present — but using it needs
  onset-conditioned multi-pitch tracking, which is a subsystem this library does not have, not a
  constant that wants adjusting.
- `power-chords` onset median is **153ms** against 120ms, while naming every chord correctly. Six
  of its eight onsets land within 60-180ms; the two E chords are ~900ms early. The audio at those
  points shows a real attack — RMS jumps from 0.0085 to 0.11 and from 0.003 to 0.084, with the
  fundamental reading 82Hz, the open low E — where the labels place the boundary nearly a second
  later. This fixture's `timingNotes` describe its boundaries as one 4/4 bar each from a first
  attack "estimated at 5100ms", i.e. a nominal grid; `cowboy-chords`, whose onset error is 40ms,
  had its boundaries "corrected from an initial uniform-2000ms-per-bar estimate" against the RMS
  envelope. That is evidence for a label review, not a verdict — `fixtures/labels/` is read-only
  and was not touched.

### Two fixtures, two definitions of an event

The chord fixtures do not agree on what counts as one event, and no detector setting reconciles
them:

- `chords-a-bm-g-d` labels **one event per strum** — *"two strums each ... that gives sixteen
  events."*
- `power-chords` and `cowboy-chords` label **one event per bar** — *"chords are labeled as one 4/4
  bar each"* — however many times the bar is strummed.

A re-articulation of the same chord is therefore a new event in one fixture and not in another,
and that distinction is not present in the audio. The detector emits per articulation, because a
consumer can merge events but cannot recover ones that were never emitted. That is why
`cowboy-chords` and `spicy-chords` show high false-positive counts while still naming every chord
correctly: those counts are mostly extra strums of a chord that is already right. Neither fixture
gates on false positives.

### The labels are estimates, and the eval says so

The fixture labels state their own uncertainty: *"Octaves are first-pass estimates; pitch-class
intent comes from the player's description."* That is why exact and pitch-class accuracy are
reported **separately** — a large gap between them points at the labels, while a low pitch-class
number points at the detector.

Where the detector confidently disagrees with a label, the evidence is written to
`.cache/proposed-label-corrections.json` rather than applied. **`fixtures/labels/` is read-only
and was never modified.**

### Reproducing and debugging

```bash
npm run eval                              # full run, writes .cache/eval-report.json
npx tsx scripts/eval.ts --trace clean-lead-120bpm   # per-hop CSV of detector internals
```

The trace dumps ten columns per hop: `timestampMs`, `frequencyHz`, `confidence`, `rms`, `tau`,
`cmnd`, `zeroCrossingHz`, `onset`, `onsetFlux` and `nearestNote`. Every tuned constant in `src/core/policy.ts` was chosen by measuring against
these fixtures, not picked a priori.

## License

MIT
