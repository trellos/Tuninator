# Tuninator

A UI-free browser library that turns guitar microphone input into **musical events**.

The unit is a `Note`, and a Note is something the recognizer learns about over time. It starts the
moment there is evidence something was played, and then improves: the pitch is refined, a bend is
recognised as a bend rather than as three notes, a chord blooms out of what first looked like a
single string. Every improvement arrives as a typed `NoteChange`, so a consumer can tell *"I know
more now"* from *"I was wrong"*.

A second, optional stream — `pitchFrame` — is the raw continuous pitch reading, one frame every
~13ms including during silence. That is what a tuner needs; it is off by default.

ESM, TypeScript, zero runtime dependencies. Audio capture runs in an `AudioWorklet`; the
recognition engine runs on the main thread by default and can be moved to a Web Worker.

The recognizer is graded against **recorded guitar**, not synthetic sine waves. `npm run eval`
decodes seventeen labelled takes — three signal paths, two tempos, two guitars — runs the real
recognition chain over them, and fails loudly on regression. See [Evaluation](#evaluation) for the
actual numbers.

> **Upgrading from 0.1?** The API changed completely. [`docs/MIGRATION.md`](docs/MIGRATION.md) maps
> every old symbol to its replacement and explains what changed and why.

## Install

```bash
npm install tuninator
```

## Worklet asset setup — read this first

This is the #1 integration failure mode.

Audio capture runs inside an `AudioWorklet`, and `AudioWorklet.addModule()` needs a **URL your
server actually serves**. The library ships that file as a prebuilt, self-contained bundle:

```
node_modules/tuninator/dist/tuninator-worklet.js
```

Copy it into your static assets and pass its URL as `workletUrl`:

```bash
cp node_modules/tuninator/dist/tuninator-worklet.js public/assets/
```

```ts
const recognizer = createRecognizer({
  workletUrl: "/assets/tuninator-worklet.js",
});
```

Bundlers do not copy this file for you, because it is loaded at runtime by URL rather than
imported. If `workletUrl` is omitted the library falls back to resolving the asset next to its
own `dist/index.js`, which works only when the package is served unbundled.

A wrong or missing URL surfaces as a `worklet-load-failed` error rather than an exception, so
handle the `error` event and you will see it immediately.

The bundle is deliberately a single file with **no `import`/`export` statements** —
`AudioWorkletGlobalScope` has no module loader on older targets. The build asserts this
(`scripts/assert-worklet-bundle.mjs`) so a stray import cannot reach a release.

## Usage

```ts
import { createRecognizer } from "tuninator";

const recognizer = createRecognizer({
  workletUrl: "/assets/tuninator-worklet.js",
});

recognizer.on("stateChange", (state) => console.log("state:", state));
recognizer.on("error", (error) => console.error(error.code, error.message));

recognizer.on("noteStarted", (note) => {
  console.log("started", note.id, note.pitch.current?.name ?? "(listening)");
});

// The interesting one. `change.type` says what KIND of news this is.
recognizer.on("noteChanged", (note, change) => {
  switch (change.type) {
    case "pitchRefinement":
      console.log(note.id, "is actually", note.pitch.current?.name);
      break;
    case "harmonyEnrichment":
      console.log(note.id, "blooms into", note.harmony?.chordName);
      break;
    case "pitchCorrection":
      console.log(note.id, "was", change.previous?.label, "now", note.pitch.current?.name);
      break;
  }
});

// Fires once, when the answer settles — before the note stops sounding.
recognizer.on("noteResolved", (note) => {
  console.log("resolved", note.harmony?.chordName ?? note.pitch.current?.name);
});

recognizer.on("noteEnded", (note) => console.log("ended", note.id, note.endTime));

// Must be called from a user gesture: the browser will not open a microphone
// or resume an AudioContext without one.
await recognizer.start();
```

`on()` returns its own unsubscribe function:

```ts
const off = recognizer.on("noteChanged", handler);
off();
```

Shutting down:

```ts
await recognizer.stop();     // flushes both lanes; every open Note gets noteEnded
await recognizer.dispose();  // stop, then release the mic, worklet and any context it created
```

`stop()` is `async` because the flush is real: a Note still sounding when you stop still gets its
`noteEnded`, with a real `endTime`, before the promise settles.

## The Note model

### A Note improves rather than being re-issued

Handlers receive **immutable snapshots**. `note.revision.revisionNumber` increases with every
change, so a snapshot you stashed can always be checked for staleness.

The distinction the whole model is built on:

| `NoteChange.type` | Meaning |
|---|---|
| `pitchRefinement`, `harmonyEnrichment` | **I know more now.** The earlier answer was not wrong, just less complete — `C` becoming `Cmaj7` becoming `Cmaj9`. |
| `pitchCorrection`, `harmonyCorrection` | **I was wrong.** `change.previous.label` carries what was said before. |
| `structuralRevision` | **The event boundaries were wrong.** `change.relatedNoteIds` names the Notes involved in a split or a merge. |
| `hypothesisPromoted`, `hypothesisDiscredited`, `hypothesisIncorporated` | A candidate interpretation changed state. |
| `resolved` | The answer has settled. |

Already-delivered events always stand. A split emits a `structuralRevision` on the surviving Note
and then a `noteStarted` for the new one with a backdated `startTime`; history is revised in
meaning, never rewritten.

### Three behaviours worth relying on

- **A re-picked note is two Notes.** An attack over something already sounding starts a new Note
  even at an unchanged pitch, so a repeated note does not read as one long sustain.
- **A legato pitch step is also two Notes.** In a fast run the pick never re-attacks, so onset
  detection alone would merge them.
- **A bend is ONE Note.** `pitch.current` keeps the origin note and `bend` records the excursion.
  A note bent from A3 up to B3 is a single Note named `A3` with `bend.amountCents ≈ 200`, never
  two Notes. Total displacement cannot separate a 200-cent bend from a 200-cent legato step —
  both are two semitones — so the discriminator is the per-hop rate: a bend glides through the
  intermediate cents over tens of frames, a fretted step jumps within one or two.

### Notes overlap

`getActiveNotes()` is genuinely plural. A chord struck while the previous one is still ringing
produces a second Note over the first, which the old single-active-event tracker could not
represent at all.

The distinction underneath is **voices versus Notes**: a ringing voice outlives the articulation
that created it, so a decaying string is attributed to the Note that already owns it rather than
spawning one of its own.

### Chords bloom; they are not a mode

There is no `kind: "chord"`. A Note starts as whatever the fast lane can say in a few tens of
milliseconds — usually a single pitch — and `harmony` appears on it later, when the deep lane has
had enough audio to say so. `harmony.chordName` is `"C"`, `"C/G"`, `"C5"`, `"Cmaj9"`.

`harmony` present with `quality` **undefined** is honest abstention, not a bug: when the top
template candidates are too close, or the best score is too low, the recognizer declines to name
the quality and surfaces the candidates in `hypotheses.active`.

That is a deliberate product guarantee. Extended voicings share most of their chroma with simpler
chords — `Cmaj9` (C E G B D) contains `Em`, `G` and `C`; `Am11` (A C D E G) contains `Am7`, `C6`
and `Dsus` — so on a strummed guitar an honest abstention is the correct answer far more often
than a coin-flip between them.

### The hypothesis trail

`note.hypotheses.active` is what is currently believed; `note.hypotheses.trail` is what was
believed and why it stopped being believed. Each entry carries a `state`:

```
candidate → contender → leading → confirmed
                     ↘ incorporated | superseded | discredited
```

A UI can show the trail directly; nothing else needs to read it.

## Timestamps

Every timestamp in the public surface is a **`SourceTimeMs`**: milliseconds of source audio since
the first processed sample, derived only from sample count ÷ sample rate. Your first Note starts
near 0, every time, regardless of how long the `AudioContext` had been alive.

Both lanes, the pitch frames, the Notes and the hypothesis trail share this one clock, which is
what makes an offline run over a WAV and a live run over the same audio directly comparable.

To relate it to the audio context's own clock:

```ts
const timebase = recognizer.getTimebase();
// { sampleRate: 48000, originContextTime: 91.372 }
const contextTime = (timebase.originContextTime ?? 0) + note.startTime / 1000;
```

## API

The full type surface lives in [`src/types.ts`](src/types.ts).

### Events

| Event | Payload |
|---|---|
| `noteStarted` | `(note: Note)` |
| `noteChanged` | `(note: Note, change: NoteChange)` |
| `noteResolved` | `(note: Note)` — once, when the answer settles |
| `noteEnded` | `(note: Note)` |
| `pitchFrame` | `(frame: PitchFrame)` — diagnostic, off unless `diagnostics.pitchFrames` |
| `stateChange` | `(state: RecognizerState)` — `idle`/`starting`/`listening`/`stopping`/`error` |
| `status` | `(message: string)` |
| `error` | `(error: RecognizerError)` |

### Methods

```ts
start(): Promise<void>            // rejects with a RecognizerError
stop(): Promise<void>             // flushes both lanes
dispose(): Promise<void>          // stop + release mic/worklet/owned context
getState(): RecognizerState
getActiveNotes(): Note[]
getNote(id: string): Note | undefined      // active, or recently ended
getTimebase(): Timebase | null
on(event, handler): () => void             // returns its own unsubscribe
```

### `PitchFrame`

One analysis hop, emitted continuously while listening — **including during silence**, with
`frequencyHz: null`. That continuity is what a tuner UI needs. Opt in with
`diagnostics: { pitchFrames: true }`.

```ts
{
  timestamp: SourceTimeMs;
  frequencyHz: number | null;      // null when gated or unvoiced
  confidence: number;              // 0..1
  nearest: PitchNote | null;       // snapped to the nearest equal-tempered note
  amplitude: { rms: number; peak?: number };
  channelRms?: number[];           // level of each INPUT channel, before they are mixed
  selectedChannel?: number | null; // channel being analysed; null = summed
  detector: { tau?: number | null; cmnd?: number | null; zeroCrossingHz?: number | null };
}
```

### Errors

`RecognizerError extends Error`, so it is throwable, `instanceof`-able and carries a stack. Every
one has a `code`:

| Code | Cause |
|---|---|
| `mic-permission-denied` | The user denied microphone access (`NotAllowedError`). |
| `mic-unavailable` | No usable microphone (`NotFoundError`, `NotReadableError`, `OverconstrainedError`). |
| `audio-context-failed` | `AudioContext` could not be created. |
| `worklet-unavailable` | The browser has no `AudioWorklet` support. |
| `worklet-load-failed` | `addModule()` rejected — almost always a wrong `workletUrl`. |
| `engine-load-failed` | `host: "worker"` without an `engineUrl`, or the worker could not be created. |
| `already-disposed` | `start()` after `dispose()`. |
| `unknown` | Anything else, including a worklet processor crash. |

### Options

```ts
createRecognizer({
  workletUrl: "/assets/tuninator-worklet.js",
  audioContext,                 // optional; never closed by the recognizer
  host: "inline",               // or "worker" — see below
  engineUrl,                    // required when host is "worker"
  input:  { deviceId, channelCount: 2, channels: "auto",
            echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  engine: { minFrequencyHz: 70, maxFrequencyHz: 1400, hopMs: 12, rmsGate: 0.008,
            confidenceGate: 0.35, minStableMs: 55, releaseGraceMs: 90,
            bendThresholdCents: 45 },
  diagnostics: { pitchFrames: false, contour: false },
});
```

| Option | Default | Why |
|---|---|---|
| `engine.minFrequencyHz` | `70` | Below E2 (82.4Hz), with headroom for flat tuning. |
| `engine.maxFrequencyHz` | `1400` | Above E6 (1319Hz). |
| `engine.hopMs` | `12` | Snapped to whole 128-sample render quanta. |
| `engine.rmsGate` | `0.008` | A *ceiling*: the working gate is derived from the rig's own measured noise floor and can only go below this. |
| `engine.confidenceGate` | `0.35` | Measured, not guessed: at `0.5` the recognizer dropped frames mid-note on decaying low strings, which read as note-offs and split notes in two. |
| `engine.minStableMs` | `55` | How long a Note must sound before it is announced. |
| `engine.releaseGraceMs` | `90` | Survives pick noise and brief dropouts. |
| `engine.bendThresholdCents` | `45` | Below a semitone, above vibrato. |

There is **no mode**. 0.1 had `lead`/`chords`/`rhythm`/`raw` because those ran genuinely different
code; one recognizer now runs the whole time and a Note blooms into a chord when the evidence
supports it. `engine` is tuning, not policy.

The microphone processors default to **off**. `echoCancellation`, `noiseSuppression` and
`autoGainControl` are tuned for speech and will chew holes in a sustained guitar note.

## Where the engine runs

| `host` | Behaviour |
|---|---|
| `"inline"` *(default)* | The engine runs on the main thread. One fast hop is a few hundred microseconds and the deep lane is budgeted and droppable. |
| `"worker"` | The engine runs in a Web Worker. Needs `engineUrl` pointing at `dist/tuninator-engine-worker.js`, shipped the same way as the worklet asset. |

```bash
cp node_modules/tuninator/dist/tuninator-engine-worker.js public/assets/
```

```ts
createRecognizer({
  host: "worker",
  workletUrl: "/assets/tuninator-worklet.js",
  engineUrl: "/assets/tuninator-engine-worker.js",
});
```

The property that makes this safe to offer is that it changes nothing else: the same audio through
either host produces the same Notes, the same timestamps and the same event ordering, and a test
asserts it emission for emission. Without `engineUrl` the recognizer fails with
`engine-load-failed` rather than silently running inline while you believe your main thread is
free.

## Multi-channel interfaces

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

If a guitar is inaudible to the recognizer but audible through the interface's own monitoring,
`channelRms` is the thing to look at first: direct monitoring is analogue and proves nothing
about what the browser received.

### `input.channels` — selection, not summing

| Value | Behaviour |
|---|---|
| `"auto"` *(default)* | Analyse the loudest channel, decided over a window and with hysteresis. Sums until a decision has latched. |
| `"sum"` | Always sum every channel. |
| a number | Always analyse that channel index. Out of range falls back to summing. |

Summing looks like the safe default and is not. Two captures of **one** source — a DI into input 1
and a mic on the cab into input 2, an entirely ordinary rig — are separated by the mic's acoustic
delay, and adding them produces a comb filter: a spectrum with periodic notches. One metre of air
is ~3ms, which is half a period of 166.7Hz, so around E3 the odd harmonics cancel outright and the
strongest remaining periodicity is the second harmonic. The recognizer then reports E4 for an E3,
confidently, with nothing anywhere looking broken. Selecting one channel cannot do this.

The rules `"auto"` follows, and why:

- **Decided over a window, not per hop.** Per-hop argmax jitters — a 13ms hop lands anywhere in a
  note's attack. Energy accumulates over **250ms** and the decision is taken on the total.
- **Hysteresis.** A challenger must beat the incumbent by **6dB** (a factor of two in amplitude)
  for **3 consecutive windows** — 750ms — before the selection moves. Switching splices two
  uncorrelated waveforms together in the analysis ring buffer, which is a worse input than either
  channel alone, so the bar sits above anything a genuine stereo pair produces and far below an
  unplugged input (30dB or more down). The *first* choice has no margin requirement; only switches
  do.
- **Silence never latches.** Before anyone plays, every channel is noise floor and "loudest" means
  "worse preamp". Windows whose loudest channel is under the amplitude gate are discarded — they
  neither latch a decision nor challenge one. Until then the channels are **summed**: a sum can be
  a poor signal, but it cannot miss an instrument, which is the right way to be wrong while
  waiting.
- **A latched choice survives silence**, so pauses between phrases do not re-open the question.
- **Mono is a no-op.** One channel, nothing to decide, no per-hop work at all.

## Architecture

```
src/engine/    the recognition engine — ZERO imports outside itself, no DOM, no globals, no clock
  kernels/     DSP: YIN, FFT, spectral flux, chroma, chord templates, channel selection
  fast/        the causal lane: pitch, transients, pitch change, re-articulation
  deep/        the revisiting lane: spectra, multi-pitch, harmony, bends, re-segmentation
  tracker/     the semantic centre: Notes, hypotheses, voices, revisions
src/browser/   the DOM adapter, and where the engine runs (inline or worker)
src/worklet/   the capture shim — channel metering and downmix, no analysis
src/offline/   the same engine, driven from Node for evaluation
```

The load-bearing rule: **`src/engine/` imports nothing outside itself and `src/types.ts`.** No
`window`, no `AudioContext`, no `performance`, no npm imports, no top-level side effects — pure
functions and classes over `Float32Array`, with sample rate and timestamps passed in. A test
asserts it.

That is what makes the offline evaluation trustworthy. There is no separate "offline recognizer";
the eval feeds samples through the same `RecognitionEngine` in the same 128-sample render quanta
the `AudioWorklet` delivers, and the deep lane is driven through an injected scheduler so a run is
bit-reproducible.

### Two lanes over one timeline

**The fast lane** is causal and answers immediately: dual-window YIN, spectral-flux onsets, pitch
change, re-articulation. It is what makes a Note appear while the note is still sounding.

**The deep lane** is allowed to be late. It revisits buffered audio out of a ~4-second timestamped
ring, addressed by sample range, and can therefore answer questions the fast lane cannot: what the
full spectrum of that attack was, how many voices are in it, what chord it is, and — the thing
that most changes the result — whether the fast lane's segmentation of a region was right at all.
Its answers arrive as `NoteChange`s against Notes that already exist.

Jobs are keyed by Note id and purpose so that a superseded job is coalesced rather than run, and a
job whose audio has fallen out of the ring is dropped with a `status` diagnostic rather than
answering about audio it no longer has.

### How the pitch reading works

Window and hop are **decoupled**. A ring buffer accumulates input and every hop the engine
analyses the most recent N samples. One period of low E (82.4Hz) is ~582 samples and YIN needs
roughly two, so the long window is 2048 samples (~43ms) even though the hop is ~13ms.

A **dual-window** YIN runs every hop — 512 and 2048 samples — and the short window wins whenever
it is confident above ~300Hz, where it genuinely spans two periods. This gives ~7× better time
resolution on fast high passages while keeping low notes reliable.

Octave errors are YIN's known failure mode on guitar, so four mitigations stack: prefer the
*first* CMND dip below threshold rather than the global minimum; a sub-harmonic check that prefers
the higher octave when half the lag is equally periodic; an independent zero-crossing estimate,
whose ~2× disagreement halves confidence because ZCR fails differently than YIN does; and a
temporal median over recent voiced frames.

Onsets use **spectral flux** — the positive half-wave rectified difference between the arriving
spectrum and the per-bin maximum over the last few hops — with an adaptive median threshold, run
both broadband and over a 1–6kHz band where a pick's transient lives and a ringing string's
fundamentals do not. An RMS envelope alone cannot see a re-picked note at the same pitch, and a
quiet upstroke 107ms after the downstroke it answers is exactly the case that needs the band.

## Development

```bash
npm install
npm run build      # library ESM+dts, the worklet bundle, and the engine-worker bundle
npm test           # vitest
npm run typecheck
npm run eval       # decode fixtures, grade the recognizer, exit nonzero on required failures
```

## Evaluation

`npm run eval` decodes every recorded take in `fixtures/audio/`, runs the real recognition chain
over them, matches Notes one-to-one against the hand-written ground truth in `fixtures/labels/`,
and exits nonzero when a fixture marked `required` misses a threshold.

The corpus is **17 takes, 459 labelled events, about ten minutes of playing**, across two guitars,
two tempos and three signal paths (direct, amp sim, room mic). Five takes at 120bpm are the
derivation set — every tuned constant was chosen against those alone — and the twelve 140bpm Les
Paul takes are **held out**: they are recorded, labelled and scored, but nothing is tuned on them.
That separation is the only reason any number below means anything.

`npm run eval` currently **passes**: every required fixture meets its thresholds.

| Fixture | Required | Labels | Notes | Missed | Exact | Pitch class | Onset median |
|---|---|---|---|---|---|---|---|
| `chords-a-bm-g-d-2x-120bpm` | **yes** | 16 | 16 | 0 | 83.3% | 100.0% | 0ms |
| `clean-lead-120bpm` | **yes** | 43 | 41 | 3 | 81.5% | 92.6% | 43ms |
| `power-chords-c-a-g-e-...-120bpm` | **yes** | 8 | 9 | 0 | 87.5% | 100.0% | 107ms |
| `cowboy-chords-...-120bpm` | no | 8 | 12 | 0 | 75.0% | 87.5% | 40ms |
| `cowboy-chords-di-...-140bpm` | no | 8 | 12 | 0 | 75.0% | 100.0% | 52ms |
| `cowboy-chords-mic-...-140bpm` | no | 8 | 12 | 0 | 75.0% | 100.0% | 92ms |
| `cowboy-chords-amped-...-140bpm` | no | 8 | 11 | 0 | 62.5% | 100.0% | 92ms |
| `power-chords-di-...-140bpm` | no | 16 | 16 | 0 | 93.8% | 100.0% | 19ms |
| `power-chords-...-140bpm` (mic) | no | 16 | 23 | 0 | 57.1% | 100.0% | 23ms |
| `power-chords-amped-...-140bpm` | no | 16 | 15 | 3 | 78.6% | 78.6% | 10ms |
| `spicy-chords-cmaj9-g-am11` | no | 3 | 5 | 0 | 33.3% | 100.0% | 37ms |
| `lead-line-di-sixteenths-...-140bpm` | no | 48 | 41 | 7 | 85.4% | 85.4% | 15ms |
| `lead-line-sixteenths-...-140bpm` (mic) | no | 48 | 38 | 10 | 68.1% | 72.3% | 16ms |
| `lead-line-amped-sixteenths-...-140bpm` | no | 48 | 37 | 14 | 70.8% | 70.8% | 16ms |
| `lead-line-di-quarter-eighth-triplet-140bpm` | no | 55 | 76 | 0 | — | — | — |
| `lead-line-quarter-eighth-triplet-140bpm` (mic) | no | 55 | 64 | 2 | — | — | — |
| `lead-line-amped-quarter-eighth-triplet-140bpm` | no | 55 | 80 | 1 | — | — | — |

The three triplet takes score no accuracy because every section of them is marked informational in
`fixtures/eval.config.json`; the gated subset is empty by configuration, so the check is reported
as not applicable rather than failed.

### What is good and what is not

**Good.** Every chord fixture on every signal path finds all of its labels. Onset timing is well
inside its gates — of the fourteen takes that score it, seven have a median absolute error under
25ms and the worst is 107ms against a 120ms limit. Pitch class on the required lead fixture is
92.6%.

**Not good, and both are the same defect seen from two sides.**

- **Fast single-note lines lose strokes.** The sixteenth-note takes find 37–41 of 48 strokes. The
  losses are downstream of the evidence, not in it: the onset kernel covers 44, 44 and 47 of the
  48 on the three paths, and the Notes are lost afterwards — absorbed, ended too young, or created
  and then paired with a neighbouring label.
- **Fast single-note lines also produce extra Notes.** The triplet takes emit 64–80 Notes for 55
  labels. `npx tsx scripts/measure-splits.ts` puts the corpus at 79 of 459 events split with 81
  extra Notes, and 54 of those 79 are the three triplet takes.

The reason both are hard is measurable and is the same one: **attack contrast varies 2.0×–24.2×
across the corpus and up to 106× within a single take.** No single threshold separates a genuine
re-pick from a decaying string's own noise everywhere, which is why the design leans on retroactive
correction — the deep lane re-segmenting a region it can see whole — rather than on getting the
first answer right.

[`docs/DETECTION-FINDINGS.md`](docs/DETECTION-FINDINGS.md) records every experiment that was
measured and reverted, so that a road already found to be a dead end is not driven down again.

Held-out onset coverage, for scale: the twelve 140bpm takes have a kernel onset within 60ms of
**372 of their 381 labels**, at an off-label rate of 1.34% of above-gate hops. The evidence is
almost all there; what happens to it afterwards is the work that remains.

### The labels are estimates, and the eval says so

The fixture labels state their own uncertainty. That is why exact and pitch-class accuracy are
reported **separately** — a large gap between them points at the labels, while a low pitch-class
number points at the recognizer.

Where the recognizer confidently disagrees with a label, the evidence is written to
`.cache/proposed-label-corrections.json` rather than applied. **`fixtures/labels/` is read-only and
was never modified**, and no label was ever decided by asking the recognizer.

### Reproducing and debugging

```bash
npm run eval                                          # full run, writes .cache/eval-report.json
npx tsx scripts/verify-fixtures.ts                    # is each label actually in the audio?
npx tsx scripts/measure-downstream-ledger.ts --all    # every missed label, and the branch that lost it
npx tsx scripts/measure-splits.ts --detail            # every event that came out as more than one Note
npx tsx scripts/measure-onset-coverage.ts             # what the onset kernel saw, before the tracker
```

The ledger is built on the tracker's own trace rather than on a re-implementation of its rules, so
it cannot describe a version of the recognizer that no longer exists. Every cause it names is a
line in `note-tracker.ts` or `fast/rearticulation.ts`.

## License

MIT
