# Decision Log

Architectural, technical, and critical project decisions for Tuninator, in the
schema defined by `AGENTS.md` §6. Newest entries at the top. A decision this
project rejected is logged exactly like one it accepted — the negative results
are what keep later work from repeating them.

---

#### [DECISION-032]: Revision is the contract, not a cost; latency to be correct is accepted
* **Date:** 2026-09-15
* **Status:** Accepted
* **Owner:** Project owner
* **Context:** The phrase-level segmentation work (DECISION-028's opening, and
  the rate line re-measured in `docs/DETECTION-FINDINGS.md`) cannot decide a
  boundary at the instant it happens. A rhythm or envelope-shape claim needs
  the strokes that follow, so a Note is delivered and then amended. That was
  raised here as a consumer-facing cost: a Note appears and is withdrawn, which
  on a live display is a flicker.
* **Decision:** The owner rules that this is not a cost to be minimised but the
  point of having a deep lane at all: better to end up correct than to stay
  wrong, and a human listener also revises what they just heard. Retroactive
  amendment is therefore in bounds for any phrase-level mechanism, and
  "it would retract a Note" is not on its own an argument against one. The
  existing machinery is already the right shape for it: `revision.ts` and the
  `structuralRevision` change of DECISION-008 exist precisely so a segmentation
  can be corrected after delivery, and `NoteChange` lets a consumer tell "I
  know more now" from "I was wrong".
* **Alternatives Considered:** Holding a Note back until the deep lane has
  ruled — rejected: it makes the fast lane pointless, and the fast lane is what
  makes a Note appear while the note is still sounding, which is the library's
  reason for existing. Emitting phantom Notes and never correcting them —
  rejected: that is the current behaviour on the split axis and is what the
  owner is asking to fix. Marking a Note provisional and letting the consumer
  decide when to draw it — not rejected, but it is a consumer concern and
  `NoteChange` already carries what such a consumer would need.
* **Consequences:** Positive — the design space for the split defect widens
  from "witnesses available at the boundary", which eight ceiling studies have
  now exhausted, to anything the deep lane can establish within its
  `deep.ringSeconds` of 4. It also puts the burden where the evidence is: a
  same-pitch boundary is not separable at the instant it happens, and this says
  the engine may stop trying to. Negative — a consumer that renders every Note
  immediately and never reads `NoteChange` will show more churn, so
  `docs/NOTE-MODEL.md` and `docs/API.md` carry more weight for integrators than
  they did; and a retraction is only correct if the mechanism driving it is,
  so this accepts flicker in exchange for accuracy and NOT in exchange for
  noise. The both-axes bar is unchanged: a mechanism that amends its way to
  fewer extras by losing real notes still fails.

---

#### [DECISION-031]: The fine onset's dip requirement stays; measured off, it is a direct-input trade that leaves the amped renders untouched
* **Date:** 2026-09-15
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** With the eight 120bpm same-pitch takes and the DI repair in one
  tree (DECISION-030), `held-then-picked-six-strings-120bpm-di` reads 14 missed
  of 120. The tracker's trace names the refusals: seven `rejected: gated` at
  the amplitude gate on a string decayed below it, three `ring-out-not-sharp`,
  three `band-only transient`, one with no transient in the window at all —
  twelve of the fourteen C3 or C4 re-picks, the other two an F#2 and a G4. The
  fine-hop witness of DECISION-029 sees the gated ones with a 19-26dB rebound
  and `fineOnsetDipDb` vetoes them, because a fine onset may not re-articulate
  a sounding note unless the 5ms envelope dipped first - the pick landing on
  the string before it plays it.
* **Decision:** Leave `transient.fineOnsetDipDb` at -6dB. Measured off
  (`= 0`, by config override against the merged tree, no source change) with
  the falsifier stated first: the override had to hold the derivation set at
  84 Notes / 2 missed / 8 extra AND not lose ground on the twelve held-out
  takes. It cleared both — derivation bit-identical, held-out 24 missed /
  72 extra to 23 / 72, and the take it was aimed at 14 missed / 5 extra to
  1 / 9, its last miss a G4 with no transient in the window. Refused on three
  counts anyway. (1) Both axes: corpus-wide 137 missed / 345 extra to
  114 / 358, twenty-three events bought with thirteen extra Notes;
  `measure-splits.ts` agrees, 340 split / 410 extra to 351 / 421. A net loss
  on either axis is a finding and not a commit. (2) Every one of the
  twenty-three is on held-out (1) or on the eight unassigned takes (22), whose
  labels are PROVISIONAL and, on two of the four takes, recorded in
  `docs/SAME-PITCH-MATERIAL.md` as not matching what the player described;
  material that gates nothing because it is unconfirmed cannot calibrate a
  shipped constant either. (3) All four amped renders are bit-identical with
  the requirement off - 1/71, 9/44, 13/32 and 2/83 missed/extra, 60/77, 57/62,
  33/41 and 51/82 split/extra - and the amped renders are where the open
  problem is, every split on the eight takes being same-pitch and contiguous.
* **Alternatives Considered:** Shipping it on the strength of the derivation
  set not moving — refused: derivation invariance is the floor this project
  measures against, not the bar; the reading still has to pay on both axes.
  Lowering the amplitude gate instead, so the seven `gated` refusals reach the
  re-articulation witnesses at all — not measured here, and out of scope for a
  merge; it is the more honest place to look, because the dip test is the
  witness the gate never lets those strokes reach. Widening the dip window
  rather than removing the requirement — the same fit to the same unreviewed
  labels, with one more constant read off them. Taking the reading as evidence
  about the amped renders — refuted by the renders themselves: nothing moves.
* **Consequences:** The direct input keeps fourteen known misses on one take,
  with the mechanism that would recover thirteen of them identified, built, and
  deliberately not enabled. What unblocks it is stated rather than guessed: the
  DI derivation material DECISION-029 already names as its precondition, and a
  reviewed label pass over the eight takes (`docs/validate-relabelled-material-prompt.md`).
  Negative cost: anyone reading the take's ledger will find the misses and the
  witness that sees them, and has to read this entry to learn why the two are
  not connected in the shipped engine. The full measurement is in
  `docs/DETECTION-FINDINGS.md`, "The DI repair, scored on the eight 120bpm
  takes it was never measured against".

---

#### [DECISION-030]: Merge the direct-input repair with the 120bpm same-pitch material; the merge has one engine parent, not two
* **Date:** 2026-09-15
* **Status:** Accepted
* **Owner:** Detection architecture
* **Context:** Two branches carried independent work. `claude/same-pitch-material`
  landed the eight 120bpm same-pitch takes (1,131 labelled events), their
  PROVISIONAL labels, `docs/SAME-PITCH-MATERIAL.md` and DECISION-026..028;
  `claude/guitar-note-detection-cjeu2h` landed the DI repair - the fine-hop
  onset witness, the pre-pick prefix and contact-led stub absorption, the
  virtual-pitch bloom - and a decision entry numbered 026, colliding with the
  other branch's. Each branch's readings were taken without the other's
  fixtures, so neither had scored its engine on the other's material.
* **Decision:** Merge into `claude/merge-di-and-same-pitch`, keeping both
  contributions whole. The conflict was in `DECISION_LOG.md` alone and was
  structural: the same-pitch material keeps `DECISION-026`, the number its
  own material is referenced by throughout the docs, and the DI roadmap entry
  is renumbered to the next free number, `DECISION-029`, with its three
  cross-references moved with it (`docs/DETECTION-FINDINGS.md`,
  `src/engine/config.ts`, `src/engine/tracker/note-tracker.ts`). The eight
  takes stay out of `fixtures/eval.config.json`: they remain informational and
  gate nothing until their labels are confirmed. One doc figure was refreshed
  from the live report per AGENTS.md §5 (`check-readme-eval.ts`: eight takes
  under a 25ms median onset error, now nine).
* **Alternatives Considered:** Renumbering the same-pitch entry instead —
  rejected: it is referenced by name from `AGENTS.md`, `DETECTION-FINDINGS.md`
  and two briefs, and the DI entry by three sites, so moving the DI entry is
  the smaller and more mechanical change. Adding the eight takes to
  `eval.config.json` while they were in hand — rejected, twice over: it is
  what DECISION-026 deliberately did not do, and the readings below would then
  gate on unreviewed generated labels. Rebasing the DI branch onto the
  same-pitch branch rather than merging — no advantage here and it rewrites two
  commits of measured work; the merge commit is the honest record that two
  independent readings met.
* **Consequences:** Measured four ways over one fixture set, with `main` and
  both source branches in detached worktrees holding `fixtures/` checked out
  from the merge, so every tree saw byte-identical audio and labels. Two
  results are structural. `claude/same-pitch-material` is **byte-identical to
  `main`** on `measure-downstream-ledger.ts --all` and `measure-splits.ts`,
  every fixture, both axes: both engine gates it tried were reverted on that
  branch, so its net `src/` diff is empty. The merge is **byte-identical to
  the DI branch** on the same instruments. The merge therefore has one engine
  parent, and no interaction between the two lines of work exists. Readings -
  derivation 84 Notes / 2 missed / 8 extra, unmoved across all four trees on
  those axes, and one derivation cell moves on naming (`power-chords-c-a-g-e`
  7 of 8 exact to 8 of 8, the virtual-pitch bloom), so "the derivation set did
  not move" holds for segmentation and not for label accuracy; held-out
  30 missed / 84 extra to 24 / 72; the eight takes 126 missed / 255 extra to
  111 / 265. Corpus-wide over all 1,590 labelled events: 158 missed to 137,
  347 false positives to 345, pitch class 88.7% to 89.9%, exact 83.8% to
  84.9%, and by `measure-splits.ts` 342 split events to 340 with strays flat
  at 20 to 21 - the accuracy gain is events recovered, not fragmentation
  traded for it. `npm run eval` PASSES (the one informational failure,
  `power-chords-b-a-g-fsharp` exact accuracy at 72.7% against an 80%
  informational bar, is pre-existing on `main` and unchanged). Five of the
  eight takes read below the per-fixture best of the two parent engines, all
  five on the extras axis; that best is not a thing any single engine can be,
  and the cause is the fine witness alone, confirmed by an override and by the
  trace. Negative: the DI repair's cost is now visible on 1,131 events it was
  never fitted to, and it is not the one-sided win it is on the mic and amp
  takes - fifteen events found for ten extra Notes. Written up in
  `docs/DETECTION-FINDINGS.md`, "The DI repair, scored on the eight 120bpm
  takes it was never measured against".

---

#### [DECISION-029]: Adopt the direct-input roadmap: fine-hop flux proposals, transitions belong to the pick, octave-consistent cancellation; DI derivation material is the precondition
* **Date:** 2026-09-15
* **Status:** Accepted, amended 2026-09-15 — Stages 1 and 2 shipped with
  every constant a held-out reading (no DI derivation material exists yet;
  the derivation set was held to bit-identical numbers instead); Stage 3's
  virtual-pitch exception shipped and its octave-consistent cancellation
  was built twice and refuted; the strum-spread half of Stage 2 was
  refuted. See the amendment below the Consequences.
* **Owner:** Detection architecture
* **Context:** Asked for a realistic path to perfect accuracy on the direct
  input. The four DI takes (127 held-out events) stand at 6 missed, 25 extra
  Notes and 4 wrong names under the shipping engine. Four ceiling
  measurements (`scripts/measure-di-*.ts`, written up in
  `docs/DI-ACCURACY-ROADMAP.md` and `docs/DETECTION-FINDINGS.md`) establish
  that the information is in the signal: a log-compressed, max-filtered flux
  at a 2.67ms hop, with a 65ms "preparation" veto, covers 126 of 127 onsets
  with six off-label firings — three pick contacts 52–65ms before a stroke,
  one strum-internal transient, one candidate 43ms before the interpolated
  `s14`, and the take's final hand mute; the engine's own pitch estimator names 96–100%
  of notes correctly by 15ms after a correct boundary; 21 of the 25 extra
  Notes are the fretting hand arriving before the pick or the strum's
  spread; both wrong chord names are one octave error in harmonic
  cancellation. The seventh defect, `s14`, is the labeller's own exception.
* **Decision:** Pursue the roadmap's stages, each with its falsifier stated
  before measurement: (1) a fine-hop SuperFlux-shaped onset front end as a
  PROPOSAL stage with a 65ms "preparation" veto in the region lane; (2) three
  structural rules in the tracker — a step-opened Note ended by the pick
  within 250ms at the pitch the pick plays is absorbed into it, a transition
  stub likewise, and a strum's first-string fragment is no longer protected
  by `restruck && announced`; (3) octave consistency in the cancellation
  loop of `kernels/chroma.ts` and blooming on a virtual pitch. Precondition
  for deriving rather than fitting any of their constants: about three
  minutes of new DI derivation material (quiet alternate-picked sixteenths,
  same-pitch re-picks, held-then-re-picked legato, open-chord changes),
  labelled by the recipe the DI label files already document. Two semantic
  decisions are the owner's: a pre-pick fretting transition is not a Note;
  a picked-and-damped stroke is.
* **Alternatives Considered:** A single fixed onset threshold across the DI
  takes — refuted: the per-take best points span 0.145 to 3.0, and at 0.25
  the strummed takes fire 65 times off-label. A mute veto keyed on the
  envelope falling after a candidate — refuted: it removes `s6` and `s40`,
  real strokes damped inside 40ms. The labeller's high-passed envelope and
  an LPC residual as detectors — 114/127 and 125/127 covered at 179 and 189
  off-label. Learned onset heads (Schlüter–Böck ≈290k parameters, Basic
  Pitch ≈17k but non-causal by ±100ms) — out of bounds or already run to a
  falsifier (`DECISION-021`). pYIN's note HMM — leaves a stable state only
  through silence, the opposite of what re-picked sixteenths need.
  Per-rig calibration of the existing witnesses — closed by `DECISION-010`.
* **Consequences:** The DI's remaining defects are reframed as upstream of
  the same-pitch decision the record calls a 0.73 ceiling: on a direct input
  the kernel was too coarse to see the pick, not the decision too weak to
  judge it. The path is expected to read 8/8, 16/16, 55/55 and 47/48 with
  zero extras; it says nothing about the mic and amp paths beyond one new
  candidate witness (the damping dip before a re-pick) that is untested on
  the decision table. Cost: the owner at a guitar for the derivation
  material, and one semantic rule (the pre-pick prefix) that a consumer
  wanting every legato pitch change as a Note would want off. Nothing in
  `src/` moved; the eval report is bit-identical.
* **Amendment (same day):** Built without the derivation material, under
  the rule that the five derivation takes must not move at all — they did
  not (84 Notes, 2 missed, 8 extra, before and after). What shipped:
  (1) `kernels/fine-onset.ts` and its corroboration by the damping dip the
  roadmap had refuted as a detector — the witness alone is not neutral on
  the derivation set at any threshold (`clean-lead` 1 → 2–4 extras from
  θ=4 down to 1); gated on a 6dB dip and a 6dB rebound, with a 55ms dedupe
  against the broadband kernel's own attacks, it is. (2) The pre-pick
  prefix and contact-led transition-stub rules, run from both ends because
  six of the eight DI prefixes are Notes the region lane carves out after
  the pick's Note was announced; a *contact* is a fine onset with a dip of
  at least 10dB and no rebound — the 6dB-rebound test alone absorbed five
  of the mic sixteenths' quiet upstrokes; the stroke look-back is 80ms,
  bounded by `clean-lead` `s8` (48ms), the mic sixteenths' `s8` (62ms) and
  the DI triplet's closest prefix (93ms). (3) Blooming on a virtual pitch
  (`power-chords-120` 8/8). What was refuted and reverted: the strum-spread
  exemption (absorbed the `spicy-chords` Cmaj9 into an E5); a stub rule
  keyed on pitch alone (took the correct half of the mic triplet's `t20`);
  a region `rose` flag as the prefix discriminator (hammer-ons rise); the
  chroma sub-octave rule in both forms. Reading: the four DI takes go from
  6 missed / 25 extra / 117 named to 2 missed / 13 extra / 121 named of
  127; the twelve held-out takes from 30 missed / 84 extra to 24 / 72;
  everything else bit-identical. The DI derivation material remains the
  precondition for deriving rather than reading any of these constants,
  and every one of them is documented as a held-out reading at its
  declaration.

---

#### [DECISION-028]: The per-boundary threshold family is exhausted; sequence modelling is the next step
* **Date:** 2026-09-14
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** DECISION-027 closed forward absorption and left the open question
  as a re-pick witness that survives compression. The owner pressed the obvious
  objection: his waveforms show plainly separate notes, on the amp-sim renders
  and at sixteenth spacing, so what is the recognizer failing to see? He also
  settled the blocking question from DECISION-027 by assigning the 120bpm
  same-pitch material as calibration material, which is what made any of the
  sweeps below derivable at all — the old derivation set holds three instances
  of the phenomenon and is flat across every constant tried.
* **Decision:** **Reject every per-boundary gate on the current witnesses, and
  name sequence modelling as the precondition for progress.** Two findings, each
  measured. **(1)** The witnesses available at the decision top out at 0.698 AUC
  over 1,103 real re-picks against 229 invented boundaries, and the best of them
  is the `sharpness` the branch already used — so any gate built from them
  reshuffles a 0.70 discriminator. **(2)** A new witness, the envelope dip before
  a boundary, scores 0.763 corpus-wide and 0.743-0.801 on the same-pitch
  material, above this project's 0.73 bar and better than anything the engine
  computes. It is nonetheless insufficient: at roughly five real re-picks per
  phantom, a 0.78 witness with overlapping distributions removes about one real
  note per phantom, and all seven configurations tried landed on that same
  exchange rate. `src/` is unchanged.
* **Alternatives Considered:** (a) **`regionMerge` and a trigger-restricted
  variant** — 383 and 175 missed labels against a baseline of 161. (b) **A second
  flux witness on the monophonic fallback** — the file's own header says
  `sharpness` is not path-independent and that neither reading suffices alone,
  and applying the chord branch's bar to single notes cost 94 misses; the two
  flux readings are 0.698 and 0.695 and strongly correlated, so the pair adds
  nothing. (c) **An energy floor on the sharpness escape** — AUC 0.483, and a
  floor killing 19 phantoms kills 173 real notes. (d) **A finer envelope for the
  deep lane**, on the theory that it is blind because it reads RMS through the
  85.3ms window the FFT needs for pitch — proposed here and then refuted by
  measurement: separability is flat from 5ms to 85ms at fixed overlap
  (0.768/0.771/0.797/0.801/0.773). (e) **Anchoring the dip on the preceding
  articulation instead of a window**, which is the better idea and measures
  better offline at 0.797 — rejected because it lost eleven held-out notes in the
  pipeline, the offline anchor being a label and the engine's being a detected
  attack on a signal that fires several transients per pick. (f) **Shipping the
  windowed dip at 0.99**, which leaves derivation and held-out misses unchanged
  at 2 and 30 while taking held-out splits 73 -> 65 — rejected because five of its
  twelve added misses are on a DIRECT take and the ledger attributes them to the
  new gate by name, sixteenths at 125ms against a 240ms reach being the
  window-versus-spacing error committed inside the repair. Age-gating it removes
  benefit and harm together (336 -> 335 splits).
* **Consequences:** Positive — the defect's discriminability is now measured
  rather than assumed, from two independent directions, and the best witness
  available is known and quantified. The envelope dip is a genuine asset for
  whatever comes next: it is above the bar, it is robust to window length over a
  seventeenfold range, and it is the only reading that describes the span BEFORE
  a transient rather than the instant of it. Negative — no accuracy change: the
  corpus stands at 336 events split, 403 extra Notes, 161 missed labels, exactly
  where the day began, and a consumer scoring one target per pick still pays for
  it. **What this rules out** is the whole family of single-number thresholds at
  a single boundary, which is where seven attempts and the eight earlier ceiling
  studies have all gone. **What it points at** is a claim about a sequence —
  evenly spaced events sharing an envelope shape — which is what a listener
  actually uses on this material. Joint segmentation by dynamic programming
  (DECISION-017) and a local-rate gate were both measured and rejected, and
  neither is a sequence decoder over the envelope; that distinction is the
  opening, and the seven rows in the findings entry are what the next attempt
  should not re-derive. **Still outstanding and the owner's:** the
  derivation/held-out assignment is now settled as calibration material, but the
  provisional labels on that material have not been reviewed, and five of the
  twelve misses in alternative (f) turn on whether those labels are right.

---

#### [DECISION-027]: Forward absorption is refused; the split-shape instruments are repaired
* **Date:** 2026-09-14
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** One played event is emitted as a correctly-named Note followed by
  a same-pitch fragment. `docs/DETECTION-FINDINGS.md` concluded this is "a
  same-pitch boundary inside one event, not a name arriving late", and that
  absorption reaches backward only — `absorbArticulationFragment()` and
  `absorbAttackFragments()` both move a survivor's START back, while the one
  mechanism that could extend a survivor's END over a following Note,
  `mergeWithinSegment()`, is gated behind `deep.regionMerge`, false on a measured
  negative taken over 78 derivation events. DECISION-026 landed 1,136 events of
  material that is nothing but this phenomenon, making the question answerable at
  a scale the corpus could not previously reach.
* **Decision:** **Reject forward absorption on the current feature set, and fix
  the instruments that were hiding the defect's size.** Two measurements, each
  with its falsifier named in advance (missed labels must not rise above 161;
  splits and extras must both fall). Enabling `deep.regionMerge` takes splits
  336 → 234 and extras 403 → 264, and missed labels **161 → 383** — 139 fewer
  phantom Notes for 222 lost played ones, with `opened but never emitted` going
  0 → 184 in the ledger. Restricting it to absorb only Notes whose `trigger` is
  not `"attack"` — a discriminator already recorded, introducing no constant —
  cuts the loss to 14, and then trades **14 extras for 14 misses, one for one**,
  in the same fixtures and the same places, while adding an informational
  pitch-class gate failure on `lead-line-amped-sixteenths`. Both reverted; `src/`
  is unchanged. Separately, `measure-split-shape.ts` is repaired and
  `measure-tail-fragments.ts` added, because the existing instrument could not
  report the shape it was built to find: its two name tests were ordered
  previous-name first, and on same-pitch material both tests pass, so
  `same pitch twice` was unreachable — 18 reported corpus-wide where the correct
  ordering gives **113**. Its `predecessor's own` bucket additionally uses a 45ms
  window against amped labels carrying up to 65ms of placement offset, which is
  documented rather than retuned since the labels are read-only.
* **Alternatives Considered:** (a) **Suppress the fragment at announcement**
  rather than retract it — rejected without measurement: it decides on strictly
  less evidence than the retrospective test that has just been refuted, and it is
  the prospective fast-lane decision that eight converging experiments already
  put a 0.73 AUC ceiling on. (b) **Announce then retract via `structuralRevision`
  with `relation: "absorbed"`** — the protocol exists and `mergeWithinSegment()`
  already emits exactly this, so the API question is moot until a rule can decide
  correctly; nothing was learned that requires `docs/API.md` or
  `docs/NOTE-MODEL.md` to change. (c) **Delay the survivor's `noteEnded` past an
  absorption window** — rejected for the same reason and at a real latency cost
  in a real-time library. (d) **Tune a new constant** — refused: the derivation
  set holds about seven same-pitch re-articulations, all in one take, and the only
  material that exercises this phenomenon is DECISION-026's, which is deliberately
  unassigned. Fitting anything on it would pre-empt that assignment and leak.
  (e) **Retune `OWN_ONSET_MS` so `predecessor's own` stops absorbing late labels**
  — rejected as fitting a diagnostic to the answer; documented instead.
* **Consequences:** Positive — the defect's size is now measurable. It is six
  times larger than reported (113 rather than 18 `same pitch twice`), and on an
  instrument that reads no label onset at all, **294 of 318 extra Notes are
  same-pitch and contiguous and none are detached**, rising to 175 of 175 on the
  same-pitch fixtures. The backward-only claim is confirmed by reading and the
  absence is the proximate cause. Most valuably, the retrospective question is
  now answered rather than assumed: a fragment's full duration, its decay and its
  own attack witness are **not** enough to tell which of two same-pitch Notes the
  player did not play, so the retrospective framing does not sit on the better
  side of the ceiling. Negative — the tail fragment still ships, and a consumer
  scoring one target per pick still pays for it. Also negative: the median
  shortest Note in a split event is 93ms, above both `tracking.minStableMs` (55)
  and `deep.minSegmentMs` (90), so no threshold already in the engine can be
  raised past these fragments. **What this leaves as the open question** is
  DECISION-026's own headline — split rates go 8% → 71%, 3% → 30% and 7% → 50%
  between the DI and amped renders of one performance — which locates the missing
  evidence in the onset features, not in segmentation bookkeeping: a witness that
  survives compression and distortion. **Three decisions this pass deliberately did
  not take, all the owner's:** assigning the DECISION-026 material to derivation
  or held-out, reviewing its provisional labels, and resolving the listening kit —
  whose human-pass figures the brief cites but which exist nowhere in this tree,
  since the kit writes to the never-committed `.cache/relabel/`. That last one is
  not merely missing: the committed MACHINE pass points the opposite way on the
  decisive row, hearing an onset at 55 of 106 extra-Note boundaries where the
  labels have none, against the brief's n=6 human reading of zero. The
  disagreement is unresolved, and its direction runs against forward absorption —
  articulations the labels do not carry would make some of the 294 same-pitch
  extras real notes that absorbing destroys without any miss count showing it.
  Everything above is reported on the corpus as it stands, no constant was fitted
  to any of it, and no conclusion here depends on either annotation pass.

---

#### [DECISION-026]: Land the 120bpm same-pitch material with generated labels, unconfigured and unassigned
* **Date:** 2026-09-14
* **Status:** Proposed
* **Owner:** Detection architecture
* **Context:** DECISION-022 established that the derivation set holds about seven
  same-pitch re-articulations, all inside `chords-a-bm-g-d-2x-120bpm`, and named
  new derivation material as the precondition for further work on that decision —
  "minutes of deliberate same-pitch re-picking (varied velocity, muted and open,
  sixteenth spacing and slower) through the corpus's three signal paths, labelled
  by ear", closing with "the fix needs the project owner at a guitar, not an agent
  at a keyboard". The owner recorded four takes at 120bpm, each as DI and through
  an amp sim: quarter notes on A3 then E5; eighths on A3; eighths then sixteenths
  on E5; and, per pitch across all six strings, four cycles of one held measure
  followed by one measure of quarter notes. The separate, downstream motivation is
  a consumer scoring one target per pick, where a spurious same-pitch tail fragment
  costs a miss and a wrong note and cascades through the phrase.
* **Decision:** Land all eight files with generated labels — 1,024 events — while
  making three things explicitly unfinished. **(1)** The labels are PROVISIONAL and
  say so in every `timingNotes`. Structure comes from the player's description and
  onsets from a plain RMS envelope written for the job; Tuninator placed nothing,
  so the labels are not derived from the detector they will grade. `quarters` and
  `held-then-picked` carry measured onsets one-to-one (the envelope rule found
  exactly 72 and 120, matching the structure); the two fast takes sit on a
  subdivision grid anchored on the first measured onset with one fitted median
  offset, because that rule cannot resolve every pick in a fast run. **(2)** No
  `fixtures/eval.config.json` entries, so the eval reports them and gates nothing —
  correct for labels nobody has reviewed. **(3)** No derivation/held-out assignment;
  that is DECISION-022's substance and wants a deliberate choice, with both renders
  of one take on the same side because they are one performance.
* **Alternatives Considered:** (a) Audio with no labels at all — `decode-fixtures.ts`
  discovers fixtures from label files, so unlabelled audio is invisible and the
  material would contribute nothing. Rejected as landing the cost without the
  benefit. (b) Hand-annotating by ear — correct, and not something this agent can
  do; the generated set is scaffolding for that pass, not a substitute, and
  `verify-fixtures.ts` plus the relabel kit exist to check it. (c) Writing labels
  from Tuninator's own output — rejected outright as the circularity `AGENTS.md` §3
  names. (d) Assigning derivation/held-out here — rejected: splitting the corpus's
  new supply of the phenomenon is the decision DECISION-022 was about, not a side
  effect of landing files.
* **Consequences:** Positive — the phenomenon that eight converging ceiling studies
  could not read now exists in quantity, across two signal paths, with
  `held-then-picked` putting one-pick-one-Note and four-picks-four-Notes on
  identical material at six pitches from F#2 to D5. Negative, and the reason the
  status is Proposed — **the labels are generated, not annotated by ear.** Both
  structural questions have since been answered by the player. `quarters` does run
  10 measures of E5 rather than 8, confirmed twice independently (pitch changes at
  17.980s after exactly 32 onsets, 40 after, 0.500s spacing throughout).
  `eighths A3` **does** contain a sixteenth section, from 20.0s, and it is now
  labelled as 72 eighths plus 112 sixteenths. The earlier claim here that it had
  no sixteenth section was a false negative from three measurements that shared a
  premise: the envelope onset rule drops about half the picks in a fast same-pitch
  run, and the modulation and autocorrelation readings were compared against the
  E5 take rather than against this take over time — the two are voiced differently,
  with the strongest periodicity at the note period in one and at twice it in the
  other. Measured against itself the A3 take does step from a 0.5s peak lag to
  0.25s at the boundary. The lesson is recorded in `docs/SAME-PITCH-MATERIAL.md`:
  three statistics agreeing is not three pieces of evidence when they share a
  premise, and subdivision in this material needs a human listen. Also recorded: the
  derivation/held-out predicate is implemented three different ways across
  `measure-decision-separability.ts`, `measure-same-pitch-population.ts` and
  `measure-dp-segmentation.ts`, and these stems fall on opposite sides of the first
  two and the third — whichever assignment is chosen, all three need updating
  together or a future reading silently mixes the sides.

---

#### [DECISION-025]: Split the README into a short front door plus `docs/`; the intro is human-owned
* **Date:** 2026-09-10
* **Status:** Accepted
* **Owner:** Documentation
* **Context:** The README had grown to ~530 lines and was carrying four
  documents at once: an install guide, a full API reference, the design
  rationale for the Note model and the engine, and the evaluation results. The
  repository owner rewrote the opening section by hand and asked for two things:
  that the human-written part stop being rewritten by agents, and that
  everything from `## Install` down be made much shorter, because someone
  deciding whether to use the library will not read a 530-line page.
* **Decision:** `README.md` now ends at the events table: what it is, install,
  one usage example, the event list, a Docs list, licence, example app. The
  moved material lives in `docs/API.md` (methods, options, error codes,
  `PitchFrame`, timestamps, worker host, multi-channel, worklet asset in full),
  `docs/NOTE-MODEL.md` (Note semantics plus architecture, two lanes, pitch
  reading) and `docs/EVALUATION.md` (the per-fixture table and analysis).
  `AGENTS.md` gained an explicit ownership rule: above `## Install` is
  human-written and not to be rewritten; below it is agent-maintained and is to
  be kept both accurate and short. `scripts/check-readme-eval.ts` now checks
  `docs/EVALUATION.md`, and the CI step was renamed to match; the script keeps
  its name for continuity with the history that named it. Its Windows path bug
  (`new URL(...).pathname` → `\C:\...`) was fixed in passing so the check is
  runnable locally on the owner's machine, not only on CI.
* **Alternatives Considered:** Deleting the moved prose outright — rejected: it
  is the only consumer-facing statement of why a bend is one Note and why
  summing a stereo rig combs the signal, and `AGENTS.md` covers neither at that
  altitude. Deleting the evaluation section and its checker — considered
  seriously, since eval results are arguably an implementation detail for a
  consumer; rejected because the drift guard was added deliberately after the
  table fell ten rows behind (DECISION-024 era), and moving the page keeps the
  guard for a page nobody has to read. Keeping the table in the README to avoid
  touching the checker — rejected: that is the tail wagging the dog, and the
  checker is fifteen lines of string constants.
* **Consequences:** The README is ~110 lines and reads as a front door. The
  cost is a link hop for anyone wanting the options table, and a new failure
  mode: `package.json`'s `files` ships only `dist`, `README.md` and `LICENSE`,
  so the `docs/` links resolve on GitHub and through npm's repository rewriting
  but are not inside the published tarball. Second cost worth naming: the four
  prose figures in `docs/EVALUATION.md` are matched by regexes that span line
  breaks, so rewrapping those paragraphs breaks CI — `AGENTS.md` §5 now says so
  explicitly, since the material is in a less-travelled file than before.

#### [DECISION-024]: Remove the held 0.1 demo copy and the completed migration brief; keep every deliberately-unwired module
* **Date:** 2026-09-07
* **Status:** Accepted
* **Owner:** Project structure
* **Context:** A prune of deprecated paths across the whole project, not just
  `src/`. `examples/browser-demo/` targeted the 0.1 API and did not compile —
  its own `MIGRATION-REQUIRED.md` said every symbol it touched had changed. It
  had been committed here only because the session that wrote it could not
  create its repository (`403 Resource not accessible by integration`) and its
  container was ephemeral; `examples/README.md` called the directory a holding
  location and ended with "Then delete `examples/` from this repository."
* **Decision:** Removed `examples/` and `docs/example-migration-prompt.md`.
  Both are superseded rather than merely stale: `trellos/Tuninator-Example`
  exists, was cloned and inspected, and is **already migrated** — it imports
  `createRecognizer` and subscribes to `noteStarted`, and its head commit
  (`507d102`, 2026-08-19) is "Delete the unreachable paths the 0.2 migration
  left behind". The brief specified work that is finished. The demo's real home
  is live, public, and ahead of the copy.
* **Alternatives Considered:** Migrating the in-repo copy to 0.2 — rejected:
  it would duplicate a published demo that is already migrated, and
  `examples/README.md` warned that fixing this copy alone leaves the published
  one broken while looking fixed; that risk now runs the other way. Keeping the
  copy as a reference — rejected: it is a 0.1 reference, and pointing a
  consumer at it (as this session did once) is worse than having no example in
  the tree. Deleting `docs/MIGRATION.md` alongside it — rejected: `README.md`
  links it as the 0.1→0.2 upgrade guide for consumers, so it is live
  documentation. Deleting `docs/BASELINE.md` — rejected:
  `docs/DETECTION-FINDINGS.md` measures its deltas against that frozen
  baseline.
* **Consequences:** The repository no longer carries code that does not
  compile against its own public API, and `examples/` is gone from a library
  whose example lives elsewhere; consumers are pointed at
  `trellos/Tuninator-Example`. Nothing else was removed, and that is the
  substantive half of this decision: a reachability sweep of `src/` found only
  three modules unreachable from the entry points, and **all three are live** —
  `kernels/click.ts` and `kernels/whitened-bands.ts` are unwired *by*
  DECISION-018 and DECISION-021 and are used by their measurement scripts and
  the training pipeline, and `offline/wav.ts` is imported by thirty scripts and
  a test. Unwired is not dead here, and a prune that went by reachability alone
  would have deleted the experimental record this project deliberately keeps.
  Of 32 files in `scripts/`, one (`summary.mjs`) is referenced by no document;
  it is a working A/B eval formatter and was kept. Noted, not acted on: this
  repository has **no CI** — no `.github/` at all — and `package.json` still
  reads `version: 0.1.0` while the library, its docs and this log all describe
  the 0.2 recognizer.

#### [DECISION-023]: Consolidate the branches on the shipping recognizer; retire the `src/core/` lineage
* **Date:** 2026-09-07
* **Status:** Accepted
* **Owner:** Detection architecture
* **Context:** Seven published branches had accumulated with no statement of
  which one detected best. Two were already fully contained in `main`
  (`guitar-event-recognizer-refactor-t5g5yr`, merged at `f6c22a5`;
  `exciting-edison-kyo0qw`, identical to it). Three carried measurement,
  documentation and unwired kernels only. One,
  `tuninator-code-review-q5yzz2`, carried a genuinely competing detector: the
  pre-rewrite `src/core/` tree developed past the fork point with a
  four-estimator fused pitch front end. Its own reported figure (80.8%) and
  the shipping engine's were not comparable, because that branch never
  carried the held-out corpus — its `fixtures/` held the five derivation
  takes alone.
* **Decision:** The shipping streaming recognizer on `main` is the most
  accurate note detection in the repository, and the branches consolidate
  onto it. Measured on identical ground truth (the twelve held-out takes and
  the seventeen-entry `eval.config.json` copied into a worktree of `053526b`;
  the five shared label files are byte-identical, so nothing was reconciled):
  on the 381 held-out events the shipping engine matches 351 to the retired
  lineage's 288 and scores 84.7% exact to its 69.7%, passing every `required`
  fixture where the retired lineage fails ten fixtures including two
  `required`. The retired lineage is **not** merged. Its architecture is
  closed; its measurements, its handoff and its pre-rewrite contributor guide
  are preserved under `docs/archive/`.
* **Alternatives Considered:** Merging `q5yzz2`'s detector, or porting its
  four-estimator fusion into the engine — rejected on the held-out numbers
  above, and structurally: its single-active-event `EventTracker` cannot
  represent overlapping Notes, which is the representation the current
  tracker exists to provide. Judging the branches on their own reported
  figures — rejected as exactly the circular comparison §3 of `AGENTS.md`
  forbids; on the derivation takes alone the retired detector wins four of
  five, which is the answer that would have been reached. Deleting the
  retired lineage as superseded — rejected: its central measurement is the
  one the current architecture was built to answer. Renumbering nothing and
  living with duplicate decision IDs — rejected; three branches had
  independently issued DECISION-016.
* **Consequences:** `main` gains the click (compactness) witness kernel, the
  whitened-bands kernel, the `training/` pipeline, the relabel listening kit
  and scorer, the same-pitch population measurement, and the nearest-label
  fix to the downstream ledger's own attribution window. Both merged kernels
  are measured and **unwired**, and the eval report after the merges is
  bit-identical to the pre-merge report — the consolidation moved no
  detection numbers, by construction. Decision IDs were reconciled: the
  shared dependency-constraint amendment keeps 016, the label-ceiling and
  click work takes 017-020, the learned onset head takes 021-022. The
  retired lineage's better held-out extras figure (38 against 84) is left on
  the record as the one axis where it was ahead. Accepted debt: `main` now
  carries two unwired kernels and a training tree that no shipped code
  imports, and `docs/archive/` contains guidance-shaped documents that are
  explicitly not guidance.

#### [DECISION-022]: The derivation set cannot support the same-pitch decision; new derivation material is the precondition for further work on it
* **Date:** 2026-08-21
* **Status:** Accepted
* **Owner:** Detection architecture
* **Context:** Investigating why the learned head's per-take scores ran
  opposite to expectation, a count of consecutive labelled events carrying
  the same pitch or chord name found **seven in the entire derivation set,
  all seven inside `chords-a-bm-g-d-2x-120bpm`**, against 138 in the
  held-out set (108 of those in the three sixteenths takes). Carried into
  the decision table every ceiling study fits on: **8 of 59 derivation
  positives are same-pitch re-articulations; 51 are a new pitch arriving
  over a ringing Note.** `clean-lead-120bpm`, 44% of that table, is a rising
  scale with zero same-pitch repeats — a claim to the contrary in
  `docs/DETECTION-FINDINGS.md` has been corrected in place.
* **Decision:** Treat every derivation-set reading of "the same-pitch
  re-articulation decision" as a reading of a mostly-different population,
  and treat new derivation material containing the case as the precondition
  for further work on it: minutes of deliberate same-pitch re-picking
  (varied velocity, muted and open, sixteenth spacing and slower) through
  the corpus's three signal paths, labelled by ear, added to the derivation
  side. `scripts/measure-same-pitch-population.ts` reproduces the count and
  should be run before trusting any future derivation reading of this
  decision.
* **Alternatives Considered:** Re-labelling existing takes more precisely —
  rejected as the wrong instrument: 20% of decision rows sit within 20ms of
  the 70ms attribution edge so timing precision is real but second-order,
  and no labelling pass creates instances of a phenomenon the audio does not
  contain. Promoting a held-out sixteenths take into derivation — rejected:
  it would spend the corpus's only dense supply of the phenomenon on tuning
  and leave nothing to be graded against. Continuing to infer same-pitch
  performance from held-out scores — rejected as the practice that produced
  eight experiments tuned on eight examples.
* **Consequences:** Reframes the record rather than invalidating it: the
  measured numbers stand, their titles do not. The 0.808 → 0.434
  leave-one-take-out collapse of DECISION-009 now has a simpler available
  explanation — the fold holding out `chords-a-bm-g-d-2x-120bpm` removes the
  phenomenon from the training half entirely — which weakens it as evidence
  for take-dependent witness scale and strengthens it as evidence that there
  was nothing there to fit. The 0.73 ceiling should be renamed to what it
  measures until new material exists. Cost: the fix needs the project owner
  at a guitar, not an agent at a keyboard.

#### [DECISION-021]: Reject wiring the learned onset head; the external-data bet failed its ranking falsifier
* **Date:** 2026-08-20
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** Under the DECISION-016 amendment, a 19,833-parameter
  convolutional scorer was trained on 248,993 decision rows extracted by
  running this engine over GuitarSet (six players, mic + pickup flavours,
  three augmentation chains; EGDB unreachable under the environment's egress
  policy), labelled by the exact target rule of the baseline separability
  study, split grouped by player, early-stopped on external validation only.
  Falsifier stated in advance: the frozen model must clear 0.73 AUC (best
  existing single witness) on the derivation decision table, or stop.
* **Decision:** The falsifier fired. Frozen reads on the derivation table:
  0.7157 (full inputs; external val 0.8820), 0.6260 (patch + whitened flux),
  0.6291 (patch only), against sharpness at 0.7281 on the same rows. All
  derivation reads taken are reported in `docs/DETECTION-FINDINGS.md`;
  variant selection read external validation only. Nothing is wired; the
  runtime fusion machinery built for the win condition was removed again
  (recoverable at bfce0ad); the engine is bit-identical to baseline and the
  twelve 140bpm held-out takes were never read, so the once-only held-out
  read remains unspent.
* **Alternatives Considered:** Selecting the training epoch or variant by
  derivation AUC (epoch 12 of the full run brushed 0.7288) — rejected as
  tuning on the falsifier's own rows. Proceeding to the ledger anyway on the
  grounds that falsifier 3 "is the only bar that matters" — rejected: the
  ranking bar exists precisely to keep the held-out read from being spent on
  a candidate no better than the incumbent witness. Iterating further
  variants against the derivation table — rejected as the garden of forking
  paths; the two ablations run were pre-planned and their prediction was
  refuted (the witnesses carry transferable signal; removing them hurt both
  domains).
* **Consequences:** The pipeline (`training/`), the whitened band kernel,
  and the hop-grid alignment finding stay committed and reproducible; the
  external number (0.88 across six players and six signal paths) establishes
  the decision is learnable while the derivation number says
  GuitarSet-plus-augmentation is not yet this corpus. A post-hoc grouping of
  the derivation rows by deciding branch (recorded in
  `docs/DETECTION-FINDINGS.md`) adds a design finding independent of this
  model: only six of the 59 derivation positives sat in the pool the fusion
  scope allowed the witness to overturn, so the ledger's missed-label upside
  was capped at six labels before any question of model quality. Any next
  attempt should set the scope from where the positives live and state that
  reachable ceiling before training. The same grouping shows two per-take
  cells previously tabulated (power chords, spicy chords) rest on 48 pairs
  and zero positives respectively and carry no signal. Named routes forward:
  closer-domain training data (EGDB DI, or self-recorded labelled electric
  takes), and the second independent labelling pass — the model ranks chord
  re-articulations at 0.90–1.00 while `clean-lead-120bpm` reads 0.605,
  consistent with the annotation-noise hypothesis living exactly where the
  ceiling does.

#### [DECISION-020]: Ledger cause attribution requires the nearest label, not any label within 70ms
* **Date:** 2026-08-20
* **Status:** Accepted
* **Owner:** Evaluation methodology
* **Context:** `measure-downstream-ledger.ts` attributed any trace event
  within ±70ms to the missed label being classified. Six missed labels sit
  55-77ms after their neighbour (rushed pairs, closer than the window), so
  the neighbour's own correct boundary was read as this label's "split made;
  successor paired with a neighbouring label" — the fifth instance of the
  window-wider-than-the-spacing error class, and the first inside the
  diagnostic that directs the project's effort.
* **Decision:** `classify` attributes an event to a label only when that
  label is the event's nearest. MISSED stays 32 (attribution only); the
  cause table redraws: "no transient within the window" 4 → 10, "band-only"
  1 → 4, "split-pairing" 8 → 2. The brief's "23 of 32 are bookkeeping"
  premise was partly this artifact — ~14 of 32 are upstream evidence losses,
  most of them the second stroke of a rushed pair inside the onset kernel's
  60ms dead time.
* **Alternatives Considered:** Leaving the diagnostic as it was and noting
  the caveat in prose — rejected; this ledger names where effort goes next,
  and it had already sent this session to the wrong cause once.
* **Consequences:** Future tracker work aims at the real bookkeeping
  residue (~10 labels), not at 23. The rushed pairs are a kernel dead-time
  question and carry the same risk profile as every documented
  more-willing-to-fire change.

#### [DECISION-019]: Revert announce credit for stubs the same attack opened (per-change bar)
* **Date:** 2026-08-20
* **Status:** Rejected
* **Owner:** Tracker semantics
* **Context:** `absorbedRenaming` discounts an absorbed step-split stub's
  span from the announcement clock, arguing the stub is the previous note's
  tail. Traced at room-mic sixteenths s45: the stub was opened by this
  stroke's OWN attack (same `burstAt` as the survivor), the "step" was the
  estimator reading the new pitch 40ms late, and the survivor died
  unannounced at 53ms counted against a real 93ms span.
* **Decision:** Crediting the stub's span when it was attack-opened at the
  survivor's own burst recovers 3 real labels (32 → 29 missed, each
  confirmed by the DECISION-017 annotation pass) but exposes one
  pre-existing premature boundary as a new extra Note (107 → 108). The
  pre-stated Task-3 bar — strictly improve one axis, no worse on the other —
  fails on the extras axis. Reverted; mechanism and diff recorded in
  `docs/DETECTION-FINDINGS.md`.
* **Alternatives Considered:** Also re-dating boundaries opened on a
  transient several times weaker than an attack arriving inside the settle
  window (would clear the exposed extra) — not attempted: it needs a
  strength-ratio constant the five derivation takes may not exercise, and
  the adjacent too-young ground has three documented failures.
* **Consequences:** The announce accounting is now known-wrong for
  own-attack stubs, with three labels waiting on it. It becomes shippable
  the moment the premature-weak-boundary shape is repaired; that pairing is
  the highest-value small change left in the tracker.

#### [DECISION-018]: Reject the millisecond click (compactness) witness for the same-pitch decision
* **Date:** 2026-08-20
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** The one physical cue no experiment had touched: a pick's
  1-5ms broadband click, measured at its own timescale (2-8kHz causal
  biquad cascade, 1ms envelope — `kernels/click.ts`) instead of smeared
  into a 23ms window on a 12ms hop. Falsifier stated in advance: best
  single compactness witness clears 0.73 AUC on the derivation decision
  rows and holds on the room-mic path, or the line closes.
* **Decision:** Measured without touching the engine
  (`scripts/measure-click-separability.ts`, identical decision-row
  population, ±12ms sub-hop alignment, adjacent-label onsets masked from
  every surround ring). The falsifier fired: best witness 0.586, and both
  compactness readings point the wrong way — re-picks read LONGER above
  half peak than churn. A positive control in the same script (label onsets
  vs mid-sustain, same code paths) reads 0.838, so the pipeline sees the
  click; the decision population kills it — the negatives are hops an
  energy witness already fired on, and their churn carries 2-8kHz spikes
  too. Ninth converging negative on this decision.
* **Alternatives Considered:** Rescue variants beyond the pre-named witness
  set (higher bands, alternative rings) — excluded by the falsifier's own
  terms. Sub-hop boundary LOCALISATION by the fine envelope — not refuted,
  untested, explicitly left open.
* **Consequences:** The last untouched physical cue at this decision is
  closed as a discriminator. Together with DECISION-017's finding that the
  missed labels are real, the remaining routes are tracker bookkeeping and
  the annotation ambiguity of the extras axis, not new witnesses.

#### [DECISION-017]: The label ceiling is measured — the misses are real; the extras axis carries annotation ambiguity
* **Date:** 2026-08-20
* **Status:** Accepted
* **Owner:** Evaluation methodology
* **Context:** Eight converging negatives put ~0.73 AUC on the same-pitch
  decision, and the literature (Dixon DAFx-06; the 2022 soft-onset
  string-ensemble study) says part of such a ceiling can be label noise.
  Every later experiment is graded against these labels, so the fraction
  had to be bounded first. Decision rule stated in advance: ≥95% control
  agreement validates an annotator; <10% contested disagreement means label
  noise is not binding; >30% concentrated on muted strums/room mic means
  the ceiling is substantially annotation.
* **Decision:** Built the blind listening kit (302 anonymised snippets: 248
  contested moments, 54 controls; `build-relabel-kit.ts`) and ran the
  machine pass (`machine-annotate-relabel.ts`, flux at 5ms + 2-8kHz fine
  envelope, reading only the anonymised audio; control bar passed at
  96.3%). Verdict by kind: the 32 missed labels are REAL (91% agreement at
  50ms, 97% at 70ms — the under-10% branch fires; threshold work against
  them is founded, and the consensus subset for witness studies equals the
  full derivation set, 161/161). The extra-Note axis is NOT clean: at 55 of
  106 extra-Note boundaries the independent pass hears a corroborated onset
  the labels lack, spread across signal paths. Calibration itself measured
  the wall: no corroboration gate (envelope rise, click, prominence) keeps
  95% of CLEAR strokes — clear-stroke p5s are rise 0.80, click 1.45,
  prominence 2.35 — the engine's own recall/precision wall, reproduced from
  the annotator's side with different features at a different timescale.
* **Alternatives Considered:** Editing labels the pass disputes — forbidden
  and not done; disagreements are proposals only. Trusting the machine pass
  to settle the extras axis — rejected: a signal-driven annotator cannot
  distinguish "note" from "articulation-like event"; the human pass (kit
  ready, `.cache/relabel/`, ~20-30 minutes) arbitrates.
* **Consequences:** Miss-side headroom under the 0.73 ceiling is real, not
  annotation noise. Extras-side gains must be read with the ambiguity in
  mind: an extra Note where an independent annotator hears an articulation
  is not unambiguously a detector error, and 55 of 107 extras sit at such
  moments. The human pass is the open follow-up.
#### [DECISION-016]: Amend the no-runtime-dependency constraint to admit fixed-weight learned components
* **Date:** 2026-08-20
* **Status:** Accepted
* **Owner:** Project owner (amendment approved by project owner)
* **Context:** The same-pitch re-articulation decision has a measured ceiling
  under everything hand-built: best single witness 0.728 AUC, a fitted
  twelve-witness logistic collapsing 0.808 in-sample → 0.434
  leave-one-take-out, and eight closed directions (DECISION-009 through
  DECISION-015). The collapse says 78 derivation events cannot support
  fitting anything; the field's standing answer at this exact wall is a small
  learned function trained on large external labelled corpora (Basic Pitch,
  ~17K parameters, ICASSP 2022). AGENTS.md §4 read "No npm runtime
  dependencies, no neural-network runtime", which as written also barred
  shipping fixed weights executed by plain TypeScript.
* **Decision:** §4 now reads: a learned component is shippable only as fixed
  weights (≤ ~25,000 parameters) executed by plain TypeScript over
  `Float32Array` inside `src/engine/**` — no runtime dependency, no dynamic
  loading, no training at runtime. The training pipeline lives outside the
  shipped library (`training/`), may use any tooling, and is never imported
  by `src/**`. Approved by project owner.
* **Alternatives Considered:** Keeping the constraint as written — rejected
  because it conflates two different risks: a runtime dependency (still
  banned; the zero-dependency invariant and engine isolation are untouched)
  and learned constants (already shippable in spirit — every tuned threshold
  is a fitted constant; the amendment only raises the admissible parameter
  count and names its bound). An unbounded amendment — rejected: the ~25K cap
  keeps the component in the class proven CPU-real-time-trivial and keeps the
  library auditable as checked-in `Float32Array` literals.
* **Consequences:** The learned-onset-head experiment can proceed with the
  engine-isolation test still enforcing that `src/engine/**` imports nothing
  outside itself. The twelve 140bpm held-out takes gain a stricter rule:
  never trained or validated on, in addition to never fitted. Risk accepted:
  checked-in weights are less inspectable than named thresholds; mitigated by
  requiring the training pipeline, dataset manifest, and run provenance to be
  committed alongside.

#### [DECISION-015]: Reject cycle dissimilarity (and YIN aperiodicity) as re-articulation witnesses
* **Date:** 2026-08-20
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** The one candidate feature that is not an energy detector: a
  decaying string satisfies x[n] ≈ α·x[n−T], a pluck resets relative phases,
  so NCC at lag T should drop at a re-pick regardless of its loudness
  (US 9,646,591; Zhou & Reiss). Falsifier stated in advance: clear 0.73 AUC
  (the best existing witness) on the monophonic derivation subset, or stop.
* **Decision:** Measured (`scripts/measure-cycle-dissimilarity.ts`), ten
  variants including the gain/shape split and the muted-repick signature
  D·(1−g): best variant 0.579 AUC on the falsifier subset against sharpness's
  0.721 on the same rows; 0.628 under the feature's own designed-for gating
  (monophonic, non-gliding, periodic before the attack) against 0.703. YIN's
  own aperiodicity: 0.521. The falsifier fired; the line is closed without
  engine changes.
* **Alternatives Considered:** The spectral (harmonic-comb phase-prediction)
  form — not built, because the time-domain form failing at the population
  level (both decision classes are transient-bearing hops; a still-ringing
  string keeps most of its phase through a re-pick) applies to it equally.
* **Consequences:** Third non-energy feature family refuted at this decision.
  Raises the standing of the annotation-noise hypothesis for the 0.73
  ceiling; the logged next step is a second independent labelling pass to
  measure human–human AUC, not another feature.

#### [DECISION-014]: Adaptive whitening confirmed as scale fix, rejected as decision input
* **Date:** 2026-08-20
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** The 0.808 in-sample → 0.434 leave-one-take-out collapse of the
  twelve-witness model is the signature of take-dependent feature scale
  (attack contrast varies 106x within one take). Stowell & Plumbley adaptive
  whitening (per-bin running-peak divide) should produce flux whose scale
  survives a change of take. Falsifier: LOTO materially above 0.434, and the
  gain must also show in the ledger and splits.
* **Decision:** Measured without touching the engine
  (`scripts/measure-whitening-separability.ts`, identical decision-table
  population, m and floor derived on the five 120bpm takes). Whitened-only
  witnesses: LOTO 0.608, and the collapse nearly vanishes (0.723 in-sample →
  0.608) — the diagnosis is confirmed. But at the derivation zero-label-cost
  operating point they admit 237 of 254 held-out false candidates, and wired
  as a veto on acted decisions they clear 2 false splits for 1 true one
  across all twelve held-out takes. Statistical half of the falsifier passed,
  ledger half failed; not wired into the engine.
* **Alternatives Considered:** Adding whitened witnesses to the twelve in one
  fitted model — measured worse (LOTO 0.414): the unstable features poison a
  joint fit, consistent with Holzapfel's decision-level-fusion result.
* **Consequences:** Future candidate witnesses should be evaluated in
  whitened form first — scale stability is now known to be cheap, and
  un-whitened LOTO numbers understate every candidate. The script stays as
  the harness for that.

#### [DECISION-013]: Frequency-axis max filter shipped config-gated, off by default
* **Date:** 2026-08-20
* **Status:** Accepted
* **Owner:** Detection architecture
* **Context:** The onset kernel's three-hop time-axis maximum suppresses
  unresolved-harmonic beating but makes the reference the loudest recent
  frame, raising the bar for quiet re-attacks — the failing case. SuperFlux
  (Böck & Widmer) runs the max across frequency of the previous frame
  instead. Falsifier: if steady-low-E flux still swings like a pick attack
  with the frequency max and no time memory, revert.
* **Decision:** Built into `kernels/onset.ts` as `maxFilterSemitones`
  (per-bin ±semitone neighbourhood, minimum ±1 bin — chosen over a triangular
  log filterbank, which would re-scale every downstream constant and the
  arrival-band structure in one change). Falsifier passed decisively: worst
  steady hop an order of magnitude below the time max's, with time memory
  fully redundant (identical at 1, 2 and 3 frames). End to end it trades
  −29 extra Notes for +11 missed labels at its best (43/71/78 against the
  32/99/107 baseline) — an operating-point move, not a both-axes win, so the
  default stays off (`transient.fluxMaxFilterSemitones: 0`), with unit tests
  holding both the ripple suppression and re-pick coverage under the filter.
* **Alternatives Considered:** Lowering the kernel arrival floor to recover
  recall (worse on both axes: 51 missed / 83 extras); rescaling the two
  sharpness-reading bars by the measured 0.849 witness shrink (recovers 2 of
  13 lost labels only — the loss is structural, in split-pairing and
  too-young churn).
* **Consequences:** The capability and its falsifier tests ship without
  changing default behaviour. Noted for revisiting: on the held-out takes
  (read, never fitted) the filter Pareto-beats the incumbent at the kernel
  level (361/381 covered at 0.67% off-label against 358/381 at 0.85%) — the
  derivation-set advantage of the incumbent partly reflects constants tuned
  to that set.

#### [DECISION-012]: Pursue three literature onset features with pre-stated falsifiers
* **Date:** 2026-08-20
* **Status:** Accepted
* **Owner:** Detection architecture
* **Context:** DECISION-009..011 established that the twelve existing
  witnesses are energy-increase detectors in disguise and no logic over them
  (fitted model, rig calibration, joint DP) beats 32 missed / 107 extras.
  `docs/onset-features-prompt.md` selected three mechanisms from the
  literature with different physical bases: the SuperFlux frequency-axis max,
  Stowell–Plumbley adaptive whitening, and period-to-period dissimilarity.
* **Decision:** Run all three in order, each with its falsifier stated before
  measuring, derivation-set discipline throughout, negatives reported as
  findings. Outcomes: DECISION-013 (accepted, gated), DECISION-014
  (rejected), DECISION-015 (rejected).
* **Alternatives Considered:** Spectral sparsity (NINOS²) and
  harmonic/percussive separation — deferred by the brief itself as
  vulnerable to the room-hiss trap without whitening first.
* **Consequences:** Full numbers in `docs/DETECTION-FINDINGS.md` ("Three
  candidate features from the onset literature"). The same-pitch ceiling now
  has eight converging negatives; the annotation-noise fraction of it is the
  next thing to measure.

#### [DECISION-011]: Reject DP-based joint region segmentation
* **Date:** 2026-08-20
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** Local, one-candidate-at-a-time accept/reject decisions for
  re-articulation cap at ~0.73 AUC (see DECISION-010). Hypothesis: choosing a
  region's whole segmentation jointly, by dynamic programming over candidate
  boundaries (cost = per-segment misfit + price per cut), might succeed where
  per-candidate thresholds fail, because it can weigh a boundary against the
  segmentation it is part of rather than judging it alone.
* **Decision:** Measured the ceiling before building it into the engine
  (`scripts/measure-dp-segmentation.ts`, fit-on-test). Rejected: no price
  setting is inside the current baseline (32 missed / 107 extras) on both
  axes; the best point holding extras under baseline misses 234 of 454
  reachable labels. The per-segment cost terms themselves scored 0.469 AUC
  (decay residual — chance), 0.689 (pitch stability), 0.713 (chroma
  stability) — the same ceiling as the local witnesses. A joint decision does
  not create information the underlying features lack.
* **Alternatives Considered:** Feeding the DP three streams at their natural
  time/frequency resolutions (fine RMS envelope, fast-lane per-hop pitch,
  85ms deep-lane chroma) rather than one window — implemented, did not change
  the conclusion.
* **Consequences:** Confirms the problem is in the feature set, not in the
  decision procedure over it (local threshold vs. joint optimum). Directly
  motivated DECISION-012: stop improving logic over the twelve existing
  witnesses and look for features with a different physical basis. Full
  numbers: `docs/DETECTION-FINDINGS.md`.

#### [DECISION-010]: Reject per-rig calibration of re-articulation thresholds
* **Date:** 2026-08-20
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** Attack contrast varies 2.0x–24.2x across the corpus and up to
  106x within a single take. A `NoiseFloorTracker` already derives the
  amplitude gate from a rig's own measured noise floor successfully. Question:
  can the same pattern — measure the rig, scale the decision thresholds by
  what was measured — fix the re-articulation (same-pitch repick) decision?
* **Decision:** Built `RigProfileEstimator`, proved a real rig signature
  exists (flux floors run 1.6x within one recording chain vs 3.0x between
  chains), then measured the fit-on-test *ceiling*: scaling re-articulation
  bars by the profile trades 7 correctly detected events and 7 correct names
  for 17 fewer duplicate Notes (32→39 missed, 107→90 extras) — worse on the
  axis that matters. The honest cross-take-within-chain version is slightly
  worse still. Decisive evidence: the *same* amp-sim profile removes 9
  duplicate Notes at zero cost on one take and costs 5 played events on
  another take from the same guitar, same session. What varies is the
  passage being played, not the recording chain.
* **Alternatives Considered:** Fitting a twelve-witness logistic model
  directly (DECISION-009, same root failure); pooling all takes into one
  profile (worse on both axes, 49 missed / 98 extras — confirms the
  chain-specific signal is real, just not useful for this decision).
* **Consequences:** Per-rig calibration is closed as a direction for this
  decision. The `RigProfileEstimator`/`RigCalibration` code stays in the tree
  (`UNCALIBRATED` is the identity, off by default, pinned by a test) because
  the underlying rig signature may be useful elsewhere (e.g. informing the
  missing-fundamental estimator which signal path it is on), just not for
  this decision.

#### [DECISION-009]: Reject a fitted multi-witness model for re-articulation
* **Date:** 2026-08-20
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** Twelve hand-computed witnesses exist for the re-articulation
  decision (spectral flux in four normalisations, envelope ratios, decay-fit
  residual, duration, pitch-change flags). No single threshold on any one
  witness works across the corpus's 2.0x–106x attack-contrast range. Question:
  does a fitted combination of all twelve do better than hand-tuned logic
  over the same set?
* **Decision:** Rejected. Best single witness reaches 0.73 AUC. An L2
  logistic regression over all twelve reaches 0.808 AUC in-sample, 0.758 with
  folds that mix takes, and **0.434 leave-one-take-out — worse than chance**.
  Scored on twelve held-out takes after fitting on five derivation takes:
  0.647, below the single best witness (0.667). Correlation analysis shows
  the twelve witnesses collapse to roughly four independent signals
  (`sharpness`/`heldSharpness` r=0.954, `fluxRatio`/`heldFluxRatio` r=0.867).
* **Alternatives Considered:** Two-feature exhaustive sweep (still overfits
  per-take scale); regularisation sweep λ ∈ {0.01, 0.1, 1, 10} (does not
  close the in-sample/leave-one-out gap).
* **Consequences:** The in-sample→leave-one-take-out collapse is the
  signature of features whose *scale* is take-dependent, not of a decision
  procedure that needs improving. This is the finding that redirected effort
  from "combine what we have better" to "find scale-invariant features" —
  see `docs/onset-features-prompt.md` for the resulting research direction
  (period-to-period waveform dissimilarity, adaptive whitening).

#### [DECISION-008]: Adopt structural revision as the mechanism for retroactive segmentation correction
* **Date:** 2026-08-19
* **Status:** Accepted
* **Owner:** Recognizer architecture (P2/P7 of the rewrite)
* **Context:** Some evidence that a segmentation decision was wrong only
  arrives after the decision was delivered to a listener (e.g. a rejected
  transient later corroborated by a mute; a same-pitch split later shown to
  be one continuous decay). The public API promises delivered events are
  never silently rewritten.
* **Decision:** A correction is delivered as a `NoteChange` with
  `type: "structuralRevision"` on the surviving Note (carrying
  `relatedNoteIds`), followed by a `noteStarted` for any new Note with a
  backdated `startTime`. History is revised in *meaning*, never rewritten —
  already-delivered events always stand.
* **Alternatives Considered:** Silently retracting and re-emitting events
  (breaks the "events are facts, once delivered" guarantee downstream
  consumers rely on); withholding emission until the deep lane confirms
  (unacceptable added latency for the fast lane's whole reason for existing).
* **Consequences:** Gives later-arriving evidence (deep lane re-segmentation,
  mute witness, decay-fit corroboration) a principled place to land without
  breaking the public contract. Cost: consumers must handle
  `structuralRevision` explicitly rather than treating the Note stream as
  append-only.

#### [DECISION-007]: Adopt a two-lane (fast/deep) architecture over one source-sample timeline
* **Date:** 2026-08-18
* **Status:** Accepted
* **Owner:** Recognizer architecture (P0 of the rewrite)
* **Context:** Rewriting from a single-active-event pitch detector
  (`src/core/event-tracker.ts`, `MusicEvent`, four caller-selected modes) to a
  streaming musical event recognizer per the architecture spec. Needed a way
  to answer both "what's happening right now" (bounded latency) and "what
  actually happened here" (needs more audio and more time than causal
  operation allows).
* **Decision:** Fast lane: causal, sub-50ms, pitch/onset/re-articulation only.
  Deep lane: allowed to be late, revisits a timestamped ring buffer by sample
  range, does spectral/harmonic/multi-pitch/re-segmentation work, emits
  corrections as `NoteChange`s (see DECISION-008). Both driven off one
  `SourceTimeMs` clock derived only from sample count ÷ sample rate.
* **Alternatives Considered:** Single-pass causal-only detector (cannot
  recover from bad early segmentation, which is the majority of remaining
  defects per `docs/DETECTION-FINDINGS.md`); fully offline/batch analysis
  (fails the real-time browser requirement entirely).
* **Consequences:** Enables retroactive correction (DECISION-008) and made
  `deep/resegment.ts` possible. Cost: two lanes to keep synchronised, a
  ring-buffer memory budget (`deep.ringSeconds`), and — per DECISION-011 —
  even this architecture has not yet closed the remaining segmentation gap;
  the lane exists but does not yet own boundary placement jointly.

#### [DECISION-006]: Modes are removed; one recognizer runs at all times
* **Date:** 2026-08-18
* **Status:** Accepted
* **Owner:** Public API design (P4 of the rewrite)
* **Context:** The 0.1 API had four caller-selected modes (`lead`, `chords`,
  `rhythm`, `raw`) that ran genuinely different code paths — chord
  segmentation was driven by chord-label change in `chords` mode and simply
  never ran in `lead` mode. This meant a chord played while in `lead` mode was
  never recognised as one.
* **Decision:** One recognizer runs the whole time. A Note starts as
  whatever the fast lane can say in a few tens of milliseconds — usually a
  single pitch — and `harmony` appears on it later if the deep lane's
  evidence supports it. No `setMode`/`getMode`, no `TuninatorMode`.
* **Alternatives Considered:** Keeping modes as a performance optimisation
  (rejected — the correctness cost of "notes played in the wrong mode are
  invisible" outweighs any saved cycles); auto-detecting an implied mode
  from recent input (rejected — same class of bug, just implicit).
* **Consequences:** Fixes a real correctness bug at the cost of always
  running the harmonic-analysis path. This is a breaking API change with no
  compatibility shim — `docs/MIGRATION.md` documents the full mapping.

#### [DECISION-005]: Voices and Notes are distinct; a ringing string does not spawn a new Note
* **Date:** 2026-08-18
* **Status:** Accepted
* **Owner:** Tracker semantics (F2/F3, S1 of the rewrite/recovery)
* **Context:** After the initial rewrite landed, false positives jumped
  23→52 because the detector could not distinguish "a new note was struck"
  from "a voice that's still ringing produced a fresh-looking transient".
  49 of 52 false positives fell inside an already-labelled event's span.
* **Decision:** A new Note triggered while another is still ringing must show
  an energy rise *above the predicted decay envelope* (a fitted
  `VoiceDecay`, not an absolute threshold) before it is allowed to exist. A
  detected pitch explainable as one of the currently-sounding Note's own
  voices is attributed to that Note rather than spawned as a new one.
* **Alternatives Considered:** A fixed refractory window after any onset
  (measured and rejected — genuine restrums in the corpus are spaced
  453–560ms apart and phantom re-triggers cluster at 427–627ms; the
  distributions overlap almost completely, so no window width works);
  gating chord protection on the Note's *name* rather than on whether it has
  *bloomed* into a chord (rejected — this actively broke the one path,
  amp-sim recordings, that needed the protection most, since amp
  compression frequently prevented a confident chord name).
* **Consequences:** Recovered from the 23→52 false-positive regression
  without weakening any label or threshold (`git diff --stat -- fixtures/`
  was empty across the whole recovery). Established `voices.ts`
  (`VoiceDecay`) as authoritative over note creation, which later became load
  -bearing for the mute-witness and decay-based corrections described in
  `docs/DETECTION-FINDINGS.md`.

#### [DECISION-004]: Engine isolation — `src/engine/**` may import nothing outside itself and `src/types.ts`
* **Date:** 2026-08-18
* **Status:** Accepted
* **Owner:** Project architecture (P0 of the rewrite)
* **Context:** The 0.1 codebase already had this property informally
  (`src/core/`) and it was load-bearing: identical code ran in the
  `AudioWorklet`, the Node offline-eval harness, and Vitest. Losing it during
  the rewrite would have made the offline evaluation harness meaningless —
  it would no longer prove anything about live behaviour.
* **Decision:** Preserved and formalised as a test
  (`tests/engine/isolation.test.ts`) rather than a convention. No `window`,
  `AudioContext`, `performance`, npm imports, or top-level side effects
  anywhere under `src/engine/`.
* **Alternatives Considered:** Relaxing isolation for convenience during the
  rewrite with a plan to "clean it up later" (rejected outright — a
  convention with no enforcement degrades under time pressure, and this
  project's whole evaluation methodology depends on the property holding
  exactly, not approximately).
* **Consequences:** Every DSP kernel and tracker file is testable with
  synthesized `Float32Array` input and no browser mocks. Cost: some
  duplication at the `src/browser/` boundary (e.g. the worker host mirrors
  engine state rather than reading it directly) to keep the boundary clean.

#### [DECISION-003]: Rewrite target is a streaming Note recognizer, not an incremental patch to the pitch detector
* **Date:** 2026-08-17
* **Status:** Accepted
* **Owner:** Project direction
* **Context:** Tuninator 0.1 was a per-frame YIN pitch detector with a
  single-active-event tracker. The desired product — an evolving `Note`
  object with a hypothesis trail, chord blooming, overlapping events, bends
  as one continuous Note — could not be expressed by extending the existing
  `MusicEvent`/single-active-event model; the data model itself was wrong for
  the target.
* **Decision:** Full rewrite of the semantic layer (tracker, event model,
  public API) while reusing the eval-tested DSP kernels (YIN, FFT, chroma,
  chord templates, channel selection) as first implementations behind new
  contracts. Breaking 0.x change, no compatibility shim, delivered as phased
  commits (see `docs/MIGRATION.md` for the resulting phase plan).
* **Alternatives Considered:** Incremental extension of `event-tracker.ts` to
  support overlapping events (rejected — the "exactly one active event"
  invariant was structural throughout the file, not a single check to
  relax); a compatibility shim translating old API calls onto the new model
  (rejected — a shim would have to invent data for concepts the new model
  doesn't produce, e.g. `MusicEvent.state` for an object that no longer has
  envelope states, and inventing data is worse than a compile error for
  consumers).
* **Consequences:** One clean break at P4 of the rewrite rather than
  incremental API churn across many releases. Cost: `examples/browser-demo`
  and the separate `Tuninator-Example` repository needed dedicated migration
  work (`docs/MIGRATION.md`, `docs/example-migration-prompt.md`).

#### [DECISION-002]: Definition of "done" is zero missed required labels, not a percentage accuracy target
* **Date:** 2026-08-17
* **Status:** Accepted
* **Owner:** Project direction
* **Context:** Needed a concrete, falsifiable bar for when detection quality
  is acceptable, stated before the rewrite began rather than negotiated
  after seeing results.
* **Decision:** The recognizer must detect every required labelled event
  (`maxMissed: 0` on required fixtures) unless fixture-audio verification
  (`scripts/verify-fixtures.ts`) shows the label is not recoverable from the
  audio — inaudible, or the stated pitch class genuinely absent from the
  signal. Any such exception requires written evidence in the verification
  report, never a quietly lowered threshold. Stated standard, restated
  directly by the project owner during development: "if a human wouldn't
  recognize it as a note then sounds like the analyzer is not working and
  needs to be fixed."
* **Alternatives Considered:** A percentage accuracy gate (e.g. "≥90% of
  labels found") — rejected as too easy to satisfy by quietly accepting a
  fixed error rate rather than by fixing causes.
* **Consequences:** Forced every miss to be individually traced to a named
  code branch (`scripts/measure-downstream-ledger.ts` exists because of this
  decision) rather than reported in aggregate. Currently 32 of 459 labels are
  still missed; each has a named cause in `docs/DETECTION-FINDINGS.md`. Not
  yet met in full — this decision remains the active target, not a
  historical record of success.

#### [DECISION-001]: Held-out evaluation set is mandatory before any detection constant is trusted
* **Date:** 2026-08-19
* **Status:** Accepted
* **Owner:** Evaluation methodology
* **Context:** Every tuned constant in the detection pipeline (gates,
  thresholds, window sizes) risks being fitted to the exact five recordings
  used to derive it, producing numbers that look good and predict nothing
  about a new recording.
* **Decision:** Split the corpus into a five-take, 78-event **derivation**
  set (120bpm, one guitar) that alone may inform any tuned constant, and a
  twelve-take, 381-event **held-out** set (140bpm, a second guitar, three
  signal paths: DI, amp sim, room mic) that is scored on every run and never
  fitted. Any measurement drawing a conclusion from held-out data alone (e.g.
  a chain-specific calibration profile derived from *all* takes in a chain,
  including the one being scored) must be labelled explicitly as a ceiling,
  not a result.
* **Alternatives Considered:** Tuning against the full seventeen-take corpus
  directly (rejected — this is exactly the leak the split exists to prevent,
  and several 2026-08-20 experiments, e.g. DECISION-010's fit-on-test
  calibration ceiling, demonstrate concretely how large the gap between an
  in-sample number and a genuine held-out number can be).
* **Consequences:** Every accuracy number in `README.md` and
  `docs/DETECTION-FINDINGS.md` is meaningful specifically because this
  separation held throughout the project. Cost: derivation data is scarce
  (43 single-note events from one recording underwrite the entire note-
  segmentation tuning), which is itself a named limitation — more varied
  derivation recordings would be the highest-leverage single contribution to
  future tuning work.
