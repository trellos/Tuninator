# The Note model, and how the recognizer works

Why a `Note` behaves the way it does, and what is underneath it. For the type
surface see [`API.md`](API.md); for contributor-facing invariants see
[`AGENTS.md`](../AGENTS.md).

---

## A Note improves rather than being re-issued

Handlers receive **immutable snapshots**. `note.revision.revisionNumber` increases with every
change, so a snapshot you stashed can always be checked for staleness.

The distinction the whole model is built on is `NoteChange.type`
([table](API.md#notechangetype)): *I know more now* (`pitchRefinement`,
`harmonyEnrichment`) is not the same news as *I was wrong* (`pitchCorrection`,
`harmonyCorrection`) or *the event boundaries were wrong* (`structuralRevision`).

Already-delivered events always stand. A split emits a `structuralRevision` on the surviving Note
and then a `noteStarted` for the new one with a backdated `startTime`; history is revised in
meaning, never rewritten.

## Three behaviours worth relying on

- **A re-picked note is two Notes.** An attack over something already sounding starts a new Note
  even at an unchanged pitch, so a repeated note does not read as one long sustain.
- **A legato pitch step is also two Notes.** In a fast run the pick never re-attacks, so onset
  detection alone would merge them.
- **A bend is ONE Note.** `pitch.current` keeps the origin note and `bend` records the excursion.
  A note bent from A3 up to B3 is a single Note named `A3` with `bend.amountCents ≈ 200`, never
  two Notes. Total displacement cannot separate a 200-cent bend from a 200-cent legato step —
  both are two semitones — so the discriminator is the per-hop rate: a bend glides through the
  intermediate cents over tens of frames, a fretted step jumps within one or two.

## Notes overlap

`getActiveNotes()` is genuinely plural. A chord struck while the previous one is still ringing
produces a second Note over the first, which the old single-active-event tracker could not
represent at all.

The distinction underneath is **voices versus Notes**: a ringing voice outlives the articulation
that created it, so a decaying string is attributed to the Note that already owns it rather than
spawning one of its own.

## Chords bloom; they are not a mode

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

## The hypothesis trail

`note.hypotheses.active` is what is currently believed; `note.hypotheses.trail` is what was
believed and why it stopped being believed. Each entry carries a `state`:

```
candidate → contender → leading → confirmed
                     ↘ incorporated | superseded | discredited
```

A UI can show the trail directly; nothing else needs to read it.

---

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
it is confident above ~300Hz, where it genuinely spans two periods. This gives ~4× better time
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
