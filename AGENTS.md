# AGENTS.md

Orientation for coding agents working in this repository. Written to be read in
full before the first edit.

`README.md` is the *consumer-facing* document — install, usage, API reference.
This file is the *contributor-facing* one: the invariants, the reasoning behind
the design, and the measured state of the detector. Where the two disagree on
numbers, this file and `npm run eval` are authoritative (see
[Doc drift](#doc-drift)).

---

## 1. What this project is

Tuninator is a **UI-free, ESM, TypeScript browser library** that turns guitar
microphone input into two streams:

| Stream | Shape | Rate | For |
|---|---|---|---|
| `pitchFrame` | `PitchFrame` | one per hop (~13.3ms) | tuners, meters, anything continuous |
| `MusicEvent` | `MusicEvent` + start/update/end | one per musical event | games, practice tools, scoring |

Zero runtime dependencies. Detection runs in an `AudioWorklet`, off the main
thread.

### The driving requirement

> The detector must be **proven against recorded guitar, not synthetic sine
> waves**, via a repeatable `npm run eval` that fails loudly on regression.

This is the reason for most of the architecture. A detector that scores well on
generated sine waves and falls apart on a strummed open G is worthless, so the
benchmark is five real recordings with hand-written ground truth, and the eval
harness runs **the exact code the browser runs**.

### Non-goals

- **No UI.** No DOM, no canvas, no CSS. The demo lives in a separate repository
  (§9) and in `examples/browser-demo/`.
- **No audio output.** Nothing here plays, records, or renders audio. The
  metronome in the demo is the demo's own.
- **No tablature, notation, or transcription.** The output is events, not a
  score.
- **No model files.** Everything is deterministic DSP; there is no training
  step, no weights, and no network access at runtime.

---

## 2. Repo map

```
src/types.ts            public type surface — types only, emits no runtime code
src/index.ts            the ONLY public entry point
src/tuninator.ts        main-thread: state machine, getUserMedia, AudioContext, worklet wiring
src/emitter.ts          tiny typed emitter; on() returns its own unsubscribe

src/core/               the shared DSP kernel — see §3, the load-bearing rule
  policy.ts             per-mode parameter sets; plain JSON-shaped data
  yin.ts                YIN pitch detection + octave-error mitigation
  pitch-engine.ts       ring buffer, dual-window YIN, hop scheduling -> PitchFrame
  onset.ts              spectral flux with an adaptive median threshold
  fft.ts                radix-2 real FFT (1024-pt for onsets, 4096-pt for chroma)
  chroma.ts             harmonic-whitened chroma (HPCP) with harmonic cancellation
  chords.ts             chord dictionary, template match, honest-abstention rule
  notes.ts              frequency <-> MIDI <-> name <-> cents
  event-tracker.ts      PitchFrame + onsets -> MusicEvent lifecycles
  channel-select.ts     which input channel to listen to (windowed, hysteretic)

src/worklet/processor.ts  AudioWorkletProcessor wrapping the kernel; bundle entry
src/offline/              the same kernel, driven from Node
  analyzer.ts             feeds 128-sample blocks, exactly like the worklet
  matcher.ts              label <-> detection matching and scoring; no audio at all
  wav.ts                  minimal WAV reader/writer

fixtures/audio/         five real guitar recordings (READ-ONLY)
fixtures/labels/        hand-written ground truth  (READ-ONLY — see §3)
fixtures/eval.config.json  thresholds and gates per fixture

scripts/eval.ts             the harness: decode -> analyze -> match -> score
scripts/decode-fixtures.ts  ffmpeg-static -> .cache/fixtures/*.wav, mtime-cached
scripts/assert-worklet-bundle.mjs  fails the build if the bundle has import/export
scripts/clean-dist.mjs      single clean step; a per-tsup-config clean races

tests/                  vitest, 289 tests across 10 files
examples/browser-demo/  in-repo Vite demo (the published demo is a sibling repo)
.cache/                 gitignored: decoded audio, eval report, traces, scratch
```

---

## 3. Invariants — do not break these

These are the rules that hold the project together. Each one has a failure mode
that is invisible until much later, which is why they are stated rather than
left to taste.

### 3.1 `src/core/` purity

**`src/core/` must be importable by the browser worklet, by Node, and by Vitest
with byte-identical behaviour.**

No `window`, no `document`, no `AudioContext`, no `performance`, no `Date.now`,
no `node:*`, no npm imports, no top-level side effects. Pure functions and
classes over `Float32Array`, with sample rate and timestamps **passed in**.

Why it matters: the offline eval is trustworthy *only* because it runs this
exact code. There is deliberately no separate "offline detector". The moment
`core/` can tell which environment it is in, every eval number becomes a claim
about the harness rather than about the product.

`src/offline/analyzer.ts` feeds samples in **128-sample blocks** — the
`AudioWorklet` render quantum. Do not change `RENDER_QUANTUM` to make the eval
run faster; it would decouple eval results from live behaviour.

### 3.2 `fixtures/labels/*.json` is ground truth

**Never edit a label file to make the eval pass.** This is the single rule that
keeps the benchmark meaningful — a detector that is allowed to rewrite its own
exam has no score.

When the detector confidently disagrees with a label, the harness writes the
evidence to `.cache/proposed-label-corrections.json` for a human to judge. It
does not apply it.

A label may be corrected **only** on an explicit human instruction describing
what was actually played, and the correction must describe the recording, never
the detector's output. Do not invent fields the detector does not produce
(no `strum`, no guessed voicings) — a label file states what was played and
when, and nothing else.

The sanctioned way to relax a fixture is `fixtures/eval.config.json`: mark a
section `required: false`, visibly and by configuration, with a note saying
why. Its numbers are still reported.

### 3.3 The worklet bundle has no `import`/`export`

`AudioWorkletGlobalScope` has no module loader on older targets, so
`dist/tuninator-worklet.js` is built as a single self-contained IIFE.
`scripts/assert-worklet-bundle.mjs` fails the build if a module statement
survives. A stray import fails *only* at runtime in the browser, with a
`worklet-load-failed` error that looks like a wrong URL — hence the build-time
assertion.

### 3.4 `src/types.ts` is a fixed public surface

It is types-only and must emit no runtime code, so it can be imported from the
main thread, the worklet bundle, and Node without pulling anything into any of
them.

Additions must be **optional and non-breaking**, and should be flagged for
review when made. Four such additions exist today and are still unreviewed:
`PitchFrame.channelRms`, `PitchFrame.selectedChannel`,
`TuninatorOptions.input.channelCount`, `TuninatorOptions.input.channels`.

### 3.5 `src/index.ts` is the only entry point

Anything reachable only by reaching into `tuninator/src/**` is an API bug, not a
workaround.

### 3.6 Tuned constants are measured, not chosen

Every number in `src/core/policy.ts` was picked by measuring against the
fixtures. When you change one, **record the measurement** — the before/after on
the affected fixtures — in the comment or the commit message. Several constants
carry their sweep table in a comment; keep that habit.

Corollary: a change that improves one fixture and silently degrades another is
a regression. Run the full eval, not the one fixture you are working on.

### 3.7 `setMode()` never restarts the audio graph

Modes swap parameters in place. The audio graph, the ring buffer, and any
in-flight event all survive. A consumer written against `MusicEvent` keeps
working in all four modes because modes change detection *policy*, never the
event model.

---

## 4. Architecture

### 4.1 Signal path

```
getUserMedia (stereo requested)
  └─ MediaStreamAudioSourceNode
       └─ AudioWorkletNode  channelCountMode:"max"  channelInterpretation:"speakers"
            └─ TuninatorProcessor.process()          [128-sample render quanta]
                 ├─ per-channel RMS metering (before mixing)
                 ├─ ChannelSelector -> analyse one channel, or sum
                 └─ PitchEngine.push(block, t)        [ring buffer]
                      └─ every hop:
                           ├─ YIN short (512)  ┐
                           ├─ YIN long (2048)  ┴─> pitch + confidence
                           ├─ spectral flux    ---> onset flag
                           └─ chroma (4096)    ---> chord candidates
                      └─ PitchFrame
                 └─ EventTracker.process(frame) -> start/update/end emissions
            └─ port.postMessage  (ONE message per hop, not per quantum)
       └─ main thread: Emitter -> "pitchFrame" / "musicEvent*" handlers
```

The Node path is identical from `PitchEngine` down; `src/offline/analyzer.ts`
replaces only the block source.

### 4.2 Window and hop are decoupled

A ring buffer accumulates input and every hop the detector analyses the most
recent N samples. One period of low E (82.4Hz) is ~582 samples and YIN needs
roughly two, so the long window is 2048 samples (~43ms) even though the hop is
~12ms.

The requested `pitchHopMs: 12` is **snapped to whole 128-sample render quanta**:
at 48kHz that is 640 samples = **13.333ms**. Timings in the eval land on that
grid, so a 12ms figure in a label is not achievable and should not be expected.

### 4.3 Dual-window YIN

Both windows run every hop — 512 and 2048 samples — and the short one wins
whenever it is confident above `shortWindowMinHz` (300Hz), where it genuinely
spans two periods. In the fixtures, timing pressure and pitch range are
inversely correlated: slow quarter notes are low (123–220Hz) and need the long
window; 125ms sixteenths are high (440–554Hz), where two periods is ~200
samples. This buys ~7× better time resolution on fast high passages without
breaking low notes.

### 4.4 Octave-error mitigation

YIN's known failure mode on guitar. Four mitigations stack:

- prefer the *first* CMND dip below threshold, not the global minimum;
- a sub-harmonic check preferring the higher octave when half the lag is equally
  periodic;
- an independent zero-crossing estimate — a ~2× disagreement halves confidence,
  because ZCR fails differently than YIN does;
- a temporal median over recent voiced frames, so one bad frame cannot create a
  spurious event.

**Five further discriminators were tried and rejected** (CMND ratio, scaled
residual, spectral partial, raw d-ratio, interpolated d-ratio). None separated a
real low-B case from a synthetic alternating-sawtooth trap without breaking pure
sines. See §6.1 before attempting a sixth.

### 4.5 Event segmentation

State machine: `attack → sustain → (bend) → release → ended`.

Three rules the eval depends on:

- **A re-picked note is two events.** An onset forces a new event even when the
  pitch is unchanged.
- **A legato pitch step is also two events.** The pick never re-attacks in a
  fast run, so spectral flux stays flat; onset-driven splitting alone would
  merge 24 triplets into a handful of events.
- **A bend is ONE event.** `label.name` keeps the origin note and `bend` records
  the excursion.

Total displacement cannot distinguish a 200-cent bend from a 200-cent legato
step — both are two semitones. The discriminator is the **per-hop rate**
(`pitch.stepThresholdCents`, 70): a bend glides through the intermediate cents
over tens of frames, a fretted step jumps within one or two.

Two subtleties that were bugs and are now load-bearing:

- `isGliding()` must include the **current** frame, not just history. History
  alone measured 24.4 cents against a 25-cent gate and the bend split into four
  events.
- Stability is measured as `lastVoicedAt - startedAt`, **not** on wall-clock.
  On wall-clock, a 24ms blip crossed the 45ms gate while in release grace.

### 4.6 Chords

Chroma is harmonic-whitened (HPCP): Hann → FFT magnitude → whitening against a
proportional-bandwidth moving mean of *log* magnitudes → peak picking with
parabolic interpolation → **iterative harmonic cancellation** over a semitone
grid → fold to 12 pitch classes. Every partial is spent once, so an overtone
cannot also be read as a note; a plain fold turns every power chord into a
ninth.

`FUNDAMENTAL_STOP_RATIO` in `chroma.ts` (currently **0.22**) is the single most
sensitive chord constant — it decides how far down the salience list harmonic
cancellation keeps looking. It carries its sweep table in a comment.

Chord labelling is **root-first score-weighted voting** across the event's hops
(`event-tracker.ts`), requiring `MIN_CHORD_EVIDENCE_HOPS = 5` before committing.
Below that the evidence is a flash and the answer is `unknown`.

**Honest abstention** is the product guarantee: when the best score is below
`floor`, or the gap to the best rival *root* is below `margin`, the event is
labelled `unknown` and the candidates go to `ambiguity.alternatives`. The margin
is measured against the best rival root with a one-way `isStrictExtensionOf`
guard, so `D7` does not block `D` but `C5` still contests `Cmaj`.

Abstentions are **not** counted as wrong answers, and a detector cannot win by
staying quiet: the accuracy denominator is labels in scope minus abstentions, so
a missed label still counts against it.

### 4.7 Multi-channel input

A 2-in interface is a single **stereo** device to the browser — the Audient iD4
lists as one input called "Analogue 1/2" — so a guitar in input 2 exists only on
channel 1.

Three things follow:

- `input.channelCount` defaults to **2**, as an *ideal* constraint. Chrome opens
  a capture device in mono unless a channel count is asked for, and a channel
  that never reaches the page cannot be recovered later. Ideal rather than
  `exact` so a genuinely mono microphone still opens and reports `1`.
- The worklet **selects the loudest channel** rather than reading channel 0.
  Summing looks like the safe default and is not: two captures of one source (a
  DI plus a mic on the cab) sum into a **comb filter**. One metre of air is
  ~3ms — half a period of 166.7Hz — so around E3 the odd harmonics cancel and
  the detector confidently reports the octave. Measured on E3 (164.81Hz) with a
  3ms delay: summed → **332.0Hz (+1213 cents)**, either channel alone →
  **164.9Hz**.
- `PitchFrame.channelRms` reports each channel's level *before* mixing, and
  `selectedChannel` reports what is actually being analysed. The latter cannot
  be inferred from the former: selection is hysteretic, so the loudest channel
  in any single frame is routinely not the selected one.

Selection rules (`core/channel-select.ts`): decided over **250ms** windows, not
per hop; a challenger must beat the incumbent by **6dB for 3 consecutive
windows** (750ms) to switch, while the *first* choice has no margin requirement;
windows under `analysis.rmsGate` are discarded so **silence never latches**; a
latched choice survives silence; mono short-circuits to no per-hop work at all.
Until a decision latches the channels are **summed** — a sum can be a poor
signal, but it cannot miss an instrument.

---

## 5. Public API

Full surface: [`src/types.ts`](src/types.ts). Consumer prose: `README.md`.

```ts
import { createTuninator } from "tuninator";

const t = createTuninator({
  mode: "lead",
  workletUrl: "/assets/tuninator-worklet.js",
});

t.on("pitchFrame", (f) => { /* f.frequencyHz, f.nearest, f.confidence */ });
t.on("musicEventStart", (e) => { /* e.label.name, e.kind, e.confidence */ });
t.on("error", (e) => { /* e.code, e.message */ });

await t.start();   // must be called from a user gesture
```

### Interface

| Member | Notes |
|---|---|
| `start(): Promise<void>` | Idempotent while starting/listening. Failures emit `error`, they do not throw. |
| `stop(): void` | Releases every track — this is what turns the browser's recording indicator off. |
| `setMode(mode): void` | Safe while listening. Never restarts the graph. |
| `getMode()` / `getState()` | `TuninatorMode` / `TuninatorState` |
| `getActiveEvents(): MusicEvent[]` | Every event not yet ended, mirrored main-side. |
| `on(name, handler): () => void` | Returns its own unsubscribe. There is no `off()` to get wrong. |

Events: `stateChange`, `status`, `pitchFrame`, `musicEventStart`,
`musicEventUpdate`, `musicEventEnd`, `error`.

States: `idle → starting → (waiting-for-user-gesture) → listening`; `stop()`
returns to `idle`; any failure goes to `error`.

### Modes

| Mode | Behaviour |
|---|---|
| `lead` *(default)* | Monophonic, high stability requirement, chords off. |
| `chords` | Chroma path on, longer stability windows (`minStableMs` 120, `releaseGraceMs` 160), lower onset sensitivity. |
| `rhythm` | Onset-driven; emits events on attacks even when pitch is uncertain (`kind: "unknown"`). |
| `raw` | Near-passthrough: `minStableMs` 0, `medianFrames` 1, onsets off. |

### Errors

`mic-permission-denied`, `mic-unavailable`, `audio-context-failed`,
`worklet-unavailable`, `worklet-load-failed`, `unknown`. Failures set state to
`error` **and** emit an `error` event; they never reject `start()`.

`worklet-load-failed` is the #1 integration failure and is almost always a wrong
`workletUrl`. The asset must be copied into the host's static files —
bundlers do not copy it, because it is loaded at runtime by URL rather than
imported.

### Defaults

```ts
input:    { channelCount: 2, channels: "auto",
            echoCancellation: false, noiseSuppression: false, autoGainControl: false }
analysis: { minFrequencyHz: 70, maxFrequencyHz: 1400, pitchHopMs: 12,
            rmsGate: 0.008, confidenceGate: 0.35 }
tracking: { minStableMs: 45, releaseGraceMs: 90, bendThresholdCents: 45 }
```

The microphone processors default to **off** on purpose: `echoCancellation`,
`noiseSuppression`, and `autoGainControl` are tuned for speech and chew holes in
a sustained guitar note.

`confidenceGate: 0.35` is measured, not guessed. At 0.5 the detector dropped
frames mid-note on decaying low strings, which read as note-offs and split notes
in two — clean-lead pitch-class accuracy 72.1% → 79.1%, missed 9 → 6.

---

## 6. Evaluation and current state

```bash
npm run eval                                       # decode, grade, exit nonzero on required failures
npx tsx scripts/eval.ts --trace clean-lead-120bpm  # per-hop CSV of detector internals
npx tsx scripts/eval.ts --force-decode             # ignore the mtime cache
```

Outputs go to `.cache/`: `eval-report.json` (machine-readable),
`proposed-label-corrections.json`, `trace-<fixture>.csv`.

The harness decodes each fixture with bundled ffmpeg, runs the real chain in
128-sample blocks, matches detections to labels **one-to-one and greedily**, and
exits nonzero when a `required` fixture misses a threshold.

Exact and pitch-class accuracy are reported **separately** on purpose: a large
gap between them points at the labels, a low pitch-class number points at the
detector.

### Current results

**`npm run eval` currently exits 1.** Measured 2026-08-18 at `d8e4141`:

| Fixture | Mode | Gate | Result | Labels | Det. | Matched | Missed | FP | Exact | Pitch class | Onset median |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `chords-a-bm-g-d-2x-120bpm` | chords | required | **PASS** | 16 | 13 | 13 | 3 | 0 | **75.0%** | 81.3% | 13.7ms |
| `clean-lead-120bpm` | lead | required | **FAIL** | 43 | 42 | 34 | 9 | 8 | 67.4% | **72.1%** | 106.5ms |
| `cowboy-chords-…` | chords | informational | PASS | 8 | 15 | 8 | 0 | 7 | 75.0% | 87.5% | 93.5ms |
| `power-chords-…` | chords | required | **FAIL** | 8 | 11 | 8 | 0 | 3 | **87.5%** | 100.0% | 140.0ms |
| `spicy-chords-cmaj9-g-am11` | chords | informational | PASS | 3 | 8 | 3 | 0 | 5 | 33.3% | 100.0% | 36.7ms |

Columns are **overall** figures; the gates are evaluated on each fixture's
*gated subset* (`clean-lead` excludes its sixteenths section), so the pass/fail
verdict does not always follow from the numbers shown here.

Failing gates:

- `clean-lead-120bpm` — `minLabelAccuracy (pitchClass)` **71.0% < 90%** and
  `maxFalsePositives` **7 > 3**, both on the gated subset.
- `power-chords-…` — `maxMedianOnsetErrorMs` **140.0 > 120**.

Everything else passes. Do not treat "2 required failures" as a broken build —
it is the honest, documented state, and the two failures are §6.1 problems, not
oversights.

---

## 6.1 Known limitations

Read this before starting work; several of these have already consumed an
attempt.

**The low-B octave error is unsolved and may not be solvable within a frame.**
The detector reads a clean 245.7Hz (`B3`) at confidence 0.89, CMND 0.022, with
the independent zero-crossing estimate agreeing at 247.8Hz. Five discriminators
were tried and all failed to separate the real case from a synthetic trap
without breaking pure sines (§4.4). A genuine fix needs **pYIN-style cross-frame
Viterbi decoding** over a pitch lattice, not another within-frame heuristic.
Do not add a sixth threshold.

**Fast legato runs over-segment.** This is the root cause of *both*
`clean-lead` failures — the low pitch-class accuracy and the false positives.
Separating "one note, re-picked" from "two notes slurred" comes down to a flux
spike that may simply not be there. The 125ms sixteenths section is excluded
from the required gate, visibly and by configuration.

**Chord onsets lag.** `power-chords` is 140ms against a 120ms threshold, because
it is 2-second bars of continuous strumming with no silence between them — the
detector must segment on chord *change*, not on attack.

**Abstention is currently never exercised.** The abstention machinery is intact
(`floor`/`margin` in `chords.ts`, `MIN_CHORD_EVIDENCE_HOPS` in
`event-tracker.ts`), but the root-first voting now commits on all five fixtures:
**0.0% abstention across the board**. The `spicy-chords` gate
(`maxFalseLabels: 0`) still passes, so nothing is confidently wrong — but the
"honest `unknown`" guarantee is presently unproven by the benchmark. Treat a
change that starts producing abstentions as a *behaviour* change to measure, not
automatically a regression.

**A decayed third makes any triad look like a power chord.** Guitar voicings
sound the third once while doubling root and fifth. D major is the worst case:
its F#4 third (high E string, 2nd fret) decays below the peak floor ~250ms in,
so the third is genuinely absent from the spectrum. `G → G5` and `Em → E5` share
this cause. This is physics, not a bug to threshold away.

**`cowboy-chords` carries one accepted confidently-wrong label** (`c2`, labelled
`D`, detected `Asus4` at 0.911). It was accepted deliberately: that event had 12
consecutive confident `Asus4` hops at 0.991 and previously said `unknown` only
because its final hop fell below margin — luck, not judgement. Flagged rather
than hidden.

**The labels state their own uncertainty.** *"Octaves are first-pass estimates;
pitch-class intent comes from the player's description."* Eleven confident
disagreements are currently written to
`.cache/proposed-label-corrections.json`. That is evidence for a human, not a
verdict.

**Offline eval feeds mono.** `PitchFrame.channelRms` and `selectedChannel` are
absent in the harness, so the channel-selection path is covered by unit tests
(`tests/channel-select.test.ts`) rather than by the fixtures.

### Held / open work

- An `rmsGate` sweep (0.0005–0.032) is written but deliberately **not run** — it
  should be anchored to a reading from a real rig, not to the existing fixtures
  alone.
- Calibration recordings on a second guitar and signal chain are pending; see
  `.cache/recording-spec.md`.
- The four `src/types.ts` additions in §3.4 are unreviewed.

---

## 7. Working in this repo

```bash
npm install
npm run build      # library ESM+dts, plus dist/tuninator-worklet.js as one self-contained file
npm test           # vitest — 289 tests, 10 files
npm run typecheck  # tsc --noEmit
npm run eval       # the one that matters
```

Before proposing any detector change as done: **`npm test` && `npm run typecheck`
&& `npm run eval`**, and compare the eval table against the one in §6. A change
that moves any fixture needs its numbers quoted.

### Conventions

- Comments explain *why*, especially where a constant was measured or a simpler
  approach was tried and failed. Match that density; this codebase is unusually
  comment-heavy on purpose, because most of its constants are non-obvious and
  every one of them has a story.
- `detect()` in `yin.ts` and the FFT paths are **allocation-free** — buffers are
  preallocated in constructors. Keep it that way; this runs on the audio thread.
- `Policy` crosses the worklet port as a structured clone, so it must stay
  JSON-shaped: no functions, no class instances.
- Audio filenames contain spaces, and one contains a **double** space
  ("Cowboy  chords …"). Never reconstruct a filename from a label title — read
  the label's `sourceAudio` and resolve it relative to the label file's
  directory. Paths go to ffmpeg as argv array elements, never through a shell
  string.
- `.cache/` is gitignored. Put scratch, traces, and analysis there.

### Git

Development branch: **`claude/tuninator-orchestration-agent-phcm0m`**. Push with
`git push -u origin <branch>`; retry network failures with exponential backoff.
**Never push to another branch without explicit permission**, and do not open a
pull request unless asked.

---

## 8. Doc drift

`README.md`'s **Evaluation** section (its results table, per-chord breakdown,
and abstention-rate table) predates the chord-voting and channel-selection work
and no longer matches reality — most visibly, it reports abstention rates of
23–44% where the current measurement is 0.0%. Its Install / Usage / API /
Architecture sections are accurate.

§6 of this file and `npm run eval` are the authority. If you touch the detector,
refreshing that README section is fair game and welcome.

---

## 9. Sibling repository

**`trellos/Tuninator-Example`** — the published Vite demo: a scrolling note
timeline and a 90bpm metronome, deployed to GitHub Pages by
`.github/workflows/deploy-pages.yml`. It checks out this library at
`LIBRARY_REF: main` and builds against it, so **a breaking change here breaks
that build**. The workflow triggers on `main` and `workflow_dispatch` only.

`examples/browser-demo/` in this repo is the in-repo equivalent and is not the
thing that gets published.
