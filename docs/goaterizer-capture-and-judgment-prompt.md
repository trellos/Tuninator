# GOATerizer brief: record what the recognizer hears, and stop charging a split note as a Miss

> **STATUS: OPEN — for a session on `trellos/goaterizer`.** Companion to
> `docs/slow-note-splits-loop-prompt.md` in `trellos/Tuninator`, which works
> the library side of the same defect. The two run in parallel and hand off
> through files: this brief produces phone-microphone fixtures the library's
> loop is waiting for, and makes the game stop turning one known library
> defect into a Miss. It was written from a read of `trellos/goaterizer` at
> `d903ccc` (on `tuninator@0.2.0`) on 2026-09-18; re-verify anything below
> against the code before building on it.

Read `AGENTS.md` in the GOATerizer repository in full before your first edit,
and hold to it: §4 (one Tuninator `Note` is one played note; never
re-segment; never invent a Tuninator API), §14 (dev tools write nothing from
a built site), §15 (the verification list), §16 (`type(scope): summary` commit
messages with a body that says why), §17 (a design gap becomes explicit,
provisional, documented tuning data), §18 (do not invent product
requirements), and the decision-logging protocol at the end. `CLAUDE.md` only
points there. Read `src/input/tuninator-provider.ts`, `src/game/judgment.ts`,
`src/game/tutorial.ts`, `src/app/tutorial-mode.ts`, `src/game/input-gate.ts`
and `src/dev/synthetic-guitar.ts` before planning; the DECISION_LOG entries
105, 107, 110 and the input-gate entry are the history that binds this.

---

## 0. Owner's choices

Filled in with the recommended defaults. The owner edits this block before
running the brief; the session implements what it says and nothing more. Where
a choice is a product decision, §17 of `AGENTS.md` applies: it lands as
explicit tuning data, labelled provisional, with a decision entry.

| # | item | choice |
|---|---|---|
| A | Dev-only raw capture of the microphone input to WAV, with a metadata sidecar and a provisional label file built from the target grid (§2) | **yes** — no product question |
| B | Debug-panel readouts: the constraints the browser actually applied, the gate in force with a live A/B against the library default, and a running count of split-shaped events (§3) | **yes** — no product question |
| C | Judge: a same-pitch attack landing inside a pending target's written span continues that target's claim instead of being charged as a wrong note (§4) | **on**, behind a tuning flag |
| D | Judge: an early release inside a pending target's span does not settle the verdict; the verdict settles at the end window using the latest release (§4) | **on**, behind the same flag |
| E | The tutorial gates on the flag's outcome, i.e. a split-but-held note no longer fails a step | follows C and D |

If the owner turns C and D off, §4 is still implemented behind the flag with
its tests and shipped **off**; the measurement in §3 is what will decide it
later.

## 1. Why, in two paragraphs

**What the library needs from the game.** Tuninator's open defect is the
same-pitch tail fragment: one played note comes out as a correctly named Note
plus a short contiguous Note at the same pitch. On the library's own corpus
that splits roughly one slow note in seven on a direct input and one in two
through an amp (`trellos/Tuninator`, `docs/slow-note-splits-loop-log.md`).
Nothing in that corpus was captured on a phone. The game is the only thing
that hears the owner's real rig through the real capture path, and it has no
way to record it: there is no `MediaRecorder`, no file capture anywhere in
`src/`, and the labels editor reads the library's fixtures rather than
making any. Part A closes that.

**What the game does with a split today.** `TargetJudge` claims a target at
the attack and settles it at the release. `#settleOffTime` rules that a note
held for less than half its written length is a **Miss**. A quarter at 120bpm
split 130ms in (0.26 of a 1-beat target) is therefore a Miss for a note played
on time, on the spot; the same-pitch fragment behind it finds no open target
(`#findMatch` skips a pending slot) and is charged as a `WrongNote` — for
playing the right pitch — or steals the next target when one is open. The
tutorial (`game/tutorial.ts`) advances only on a clean pass, so one split
repeats the step. The adapter already honours Tuninator's absorption as a
retraction (DECISION-110), but the library never absorbs a same-pitch tail,
and a retraction that arrived after the release had settled a Miss would not
take the Miss back anyway (the DECISION-110 asymmetry). Parts B and C make
the game count the defect and stop paying for it, without re-segmenting
anything.

## 2. Part A — the capture tool

**Where it lives.** Dev-only, under `src/dev/` beside `synthetic-guitar.ts`,
reachable from the debug panel (`?dev=1`) as a record/stop control, and
usable from the **built** site on a phone: the output is a browser download
(`Blob` + `<a download>`), never a dev-server route. `AGENTS.md` §14 forbids a
path that writes content from a built site, and a phone cannot reach the dev
server's file API anyway.

**How it hears what Tuninator hears.** Tuninator opens the microphone itself
(`createRecognizer().start()` → `navigator.mediaDevices.getUserMedia`, a live
property lookup at call time) and exposes neither the stream nor its source
node. The game's own precedent is the answer: `src/dev/synthetic-guitar.ts`
monkey-patches `getUserMedia` so the recognizer receives a generated stream.
The capture tee patches it the other way — call the original with the
recognizer's own constraints, keep a reference to the returned `MediaStream`,
return it unchanged. Then, on the game's shared `AudioContext`, a second
`MediaStreamAudioSourceNode` from that same stream feeds a capture node.
Prefer an `AudioWorkletNode` that posts `Float32Array` blocks and the context
`currentFrame` of its first block (serve the worklet module the way
`vite.config.ts` already serves Tuninator's); a `ScriptProcessorNode` is an
acceptable dev-only fallback if the worklet asset is more plumbing than the
session can justify — say which was built. Record every channel the track
delivers, at the context's sample rate, unprocessed. Install and uninstall
must compose with the synthetic mic (both patch the same property): define
the order, restore the previous function on uninstall, and cover it with a
test against a fake `mediaDevices`.

**What one capture produces** — one stem, three files, downloaded together:

1. `<stem>.wav` — PCM at the context's sample rate, channel count as
   delivered. 32-bit float is the simplest honest encoding of a
   `Float32Array` and the library's decoder (`ffmpeg`) reads it; 16-bit is
   fine if smaller files matter more than a quiet rig's headroom (the game
   can run the library's gate at 0.00008, about −82dBFS, so do not go below
   16 bits). Write the header yourself; it is forty-four bytes and a test.
2. `<stem>.capture.json` — the sidecar. `userAgent`; the context's
   `sampleRate` and `baseLatency`; `track.getSettings()` in full (this is the
   readout that says whether the phone applied `noiseSuppression` or
   `autoGainControl` regardless of what was asked); the `rmsGate` in force
   and whether it came from a calibration; the latency trim; the tempo, key
   and which screen was running; the context time at the first captured
   sample; the tutorial step boundaries in context time; and the game's own
   event log for the take — every `attack`, `retune`, `release`, `retract`
   the adapter emitted, with context times and pitches, plus the judge's
   verdicts. That log is DIAGNOSTIC: it is what the game saw, and it must
   never be used to place a label (next item).
3. `<stem>.labels.json` — a **provisional** label file in Tuninator's fixture
   schema (`version: 1`, `title`, `sourceAudio: "../audio/<stem>.wav"`,
   `instrument`, `tempoBpm`, `tuning`, `timingNotes`, `events[]` with `id`,
   `startMs`, `endMs`, `kind: "note"`, `label` such as `"A3"`, `pitches`,
   `pitchClasses`, `required: true`; copy the shape from any file under
   `../Tuninator/fixtures/labels/`). Events come from the **target grid**
   only: each target's start and end beat converted to context time by the
   transport, minus the capture origin, in milliseconds; `label` from
   `midiToName` in `src/music/pitch.ts`. `timingNotes` must say, in these
   words or better: grid-derived from the tutorial's targets, not measured
   against the audio; the player's own timing error and the rig's latency
   are in every value; re-time in the labels editor against the waveform
   before use; **no detector output was used**. A label placed from a
   Tuninator `Note` is the circularity both repositories forbid
   (`../Tuninator/AGENTS.md` §3, this repository's §14); the sidecar's event
   log exists so nobody is tempted to read it back into the labels.

**Practicalities.** A running readout (`recording 0:42`, channels, sample
rate) and a hard cap on duration so a forgotten recorder does not eat the
phone's memory; the stem from the screen, tempo, key, device and time
(`tutorial-120bpm-G-iphone-20260918-1432`); a note in `README.md`'s dev-tools
section on how to get the three files off a phone and where they go in the
library (`fixtures/audio/` and `fixtures/labels/`, then
`npx tsx scripts/verify-fixtures.ts` there, then the labels editor here).

**Tests** (pure, no browser): the WAV writer round-trips a known buffer; the
label builder turns a target list plus an origin into events at the right
milliseconds with the right names and refuses to build from anything but
targets; the tee installs over and restores both the real function and the
synthetic mic's patch.

## 3. Part B — readouts and telemetry

- **Applied constraints.** With the tee holding the stream, show
  `getAudioTracks()[0].getSettings()` in the debug panel: `echoCancellation`,
  `noiseSuppression`, `autoGainControl`, `sampleRate`, `channelCount`. This is
  the single most useful number for the library's loop and it costs one row.
- **The gate, with an A/B.** The panel already reports the measured gate;
  add a control that forces the library default (0.008) for the rest of the
  session without forgetting the calibration, so the owner can play the same
  passage at both and read the split counter below. Rebuilding the provider
  on change is what `game-app.ts` already does for a gate change; reuse it.
- **A split counter.** Count, per session and per take, the game-visible
  shape of the library's defect: an `attack` whose pitch equals a **pending**
  target's pitch and whose beat lies inside that target's written span
  (`startBeat` to `startBeat + durationBeats`), arriving after a `release` on
  the attack that claimed it. Show it in the debug panel beside the timing
  log's numbers and write it into the capture sidecar. Also count the
  retractions that later cancel one, so the panel shows how many the library
  took back itself. Keep the definition in one pure function with a test;
  the library's loop will quote it.

## 4. Part C — the judge, behind a flag

**The flag.** One constant in `src/config/tuning.ts` in the house style — a
name, a doc comment that states the rule, the reason, and that it is
provisional (§17) — read by `TargetJudge` through `JudgeOptions` so tests can
set it either way. Default per §0.

**Rule C — same-pitch continuation.** When an attack arrives whose pitch
matches a target that is **pending** (claimed, unjudged) and whose beat lies
inside that target's written span, it is not a wrong note and it does not
look for another target: it continues the claim. The pending record now
carries the continuing attack's id as the one whose release counts, and the
original attack's beat as the attack beat (the verdict's timing is the first
attack's). Emit nothing new for it beyond whatever the timeline needs to draw
the bar the recognizer reported — the timeline still draws both Notes, per
DECISION-110; only the judge's charge changes. A same-pitch attack **outside**
the span, or at a pitch that does not match the pending target, is judged
exactly as today.

**Rule D — verdict timing on an early release.** A release inside a pending
target's written span settles nothing; the record remembers the release
beat. If a continuation arrives (rule C), the remembered release is replaced
by the continuing Note's when it comes. The verdict settles at the first of:
a release inside the end window (on time — the attack's verdict stands, as
today); or `tick`/`close` passing the end window, which applies
`#settleOffTime` to the **latest** remembered release. A note that was
genuinely let go early and never continued is still a Miss or a Good by the
existing rule, reported later than today — by up to the remaining span plus
the Good window. State that cost in the decision entry; it is the price of
not calling a held note a Miss.

**What stays as it is.** A retraction of a continuing attack is a no-op for
the claim (the original attack still holds it). A retraction of the original
attack while a continuation holds the claim hands the claim to the
continuation rather than reopening the target — the player is still playing
the note. `retune` on either id keeps its current meaning. A verdict already
shown is never taken back. Nothing in `src/input/` changes: the adapter still
emits one attack per Tuninator `Note`.

**The accepted cost, to log.** A player who deliberately re-picks the same
pitch inside a target's span is no longer charged for the extra note. In the
tutorial and on the shipped scenarios that is the right trade; if a future
family wants to score repeated picks on one pitch, it turns the flag off for
its own material, which is why it is a flag.

**Tests, in `tests/`, using the deterministic provider or the judge directly
(§15: domain inputs and outputs, never visual timing):**

- a quarter attacked on the beat, released at 0.26, re-attacked at the same
  pitch at 0.26, released at 1.0 → Perfect, no `WrongNote`; the same sequence
  with the flag off → Miss plus `WrongNote`, which pins today's behaviour;
- the same but the second attack is a different pitch → unchanged: the first
  note's early release, judged at the end window, and the second attack
  judged on its own merits;
- a same-pitch attack after the span (a real repeated note on the next
  target) → claims the next target as today;
- release at 0.26 and no continuation → Miss, reported at the end window
  close, not at the release;
- retraction of the continuation, and retraction of the original while a
  continuation holds, per "what stays as it is";
- the tutorial: a loop whose one note is split-but-held advances the step
  with the flag on and repeats it with the flag off (the existing tutorial
  tests show how to drive a loop with the test provider).

## 5. What not to do

- Do not merge, filter or coalesce Tuninator `Note`s in the adapter or the
  timeline. DECISION-110 measured what that cost and deleted it; §4 changes
  what the judge charges, not what the game hears.
- Do not implement any pitch detection, onset detection or "is this one note
  or two" logic on audio in this repository. The capture tool records; it
  does not analyse.
- Do not place a label from anything the recognizer emitted.
- Do not alias `tuninator` to a local checkout, deepen an import into
  `tuninator/dist/**`, or wait on a library change; nothing here needs one.
- Do not add a dev-server write path for captures, and do not write into
  `../Tuninator/fixtures/**` from this task — the owner moves the files.
- Do not touch the tutorial's steps, text, tempos or the scoring tables.

## 6. Verification, then commit

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
npm run validate:browser        # if it covers the debug panel; say if it does not
```

Run the app (`?dev=1`) and exercise: record → stop → three files download;
the synthetic mic and the capture tee installed in both orders; the gate A/B
rebuilds the provider; the split counter moves when the test provider plays
a split-shaped pair. Say what was exercised in a browser and what was not.
Do not claim a real guitar was used unless one was (§15).

Commit per `AGENTS.md` §16: `feat(dev): …`, `feat(judgment): …`,
`docs(log): …` with bodies that say why, what was deliberately not done, and
what was verified. The `Co-Authored-By` and `Claude-Session` trailers are
supplied by the tooling in this repository — do not hand-write or strip them.
One `DECISION_LOG.md` entry per decision in the schema at the end of
`AGENTS.md`, next sequential id: the capture tool (a dev-tool decision), the
judge flag (a judgment decision, with the accepted cost and the latency it
adds to an honest Miss), and the telemetry definition.

## 7. What to hand back

- The three-file capture working from a phone on the built site, with the
  README paragraph on getting the files into `trellos/Tuninator`.
- The debug panel showing applied constraints, the gate A/B, and the split
  counter.
- The judge flag with its tests, at the §0 default, and the tutorial
  behaving accordingly.
- A short note to the owner listing: which phone and browser to record on,
  the tutorial at two tempos (60 and 120), the same passage on the direct
  input if the rig allows, and the reminder that the label file is a grid
  and must be re-timed in the labels editor before the library's
  `verify-fixtures.ts` is asked to believe it.

One standing instruction: where this brief's reading of the code is wrong,
the code wins and the brief gets a correction in your first commit's body.
Say what was thin rather than building on it.
