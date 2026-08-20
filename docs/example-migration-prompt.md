# Ready-to-paste prompt: migrate Tuninator-Example to the 0.2 recognizer

The browser demo's real home is the separate repository `trellos/Tuninator-Example`,
which this repository's session could not reach. Everything that session needs
is below, written to stand alone — it cannot see this repo's history.

Open a Claude Code session against `trellos/Tuninator-Example` and paste
everything from the horizontal rule down.

---

You are migrating this demo from Tuninator 0.1 to Tuninator 0.2. The library was
rewritten from a **pitch detector** into a **streaming musical event
recognizer**. Every symbol the demo touches has changed. There are no
compatibility shims, so this is a compile-error-driven migration and the
compiler will find most of it for you.

## Checkout constraint

The demo resolves `tuninator` to a sibling checkout (`"tuninator":
"file:../Tuninator"`, with a Vite alias to `../Tuninator/src/index.ts`). Clone
`trellos/Tuninator` next to this repo, on branch
`claude/guitar-event-recognizer-refactor-t5g5yr`, and build it (`npm install &&
npm run build`) before starting. If the alias points at `src/index.ts` rather
than `dist`, no build is needed for types, but `dist/tuninator-worklet.js` must
exist for the demo to run.

## The new public API, verbatim

```ts
import { createRecognizer, RecognizerError } from "tuninator";
import type {
  Note, NoteChange, NoteChangeType, NoteLifecycle,
  DetectedPitch, Hypothesis, PitchFrame, PitchClass,
  Recognizer, RecognizerOptions, RecognizerState, SourceTimeMs, Timebase,
} from "tuninator";

interface Recognizer {
  start(): Promise<void>;            // rejects with RecognizerError
  stop(): Promise<void>;             // flushes: every open Note gets noteEnded
  dispose(): Promise<void>;          // stop + release mic/worklet/own context
  getState(): RecognizerState;       // "idle"|"starting"|"listening"|"stopping"|"error"
  getActiveNotes(): Note[];          // genuinely plural — Notes can overlap
  getNote(id: string): Note | undefined;
  getTimebase(): Timebase | null;    // { sampleRate, originContextTime? }
  on<E>(event: E, handler): () => void;
}

type RecognizerEventMap = {
  noteStarted:  (note: Note) => void;
  noteChanged:  (note: Note, change: NoteChange) => void;
  noteResolved: (note: Note) => void;              // NEW: the answer settled
  noteEnded:    (note: Note) => void;
  pitchFrame:   (frame: PitchFrame) => void;       // opt-in diagnostic
  stateChange:  (state: RecognizerState) => void;
  status:       (message: string) => void;
  error:        (error: Error & { code: string }) => void;
};

type RecognizerOptions = {
  audioContext?: AudioContext;       // caller-owned; never closed by us
  workletUrl?: string | URL;
  engineUrl?: string | URL;
  host?: "inline" | "worker";        // "worker" is not available yet; it throws
  input?: {
    deviceId?: string; echoCancellation?: boolean; noiseSuppression?: boolean;
    autoGainControl?: boolean; channelCount?: number;
    channels?: "auto" | "sum" | number;
  };
  engine?: {                         // replaces analysis/tracking; NO mode
    minFrequencyHz?: number; maxFrequencyHz?: number; hopMs?: number;
    rmsGate?: number; confidenceGate?: number;
    minStableMs?: number; releaseGraceMs?: number; bendThresholdCents?: number;
    deepLatencyMs?: number;
  };
  diagnostics?: { pitchFrames?: boolean; contour?: boolean };
};

type Note = {
  id: string;
  startTime: SourceTimeMs;
  endTime: SourceTimeMs | null;
  lifecycle: "started" | "enriching" | "resolved" | "ended";
  origin: {
    firstDetectedPitch: DetectedPitch | null;
    initialConfidence: number;
    trigger: "attack" | "pitchChange" | "rearticulation";
  };
  pitch: {
    currentFrequencyHz?: number;
    current?: DetectedPitch;
    confidence: number;
    contour?: ReadonlyArray<readonly [SourceTimeMs, number, number]>;
  };
  bend?: {
    active: boolean; direction: "up" | "down";
    amountCents: number; peakAmountCents: number;
    releaseDetected: boolean; confidence: number;
  };
  harmony?: {                        // absent until the Note blooms into a chord
    root?: PitchClass; bass?: DetectedPitch;
    quality?: string;                // undefined = honest abstention
    chordName?: string;              // "C", "C/G", "Cmaj9", "C5"
    intervals?: string[];
    detectedPitches?: DetectedPitch[];
    uniquePitchClassCount?: number;
    estimatedVoiceCount?: { value: number; confidence: number };
    confidence?: number;
  };
  hypotheses: { active: Hypothesis[]; trail: Hypothesis[] };
  revision: { lastChangeType: NoteChangeType | null; revisionNumber: number };
  confidence: number;
  amplitude: { rms: number; peak?: number };
};

type DetectedPitch = {
  midi: number; name: string; pitchClass: PitchClass; octave: number;   // all required
  frequencyHz?: number; centsOffset?: number;
  role: "first" | "bass" | "root" | "chordTone" | "unknown";
  confidence: number; salience?: number;
};

type Hypothesis = {
  id: string;
  kind: "pitch" | "harmony" | "bend" | "structure";
  label: string;
  state: "candidate" | "contender" | "leading" | "confirmed"
       | "incorporated" | "superseded" | "discredited";
  confidence: number; peakConfidence: number;
  firstSeenAt: SourceTimeMs; lastUpdatedAt: SourceTimeMs;
  resolvedInto?: string;
};

type NoteChange = {
  type: "confidenceUpdate" | "pitchRefinement" | "pitchCorrection" | "pitchMovement"
      | "bendUpdate" | "pitchAdded" | "pitchRemoved"
      | "harmonyEnrichment" | "harmonyCorrection"
      | "hypothesisPromoted" | "hypothesisDiscredited" | "hypothesisIncorporated"
      | "structuralRevision" | "resolved";
  at: SourceTimeMs;                  // when the EVIDENCE is from; may precede delivery
  revisionNumber: number;
  previous?: { label: string; hypothesisId?: string };
  relatedNoteIds?: string[];
};
```

## Old → new mapping

| 0.1 | 0.2 |
|---|---|
| `createTuninator(opts)` / `Tuninator` | `createRecognizer(opts)` / `Recognizer` |
| `MusicEvent` | `Note` |
| `musicEventStart` / `musicEventUpdate` / `musicEventEnd` | `noteStarted` / `noteChanged(note, change)` / `noteEnded` |
| — | `noteResolved` (new) |
| `event.kind === "chord"` | `note.harmony !== undefined` |
| `event.label.name` | `note.harmony?.chordName ?? note.pitch.current?.name` |
| `event.label.quality` | `note.harmony?.quality` |
| `event.state` (`attack`…`ended`) | `note.lifecycle` + `change.type` |
| `event.primaryPitch?.frequencyHz` | `note.pitch.currentFrequencyHz` |
| `event.pitches[]` | `note.harmony?.detectedPitches ?? []` |
| `event.ambiguity.alternatives` | `note.hypotheses.active` (and `.trail`) |
| `event.ambiguity.polyphony` | `note.harmony?.estimatedVoiceCount?.value` |
| `event.confidenceParts` | `note.confidence`, `note.pitch.confidence`, `note.harmony?.confidence` |
| `event.bend.isActive` | `note.bend?.active` (`note.bend` is absent with no bend) |
| `event.bend.centsFromStart` | `note.bend?.amountCents` |
| `event.bend.semitonesFromStart` | `note.bend!.amountCents / 100` |
| `event.startedAt` / `event.endedAt` | `note.startTime` / `note.endTime` |
| `event.updatedAt` | gone — use `note.revision.revisionNumber` |
| `setMode()` / `getMode()` / `TuninatorMode` | **deleted**; there are no modes |
| `getActiveEvents()` | `getActiveNotes()` |
| `stop(): void` | `await stop()` |
| `TuninatorError` (plain object) | `RecognizerError extends Error` |
| `options.analysis` / `options.tracking` | `options.engine` |
| `pitchFrame` always on | opt-in via `diagnostics.pitchFrames: true` |
| `frame.detector.effectiveSampleRate` | removed |
| state `waiting-for-user-gesture` | removed; new state `stopping` |

## Two behaviour changes that are silent, not loud

1. **The timestamp epoch moved.** 0.1 used `AudioContext.currentTime * 1000`, so
   a context alive for 90s gave a first event at ~90000. 0.2 uses `SourceTimeMs`
   — milliseconds of source audio since the first processed sample — so the
   first Note starts near 0. Anything in the timeline that subtracts a
   context-derived "now" from an event timestamp will be wrong by the context's
   age. Use `recognizer.getTimebase()` →
   `{ sampleRate, originContextTime }` to convert:
   `contextTime = originContextTime + note.startTime / 1000`.

2. **Notes can overlap.** `getActiveEvents()` returned 0 or 1. `getActiveNotes()`
   really is plural. Any UI keyed on "the current event" must be keyed on
   `note.id` instead.

## File-by-file work list

### `src/main.ts`
- Replace the `createTuninator` construction: drop `mode`, move `analysis`/
  `tracking` into `engine`, add `diagnostics: { pitchFrames: true }` if the tuner
  readout uses the pitch stream (it does).
- Rename all seven subscriptions (`stateChange`, `status`, `error`,
  `pitchFrame`, `musicEventStart|Update|End`), and add `noteResolved`.
- `noteChanged` now takes `(note, change)`; branch on `change.type` rather than
  treating every update the same.
- Transport: `stop()` is async — `await` it. Add a `dispose()` call on
  `pagehide`/`beforeunload`.
- **Delete both `setMode` call sites and whatever UI selects the mode.** There
  is no replacement; the recognizer decides. If the mode selector is a visible
  control, remove it rather than wiring it to nothing.
- `error` handlers now receive a real `Error`; `error.code` still exists.

### `src/ui.ts`
Per-field reads that must change: `event.kind`, `event.label.name`,
`event.label.quality`, `event.state`, `event.primaryPitch?.frequencyHz`,
`event.bend.isActive`, `event.bend.centsFromStart`,
`event.bend.semitonesFromStart`, `event.ambiguity.polyphony`,
`event.ambiguity.alternatives`, `event.pitches[]`, `event.confidenceParts.*`.
Use the mapping table above.

Two things to get right rather than merely compiling:
- `note.harmony` present with `chordName` **undefined** is honest abstention:
  the recognizer knows it is a chord and will not name it. Render "…" or
  "unknown", never a guess.
- `note.bend` is **absent** when there is no bend. `event.bend.isActive` was
  always present and false; `note.bend?.active` is the equivalent.

### `src/mock-tuninator.ts`
Full rewrite against `Recognizer`/`Note`. It implements the old interface end to
end, so nothing in it survives. It must now:
- expose `start`/`stop`/`dispose`/`getState`/`getActiveNotes`/`getNote`/
  `getTimebase`/`on`, with `stop` and `dispose` async;
- emit `noteStarted` → some `noteChanged` → `noteResolved` → `noteEnded`, in
  that order, with `revision.revisionNumber` increasing;
- use `SourceTimeMs` starting at 0, not context time;
- produce at least one Note that *blooms*: starts with only `pitch`, then gains
  `harmony` via a `harmonyEnrichment` change, so the demo exercises the path;
- produce at least one `pitchCorrection` carrying `change.previous`;
- produce one bend Note with `note.bend` populated;
- keep `hypotheses.active`/`trail` non-empty so the alternatives UI has data.

### `scripts/smoke.mjs`
The probe counters are keyed to the old event names. Rename them to
`noteStarted` / `noteChanged` / `noteResolved` / `noteEnded`, and add an
assertion that at least one Note reached `lifecycle === "resolved"`.

## Additive opportunities (not required for parity)

Worth doing, but not part of "the demo works again":
- Show `note.hypotheses.trail` — what was considered and rejected, with the
  reason in each entry's `state`. This is the most visible new capability.
- Show a Note blooming: render the `harmonyEnrichment` transition rather than
  just the final chord name.
- Use `getActiveNotes()` plurality — overlapping Notes are now representable, so
  the timeline can show a restrum over a still-ringing chord as two rows.
- `note.bend.peakAmountCents` and `releaseDetected` give a fuller bend readout.

## Verification bar

1. `npm run typecheck` and `npm run build` clean.
2. `npm run smoke` passes with the renamed probes.
3. Live check in a browser with a guitar or a recording:
   - a single picked note produces one Note with a pitch name;
   - a strummed chord produces a Note that **blooms** — `harmony` appears on a
     `harmonyEnrichment` change after the Note has already started;
   - stopping mid-note still produces a `noteEnded` for it (this is what
     `stop()` becoming async fixed);
   - no console errors, and no UI element still labelled with a mode.
