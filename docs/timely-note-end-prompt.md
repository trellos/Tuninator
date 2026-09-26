# Brief: send `noteEnded` when the sound ends

> **STATUS: CLOSED 2026-09-26 — Part A shipped as 0.3.0 (DECISION-086);
> Part B missed its stated bar by 20ms and then shipped in 0.3.0 on the
> owner's acceptance of 220ms (DECISION-087).** Written from
> GOATerizer (`trellos/goaterizer`, on `tuninator@0.2.1`) on 2026-09-25, from a
> read of `main` at `fecc0e4`. The figures in §1–§6 were measured at that
> commit and are kept as written. The hand-back follows, and the numbers in it
> were measured on the branch that ships.
>
> **Version:** `package.json` is 0.3.0. Not tagged; the tag is the owner's.
>
> **`scripts/measure-end-latency-fixtures.ts`**, 27 takes, default config
> (ms, Notes ended live and not absorbed: 1,736 before, 1,740 after — four
> that only the flush used to end):
>
> | | p10 | p50 | p90 | p95 | max |
> |---|---:|---:|---:|---:|---:|
> | `late` before | 227 | 253 | 760 | 920 | 1,493 |
> | `late` after | 0 | 0 | 93 | 160 | 1,013 |
> | `hold` before | 53 | 240 | 747 | 920 | 1,160 |
> | `hold` after | 0 | 0 | 0 | 0 | 0 |
>
> Over 250ms late: 58.4% → 3.3%. Over 500ms: 23.3% → 0.6%. Over 1s: 3.2% →
> 0.1%. The slowest take now is `rest-repick-g2-60-120bpm-amped` (p50 427ms):
> its damps are placed on the damp, but the amp's ring holds the gate open.
> After `noteEnded`, 116 of 1,807 announced Notes are revised
> (`scripts/measure-after-end.ts`): 44 have their end moved, 8 are renamed and
> 64 are absorbed. None gets two `noteEnded`s or two `noteResolved`s, and
> nothing arrives after a `noteResolved`.
>
> **`scripts/measure-end-latency.ts`**, worst live `late` per case (ms):
>
> | Case | before | after |
> |---|---:|---:|
> | 1. A3 damped on the beat | 253 | 93 |
> | 2. detached quarters, 120bpm | 253 | 93 |
> | 3. detached sixteenths, 100bpm | 1,107 | 93 (0 for 15 of 16) |
> | 4. open E rings on, gate 0.0008 | 3,987 | 13 — but the E is still announced, and the flush still makes 13 Notes of it |
> | 5. as 4, default gate | 253 | 93 |
> | 6. 50Hz hum, gate 0.0008 | 360 | 307 — A3 still ends 1,540ms after the damp, and its tail is still a second A3 |
> | 7. as 6, default gate | 253 | 93 |
>
> Cases 4 and 6 are Part B's. With it (branch `claude/timely-note-end-part-b`,
> `304e5be`): case 4 reports 73ms after the damp with no phantom, and case 6
> reports 220ms after the damp with no phantom. The bar was 200ms. B was held
> back, then shipped in 0.3.0 once the owner accepted 220ms (DECISION-087;
> `docs/DETECTION-FINDINGS.md`). On the corpus it is inert: every eval figure,
> split and ledger row is identical with it.
>
> **Contract as shipped:** §4 items 1–6 hold. `noteEnded` goes out in the
> `processChunk` call in which the fast lane ends the Note, carrying its best
> `endTime`. After it, boundaries arrive as `structuralRevision`, names as
> corrections or refinements, and absorptions as today. `noteResolved` fires
> once per announced Note, after `noteEnded`. `stop()` ends and then resolves
> every open Note. The two hosts produce identical emissions. The lifecycle
> order is `started → enriching → ended → resolved`.
>
> **Decided differently from §0, or left open by it:**
> - **D:** an absorbed Note **does** get `noteResolved`, once, as soon as its
>   absorption is delivered. So every announced Note gets exactly one, and
>   the offline analyzer's `notes`, now taken at `resolved`, stay the same
>   set.
> - **§4.4 "nothing more will change":** the region lane can still rename a
>   Note it has already let go (`correctPitch` over resolved Notes, a
>   deliberate path). It never does on the 27 takes. It is documented as
>   possible in `docs/API.md`, and `NoteLifecycle` already calls `"resolved"`
>   revisable.
> - **B** missed its bar (above) and ships anyway, on the owner's decision.

Read `AGENTS.md` in full before your first edit, and hold to it — especially
§3 (the evaluation harness, derivation against held-out, `fixtures/` read-only),
§4 (engine isolation, a causal fast lane, a falsifier stated before measuring,
no model identifiers in commits or comments, never `git stash`), §5 (doc drift
and `scripts/check-readme-eval.ts`), §6 (the decision log) and §7 (the owner
pushes the tag). `README.md` above `## Install` is human-written.

## 0. Owner's choices

Filled in with recommended defaults. Edit this block before running; the
session implements what it says.

| # | Item | Choice |
|---|---|---|
| A | `noteEnded` goes out when the fast lane ends the Note. The deep lane's later rulings reach the consumer as `noteChanged` on the ended Note, and `noteResolved` is the "nothing more will change" signal (§5) | **yes** |
| B | A damp that leaves something above the gate still ends the Note at the damp, and a quiet opening inside that damp is not a Note that never ends (§6) | **yes**, as a separately measured detection change. If it misses its bar, record the finding and ship A alone |
| C | `Note.lifecycle` once the sound is over | **`"ended"`** from the moment `noteEnded` fires; the `noteResolved` snapshot then reads `"resolved"`, so the order becomes `started → enriching → ended → resolved`. Documented in `src/types.ts`, `docs/API.md` and `docs/NOTE-MODEL.md` |
| D | What an absorbed Note gets | No `noteEnded` after its absorption (today it gets one from the flush in `stop()`). One absorbed after its `noteEnded` is retracted through the survivor's `structuralRevision`, as today. Whether it still gets `noteResolved` is the session's call; document it |
| E | Version | **0.3.0**: the meaning of `noteEnded` and the event order both change. GOATerizer pins `^0.2.1`, so nothing picks it up by accident |

## 1. What the consumer sees

GOATerizer draws each played note from its attack to the playhead until
`noteEnded` arrives, then snaps the bar back to the `endTime` it carries. It
judges a sustained note when the note is let go. The designer, playing it:
*"Note bars seem to go on a long time after a note ends. Sometimes the minigame
finishes and it thinks the note is still going but it's muted."*

There are two causes, and both are about how an ending reaches a consumer.

1. **Every ending waits for the closing hold.** `NoteTracker.end()`
   (`src/engine/tracker/note-tracker.ts:3424`) moves a Note into `closing`, and
   `releaseClosed()` (`:3475`) emits its `resolved` and `ended` only when three
   things are true: the deep lane has nothing queued for it, its region has
   been re-segmented (`deepResolved`), and no quieter Note that opened at its
   end is still sounding (`quietSuccessor`, `:3349`). The region is queued
   `deep.regionSettleMs` (200ms) after the last Note in it ended, or once it
   spans `deep.maxRegionMs` (1.2s), and it runs `deep.latencyMs` (40ms) after
   that (`src/engine/engine.ts:222`). On dense material the region never
   settles between notes, so endings arrive in batches about every 1.2s.
2. **A damp that leaves something above the gate is not an ending.** A Note
   ends only after `tracking.releaseGraceMs` of *gated* hops
   (`note-tracker.ts`, about lines 1213–1246: *"A Note ends when the sound
   stops, not when the pitch tracker loses it"*). If anything stays above the
   gate after the player damps — a sympathetic open string, pickup hum, an amp
   sim's noise, a consumer's gate set close to its floor — the Note either never
   ends, or it ends into a quiet successor that `quietSuccessor` holds it for
   and that never ends itself. GOATerizer makes this likelier: it measures the
   player's noise floor and passes `rmsGate` at 8× it, which on a quiet direct
   input is about 20dB under the library's default.

## 2. Measured

### On the corpus

All 27 fixture takes, default config, run through the eval's own loop
(`scripts/measure-end-latency-fixtures.ts`, §9). The table covers the 1,736
announced Notes that ended while their take was running and were not absorbed.

| ms | p10 | p50 | p90 | p95 | max |
|---|---:|---:|---:|---:|---:|
| `late`: `noteEnded` delivered − the `endTime` it carries | 227 | 253 | 760 | 920 | 1,493 |
| `hold`: delivered − when the fast lane ended the Note | 53 | 240 | 747 | 920 | 1,160 |
| `early`: `late` if `noteEnded` went out when the fast lane ended the Note | 0 | 0 | 93 | 160 | 1,013 |

- **How often it is late:** 58.4% arrive more than 250ms after their end,
  23.3% more than 500ms, and 3.2% more than 1s.
- **Where it is worst:** fast lines and anything through an amp.
  `lead-line-di-sixteenths` has a p50 of 533ms; `same-pitch-eighths-a3-amped`
  has a p50 of 467ms, with 94 of its 211 Notes over 500ms. Chords and DI power
  chords sit near 240ms.
- **What the hold bought:** the `ended` payload differs from the Note as it
  stood when the fast lane ended it for **51 of 1,736 (2.9%)**. On 44 the
  `endTime` moved, always earlier (median −213ms, range −8 to −1,453ms). On 7
  (0.4%) the label changed. No `startTime` moved.
- **Absorptions:** 58 of the 66 announced Notes that were absorbed were
  absorbed after the fast lane had ended them — a median 53ms later, 827ms at
  most.

So the hold delays nearly every ending by a median 240ms (p90 747ms) in order to
change about 3% of them. `early`'s p50 of 0 is legato: a Note ended by the next
attack is ended on the hop that opens its successor. Its tail was not broken
down.

### Synthetic, at a consumer's calibrated gate

`scripts/measure-end-latency.ts` (§9): seeded plucked notes over a 1e-4 RMS
floor, each damp falling 60dB in 40ms, with `rmsGate` 0.0008 where the case says
so.

| Case | What happened |
|---|---|
| A3 damped on the beat | `noteEnded` arrived 253ms after the `endTime` it carries, which is 47ms after the damp |
| Detached sixteenths at 100bpm | Endings arrived in batches about every 1.2s; the oldest in each batch was 1,093–1,107ms late |
| A3 damped, an open E ringing on at −32dB, gate 0.0008 | A3 ended on time (1560ms), but `quietSuccessor` held its `noteEnded` for 3,987ms. The E was announced as a Note (E2, at 1627ms) that only `flush()` ended, and the flush then re-segmented it into 13 |
| The same, default gate | 253ms, and nothing else |
| A3 damped, then 50Hz hum above the gate (never a pitch), gate 0.0008 | A3 did not end. The region lane cut it at 3040ms — an `endTime` 1,540ms after the damp — and the cut-off tail became a new Note, still named A3, that only `flush()` ended |
| The same, default gate | 253ms, and nothing else |

For scale, here is what that costs the consumer. GOATerizer's judge rules that a
note whose release has not arrived by the end of its window was released late.
So at 120 and 140bpm, a note played and damped exactly on time scores Good
instead of Perfect whenever `noteEnded` trails the damp by about 300ms. That is
GOATerizer's to handle, but it is why a bound matters.

## 3. Why the hold exists, and why the event can move anyway

These are the library's own reasons:

- `end()`: *"The sound is over, but the recognizer may not have finished
  thinking. A chord's identity is routinely settled by deep analysis that
  started before the strum stopped, so the closing events wait for it —
  otherwise the answer a consumer keeps is the one from before the evidence
  arrived."*
- `releaseClosed()`: *"A Note nobody has re-analysed is not finished, whatever
  the queue says. Holding it here is what makes the region reach back over it:
  once it is gone from `closing` there is nothing left to correct."*
- DECISION-074, alternative (b), rejected: *"Revise the earlier Note after its
  `noteEnded`: a consumer has already been told it is finished, and the offline
  adapter scores the end it was given then."*
- `src/offline/eval-adapter.ts`: the gated `final` projection is *"the Note as
  it stood when it ended … what a consumer who waited for `noteEnded` would have
  seen."*

So `noteEnded` carries two meanings today. One is *the sound is over*, which is
what `NoteLifecycle`'s own doc says `"ended"` means. The other is *this answer is
final*, which is what `noteResolved` is documented to mean. The second reason
above is internal, and it stays: a Note has to remain in the region's working
set until the deep lane has ruled on it. Only the event moves.

The measurement says the first reason buys 7 label changes in 1,736 Notes. The
model already says how to deliver those: *"Already-delivered events always stand
… history is revised in meaning, never rewritten"*, and the deep lane's
*"answers arrive as `NoteChange`s against Notes that already exist"*
(`docs/NOTE-MODEL.md`).

Most of the machinery is already there. Every path that moves an ended Note's
boundary already emits a `structuralRevision` on it: the merge
(`note-tracker.ts:2557`), both carves (`:2739`, `:2822`) and the damp-ghost
absorption (`:3396`). They are simply delivered while its `noteEnded` is being
held. The exception is the label; see §5.

## 4. The contract after this change

This is what GOATerizer needs, and what this brief asks the library to promise
and document:

1. `noteEnded` goes out when the fast lane ends the Note, in the same
   `processChunk` call. It is never held for the deep lane or for
   `quietSuccessor`. Its delay from the `endTime` it carries is whatever the
   fast lane needed to decide: release grace for a silence, a hop or two for an
   ending made by the next attack. Document that.
2. `noteEnded` carries the fast lane's best `endTime`.
3. After `noteEnded`, anything that changes the Note arrives as `noteChanged`
   on that Note:
   - a boundary as `structuralRevision`, with the new `endTime` or `startTime`
     in the snapshot;
   - a label as `pitchCorrection`, `harmonyCorrection` or a refinement;
   - an absorption as today: `structuralRevision` with `relation: "absorbed"`,
     on the survivor, naming it.
4. `noteResolved` fires once per Note, when nothing more will change. For
   nearly every Note it now follows `noteEnded`. A consumer that wants only
   final answers waits for it. That is the whole of the option; there is no
   setting that restores the old timing.
5. `stop()` still flushes: every open Note gets `noteEnded` and `noteResolved`
   before the promise settles.
6. The inline and worker hosts stay identical, emission for emission.

GOATerizer's adapter (`src/input/tuninator-provider.ts` in `trellos/goaterizer`)
already keeps a record of every ended Note. It already turns a late label change
into a re-label and an absorption into a retraction, and it already settles its
drawing on `noteResolved`. It will add handling for a moved `endTime` when it
takes this release, and it needs nothing else from the library.

## 5. Part A — move the event, not the logic

The aim: every Note's final state after `stop()` is exactly what it is on
`main`. Only *when* the consumer hears about it changes.

Where to look, at `fecc0e4`:

- **`NoteTracker.end()` (`:3424`).** Emit `ended` here for an announced Note.
  An unannounced blip is still dropped through `retractOpening`, and a Note
  announced *at* its end gets `started` and then `ended`. Keep pushing the
  record to `closing`: that is the region's working set, and `pendingRegion()`
  (`:2253`), `applySegmentation()` (`:2319`) and `absorbDampGhost()` (`:3377`)
  all read it.
- **`releaseClosed()` (`:3475`).** It keeps its three conditions and now emits
  only `resolved`. `quietSuccessor` then holds a Note's *resolution*, not its
  ending; record that DECISION-074 part (1) changes meaning.
- **`absorbDampGhost()`.** It marks the ghost `merged` and then calls `end()` on
  it, so `end()` must not emit `ended` for a Note that has already been absorbed
  (owner's choice D).
- **The label emission guards, `record.announced && record.endTime === null &&
  …` at `:1421` and `:1536`.** Today a label change to a Note in `closing` is
  applied silently (`record.bump(type)`) and reaches the consumer only inside
  the held `noteEnded`. After this change it has to be emitted as `noteChanged`;
  otherwise it reaches the consumer only in the `noteResolved` snapshot. Check
  `publish()` (`:3176`, which skips ended Notes) and `lastEmitted` for the same
  assumption. The guard at `:1518` is not an emission guard: it keeps
  `absorbAttackFragments` to a sounding Note. That is behaviour, and Part A must
  not change it.
- **`WorkerEngineHost.mirror()` (`src/browser/engine-host.ts:230`).** It assumes
  `ended` is a Note's last emission. Any emission after it (`changed`,
  `resolved`) would put the ended Note back into `active`, so `getActiveNotes()`
  would return it. Key it on the Note's own `endTime`.
  `tests/browser/engine-worker.test.ts` must stay green, and it should catch
  this.
- **`src/offline/eval-adapter.ts`.** Build the gated `final` projection at
  `resolved`, whose snapshot is the one today's `ended` carries.
- **Docs.** `src/types.ts` (`NoteLifecycle`, `Note.endTime`); `docs/API.md` (the
  events and the `NoteChange` table); `docs/NOTE-MODEL.md` (a section on
  endings: when `noteEnded` fires, what can change after it, what
  `noteResolved` means); the README's events table, which is below
  `## Install`; `CHANGELOG.md`.

Nothing in the tracker reads `lifecycle` except the `started → enriching` step
(`:3074`, `:3170`), so moving where `"ended"` is set should not change behaviour.
The falsifiers below are what check that.

**Falsifiers — state them in the decision entry before measuring:**

- `npm run eval`: every figure in the table is **identical** to `main`, not
  merely PASS, and `npx tsx scripts/check-readme-eval.ts` is clean without
  `--write`. The revision counters (`revisions.changes`, `timeToFinalLabelMs`)
  may rise, by exactly the label changes that are now emitted after an ending;
  report the delta.
- `measure-downstream-ledger.ts --all` and `measure-splits.ts` are identical to
  `main`.
- In `measure-end-latency-fixtures.ts`, `late` falls to what `early` reads on
  `main` (p50 0, p90 93, p95 160ms at `fecc0e4`), and `hold` is gone.
- Count the Notes that receive a boundary or label revision, or an absorption,
  after their `noteEnded`. From §2, expect about 51 + 58 out of about 1,800.
  Much more than that means something is emitting noise.
- `git diff --stat -- fixtures/` is empty, and `npx tsc --noEmit && npm test` is
  green.

## 6. Part B — a damp that leaves something above the gate

Both shapes are in §2's synthetic table, and both come from one gap:

- The library accepts a damp as the end of a Note only once the level has spent
  `releaseGraceMs` under the gate. `dampedAt()` places the end, but only after
  that.
- It absorbs a quiet opening inside a damp only once that opening has itself
  ended in silence (`absorbDampGhost`, DECISION-074 part 2).

A residual that never goes under the gate defeats both.

What is wanted is that the damp itself becomes the witness. For instance: a Note
whose pitch has gone, and whose level shows the damp signature `dampedAt()`
already looks for, ends at the damp without waiting for the gate. That signature
is: fell `tracking.dampFallDb` under its recent median, reached
`tracking.dampDepthDb` under it, and never came back. Likewise, a quiet opening
inside the damp (the `quietSuccessor` shape) is decided on that same evidence
rather than after it goes silent. Those are suggestions; the design is yours.

It is a detection change, so §3 and §4 of `AGENTS.md` apply in full:

- State a falsifier first.
- Tune on derivation takes only. `rest-repick-g2-60-120bpm`, DI and amped, is
  the owner's pick–ring–damp–rest take (DECISION-066). §3 notes that on the
  amped renders the head noise floor sits above the engine's `rmsGate`, which is
  this condition.
- Run `measure-downstream-ledger.ts --all` and `measure-splits.ts` before and
  after.
- Read the held-out set once.

The rule must not bring back the defect that the gated-only ending was built to
remove: a strummed chord has no single periodicity, and *"a Note that expired on
unvoiced frames could not survive its own first 90ms"*.

Add the two synthetic shapes as tests at `rmsGate: 0.0008`. If B misses its bar,
write it up in `docs/DETECTION-FINDINGS.md` and ship A alone.

## 7. Tests

- A Note ended by silence gets `ended` in the `processChunk` call in which the
  fast lane ends it, `resolved` later, and a final snapshot identical to
  `main`'s.
- A Note whose end the region lane moves after its `ended` (a carve), and one
  that is absorbed after its `ended`: each gets a `structuralRevision` after
  `ended`, the new `endTime` is in the snapshot, and there is no second `ended`.
- A label change after `ended` arrives as `noteChanged`.
- On the worker host, `getActiveNotes()` never returns a Note that has ended.
- `stop()`: every open Note gets `ended` and then `resolved`.
- Part B: the two synthetic shapes.

## 8. Shipping and hand-back

- Write a decision entry for A, with the next sequential ID and the falsifiers
  written before the numbers. Write another for B, or for its finding. Record
  what A does to DECISION-074 part (1).
- Update `CHANGELOG.md`, and set `package.json` to the owner's version (§0 E).
  Do not tag: pushing the tag is the publish (`AGENTS.md` §7), and it is the
  owner's to push.
- Hand back, in the session's final message and in this brief's banner: the
  version, the before-and-after tables from both scripts, the contract as
  shipped, and anything decided differently from §0. GOATerizer then bumps,
  handles a moved `endTime` in its adapter, and re-measures its judge against a
  real guitar.

## 9. The two measurement scripts

Both typecheck under this repository's `tsconfig.json` and were run at
`fecc0e4`. They are committed as `scripts/measure-end-latency.ts` (synthetic,
about 4s) and `scripts/measure-end-latency-fixtures.ts` (the corpus, about
90s, after `npm run decode-fixtures`, which needs `ffmpeg-static`'s binary; if
`npm ci` skipped its install script, run `npm rebuild ffmpeg-static`). The
brief carried their full source; it is not repeated here.
