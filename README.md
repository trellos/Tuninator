# Tuninator

Tuninator is a browser library that turns guitar microphone input into **musical events**.

It generates a `Note` object when a pitch is detected. As Tuninator listens to more audio it refines that note--possibly blooming into a chord, a bend to a different pitch, and tracking the end. Events are generated for each change.

Tuninator is written in TypeScript without runtime dependencies. Audio capture runs in an `AudioWorklet`. The recognition engine runs on the main thread by default and can be moved to a Web Worker.

This is just a little library I made to help write guitar stuff. If it helps you do something rad please reach out. If you know more about audio processing and see it doing boneheaded things, also please reach out.

## Install

```bash
npm install tuninator
```

Capture runs in an `AudioWorklet`, which loads by URL — so copy the prebuilt worklet into your
static assets and point `workletUrl` at it. Bundlers will not do this for you:

```bash
cp node_modules/tuninator/dist/tuninator-worklet.js public/assets/
```

## Usage

```ts
import { createRecognizer } from "tuninator";

const recognizer = createRecognizer({
  workletUrl: "/assets/tuninator-worklet.js",
});

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

recognizer.on("noteEnded", (note) => console.log("ended", note.id, note.endTime));
recognizer.on("error", (error) => console.error(error.code, error.message));

// Must be called from a user gesture: the browser will not open a microphone
// or resume an AudioContext without one.
await recognizer.start();

// When you're done:
await recognizer.stop();     // every open Note still gets its noteEnded
await recognizer.dispose();  // stop, then release the mic and worklet
```

`on()` returns its own unsubscribe function.

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

## Docs

- [**API reference**](docs/API.md) — methods, options, error codes, `PitchFrame`, timestamps,
  running the engine in a Worker, multi-channel interfaces, and the worklet asset in full.
- [**The Note model**](docs/NOTE-MODEL.md) — why a bend is one Note and a re-pick is two, how
  chords bloom, and how the recognizer works underneath.
- [**Evaluation**](docs/EVALUATION.md) — what it gets right and wrong, measured against 459
  hand-labelled events.
- [**Migrating from 0.1**](docs/MIGRATION.md)

## License

MIT

## Example app

A working browser demo — mic start/stop, live frequency and cents, a scrolling
canvas timeline driven by a metronome clock, and a mock stream (`?mock=1`) for
developing without a microphone — lives in its own repository:
**[trellos/Tuninator-Example](https://github.com/trellos/Tuninator-Example)**.

It consumes this library through its public entry point only.
