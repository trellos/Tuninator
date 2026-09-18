# Loop brief: slow notes must not split

> **STATUS: ACTIVE LOOP.** Every run of this brief is ONE iteration. Before
> anything else, read `docs/slow-note-splits-loop-log.md` — it holds the
> baseline, every earlier iteration's verdict, the living candidate ledger and
> the owner-side blockers. Append your iteration there before you finish. The
> loop ends when the exit rule in §9 fires, and the iteration that fires it
> writes the exit report. Written for any coding agent; nothing here assumes a
> prior conversation.

Read `AGENTS.md` in full before your first edit. It is the contributor-facing
source of truth — architecture, invariants, the evaluation harness, the
constraints that bind every change, and the mandatory decision-logging
protocol. `CLAUDE.md` only points there. Then read this whole brief before
running anything.

---

## 0. How this loop runs

- **One iteration per session, one mechanism per iteration.** Research, pick
  ONE candidate, state its falsifier, build it behind a config gate, measure it
  in the pipeline, keep or revert, document, commit, push, append to the
  journal. A tuning pass (§6.6) is allowed only on a mechanism that already
  cleared the bar in the same iteration. If a candidate is falsified cheaply on
  the bench before anything is built, you may take a second candidate in the
  same session; if a candidate was BUILT and reverted, stop there and write it
  up — the write-up is the iteration's product.
- **Start every iteration from the journal**, not from this brief's numbers.
  The journal's latest entry says where the corpus stands and which candidates
  are spent. §5's baseline figures are as of 2026-09-18 and go stale.
- **Branch:** the branch your session was given. Never push elsewhere. Every
  iteration ends with a pushed commit, kept or reverted; a reverted iteration
  still commits its findings entry, decision entry and journal entry.
- **The owner reads the journal, not the transcript.** Anything you need from
  the owner — a listening pass, a recording, a decision about the consumer's
  API — goes in the journal's "Owner-side blockers" section as a specific
  request with what it unblocks. Do not stop the loop to wait for it unless
  the exit rule says so; continue on the corpus as it stands.

## 1. The defect, in the owner's words and in this repository's

The owner's consumer is GOATerizer, a rhythm game that scores one target per
pick and reads a Note's duration. It runs Tuninator on a phone microphone in
front of an amped guitar, and on a direct input. During its tutorial, slow easy
notes — quarters and eighths — split: a note played on time comes out as a
short Note followed by another Note, so the game sees a short note where a long
one was played, and the next target is often taken by the phantom.

In this repository that is the **same-pitch tail fragment**: one played event
emitted as a correctly named Note plus a contiguous Note at the same pitch
class. It is the defect DECISION-027 through DECISION-037 circle, and it is
already measured, at length. What this brief adds is a target the earlier work
did not have: the **slow subset**, quarters and eighths only, scored per signal
path, because that is where the owner's players are and it is not where the
project's sixteenth-note ceiling studies looked.

**The corpus reproduces the complaint without any new recording.** As of
2026-09-18 on `main` at `1c5e632`, `npx tsx scripts/measure-splits.ts
--subset=slow` reads 754 quarter- and eighth-note labels across twelve takes:

| take (slow labels) | DI | amped / room mic |
|---|---|---|
| `same-pitch-quarters-a3-e5-120bpm` (72) | 9 split / 10 extra | **50 split / 79 extra** |
| `held-then-picked-six-strings-120bpm` (120) | 8 / 8 | **47 / 59**, worst 5 Notes on one pick |
| `same-pitch-eighths-a3-120bpm` eighths (71) | 6 / 6 | **37 / 42** |
| `same-pitch-eighths-sixteenths-e5-120bpm` eighths (64) | 22 / 22 | 24 / 32 |
| `lead-line-…-quarter-eighth-triplet-140bpm` q+e (31) | 7 / 8 | amp **21 / 22**, mic 10 / 11 |
| `clean-lead-120bpm` quarters (7) | 0 / 0 | — |
| **slow subset total (754)** | **52 / 54 on 365 DI labels** | **189 / 245 on 389 amped or mic labels** |

Two things to take from that table before planning anything.

- **Roughly one slow note in seven splits on a direct input, and one in two
  through an amp.** The signal path dominates, on the same performance: the
  quarters take is 9 of 72 on DI and 50 of 72 amped. Whatever separates a real
  re-pick from an invented boundary survives a direct input and collapses under
  compression and distortion (DECISION-026's headline, still true).
- **These are slow notes.** A quarter at 120bpm is 500ms and the fragments are
  93ms at the corpus median. The rate-relative announce bar of DECISION-030
  already fires here (0.35 × 500ms = 175ms) and the split rate is still 69% on
  the amped quarters. So the slow subset is not the sixteenths problem seen
  again; the boundary is being accepted at instants where the phrase context
  says plainly that nothing was picked.

Where the accepted boundaries come from (`scripts/measure-split-cause.ts`,
corpus-wide): 175 of 267 same-pitch contiguous fragments were accepted by the
`sharpness` fallback in `fast/rearticulation.ts`, 35 by `envelope-rise`, 27 by
no re-articulation decision at all (the region lane or a Note ending and
restarting), 21 by `new-pitch`. At those wrong boundaries sharpness reads a
median 3.85 and p90 10.06 against a bar of 1.6: the engine is reading a real
spectral rise and calling it a pick.

**The phone microphone is not in the corpus.** The "mic" takes are a room mic
on a Les Paul. A phone adds its own compression, automatic gain, noise
suppression and a band-limited capsule, all of which push the signal further
toward the amped renders' behaviour. §10 says what to ask the owner to record;
until it lands, the amped renders are the closest stand-in and every result is
reported per signal path so the direction of transfer is visible.

**GOATerizer's capture path is this library's, with two settings the eval
never runs at.** Read from `trellos/goaterizer` on 2026-09-18 (the journal has
the detail): it calls `createRecognizer()` with the speech processors
explicitly off and lets the library open the microphone; it does not record
audio anywhere. But after a calibration it passes `engine.rmsGate` as low as
0.00008, a hundredth of the shipped default, and its `AudioContext` runs at
the device's sample rate where every fixture here is 48kHz (at 44.1kHz the
hop is 11.6ms, not 13.3ms). The journal's ledger rows C7 and C8 are the cheap
measurements that say whether either moves the slow subset; take them before
any mechanism, because a fix measured at the eval's gate may not be the fix
the player is running.

## 2. What "fixed" means, and how it is scored

The standing bar (`AGENTS.md` §4): **every played note reads as one Note**, on
both axes. Nothing below relaxes it.

**Primary target — the slow subset, per signal path.**

```bash
npx tsx scripts/measure-splits.ts --subset=slow            # the table above
npx tsx scripts/measure-splits.ts --subset=slow --detail   # every split event, note by note
```

`--subset=slow` is defined in the script header (per-fixture label-id rules;
754 labels). Report split events and extra Notes, DI and amped/mic separately,
before and after. A change that helps the amped column and costs the DI column
is a finding to write up, not a commit.

**Second axis — missed labels must not rise.**

```bash
npx tsx scripts/measure-downstream-ledger.ts --all         # missed labels, per fixture, by cause
```

Corpus-wide MISSED as of the baseline is 137. A mechanism that removes phantoms
by absorbing played notes has failed, whatever the split column says. That is
the exchange rate every energy witness in DECISION-028 died on: roughly one
real note per phantom. Beat it or report it.

**Third — the whole corpus, both axes**, so the slow subset was not bought
with the rest:

```bash
npx tsx scripts/measure-splits.ts                          # 316 of 1592 split, 379 extra at baseline
npx tsx scripts/measure-tail-fragments.ts                  # shape: same pitch / detached / other pitch
npm run eval                                               # PASS, zero required failures
```

**Fourth — the consumer's view.** GOATerizer DOES act on a
`structuralRevision` with `relation: "absorbed"`: the absorbed id becomes a
retraction that un-draws the bar, refunds a wrong-note charge and reopens a
target not yet judged (its DECISION-110). What it does not undo is a verdict
already shown, and its judge settles a target at the note's RELEASE: a Note
held for under half the written length is a Miss on the spot. So the first
half of a split quarter is already a Miss before any absorption can arrive,
and the same-pitch fragment behind it is charged as a wrong note or steals the
next target. `src/offline/eval-adapter.ts` scores the FINAL Note stream,
absorbed Notes removed, which is what the game sees once a retraction lands.
For any mechanism that announces and then retracts, report separately: how
many fragments were announced then absorbed, and the latency from the
fragment's `noteStarted` to its absorption (median and p90) — a retraction
that arrives after the survivor's release has already settled a Miss helps the
score sheet and not the player. DECISION-036 makes retraction admissible;
DECISION-030's precedent is that where never-announcing measures the same as
announce-then-retract, the simpler one ships. Prefer that order.

**Fifth — derivation discipline**, which is the only reason any number means
anything. Derivation is the five 120bpm originals plus the eight 120bpm
same-pitch takes (DECISION-028 assigned them as calibration material); the
twelve 140bpm Les Paul takes are held out and read only after a bar is fixed.
The eight takes' labels are PROVISIONAL (`docs/SAME-PITCH-MATERIAL.md`): two
of the amped fast takes sit on grids up to 65ms off and one DI sixteenth
section is flagged. Say which predicate produced any derivation/held-out
number — three scripts compute the split three ways
(`docs/SAME-PITCH-MATERIAL.md`, "Why these are not in eval.config.json").

**Sixth — every window against the tightest subdivision.** A sixteenth at
140bpm is 107ms; at 120bpm, 125ms. A window wider than the spacing of the
events it discriminates has produced a false finding at least five times in
this project. The slow subset does not exempt you: the same mechanism runs on
the sixteenth sections of the same files, and the ledger will show what it
costs there.

## 3. Read before you plan — in this order, and what to take from each

1. `AGENTS.md`, whole. §3 (the harness, the derivation split, the eighty
   measured experiments), §4 (constraints), §6 (decision logging).
2. `docs/slow-note-splits-loop-log.md` — the journal. Latest numbers, spent
   candidates, open blockers.
3. `docs/DETECTION-FINDINGS.md`, these sections, in this order:
   - "What the split shapes actually are" and "The fragmentation metric charged
     a tail fragment to the event that had not started" — the shape, note by
     note.
   - "Forward absorption: the instruments were wrong, then the mechanism was
     refuted" — why `regionMerge` costs 222 played notes.
   - "The envelope dip: the best witness yet, and still not enough" — the
     witness table (every boundary reading tops out at 0.698 AUC), the seven
     configurations that all trade one real note per phantom, and "why 0.78 is
     not enough, which is arithmetic".
   - "A tail fragment is short FOR THE PACE" — the one gate that shipped at
     zero cost, its estimator's circularity, the oracle ceiling ("a perfect
     clock is worth about twice the reach and it is no longer free"), and the
     three rhythm readings measured and not kept.
   - "Rhythm features at the boundary: the learned-model gate, and it fails" —
     and, inside it, "two benches in this repository measure different things".
   - "The DI repair, scored on the eight 120bpm takes" — especially "Why the
     merge does not move the split axis at all", "Why the deep lane does not
     already do this", "The rate gate's ceiling, re-measured", "The two pace
     attempts, side by side", and "The third pace attempt".
   - "Segmenting a region JOINTLY, by dynamic programming: measured, refuted" —
     read the verdict paragraph twice: the DP was fine, the COST was at chance.
   - "Lessons carried over from the retired lineage" — a bench ranking is not a
     pipeline ranking; a trailing window answers for the previous note.
4. `DECISION_LOG.md`: 022, 026, 027, 028, 030, 031, 032, 033, 035, 036, 037.
5. `docs/SAME-PITCH-MATERIAL.md` — what the eight takes are, how their labels
   were made, what is still open on them.
6. `docs/DI-ACCURACY-ROADMAP.md` §4 and §8 — a literature survey already run
   for this project, with its per-approach verdicts and the sources. Your
   research in §6.1 extends it; it does not repeat it.
7. The four closed briefs, banners only: `docs/forward-absorption-prompt.md`,
   `docs/onset-features-prompt.md`, `docs/learned-onset-head-prompt.md`,
   `docs/ceiling-click-tracker-prompt.md`. They are run to verdicts. Do not
   pick them up.
8. Code: `src/engine/fast/rearticulation.ts` (the five bars and the fallback
   that accepts 175 of the 267); `src/engine/tracker/note-tracker.ts`
   `process()` steps (a)–(d), `localIoiMs()`, `end()`, `absorbAttackFragments()`
   and its `restruck && announced` guard; `src/engine/deep/resegment.ts` and
   `deep-lane.ts` (`analyzeRegion`, `regionSettleMs`, `maxRegionMs`,
   `ringSeconds`); `src/engine/config.ts` comments on `rateFragment*`,
   `regionMerge`, `regionCorrectPitch`, `ringOut*`; `src/engine/tracker/voices.ts`
   (`VoiceDecay`); `src/engine/tracker/hypotheses.ts`.

## 4. The closed roads — do not drive down these again

Each of these was built or measured to a verdict with its numbers recorded.
A candidate whose mechanism is one of these needs to say, in writing, what is
different and why the recorded number does not already answer it.

| direction | verdict | where |
|---|---|---|
| Any single-number threshold at a single boundary, on any witness the engine computes (`sharpness`, `fluxRatio`, `heldSharpness`, `heldFluxRatio`, `troughRatio`, `riseRatio`) | tops out at 0.698 AUC; every gate reshuffles a 0.70 discriminator | DECISION-028, "The envelope dip" |
| The envelope dip before a boundary as a GATE | 0.763 AUC, above the bar, still one real note per phantom at any threshold; ships as a WITNESS in DECISION-030 only | DECISION-028 (a)–(f) |
| A fixed-duration bar on a fragment (80ms, 100ms, `minStableMs` > 60, `articulationMs` > 100) | 80ms costs 77 played notes, 100ms costs 173; the sixteenth cliff | DECISION-030 (a); "Hypotheses tested and rejected" |
| `deep.regionMerge` on, or restricted to non-attack Notes | 383 missed against 161; restricted: 14 extras for 14 misses | DECISION-027, DECISION-028 (a) |
| Suppress at announcement on boundary witnesses; delay `noteEnded` past an absorption window | decides on strictly less evidence than the refuted retrospective test; latency in a real-time library | DECISION-027 (a), (c) |
| The retrospective question with a fragment's own duration, decay and attack witness | answered: not on the better side of the ceiling | DECISION-027 |
| A local rate as an ABSORB ratio (pace attempts 1–3) | 9 Notes at 0.35 and 19 at 0.40 against a bar of 35; at 0.40 the trade is 19 extras for 1 missed and 18 of the 19 sit on PROVISIONAL labels — "not yet decidable"; module withdrawn in `a10d0e5` | DECISION-037 and its amendments |
| Scaling every duration constant by a pace | `releaseGraceMs` and `changeStableMs` are decay physics, not tempo; costs the derivation set | "The reference pace, derived on the five originals" |
| Estimating the rate from the audio envelope's periodicity | 0.622 AUC; octave errors both ways | DECISION-030 (d) |
| Upper percentiles of the recent gaps (p75, p90) | rank better on the bench, lose in the pipeline | "Three ways to read the rhythm instead" |
| The gap shape `gapAfter / gapBefore` | 0.779 with no clock; end to end dominated, +7 missed for -28 fp | same |
| Run length of equal gaps | 0.686; a real note is isolated by construction in slow passages | same |
| Restricting the rate gate to monophonic Notes via `polyphonic` | regression; the flag is wrong both ways | DECISION-030 amendment |
| Rhythm features into a logistic regression at the boundary | LOTO 0.603 against a bar of 0.828; 2 of 635 fp removable | DECISION-031 |
| A learned onset head on the BOUNDARY target (19,833 parameters, GuitarSet) | 0.7157 against a bar of 0.73 | DECISION-021, DECISION-032 |
| Fitted multi-witness model; per-rig calibration; DP joint segmentation over WINDOWS with a misfit cost; cycle dissimilarity; adaptive whitening as input; the millisecond click | each measured to its ceiling | DECISION-009, 010, 011, 015, 014, 018 |
| Joint DP segmentation's decay-residual cost ("is this span one decay") | at chance, 0.469, on a 5ms envelope | "Segmenting a region JOINTLY" |
| A finer envelope for the deep lane | separability flat from 5ms to 85ms | DECISION-028 (d) |
| Anchoring the dip on the preceding articulation | 0.797 offline, loses eleven held-out notes in the engine because the anchor is a detected attack, not a label | DECISION-028 (e) |
| `fineOnsetDipDb` off (recovers DI misses) | a DI-only trade, 23 events for 13 extras, amped renders bit-identical | DECISION-035 |
| "One onset, two readings"; absorbing an identically named stub; clearing votes on absorb; absorbing the predecessor of a pitch-step split | each costs labels or accuracy | "Hypotheses tested and rejected" |
| pYIN / Tony note HMM as published | leaves a stable state only through silence, so gapless same-pitch repeats merge | `docs/DI-ACCURACY-ROADMAP.md` §4.2 — an assessment, not a measurement; see §5 door 1 |

The pattern across the table: **the information is not at the boundary.** Every
reading taken at the instant of the transient tops out near 0.70. The one thing
that measured far above it — fragment span over the local interval, 0.905 with
an estimated rate and 0.926 with a true one — is a claim about the PHRASE, and
the first gate built on it was the first to cost nothing. Its binding
constraint is not the clock ("a perfect clock is worth about twice the reach"),
it is that the gate is as wide as its weaker half, the dip at 0.636.

## 5. The open doors, ranked — start at the top unless the journal says a door is spent

Every door below is something the record itself names as untested, or a gap it
locates in a file. For each, the sketch is a starting point, the nearest closed
relative is what you must distinguish yourself from in writing, and the
falsifier is the shape of the number you state before measuring. Your own
research (§6.1) may add doors; it may not reopen §4 without new evidence.

### Door 1 — a sequence decoder over EVENTS in the deep lane

**What the record says.** DECISION-028: "what a listener uses on this material
is not one number at one boundary — it is four evenly spaced events carrying
the same envelope shape, which is a claim about a SEQUENCE." "Why the deep lane
does not already do this" locates the gap: `deep/resegment.ts` sequences
WINDOWS, not events; neither of its witnesses compares a candidate boundary to
the OTHER boundaries in the phrase; the ring holds 4s and a region caps at
1.2s, so the context is buffered and unread. DECISION-036 rules that retracting
a Note is the contract, not a cost. "The two pace attempts" ends with the one
shape neither attempt used: `tracker/hypotheses.ts` as where a PRIOR lives —
weighting a segmentation hypothesis by how well its note lengths fit the
passage, instead of merging or not at one instant.

**Sketch.** For a region, the candidates are the boundaries the fast lane
ACCEPTED (a handful per phrase), not the 41 window positions per region
DECISION-011 searched. Score each keep/drop subset of those boundaries jointly
by the regularity of the inter-onset intervals it produces across the phrase
(deviation of each log-IOI from the phrase's own median, or the coefficient of
variation of the resulting IOIs), with the existing per-boundary witnesses
(`dipRatio`, `fluxRatio`, `sharpness`) as a weak prior and a penalty for
dropping a boundary that showed a dip. Decode by DP over the boundaries (k ≤ 8
in 1.2s; enumeration is fine). A dropped boundary is an absorption:
`structuralRevision`, `relation: "absorbed"`, the survivor's end extended —
check `docs/NOTE-MODEL.md` and `src/types.ts` for whether extending an END is
already expressible; DECISION-027 says the protocol exists and
`mergeWithinSegment()` already emits it. Abstain on a phrase with fewer than
three events — a real note is isolated by construction in slow passages
("run length", §4). Consider `maxRegionMs` and `regionSettleMs` — a slow
phrase at 500ms per note does not fit four events in 1.2s.

**Nearest closed relatives, and the difference you must establish.** (i)
DECISION-011 — DP over windows with a misfit cost whose decay-residual term was
at chance. This door does not ask "is this span one decay"; it asks whether the
partition's IOIs are regular, which is the quantity measured at 0.905/0.926
after DECISION-011 was closed. Say so, and do not put a decay-residual term in
the cost. (ii) DECISION-037 — one fragment against one scalar rate, bound by
the estimator's circularity. A joint decode needs no rate estimate: it scores
partitions by their own regularity, which is exactly the "rate not derived from
the onsets being corrected" the causal-estimator entry asked for. (iii) The gap
shape (0.779, dominated end to end): a joint decode over a phrase IS the gap
shape generalised to the whole phrase, so the falsifier must beat the gap
shape's exchange rate (-28 fp for +7 missed on derivation), not merely match it.
(iv) The corpus is metronomic — no rubato, no accelerando, nothing held past the
beat. A regularity prior's failure mode is merging notes a player played while
slowing down. Say what the prior does on an isolated long note and on a
ritardando, and test it on a synthetic one in `tests/engine/`.

**Falsifier.** On the derivation predicate, more extra Notes removed than
DECISION-030's shipped gate (-35 fp at +0 missed on the derivation set at the
time; re-read the current figure from the journal) at zero missed labels; then
held-out read once and not worse on either axis; then the slow subset per
path. Below that, the door closes with its numbers.

### Door 2 — a re-pick witness that survives compression

DECISION-027's own closing question: "a re-pick witness that survives
compression and distortion. That is an onset-feature question, not a
segmentation one." The candidates below are not in the record. Each is a bench
measurement first, on the OUTCOME-shaped population (`measure-rate-relative-
merge.ts`'s candidates: every Note opened by an accepted, settled, same-pitch
re-articulation, labelled surplus or not by the matcher), with a bar of 0.80
AUC before any engine work — the standard the DP entry set for a witness worth
a pipeline run. Report DI and amped separately; a witness that only separates
on DI is not the one the slow subset needs.

- **Harmonic/percussive separation** (Fitzgerald 2010, median filtering
  across time and frequency on the fine-hop STFT the fine-onset kernel already
  computes): a pick is a vertical line in the spectrogram; an amp's harmonic
  re-excitation of a sustaining string is horizontal. The percussive
  component's flux is the candidate. Nearest closed relatives: the 1–6kHz
  attack band (a crude frequency selection, not a structure test) and the
  click witness (DECISION-018, compactness at 2–8kHz).
- **A band-limited dip.** The dip witness is broadband RMS and compression acts
  on broadband level; the high partials of a plucked string decay faster than
  the fundamental, so a dip measured on 1–6kHz energy may survive the
  compressor that flattens the broadband one. Nearest closed relative:
  DECISION-028 (d), which varied window LENGTH, not band.
- **Octave displacement of the fragment.** Observed on 2026-09-18 while
  building the baseline, unmeasured against any target: on the amped renders
  the phantom is often named an octave or two above the label (`A3 + A5`,
  `F#2 + F#5`, `C3 + C5`), which reads as YIN locking onto the amp's harmonic
  content rather than a re-struck fundamental. Counted over
  `measure-splits.ts --detail`: 38 of 249 same-pitch-class split events carry
  an octave-displaced Note (7 of 49 on the amped quarters, 16 of 55 on the
  amped A3 eighths, 11 of 40 on held-then-picked amped), against 15 of 363
  MATCHED Notes octave-off on the same three amped takes per the eval report.
  Roughly 15% against 4%: a weak retrospective witness, not a gate. Worth one
  bench row, especially in combination with the rate; not worth shipping
  alone. Note `pitchDiffers` compares by pitch CLASS, so the split is accepted
  by `sharpness` and the fragment only names itself an octave up afterwards.
- **Spectral-shape novelty at fine hop** — centroid or flatness jump at the
  candidate, normalised by the phrase. Nearest closed relatives: cycle
  dissimilarity (DECISION-015) and whitening (DECISION-014), both of which
  measured spectral CHANGE; this measures spectral SHAPE, which is what a
  compressor does not touch.

**Falsifier for any of them:** 0.80 AUC on the outcome-shaped population on
the amped takes, on derivation only, or the row closes. A witness that passes
then goes into the pipeline as the dip did in DECISION-030 — as the second
witness of a rate-shaped gate, never as a gate on its own — and is judged by §2.

### Door 3 — a retrospective classifier judged on the OUTCOME target

DECISION-032 records that "a model trained and judged on surplus Notes … has
never been run": DECISION-021 and DECISION-031 were both scored on the
boundary-shaped question, and the two targets disagree on 26.8% of shared rows.
DECISION-016 admits a learned component of ≤ ~25,000 parameters, plain
TypeScript over `Float32Array`, fixed weights, in `src/engine/**`. The pipeline
under `training/` exists and is GuitarSet-only; `docs/learned-onset-head-
prompt.md` and `training/README.md` describe it.

**Sketch.** Inputs per candidate: the fine (5ms) envelope and the fine log-flux
over a window from the predecessor's onset to the fragment's end plus a margin,
resampled to a fixed length normalised by the local interval, plus the boundary
witnesses and `localIoiMs`. Target: the OUTCOME rule (was the Note this split
opened paired with a label). Train on GuitarSet rows produced by driving the
real engine (the existing `extract-rows.ts` population rule is the BOUNDARY
one — write the outcome one by running the matcher), grouped by player; score
leave-one-take-out on the corpus's own outcome-shaped rows; wire only if it
passes, as a witness beside the rate, never as a gate.

**Nearest closed relatives.** DECISION-021 (boundary target, causal patch, 9
hops × 60 bands), DECISION-031 (the retrospective feature group R was the
WEAKER one — on the boundary target; the fitted weight was -0.01). Say why the
target change is expected to matter beyond the 26.8% disagreement, and what the
result would mean if R is weak on the outcome target too.

**Falsifier.** LOTO AUC on the corpus's outcome-shaped rows above the shipped
rate feature's causal reading on the same rows (0.826 in "A tail fragment is
short FOR THE PACE"; re-measure it first), AND in the pipeline more extras
removed at zero missed on derivation than the shipped gate. If the corpus is
still the only place the phenomenon exists at scale, say that the reading is
against PROVISIONAL labels and weight it accordingly.

### Door 4 — the pace absorb at 0.40, "not yet decidable"

DECISION-037's amendment: at `absorbRatio` 0.40 the trade is 19 extras for 1
missed corpus-wide, 18 of the 19 on the eight takes whose labels are
provisional. The named next measurement is small — this estimator's own ratio
to the oracle rate at the candidates, per take; if it is 0.82, 0.50 is derived
rather than fitted. The module (`tracker/pace.ts`, `absorbAtPace()`,
`tests/engine/pace.test.ts`) was withdrawn in `a10d0e5` when DECISION-030's
announce-bar form superseded it; `git show a10d0e5^:src/engine/tracker/pace.ts`
recovers it. **Do not rebuild it.** Take the named measurement if it is cheap;
the door itself is blocked on the owner's label review of the eight takes, and
that goes in the journal's blockers.

### Door 5 — the per-Note `harmonyBloomed` restriction

DECISION-030's amendment: restricting the rate gate by the room-context
`polyphonic` flag regressed; "a per-Note test on the predecessor's
`harmonyBloomed` is the untested alternative". One condition, no constant.
Falsifier: extras on the chord takes fall, nothing else moves at all. Cheap,
and a clean negative is fine.

### Door 6 — the amplitude gate on slow decayed strings (misses, not splits)

Out of this loop's scope but on a GOATerizer player's screen: `held-then-
picked-six-strings-120bpm-di` misses 14 of 120 re-picks, seven of them
`rejected: gated` — the string decayed below `rmsGate` before the pick.
DECISION-035 names "lowering the amplitude gate so the seven gated refusals
reach the re-articulation witnesses at all" as the more honest place to look
and does not measure it. If an iteration touches the gate, the ledger's
`rejected: gated` row is the number, and the both-axes bar applies in full. Log
it as its own iteration; do not fold it into a split mechanism.

## 6. The iteration, step by step

### 6.1 Research

Two things, both written into the journal's candidate ledger before any code:

**(a) Literature.** `docs/DI-ACCURACY-ROADMAP.md` §4/§8 already surveyed onset
detection, pitch, multi-pitch and the commercial DI systems. Extend it, do not
repeat it. The questions worth an hour of reading, with the constraint that
whatever comes back must run as plain TypeScript inside `src/engine/**`, causal
in the fast lane, over ≤4s of history in the deep lane, with any learned part
under ~25k fixed parameters:

- Late (non-causal within a bounded window) note segmentation for plucked
  strings with same-pitch repeats: HMM/Viterbi note trackers with an explicit
  attack state that can be entered from a sounding state (the published pYIN
  and Tony trackers cannot; what has been done about that), Basic Pitch's and
  Onsets-and-Frames' onset-gated note decoding, madmom's note transcription
  post-processing, and any transcription work that uses a rhythm or
  note-length prior.
- Onset features reported robust to compression and distortion, specifically
  on electric guitar: harmonic/percussive separation as an onset function,
  phase- and complex-domain functions (Bello 2005, Duxbury), spectral-shape
  functions, and the electric-guitar transcription papers (EGDB, IDMT-SMT-
  Guitar, Riley 2024) for what they report about amp-processed audio.
- Envelope physics of an electric guitar through a compressor or amp: what a
  single pluck's partials do under compression, so a "one decay" model has a
  chance of being right on the amped path where DECISION-011's was at chance.

Add sources to a "Sources" block in your findings entry with the roadmap's
`†` convention for anything read from an abstract.

**(b) The candidate ledger.** For every candidate you consider, one row: the
mechanism; where it lives (fast lane / deep lane / instrument only); its nearest
closed relative in §4 and the sentence that distinguishes it; the falsifier as
a number; the cost to build; the signal path it is expected to help. Then pick
ONE. The ledger is what lets the next iteration skip what you rejected.

### 6.2 State the falsifier, then build behind a gate

Name the number that would mean the hypothesis is wrong, in the journal,
before measuring. Build the mechanism config-gated with the default at the
shipped behaviour, so a single override reproduces "off". Every constant is
SWEPT on the derivation predicate until a fixture moves, and the most
sensitive setting the material supports is taken — read three or four existing
comments in `src/engine/config.ts` for the idiom and reproduce it. Write the
comment before the sweep and fill in the numbers after; a constant with no
derivation story is a leak.

### 6.3 Bench first, when a bench exists — then the pipeline, always

A bench number (an AUC on extracted rows, a simulated merge on a detection
list) is a HYPOTHESIS. On this decision the record has now caught the bench
lying five times, twice inside the one entry that shipped. The verdict is
`npm run eval` plus `measure-splits.ts` plus the
ledger, on the real engine, in the real 128-sample quanta. If a bench falsifies
a candidate cheaply, take the negative and move on; if it passes, expect the
pipeline to disagree and measure anyway.

### 6.4 Measure — the report every iteration carries

Before and after, in the journal, in this shape:

```
slow subset (--subset=slow)     DI: split / extra      amped+mic: split / extra
corpus (measure-splits)         split / extra / strays
tail fragments                  same pitch / detached / other pitch
ledger MISSED                   total, and every fixture whose row moved, with the cause
by material                     derivation (5+8) / held-out (12): missed and extra
eval                            PASS/FAIL, required failures, informational failures
consumer view (if retracting)   fragments announced-then-absorbed, latency median/p90
tests                           count passing
```

And per signal path for any take that moved. A take that moved the wrong way
gets a note-by-note reading from `--detail` and the ledger's cause for each
label it lost — that is the diagnosis by instrument that DECISION-030 records
as the thing that finally worked after two guesses failed.

### 6.5 Decide

Keep only if all of §2 holds: slow subset better on at least one path and worse
on none; corpus extras not up; MISSED not up; eval PASS; derivation predicate
stated; held-out read once, after. Otherwise revert `src/` to bit-identical
(verify with the ledger and `measure-splits.ts`, not by eye) and keep the
instrument, the test and the write-up.

### 6.6 Tuning pass

Only on a mechanism that was kept in this iteration. One or two constants,
each swept on derivation with the cliff on both sides recorded; held-out read
once at the chosen value. A tuning pass that only helps held-out is not a
result. Stop the moment a sweep is flat — flat is the derivation set saying it
cannot see the constant, and DECISION-022 says what that means.

### 6.7 Verify, document, commit, push

```bash
npx tsc --noEmit && npm test                     # 511 tests at baseline
npm run eval                                     # PASS, 0 required failures
git diff --stat -- fixtures/                     # must be EMPTY
npx tsx scripts/check-readme-eval.ts             # --write if the report moved the page
npx tsx scripts/measure-downstream-ledger.ts --all
npx tsx scripts/measure-splits.ts
npx tsx scripts/measure-splits.ts --subset=slow
```

Then, every iteration, kept or reverted:

- **`docs/DETECTION-FINDINGS.md`** — a new section with the numbers, the
  falsifier as stated, what was built, what moved per fixture, and the verdict.
  Its title should let the next reader find it from §4's table.
- **`DECISION_LOG.md`** — an entry in the exact §6.3 schema from `AGENTS.md`,
  newest at top, next sequential id (DECISION-045 at the time of writing;
  verify). A closed direction is logged exactly like a shipped one.
- **`src/engine/config.ts`** — any constant's comment in the house idiom.
- **`docs/EVALUATION.md`** — `check-readme-eval.ts --write` if figures moved;
  never rewrap the anchored paragraphs.
- **`CHANGELOG.md`** — one line under an `## Unreleased` heading if shipped
  behaviour changed.
- **`docs/slow-note-splits-loop-log.md`** — the iteration entry (template in
  the journal), including the paragraph the owner asked for: **what a
  GOATerizer player would notice**, in plain words and per signal path — e.g.
  "through an amp, quarters at 120bpm split 50 of 72 before and 31 of 72 after;
  on DI unchanged at 9; nothing played was lost". If nothing shipped, say so in
  the same words.
- Commit with a message that states the verdict, and push to the session's
  branch. No AI or model identifiers anywhere.

## 7. Traps this project keeps walking into

- **A window wider than the spacing it discriminates.** 107ms. Five times.
- **A bench ranking is not a pipeline ranking.** Five times, two of them inside
  the one entry that shipped.
- **A trailing analysis window answers for the previous note.** Sampling from a
  note's start shows the estimator its predecessor.
- **Statistics that agree because they share a premise are one piece of
  evidence.** A take was confidently declared to have no sixteenth section on
  three converging measurements; one listen refuted it.
- **The two benches measure different targets.** Boundary-shaped
  (`measure-decision-separability.ts`) for segmentation questions;
  outcome-shaped (`measure-rate-relative-merge.ts`) for fragmentation
  questions. This brief is a fragmentation question. Never compare an AUC from
  one with an AUC from the other.
- **Over-segmentation flatters a one-to-one matcher.** Recall alone is never
  the number; `measure-splits.ts` beside the ledger, always.
- **Fitting on the eight takes.** They are derivation material by
  DECISION-028 and their labels are provisional. A constant chosen where all
  of its effect sits on provisional labels is a reading, not a derivation; say
  which.
- **Never edit `fixtures/labels/**` or `fixtures/eval.config.json`.** Never use
  the detector's output to decide what a label should be. Where a label looks
  wrong, `.cache/proposed-label-corrections.json` is where the evidence goes.

## 8. Constraints

- `src/engine/**` imports nothing outside itself and `src/types.ts`. No DOM, no
  globals, no clock reads, no npm imports, no top-level side effects.
  `tests/engine/isolation.test.ts` asserts it.
- The fast lane is causal. Only the deep lane may read buffered history, and
  never audio that has not arrived, even offline.
- No npm runtime dependencies. A learned component ships only as fixed weights
  of ≤ ~25,000 parameters executed by plain TypeScript inside `src/engine/**`;
  `training/` may use anything and is never imported by `src/**`.
- Never `git stash` — it is repo-wide across worktrees here and has destroyed
  work. Pathspec-limited `git add`.
- No AI or model identifiers in commit messages, PR bodies, code comments or
  docs.
- Relevant tests to extend rather than duplicate: `tests/engine/articulation.test.ts`,
  `tests/engine/note-tracker.test.ts`, `tests/engine/resegment.test.ts`,
  `tests/engine/region-reconcile.test.ts`, `tests/engine/compressed-signal.test.ts`
  (a synthetic compressed signal already exists there — the place for "one
  pick through a compressor is one Note").

## 9. Loop control and the exit rule

**Continue** while both hold:

1. The slow subset still has split events on any take at the current head.
2. The candidate ledger holds at least one entry whose nearest closed relative
   is different in MECHANISM (not in threshold) and whose falsifier is stated
   as a number the record does not already answer.

**Exit** when (2) fails; or after two consecutive iterations that built a
mechanism and reverted it without adding a new ledger entry; or when every
remaining entry is blocked on the owner (a label review, a recording, a
consumer-API decision) and nothing can be measured until it lands. Never loosen
§2 to keep looping, and never reopen a §4 row to have something to try.

**The exit report** is a section at the end of the journal, and the last
iteration writes it: the numbers at exit against the baseline (the §6.4 table,
both), the ceiling as it now stands on the slow subset per path, every
candidate spent with a one-line reason, what would reopen the loop (with the
specific material or decision named), and the plain-words paragraph for the
owner. It also gets a `DECISION_LOG.md` entry closing the loop.

## 10. Owner-side items — ask in the journal, do not do

- **Phone-microphone material.** Nothing in the corpus was captured on a
  phone. Request: the GOATerizer tutorial passage itself, played as the game
  asks (quarters and eighths, at the tutorial's tempo, several repetitions of
  the same pitch on the same string among them), captured (a) on the phone
  through GOATerizer's own capture path — ideally the raw worklet input written
  to a file, so the browser's constraints and the phone's processing are the
  ones the recognizer really sees — and (b) as a direct input of the same
  performance where possible, so the pair isolates the phone path the way the
  DI/amped pairs isolate the amp. Name the phone, the browser and whether
  `echoCancellation`, `noiseSuppression` and `autoGainControl` were off.
  Labels follow the recipe the existing label files document in their
  `timingNotes` (a harmonic-sum f0 track for identity and boundaries, onsets
  refined on a high-passed 1ms envelope, no detector output used);
  `scripts/verify-fixtures.ts` checks them; `scripts/retime-gridded-labels.ts`
  and `scripts/propose-amped-onsets.ts` are the tools that already exist. The
  owner assigns the take to derivation or held-out (DECISION-022: new slow
  same-pitch material is what derivation lacks), with both captures of one
  performance on the same side, and all three derivation predicates updated
  together.
- **The label review of the eight takes** (`docs/SAME-PITCH-MATERIAL.md`,
  "What is still open"): the 33 grid placeholders in the A3 sixteenth section,
  and whether to carry the re-timed DI times to the amped files at +2.5ms. It
  is the blocker on door 4 and on believing any number read off the amped fast
  takes to better than ±65ms.
- **A raw-capture switch in GOATerizer.** The game has no way to record what
  the recognizer hears — no `MediaRecorder`, no file capture; its labels
  editor reads this repository's `fixtures/` and does not record. A dev-only
  switch that writes the worklet's input to a WAV is what makes the phone-mic
  request above a fixture rather than a studio recording, and it belongs in
  that repository.
- **GOATerizer and `structuralRevision`** — answered, see §2: it honours
  `relation: "absorbed"` as a retraction. What remains the owner's is whether
  a judge that settles a Miss at an early release should wait for the
  library's absorption window on same-pitch material; that is a game-design
  question, not this loop's.
- **A tempo hint.** GOATerizer knows the tutorial's tempo and target grid;
  Tuninator's `localIoiMs` is the binding constraint on the shipped gate and
  the record bounds what a true clock is worth (about twice the reach, and no
  longer free: the oracle at 0.35 read -49 fp for +3 missed on derivation
  against the shipped -35 for +0). An `EngineTuning` field carrying an expected
  inter-onset interval is a product decision, not a detection one; raise it,
  with those numbers, and do not build it unasked.

## 11. Start here — the iteration checklist

1. `npm ci`, then `npm run eval` and the three measurement commands in §2.
   Confirm the journal's latest numbers reproduce bit for bit. If they do not,
   stop and find out why before anything else — a moved baseline is a finding.
2. Read §3 in order. Read the journal's candidate ledger and blockers.
3. Research (§6.1). Write the ledger rows. Pick one door.
4. State the falsifier in the journal. Build behind a gate. Sweep on
   derivation. Measure in the pipeline. Read held-out once.
5. Decide (§6.5). Tuning pass if kept (§6.6).
6. Verify, document, commit, push (§6.7). Journal entry with the owner's
   paragraph.
7. Apply the exit rule (§9). If it fires, write the exit report.

One standing instruction for the whole loop: this defect has been misdiagnosed
more than once in this repository's record and by the people handing over the
briefs. Where the evidence is thin, say it is thin. A clean negative reported
early, with its number, is worth more here than a plausible fix.
