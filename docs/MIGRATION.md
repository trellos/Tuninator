# Migrating from the 0.1 pitch detector to the 0.2 recognizer

Tuninator 0.1 was a **pitch detector**: a per-frame YIN pipeline, a tracker that
could hold exactly one active event, and four caller-declared modes.

Tuninator 0.2 is a **streaming musical event recognizer**. The unit is a `Note`,
and a Note is something the system learns about over time: it starts as soon as
there is evidence something was played, and then improves — the pitch is
refined, a bend is recognised as a bend rather than as three notes, a chord
blooms out of what looked like a single pitch. Every improvement arrives as a
typed `NoteChange`, so you can tell "I know more now" from "I was wrong".

This is a breaking 0.x rewrite. **There are no compatibility shims**, and every
symbol the old surface exported is gone. That is deliberate: a shim layer would
have to invent a `MusicEvent.state` for a model that no longer has envelope
states, and inventing data is worse than a compile error.

---

## The mapping, symbol by symbol

| 0.1 | 0.2 | What changed |
|---|---|---|
| `createTuninator(options)` / `Tuninator` | `createRecognizer(options)` / `Recognizer` | renamed; options reshaped |
| `MusicEvent` | `Note` | replaced. One `label` becomes `pitch` + `harmony` + `hypotheses`; `kind` is gone, because a Note blooms rather than being born a chord |
| `musicEventStart` | `noteStarted` | renamed |
| `musicEventUpdate` | `noteChanged(note, change)` | gains a typed `NoteChange` second argument |
| `musicEventEnd` | `noteEnded` | renamed |
| — | `noteResolved` | **new.** Fires once, when the answer settles, before `noteEnded` |
| `MusicEvent.state` (`attack`…`ended`) | `Note.lifecycle` + `NoteChange.type` | envelope states become a recognition lifecycle |
| `MusicEvent.label.name` | `Note.pitch.current.name` or `Note.harmony.chordName` | one field became two, because a Note can be either |
| `MusicEvent.primaryPitch` | `Note.pitch.current` | `DetectedPitch` requires `midi`/`name`/`pitchClass`/`octave`; the old `EventPitch` had them all optional |
| `MusicEvent.pitches[]` | `Note.harmony.detectedPitches[]` | register-preserving, and only present once harmony has bloomed |
| `MusicEvent.ambiguity.alternatives` | `Note.hypotheses.active` / `.trail` | a flat list of runner-ups becomes stateful hypotheses with history |
| `MusicEvent.confidenceParts` | `Note.pitch.confidence`, `Note.harmony.confidence`, `Note.confidence` | per-facet; the fields nothing ever wrote are gone |
| `MusicEvent.bend.{isActive,centsFromStart,semitonesFromStart}` | `Note.bend.{active,direction,amountCents,peakAmountCents,releaseDetected,confidence}` | enriched; `Note.bend` is absent until there is a bend |
| `MusicEvent.startedAt/updatedAt/endedAt` | `Note.startTime` / `Note.endTime` | `updatedAt` is gone; use `revision.revisionNumber` |
| `setMode()` / `getMode()` / `TuninatorMode` | **removed** | see below |
| `TuninatorOptions.analysis` / `.tracking` | `RecognizerOptions.engine` (`EngineTuning`) | one flat tuning object |
| `stop(): void` | `stop(): Promise<void>` | now flushes; awaiting it guarantees every open Note got its `noteEnded` |
| — | `dispose(): Promise<void>` | **new.** Releases the microphone, worklet and any context the recognizer created |
| `getActiveEvents()` (0 or 1) | `getActiveNotes()` | genuinely plural — Notes can overlap now |
| — | `getNote(id)` | **new.** Answers for active Notes and recently ended ones |
| — | `getTimebase()` | **new.** Relates `SourceTimeMs` to `AudioContext.currentTime` |
| `TuninatorError` (plain object) | `class RecognizerError extends Error` | throwable, `instanceof`-able, carries a stack |
| `TuninatorState` `waiting-for-user-gesture` | `RecognizerState` `stopping` | the gesture state was never emitted; `stopping` is real |
| `PitchFrame.detector.effectiveSampleRate` | removed | it always equalled the context sample rate |

## The timestamp epoch changed

This is the change most likely to be silently wrong rather than loudly broken.

- **0.1** timestamped everything with `AudioContext.currentTime * 1000`. If your
  context had been alive for 90 seconds before `start()`, your first event's
  `startedAt` was ~90000.
- **0.2** uses `SourceTimeMs`: milliseconds of **source audio since the first
  processed sample**, derived only from sample count ÷ sample rate. Your first
  Note starts near 0, every time.

That is what makes an offline run over a WAV and a live run over the same audio
agree exactly — there is no wall clock anywhere in the engine. If you need to
line Notes up against your own `AudioContext`-scheduled events, `getTimebase()`
returns `{ sampleRate, originContextTime }`, where `originContextTime` is
`AudioContext.currentTime` at source time 0:

```ts
const { originContextTime } = recognizer.getTimebase()!;
const contextTime = originContextTime + note.startTime / 1000;
```

## Modes are gone, and nothing replaces them

`setMode("lead" | "chords" | "rhythm" | "raw")` asked the caller to declare in
advance what the player was about to do. It got the wrong answer whenever they
were wrong: `chords` and `lead` ran genuinely different code, so a chord played
in lead mode was never a chord, and a single note played in chord mode was
matched against 120 chord templates.

One recognizer now runs the whole time. Segmentation is driven by evidence — an
attack, a pitch step, a harmony change — and a Note **blooms** into a chord when
the deep lane finds evidence for one. So:

```ts
// 0.1
recognizer.setMode(userPickedChords ? "chords" : "lead");
if (event.kind === "chord") showChord(event.label.name);
else showNote(event.label.name);

// 0.2 — no mode to pick, and the Note tells you what it turned out to be
if (note.harmony) showChord(note.harmony.chordName ?? "…");
else showNote(note.pitch.current?.name ?? "…");
```

`note.harmony` present with `chordName` **undefined** is honest abstention: the
recognizer knows it is a chord and will not guess which one. Render that as
"…", never as a chord name you picked yourself.

## Subscription-by-subscription

### Construction

```ts
// 0.1
const tuninator = createTuninator({
  mode: "lead",
  workletUrl: new URL("tuninator-worklet.js", import.meta.url),
  analysis: { rmsGate: 0.01 },
  tracking: { minStableMs: 60 },
});

// 0.2
const recognizer = createRecognizer({
  workletUrl: new URL("tuninator-worklet.js", import.meta.url),
  engine: { rmsGate: 0.01, minStableMs: 60 },
  diagnostics: { pitchFrames: true },   // the pitch stream is now opt-in
});
```

### `musicEventStart` → `noteStarted`

```ts
// 0.1
tuninator.on("musicEventStart", (event) => {
  addRow(event.id, event.label.name, event.startedAt);
});

// 0.2
recognizer.on("noteStarted", (note) => {
  addRow(note.id, note.harmony?.chordName ?? note.pitch.current?.name ?? "…", note.startTime);
});
```

### `musicEventUpdate` → `noteChanged`

The second argument is the reason, and it is the point of the change. An
enrichment should slide in; a correction should replace, and can explain itself
from `change.previous`.

```ts
// 0.1 — one undifferentiated update
tuninator.on("musicEventUpdate", (event) => {
  updateRow(event.id, event.label.name, event.confidence);
});

// 0.2
recognizer.on("noteChanged", (note, change) => {
  switch (change.type) {
    case "harmonyEnrichment":                 // C -> Cmaj7: still true, sharper
    case "pitchRefinement":
      updateRow(note.id, labelOf(note));
      break;
    case "harmonyCorrection":
    case "pitchCorrection":                   // was wrong; say so
      replaceRow(note.id, labelOf(note), change.previous?.label);
      break;
    case "bendUpdate":
      updateBend(note.id, note.bend!.amountCents);
      break;
    case "hypothesisPromoted":
    case "hypothesisDiscredited":
      updateAlternatives(note.id, note.hypotheses.active);
      break;
    case "structuralRevision":                // the Note's extent changed
      relayout(note.id, change.relatedNoteIds ?? []);
      break;
    default:
      updateConfidence(note.id, note.confidence);
  }
});
```

### `noteResolved` — new

Fires once per Note, when the answer has settled and further evidence would have
to actively contradict it. This is the moment to commit a UI element from
"provisional" to "final", and it always precedes `noteEnded`.

```ts
recognizer.on("noteResolved", (note) => markSettled(note.id));
```

### `musicEventEnd` → `noteEnded`

```ts
// 0.1
tuninator.on("musicEventEnd", (event) => closeRow(event.id, event.endedAt));

// 0.2
recognizer.on("noteEnded", (note) => closeRow(note.id, note.endTime));
```

### `pitchFrame`

Unchanged in shape apart from `timestamp` now being `SourceTimeMs` and
`detector.effectiveSampleRate` being gone — but it is now **opt-in**. Pass
`diagnostics: { pitchFrames: true }` or you will never receive one.

### `stateChange`, `status`, `error`

`stateChange` loses `waiting-for-user-gesture` (never emitted) and gains
`stopping`. `error` now receives a real `Error`:

```ts
// 0.1
tuninator.on("error", (error) => show(error.code, error.message));

// 0.2 — same fields, but you can also throw it, and it has a stack
import { RecognizerError } from "tuninator";
recognizer.on("error", (error) => {
  if (error instanceof RecognizerError && error.code === "mic-permission-denied") {
    showPermissionHelp();
  }
});
```

### Transport

```ts
// 0.1
button.onclick = () => { tuninator.stop(); };   // in-flight events lost

// 0.2 — await it, and every open Note gets its noteEnded first
button.onclick = async () => { await recognizer.stop(); };
window.addEventListener("pagehide", () => { void recognizer.dispose(); });
```

## Overlapping Notes

`getActiveEvents()` returned zero or one event, because the old tracker held
`active: Active | null` and a second note beginning while the first still rang
was structurally impossible. `getActiveNotes()` is genuinely plural. If your UI
assumed a single "current" element, that assumption no longer holds — key your
rows by `note.id`.

## What is additive, not required

None of these are needed for parity with a 0.1 integration, but they are the
reason the rewrite exists:

- `note.hypotheses.trail` — what the recognizer considered and rejected, with
  the reason in each entry's `state`. This is what to show when a player
  disagrees with the answer.
- `note.harmony` blooming — a Note that started as a single pitch acquiring a
  chord identity, delivered as `harmonyEnrichment`.
- `note.bend` — direction, current and peak excursion, and whether the bend has
  been released.
- `note.pitch.contour` — the frequency trajectory, under
  `diagnostics: { contour: true }`.
