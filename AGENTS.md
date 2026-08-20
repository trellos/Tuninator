# AGENTS.md

Orientation for coding agents working in this repository. Written to be read in
full before the first edit.

`README.md` is the *consumer-facing* document — install, usage, API reference.
This file is the *contributor-facing* one: the invariants, the architecture, the
reasoning behind the design, and the measured state of the recognizer. Where the
two disagree on numbers, this file and `npm run eval` are authoritative.

---

## 1. What this project is

Tuninator is a **UI-free, ESM, TypeScript browser library** that turns guitar
microphone input into a streaming musical event recognizer. The unit is a
`Note`: something the recognizer learns about over time rather than a single
classification event. It starts as soon as there is evidence something was
played, then improves — pitch refined, a bend recognised as a bend, a chord
blooming out of what first looked like a single string — with every change
delivered as a typed `NoteChange` so a consumer can tell "I know more now" from
"I was wrong".

A second, diagnostic-only stream, `pitchFrame`, is the raw continuous pitch
reading. Zero runtime dependencies. Detection runs off the main thread by
default (`AudioWorklet` for capture; the recognition engine inline or in a Web
Worker).

Read `README.md` first for the public API, the Note model, and the evaluation
numbers as of the last README update. This file goes one layer deeper.

---

## 2. Architecture

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

### The load-bearing invariant

**`src/engine/**` imports nothing outside itself and `src/types.ts`.** No
`window`, no `AudioContext`, no `performance`, no npm imports, no top-level side
effects — pure functions and classes over `Float32Array`, with sample rate and
timestamps passed in. `tests/engine/isolation.test.ts` asserts it.

This is what makes the offline evaluation trustworthy. There is no separate
"offline recognizer" — `npm run eval` drives the exact same `RecognitionEngine`
in the same 128-sample render quanta the `AudioWorklet` delivers. A change that
only "works" because it reaches into browser globals will fail this test, not
quietly diverge between live and offline behaviour.

### Two lanes over one source-sample timeline

**The fast lane** (`src/engine/fast/`) is causal and answers within tens of
milliseconds: dual-window YIN pitch, spectral-flux onset, pitch-change
detection, re-articulation. It is what makes a Note appear while the note is
still sounding.

**The deep lane** (`src/engine/deep/`) is allowed to be late. It revisits
buffered audio out of a timestamped ring (`deep.ringSeconds`), addressed by
sample range, and answers questions the fast lane cannot: the full spectrum of
an attack, how many voices are in it, what chord it is, and — the thing that
changes results most — whether the fast lane's segmentation of a region was
right at all. Its answers arrive as `NoteChange`s against Notes that already
exist. Offline, it is driven through a deterministic scheduler so a run is
bit-reproducible; live, it is budgeted and droppable.

### The tracker (`src/engine/tracker/`)

The semantic centre. `note-tracker.ts` holds `Map<id, NoteRecord>` from the
start — Notes can overlap, which the old single-active-event architecture this
project replaced could not represent at all. `hypotheses.ts` is the stateful
hypothesis trail (`candidate → contender → leading → confirmed`, or
`incorporated | superseded | discredited`). `voices.ts` is the
voices-vs-Notes distinction: a ringing voice outlives the articulation that
created it, so a decaying string is attributed to the Note that already owns
it rather than spawning one of its own. `revision.ts` classifies a change as
enrichment, correction, or structural revision (split/merge, with a backdated
`startTime` and a `structuralRevision` change on the survivor).

### Where the engine runs

`src/browser/engine-host.ts` implements one `EnginePort` interface two ways:
`InlineEngineHost` (main thread, default) and `WorkerEngineHost` (a Web
Worker, `dist/tuninator-engine-worker.js`). The worker host mirrors the
engine's Note state on the main thread rather than round-tripping every read,
because four of `EnginePort`'s methods are synchronous and a worker cannot be.
A test (`tests/browser/engine-worker.test.ts`) asserts both hosts produce
identical Notes, timestamps and event ordering for the same audio — that
property is what makes offering the worker host safe at all.

---

## 3. The evaluation harness — read this before touching detection logic

`npm run eval` decodes every recorded take in `fixtures/audio/`, runs the real
recognition chain, matches Notes one-to-one against hand-written labels in
`fixtures/labels/`, and exits nonzero when a fixture marked `required` misses a
threshold in `fixtures/eval.config.json`.

**`fixtures/labels/**` is read-only ground truth. `fixtures/eval.config.json`
thresholds are read-only.** Never edit either. Never use the detector's own
output to decide what a label should be — that is circular and has been called
out explicitly more than once in this project's history.

### Derivation vs held-out — the only reason any number here means anything

```
DERIVATION (every tuned constant comes from here, and only here)     78 events
  chords-a-bm-g-d-2x-120bpm, clean-lead-120bpm,
  cowboy-chords-c-d-em-g-c-d-em-am-120bpm, power-chords-c-a-g-e-c-d-fsharp-e-120bpm,
  spicy-chords-cmaj9-g-am11

HELD OUT (scored every run, never fitted)                           381 events
  four Les Paul performances x three signal paths (DI / amp sim / room mic):
  cowboy chords, power chords, lead line quarters/eighths/triplets, lead line sixteenths
```

The held-out set is four performances heard three ways, not twelve independent
samples — keep that in mind before treating a twelve-take result as more
statistically solid than it is.

### Measurement scripts

```
scripts/measure-downstream-ledger.ts --all   every missed label + the exact branch that lost it
scripts/measure-splits.ts                    events that came out as more than one Note
scripts/measure-onset-coverage.ts            what the onset kernel saw, before the tracker decided anything
scripts/verify-fixtures.ts                   is each label actually audible/attack-aligned/pitch-supported
```

Several more exist for specific investigations (`measure-decision-separability.ts`,
`measure-rig-profile.ts`, `measure-dp-segmentation.ts`, …) — `ls scripts/` and
read a header comment before assuming one doesn't exist.

### `docs/DETECTION-FINDINGS.md` — read before proposing a detection change

Records upwards of eighty measured experiments, most of them reverted, with the
numbers that killed each one. Repeated pattern worth internalising: **a window
wider than the spacing of the events it discriminates** has produced a false
finding at least four separate times in this project (a fragmentation metric's
120ms ownership tolerance against a 140ms triplet; a fixture verifier's 150ms
attack search against a 107ms sixteenth; two more). Check every new window
against the corpus's tightest subdivision — a sixteenth note at 140bpm is
**107ms** — before trusting a result built on it.

Also recorded there: five converging negative results establishing that the
current feature set has a hard ceiling on the same-pitch re-articulation
decision (best single witness 0.73 AUC; a fitted twelve-witness model collapses
from 0.808 in-sample to 0.434 leave-one-take-out; per-rig calibration, joint
region segmentation by dynamic programming, and a local-rate gate all measured
to their ceiling and rejected). `docs/onset-features-prompt.md` is the
self-contained next-steps brief for that specific problem — read it before
re-deriving the same conclusions from scratch.

---

## 4. Constraints that bind every change

- **Engine isolation** (§2, above). Enforced by `tests/engine/isolation.test.ts`.
- **No npm runtime dependencies.** A learned component is shippable only as
  fixed weights (≤ ~25,000 parameters) executed by plain TypeScript over
  `Float32Array` inside `src/engine/**` — no runtime dependency, no dynamic
  loading, no training at runtime. The training pipeline lives outside the
  shipped library (`training/`), may use any tooling, and is never imported
  by `src/**`. A trained model larger than this, or one requiring a runtime,
  remains out of bounds.
- **Causal by default.** The fast lane must answer from past audio only. Only
  the deep lane, explicitly, may look at buffered history — never at audio that
  hasn't arrived yet, even offline, because the offline harness exists to
  predict live behaviour.
- **Derivation discipline** (§3). A constant tuned by looking at held-out data
  is a leak, not a result. Say so explicitly if you cannot avoid it.
- **Never edit `fixtures/labels/**` or `fixtures/eval.config.json`.**
- **Never use `git stash` in a shared worktree.** It is repo-wide across
  worktrees in this environment and has destroyed concurrent agents' work
  before. Use pathspec-limited `git add`/commits instead when working
  alongside other agents.
- **State a falsifier before measuring a new detection hypothesis.** This
  project's productive days are the ones where a specific number was named in
  advance as the bar to clear, and a clean negative was reported as a finding
  rather than argued around. See `docs/DETECTION-FINDINGS.md` for the pattern
  in practice.
- **No AI or model identifiers** in commit messages, PR bodies, or code
  comments.

### Verification bar before any commit touching `src/`

```bash
npx tsc --noEmit && npm test
npm run eval                          # PASS, 0 required failures
git diff --stat -- fixtures/          # must be EMPTY
```

For a change to detection logic specifically, also report before/after:

```bash
npx tsx scripts/measure-downstream-ledger.ts --all   # missed labels, per fixture
npx tsx scripts/measure-splits.ts                    # events split into >1 Note, per fixture
```

Misses down at the cost of extra Notes is **not** automatically a win — both
axes count, per the standing project bar that every played note should read as
one note. A net loss on either axis is a finding, not a commit: write it up in
`docs/DETECTION-FINDINGS.md` and say so rather than shipping it.

---

## 5. Doc drift

If a number in `README.md`'s evaluation section, this file, or anywhere else
disagrees with a fresh `npm run eval` run, **the eval output is authoritative**
and the doc is stale. Fixing the doc is welcome; trusting the doc over a live
run is not.

---

## 6. Decision Logging Protocol (Mandatory)

You must track all architectural, technical, and critical project decisions.
Every time a significant choice is agreed upon, updated, or abandoned, you must
log it immediately.

### 6.1 Trigger criteria

Log a decision if it involves:

- Choosing a tool, language, or framework over alternatives.
- Modifying project architecture, folder structures, or workflows.
- Approving a critical API design or data schema choice.
- Accepting a specific technical debt or security trade-off.

This project's own history is full of borderline cases that qualify: closing a
detection direction after measuring its ceiling (per §3 above) is a technical
decision with real consequences for what gets tried next, and belongs in the
log even though no code shipped.

### 6.2 File location & naming

Maintain a centralized file named `DECISION_LOG.md`, at the repository root.

### 6.3 Required metadata structure

Every logged decision must use this exact schema:

```markdown
#### [DECISION-ID]: [Short, Descriptive Title]
* **Date:** YYYY-MM-DD
* **Status:** [Proposed | Accepted | Rejected | Superseded by ID]
* **Owner:** [Name/Role]
* **Context:** What problem are we solving? What constraints exist?
* **Decision:** What specific path are we taking?
* **Alternatives Considered:** What else did we look at, and why did we reject it?
* **Consequences:** What are the positive and negative trade-offs of this choice?
```

### 6.4 Agent execution flow

1. **Identify:** Detect when a user conversation or a task output results in a
   baseline choice.
2. **Draft:** Propose the log entry to the user before finalizing if the
   context is ambiguous.
3. **Write:** Append the new entry to the top of the decision file or create
   the next sequential ADR markdown file.
4. **Link:** If this decision supersedes a previous one, immediately update the
   status of the older decision to "Superseded by [New ID]".
