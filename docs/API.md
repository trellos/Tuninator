# API reference

The full type surface ships as `dist/index.d.ts` (source: `src/types.ts` in the
repository). The event list is in [the README](../README.md#events); everything
else is here.

---

## Worklet asset setup

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
imported. If `workletUrl` is omitted the library passes the bare relative string
`./tuninator-worklet.js` to `addModule()`, which resolves it against **the page's** base URL, not
against the library's own location — so the default works only when the file happens to sit next
to the document being served. Pass `workletUrl` explicitly and this stops being a question.

A wrong or missing URL surfaces as `worklet-load-failed` on both paths: `start()` rejects with it,
and the `error` event fires with the same `RecognizerError`. Handling either one is enough to see
it.

The bundle is deliberately a single file with **no `import`/`export` statements** —
`AudioWorkletGlobalScope` has no module loader on older targets. The build asserts this
(`scripts/assert-worklet-bundle.mjs`) so a stray import cannot reach a release.

## Methods

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

`start()` must be called from a user gesture: the browser will not open a microphone or resume an
`AudioContext` without one.

`on()` returns its own unsubscribe function:

```ts
const off = recognizer.on("noteChanged", handler);
off();
```

Shutting down:

```ts
await recognizer.stop();     // flushes both lanes; every open Note gets noteEnded, then noteResolved
await recognizer.dispose();  // stop, then release the mic, worklet and any context it created
```

`stop()` is `async` because the flush is real: a Note still sounding when you stop still gets its
`noteEnded`, with a real `endTime`, and then its `noteResolved`, before the promise settles.

## When a Note ends, and when it is final

The contract, since 0.3.0:

1. `noteEnded` fires when the fast lane ends the Note, in the same `processChunk` call. It is
   never held for the deep lane. Its delay from the `endTime` it carries is only what the fast lane
   needed to decide: a hop or two for an ending made by the next Note, `tracking.releaseGraceMs`
   of gated audio for a silence.
2. `noteEnded` carries the fast lane's best `endTime`.
3. After `noteEnded`, anything that changes the Note arrives as `noteChanged` on that Note: a
   boundary as `structuralRevision` with the new `endTime`/`startTime` in the snapshot; a name as
   `pitchCorrection`, `harmonyCorrection` or a refinement; an absorption as `structuralRevision`
   with `relation: "absorbed"` on the survivor, naming it.
4. `noteResolved` fires once per Note, after its `noteEnded`, when the deep lane has ruled and
   nothing more is expected to change. A consumer that wants only final answers waits for it; no
   setting restores the old timing.
5. `stop()` flushes: every open Note gets `noteEnded` and then `noteResolved` before it settles.
6. The inline and worker hosts produce the same emissions, in the same order.

In more detail — two events, two meanings:

- **`noteEnded` — the sound is over.** It fires in the same audio block in which the fast lane
  decides the Note has stopped, and is never held for the deep lane. How long after the Note's
  `endTime` that is depends on how it ended: a Note ended by the next attack or pitch step is ended
  on the hop that opens its successor (a hop or two); a Note ended by silence waits until the level
  has spent `tracking.releaseGraceMs` under the gate. A damp on a direct input is reported about
  140ms after the damp; through an amp, whose ring holds the gate open for a while after the damp,
  about 0.4s. Either way the `endTime` it carries is the damp. On the 27 fixture takes the delay
  from `endTime` to `noteEnded` is 0ms at the median, 93ms at p90 and 160ms at p95.
  `note.lifecycle` reads `"ended"`.

  Something that stays above the gate after a damp — a sympathetic string, hum, a gate set close to
  the noise floor — holds the Note open: it ends only when the level finally drops, when the region
  lane cuts it, or at `stop()`. Set `rmsGate` with that margin in mind.
- **`noteResolved` — the answer is settled.** The deep lane has re-analysed the region the Note
  lives in, and nothing more is expected to change. It follows `noteEnded` by 240ms at the median
  on the fixture corpus and 750ms at p90: the region is analysed once it has been quiet for
  `deep.regionSettleMs` or has grown to `deep.maxRegionMs`, so on dense material resolutions come in
  batches about a second apart. It waits longer while a much quieter Note that opened at this one's
  end is still sounding, in case the damp opened it (DECISION-074). `note.lifecycle` reads
  `"resolved"`. A consumer that wants only final answers waits for this.

Between the two, anything the deep lane changes arrives as `noteChanged` on the ended Note:

| What changed | How it arrives |
|---|---|
| Its end or start | `structuralRevision`, with the new `endTime`/`startTime` in the snapshot. An end has only ever moved earlier. |
| Its name | `pitchCorrection`, `harmonyCorrection`, or a refinement/enrichment, as for a sounding Note |
| It was part of another Note after all | `structuralRevision` with `relation: "absorbed"` on the survivor, naming it |

On the fixture corpus about one Note in sixteen gets any of these after its `noteEnded`: 44 of
1,807 an earlier end, 8 a new name, 64 an absorption.

A Note absorbed into another gets no `noteEnded` after the absorption — the survivor's
`structuralRevision` is its last word — and is resolved at once. One absorbed after its
`noteEnded` is retracted by that revision in the same way.

`noteResolved` is a settled answer, not a sealed one: in one rare path the region lane can still
correct the name of a Note it had already let go, as a `pitchCorrection`. On the fixture corpus it
never does.

## `NoteChange.type`

The distinction the whole Note model is built on — see
[the Note model](NOTE-MODEL.md) for what each one means in practice.

| `NoteChange.type` | Meaning |
|---|---|
| `pitchRefinement`, `harmonyEnrichment` | **I know more now.** The earlier answer was not wrong, just less complete — `C` becoming `Cmaj7` becoming `Cmaj9`. |
| `pitchCorrection`, `harmonyCorrection` | **I was wrong.** `change.previous.label` carries what was said before. |
| `structuralRevision` | **The event boundaries were wrong.** `change.relatedNoteIds` names the Notes involved, and `change.relation` says whether they were `"absorbed"` into this Note or `"split"` out of it. Getting those two backwards double-counts a strum or discards notes somebody played. |
| `pitchMovement`, `bendUpdate` | The pitch is moving, and that motion is part of this Note. |
| `pitchAdded`, `pitchRemoved` | The set of pitches believed to be sounding changed. |
| `hypothesisPromoted`, `hypothesisDiscredited`, `hypothesisIncorporated` | A candidate interpretation changed state. |
| `confidenceUpdate` | Same answer, different confidence. |
| `resolved` | The answer has settled — the change that accompanies `noteResolved`. |

`change.at` is when the *evidence* is from, which may precede delivery — the deep lane analyses
audio the fast lane already reported on. Any of these can arrive on a Note after its `noteEnded`
and before its `noteResolved`; see [above](#when-a-note-ends-and-when-it-is-final).

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

## `PitchFrame`

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

## Errors

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

## Options

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

`engine.deepLatencyMs` also exists: it simulates deep-lane latency in source time, and is a
determinism knob for the offline harness rather than something to set in a browser.

There is **no mode**. 0.1 had `lead`/`chords`/`rhythm`/`raw` because those ran genuinely different
code; one recognizer now runs the whole time and a Note blooms into a chord when the evidence
supports it. `engine` is tuning, not policy.

The microphone processors default to **off**. `echoCancellation`, `noiseSuppression` and
`autoGainControl` are tuned for speech and will chew holes in a sustained guitar note.

## Where the engine runs

| `host` | Behaviour |
|---|---|
| `"inline"` *(default)* | The engine runs on the main thread. One fast hop is a few hundred microseconds, and the deep lane's work per hop is bounded and its jobs droppable. |
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

A 2-in interface is a single **stereo** device to the browser: macOS and Windows typically list
its two inputs as one device with a name like "Analogue 1/2". A guitar plugged into input 2
therefore exists only on channel 1, and nothing on channel 0.

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
