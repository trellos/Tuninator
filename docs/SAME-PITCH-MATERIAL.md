# The 120bpm same-pitch material

Eight new fixtures — four takes, each captured as DI and through an amp sim —
recorded to close the gap DECISION-022 named: **the derivation set contains
about seven same-pitch re-articulations, all of them inside one take**, so every
derivation-set reading of the same-pitch decision has been a reading of a
mostly-different population.

This material is deliberately nothing but that phenomenon.

> **The labels in this set are PROVISIONAL.** They were generated, not
> hand-annotated by ear. Since then (2026-09-14) the player has listened to
> fifteen disputed points and corrected nine labels, and the two gridded DI
> sections have been re-timed against the audio and validated from the amped
> render (DECISION-029) — but the amped renders of the two fast takes are still
> on their own grids and `same-pitch-eighths-a3-120bpm-di`'s sixteenth section
> is flagged as unreliable. Read "How the labels were made" and "What was
> checked, and what is still open" before trusting a number computed against
> them, and see "Where the structure came from".

---

## The takes

| fixture stem | pitch | content | events |
|---|---|---|---|
| `same-pitch-quarters-a3-e5-120bpm-{di,amped}` | A3 then E5 | 8 measures of quarter notes on A3, then **10** measures on E5 | 72 |
| `same-pitch-eighths-a3-120bpm-{di,amped}` | A3 | eighth notes, then sixteenths from 19.9s | 184 di / 183 amped |
| `same-pitch-eighths-sixteenths-e5-120bpm-{di,amped}` | E5 | 8 measures of eighths, then 8 measures of sixteenths | 192 (amped copied from DI, DECISION-064) |
| `held-then-picked-six-strings-120bpm-{di,amped}` | F#2 C3 G3 C4 G4 D5 | per pitch: 4 cycles of [one measure held, one measure of quarter notes] | 120 |

All at 120bpm, so a sixteenth is 125ms — just above the corpus's tightest
subdivision (a sixteenth at 140bpm is 107ms).

**`held-then-picked` is the one to reach for first.** It puts the positive and
the negative class on identical material: a measure where one pick must produce
exactly one Note, immediately followed by a measure where four picks must produce
exactly four, at the same pitch, on the same string, through the same signal
chain. Nothing else in the corpus separates "a boundary the player put there"
from "a boundary the recognizer invented" that cleanly, and it covers all six
strings from F#2 to D5.

## Why these are not in `fixtures/eval.config.json`

Deliberately. A fixture with no config entry is reported by `npm run eval` and
**gates nothing** — the eval prints a warning naming it and scores it with an
empty config. That is the correct state for material whose labels have not been
reviewed. Adding thresholds is a decision for after the labels are confirmed.

They are also **not yet assigned to derivation or held-out.** That assignment is
the point of DECISION-022 and should be made deliberately, take by take — and
note that the DI and amped renders of one take are the *same performance*, so
they must land on the same side of the split or the split leaks.

Also note: three scripts decide derivation-vs-held-out three different ways —
`measure-decision-separability.ts` and `measure-same-pitch-population.ts` both
test `stem.includes("140bpm")`, while `measure-dp-segmentation.ts` matches an
explicit `DERIVATION` list by `startsWith`. These stems contain no "140bpm", so
the first two file them as derivation and the third files them as held out.
**Whichever way the split is decided, all three predicates need updating
together.**

## How the labels were made

Two inputs, neither of them the detector:

1. **Structure** — the player's own description of what he played.
2. **Onsets** — a plain broadband RMS envelope (20ms window, 5ms hop) with an
   envelope-rise onset rule, written specifically for this job.

**Tuninator was not used to place any label.** Using the detector's output to
decide what a label should be is circular, and `AGENTS.md` §3 calls it out by
name.

Pitches were confirmed independently by autocorrelation of the raw audio:
A3 ≈ 220.5Hz, E5 ≈ 658.2Hz, and the six strings of `held-then-picked` at
F#2 ≈ 92.8, C3 ≈ 130.9, G3 ≈ 196.0, C4 ≈ 260.9, G4 ≈ 390.3, D5 ≈ 588.0Hz.

Two placement methods, per take, as originally generated:

- **`quarters` and `held-then-picked`** — the envelope detector found *exactly*
  as many onsets as the structure predicts (72 and 120), so events are mapped
  one-to-one onto measured onsets. These carry real onset times, not a grid.
- **`eighths` and `eighths-sixteenths`** — the runs are too fast for the
  envelope rule to resolve every pick, so events were put on a fixed
  subdivision grid anchored on the first measured onset, with a single
  median-offset correction fitted across the take. The subdivision is musical;
  only the anchor is measured. **Each render was anchored on its own first
  envelope rise**, and on the amp-sim renders that rise fires late: the amped
  grids sit 195ms (A3) and 225ms (E5) after the DI grids although the audio of
  the two renders is aligned to 2.5ms (see below). So on these two takes a
  label id does *not* name the same pick in the DI and amped files — the
  player's own corrections show the pick at 31.344s as `s16108` in `e5-di` and
  `s16106` in `e5-amped`.

Each take was then **calibrated once** against `verify-fixtures.ts`'s own attack
search — which is deliberately cruder than, and independent of, the engine's
spectral flux — by shifting the whole label set so its median offset lands near
zero, where the rest of the corpus already sits. The shifts were +55ms
(quarters), +20ms (eighths A3), +30ms (eighths+sixteenths E5) and +80ms
(held-then-picked), each derived from the DI render and applied to both.

Two passes since, both on 2026-09-14, both recorded in each file's `timingNotes`:

1. **The player's listening pass** (`b5cf94b`). He listened to fifteen points
   where the recognizer and the grid disagreed and reported what he heard: five
   grid positions with no pick under them were removed, four onsets moved to the
   times he gave. This is human annotation and outranks everything else here.
   Counts became 183 (A3, both renders), 191 (E5 DI) and 190 (E5 amped).
2. **The DI grids re-timed by count** (`7a216fe`,
   `scripts/retime-gridded-labels.ts`). **The grid is gone from the DI renders
   of the two fast takes.** For each section, the most prominent peaks of a
   plain 20ms RMS envelope are over-selected and aligned monotonically to the
   section's own label count, with the player's values locked; a label with no
   pick found for it stays where the grid put it. Moved: e5 eighths 57 of 64
   (median |Δ| 13ms), e5 sixteenths 115 of 127 (20ms), a3 eighths 68 of 72
   (30ms), a3 sixteenths **78 of 111** (43ms). Validated in DECISION-029 from
   the amped render, which the re-timing never read: on e5 the re-timed
   sixteenth labels sit on 2.7× the amped onset energy the grid did, the
   verifier's attack-offset spread tightens three- to four-fold on every
   section, and inter-onset intervals scatter like the player's measured
   quarter-note takes. **The a3 sixteenth section is the exception:** a third of
   its off-beat picks are too quiet for any envelope method, its 33 unmoved
   labels are interleaved with re-timed ones, and 39 of its 110 intervals now
   fall outside 85–175ms. It is no worse per label than the grid was and is
   not verifiable from the amped render. Treat it as ±65ms data. The unmoved
   ids are listed in `docs/DETECTION-FINDINGS.md`.
3. **The player's second listening pass**, same day, on the DI files only. He
   gave every pick attack he heard in 19.0–20.3s and 21.0–21.8s of the E5 take
   and 19.0–20.8s and 33.3–34.0s of the A3 take — 37 times, applied verbatim.
   On E5 the 19.614s pick is `s1614` and 19.744s is `s1615` (the count was
   right, the earlier lock's id was not), and `s1628` is restored at 21.297s.
   On A3 the eighth at 19.230s (`e870`) had no pick under it and is removed,
   both section-end picks are labelled (`s160` 19.875s, `s16113` 33.955s), and
   two very weak picks at 19.131s and 19.599s are deliberately unlabelled: he
   calls them bad playing and says missing them is fine, and a label is by
   definition an event the recognizer must find. Where his times overlap the
   re-timing, the re-timing was within 5ms on 21 of 31 labels and within 15ms
   on 29. Counts: `e5-di` 192, `a3-di` 184.

The amped renders of these two takes are untouched by either the re-timing or
this validation: still on their own late-anchored grids, with the player's
corrections applied. In their sixteenth sections those labels sit at chance on
their own audio. Carrying the re-timed DI times across at +2.5ms is the obvious
repair and is the player's decision.

### What `npx tsx scripts/verify-fixtures.ts` says about them

As of the current labels (after both 2026-09-14 passes):

| fixture | labels | concerns | attacks found | p10 | median Δ | p90 |
|---|---|---|---|---|---|---|
| `same-pitch-quarters-a3-e5-120bpm-di` | 72 | **0** | 72 | −35 | **0** | 25 |
| `same-pitch-quarters-a3-e5-120bpm-amped` | 72 | 68 | 4 | −60 | −35 | 0 |
| `same-pitch-eighths-a3-120bpm-di` | 184 | 58 | 126 | −30 | **−18** | −7 |
| `same-pitch-eighths-a3-120bpm-amped` | 183 | 181 | 2 | — | 65 | — |
| `same-pitch-eighths-sixteenths-e5-120bpm-di` | 192 | 48 | 144 | −18 | **−13** | −5 |
| `same-pitch-eighths-sixteenths-e5-120bpm-amped` | 190 | 114 | 76 | −5 | 25 | 55 |
| `held-then-picked-six-strings-120bpm-di` | 120 | **2** | 118 | −50 | 50 | 130 |
| `held-then-picked-six-strings-120bpm-amped` | 120 | 59 | 61 | −5 | 45 | 115 |

For scale, existing fixtures on the same measure: `chords-a-bm-g-d` median −20,
`clean-lead-120bpm` +27, `lead-line-di-sixteenths` −9.

Two things to know about reading this table for the two re-timed DI files.
Their p10..p90 spread was −40..+40 (A3) and −30..+30 (E5) on the grid and is
now 20ms wide, centred on a constant −13 to −20ms: the re-timed labels sit at
the RMS *peak* and the verifier fires at the *rise*, so that lag is uniform
where it used to be scattered. And **the concern count cannot see that**: a
label earns an onset concern only when no rise exists inside a search bounded
at the midpoints to its neighbours — ±62ms at sixteenth spacing — and no move
in the re-timing exceeds 90ms, so the count is blind to a sub-window move by
construction. Its per-label offsets are the sensitive reading, not its total.

**The DI renders are in good shape.** Two of the four have essentially no
concerns; `held-then-picked-di` in particular went from 61 concerns to 2 under
calibration, which is the take that matters most.

**The amped renders carry far more concerns, and that is mostly the verifier, not
the labels.** An amp sim compresses the envelope until a crude rise test can
barely locate a pick — it finds an attack for 2 of 183 labels on the A3 amped
render — and its distortion crowds the chroma so pitch support reads badly.
Same "attack contrast varies 2.0×–24.2× across the corpus" problem the
evaluation already documents — worth having in the corpus, and a reason not to
read the amped rows as a verdict on the labels. **The two renders of each take
are one performance, time-aligned to 2.5ms** (measured by cross-correlating an
onset-strength function between the renders on three takes, with a sharp peak
and the runner-up at the eighth-note period; the player's own ear gave the same
time on both renders for three picks). Two earlier offset estimates in the
record, 9–56ms and 80–90ms, were both wrong. `quarters`' labels are identical
on both renders; `held-then-picked`'s amped labels differ from its DI labels by
a median 15ms; the two fast takes' amped labels are separately-anchored grids,
195/225ms behind the DI ones, as described above.

The A3 eighths take's DI concern count rose from 6 to 61 when its sixteenth
section was labelled, which is the verifier finding fast quiet picks over a
ringing note hard to confirm — the same difficulty the take exists to capture.
It is 59 now; the labels it cannot confirm are the same quiet off-beats the
re-timing could not locate.

## What the recognizer does on it today

`npx tsx scripts/measure-splits.ts`, as of now. Two things have moved these
cells since the DECISION-026 snapshot: the labels (the 2026-09-14 passes, which
change which Note is assigned to which event) and DECISION-030's rate-relative
fragment bar, which is the first engine change to touch this material:

| fixture | labels | split | extras | worst |
|---|---|---|---|---|
| `same-pitch-quarters-a3-e5-120bpm-di` | 72 | 6 | 6 | 2 |
| `same-pitch-quarters-a3-e5-120bpm-amped` | 72 | **50** | **78** | 4 |
| `same-pitch-eighths-a3-120bpm-di` | 184 | 5 | 5 | 2 |
| `same-pitch-eighths-a3-120bpm-amped` | 183 | **55** | **60** | 4 |
| `same-pitch-eighths-sixteenths-e5-120bpm-di` | 192 | 23 | 23 | 2 |
| `same-pitch-eighths-sixteenths-e5-120bpm-amped` | 190 | **26** | **34** | 3 |
| `held-then-picked-six-strings-120bpm-di` | 120 | 8 | 8 | 2 |
| `held-then-picked-six-strings-120bpm-amped` | 120 | **48** | **60** | 5 |

Corpus total moved from 99 of 459 events split to 336 of 1595, 403 extra Notes
when the material landed. On the current labels, and with DECISION-030's
rate-relative fragment bar in the engine, it reads **318 of 1592, 379 extra
Notes**. Two separate things moved it. The labels got closer to the picks, which
changes which Note is assigned to which event (`e5-di` went 21 → 25 on re-timing
and back to 23 after the listening pass) — a more accurate measurement, not a
regression. Then DECISION-030 removed 28 extra Notes corpus-wide for no missed
label, which is most of the `held-then-picked-amped` and `e5-amped` movement in
the table above.

**The signal path dominates.** These are pairs: the same performance, differing
only in whether the capture is direct or through an amp sim (the label timings
are identical on `quarters`, 15ms apart on `held-then-picked`, and on the two
fast takes the amped file is a separately-anchored grid — see "How the labels
were made"). Split rates go 8% → 69% on the quarters take, 3% → 30% on the A3
eighths, and 7% → 40% on held-then-picked. Up to five Notes on a single played
event.

That is a sharper statement of the problem than the corpus could previously
make, and it points somewhere specific: whatever separates a real re-pick from a
spurious boundary is surviving a direct input and collapsing under compression
and distortion. It also fits the standing measurement that attack contrast varies
2.0×–24.2× across the corpus and up to 106× within one take.

### What SHAPE those splits are

Measured in DECISION-027, on an instrument that reads no label onset —
`measure-tail-fragments.ts`, added because this material's amped labels carry up
to 65ms of placement offset and the existing shape classifier's buckets are 45ms
wide:

| fixture | extras | same pitch, contiguous | detached | other pitch |
|---|---|---|---|---|
| `same-pitch-quarters-a3-e5-120bpm-amped` | 63 | **63** | 0 | 0 |
| `same-pitch-eighths-a3-120bpm-amped` | 53 | **53** | 0 | 0 |
| `same-pitch-eighths-sixteenths-e5-120bpm-amped` | 37 | **37** | 0 | 0 |
| `same-pitch-eighths-sixteenths-e5-120bpm-di` | 19 | **19** | 0 | 0 |
| `same-pitch-eighths-a3-120bpm-di` | 3 | **3** | 0 | 0 |
| `same-pitch-quarters-a3-e5-120bpm-di` | 1 | **1** | 0 | 0 |

(Current labels; DECISION-027's snapshot read 36 on the E5 amped row.)

Every extra Note on all six, without exception, is at the label's own pitch
class and butted against its neighbour. This material does exactly what it was
recorded to do. Note also that the median SHORTEST Note in a split event across
the corpus is 93ms — above `tracking.minStableMs` (55) and `deep.minSegmentMs`
(90) — so these are not sub-threshold blips.

Beware `measure-split-shape.ts` on this material specifically: until
DECISION-027 it tested the previous label's name before the label's own, which
makes its `same pitch twice` bucket unreachable whenever consecutive labels
share a pitch — which here is almost every label. It reported one such split on
a 184-label take where all 184 labels are A3.

Two cautions before building on these numbers. The labels are provisional, and
the amped labels carry the most `verify-fixtures.ts` concerns — though note
that on `held-then-picked` the amped labels differ from the DI ones by a median
15ms, so the 8-vs-61 gap on one performance cannot be a labelling difference.
And `same-pitch-eighths-a3` has an open structural question below.

## Where the structure came from

Both open questions have been answered by the player, and one of my answers was
wrong. Recorded here because the correction is instructive.

1. **`quarters`: the E5 section really is 10 measures, not 8** — confirmed.
   Verified twice, independently: pitch is A3 for exactly 32 onsets and changes
   at 17.980s, leaving 40 onsets after it, evenly spaced at 0.500s throughout.
   32/4 = 8.00 measures and 40/4 = 10.00 measures exactly. The labels follow the
   audio.
2. **`eighths A3` does contain a sixteenth section, starting at 20.0s** — the
   player listened and said so, and the labels now say so: 72 eighths, then
   sixteenths — 112 on the original grid from 19.960s, 111 since the player
   removed `s1692` (31.355s, no pick under it), 113 since his second pass: the
   DI audio carried pick-like events with no label at both ends of the section,
   and he confirmed both — the sixteenths begin at 19.875s (`s160`, one
   sixteenth before the nominal 20.0s) and the take ends on a slight pick at
   33.955s (`s16113`). The eighths are 71 on the DI render: `e870` (19.230s)
   had no pick under it.

   **I had previously reported that this take had no sixteenth section at all,
   on three converging measurements. That was a false negative.** Worth the space,
   because the failure is the kind this repository already documents. Onset
   spacing said eighths because the envelope rule drops roughly half the picks in
   a fast same-pitch run — exactly the material it is worst at. Envelope
   modulation and autocorrelation said eighths because I compared this take's
   absolute figures against *the E5 take's*, when the two are voiced differently:
   in the E5 take the strongest envelope periodicity sits at the note period,
   while in the A3 take it sits at twice it, on the accent. Measured against
   itself over time the A3 take does drop from a 0.5s peak lag to 0.25s after
   20s, which is the boundary — but I read the cross-take comparison first and
   stopped.

   Three statistics agreeing is not three pieces of evidence when they share a
   premise. The ear settled it in one listen.

Neither take's subdivision can be resolved reliably by the crude envelope tools
used here. Treat any future claim about subdivision in this material as needing
a human listen, and note that this difficulty is itself the property the
material was recorded for.

## What was checked, and what is still open

The 2026-09-14 validation (DECISION-029; full numbers under "The re-timed
labels, checked from the other render" in `docs/DETECTION-FINDINGS.md`) built
checks the re-timing could not pass by construction: its own 6/6 against the
player's ear rests on four values it is forbidden to move. What held:

- the re-timing reproduces byte for byte from `b5cf94b` and the script;
- all eight files are strictly ordered, overlap-free, at the stated counts,
  with the player's nine corrections intact;
- on `e5-di`, the re-timed sixteenth labels land on 2.7× the onset energy in
  the **amped** render that the grid did, and 115 rather than 99 of 127 sit
  within 25ms of a strong amped peak;
- the verifier's attack-offset spread tightens three- to four-fold on all four
  re-timed sections;
- inter-onset intervals on `e5` and on `a3`'s eighths scatter like the player's
  measured quarter-note takes (SD 21–22ms against 16–20);
- unlocking the player's ear points one at a time, the method lands five of
  six within 11ms. The sixth, `s1615` at 19.613s, it puts a sixteenth later —
  and the pick sequence in both renders says the method's *count* is right and
  the lock is enforcing an id the ear never gave. That one point is open.

Three of the four questions that left open were settled the same day by the
player's second listening pass (pass 3 under "How the labels were made"): the
19.614s pick is `s1614`; A3's sixteenths run 19.875s to 33.955s and both ends
are labelled; the three off-beats at 21.04 / 21.30 / 21.55s are all picks and
all labelled. What is still open, all of it the player's, DI first:

1. **The A3 sixteenth section's 33 grid-placeholder labels** between 21.1s and
   33.4s. His pass over 20.0–20.8s heard every sixteenth, including the quiet
   off-beats the envelope could not, so the same method settles the rest.
2. Whether to carry the corrected DI times to the amped files at +2.5ms.
   Deferred on his instruction.

Until then: `same-pitch-eighths-sixteenths-e5-120bpm-di`,
`same-pitch-quarters-a3-e5-120bpm-di` and `held-then-picked-six-strings-120bpm-di`
carry measured onsets; `same-pitch-eighths-a3-120bpm-di`'s eighths and its
first 0.9s of sixteenths do too; the rest of that sixteenth section and every
amped fast-take label are ±65ms data.

## Before relying on this material

```bash
npx tsx scripts/verify-fixtures.ts        # audible / attack-aligned / pitch-supported
npx tsx scripts/measure-same-pitch-population.ts   # re-run DECISION-022's count
```

`verify-fixtures.ts` is the one that matters: it checks each label against the
audio independently, and it is the cheapest way to catch a systematic error in
a generated label set before anything is derived from it.

## The amped re-timing pass: two takes proposed, two refused

`scripts/propose-amped-onsets.ts` derives onsets for the four amped renders from
the amped audio itself — a plain signal measurement, sharing no constant and no
line of code with Tuninator, which is never consulted. It writes a proposal to a
`--out` directory, has no `--write` mode, and refuses any path under `fixtures/`.
Proposals are scored by importing `verifyFixture` from `verify-fixtures.ts`, so
the before/after numbers come from that script's own code, constants and concern
wording rather than a lookalike.

| take | events in → out | median shift | placement |
|---|---|---|---|
| `quarters-a3-e5-amped` | 72 → 72 | 0ms | no change proposed; still matches DI |
| `eighths-a3-amped` | 183 → 183 | **−187ms** | proposed (p10 −240, p90 −137) |
| `eighths-sixteenths-e5-amped` | 190 → 190 | **−215ms** | proposed (p10 −241, p90 −187) |
| `held-then-picked-amped` | 120 → 120 | — | **refused, see below** |

Event counts are identical in and out everywhere; no pitch, name, id or ordering
was touched.

**Where the evidence is real.** On `e5-amped` — the only amped render with
enough findable attacks to measure placement at all — the proposal takes the
error against the independent attack search from **|Δ| median 25ms to 8ms**, p90
55ms to 20ms. That is better than the DI render's own 13ms. It was computed
after the method was fixed, with nothing tuned on it.

**`held-then-picked-amped` is a clean no.** The prominence method fails its own
DI control at a 105ms interquartile spread on clean audio — 2s held notes defeat
an envelope peak-picker, which is the same class of error as a window wider than
the spacing it discriminates. The only move on offer was −15ms, inside the
40.7ms spread of the measurement that would justify it, and applying it made the
concern count worse (59 → 61). Refusing is the result.

**The concern count is not the target, and this is the measurement behind that.**
Every concern on all eight renders is "no energy rise near `startMs`". The
verifier's rule fires legitimately only 10, 7, 80 and 75 times against 72, 183,
190 and 120 labels; the rest is a head noise floor above the engine's `rmsGate`,
at 14.3% and 31.3% of envelope peak on two amped renders. The floors below which
no label placement can take these counts are 62, 176, 110 and 45. This is what
"that is mostly the verifier, not the labels" above was asserting, now measured.

**Structural disagreement: `e5` settled by the owner on 2026-09-23 (DECISION-064).**
`e5` carried 192 DI events against 190 amped for one performance. The owner
chose the DI set: the amped file now holds the DI events shifted +3ms (the
renders align at +2.5ms), which also retires that file's 35-60ms grid drift.
`eighths-a3` still carries DI-only `e838` and amped-only `s1692`; that pair is
unresolved.

### What applying the proposal does to the reported numbers — and why that is not a validation

Measured in a throwaway detached worktree with the two proposals overlaid;
nothing under `fixtures/` in the repository was touched. The twenty-three
untouched fixtures read bit-identically, as they must.

| | labels | Notes | missed | false pos | pitch class | exact | onset median abs |
|---|---|---|---|---|---|---|---|
| `eighths-a3-amped` now | 183 | 218 | 9 | 44 | 95.1% | 87.4% | 31ms |
| `eighths-a3-amped` proposed | 183 | 218 | **10** | **45** | **94.5%** | 87.4% | **37ms** |
| `eighths-sixteenths-e5-amped` now | 190 | 209 | 13 | 32 | 92.6% | 92.6% | 27ms |
| `eighths-sixteenths-e5-amped` proposed | 190 | 209 | 13 | 32 | 92.6% | 92.6% | **18ms** |

Corpus-wide: 137 missed to 138, 345 false positives to 346, pitch class 89.9%
unchanged, exact 84.9% unchanged. `measure-splits.ts` goes 340 split / 410
extras to 354 / 421, because moving a label changes which Note it pairs with.

**Read the direction of inference carefully, because it is the trap this
material exists to avoid.** None of the above is evidence about whether the
labels are right. Judging a label by whether the recognizer scores better
against it is precisely the circularity `AGENTS.md` §3 forbids — a detector and
a label set can agree because both are wrong in the same direction, which on a
DI-derived label set applied to an amped render is the expected failure, not an
unlikely one. The non-circular instrument is `verify-fixtures.ts`'s independent
attack search, and it says `e5-amped` improves from 25ms to 8ms while
`a3-amped` **has no measurable anchor at all** — the hiss swamps the rise, so
its proposal rests on a whole-render cross-correlation rather than on located
attacks.

Two conclusions follow.

**The corpus numbers were never being held back by this.** A 187–215ms label
error on two amped takes moves the corpus by one missed label and one false
positive. Anyone hoping a label review would unlock an accuracy gain should
stop hoping: it will not, and that is worth knowing before the review rather
than after.

**Propose `e5-amped`; hold `a3-amped` for a listening pass.** `e5` improves on
the independent measure and costs nothing on the dependent one. `a3` improves on
neither: its independent anchor is unmeasurable and the recognizer's own onset
error gets *worse* (31ms to 37ms) while it loses a label. That disagreement does
not prove the proposal wrong — the detector is not a judge here — but a proposal
with no independent support and a dependent measure pointing the other way is
exactly the one a human should place by ear.

## The owner's third listening pass — 2026-09-23 (DECISION-064)

He answered the label review list through a listening page that played a clip
of each moment with the labels drawn on its envelope, and moved labels by
clicking where he heard the note start. Applied verbatim; Tuninator was not
consulted.

- `quarters-a3-e5-di` `e36` 35.450 → 35.490s (the old time was the contact).
- `held-then-picked-di` `p1c1q1`–`p1c1q4` → 4.036, 4.533, 5.039, 5.523s, each
  about 50ms earlier. The rest of that take was not moved: measured against a
  plain 10ms envelope, its labels' offsets to the strongest nearby rise run from
  about 60ms early to 60ms late stroke by stroke, so it needs a per-stroke pass,
  not a shift.
- `held-then-picked-amped` `p1c4q4` 17.535 → 17.478s.
- `eighths-a3-di`: all 33 grid placeholders listened to. `s166` → 20.611s,
  `s1614` → 21.617s, `s1697` → 32.117s (no pick under 31.980s; the pick he hears
  is after `s1698`, so the events are re-sorted and those two ids run out of
  numeric order). The other 30 stay on their grid times, now confirmed by ear.
- `eighths-sixteenths-e5-amped` replaced by the DI events +3ms (above).
- Confirmed unchanged: `t12`, `s7` and `s161` (two picks each where asked), and
  the mic triplet `t5` (a separate stroke, not the ring of the note before).

**Twins not moved.** Each answer was applied to the render he judged. The DI
twin of `p1c4q4` and the amped twins of `e36` and `p1c1q1`–`q4` were not moved,
so those pairs no longer sit at their files' usual offset.

**Found while applying it, not applied.** `quarters-a3-e5-di` `e26`–`e40` sit
30 to 52ms before the strongest nearby rise, drifting later along the section.
His four marks in the `e36` clip land on those rises. The A3 half of the take
reads a median 18ms the other way.

## The rest-and-repick take — 2026-09-24 (DECISION-066)

The one shape the corpus lacked: a note picked, rung, damped for a rest,
then picked again. The owner recorded it on 2026-09-23 as a DI take and
re-amped it, and on 2026-09-24 asked that recognition be calibrated to
both files, so they are **derivation**, not held out.

- `rest-repick-g2-60-120bpm-di` and `-amped`, eight picks of G2 each:
  four 4s apart, then four 2s apart, each damped about halfway to the
  next pick. The amped render lags the DI by about 3ms.
- Labels are measured, not placed by ear (see the files' `timingNotes`):
  a start where the note sounds, an end on the damp. The amped labels
  are the DI labels +3ms. The quiet pick contact 150-350ms before most
  picks is not labelled.
- Before any change the engine found all eight picks on both renders,
  with five extra Notes on each. On the DI take every extra was a
  90-170ms G#2 at a damp: stopping the string pushes it sharp for a
  moment (98Hz to 104.6Hz at 10.08s), and the region lane cut that off
  as a Note. `deep.dampTailMs` removes all five. On the amped take the
  extras are stubs before three picks, one on a pick contact and one
  after a damp; five picks are named G5 and one "unknown".

## The quarters take's E5 section re-timed — 2026-09-24 (DECISION-067)

`quarters-a3-e5-di` `e26`-`e35` and `e37`-`e40` sat 30-52ms before the
note sounds, drifting later along the section, the error the owner
corrected by ear on `e36`. On his word they are moved onto the big rise
of a 10ms RMS envelope, and sent back to him on a listening page to
confirm. The amped twin is not moved.

