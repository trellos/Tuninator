# Close the same-pitch tail fragment: make absorption able to reach forward

> **STATUS: RUN TO A VERDICT — refused. Do not pick this up as work.**
> See DECISION-027 and "Forward absorption: the instruments were wrong, then the
> mechanism was refuted" in `docs/DETECTION-FINDINGS.md`. Nothing in `src/`
> changed.
>
> **Since 0.3.0 (DECISION-086), the answer to "may a revision be emitted
> against a Note that has already ended?" (below) is yes, by design.**
>
> Three things this brief got right and one it got wrong, worth reading before
> acting on anything below.
>
> **Right:** absorption does reach backward only, confirmed by reading —
> `absorbAttackFragments()` is additionally gated on `justNamed`, so it never
> runs on monophonic lead material at all. The defect is a same-pitch boundary
> inside one event. And the shape *is* the largest block, not a minority.
>
> **Wrong, and it was wrong in the direction the brief warned about:** the brief
> says to establish what fraction of splits are actually `same pitch twice` and
> to report it if the shape turns out to be a small minority. Measured as
> shipped it looked like one — 18 of 294. That reading was an artefact of
> `measure-split-shape.ts` testing the previous label's name before the label's
> own, which makes `same pitch twice` unreachable whenever consecutive labels
> share a pitch, i.e. on all of the material recorded to study it. Corrected, it
> is 113 of 294; on an instrument that reads no label onset at all
> (`measure-tail-fragments.ts`), 294 of 318 extra Notes are same-pitch and
> contiguous and none are detached. Do not re-derive the "small minority"
> reading — it was the instrument, not the corpus.
>
> **The verdict.** `deep.regionMerge` re-opened on the full 1,595-event corpus
> costs 222 missed labels for 139 fewer extra Notes. Restricted to absorb only
> Notes the fast lane opened without an attack — no new constant, the most
> conservative retrospective rule available — it trades 14 extras for 14 misses,
> one for one, in the same places. So the retrospective question the brief poses
> below ("that fragment already happened — with its full duration, its decay,
> and whether it carried its own attack witness, was it one?") is **answered,
> and it does not sit on the better side of the 0.73 AUC ceiling.** The extra
> evidence a fragment's own history carries is not the missing ingredient.
>
> The open problem this leaves is the one DECISION-026's headline points at: a
> re-pick witness that survives compression and distortion. That is an
> onset-feature question, not a segmentation one.
>
> **One correction to the section "What the blind listening pass already says"
> below: those human figures are not in this repository.** The kit writes to
> `.cache/relabel/`, which is never committed, so no answer sheet exists here and
> `score-relabel.ts` cannot be run — the re-scoring this brief asks for is not
> possible in the tree. What IS committed is the MACHINE pass, and it points the
> **opposite** way on the one row that matters: it hears an onset at 55 of 106
> extra-Note boundaries where the labels have none, and `DETECTION-FINDINGS.md`
> concludes that machine-only cannot settle whether those are real. The human
> reading quoted below is n=6 on a control bar of n=2, and the findings section
> it belongs to still says the human half is "built and waiting". Treat the
> figures below as an uncommitted claim, not a prior — and note the direction:
> if the machine pass is even partly right, some of the "extra Notes" are notes
> somebody played, which makes absorbing them worse, not better.


Read `AGENTS.md` in full before your first edit. It is the contributor-facing source of
truth — architecture, invariants, the evaluation harness, the constraints that bind every
change, and the mandatory decision-logging protocol. `CLAUDE.md` only points there.

## The defect

One played event is emitted as two Notes: a correctly-named Note, then a short
**same-pitch tail fragment**. `docs/DETECTION-FINDINGS.md` has already diagnosed this and
shows the shape note by note on the amped triplet take:

```
  labels   e2 B4 @13312    e3 C5 @13492    e4 D5 @13679    e5 C5 @13894
  Notes    13320-13440 B4  13507-13627 C5  13693-13827 D5  13907-14040 C5
           13440-13507 B4  13627-13693 C5  13827-13907 E5  14040-14107 C5
```

> Every event is emitted twice: a correctly-named ~130ms Note, then a ~70ms tail fragment
> at the same pitch.

and concludes:

> **So the defect behind the largest block of splits is a same-pitch boundary inside one
> event, not a name arriving late.** That is a segmentation question and it is where the
> effort belongs.

Nobody has done that work. That is this task.

`docs/EVALUATION.md` puts the corpus at **99 of 459 events split with 107 extra Notes**,
**63 of the 99 in the three triplet takes**. Re-run the measurements yourself before
trusting any of those figures — §5 of `AGENTS.md` is explicit that a live run beats a doc.

**Why it matters downstream.** A consumer that scores every note — a rhythm game reading
one target per pick — cannot absorb this. A phantom fragment takes the next note's target,
scores as a miss, and marks the real next note wrong, cascading through the phrase. The
project's own standing bar says the same thing: *every played note should read as one
note*. Your acceptance bar is that bar. This is not a task about the consumer; it is judged
entirely by Tuninator's own corpus.

## Start from this branch: new material is already landed

You are on `claude/same-pitch-material`, which adds eight fixtures — four takes,
each as DI and through an amp sim, 1,168 labelled events — recorded to answer
DECISION-022's finding that the derivation set held about seven same-pitch
re-articulations, all in one take. **Read `docs/SAME-PITCH-MATERIAL.md` first.**
DECISION-026 records the terms.

`held-then-picked-six-strings-120bpm` is the take to reach for: per pitch, four
cycles of one held measure then one measure of quarter notes, across all six
strings from F#2 to D5. One pick that must yield one Note, immediately followed
by four picks that must yield four, at the same pitch on the same string.

**The headline result, from `measure-splits.ts` with nothing in `src/` changed:**

| take | DI split | amped split |
|---|---|---|
| quarters A3/E5 | 6 / 72 (8%) | **51 / 72 (71%)** |
| eighths→sixteenths A3 | 6 / 184 (3%) | **56 / 184 (30%)** |
| eighths→sixteenths E5 | 21 / 192 (11%) | 29 / 192 (15%) |
| held-then-picked | 8 / 120 (7%) | **60 / 120 (50%)** |

Same performances, same label timings, up to five Notes on one played event.
**The signal path dominates this defect** — whatever separates a real re-pick
from a spurious boundary survives a direct input and collapses under compression
and distortion. That is a stronger and more specific statement than the corpus
could previously make, and it should shape how you evaluate any fix: measure per
signal path, not per take. It also fits the standing figure that attack contrast
varies 2.0×–24.2× across the corpus and up to 106× within one take.

Three cautions. The labels are **provisional and generated**, not annotated by
ear — the doc says exactly how, and Tuninator placed none of them. The fixtures
carry **no `eval.config.json` entries**, so they report and gate nothing; leave
that alone unless you have a reason. And they are **not assigned to derivation or
held-out**, which is deliberate: that assignment is DECISION-022's substance, both
renders of a take must land on the same side because they are one performance,
and three scripts currently compute that split three different ways.

One more thing the doc records, worth absorbing before you trust your own
instruments: the first analysis of this material confidently concluded one take
had no sixteenth section, on three converging measurements that turned out to
share a premise. A single human listen refuted it. Three statistics agreeing is
not three pieces of evidence when they agree for the same reason.

## What the blind listening pass already says — a prior, not a result

`docs/DETECTION-FINDINGS.md` describes a second-annotation listening kit built to bound how
much of the recognizer's ceiling is annotation noise rather than detection failure. Its
human half was unrun when that section was written. **It is now partially run**, and the
part that bears on this task is encouraging:

- Of **6 extra-note points** answered blind — extra-note points *are* tail fragments, the
  start of every Note past the first at a labelled event — the annotator agreed with the
  shipped labels at **6/6, at 25ms, 50ms and 70ms**, with zero `ann+ lab-`. They heard **no
  new note where the detector split.** Direction: the detector is inventing boundaries, not
  the labels undercounting.
- Implied ceiling, all contested: **0.875 @50ms, 0.938 @70ms (n=13)** — against the 0.73 AUC
  ceiling that eight converging experiments put on the same-pitch decision. Suggests label
  noise is *not* the binding constraint.
- Onset alignment: **median −1ms** over 95 marked onsets. The shipped labels' onset
  placement is sound.

**Now the honesty.** Only 15 of 302 kit points are answered. The control bar passed at
100% — but **n=2**, so the calibration that licenses reading everything else is effectively
absent. Six extra-note points is a pilot. And the annotator played the material; the kit's
blinding stops position leaking the claim, not recognition.

So: treat this as a prior that points your way, **not** as permission to skip measuring, and
not as a settled fact you may cite. The sheet is being filled in. **Before you rely on any
figure above, re-score it yourself** — the numbers will have moved:

```bash
npx tsx scripts/score-relabel.ts .cache/relabel/answers-<name>.csv
```

If the control bar is still under n≈20, say so when you report, and weight the contested
numbers accordingly.

## The structural claim to verify first

Absorption appears to reach **backward only**. Confirm or refute each of these by reading
the code — do not take them from me:

- `absorbArticulationFragment()` in `src/engine/tracker/note-tracker.ts` — absorbs a
  *predecessor* stub younger than `transient.articulationMs` (80) that was still rising.
  Backward.
- `absorbAttackFragments()` — reaches back `harmony.mergeLookbackMs`, and appears gated on
  a Note having just *named itself a chord* (`justNamed`). Backward, and possibly never
  reached on monophonic lead material at all. Check that.
- `mergeWithinSegment()` — the deep lane's retraction, the one mechanism that could undo a
  split after the fact — is gated behind `config.deep.regionMerge`, which ships `false`.
  Read the config comment in `src/engine/config.ts` for the measured reason.
- `carveAfter()` and `splitAtSegments()` run unconditionally but are *additive* — they can
  create Notes, never retract one.

So the question is: **is there any path today by which an announced Note can later swallow a
following same-pitch fragment?** If there genuinely is not, say so plainly in your findings
— that absence is the defect's cause, and naming it is half the work.

## Measure before you change anything

```bash
npm ci
npx tsx scripts/decode-fixtures.ts            # prerequisite for every measure-* script
npm run eval                                  # baseline; note required-gate status
npx tsx scripts/measure-splits.ts --detail
npx tsx scripts/measure-split-shape.ts --detail
npx tsx scripts/measure-downstream-ledger.ts --all
```

`scripts/measure-split-shape.ts` is the important one: it already classifies splits into
four shapes, and the one you are hunting is **`same pitch twice` — "it began on this label
and carries this label's own name. A boundary the player did not put there."** Its header
warns that the obvious reading of a split is "mostly wrong", so establish what fraction of
the 99 are actually your shape rather than `named as before` (pitch lag) or
`predecessor's own`. If your shape turns out to be a small minority, that is a finding and
it changes the task — report it rather than proceeding on the assumption.

Write the baseline numbers down. They are what you must not regress.

## The methodological bind — read this before you plan

`AGENTS.md` §3 defines the split that makes any number here mean anything:

- **DERIVATION** (every tuned constant comes from here, and only here): 78 events across
  five 120bpm takes.
- **HELD OUT** (scored every run, never fitted): 381 events, four Les Paul performances
  through three signal paths.

And then the trap: **the derivation set contains only about seven same-pitch
re-articulations, all of them in one take.** (`AGENTS.md` §3 says seven;
`scripts/measure-same-pitch-population.ts`'s header says "8 of 59 derivation positives, all
eight inside one take" — determine which is current.) Meanwhile the defect lives
overwhelmingly in the **140bpm triplet takes, which are held out.**

That is a real bind and you must confront it rather than route around it. A constant tuned
by looking at held-out data is a leak, not a result, and `AGENTS.md` requires you to say so
explicitly if you cannot avoid it. **"This cannot be honestly derived on the current corpus;
new derivation material is the precondition" is a legitimate and valuable outcome** — it is
exactly what DECISION-022 concluded for the adjacent problem. If you reach it, log it as a
decision and stop; do not ship a number you cannot defend.

The escape, if there is one, is a rule that needs **no tuned constant** — one that reads a
discriminator already computed for other reasons. Look hard for that before reaching for a
threshold.

### Check how each script decides "derivation" before you read its split

Three different predicates are in use, and they disagree:

- `scripts/measure-decision-separability.ts` — `export const isHeldOut = (stem) => stem.includes("140bpm")`
- `scripts/measure-same-pitch-population.ts` — `if (fixture.stem.includes("140bpm")) continue; // derivation only`
- `scripts/measure-dp-segmentation.ts` — an explicit `DERIVATION` list matched by `startsWith`

The filename-substring rule and the explicit list agree only by accident of the current
corpus. If the owner adds new derivation material — which DECISION-022 names as the
precondition for work on this decision, and which may land while you are working — a take
recorded at 140bpm is silently filed as **held out** by the first two, and a new take at any
tempo is filed as held out by the third. Whenever you quote a derivation-vs-held-out number,
say which predicate produced it, and check `fixtures/` against that predicate. This is the
same class of error as the window-wider-than-the-spacing one: a rule that was correct for
the material it was written against.

## Traps already walked into

- **A window wider than the spacing of the events it discriminates** has produced a false
  finding at least four separate times in this project. A sixteenth at 140bpm is **107ms**.
  Check every window you introduce against that.
- The **same-pitch re-articulation decision has a measured ceiling**: best single witness
  0.73 AUC; a twelve-witness fitted model collapses 0.808 in-sample to 0.434
  leave-one-take-out; per-rig calibration, DP joint segmentation, a local-rate gate, a
  millisecond click witness (DECISION-018) and a 19,833-parameter learned head
  (DECISION-021) have all been measured and rejected. Three briefs in `docs/` carry status
  banners saying they are run to verdict — read them, do not re-run them.
  **But note the distinction and test it rather than assuming it:** that ceiling is on the
  *prospective* fast-lane decision ("is this arriving attack a real re-pick?"). Yours is a
  *retrospective* question ("that fragment already happened — with its full duration, its
  decay, and whether it carried its own attack witness, was it one?"), which has strictly
  more evidence available. That may or may not put it on the right side of the ceiling.
  Establish which; do not assert it.
- **Merging deletes a detection the recognizer already stood behind.** `config.ts` records
  what happened when `regionMerge` was enabled: false positives 6 → 10, fragmentation 11/78
  → 12/78, worst case five Notes on one event, because moving a start time cascades into
  the fast lane's own absorption path. If you go near that switch, you are re-opening a
  measured negative and you need to beat it on both axes.
- **Misses down at the cost of extra Notes is not a win.** Both axes count. A net loss on
  either is a finding to write up, not a commit.

## The public-API question you must answer before implementing

A tail fragment clears `tracking.minStableMs` (55) at ~70ms, so by the time you know it was
spurious it has already been announced — very likely `noteStarted` **and** `noteEnded`. So
decide, explicitly, and write the reasoning down:

1. **Suppress at announcement** — never emit it. Cheapest for consumers, but you are
   deciding on less evidence, which is the fast lane's ceiling problem again.
2. **Announce then retract** via a `structuralRevision` change carrying `relatedNoteIds`
   and `relation: "absorbed"`. Check `src/types.ts` for what that field already promises —
   its doc comment states what a consumer must do with it, and warns that one which cannot
   tell `absorbed` from `split` "either double-counts a strum or throws away notes somebody
   played". Determine whether a revision may legally be emitted against a Note that has
   already ended, and what `getNote()` / `tracking.endedNoteHistory` do with it.
3. **Delay the survivor's `noteEnded`** past an absorption window. Cleanest for a consumer,
   but this is a real-time library and you are spending latency. Quantify it.

Also settle: existing absorption moves a survivor's **start** backward. Extending a
survivor's **end** forward may or may not be expressible in the current Note model and
event stream. Find out. If `docs/API.md` or `docs/NOTE-MODEL.md` need updating to state the
contract, update them.

## Constraints

- `src/engine/**` imports nothing outside itself and `src/types.ts`. No DOM, no globals, no
  clock reads, no npm imports. `tests/engine/isolation.test.ts` asserts it.
- The fast lane is **causal** — past audio only. Only the deep lane may look at buffered
  history, and never at audio that has not arrived, even offline.
- **Never edit `fixtures/labels/**` or `fixtures/eval.config.json`.** Never use the
  detector's own output to decide what a label should be.
- **Never `git stash`** — it is repo-wide across worktrees here and has destroyed work.
- **No AI or model identifiers** in commit messages, PR bodies, or code comments.

## Required process

- **State your falsifier before you measure.** Name, in advance, the specific number that
  would mean your hypothesis is wrong. This project's productive days are the ones where
  that happened and a clean negative was reported rather than argued around.
- **Any new constant must be swept, not chosen.** The house method is to sweep until a
  fixture moves and take the most sensitive setting the material supports — read a few of
  the existing constant comments in `src/engine/config.ts` for the idiom, and reproduce it.
- **`docs/DETECTION-FINDINGS.md` gets an entry whether this lands or is reverted**, with
  the numbers. That file is upwards of eighty measured experiments, most of them reverted,
  and it is why this repo does not re-drive dead ends.
- **`DECISION_LOG.md` gets an entry** in the exact schema from `AGENTS.md` §6.3, newest at
  top, next sequential id (**DECISION-026** — verify, the log may have moved). A closed
  direction is logged exactly like a shipped one.
- If `docs/EVALUATION.md` figures move, `npx tsx scripts/check-readme-eval.ts --write` and
  do not rewrap the prose paragraphs it anchors on.

## Verification bar before any commit touching `src/`

```bash
npx tsc --noEmit && npm test
npm run eval                          # PASS, 0 required failures
git diff --stat -- fixtures/          # must be EMPTY
```

and for a detection change, report before/after:

```bash
npx tsx scripts/measure-downstream-ledger.ts --all
npx tsx scripts/measure-splits.ts
npx tsx scripts/measure-split-shape.ts
```

Relevant existing tests to extend rather than duplicate: `tests/engine/articulation.test.ts`,
`tests/engine/note-tracker.test.ts`, `tests/engine/restrum.test.ts`,
`tests/engine/region-reconcile.test.ts`, `tests/engine/resegment.test.ts`. Add a synthetic
case that pins the behaviour: one pick, one Note.

## Acceptance

A change ships only if all of these hold, stated as numbers against your recorded baseline:

1. `measure-split-shape.ts`'s **`same pitch twice`** count falls materially.
2. `measure-splits.ts` — split events and extra Notes both fall, or one falls and the other
   is unchanged. Neither rises.
3. `measure-downstream-ledger.ts` — **missed labels do not rise.** Absorbing a real note is
   the failure mode that matters most; it is unrecoverable downstream where an extra note is
   not.
4. `npm run eval` passes with zero required-gate failures, and `clean-lead-120bpm`'s gated
   pitch class does not regress.
5. Any constant you introduce was swept, and you state which fixtures moved at which value.
6. You can say which held-out takes improved without having tuned on them.

If you cannot reach all six, do not ship. Write up what you measured, log the decision, and
say what new derivation material would be needed — that outcome is worth more to this
project than a change that cannot be defended.

## Start here

1. Read `AGENTS.md`, then `docs/DETECTION-FINDINGS.md` (at minimum the split-shape section,
   "What is still fragmenting, and why", and "The label ceiling, measured"), then
   `docs/NOTE-MODEL.md`.
2. Re-score the listening kit (`score-relabel.ts`) and report where it now stands —
   answered count, control-bar n, and the extra-note row specifically.
3. Run the measurement block above and report the current shape of the defect.
4. Verify the backward-only claim in the tracker.
5. Then propose an approach, with your falsifier named, **before** writing code.

One standing instruction for the whole task: this defect has been misdiagnosed more than
once, in this repository's own record and by the person handing you this prompt. Where the
evidence is thin, say it is thin. A clean negative reported early is worth more here than a
plausible fix.
