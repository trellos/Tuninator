# Validate the re-labelled 120bpm same-pitch material

> **STATUS: CLOSED 2026-09-14 — verdict: the re-timing (`7a216fe`) holds and is
> kept; `b5cf94b` stands.** Three of the four re-timed sections were confirmed by
> instruments the re-timing never consulted (the amped render, the verifier's
> attack search, inter-onset-interval spread against a human reference, and a
> leave-one-out at the owner's ear points); the fourth, `a3-di`'s sixteenth
> section, could not be verified either way and is flagged as unreliable. Two
> of this brief's premises were wrong and are corrected in the record: the two
> renders are aligned to within 5ms, not 20–90ms; and the amped label files of
> the two fast takes were never the DI timings — their grids are anchored
> 195ms and 225ms later — so a removal cannot be carried across renders by
> label id. Full numbers in `docs/DETECTION-FINDINGS.md` ("The re-timed labels,
> checked from the other render") and DECISION-029. `src/` is unchanged;
> `fixtures/labels/**` is unchanged by the validation.

Read `AGENTS.md` in full before anything else. Then read this whole brief before
running anything.

## What you are checking, and why it needs checking

`fixtures/labels/**` is normally read-only. On 2026-09-14 it was edited anyway,
in two passes, on the repository owner's explicit instruction. **Your job is to
decide whether those edits are sound.** Assume they are not until you have
checked; the session that made them got several things wrong first and caught
them only because the owner pushed back.

The two commits, newest last:

- `b5cf94b` — **nine labels corrected from the owner's own listening pass.** He
  listened to fifteen disputed points and reported what he heard. Five grid
  positions with no pick under them were removed; four onsets were moved to the
  times he gave. This is human annotation and it is the highest-authority source
  in the repository.
- `7a216fe` — **the two gridded DI sections re-timed automatically**, by
  `scripts/retime-gridded-labels.ts`. Envelope peaks, ranked by prominence,
  over-selected, then aligned monotonically to each section's own label count.

Why the second pass exists: `docs/SAME-PITCH-MATERIAL.md` records that
`same-pitch-eighths-a3` and `same-pitch-eighths-sixteenths-e5` were labelled on a
fixed subdivision **grid**, because "the runs are too fast for the envelope rule
to resolve every pick". A grid does not follow a player. The owner's ear found
drift up to 87ms and five grid positions with no pick at all.

Why it might be wrong: an automated pass moved roughly 330 labels on evidence
that is weaker than an ear, against material the project has repeatedly
mis-measured.

## Declared weaknesses — verify these first, they are where it breaks

The session that did this work states these openly. Confirm or refute each.

1. **`same-pitch-eighths-a3-120bpm-di`'s sixteenth section located only 78 of
   111 picks.** A third of that section is still on the grid, interleaved with
   re-timed labels. This is the least trustworthy thing in the corpus and it may
   be worse than leaving the section alone.
2. **`verify-fixtures.ts` barely moved** — concerns went 61 → 59 on `a3-di` and
   48 → 47 on `e5-di`. An independent check that does not confirm a claimed
   improvement is evidence, and it was waved away as "a crude instrument". Decide
   whether that dismissal is fair.
3. **Only the DI renders were re-timed. The amped labels are untouched**, so the
   two renders of one performance now carry differently-derived labels. The
   renders were measured to sit 20–35ms apart, by two methods that disagreed
   (envelope correlation said 9/12/25/56ms; onset-time matching said
   80/10/90/80ms). Neither is trustworthy. Whether the DI corrections should
   carry across is unresolved.
4. **Three removals were applied to one render only.** The owner stated the
   renders are the same performance, which implies `34.050` in `e5-di`, `31.355`
   in `a3-amped` and `11.425` in `a3-di` should also go. They were left in place.

## What to run

```bash
npm ci
npx tsx scripts/decode-fixtures.ts
npx tsx scripts/verify-fixtures.ts
npm run eval
npx tsx scripts/retime-gridded-labels.ts        # dry run; prints its own agreement
npx tsx scripts/measure-splits.ts
npx tsx scripts/measure-tail-fragments.ts
```

## The checks, with the numbers that mean failure

**Structural.** Every same-pitch and held-then-picked label file: events strictly
ordered by `startMs`, no `endMs > next.startMs`, no `endMs <= startMs`. Any
violation is a fail — one was found and fixed during the work and there may be
more.

**The owner's nine corrections survived.** These are locked values and nothing
should have moved them:

| file | label | must be |
|---|---|---|
| `e5-di` | `s1615` | 19613 |
| `e5-di` | `s1684` | 28339 |
| `e5-di` | `s16108` | 31344 |
| `a3-di` | `s1627` | 23275 |
| `e5-amped` | `s1632` | 22078 |
| `e5-amped` | `s16106` | 31344 |
| `a3-amped` | `s1618` | 22280 |
| `held-then-picked-amped` | `p2c2q2` | 24464 |

and these must be **absent**: `s1626`, `s16128` (e5-amped), `s1628` (e5-di),
`s1692` (a3-di), `e838` (a3-amped).

This matters because the automated pass **did** overwrite one of them before a
lock was added — it replaced the owner's 19.613s with 19.745s silently. Check
that the lock actually holds rather than trusting that it was added.

**Counts.** `e5-amped` 190, `e5-di` 191, `a3-amped` 183, `a3-di` 183,
`held-then-picked` 120 each, `quarters` 72 each. A count that drifted means the
re-timing dropped or duplicated an event.

**Eval.** PASS with zero required failures, and exactly one informational
failure (`power-chords-b-a-g-fsharp-b-a-g-e-140bpm`, pre-existing). More than one
is a regression caused by this work.

**`clean-lead-120bpm` gated pitch class must still be 92.9%.** It is untouched by
any of this; if it moved, something is wrong that has nothing to do with labels.

## Independent verification you should do rather than repeat

The re-timing checks itself against the owner's ear and reports 6/6. **That check
is nearly circular** — four of those six points are locked values that the pass
is forbidden to move, so it cannot fail them. Build a check that does not have
that property. Two suggestions, neither tried:

- **Cross-render consistency.** DI and amped are one performance. After
  accounting for a constant offset, a re-timed DI onset should land on a real
  event in the amped audio. If the re-timed DI labels agree with the amped audio
  better than the grid did, that is genuine independent evidence.
- **Inter-onset intervals.** A human playing sixteenths at 120bpm produces
  intervals clustered near 125ms with human spread. Compare the interval
  histogram of the grid, the re-timed labels, and what a clean take
  (`quarters-di`, which has real measured onsets) looks like. Re-timing that
  produced a *tighter* distribution than a human plays would indicate it snapped
  to something spurious; one that produced a wildly looser one would indicate it
  lost the beat.

## Traps this project keeps falling into

Every one of these was hit during the work being validated, several more than
once. They are not hypothetical.

- **A window wider than the spacing of the events it discriminates.** A
  sixteenth at 120bpm is 125ms; at 140bpm it is 107ms. This error appeared five
  times in one day, including inside the label tool built to repair it: a 110ms
  match window let a label with no pick be adopted by its neighbour's.
- **A bench ranking is not a pipeline ranking.** An envelope witness scored 0.797
  offline and lost eleven held-out notes when built into the engine, because
  offline it was anchored on labels and in the engine it can only anchor on
  detected attacks.
- **Statistics that agree because they share a premise are one piece of
  evidence, not three.** `docs/SAME-PITCH-MATERIAL.md` records a false negative
  from exactly this. A single human listen refuted it.
- **The ear outranks the measurement.** When they disagree, the measurement is
  wrong until proven otherwise.

## What to do with what you find

- If the re-timing is sound, say so with the numbers, and update
  `docs/SAME-PITCH-MATERIAL.md`, whose "How the labels were made" section still
  describes these two takes as gridded. It is now stale.
- If it is not sound, **revert `7a216fe` and keep `b5cf94b`.** The owner's nine
  corrections stand on their own authority regardless of what the automated pass
  did. Do not revert both.
- Either way: a `DECISION_LOG.md` entry in the §6.3 schema, next sequential id,
  and a `docs/DETECTION-FINDINGS.md` entry with the numbers.

## Constraints

- **Do not change `src/`.** This is a data-validation task. If you find a
  detection bug, write it up; do not fix it here.
- **Do not edit `fixtures/labels/**` further** except to revert `7a216fe`
  wholesale. Any other change needs the owner, by ear.
- **Never use Tuninator's output to decide what a label should be.** `AGENTS.md`
  §3. The re-timing script does not, and neither should your validation — if you
  find yourself comparing labels against detections to decide which is right,
  stop.
- Never `git stash`.
- No AI or model identifiers in commit messages or code comments.

## Context you will want

- `DECISION-026` — why this material exists and what was deliberately left open.
- `DECISION-027`, `DECISION-028` — the two detection directions closed on this
  material, and the witness-separability table that closed them. Useful because
  they explain why the labels' accuracy is now the binding constraint.
- `docs/DETECTION-FINDINGS.md`, the two newest sections.
- `scripts/propose-label-corrections.ts` carries a status banner saying it does
  not work and why. Read it before writing anything similar; it is the record of
  three matching strategies that failed.
