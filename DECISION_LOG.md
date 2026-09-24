# Decision Log

Architectural, technical, and critical project decisions for Tuninator, in the
schema defined by `AGENTS.md` §6. Newest entries at the top. A decision this
project rejected is logged exactly like one it accepted — the negative results
are what keep later work from repeating them.

---

#### [DECISION-083]: The owner's fourth listening pass on the A3 eighths DI take, and optional labels
* **Date:** 2026-09-24
* **Status:** Accepted
* **Owner:** The project owner (marked the picks, 2026-09-24; chose "optional" for the two weak ones); evaluation harness carries the matcher rule
* **Context:** `e865` was one of the five tuning DI slow splits left after
  DECISION-082: the engine accepts a transient 160ms into the note (rise
  2.17, sharpness 10.6). Asked to listen, the owner heard more picks than
  the labels carry over 18-19s, and asked for a page where he could place
  them himself. He marked every pick over 17.1-20.0s on a drag-and-add
  page ("A3 Pick Marker 17-20s", db `answers/a3-17-20`). He re-added the
  two weak picks near 19.13s and 19.60s that he had left out on
  2026-09-14 as bad playing, and called them optional.
* **Decision:** Labels: `e863`, `e864`, `e866`, `e868` move 12, 27, 11
  and 23ms earlier; `e865b` 18.153s, `e866b` 18.362s, `e867b` 18.620s and
  `e868b` 18.852s are added; `e869b` 19.127s and `e871b` 19.611s are added
  with `required: false`; ends in the stretch re-chain to the next start.
  The amped twin is not moved. Matcher: the per-event `required` flag,
  present in the format but read by nothing, now means something. A
  `required: false` label takes part in the one-to-one assignment, so the
  Note under it is not an extra, and the pair is then dropped: never a
  match, never a miss. `measure-splits.ts` charges Notes to it the same
  way and leaves it out of its counts. No label carried `false` before.
  Numbers, engine unchanged: derivation missed 97 -> 100, fp 201 -> 200;
  slow subset 186 / 218 of 770 -> 185 / 217 of 774 (DI tuning splits 5 ->
  4: `e865` was a real pick, `e865b`); corpus 239 / 275 -> 238 / 274;
  ledger MISSED 124 -> 127; held-out unchanged; eval PASS; 552 tests.
  The three new misses are picks the engine does not open a Note on:
  `e866b` (an onset at 18373ms, rise 1.05, no split), `e867b` (onset at
  18627ms, rise 0.78) and `e868b` (no onset).
* **Alternatives Considered:** (a) **Leave the two weak picks out:** his
  earlier call; he chose optional instead. (b) **Required:** a miss on a
  pick he calls bad playing would count against the engine.
* **Consequences:** `e865` leaves the list of DI slow splits; four remain.
  The same-pitch loop's next target list gains three quiet re-picks on
  this take the engine does not hear.

---

#### [DECISION-082]: A contact the fine witness delivers after its release was refused under the gate moves onto that release
* **Date:** 2026-09-24
* **Status:** Accepted
* **Owner:** Detection architecture (DECISION-044's loop, iteration 21)
* **Context:** Two of the seven tuning DI slow splits left after
  DECISION-081 (`e5`, `e25`, quarters DI) are one shape. The pick's
  release lands on a hop under `analysis.rmsGate` (20453ms rise 2.09;
  30480ms rise 2.81) and is refused `gated` on the Note before. Only
  afterwards does the fine witness, which confirms an onset 65ms late,
  deliver the contact (20397ms, 30419ms) and open the stroke's Note there,
  56 to 61ms early. A second fine onset then splits that Note again
  (20459ms, 30488ms). DECISION-052 reads a release on the frame that
  opens a fine-opened Note and after it, never one that came before.
* **Decision:** `tracking.releaseBeforeFineContact` (on). The newest
  same-pitch `gated` refusal is remembered with its rise; when the fine
  witness opens a Note and that refusal sits inside the articulation
  window after the contact with a rise of `tracking.releaseRiseRatio` or
  more, the Note's start moves onto it (traced `released` via `gated`,
  contact `fine`) and its announce clock stays on the contact.
  Numbers (derivation predicate "not 140bpm"): slow subset 188 / 220 →
  186 / 218 (DI tuning 7 → 5; amped and mic unchanged); corpus 241 / 277
  / 15 → 239 / 275 / 15; tail fragments 224 / 241 → 223 / 239;
  derivation missed 97 → 97, fp 203 → 201; ledger MISSED 124; `e5` and
  `e25` now match 27 and 37ms from their labels; held-out, read once,
  missed 27, fp 66, unchanged; eval PASS; 551 tests.
* **Alternatives Considered:** (a) **Dedupe the second fine onset
  alone:** it would leave the Note on the contact, 56ms early, and
  `e5`'s bar would still hold the early Note. (b) **A flag with no rise
  bar:** not built; the release bar is the one every other release rule
  reads.
* **Consequences:** Nothing a derivation count can see moved but the two
  targets. The rule reads a refusal made on another Note, so it depends
  on the order the fine witness and the gate report in; both are hop
  order in source time, as offline and live.

---

#### [DECISION-081]: A damped re-pick whose transient the gate refused splits the Note, and the refused-contact burst rule ships with it
* **Date:** 2026-09-24
* **Status:** Accepted
* **Owner:** Detection architecture (DECISION-044's loop, iteration 20; the owner restarted the loop 2026-09-24, "go")
* **Context:** DECISION-080 re-ran the refused-contact burst rule (ledger
  C11) and found both labels it costs are one shape: a re-pick after a
  damp whose transient lands on a hop `analysis.rmsGate` refuses, on a
  Note still open because its tail kept a pitch reading
  (`held-then-picked-di` at 29467ms, `eighths-sixteenths-e5-di` at
  12467ms). `rearticulation.ts` returns `gated` before reading anything,
  and the next hop, back at full level, carries no broadband transient of
  its own, so the pick is lost into the Note. Counted on every take at
  `main`: 70 settled same-pitch `gated` refusals, 62 of them on the four
  DI same-pitch takes and none on an amped render; 52 of the 70 sit
  within 40ms of a label.
* **Decision:** `tracking.gatedRepickDipRatio` 0.25 (new ledger row C28).
  A settled, unbloomed Note refused a same-pitch transient as `gated`
  with the envelope fallen to 0.25 or less before it is held pending for
  one articulation (`transient.articulationMs`); if the level comes back
  on an ungated hop by `tracking.releaseRiseRatio` while the Note is
  announced and has sounded half the local interval, the Note ends at the
  refused transient and a new Note opens there (traced `gatedRepick`).
  DECISION-080's rule, `tracking.burstContactRiseRatio` 1.2 with
  `tracking.burstContactRingOutOnContact`, ships with it.
  Numbers (derivation predicate "not 140bpm"), base → both rules:
  derivation missed 113 → 97, fp 204 → 203, exact 948 → 975; slow subset
  190 / 222 → 188 / 220 of 770 (DI tuning 9 → 7, amped and mic 148 / 180
  unchanged, DI held-out 3); corpus 243 / 279 / 14 → 241 / 277 / 15; tail
  fragments 227 / 244 → 224 / 241; ledger MISSED 140 → 124
  (`held-then-picked-di` 14 → 2, `eighths-a3-di` 63 → 59); eval PASS;
  549 tests. Held-out, read once: missed 27 → 27, fp 65 → 66 (a Note at
  30120ms on the mic triplet take, 2.4s from any label, on a gated hop
  with dip 0.08). The sweep and the guards are in `config.ts`.
* **Alternatives Considered:** (a) **This rule alone**, at 0.2: missed
  113 → 100 but `e843` reads split, the refused-contact shape behind the
  pick it finds, so the slow DI column is worse by one; kept only with
  DECISION-080's rule, which clears it. (b) **Without the announced
  guard:** four sixteenths on the E5 take lost (a split drops the young
  Note before it clears its bar). (c) **Without the half-the-pace guard:**
  `e839` split (a contact stub the fine witness opened, cut by its own
  release). (d) **The ring-out clock from the moved start**, as every
  other Note: one more split and one more false positive on derivation,
  the phantom DECISION-049 named. (e) **Accepting a gated transient
  outright when it rises by the release bar:** not built; it cannot reach
  `e843`, whose transient rose 1.54 and whose level came back on the
  next hop.
* **Consequences:** Two rows ship together, each defended by the other's
  numbers; neither clears the keep rule alone, and that is recorded
  rather than argued around. Sixteen derivation labels the engine did
  not find are now found with none lost, most on the held-then-picked DI
  take, whose damped re-picks were the rule's target. The amped renders
  are bit-identical in count (an amp's floor sits over the gate). The
  held-out mic triplet take gains one Note on a gated hop far from any
  label, the one reading the rule costs.

---

#### [DECISION-080]: Door C25 has no site left, and the refused-contact burst rule re-run alone still costs two labels
* **Date:** 2026-09-24
* **Status:** Rejected (the rule alone); carried into DECISION-081
* **Owner:** Detection architecture (DECISION-044's loop, iteration 19; the owner restarted the loop 2026-09-24)
* **Context:** The loop paused on 2026-09-19 with C11 (the refused-contact
  burst) and C25 (the attack branch on the rising transient) reopened
  under DECISION-063's instrument and never re-run. At `main` (after
  DECISION-067) the tuning DI takes read 9 slow splits: `p1c1h`,
  `p2c3q2`, `p2c4q3`, `p3c4q1` (held-then-picked), `e865` (A3 eighths),
  `e821` (E5 eighths), `e5`, `e25`, `e26` (quarters).
* **Decision:** C25 is closed by count: its target (`a14`, `a15`) no
  longer reads split, and none of the nine is an attack-branch boundary
  on a band-only onset. C11 was rebuilt as DECISION-047 had it
  (`tracking.burstContactRiseRatio` 1.2) plus the anchor ledger row C15
  proposed and DECISION-049 asked for: the Note a moved boundary opens
  reads its ring-out age from the contact (`NoteRecord.ringOutFrom`).
  Alone: slow DI tuning 9 → 7 (`p2c3q2`, `p2c4q3`), amped unchanged,
  corpus 243 / 279 → 241 / 277, fp 204 → 203, and derivation missed
  113 → 115: `p2c3q4` and `e843`, the same two overlap credits as
  iterations 3 and 5. Both are labels whose own pick the engine never
  found; each was credited to a Note that began at the previous pick's
  contact (410ms early, and 177ms late). Rejected alone on the missed
  line; the shape that hides both picks is DECISION-081's.
* **Alternatives Considered:** (a) **Keep it on the owner's word**, as
  DECISION-062 did: not needed, since the next row finds the two picks.
  (b) **Without the ring-out anchor:** read in DECISION-081, one phantom
  more.
* **Consequences:** C11's two obstacles from DECISION-049 are both
  answered: the instrument (DECISION-063) and the ring-out clock (this
  anchor). What remained was two picks under the gate. C25 is spent.

---

#### [DECISION-075]: The last E5 of the C-A-G power chords take is labelled where the owner hears it
* **Date:** 2026-09-24
* **Status:** Accepted
* **Owner:** The project owner (chose "Move label", then marked the times by ear on a listening page and pasted them into the thread, 2026-09-24)
* **Context:** `power-chords-c-a-g-e-c-d-fsharp-e-120bpm` is labelled on
  a bar grid. Its last chord, `p8` E5, sat at 19.1-20.75s. The file is
  under -45dB from 19.13s to its end; the chord sounds 18.2-18.9s.
  Before DECISION-073 the E5 Note rang to 19.107s and touched the label
  by 7ms, which the matcher counted as a match. Once the Note ends at
  the damp (18.88s) the label is missed and the Note is an extra.
* **Decision:** `p8` moved to 18175-18848ms, the start and end the owner
  marked on the "Last E5 Label" listening page. Tuninator was not used
  to place it; the file's `timingNotes` records the correction. `p7`
  stays on its grid slot (17.1-19.1s), overlapping the new `p8`.
  Numbers against DECISION-074: derivation missed 115 → 114, fp 197 →
  196, exact 1070 → 1071; held-out unchanged (27 / 62 / 320); splits
  237 / 270 / 11 and slow subset 184 / 213 unchanged; ledger MISSED
  142 → 141. The engine did not change.
* **Alternatives Considered:** (a) **Leave the grid slot**: keeps a
  label over silence and charges DECISION-073 with a miss and an extra
  it did not cause. (b) **The plain-envelope suggestion, 18170-18850ms**:
  the owner's marks are within 5ms of it; his are used.
* **Consequences:** The take scores 8 of 8 with one extra. The other
  seven chords remain on the grid and were not re-examined here.

---

#### [DECISION-074]: A Note opened inside the damp that stopped the Note before it is absorbed into it
* **Date:** 2026-09-24
* **Status:** Accepted
* **Owner:** The project owner (asked for the amped rest-and-repick take's extra Notes to be fixed, and chose "Go on" to fixing the damp splits, 2026-09-24); detection architecture carries the rule
* **Context:** On `rest-repick-g2-60-120bpm-amped` the damp at 18.1s
  opened a G2 Note at 18.33s. The level was already 22dB under the
  note's and still falling. The sharpness fallback accepted it (sharpness
  2.34, rise 0.78, dip 0.08). DECISION-071 found it was the only
  sharpness-accepted opening in the derivation takes with a dip under 0.1
  and no rise, so no bar on those witnesses could be derived. DECISION-073
  gives a witness that does not need one: the damp itself. The ghost
  opened after the level had fallen `dampFallDb` under the note, the level
  never came back, and it ended in silence. The Note before had already
  been let go by the time the ghost ended, because the deep lane resolved
  it within one hop.
* **Decision:** Two parts, with no new tuned constant.
  (1) A Note is held in `closing` while a Note that opened at its end is
  still sounding and opened `tracking.dampFallDb` or more under its
  median level over the 300ms before (`quietSuccessor`). Across all 27
  takes this holds 9 Notes.
  (2) When a Note ends in silence and the Note before it ran right up to
  it, the damp search (`dampedAt`) runs over the two of them. The Note
  before must be within `DAMP_STEP_SEMITONES` and still closing. If the
  fall began at or before the later Note opened, the later Note is
  absorbed (`structuralRevision`, `absorbed`) and the earlier one ends at
  the damp (`absorbDampGhost`).
  Numbers: derivation missed 115 → 115, fp 198 → 197
  (`rest-repick-amped` 2 → 1), exact 1070 unchanged; `rest-repick-di`
  median end +55 → +48ms. Held-out, read once: missed 27, exact 320,
  fp 63 → 62 (`power-chords-amped-140bpm` 2 → 1). Splits 237 / 270 with
  strays 13 → 11; slow subset 184 / 213 with strays 7 → 6. Ledger MISSED
  142. 547 tests.
* **Alternatives Considered:** (a) **A bar on the sharpness fallback's
  dip or rise**: one instance, nothing to derive it from (DECISION-071).
  (b) **Revise the earlier Note after its `noteEnded`**: a consumer has
  already been told it is finished, and the offline adapter scores the
  end it was given then. (c) **Hold every Note until the one after it
  ends**: delays every legato note's end. The quiet opening confines the
  hold to the 9 cases where a damp ghost is possible.
* **Consequences:** A quiet re-pick within a whole tone, opened with no
  gap straight out of a damp, that then fades to silence without ever
  coming back within 5dB of the note before, would be folded in. None in
  the corpus does. A Note followed by a quiet successor ends later for
  consumers, by as long as that successor sounds.

---

#### [DECISION-073]: A Note ending in silence ends at the player's damp, not where the amp's ring falls under the gate
* **Date:** 2026-09-24
* **Status:** Accepted
* **Owner:** The project owner (chose "Build damp ending" and then "Build it" on the damp-test numbers, 2026-09-24); detection architecture carries the rule
* **Context:** A Note ends when the sound falls under the amplitude gate
  (`releaseGraceMs` after it). Through an amp the string rings about
  0.45s past the player's damp before the gate closes, so every damped
  amped Note ran on with it: on `rest-repick-g2-60-120bpm-amped` the
  median end was +445ms against the labels. Un-blooming those Notes
  (DECISION-069's follow-on) appeared to help only because ghost splits
  cut them at the damp. A damp is a level event: the level falls
  sharply under where it has been and does not come back. Benched on the
  cached fast-frame levels of every derivation take, with the fall at
  6 / 10dB under the 300ms median, depth 15 / 20 / 25dB within 150 /
  300ms, and no recovery for 150 / 300 / 500ms. At 10 / 25 / 300 / 500
  it found all 16 damps on the two rest-repick takes and fired nowhere
  in the middle of a held note. Elsewhere it fired only where a take's
  last note, or one chord before a change, falls silent. With the end
  on the first hop 6dB under the median, the rest-repick ends land
  30-120ms after the labels. Four labelled notes end before theirs: the
  last notes of the A3 eighths amped (135ms) and DI (53ms) and of the
  A-Bm chords (80ms), and the last E5 of the C-A-G power chords, whose
  label sits over silence (below). The owner saw these numbers and chose
  to build. The held-out takes were looked at once on the bench, at the
  walk-back placement; nothing was chosen from them.
* **Decision:** `tracking.dampFallDb` 10 and `tracking.dampDepthDb` 25.
  When a Note ends in silence, the tracker looks back over its own level
  log (`NoteTracker.dampedAt`) for the first hop 10dB under the median
  of the 300ms before it that reaches 25dB under within 300ms and never
  climbs back past 5dB under before the silence. The Note ends on the
  first hop 6dB under that median instead of where the gate closed.
  Notes ended by what follows them are untouched. 0 turns it off.
  Numbers: derivation missed 114 → 115, fp 197 → 198, exact 1071 →
  1070; all three are one Note on `power-chords-c-a-g-e-c-d-fsharp-e-120bpm`.
  Its last E5 sounds 18.2-18.9s, then the file is silent (-61dB from
  19.4s to its end at 20.75s). The label `p8` sits at 19.1-20.75s, and
  the Note used to ring to 19.107s, touching it by 7ms. It still opens at
  18.17s named E5 and now ends at 18.88s. Median end error:
  `rest-repick-amped` +445 → +91ms, `rest-repick-di` +102 → +55ms.
  Held-out, read once: missed 27, fp 63, exact 320, all unchanged; end
  error `power-chords-amped` +125 → +29ms, `power-chords-di` +31 → +9ms,
  `power-chords` (room) +24 → -18ms. Splits 237 / 270 / 13 and slow
  subset 184 / 213 unchanged. Ledger MISSED 141 → 142 (the same E5).
  546 tests (`tests/engine/damp-end.test.ts` adds four).
* **Alternatives Considered:** (a) **Un-bloom the amped single notes so
  the ghost splits end them**: +10 to +14 false positives, and the
  better end was the ghosts' doing (DECISION-069). (b) **A fall over
  100ms among short contiguous Notes ending in silence**: 3 false
  positives and 1 matched Note above 8dB. (c) **Fall 6dB, reach 15dB
  within 150ms**: missed 3 of the 8 DI damps and fired 30 times on other
  takes. (d) **End on the hop where the fall starts** (the walk-back to
  the median): 70-130ms before the labels, which sit where the note has
  dropped about 6dB.
* **Consequences:** Notes the player stops now end when they stopped
  them, on both paths. A note left to decay into silence with no sharp
  fall is untouched. A last note whose level drops 25dB fast is ended at
  that drop, which on three takes is 53-135ms before the label. The
  ghost Notes after a damp (the Note at 18.33s on `rest-repick-amped`)
  are not touched by this and are still counted.

---

#### [DECISION-071]: A short Note the release arrives 15dB louder than was the pick's contact through an amp
* **Date:** 2026-09-24
* **Status:** Accepted
* **Owner:** The project owner (asked for the amped rest-and-repick take's extra Notes to be fixed, 2026-09-24); detection architecture carries the rule
* **Context:** On `rest-repick-g2-60-120bpm-amped` the pick at 12.01s
  came out as a 133ms Note opened at 11.91s (-39.6dB, one C3 hop) and
  then the pick. The amp makes the pick's contact loud enough to be an
  attack of its own. The repository finds a contact by its lack of rise
  (`isContactOpening`, rise under 1.2, DECISION-046), which is what a DI
  contact sounds like, but through the amp contacts rise 4-48x over the
  silence before them and the test never fires. What still gives it
  away is that the note, when it sounds, is far louder again.
  Benched on the derivation takes, over every attack-opened Note ended
  within 200ms by an accepted, settled re-articulation: the level on the
  hop that opens the next Note sits 12.0-21.6dB over the short Note's
  opening hop on four false positives, and at most 11.2dB on the 413
  that matched a label.
* **Decision:** `tracking.contactGainDb` 15. When a re-articulation
  opens a Note on an attack at least that much louder than the attack
  that opened the Note it ends, the short Note was the contact: it is
  absorbed even past `transient.articulationMs`, and the boundary stays
  on the release (`released`, `contact: "gain"`). 0 turns it off.
  Numbers: derivation missed 114 → 114, fp 199 → 197
  (`rest-repick-amped` 3 → 2, `eighths-a3-amped` 39 → 38), exact labels
  unchanged. 12dB reads the same (the other two false positives above
  12dB are declined by other guards). Held-out, read once: missed 27,
  fp 63, exact 320, all unchanged. Splits 238 / 271 / 14 → 237 / 270 /
  13; slow subset 185 / 214 → 184 / 213. Ledger MISSED 141. 542 tests.
* **Alternatives Considered:** (a) **Widen `isContactOpening`'s rise
  bar** to reach the amped contacts: a rise of 4-48 overlaps every real
  attack out of silence. (b) **Drop unvoiced short Notes before a louder
  one**: the voiced fraction does not separate them (the rest-repick
  contact is 0.1 voiced, the eighths one 0.42, matched stubs range 0 to
  1).
* **Consequences:** Two contacts on the amped takes stop reading as
  notes. A real quiet note answered within 200ms by a note 15dB louder,
  on an attack, would now be folded into it; none in the derivation
  takes comes within 3.8dB of the bar. The contact at 7.63s on the
  rest-repick amped take is not touched: no note follows it within
  200ms.

---
#### [DECISION-069]: A Note whose readings after its pitch settles find one fundamental reports its pitch, not a chord
* **Date:** 2026-09-24
* **Status:** Accepted
* **Owner:** The project owner (asked for the amped rest-and-repick take's "G5" naming to be fixed, 2026-09-24); detection architecture carries the rule
* **Context:** On `rest-repick-g2-60-120bpm-amped` five of the eight G2
  picks were named "G5" and one "unknown": the Note bloomed into a chord.
  Blooming is vetoed for a Note whose mean fast-lane pitch confidence is
  over `harmony.maxMonophonicConfidence` (0.9), but through an amp a
  picked G2 is aperiodic for 60-160ms, and those unvoiced hops hold the
  mean under 0.9 for a second or more (0.28 at 4.16s, 0.9 only at 5.76s)
  while the attack's noisy spectrum supplies the polyphony. After that,
  most multi-pitch readings find one fundamental, G2, and the chroma of
  its harmonics (G and D) matches the "G5" template.
  Benched on the derivation takes, over every Note that ended bloomed:
  the share of multi-pitch readings taken after the Note held a pitch
  (DECISION-068) that found fewer than `harmony.minPolyphony`
  fundamentals. All 37 over a chord label read under 10% (the most, 1 in
  39); of the 66 over a single-note label, 48 read 20% or more, 58 read
  10% or more.
* **Decision:** `harmony.oneStringReadingFraction` 0.2. At or above it
  a bloomed Note is `oneString`: it reports its pitch and no harmony,
  delivered as a `harmonyCorrection`. Only the name follows;
  `harmonyBloomed` stays set, so segmentation is unchanged. 0 turns it
  off.
  Numbers, final Notes and the matcher: derivation exact labels 1027 →
  1071 of 1220-1222 (`held-then-picked-amped` 76 → 109 of 120,
  `rest-repick-amped` 2 → 8 of 8, `rest-repick-di` 7 → 8,
  `eighths-a3-amped` 160 → 163, `held-then-picked-di` 104 → 105); missed
  113 → 114, fp 198 → 199, both on `held-then-picked-di`, where the Notes
  are identical and the matcher now pairs `p2c3q3` with the Note it
  overlaps by name instead of the one 410ms before `p2c3q4`. Held-out,
  read once: missed 27 → 27, fp 63 → 63, exact 320 → 320 of 372 (one
  `cowboy-chords-amped` chord now reads as its root note; one triplet
  note gains its name). Splits unchanged (238 / 271 / 14; slow subset
  185 / 214). Ledger MISSED 140 → 141, the same re-pairing. 542 tests.
* **Alternatives Considered:** (a) **Un-bloom the Note outright**
  (clear `harmonyBloomed`): exact 1027 → 1073 and missed 113 → 109, but
  fp 198 → 212: a bloomed Note is shielded from pitch-step and
  re-articulation splits, and without the shield the amp's damps and
  some mid-note transients cut the Note (on the rest-repick amped take 3 →
  8 extra). It also brings the amped end error from +445ms to +135ms.
  Worth taking once those splits are handled; not before. (b) **Mean
  confidence over voiced hops, or since the pitch arrived:** the first
  voiced hops of an amped pick read 0.54-0.64, so the bloom still happens
  on the attack. (c) **Bar 0.1:** ten more single notes renamed, but a
  chord with eight readings would flip on one lone-fundamental reading.
* **Consequences:** A single string through an amp is named as a note.
  A real chord whose later readings keep finding a single fundamental
  (a power chord whose fifth has died, a chord reduced to its root) now
  reports that root note: one held-out amped chord does. The segmentation
  a bloomed Note gets still applies to these Notes, which keeps their
  ends late on the amp.

---
#### [DECISION-068]: A pitch step out of a Note that never held a pitch is the pitch arriving, not a new note
* **Date:** 2026-09-24
* **Status:** Accepted
* **Owner:** The project owner (asked for the amped rest-and-repick take to be fixed next, 2026-09-24); detection architecture carries the rule
* **Context:** On `rest-repick-g2-60-120bpm-amped` three of the eight
  picks came out as a 67-133ms stub followed by the real Note (11.91s,
  16.04s, 25.93s). Through the amp a picked G2 takes 60-160ms to read as
  periodic, and the first voiced hops are its harmonics (16.08s: 396Hz
  then 247Hz, then 98.9Hz) or, across a silence, the previous Note's last
  reading (25.93s: the step "from" 104.1Hz was the damp of the note before,
  400ms earlier). The pitch-change detector confirmed a step into G2 and
  the tracker ended the Note there. `pitchStillArriving` exists for
  exactly this and did not fire: the stub had been announced (67ms over
  the 55ms bar), and its votes included the arriving G2's first hop, so
  "every vote is for the reading it is leaving" was false.
* **Decision:** `NoteRecord.heldReading`: a Note has held a pitch once
  `pitch.stepConfirmFrames` of its own voiced hops in a row agree within
  `pitch.stepThresholdCents`, the detector's own test; a Note opened by a
  confirmed step holds one from its start. A step out of a Note that has
  never held one is `pitchStillArriving` (with the existing
  `cannotDefendReading` guard), and the stub it sheds is absorbed even
  past `transient.articulationMs`, since it has no pitch of its own to
  stand for. No new constant.
  Numbers, final Notes and the matcher: derivation missed 113 → 113, fp
  204 → 198 (`rest-repick-amped` 5 → 3, `held-then-picked-amped` 50 → 48,
  `eighths-a3-amped` 40 → 39, `quarters-a3-e5-amped` 68 → 67); exact
  label accuracy unchanged. Held-out, read once: missed 27 → 27, fp 65 →
  63. Splits: slow subset 190 / 222 → 185 / 214 of 770; corpus 243 / 279
  / 14 → 238 / 271 / 14 of 1610; ledger MISSED 140 → 140. 542 tests.
* **Alternatives Considered:** (a) **Refuse the step outright** when the
  Note never held a pitch, instead of ending and absorbing: derivation fp
  204 → 197 but missed 113 → 114 (one E5 DI eighth) and exact accuracy
  down six labels. (b) **Only widen the vote test** without lifting the
  absorb's 80ms bound: fp 204 → 202; the 25.93s stub is 133ms and stays.
* **Consequences:** On the amped take the 16.04s and 25.93s stubs are
  gone; the 11.91s one was already absorbed and its contact Note before
  it remains. A Note whose first readings are its harmonics now keeps
  the attack's start. A real grace note too short for two agreeing
  readings (under ~30ms) followed by a step would now be folded into the
  note it leads to; none in the corpus.

---

#### [DECISION-067]: The quarters take's E5 labels `e26`-`e40` move onto the note sounding
* **Date:** 2026-09-24
* **Status:** Accepted
* **Owner:** The project owner ("move them", 2026-09-24); measured and applied by the agent, returned to him on a listening page to confirm
* **Context:** While checking his third listening pass (DECISION-064) the
  agent found that `quarters-a3-e5-di`'s E5 section drifts: measured on
  a 10ms RMS envelope, `e26`-`e40` sat 30-52ms before the big rise where
  the note sounds, growing along the section. `e36` was the one he had
  already moved by ear, 40ms later, onto that rise.
* **Decision:** `e26`-`e35` and `e37`-`e40` move to the measured rise
  (30475, 30968, 31458, 31963, 32443, 32950, 33473, 33950, 34445, 34980,
  35978, 36463, 36973, 37468 ms); each previous label's end follows where
  it was chained to the old start. Sent to the owner as the "E5 Quarters
  Label Check" listening page, whose answers land in its db collection
  `answers`.
  Numbers, with DECISION-066 in place: derivation missed 113 and fp 204
  before and after; the move changes no match. Eval PASS with the same one
  informational failure.
* **Alternatives Considered:** (a) **Move `e21`-`e25` too** (+25 to +28ms
  by the same measure): inside the matcher's tolerance and not in what
  was proposed. (b) **Move the amped twin with them:** the owner judged
  no amped audio, and DECISION-064 left twins alone for the same reason.
* **Consequences:** The E5 section's labels sit on the note, as `e36`
  does. The owner confirmed them on the page on 2026-09-24: all four
  clips checked, none moved. `quarters-a3-e5-amped` is no longer byte-identical in timing to
  its DI twin.

---
#### [DECISION-066]: The owner's rest-and-repick take becomes tuning material, and a damp is not a note
* **Date:** 2026-09-24
* **Status:** Accepted
* **Owner:** The project owner (recorded the take 2026-09-23; "it should calibrate recognition to these files", 2026-09-24); detection architecture carries the rule
* **Context:** The corpus lacked the shape of the owner's original
  complaint: a note picked, rung, damped for a rest, then picked again.
  He recorded it (G2, four picks 4s apart then four 2s apart, each damped
  about halfway to the next) as DI and re-amped, and asked that the
  recognizer be calibrated to both files. On the shipped engine every
  pick was found on both renders, with five extra Notes on each. On the
  DI render all five were a 90-170ms G#2 at a damp: laying the hand on
  the string pushes it sharp for a moment (98Hz to 104.6Hz at 10.08s),
  and the region lane (`isRealBoundary`, `pitchChange`) held the new
  leader for two windows and cut it off as a Note. Across the derivation
  takes the region lane's accepted pitch-change boundaries that reached
  the final list were exactly these five.
* **Decision:** `fixtures/audio/Rest Repick {DI,Amped} G2 60-120bpm.mp3`
  and `fixtures/labels/rest-repick-g2-60-120bpm-{di,amped}.json` are
  added as derivation material, with no `eval.config.json` entry (like
  the other calibration takes) and in `measure-splits.ts`'s slow subset.
  Labels are measured (start where the note sounds, end on the damp;
  amped = DI +3ms). New constant `deep.dampTailMs` 300: a pitch-change
  boundary within a whole tone of the Note's name, in the last 300ms of a
  Note that ended by falling silent (`silentSince` set), is not a
  boundary. Derivation tails ran 91-240ms. Engine off with 0.
  Numbers, rule off → on, final Notes and the matcher: derivation missed
  113 → 113, fp 209 → 204 (all five on the rest-repick DI take, which
  reads 8 of 8, 0 extra); held-out, read once, missed 27 → 27, fp 67 →
  65 (`lead-line-amped-sixteenths` 3 → 2, `lead-line-di-triplet` 8 → 7).
  542 tests.
  Both changes together against DECISION-065's state: eval PASS with the
  same one informational failure; slow subset 187 / 220 of 754 → 190 /
  222 of 770 (the rest-repick amped take adds 3 / 2, its DI take 0);
  corpus 240 / 277 / 13 of 1594 → 243 / 279 / 14 of 1610; ledger MISSED
  140 → 140.
* **Alternatives Considered:** (a) **Hold the takes out** as a transfer
  check, which is what they were recorded for. The owner chose tuning.
  (b) **Require a fall in level after the boundary** (the damp's
  envelope drops 5-12dB in 100ms) instead of the Note's silent end: a
  second number to tune, and the silent end is already the tracker's own
  fact about the Note. (c) **Raise `BEND_IS_ONE_NOTE_CENTS`'s reach** to
  these Notes: the bend tracker never saw the sharp push on four of the
  five (peak 0 cents), so the region lane is where it has to be refused.
* **Consequences:** A damp no longer adds a note a half step up on the
  direct input. A legato note (hammer-on, pull-off, slide) of a tone or
  less that is muted within 300ms of arriving, with nothing after it, is
  now folded into the note before; the corpus has none. The amped
  render's stubs, pitch naming (G5) and ring past the damp are
  untouched. The DI take's onsets read +35ms late at the median.

---
#### [DECISION-065]: Door 1, the phrase-regularity decode, is closed on the bench: at no cost it removes 13 derivation extras where the shipped rate gate removes 44
* **Date:** 2026-09-23
* **Status:** Rejected
* **Owner:** The agent, under the slow-note-splits loop brief (§5 door 1), which the owner said go on 2026-09-23
* **Context:** Door 2 closed on 2026-09-18 (every witness read at a
  boundary tops out near 0.70 AUC, and through an amp a phantom and a
  re-pick read the same). Door 1 asks whether the information is in the
  SEQUENCE instead: judge a phrase's same-pitch boundaries together and
  drop the one whose removal makes the phrase's note spacing most
  regular. Ledger row C1. Its falsifier, stated in the brief and in the
  bench's header before running: on the derivation takes, more extra
  Notes removed than the shipped rate gate removes on the current
  engine, at zero added missed labels; then held-out once, not worse.
  Measured on the labels after DECISION-064.
* **Decision:** Closed. `scripts/measure-phrase-regularity-decode.ts`
  simulates the drop on the final detection list (survivor's end
  extended, matcher re-run), nothing in the engine changed. The gate's
  share, measured by running the engine with both span fractions at 0:
  missed 113 → 112, fp 199 → 243, so the gate removes 44 extras at +1
  missed. 126 settings of the decode (three grids of allowed interval
  multiples, six margins, seven variants: candidates restricted to
  accepted same-pitch re-articulations, a dip penalty, abstaining on
  phrases whose median interval is under 200ms) were read on top of the
  shipped engine and in place of the gate. Best at +0 missed: halves
  grid, accepted boundaries only, dip weight 1, abstain under 200ms,
  margin 0.5: fp 199 → 186 (-13), on three takes
  (`held-then-picked-amped` 50 → 43, `quarters-a3-e5-amped` 68 → 64,
  `quarters-a3-e5-di` 3 → 1). Held-out, read once at that setting:
  missed 27 → 27, fp 67 → 65. In place of the gate, no setting reaches
  the gate's count at +1 missed or less (best fp 232 at -1). The
  frontier across all 126 settings: -16 at +1 missed, -22 at +3, -37 at
  +6, -42 at +8. Below the falsifier's bar at every price; the door
  closes with its numbers.
* **Alternatives Considered:** (a) **Build the -13 as an addition on top
  of the gate.** It costs nothing on the tuning takes and nothing
  held-out, but it is a new deep-lane mechanism (a joint decode and an
  absorption) for 13 of 199 extras, and the falsifier the owner agreed
  measured it against the gate, not against zero. Offered to the owner
  instead of taken. (b) **Enumerate subsets (the brief's DP) instead of
  greedy best-first.** The greedy path's losses are real notes whose
  removal also improves regularity, which an exact search over the same
  cost finds too; the cost, not the search, is what separates poorly.
  (c) **Thirds in the grid** (triplet takes). The derivation set holds
  no triplet take and the held-out triplets would then set the grid.
* **Consequences:** Negative result: the phrase's own spacing carries
  less than the local-interval span the gate already reads (0.905 AUC
  in DECISION-030's measurement) once the gate has taken its share,
  and the real notes it drops first sit in the sixteenth sections,
  where a real note's interval jitters as much as a phantom's (read
  with `--detail`; abstaining under 200ms removes those losses and most
  of the gain with them).
  Ledger C1 closed. The amped column now needs door 3 (a learned
  classifier) or new material; the owner's rest-repick DI take is a
  transfer check, not a fix.

---
#### [DECISION-064]: The owner's third listening pass is applied to the labels, and the E5 amped labels become the DI set
* **Date:** 2026-09-23
* **Status:** Accepted
* **Owner:** The project owner (his answers to the label review list, 2026-09-23); applied by the agent on his word
* **Context:** The slow-note-splits loop paused on nine single label
  questions, the 33 grid-placeholder sixteenths on `eighths-a3-di`, and
  the one-performance-two-answer-keys disagreement on
  `eighths-sixteenths-e5` (192 DI against 190 amped, measured in
  `docs/SAME-PITCH-MATERIAL.md`). `fixtures/labels/**` is otherwise
  read-only; the owner's ear is the one source allowed to change it.
  He answered through a listening page that played a clip of each
  moment with the labels drawn on a plain envelope, and he moved labels
  by clicking where he heard the note start. Nothing in it consults
  Tuninator.
* **Decision:** Applied verbatim, each on the render he judged:
  `quarters-a3-e5-di` `e36` 35450 → 35490; `held-then-picked-di`
  `p1c1q1`–`p1c1q4` → 4036, 4533, 5039, 5523; `held-then-picked-amped`
  `p1c4q4` 17535 → 17478; held-out `lead-line-amped-sixteenths` `s46`
  8527 → 8555; `eighths-a3-di` `s166` → 20611, `s1614` → 21617,
  `s1697` → 32117 (no pick under 31980; re-sorted after `s1698`), and
  the other 30 placeholders confirmed on their grid times. The
  `eighths-sixteenths-e5-amped` file's 190 labels are replaced by the
  DI file's 192 events shifted +3ms (the renders align at +2.5ms), his
  choice of the recommended option. Confirmed unchanged: `t12`, `s7`,
  `s161`, and the mic triplet's `t5` as a separate stroke. Each
  neighbour's end follows the moved start. `retime-gridded-labels.ts`
  locks the 33 placeholders and carries his new times; its dry run
  reads 42/42 against his ear.
  Numbers, main → this change (the engine did not move): eval PASS with
  the same one informational failure; corpus split 237 / 276 / 13 →
  240 / 277 / 13 of 1592 → 1594 labels; slow subset 186 / 221 → 187 /
  220; ledger MISSED 139 → 140. Every difference is on the E5 amped
  take (whole take split 23 → 26, missed 13 → 14), which the
  2026-09-18 measurement predicted for this option. Every other edit
  moved no count, because each moved label was already matched within
  the 40ms tolerance or was already missed.
* **Alternatives Considered:** (a) **Propagate each move to the twin
  render** (the DI twin of `p1c4q4`, the amped twins of `e36` and
  `p1c1q*`, the DI twin of `s46`). The owner judged one render each,
  and on `held-then-picked` the audio does not keep the labels' uniform
  +15ms between renders. The twins are listed as follow-ups in
  `docs/SAME-PITCH-MATERIAL.md`. (b) **Re-time all of
  `held-then-picked-di` by the ~50ms his four moves share.** Measured
  against a 10ms envelope, that take's label-to-rise offsets run from
  -60 to +60ms stroke by stroke, so a single shift would be wrong. It
  needs a per-stroke pass. (c) **Delete `lead-line-di-sixteenths` `s6`.**
  He hears no new pick at 4.27s. The file is held-out and one of three
  renders of one performance, so it is left for his explicit word.
  (d) **Trim the E5 DI set to 190, or leave both.** He chose neither.
* **Consequences:** Positive: the E5 take is one performance with one
  answer key, the amped file loses its 35-60ms grid drift, and the A3
  sixteenth section is now fully human-reviewed. Negative: the E5 amped
  split count reads three worse, partly the instrument charging
  early-opening Notes once labels sit on the release. The twins moved
  here are no longer at their usual offsets. `s1697` and `s1698` run
  out of numeric order. `quarters-a3-e5-di` `e26`–`e40` were found
  sitting 30-52ms before the note sounds and are not yet moved.

---
#### [DECISION-063]: The split instrument charges a Note to the label it overlaps most, each bar widened by the matcher's 40ms
* **Date:** 2026-09-19
* **Status:** Accepted
* **Owner:** The project owner (the PR's decision 3, 2026-09-19); detection architecture carries it
* **Context:** `scripts/measure-splits.ts` charged a Note to the last
  label that had started when it did, reaching 40ms forward. On the
  direct-input same-pitch takes every Note in a passage opens early, so
  a boundary moved onto the right event moved the charge onto its
  neighbour and the column read flat or one worse with every touched
  boundary right (DECISION-049, DECISION-051, DECISION-054,
  DECISION-057). Put to the owner as the PR's decision 3 with three
  readings of DECISION-058's engine, nothing in the repository changed
  (`docs/DETECTION-FINDINGS.md`, "The split instrument's ownership rule,
  read three ways").
* **Decision:** The owner chose most overlap. `ownerIndexOf(labels,
  startedAt, endedAt)` charges a Note to the label whose bar, widened
  by `OWNERSHIP_LEEWAY_MS` (40, the matcher's own onset tolerance) at
  both ends, it overlaps most; a tie goes to the earlier bar; a Note
  overlapping no widened bar is a stray, and `ORPHAN_GAP_MS` is gone.
  `build-relabel-kit.ts` shares the rule. Leeway 0 and 40 count
  identically everywhere; at 80 the count starts to fall by neighbouring
  bars sharing a Note (amped and mic 144 → 142 on the tuning takes,
  held-out 30 → 28) rather than by any boundary reading better. On
  DECISION-058's engine, tuning takes: slow DI 20 → 8 of 327, amped and
  mic 148 → 144; held-out DI 4 → 4, amped and mic 30 → 30; corpus 273 /
  329 / 20 → 237 / 276 / 13. The baseline at `1c5e632` re-read: slow DI
  52 → 37 of 365, amped and mic 189 → 185; corpus 316 / 379 / 20 → 277 /
  323 / 13. So the seven kept iterations read DI 37 → 12 and amped and
  mic 185 → 174 under the instrument that can see them, against 52 → 24
  and 189 → 178 under the old one; the journal carries the baseline and
  each kept iteration re-read. Of 33 Notes starting between two labels,
  the old rule charged 25 to the next label, 6 as strays and 2 to the
  previous; nearest start charges all 33 to the next; most overlap
  charges 30 to the next, 2 as strays and 1 to a neighbour. Every
  number in journal entries before this date stands as read under the
  old rule and is not comparable to a later one without the re-read
  table; ledger rows C11 and C25 reopen on the new count.
* **Alternatives Considered:** (a) **Nearest label start** — the
  thread's first recommendation; reads DI 9 and amped 146 on the tuning
  takes, one and two worse than overlap, and charges a stray in a rest
  to the note after it. (b) **Leave the count and judge by the
  per-label trace** — the keep rule reads the count, so a rule the
  count cannot see cannot be kept. (c) **Broad leeway** (80ms) — merges
  neighbours, above. (d) **The overlap axis already printed as a second
  line** — it counts a Note against every bar it touches, so it
  brackets the truth from above and decides nothing.
* **Consequences:** Positive — a boundary moved onto the right event
  reads as one fewer split; the direct-input column on the tuning takes
  reads 8, and those are Notes that both fill one bar, not chain
  charges. Negative — two ledger rows need their falsifiers restated on
  the new count (C11's "below 30" is met by the instrument alone, so
  its bar is the current head's 8 at +0 missed); every earlier table is
  a historical reading; the two other scripts that keep their own copy
  of the old rule (`measure-articulation-stubs.ts`,
  `measure-rig-ceiling.ts`) still read the old way and say so in their
  headers, and were left alone because nothing in the loop reads them.

---

#### [DECISION-062]: The under-the-hand witness reads the level's fall alongside the pitch's absence, kept on the owner's decision
* **Date:** 2026-09-19
* **Status:** Accepted
* **Owner:** The project owner (the PR's decision 5, option 2, 2026-09-19); detection architecture carries it
* **Context:** DECISION-060 built `tracking.underHandLevelFall` and
  reverted it on the loop's letter: the tuning takes are bit-identical
  with it, so its constant is one only a held-out take can see, and
  DECISION-044's keep rule holds no change on a held-out gain. The trade
  it decides, mic label `t6` on the held-out triplet take, was put to
  the owner with three options (keep DECISION-058 and lose `t6`; turn
  `tracking.prefixUnderHand` off and keep the four ghost Notes; keep
  both halves outside the rule).
* **Decision:** The owner chose the third. Rebuilt as DECISION-060 had
  it: the tracker's voiced log carries each hop's RMS, `levelFallIn`
  reads the quietest hop over the loudest under the carved Note, and
  `underHand` requires both the unvoiced fraction at or over
  `tracking.underHandUnvoicedFraction` and the fall at or under
  `tracking.underHandLevelFall` (0.5; 1 is the pitch half alone). A
  third test in `region-reconcile.test.ts` holds the muted stretch at
  the note's own level and expects no absorption. Derivation
  bit-identical to DECISION-058's engine on every take (missed 112,
  false positives 200; slow DI 20 of 327 and amped and mic 148, as the
  journal reads them); held-out, read once, missed 28 → 27 with
  `t6` back and nothing else moved, false positives 67; ledger MISSED
  140 → 139; eval PASS with the same one informational failure as at
  baseline; 542 tests. Kept outside the keep rule on the owner's word,
  and logged as that: §6.5 and §6.6 of the loop's brief are unchanged,
  and this is the one constant in the engine set on a held-out reading.
* **Alternatives Considered:** (a) **Keep DECISION-058 alone and lose
  `t6`** (option 1) — the owner's to take; not taken. (b) **Turn
  `tracking.prefixUnderHand` off** (option 3) — the four ghost Notes
  return (two on the DI held-then-picked take, two on the held-out DI
  triplet take) and an amped duplicate with them. (c) **A derivation
  site for the level half** — none exists in the corpus (DECISION-060
  (c)); a tuning take carrying a sustained note the detector loses the
  pitch of between a note's end and a stroke would make this a loop
  iteration rather than an owner's exception.
* **Consequences:** Positive — the witness reads both halves of what
  "under the hand" means (no pitch, and the level fallen), which is the
  reading both sets agree with as far as either can say; the held-out
  mic label is matched again. Negative — the held-out set is no longer
  independent of this constant on the mic triplet take, so a later read
  of that take cannot count `t6` as evidence for a different rule; and
  the loop's report now carries one kept change its rule did not keep,
  marked as such here and in the journal.

---

#### [DECISION-061]: The slow-note-splits loop's tuning-only run pauses on the owner's decisions, with its last two ledger rows closed by their counts
* **Date:** 2026-09-19
* **Status:** Proposed
* **Owner:** Detection architecture; the project owner decides what reopens it (DECISION-044's loop, iteration 17)
* **Context:** After DECISION-060 the ledger held two rows the loop could
  still measure without the owner: C22 restated for nine late amped
  onsets (DECISION-056) and C13, a sharpness ceiling on the contact for
  DECISION-046's release rule (`docs/DETECTION-FINDINGS.md`, "Two rows
  read without a build, and where the loop stands").
* **Decision:** Both read without a build and both falsified by their
  counts. C22: lending every unannounced octave stub's start to its
  successor on the tuning takes moves the slow subset 168 → 170, extras
  255 → 259, missed and false positives unchanged, and the direct-input
  takes are not bit-identical; it is an onset rule for the amped column,
  not a same-pitch split rule. C13: of 54 release moves on the tuning
  takes, the contacts sharper than 6.6 are all direct-input moves of at
  most 14ms on the E5 eighths take (up to 10.5), and the amped and mic
  moves have no broadband transient at the contact, so no ceiling
  between 6.6 and 12 changes a derivation count and the constant is one
  only a held-out take can see (as DECISION-060). With C11 and C25
  blocked on the split instrument's forward reach (PR decision 3), C27
  on the owner accepting a held-out-only gain (PR decision 5), and the
  remaining rows with stated falsifiers being doors 1 and 3 (new
  mechanisms the owner's instruction on 2026-09-18 did not cover) and
  two rows outside the slow subset (C5, C6), the tuning-only run pauses.
  §9's exit rule has not fired by its letter; the journal carries the
  report §9 asks for at exit, so the owner reads the same page either
  way. Engine unchanged, bit-identical to DECISION-058's.
* **Alternatives Considered:** (a) **Building C22 or C13 anyway** —
  rejected: a count that already answers the falsifier makes the build a
  third consecutive revert. (b) **Starting door 1 or door 3** — not the
  owner's ask; put to him as what reopens the loop. (c) **Running C8 (the
  slow subset at 44.1kHz)** — the repository has no resampler
  (`decode-fixtures.ts` refuses any rate but 48kHz by design); left open.
* **Consequences:** Positive — every row the loop could measure alone
  has a measured verdict; the state is in one place for the owner.
  Negative — the direct-input column stops at 24 of 365 slow labels
  split (20 of 327 on the tuning takes) until the scorer decision lands;
  nothing on the amped column moves without a new mechanism.

---

#### [DECISION-060]: The under-the-hand witness does not read the level's fall alongside the pitch's absence
* **Date:** 2026-09-19
* **Status:** Rejected
* **Owner:** Detection architecture; DECISION-044's loop, iteration 16
* **Context:** DECISION-059 found the gate the wrong absolute for an
  amped render and named the level relative to the Note as the missing
  half of DECISION-058's witness: the three absorbed Notes on the tuning
  takes fall to 0.06–0.37 of their own peak, the mic triplet Note that
  cost `t6` holds at about 0.7 (`docs/DETECTION-FINDINGS.md`, "The
  under-the-hand witness as pitch and level together").
* **Decision:** Built as `tracking.underHandLevelFall` (0.5; 1 is the
  pitch alone), the quietest hop over the loudest under the carved Note.
  Derivation bit-identical to DECISION-058's engine on every take;
  held-out, read once, missed 28 → 27 with `t6` back and nothing else
  moved. Reverted on the keep rule's letter: the slow subset is better on
  no derivation path, since nothing on the tuning takes is refused by the
  level half, so the constant is one only a held-out take can see (§6.6
  of the loop's brief; the DECISION-046 precedent of guards not added
  because their edge was read on held-out events). Engine bit-identical
  to DECISION-058's.
* **Alternatives Considered:** (a) **Keeping it on the held-out gain** —
  rejected by the loop's rule; put to the owner as an option on the PR's
  decision 5, since the mechanism is right as far as either set can say
  and it is one constant. (b) **The RMS at the Note's end over its peak**
  instead of the quietest hop — not built: the same reading on every
  candidate in the derivation table. (c) **A derivation site for the
  level half** — none exists in the corpus: no tuning take carries a
  sustained note the detector loses the pitch of between a note's end
  and a stroke.
* **Consequences:** Positive — the witness's second half is built,
  tested and measured, with its reading on every candidate on record.
  Negative — the engine did not move; `t6` stays lost under
  DECISION-058 unless the owner keeps this outside the rule; the loop
  has now built and reverted two candidates in a row, the first with a
  new ledger row and this one without.

---

#### [DECISION-059]: The under-the-hand witness does not read the amplitude gate in place of the pitch detector
* **Date:** 2026-09-19
* **Status:** Rejected
* **Owner:** Detection architecture; DECISION-044's loop, iteration 15
* **Context:** DECISION-058's witness, a carved Note with no pitch on
  half its hops, absorbed a sustained note on the held-out mic triplet
  take whose pitch the detector had lost while its level held, and cost
  `t6`; ledger row C26 named the level as the missing half
  (`docs/DETECTION-FINDINGS.md`, "The under-the-hand witness read on the
  gate").
* **Decision:** Built as `tracking.underHandReadsGate` — hops under
  `analysis.rmsGate` counted in place of hops without a pitch — after the
  tuning takes showed the gate separating the two direct-input Notes
  under the hand (0.62, 0.50) from the twenty-one real notes under the
  same decline (at most 0.33), and reading 0 on the amped duplicate
  DECISION-058 had absorbed, whose level stopped five times above the
  gate. Derivation: slow DI 20 → 20, amped and mic 148 → 149, false
  positives 200 → 201, missed unchanged, the one change being that
  duplicate kept. Held-out, read once: missed 28 → 27, `t6` back, nothing
  else moved. Reverted on the keep rule's letter (the amped path worse);
  engine bit-identical to DECISION-058's.
* **Alternatives Considered:** (a) **Keeping it for the held-out label**
  — rejected: the loop's rule reads the derivation set, and a rule that
  loses on it is not kept for a gain elsewhere. (b) **A gate relative to
  the render's floor** — not built: it is the same reading as the level's
  fall relative to the Note (c), with an extra estimate. (c) **The pitch's
  absence and the level's fall read together** — the three absorbed Notes
  fall to 0.06–0.37 of their own peak and the mic Note holds at about
  0.7; not built this iteration (a built-and-reverted candidate ends it),
  recorded as ledger row C27 with its derivation on the tuning takes.
* **Consequences:** Positive — the gate's reading of every candidate is
  on record, and the witness's two halves are now named with their
  numbers. Negative — the engine did not move and `t6` stays lost until
  C27 is built.

---

#### [DECISION-058]: A carved Note the fast lane heard no pitch on is the string under the hand, and the next stroke's preparation
* **Date:** 2026-09-18
* **Status:** Proposed
* **Owner:** Detection architecture; the ship decision is the project owner's (DECISION-044's loop, iteration 14)
* **Context:** DECISION-055 left a row (C23) for two 91–94ms Notes of no
  pitch the rise rule produced on the held-out DI triplet take, between a
  note's end and the next stroke's release, which the shipped engine had
  absorbed as contact stubs; its sites being held-out, the row read on the
  tuning takes first (`docs/DETECTION-FINDINGS.md`, "The string under the
  hand as the next stroke's preparation").
* **Decision:** The count found no prefix declined `unpitched` on the
  tuning takes, so the row as written was falsified cheaply; the shape it
  named stands twice there, on the held-then-picked DI take, declined
  `region-attack` because the region's attack branch had put its boundary
  on the pick's contact and `offerPrefix` reads any attack boundary as a
  stroke. What separates those two from the twenty-one real notes under
  the same decline is the fast lane's own hops: no pitch on 0.57 and 0.83
  of them against 0 to 0.33. Built as `tracking.prefixUnderHand` (true)
  with `tracking.underHandUnvoicedFraction` 0.5, bit-identical to
  DECISION-055's engine when off: a carved Note over the bar is offered
  past the attack boundary, the transient at its start counts as a stroke
  only when its rise cleared `tracking.releaseRiseRatio`, and it is
  claimed whatever pitch it read. Derivation: slow DI 21 → 20 of 327,
  amped and mic 149 → 148, split 206 → 204, extras 257 → 255, missed 112
  → 112, false positives 203 → 200; corpus 277 / 333 / 20 → 273 / 329 /
  20; ledger MISSED 139 → 140; eval PASS; 541 tests. Held-out, read once:
  the two triplet Notes absorbed as predicted (false positives 69 → 67,
  split 71 → 69), and one label lost on the mic triplet take, `t6`, whose
  neighbour's Note read no pitch on nine of twelve hops while its level
  held at 0.02–0.04 RMS — the mic's sustain, not the hand — and was
  absorbed. `docs/EVALUATION.md` refreshed from the report.
* **Alternatives Considered:** (a) **The transient's rise as the witness**
  (offer past a non-rising attack boundary) — rejected on the count: real
  notes open on band-only and contact transients too, nine of the
  twenty-one. (b) **The offer lifted for every attack boundary** —
  rejected: the twenty-one real notes would be offered and claimed at
  their own pitch class. (c) **The level's fall alongside the pitch's
  absence**, which would have kept the mic Note — not built this
  iteration: its motivating site is held-out, and the tuning takes carry
  the evidence to derive it (the two under the hand sit under the gate on
  half their hops; the amped one falls to 6% of its peak). Ledger C26.
  (d) **A higher unvoiced bar** — rejected: the mic Note reads 0.73, above
  the held-out DI sites' 0.71, so no bar separates them.
* **Consequences:** Positive — the two direct-input Notes of muted string
  gone from the tuning takes and the two from the held-out triplet take,
  one amped duplicate gone, no label lost on derivation; the first row
  derived from a count of the tracker's own declines. Negative — one
  held-out mic label lost to a witness that cannot tell a lost pitch from
  a damped string, the owner's to weigh; the witness's second half (C26)
  is the next iteration's.

---

#### [DECISION-057]: The attack branch of the segmenter does not move its boundary to the transient that rose inside the window
* **Date:** 2026-09-18
* **Status:** Rejected
* **Owner:** Detection architecture; DECISION-044's loop, iteration 13
* **Context:** DECISION-056 found `a15`'s boundary to be the attack
  branch's, placed on the band-only onset at the mute because
  `attackSamples` carries band-only onsets, and named the rule it needs:
  DECISION-055's envelope-branch rule applied in the attack branch
  (`docs/DETECTION-FINDINGS.md`, "The attack branch on the transient that
  rose").
* **Decision:** Built as `deep.segmentAttackOnRisingTransient` and
  reverted. The count first: 648 attack-branch windows on the derivation
  takes, 335 on a band-only onset, 163 of those with a rising broadband
  transient inside the window, 41 more on a contact with one; `a15`'s
  window not among them, its release at 1.997 under the bar on the
  one-hop reading, so the falsifier became the column. On derivation: slow
  DI 21 → 22 of 327, amped and mic 149 → 148, false positives 203 → 201,
  missed, split and extras unchanged; two takes changed. On the
  held-then-picked DI take two boundaries moved onto their releases (80ms
  and 107ms early → 27ms) and one 94ms false positive on a contact is
  gone, and the count reads one worse because the next Note's refused
  contact (C11, 88ms early) now ends a right Note short — the split
  instrument's chain reading, a fourth time. Reverted on the keep rule's
  letter; held-out not read; engine bit-identical to DECISION-055's.
* **Alternatives Considered:** (a) **Keeping it on the mechanism's
  reading** — rejected: the loop's rule is the score on the slow subset,
  worse on no path, and the rule is not loosened to keep a candidate. (b)
  **Changing the split instrument's forward reach first** — the owner's
  call (DECISION-054, PR decision 3); not made. (c) **A lower bar for the
  attack branch's transient** — rejected, as for DECISION-053 and -056.
* **Consequences:** Positive — the rule is built, tested and recorded, and
  reads right at every site it moved; the count of attack-branch
  boundaries on the mute is on record (163 with a release in reach).
  Negative — the engine did not move; the direct-input column now has no
  open ledger row that is not blocked on the owner's instrument decision.

---

#### [DECISION-056]: A transient's rise is not read over two hops for the region lane, and the octave stub is not made to lend its start
* **Date:** 2026-09-18
* **Status:** Rejected
* **Owner:** Detection architecture; DECISION-044's loop, iteration 12
* **Context:** DECISION-055 left two rows: `s161` on the A3 eighths DI
  take, credited before by a carve that wholly overlapped a Note the pitch
  tracker opened 42ms late after an octave misread of its first two hops
  (C22); and `a15` on the quarters DI take, whose release transient read
  0.91 on its hop, 1.997 on the next and 2.05 on the one after, against
  the release bar of 2 (C24) (`docs/DETECTION-FINDINGS.md`, "The octave
  stub read and the rise read two hops out").
* **Decision:** C22 falsified on the bench without a build: of 101 such
  stubs on the tuning takes, 82 read the successor's pitch or its octave,
  but on the direct-input takes the stubs are 0–13ms and the successors on
  time, and `s161` cannot be regained by lending a start because the fast
  lane opened one Note for two picks there and the miss only moves to
  `s162`; the nine successors it would bring within 40ms of their labels
  are all on amped takes. C24 built as `deep.transientRiseHops` (2; 1 as
  DECISION-055) and reverted: at 2 and 3 hops the quarters DI take is
  bit-identical — the deep lane read the transient at 2.053 and the
  boundary stayed at 8960ms because it is the shipped ATTACK branch's,
  placed on the band-only onset at the mute, which DECISION-055's
  envelope-branch rule never sees — and the clean-lead take loses `t17`
  (missed 112 → 113), because a longer reading also lets the transient
  before the release outrank it. Held-out not read. Engine bit-identical
  to DECISION-055's.
* **Alternatives Considered:** (a) **The attack branch placing its
  boundary on the broadband rising transient inside the window when the
  transient it read is band-only** — the rule `a15` actually needs; not
  built this iteration, ledger C25 with the falsifier stated. (b) **A rise
  reading bounded by the next transient rather than a hop count** — not
  built; C25 makes it moot for the direct input. (c) **Lending the stub's
  start on amped takes** — a row for the amped column's onset error (C22
  restated), not this loop's next step.
* **Consequences:** Positive — three iterations' wrong premise about
  `a15` corrected by the deep lane's own reading, and the rule it needs
  named with its reproduction; the octave-stub count taken once and
  recorded. Negative — the engine did not move; `a14` stays charged.

---

#### [DECISION-055]: The region lane's envelope boundary is placed on the transient that rose, with the rise read on its hop or the next, and a carve sees every Note the tracker holds
* **Date:** 2026-09-18
* **Status:** Proposed
* **Owner:** Detection architecture; the ship decision is the project owner's (DECISION-044's loop, iteration 11)
* **Context:** DECISION-054 placed an envelope-rise boundary on the first
  broadband transient inside the window that noticed the rise whose rise
  clears `tracking.releaseRiseRatio`, and reverted it: the rise witness
  reads the long window, which lags the flux by one hop, so three of the
  four sites read the rise of the hop before their transient and did not
  move, and one moved boundary coincided with a fast-lane Note's start and
  was carved beside it as a duplicate (`docs/DETECTION-FINDINGS.md`, "The
  region lane's boundary on the transient that rose, read one hop late,
  and a carve that sees every Note").
* **Decision:** Two rules, each behind its own constant, each bit-identical
  to DECISION-052's engine when off. `deep.segmentRiseOnRisingTransient`
  (true): DECISION-054's rule with each transient's rise read as the larger
  of its own hop's and the next hop's (`NoteTracker.pendingRise`). Alone
  on derivation: slow DI split 27 → 24 of 327, missed 114 → 110, false
  positives 210 → 210, extras 268 → 266, amped and mic bit-identical; `a2`,
  `a4`, `e825`, `e836` onto their releases, `a15` unmoved at a rise of
  1.997 against the bar of 2. `deep.regionCarveSeesEveryNote` (true):
  `carveAfter` scans every Note the tracker holds, not only the region's
  candidates and the open Notes, and carves nothing where a Note already
  begins within a hop; the duplicate's cause was a Note that began inside
  the region and ended past its edge, out of the scan's sight. Alone on
  derivation: false positives 210 → 203 and split 216 → 209, seven Notes
  each beginning within a hop of another, on four takes, three of them
  amped; missed 114 → 115 (`s161`, credited before by a carve wholly
  overlapping a Note that opened 42ms late on an octave misread). Together:
  slow DI 27 → 21, amped and mic 152 → 149, split 216 → 206, extras 268 →
  257, missed 114 → 112, false positives 210 → 203; corpus 286 / 343 / 19
  → 277 / 333 / 20; ledger MISSED 141 → 139; eval PASS. Held-out, read
  once: missed 27 → 27, false positives 66 → 69, split 70 → 71, extras 75
  → 76 — two 91–94ms unpitched Notes on the DI triplet take that the
  shipped engine absorbed as contact stubs, one Note in the mic
  power-chord take's tail, one label lost on the amped sixteenths take
  whose credit was a wrong-pitch carve, one label regained on the DI
  sixteenths take. `docs/EVALUATION.md` refreshed from the report.
* **Alternatives Considered:** (a) **A lower rise bar for the transient's
  own hop** — rejected: reads the contact before the lagged rise
  (DECISION-053). (b) **The carve rule gated under the rise key** —
  rejected: the carve's blindness predates the loop and the seven
  duplicates it removes are on the shipped path; a rule that changes the
  shipped path gets its own constant. (c) **Merging the carved segment into
  the coinciding Note by moving that Note's start** — not built: the one
  label the carve rule costs (`s161`) wants the stub's start lent to the
  Note the pitch change opened, which is a tracker rule (ledger C22), not a
  carve rule. (d) **The rise read over the two hops after the transient**,
  for `a15` — not built this iteration (ledger C24). (e) **Offering a
  carved prefix of no pitch as the successor's contact stub**, for the
  triplet take's two new Notes — not built; its sites are held-out, so the
  row (C23) reads on the tuning takes first.
* **Consequences:** Positive — six direct-input boundaries on the release
  where they were in the mute; seven duplicate Notes gone, three of them
  on amped takes, the first amped gain since DECISION-048; missed down on
  derivation with the amped and mic slow subset better. Negative — three
  more false positives and one label traded for one on held-out, the
  owner's to weigh; `a15` still charged; the split scorer's chain reading
  (DECISION-054's owner-side item) still hides one right boundary behind
  `a4`.

---

#### [DECISION-054]: The region lane's envelope boundary is not placed on the transient whose own hop rose over the muted string
* **Date:** 2026-09-18
* **Status:** Rejected
* **Owner:** Detection architecture; DECISION-044's loop, iteration 10
* **Context:** DECISION-053 placed an envelope-rise boundary on the first
  transient inside the window that noticed the rise and read the mute as
  often as the release, because the transient list carried band-only
  onsets and no rise. This iteration gave the list each transient's
  witness and rise (`RegionTransient`, carried tracker → engine → deep
  lane) and placed the boundary on the first broadband transient whose
  rise clears `tracking.releaseRiseRatio`
  (`docs/DETECTION-FINDINGS.md`, "The region lane's boundary on the
  transient that rose").
* **Decision:** Built as `deep.segmentRiseOnRisingTransient` and reverted.
  On derivation: slow DI split 27 → 27 of 327, split 216 → 217, extras
  268 → 269, missed 114 → 111, false positives 210 → 210, the amped and
  mic takes bit-identical; DECISION-053's ten extras absent. `a4` and
  `e836` moved onto their releases (23ms from their labels) and the split
  charge moved along the chain to `a4` and `e855`, so the column did not
  fall. `a2`, `a15` and `e825` did not move: the long-window rise lags the
  flux by one hop, so the hop carrying the transient reads 1.03, 0.91 and
  1.68 and the next hop 2.67, 2.00 and 4.35. The one extra is a duplicate:
  a moved boundary at 32293.33ms on the A3 eighths DI take coincides with
  a fast-lane Note's start and `splitAtSegments` carves beside it. Held-out
  not read. The types, the list and the tests went with the revert.
* **Alternatives Considered:** (a) **The rise read on the transient's hop
  or the next** — not built this iteration; ledger C20, with the three
  unmoved sites as its reproduction. (b) **Merging a carved segment whose
  start coincides with an existing Note's** — not built; ledger C21, with
  the A3 duplicate at 32293ms. (c) **A lower bar for the transient's own
  hop** — rejected: a bar under the release bar reads the contact
  (DECISION-053's stubs) before it reads the lagged rise. (d) **Changing
  the split instrument's 40ms forward reach** so a right boundary reads as
  one fewer split whatever its neighbour does — not the loop's to decide;
  put to the owner.
* **Consequences:** Positive — the transient list's defects are corrected
  in a form the next build can reuse (witness and rise on every transient);
  the one-hop lag between the flux witness and the rise witness is named
  with three sites; the reconciliation gap for a boundary that coincides
  with an existing Note is named with one; two of the four region-lane
  boundaries are shown to land on the release when the rule reaches them.
  Negative — the engine did not move; the four labels stay charged; and the
  count's chain reading now hides right boundaries on three of the last
  six iterations.

---

#### [DECISION-053]: The region lane's envelope boundary is not placed on the first transient inside the window that noticed the rise
* **Date:** 2026-09-18
* **Status:** Rejected
* **Owner:** Detection architecture; DECISION-044's loop, iteration 9
* **Context:** Four of the 27 slow direct-input splits left after
  DECISION-052 are region-lane Notes starting 55–63ms before their labels
  (`a2`, `a4`, `a15` on the quarters DI take, `e825` on the A3 eighths DI
  take). `resegment.ts` places an envelope-rise boundary at the START of
  the first 85ms window whose RMS clears `segmentRiseRatio`, the earliest
  defensible estimate; on a same-pitch stroke that window begins in the
  mute between the pick landing and letting go, and the fast lane's
  transient at the release sits inside it, unread, because the envelope
  branch is tested before the `attack` branch and the `attack` branch
  reads only the hop before the window's start
  (`docs/DETECTION-FINDINGS.md`, "The region lane's envelope boundary sits
  at the start of the window that noticed the rise").
* **Decision:** Built as `deep.segmentRiseOnTransient` — the envelope
  boundary moves to the first transient the fast lane recorded inside the
  window, kind `attack` — and reverted. On derivation: slow DI split
  27 → 34 of 327, split 216 → 224, extras 268 → 276, false positives
  210 → 220, missed 114 → 109, the amped and mic takes bit-identical.
  `a4` moved as designed (3427 → 3466.67ms, 23ms from its label) and five
  labels came back, three of them sixteenths in the E5 take's runs; ten
  Notes appeared that match nothing, four of 93–96ms and six of 227–386ms.
  The list the region lane reads (`NoteTracker.attackSamples`) records
  every hop on which energy arrived, band-only onsets included and with no
  rise attached, and on a direct-input same-pitch stroke the band witness
  fires at the mute's onset and the burst's first broadband attack is often
  the contact; so the first transient in a window that begins in the mute
  is the mute or the contact as often as the release, and a boundary there
  leaves `minSegmentMs` of muted string as a Note. Held-out not read. The
  key and its tests went with the revert.
* **Alternatives Considered:** (a) **The last transient in the window** —
  rejected without a build: over a sixteenth run at 120ms a stroke, an
  85ms window can hold the next stroke's contact, which is what the six
  longer extras look like. (b) **Testing the `attack` branch before the
  envelope branch** — rejected: it reads only the hop before the window's
  start, so it reaches none of the four sites, and reordering changes
  every boundary the two branches already agree on. (c) **The transient
  carrying its rise, and the boundary on the first broadband transient
  whose rise clears `tracking.releaseRiseRatio`** — not built this
  iteration (one mechanism per iteration); ledger row C19, with this
  iteration's ten extras named as its falsifier. (d) **A shorter region
  window** — rejected: the window is `harmony.fftSize`, and the deep lane's
  pitch reading is denominated in it.
* **Consequences:** Positive — the region-lane placement of same-pitch
  boundaries is named as a shape with four derivation labels in it, its
  cause located to one line of `resegment.ts`, and the transient list's
  two defects for this purpose (band-only onsets, no rise) stated; the E5
  sixteenth runs are shown to respond to transient-placed boundaries.
  Negative — the four labels stay charged; the engine did not move; and
  the list the deep lane reads still cannot tell a mute from a release.

---

#### [DECISION-052]: The release test reads a Note the fine witness opened on the frame that opens it, and the move keeps the announce clock on the contact
* **Date:** 2026-09-18
* **Status:** Proposed
* **Owner:** Detection architecture; the ship decision is the project owner's (DECISION-044's loop, iteration 8)
* **Context:** DECISION-051 read the path and reverted it: the fine
  witness delivers a contact 65ms late, so it can arrive on the release's
  own hop in a Note born settled, and DECISION-050's `!settled` refused the
  release; reading it there moved two direct-input boundaries right and
  dropped one stroke, `e36` on the quarters DI take, whose release
  re-excited the string only to the gate's level — 75ms on its announce
  clock born at the contact, 13.33ms started at the release. The move
  re-decided the Note because `announceSoundedMs` reads from the moved
  `startTime`.
* **Decision:** `tracking.releaseOnFineOpenedFrame` (true; false is
  DECISION-050 as shipped). The gated release test in step (a) also reads
  a settled, unannounced Note the fine witness opened — in practice on the
  frame that opens it, since `isRelease` keeps `!announced` — and when it
  moves such a Note it sets `releasedFromContact` on the record, for which
  `announceSoundedMs` reads from `ownStartTime`, as it already does for a
  Note that absorbed a step-shed stub. The witness that opened the Note
  decided a stroke began; the release places its boundary and does not
  re-decide it. Result on derivation: slow DI split 29 → 27 of 327
  (`e817`, `e35`), split 218 → 216, extras 270 → 268, missed 114 → 114,
  false positives 211 → 210 (the phantom the release's own fine onset
  opened on `e35`), the amped and mic takes bit-identical; four Notes
  moved on their birth frame, one of them (`e36`'s) newly announced and
  matched, none a false positive; corpus 288 / 345 / 19 → 286 / 343 / 19;
  held-out, read once: identical on every take. Eval PASS; 534 tests.
* **Alternatives Considered:** (a) **Counting the contact-to-release
  stretch toward `soundedMs` as well** — rejected: `soundedMs` feeds
  `settled` and the ring-out clock (C15), and the Note is announced at the
  end of its birth frame either way, so widening the change buys nothing
  and touches the coupling DECISION-049 named. (b) **Keeping the clock for
  the unsettled release paths too** (DECISION-046, DECISION-050) —
  rejected: an attack-opened contact Note has not been decided by anyone
  yet; earning its 55ms after the move is what those rules shipped, and
  nothing on derivation asks for more. (c) **Reading the gated release on
  any settled unannounced Note, not only a fine-opened one** (iteration 7's
  build) — rejected as the looser statement: every case reached on
  derivation is fine-opened, and the announce-clock argument only holds
  for a Note a witness opened. (d) **Editing `e36`'s label onto the
  release** — not this loop's to do, and it would not have rescued
  iteration 7's build: the Note still had 13ms on its clock.
* **Consequences:** Positive — the release test now reaches every
  contact-opened Note whose release arrives inside the window, on any hop,
  fine-opened or not; two more direct-input boundaries on the release and
  one phantom fewer at no cost on either set; the record's two starts
  (`ownStartTime`, `startTime`) now carry a stated meaning for a forward
  move as well as a backward one. Negative — one more flag on
  `NoteRecord`; a Note this path moves reports a start up to 80ms after the
  contact a listener may have labelled (`e36`, on the owner's list); and
  `soundedMs` and `announceSoundedMs` now disagree for such a Note by the
  contact-to-release stretch, which the ring-out clock reads as DECISION-049
  described.

---

#### [DECISION-051]: The release test does not read a Note the fine witness opened on the frame that opens it
* **Date:** 2026-09-18
* **Status:** Rejected
* **Owner:** Detection architecture; DECISION-044's loop, iteration 7
* **Context:** DECISION-050 (d) deferred `e818`'s case on the E5 eighths
  DI take — a Note the fine witness opened on a contact, with a gated
  release 77ms later — to the announce bar, ledger row C16. Re-read on the
  trace (`docs/DETECTION-FINDINGS.md`, "The release test reaches a Note
  the fine witness opened only on the frame that opens it"), the announce
  bar is not what refused it: the fine witness confirms 65ms after the
  onset, so the contact was delivered on the same hop as the release, and
  `handleFineOnset` opens the successor with `lastAudibleAt` on that frame.
  At step (a) of that frame the Note is settled (77ms on its clock, over
  `minStableMs`) and not yet announced (`publish` runs at the frame's
  end); DECISION-050's `!settled` requirement refused the release, and a
  higher announce bar would have changed nothing. In the same iteration,
  ledger row C15 (the ring-out clock reads from the moved start) was read
  on the four derivation DI takes without a build: 47 moved starts, 23
  transients in the reopened window, 2 changed verdicts, both contacts
  accepted `sharpness` in place of a ring-out refusal and then moved onto
  their release by DECISION-046's unsettled path (`e817`, `e853`), and no
  phantom. Nothing for an anchored clock to fix on derivation; closed.
* **Decision:** Built as `tracking.releaseOnGatedHopSettled` — the gated
  path of DECISION-050 read with `(!settled || releaseOnGatedHopSettled)`,
  `isRelease`'s `!announced` guard unchanged, so it reaches a fine-opened
  Note only on its birth frame — and reverted. On derivation: slow DI
  split 29 → 27 of 327 (`e817` and `e35` cleared), split 218 → 216,
  extras 270 → 268, false positives 211 → 210, amped and mic takes
  bit-identical, and missed 114 → 115. The lost label is `e36` on the
  quarters DI take: a stroke whose contact muted the string to 0.0019 RMS
  and whose release re-excited it to 0.008, the gate's own level, so the
  fast lane heard one voiced hop of a note that sounds through its whole
  label. Born at the contact the Note had 75ms on its clock and was
  announced; started at the release it had 13.33ms and was dropped
  unannounced. The move re-decides whether the Note exists, because the
  announce clock reads from the moved start — a mechanism, present on
  every stroke this path reaches. The keep rule (missed not up) fails;
  `src/` is DECISION-050's, bit-identical; held-out not read. The key and
  its frame-driven test went with the revert.
* **Alternatives Considered:** (a) **The announce bar for a fine-opened
  contact, as C16 was written** — rejected by the read: the announce comes
  after step (a) on the same frame, so no bar reaches the release test.
  (b) **Deferring the move until the next hop is voiced** — rejected: on
  `e36` the next hop is the only voiced one and the Note still dies, and
  the fast lane would act a hop late on every other stroke. (c) **Refusing
  the move when the Note would not be announced** — rejected: the fast lane
  is causal and does not know at the frame what the next hops carry.
  (d) **Keeping the announce clock on the contact when the gated release
  moves a fine-opened Note** — not built this iteration (one mechanism per
  iteration); it is ledger row C17, with the count of Notes it would
  announce that otherwise die unannounced as its falsifier.
* **Consequences:** Positive — C15 closed without a build; C16's premise
  corrected on the trace; the one mechanism that can lose a label on this
  path named exactly, with `e36`'s frames as the reproduction; `e35`'s
  split identified as the release's own fine onset splitting a Note that
  still started at the contact. Negative — `e817` and `e35` stay charged
  (slow DI 29 on the tuning takes); the engine did not move this
  iteration; `e36`'s label sits on its contact where the other probed same-pitch
  direct-input labels sit on the release, noted for the owner's listening
  list and not edited.

---

#### [DECISION-050]: The release test reads the hop the amplitude gate refuses, and measures its window in samples
* **Date:** 2026-09-18
* **Status:** Proposed
* **Owner:** Detection architecture; the ship decision is the project owner's (DECISION-044's loop, iteration 6)
* **Context:** DECISION-046 moves a contact-opened Note's start to the
  first attack inside one articulation window whose rise clears
  `tracking.releaseRiseRatio`. Read on the trace at the current engine
  (`docs/DETECTION-FINDINGS.md`, "The release can land on a hop the
  amplitude gate refuses"), two of the remaining slow direct-input splits
  are that release refused before the test ran: on `e851` of the E5
  eighths DI take the release is six hops after the contact, which is 80ms
  in exact arithmetic and 80.0000000000018 in doubles, so
  `> articulationMs` put it outside the window; on `e815` the release's
  hop reads under the gate (the string under the pick is very quiet on a
  direct input, and the transient detector's window leads the gate's), so
  `rearticulation.ts` returned `gated` and the tracker never asked whether
  it was the release.
* **Decision:** `tracking.releaseOnGatedHop` (true; false is
  DECISION-046's test as shipped). When the verdict is `gated`, the Note
  is unsettled and `isRelease` holds — contact-opened, unannounced, inside
  the window, rise over the bar — the start moves to the attack, traced
  `released` via `gated`. Nothing opens on the gated hop: the gate exists
  to stop the fast lane opening a Note on room tone, and this reads a
  ratio over the muted string in a Note that is already open and not yet
  announced. And `isRelease` measures its window in samples,
  `clock.durationSamples(articulationMs)` against the attack's and the
  Note's sample positions, so the six-hop release is inside. Result on
  derivation: slow DI split 30 → 29 of 327, split 219 → 218, extras
  271 → 270, missed 114 → 114, false positives 211 → 211, the amped and
  mic takes bit-identical; corpus 289 / 346 / 19 → 288 / 345 / 19; held
  out, read once: identical on every take. Both labels the falsifier
  named fell; the count is 29 rather than 28 because `e817`'s neighbour,
  a fine-opened contact announced at 55ms before its own gated release
  arrived at 77ms, is now charged to `e817` once `e817`'s own boundary is
  right (three boundaries moved to within 10ms, one label's charge moved
  along the chain). Eval PASS; 530 tests.
* **Alternatives Considered:** (a) **Lowering the gate on direct input**
  — rejected by ledger row C7 (DECISION-045's iteration): at the gates
  GOATerizer can pass, the held-then-picked DI take's gated misses become
  splits, 8 → 45. (b) **A tolerance in milliseconds on the window** —
  rejected: the times are hop-quantised, so the comparison belongs in
  samples, where it is exact; a tolerance would paper over the same
  defect wherever else `articulationMs` is compared in milliseconds (the
  burst `continues` test, the fragment length test), which are left as
  they are and noted. (c) **Deferring the gated release to the next
  ungated hop** so the fast lane literally never acts on a gated hop —
  rejected as the same move with a hop of latency and one more piece of
  state; the invariant is about opening Notes on room tone, and the start
  of an unannounced Note moving is not that. (d) **Reading the gated
  release on a settled or announced Note** — rejected: an announced start
  is the consumer's, and `e818`'s case (announced at 55ms, release at
  77ms) is an announce-bar question, ledger C16, not a release-test one.
* **Consequences:** Positive — the release test now reaches every
  contact-opened, unannounced Note whose release arrives inside the
  window, gated or not, and the window is exact; two more direct-input
  boundaries sit on the release; the fine-opened contact's announce bar
  is named as the next mechanism on this shape. Negative — one more
  reading of the fast lane on a gated hop, confined to moving an
  unannounced start; the split count credits the rule by one where it
  moved three boundaries, for the chain reason DECISION-049 named; and
  `e839` (release 91ms after the contact) stays outside a window that is
  `transient.articulationMs` by reuse rather than by measurement.

---

#### [DECISION-049]: The refused-contact burst rule is NOT shipped on the corrected pace estimate either — the estimator now holds, and the score cannot see the moves through the split instrument's chain reading and a ring-out clock that runs from the moved start
* **Date:** 2026-09-18
* **Status:** Rejected (built, measured, reverted — DECISION-044's loop, iteration 5; second build of DECISION-047's rule)
* **Owner:** Detection architecture
* **Context:** DECISION-047 reverted the rule because one 67ms boundary
  move tipped the pace estimate 227 → 160ms and announced two 80ms stubs.
  DECISION-048 struck retracted openings from that estimate and left the
  rule to be re-run. `docs/DETECTION-FINDINGS.md`, "The refused-contact
  burst rule, re-run on the corrected pace estimate".
* **Decision:** Not shipped. DECISION-047's build, character for character
  (`tracking.burstContactRiseRatio` at the split's backdate site in step
  (a)), measured at 1.2 only — iteration 3's sweep was flat from 1.0 to
  1.3 — and reverted to bit-identical. Derivation: slow DI split 30 → 30 of
  327 (quarters 8 → 7, E5 9 → 8, held-then-picked 8 → 10), missed
  114 → 116, false positives 211 → 211, extras 271 → 271, the cowboy chord
  take one phantom better; held-out, read once: split 70 → 69, false
  positives 66 → 64, missed 27 → 27. Against the same falsifier as
  iteration 3 ("down by at least 6 of the 9, neither up, chord takes
  bit-identical") the first line fails, the second fails on the same two
  overlap credits as before (`e843`, `p2c3q4`), the third on the letter.
  The estimator held: the E5 take's two DECISION-047 false positives do not
  return (stubs' bars 133 and 140ms). Two other things stand between the
  moves and the score. (1) `measure-splits.ts` charges a Note 67ms early to
  the label before it, so on the held-then-picked DI take, where every
  re-pick opens early, a label reads split when two early Notes meet; the
  rule fixes the refused-contact positions in that chain and the charge
  moves to the six neighbours whose own boundary is a shape the rule does
  not reach (C12), 8 → 10 with every moved boundary right. (2) The ring-out
  branch of `rearticulation.ts` is reached at `soundedMs >= ringOutMs`
  (250), and `soundedMs` runs from the Note's start: on `p1c2q3` a transient
  at 9213ms that reached the ring-out branch at 280ms of age (refused
  `ring-out-not-sharp`) reaches the rolling-baseline test at 213ms once the
  start is on the release, and is accepted as a third Note. Every boundary
  moved 67ms later delays the ring-out branch by 67ms; DECISION-046's moves
  do the same and were not read for it.
* **Alternatives Considered:** (a) **Keeping it, since the moves are right
  and the score's failure is the instrument's** — rejected: the third Note
  on `p1c2q3` is a real phantom the move created, not an instrument
  artefact, and the loop's bar is the score. (b) **Rewriting the split
  instrument to charge chains fairly** — rejected here: the count is not
  wrong (the consumer does see two Notes in that span); the falsifier was
  wrong to expect it to move before the neighbouring shape is fixed. (c)
  **Anchoring the ring-out clock to the burst's first attack in the same
  iteration** — rejected: a second mechanism in one iteration, with its own
  falsifier (ledger C15), and it applies to DECISION-046's moves first.
  (d) **A third build of this rule after C12 and C15** — the record's
  position: not the next mechanism, the one that reads clean once those
  two have; re-running it a third time before then answers nothing new.
* **Consequences:** Positive — the pace estimator is confirmed fixed for
  the case it was fixed for; the split instrument's chain reading is
  named, so the held-then-picked count is now read as "chain positions
  still wrong" rather than as a verdict on any one rule; and the ring-out
  clock's dependence on the Note's start is a measured coupling with a
  reproduction (held-then-picked DI, 9213ms, `soundedMs` 280 → 213) that
  any boundary-moving rule, DECISION-046 included, must answer. Negative —
  the engine is unchanged for a second iteration on this shape; the
  held-then-picked DI passage still starts its refused-contact re-picks on
  the pick's landing.

---


#### [DECISION-048]: The local-rate estimate strikes out an opening once its Note is absorbed or dropped unannounced
* **Date:** 2026-09-18
* **Status:** Proposed
* **Owner:** Detection architecture; the ship decision is the project owner's (DECISION-044's loop, iteration 4)
* **Context:** DECISION-030's estimator, `localIoiMs`, is the median of the
  last eight gaps between Note openings, every opening counted, on the
  argument that a phantom can only shorten a gap and a short reading is the
  safe direction. Read on the E5 eighths DI take
  (`docs/DETECTION-FINDINGS.md`, "The pace estimate reads the openings that
  never became Notes"), half the gaps in the window are pieces of a 250ms
  eighth cut by an opening that was later absorbed or dropped — contact
  stubs, fragments the rate gate held back — and the median sits on a cliff
  between the pieces and the wholes; DECISION-047 showed one 67ms boundary
  move tipping it 227 → 160ms and two 80ms stubs clearing the bar that fell
  with it. Across the derivation takes the estimate reads 0.85 of the
  labels' own interval at the median, 0.37 at the tenth percentile.
* **Decision:** `tracking.paceIgnoresRetracted` (true; false is the
  estimator as shipped). Openings are kept with their Note ids, and when a
  Note is absorbed (articulation fragment, attack fragment, prefix claim,
  region merge) or ends before it was announced, its opening is struck out
  and the gap it cut is whole again. Causal: only a fate already decided is
  read. Result on derivation: split 225 → 219, extras 281 → 271, false
  positives 223 → 211, missed 114 → 114; slow subset amped+mic 188/243 →
  182/232 with the DI column unchanged at 34/36; corpus 295 / 357 / 18 →
  289 / 346 / 19; tail fragments 246 → 235. Held out, read once: false
  positives 67 → 66, missed 27 → 27. The estimate against the labels'
  interval: 0.85 → 0.96 at the median, 0.37 → 0.48 at the tenth percentile.
  Eval PASS; 528 tests.
* **Alternatives Considered:** (a) **A lower or trimmed percentile** — the
  alternative DECISION-030 (e) already tried "each fixed the bias without
  improving the end-to-end trade"; and a percentile does not remove the
  pieces, it chooses among them. (b) **Gaps read from attack times rather
  than openings** — rejected on reading: the attack history holds every
  contact, release and band-only onset, so its gaps are shorter and more
  numerous than the openings', not cleaner. (c) **A bar denominated in the
  predecessor's own length rather than the local pace** — a different
  mechanism; not this iteration. (d) **Striking only absorbed stubs, not
  unannounced drops** — not measured separately: a fragment the rate gate
  dropped is exactly the opening the estimate should not have counted, and
  the gate feeding on its own drops is the circularity DECISION-030 named.
* **Consequences:** Positive — the first change since DECISION-030 to move
  the amped column at all (eight phantoms fewer on the quarters amped
  take, 46 of 72 split instead of 50), at no missed label on derivation or
  held-out; the estimate's ratio to the truth is now measured on this
  estimator, 0.96, and the row DECISION-037 left "not yet decidable" has a
  number; and DECISION-047's rule can be re-run on an estimate a boundary
  move cannot tip. Negative — one more stray, a 93ms Note at the start of
  the A3 eighths amped take where no pace exists yet; the span bars
  (0.35, 0.5) now act on an estimate 13% longer than the one they were
  tuned on, unswept here; and on the quarters amped take the estimate still
  reads under half the true interval because that take's phantoms are
  announced and stay in.

---

#### [DECISION-047]: A same-pitch split whose burst began on a refused contact is NOT moved to the release yet — the moves are right on 22 of 23 boundaries and the derivation score is worse through the pace estimator
* **Date:** 2026-09-18
* **Status:** Rejected (built, measured, reverted — DECISION-044's loop, iteration 3)
* **Owner:** Detection architecture
* **Context:** After DECISION-046, 9 of the 30 slow direct-input split events
  left on derivation are a pick's contact refused as a re-articulation
  (`no-energy-not-sharp`, `ring-out-not-sharp`; rise 0.56–0.93) with the
  release accepted 67–80ms later; the release splits the still-open Note,
  and the burst rule ("the boundary is the FIRST attack of this burst")
  backdates the split onto the contact. Five of the held-then-picked DI
  take's eight splits are this. `docs/DETECTION-FINDINGS.md`, "A burst that
  began on a refused contact".
* **Decision:** Not shipped. The rule — `tracking.burstContactRiseRatio`,
  read at the split's backdate site: when the burst's first attack rose by
  less than the bar and the accepting attack by `releaseRiseRatio` or more,
  same pitch class, the boundary is the accepting attack — was built, swept
  at 1.0 / 1.1 / 1.2 / 1.3 on the derivation predicate (flat: every refused
  contact reads under 1.0), and reverted to bit-identical: slow DI split
  30 → 33 of 327, missed 114 → 116, false positives 223 → 225, against a
  falsifier of "down by at least 6, neither up". The 23 boundaries it moved
  on the three DI takes went from 40–107ms early to within 33ms of their
  labels on 22 of them (the other is a label on the contact); the score
  moved through two indirect paths. (1) `localIoiMs` is the median of the
  last eight opening gaps; on the E5 take, whose gaps sit in two clusters,
  one gap shortened by 67ms tips the median 227 → 160ms, DECISION-045's
  announce bar for a no-rise fragment falls 113 → 80ms, and two 80ms
  contact stubs that had been dropped are announced. (2) Two overlap
  credits for labels the engine had not found at their own onset (`e843`,
  `p2c3q4`) rest on stubs the rule shortens to 13 and 40ms, which are then
  absorbed.
* **Alternatives Considered:** (a) **Keeping it on the strength of the
  moves** — rejected: the loop's bar is the derivation score and the
  falsifier was stated; the write-up carries the moves. (b) **Making the
  pace estimator robust in the same iteration** (a percentile that ignores
  one gap, or gaps read from attack times rather than Note openings) —
  rejected here: a second mechanism in one iteration, and the estimator's
  sensitivity deserves its own falsifier, since it applies to DECISION-046's
  moves as much as to these. Ledger row C14, ahead of C11. (c) **Restricting
  the rule to the held-then-picked shape** (a predecessor longer than the
  local interval) — not tried: it would be tuned to one take, and the score
  on that take is worse for the octave-credit reason, not the rule's.
* **Consequences:** Positive — the refused-contact shape is confirmed as
  the largest remaining direct-input timing error, and the exact site and
  condition are recorded; the pace estimator's cliff on bimodal material is
  now a named, measured fragility with a reproduction (E5 take, 15907ms,
  `announceBarMs` 113 → 80) rather than a suspicion. Negative — the engine is
  unchanged; the held-then-picked DI passage still starts its re-picks on
  the pick's landing; a rule that is right on 22 of 23 boundaries stays out
  until the estimator it disturbs is fixed.

---

#### [DECISION-046]: A Note opened on a pick's contact moves its boundary to the release — the first attack inside one articulation of the opening that rises over the muted string
* **Date:** 2026-09-18
* **Status:** Proposed
* **Owner:** Detection architecture; the ship decision is the project owner's (DECISION-044's loop, iteration 2)
* **Context:** After DECISION-045 the slow direct-input material still
  split 35 of 327 derivation events. Classified one by one from the trace
  (`docs/DETECTION-FINDINGS.md`, "The boundary of a slow direct-input stroke
  is the pick's release"), 27 of the 35 are not phantoms: one Note per pick,
  each opening 45–70ms before its label and the note before it ending as
  early. A 2ms envelope under the labels shows the cause. A slow pick stroke
  on a direct input is two events — the pick lands and mutes the string
  25–40dB, then 45–70ms later lets go and the note sounds — and every label
  probed sits on the release, within 6ms on the hand-labelled takes. Both
  kernels fire on the contact (the fine witness by design, DECISION-018), so
  the Note opens there; the release then lands inside
  `transient.articulationMs` and is folded in, or splits a stub off the
  contact that the split then absorbs, inheriting its start. The brief's door
  2 — a re-pick witness that survives compression: percussive flux,
  band-limited dip and rise, spectral shape, octave displacement — was
  benched first and closed: nothing over 0.69 AUC on the amped column against
  a bar of 0.80.
* **Decision:** Add `tracking.releaseRiseRatio` (2; 0 turns it off,
  bit-identical). A Note opened on a contact — by the fine witness, or by an
  attack with `riseRatio` under `CONTACT_RISE` 1.2 — has its boundary moved
  to the first attack inside `transient.articulationMs` of its opening whose
  `riseRatio` is at or over the bar, while it is unannounced and has not
  bloomed into a chord: an attack landing in the unsettled Note moves its
  start; an attack that split a stub off the contact still absorbs the stub
  (`absorbArticulationFragment`), so the consumer never sees it, but the
  survivor keeps its own start. Swept on the derivation predicate: slow DI
  split 35 / 30 / 30 / 31 / 31 / 32 at off / 1.5 / 2 / 2.5 / 3 / 4, missed
  114 throughout, amped column 158 throughout; 2 is the middle of the
  plateau. Result on derivation: slow DI split events 35 → 30 of 327, false
  positives 227 → 223, extras 288 → 281, missed 114 → 114, DI onset error
  median 25 → 23.7ms; the E5 eighths DI take's onset p90 51 → 25ms. Corpus
  305 / 368 / 20 → 295 / 357 / 18 split / extra / strays. Held out, read
  once: split 74 → 70, false positives 69 → 67, missed 24 → 27. Eval PASS;
  525 tests.
* **Alternatives Considered:** (a) **The release recognised by LEVEL**
  (the stub's level against the survivor's) — built first and never fires: a
  fine-opened stub is backdated onto the contact, so its frames were folded
  before it existed and it carries the release's own level (absorbed
  `levelRatio` 1.0 on every such stub). The rise over the 80ms baseline works
  because that baseline spans the muted string. (b) **A pace guard** (the
  contact-to-release gap under half the local interval) — rejected on the
  moved-boundary population: the five direct-input boundaries it would keep
  from moving on the held-out triplet take are all correct moves at
  0.50–0.62 of the interval, and the one wrong move it would stop sits at
  0.56 among them. (c) **A dip floor at the release** — rejected: the wrong
  move on the mic sixteenth take reads dip 0.19 and correct amped moves read
  0.135–0.18; no edge between them that is not tuned to one event. (d) **A
  sharpness ceiling on the contact opening** — the two moves that cost
  something had a broadband transient of sharpness 9.9 and 12.8 at the
  contact, the direct-input contacts read 0.5–6.6; a real candidate, and
  deliberately NOT added here, because it was read on held-out material and
  a bar chosen from it would be tuned on the held-out set. Ledger row C13.
  (e) **Reverting on the held-out +3** — the reading is recorded and the call
  left to the owner: one label is an overlap credit for a pick the engine
  already missed (`t12`, the credited stub sat in the next stroke's mute);
  two are on the mic sixteenths take at 140bpm, where the boundary moved 67ms
  onto the release and the region lane's reconciliation then read the next
  sixteenth, 62ms later, as agreeing with it — one real note lost, one
  duplicate credit lost; nothing on derivation is lost.
* **Consequences:** Positive — the first change to move the direct input's
  onset error rather than its phantom count: 22 boundaries on the E5 eighths
  DI take go from 42–93ms early to 2–25ms late, the direct-input held-out
  take reads slow splits 7 → 4 and onset p90 53 → 21ms, the amped column is
  one extra better and otherwise untouched, and the rule is off with one
  constant. Negative — held-out missed rises by three, one of them a real
  sixteenth on a room mic at 140bpm, so the letter of the loop's bar is
  broken on held-out material and the call is the owner's; the
  held-then-picked DI take's onset error reads worse (median 88 → 97ms)
  because its PROVISIONAL labels sit 20–90ms ahead of the contact, which the
  label review already in the journal covers; and the 30 remaining DI slow
  splits are now mostly the same mechanism at sites this rule does not
  reach — 9 where a refused contact starts the burst and the burst rule
  backdates the boundary onto it, 3 where the release arrives on a gated
  hop — which are ledger rows C11 and C12.

---

#### [DECISION-045]: The rate gate gains a second witness for the direct input — a same-pitch boundary over which no energy arrived — at fourteen emitted phantoms for one overlap credit
* **Date:** 2026-09-18
* **Status:** Proposed
* **Owner:** Detection architecture; the ship decision is the project owner's (DECISION-044's loop, iteration 1)
* **Context:** DECISION-030's rate gate holds a same-pitch fragment back
  from announcement for 0.35 of the local interval when the boundary under it
  showed no envelope dip (`dipRatio >= 0.85`). Read per signal path on the
  slow subset (`docs/DETECTION-FINDINGS.md`, "The rate gate's second
  witness"), the direct input is a column that witness never reaches: the 26
  emitted same-pitch phantoms on the DI slow takes have a median dip of 0.64
  and every one of them was announced. What separates them from the 154 real
  DI re-picks is `riseRatio`, the short envelope over its 80ms baseline —
  0.77 at the median against 1.01 at the real re-picks' tenth percentile,
  0.909 AUC — and their span over the causal interval (0.42 against 0.68).
  On the amped and mic renders `riseRatio` is 0.502 AUC: a compressor makes
  phantom and re-pick identical there, as every earlier reading found.
* **Decision:** Add a second form to the same gate, behind three
  `tracking` constants: a same-pitch boundary with `riseRatio` under
  `rateFragmentNoRiseRatio` (0.8) and `dipRatio` at or above
  `rateFragmentNoRiseDipRatio` (0.4) sets an announce bar of
  `rateFragmentNoRiseSpanFraction` (0.5) × the local interval; a boundary
  failing both witnesses takes the longer bar; the shipped dip form is
  unchanged. The decision is `rateFragmentSpanFraction()` in
  `note-tracker.ts`, unit-tested on corpus vectors. Swept on the derivation
  predicate: the rise bar has a cliff on both sides (0.75 gives up four of
  ten DI events, 0.85 reaches the amped column and the bench's nearest real
  re-picks sit at 0.82–0.89); the span bar costs a second label at 0.55; the
  dip floor is flat from 0.3 to 0.5 and stays where the readings put it.
  Result on derivation: slow DI split events 45 → 35 of 327, false positives
  241 → 227, missed 113 → 114; amped and mic column 158 → 158. Held out, read
  once: missed 24 → 24, false positives 70 → 69. Eval PASS.
* **Alternatives Considered:** (a) **`riseRatio` as a gate at the boundary
  itself** — rejected without building: DECISION-028 closed every single
  witness at the boundary, and the bench confirms why — 0.909 on DI is
  0.502 through an amp, and a boundary gate cannot tell which it is looking
  at; as the second witness of a rate gate it acts only on a Note that is
  also too short for the pace, which is what makes it safe on the amped
  renders. (b) **Raising `rearticulationRiseRatio` or narrowing the
  `sharpness` fallback in `rearticulation.ts`** — rejected: the same
  boundary gate, and the sharpness fallback is what accepts the real DI
  re-picks whose rise the 80ms baseline under-reads. (c) **A prospective
  bar on the predecessor's age over the local interval**, so the fragment is
  refused rather than opened — bench-falsified at 0.45–0.55 AUC on every
  population; the phantom's predecessor is a normal-length note. (d) **The
  rise bar at 0.9**, which reaches three more DI phantoms — rejected: it
  takes three real re-picks with it (`lead-line-sixteenths` s34,
  `same-pitch-eighths-a3-di` s16103, `held-then-picked-di` p4c4q4), each a
  note picked while its predecessor was still loud. (e) **Reverting on the
  +1 missed** as the letter of DECISION-044's bar requires — the reading is
  recorded and the call left to the owner: the label (`p1c4q4`,
  `held-then-picked-six-strings-120bpm-amped`, PROVISIONAL) was missed at
  its own onset on `main` (`chord-not-sharp`) and credited by a phantom Note
  opened 305ms later on 133ms of overlap; the change drops that phantom, and
  nothing played on time is lost anywhere on the derivation set.
* **Consequences:** Positive — the first change since DECISION-030 to move
  the direct input's same-pitch column, and the first to touch the slow
  subset at all: the E5 eighths DI take splits 13 of 64 slow labels instead
  of 22, fourteen phantoms fewer reach a consumer, held-out is one phantom
  better and nothing worse, the amped column is bit-identical, and the
  witness is off with one constant. It also corrects the loop's DI premise:
  emitted DI phantoms come through `sharpness`, not `envelope-rise`.
  Negative — one derivation label on the provisional side reads as missed
  where a late phantom used to stand in for it, so the standing "missed may
  not rise" bar is broken by one on the letter; the gain sits almost
  entirely on one take (17 of the 26 DI phantoms were there), which is
  narrow evidence; and the remaining DI slow splits are the shape this
  witness stops at (rise 0.8–1.0 against real re-picks from 1.01), so the
  next DI gain needs a different witness or the owner's own recordings.

---

#### [DECISION-044]: The same-pitch split is worked as a loop, judged on a quarters-and-eighths subset per signal path, with a journal as the hand-off between sessions
* **Date:** 2026-09-18
* **Status:** Proposed
* **Owner:** Project owner (the loop is his to run); brief and baseline by detection architecture
* **Context:** The owner's consumer, a rhythm game, runs Tuninator on a
  direct input into a computer's browser (a phone microphone in front of an
  amp is intended and untried) and reports that during its tutorial slow
  notes — quarters and eighths — split, so a note played on time reads as a
  short Note followed by another. On the direct input the corpus shows two
  shapes behind that symptom: same-pitch fragments accepted by the
  envelope-rise test, and low-string re-picks refused at the amplitude gate. In this repository that is the same-pitch
  tail fragment DECISION-027 through DECISION-037 measured, but every ceiling
  study read it on the whole corpus or on the sixteenth-note takes, never on
  the slow material as a population of its own. Measured on `main` at
  `1c5e632`, the slow material splits 52 of 365 events on the direct input
  and 189 of 389 through an amp sim or a room mic; on the amped quarters take
  the first Note of a split pair ends 237ms early at the median, which is the
  duration the game reads. The record's per-boundary threshold family is
  exhausted (DECISION-028), one phrase-level gate shipped at zero cost
  (DECISION-030), and the record itself names what is untested: a sequence
  decoder over EVENTS in the deep lane, a re-pick witness that survives
  compression, a classifier judged on the outcome-shaped target
  (DECISION-032), and two small named measurements. No phone-microphone
  material exists in the corpus.
* **Decision:** Work the defect as a **loop of single-mechanism iterations**,
  each a fresh session running `docs/slow-note-splits-loop-prompt.md`, with
  `docs/slow-note-splits-loop-log.md` as the only state carried between
  sessions: the baseline, every iteration's verdict in a fixed template, a
  living candidate ledger and the owner-side blockers. The primary target is
  the **slow subset** — `scripts/measure-splits.ts --subset=slow`, 754
  quarter- and eighth-note labels defined per fixture by label-id in the
  script header — scored per signal path, with the standing both-axes bar
  unchanged: missed labels may not rise, corpus extras may not rise, eval must
  pass, every constant swept on the derivation predicate. The loop's exit
  rule is stated in the brief (§9): it ends when the subset no longer splits,
  or when no candidate remains whose mechanism differs from a closed
  direction and whose falsifier the record does not already answer, or when
  everything left is blocked on the owner. The brief carries a table of every
  closed direction with its number so an iteration cannot re-drive one
  without saying in writing what is different.
* **Alternatives Considered:** (a) **One long session** that researches,
  builds and tunes until done — rejected: the record shows this decision is
  where hypotheses are argued around rather than falsified, and a per-iteration
  write-up with a stated falsifier is the discipline that produced the only
  zero-cost gain. (b) **Judging on the corpus totals as before** — rejected: the
  totals are dominated by 1,131 same-pitch events including sixteenths, and a
  change can move them without touching what the owner's players play; the
  subset is reported beside the totals, never instead of them. (c) **Waiting
  for recordings from the owner's rig before starting** — rejected: the
  corpus already reproduces the complaint on its own direct-input and amped
  takes, and the material is requested in the journal as a transfer check
  rather than a precondition.
  (d) **Building the tempo hint the consumer could supply** — deferred as a
  product decision; the record bounds what a true clock is worth and it is not
  the fix.
* **Consequences:** Positive — the defect has a target that matches its
  consumer, a reproducible baseline (`--subset=slow`, an instrument-only
  change to `scripts/measure-splits.ts` that slices labels after ownership is
  assigned and touches nothing under `src/`), a ranked list of what to try
  with the falsifier shape for each, and a hand-off format that lets sessions
  be short. Negative — nothing in the engine changed and the numbers stand
  exactly where they did; the loop's value is entirely in what its iterations
  measure. The subset's amped column rests partly on PROVISIONAL labels
  (`docs/SAME-PITCH-MATERIAL.md`), so a gain there is a reading until the
  label review lands; and the owner's own rig — his direct input today, a
  phone later — remains unmeasured until he records it through the game, so
  transfer to the actual rig is an assumption the journal states rather than
  a result.

---

#### [DECISION-043]: Publish from GitHub Actions on a release tag, with provenance; OIDC trusted publishing after a token-authenticated bootstrap
* **Date:** 2026-09-16
* **Status:** Accepted
* **Owner:** Project structure (mechanism as preferred by the repository owner)
* **Context:** The first publish of `tuninator` (DECISION-039). The owner's
  preference was a publish from GitHub Actions on a tag, with `--provenance`
  and OIDC, so that each version on npm is attested to the commit that built
  it; an interactive `npm login` is not available to an agent session, and a
  long-lived publish token in the repository is the credential class behind
  the 2025 npm supply-chain incidents. Two registry constraints shape the
  mechanism, both verified against npm's documentation and the CLI source:
  a trusted publisher can only be configured on a package that **already
  exists**, and staged publishing "cannot stage a brand-new package". So the
  very first publish of the name cannot use OIDC; every later one can.
  Trusted publishing also needs npm 11.5.1+, which Node 20 (the toolchain
  pin) does not carry.
* **Decision:** `.github/workflows/publish.yml`, triggered by a `v*` tag.
  It calls `ci.yml` as a reusable workflow (a one-line `workflow_call`
  trigger added there) so the tagged commit passes the exact verification
  bar every push to main gets, then a separate job checks the tag name
  against `package.json`, asserts npm ≥ 11.5.1, installs with
  `--ignore-scripts`, skips a version already on the registry, and runs
  `npm publish --provenance` — `prepublishOnly` rebuilds from that checkout.
  Authentication is OIDC: the npm CLI attempts the token exchange in every
  GitHub Actions run and, when it succeeds, overrides any configured token;
  when it fails it falls through to `NODE_AUTH_TOKEN`. The first publish
  therefore uses a granular access token (read-write, bypass-2FA, shortest
  expiry) held as the `NPM_TOKEN` secret for one run; the trusted publisher
  (`trellos` / `Tuninator` / `publish.yml`) is then configured on the
  now-existing package and both the token and the secret are deleted. The
  same workflow serves both phases unchanged. `id-token: write` is granted
  to the publish job only, and nothing but this repository's own scripts
  runs while it is held. The publish job runs Node 24 for its npm; the
  library does not run on Node, so the toolchain pin is not a consumer
  constraint (DECISION-042).
* **Alternatives Considered:** Publishing 0.2.0 by hand (`npm login`, `npm
  publish`) and reserving the workflow for later versions — workable and
  documented as the fallback, rejected as the default because 0.2.0 would
  carry no provenance and the workflow would be untested until 0.2.1. A
  long-lived automation token as the standing mechanism — rejected: it is
  exactly what trusted publishing exists to replace, and bypass-2FA tokens
  lose direct publish around January 2027 regardless. Staged publishing
  with human approval — attractive for later, unavailable for a first
  publish, and the tag push is already the human gate. Duplicating the CI
  steps inside `publish.yml` instead of calling `ci.yml` — rejected: two
  copies of the verification bar drift. A GitHub environment with required
  reviewers — not added; the tag is the approval, and an environment name
  would have to be mirrored in the trusted-publisher configuration.
* **Consequences:** Pushing a `v*` tag **is** the publish, which `AGENTS.md`
  §7 now says in bold. One manual bootstrap remains, and one manual
  configuration step after it, both written into the workflow header. A
  tag on a commit that fails the bar publishes nothing; a tag whose name
  disagrees with `package.json` fails before anything is sent; re-running a
  failed run cannot double-publish. Cost: the publish job re-runs typecheck,
  tests and build through `prepublishOnly` after the verify job already ran
  them — a minute of redundancy kept because that guard exists for hand
  publishes too and removing it for CI would mean `--ignore-scripts` on the
  publish itself.
* **Amendment (same day):** The first run of the workflow on `v0.2.0` failed
  in the publish step with `EUSAGE: Can't generate provenance for new or
  private package, you must set access to public` — nothing was sent, and
  the verify job had passed. `--access public` had been left out as
  redundant for an unscoped name; it is not redundant for a name the
  registry has never seen when provenance is requested. The command is now
  `npm publish --provenance --access public`, and the tag was moved to the
  commit carrying that fix, since no release existed to point at.

---

#### [DECISION-042]: No `engines` field in the published package; `.nvmrc` pins the toolchain instead
* **Date:** 2026-09-16
* **Status:** Accepted
* **Owner:** Repository owner
* **Context:** `package.json` carried `"engines": { "node": ">=20" }`. Nothing
  in the tarball runs on Node: all three bundles are built for the browser
  and need `AudioContext`, `AudioWorklet` and `getUserMedia`. Node 20 is a
  requirement of the dev toolchain alone — tsup, vitest, tsx, the eval — which
  a consumer never installs. The field therefore warns a consumer on an older
  Node with `EBADENGINE` for reasons that are ours, and under `engine-strict`
  fails their install outright.
* **Decision:** Remove `engines`. Add `.nvmrc` containing `20` so contributors
  keep the pin through nvm/fnm/volta and `actions/setup-node`'s
  `node-version-file`. `ci.yml` already pins `node-version: 20` and is
  unchanged. The lockfile's root entry, which mirrors `engines`, was
  regenerated by npm rather than edited.
* **Alternatives Considered:** Keeping the field as documentation of the
  toolchain — rejected: `engines` is read by the consumer's package manager,
  not by contributors, and is the wrong place to document a dev requirement.
  Widening it to `>=18` to stop the warning — rejected: still a claim about a
  runtime the package does not target.
* **Consequences:** No consumer sees an engine warning or an engine-strict
  failure for a browser-only package. Contributors on the wrong Node lose the
  `npm install` warning and get the `.nvmrc` prompt from their version manager
  instead; CI remains the enforcement.

---

#### [DECISION-041]: No sourcemaps in the published package
* **Date:** 2026-09-16
* **Status:** Accepted
* **Owner:** Repository owner
* **Context:** The index and engine-worker builds emitted sourcemaps
  (`sourcemap: true` in `tsup.config.ts`; the worklet build was already
  `false`). `dist/index.js.map` (647.7 kB) and
  `dist/tuninator-engine-worker.js.map` (592.0 kB) were 1.24 MB of the
  1.77 MB unpacked package — each map larger than the bundle it describes,
  because the engine's source is heavily commented and the maps carry it.
* **Decision:** `sourcemap: false` on both builds. Measured on the same
  tree: 13 files / 476.8 kB packed / 1.77 MB unpacked before, 11 files /
  143.7 kB packed / 523.5 kB unpacked after (the file count also reflects
  DECISION-040 and the new `CHANGELOG.md`). This trades debugging the
  library inside a consumer's app for install weight, deliberately, and the
  CHANGELOG says so in one line.
* **Alternatives Considered:** Keeping the maps — rejected on the ratio: 70%
  of every install for a facility most consumers never open, and the source
  is a `git clone` away. Maps without `sourcesContent` — considered;
  they would be small but would point at paths that do not exist in a
  consumer's tree, which is worse than no map. Publishing maps to a separate
  package — over-engineering for a 0.2.
* **Consequences:** A stack trace from inside the bundle names `index.js`
  lines rather than `src/` lines. Anyone who needs to step through the
  library builds it from source, which the README's Docs list already points
  at. The `//# sourceMappingURL` trailer is gone from both bundles, so no
  browser devtools 404 on a missing map either.

---

#### [DECISION-040]: `docs/MIGRATION.md` stays in the repository and leaves the package and the README
* **Date:** 2026-09-16
* **Status:** Accepted
* **Owner:** Repository owner
* **Context:** `docs/MIGRATION.md` is the symbol-by-symbol map from the 0.1
  pitch detector to the 0.2 recognizer. It was addressed to people upgrading
  from a 0.1 that was never published: `npm view tuninator` returned 404 on
  2026-09-16, and nothing at 0.1.x ever existed on the registry. It was in
  `package.json`'s `files` and in the README's Docs list as live consumer
  documentation, which is the ground DECISION-024 gave for keeping it.
* **Decision:** Remove it from `files` and from the README Docs list. Keep the
  file: it documents the 0.1 → 0.2 design delta — modes removed, the
  timestamp epoch, overlapping Notes, hypotheses — and is worth having as
  history. `CHANGELOG.md` links it on GitHub for anyone who built against a
  0.1 checkout. **This voids one clause of DECISION-024** — "`README.md` links
  it as the 0.1→0.2 upgrade guide for consumers, so it is live
  documentation" — and no other part of that decision; its status stands.
* **Alternatives Considered:** Deleting the file — rejected, it is the
  clearest statement in the tree of why 0.2 has the shape it has. Keeping it
  in the tarball as a cheap 11 kB — rejected: a consumer who installs 0.2.0
  and finds a migration guide will look for the 0.1 it migrates from.
* **Consequences:** The published package carries three docs pages (API, Note
  model, evaluation), all about the version installed. A reader of the README
  on npm no longer sees a link to a migration they cannot need.

---

#### [DECISION-039]: 0.2.0 is the first published version, tagged `v0.2.0`
* **Date:** 2026-09-16
* **Status:** Accepted
* **Owner:** Repository owner
* **Context:** The library is reviewed and ready to publish (DECISION-038).
  `package.json` has read `0.2.0` since `f6cacf4`, because that is the API
  the tree implements; the 0.1 series exists only in this repository's
  history and was never on npm. The name `tuninator` was verified unclaimed
  on 2026-09-16.
* **Decision:** Ship as 0.2.0, tagged `v0.2.0` on the release commit. The
  version is the one the API, the docs and this log already describe, and a
  first release does not reset it. `CHANGELOG.md` opens with 0.2.0 and says
  in a short section why the number is not 0.1.0 or 1.0.0.
* **Alternatives Considered:** 0.1.0, as "the first release" — rejected: it
  would name a published version after an unpublished design the docs
  explicitly contrast with. 1.0.0 — rejected: the same-pitch re-articulation
  decision is measured to a ceiling (DECISION-022, -028) and the amped
  same-pitch labels are provisional; 0.x is honest about the API being open
  to change on that front.
* **Consequences:** Semver 0.x: minor versions may break. The tag convention
  `v<version>` is what `publish.yml` triggers on and checks against
  `package.json` (DECISION-043).

---

#### [DECISION-038]: Pre-publish prune — remove seams nothing calls, wire the channel meters the API already promised, keep every deliberately-unwired module
* **Date:** 2026-09-16
* **Status:** Accepted
* **Owner:** Project structure
* **Context:** A code review ahead of publishing to npm, asked to make the
  code readable, keep the architecture straightforward, and remove
  deprecated and unused code and signs of drift. A reference scan of every
  export under `src/` found two kinds of unreferenced code. One kind the log
  keeps on purpose (DECISION-010, -013, -023, -024, -037). The other kind
  nothing anywhere calls: `IDeepScheduler`/`DeepJob` (an injected scheduler
  the deep lane never had — it drains by source time), `DeepJobPurpose` with
  three values never requested, `DeepLane.reassign`/`forget`/`drainAll`,
  `EnginePort.now()` and the `now` on every worker output message, the
  worklet's `reset` command and its `contextTime`/`sampleRate` chunk fields,
  `NoteTracker.flush`/`currentHarmonyOf`, `NoteRecord.closing`, a second
  `centsBetween`, an `isRearticulation` wrapper the tracker never used, a
  `sort` whose comparator always returns 0, and parameters `void`ed inside
  the functions that take them. Separately, `PitchFrame.channelRms` and
  `selectedChannel` are documented in `docs/API.md` and measured by the
  worklet on every hop, and were dropped at the recognizer's port handler, so
  no consumer could ever have seen them. Seven kernel headers still said
  "Part of `src/core/`" (a tree DECISION-023 retired), six carried "CONTRACT
  FILE — owned by the X workstream" banners from a parallel-workstream era,
  and the top-level docs described an injected scheduler and a `status`
  diagnostic that do not exist. DECISION-037 still said `tracker/pace.ts`
  was retained, a day after `a10d0e5` removed it.
* **Decision:** Remove the unreferenced seams above and the lineage banners;
  consolidate `centsBetween` in `kernels/notes.ts`; carry the worklet's
  channel meters through `EnginePort.push(samples, startSample, meters)` and
  stamp them onto that hop's `PitchFrame`s in the host — the worker entry
  echoes them back with its output, so the engine still never sees channels
  and both hosts stamp the exact hop. Declare `sideEffects` for the two
  bundles that register themselves on load rather than `false` for the whole
  package, and add `main`, `keywords`, `homepage` and `bugs` for the
  registry. Amend DECISION-037 to record the withdrawal. **Keep**
  `kernels/click.ts`, `kernels/whitened-bands.ts`, `rig-profile.ts` and the
  calibration seam, `deep.regionMerge`/`regionCorrectPitch`,
  `transient.fluxMaxFilterSemitones` and `training/`: each is unwired by a
  logged decision and driven by its measurement script, and DECISION-024's
  rule stands — unwired is not dead here.
* **Alternatives Considered:** Pruning by reachability alone — rejected, per
  DECISION-024. Removing `channelRms`/`selectedChannel` from the public type
  instead of wiring them — rejected: the worklet already measures them, the
  API doc already promises them, and the missing piece was a dozen lines.
  Stamping meters in the recognizer from the most recently captured chunk —
  rejected for the worker host, where that chunk can be a hop or two ahead
  of the frames arriving; echoing them through the port keeps both hosts
  exact for one small structured clone per hop. Removing `deepLatencyMs`
  from `EngineTuning` (an offline knob on the public surface) — deferred:
  dropping a public option is a versioned change, not a cleanup.
* **Consequences:** No detection change: `npm run eval` produces a report
  byte-identical to the pre-prune run (only `generatedAt` differs), and
  `docs/EVALUATION.md` still matches it. The suite goes from 510 tests to 511
  (one test of `DeepLane.forget` removed, two added for meters through each
  host). `EnginePort` loses `now()` and `getTimebase()` no longer returns
  null; both were internal. `CaptureChunk` and the worker protocol shrink by
  the fields nothing read. Accepted debt: `EvalStats`/`FixtureReport` still
  carry more than `docs/EVALUATION.md` reads, and `EngineTuning.deepLatencyMs`
  stays public until a versioned API change removes it.
* **Amendment (2026-09-16):** `bc313bc` recorded the `main` field and the
  `sideEffects` list above but carried only `keywords`, `homepage` and
  `bugs`; `package.json` still read `"sideEffects": false` with no `main`.
  Both landed with the 0.2.0 release preparation (DECISION-039 to -043):
  `main` is `./dist/index.js`, and `sideEffects` names
  `./dist/tuninator-worklet.js` (calls `registerProcessor` on load) and
  `./dist/tuninator-engine-worker.js` (installs its message handler on
  load).

---

#### [DECISION-037]: The third pace attempt ships disabled; the ratio gate misses its stated bar at the oracle's operating point
* **Date:** 2026-09-15
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** DECISION-028 named a sequence claim as the precondition for
  progress on the same-pitch split, and the owner asked for the live-tempo form
  of it (DECISION-036 having removed the retraction objection). A live pace had
  been built twice and reverted twice. Read against each other the two entries
  yield a combination neither ran: attempt 1's target (bias the segmentation
  toward whole notes) with attempt 2's feed (once per attack BURST, quantile
  0.25), scaling only the absorb decision and explicitly not `releaseGraceMs`
  or `harmony.changeStableMs`, both of which attempt 1 proved are decay physics
  rather than tempo. Re-measuring the oracle ceiling with the eight same-pitch
  takes in the corpus moved it from 8 emitted Notes to 71, because the gate is
  visible only when `ratio x rate` clears the 55-90ms announce bar and this
  material's candidates sit at a 222ms median rate against the old 154ms.
  Falsifier stated before building: at least 35 emitted Notes removed, no
  derivation cost, no net held-out loss.
* **Decision:** Built (`tracker/pace.ts`, `absorbAtPace()` in
  `note-tracker.ts`, `pace.*` config, `tests/engine/pace.test.ts`) and
  **rejected as a shipping candidate; `pace.absorbRatio` stays 0**, verified
  byte-identical to the merge with the gate off. At the oracle's own operating
  point it removes **9 Notes at 0.35 and 19 at 0.40 against a bar of 35**,
  where the oracle removed 71 and 77. The derivation set is unmoved at every
  ratio tried and the held-out takes gain a label rather than lose one from
  0.30 to 0.40, so the mechanism is inert rather than harmful — which is the
  same shuffle attempt 2 was reverted for, now reproduced with attempt 2's own
  corrections in place. `PaceEstimator` is retained and tested because a
  sequence model over the envelope needs a pace and this one's two known
  defects (the per-transient feed, the pace carried across a rest) are fixed
  and covered by tests.
* **Alternatives Considered:** **Shipping at 0.50**, where the sweep clears
  every clause of the falsifier as written — 42 Notes removed, derivation
  unmoved, held-out at its baseline. Refused on two counts. There is a
  principled case for 0.50 (attempt 2 measured its estimator at 0.82 of the
  oracle rate, and 0.40/0.82 = 0.49) but that 0.82 belongs to a different
  implementation measured on a 459-label corpus and has **not been re-measured
  for this estimator**, so shipping on it means choosing a constant because a
  sweep over held-out and provisional-label material shows it clearing the bar.
  And it costs two labels on the eight takes, a net loss on the missed axis
  against annotations that are PROVISIONAL and, on two of four takes, recorded
  as not matching what the player described. Scaling the announce bar as well
  as the absorb bar — not tried, because attempt 1's derivation damage came
  from scaling durations wholesale and the narrow gate had to be read first.
  Reverting the estimator outright — rejected per DECISION-024's precedent of
  keeping deliberately-unwired modules, and because the next measurement needs
  it.
* **Amendment (same day):** The verdict above leads with the wrong quantity and
  is corrected here. "9 against a bar of 35" weighs a bar set at half the
  oracle's figure — an arbitrary fraction, not a test of worth — and the
  standing both-axes bar was over-applied: it warns that fewer misses bought
  with extras is not automatically a win, which does not make one extra missed
  label an automatic refusal. Split by material at 0.40, extra Notes go 13 to
  13 on derivation, 83 to 82 on the twelve held-out takes, and 314 to 296 on
  the eight — so **eighteen of the nineteen removed Notes are on the eight
  takes**, and the held-out move is a shuffle of one Note each way. The missed
  cost divides identically: -1 held-out, +2 the eight. The exchange rate is
  19 extras for 1 missed corpus-wide, far better than the one-for-one every
  energy witness produced, and it is measured almost entirely against
  PROVISIONAL labels. The decision therefore stands as **"not yet decidable"
  rather than "not worth having"**, the operating point to read it at is 0.40
  (the oracle's own, stated before this was built, not fitted), and the label
  review on the eight takes is the blocker in the strict sense that the whole
  measured effect sits on the unreviewed side of the corpus.
* **Consequences:** No behaviour change: the engine is bit-identical, `npm run
  eval` PASSES, and the corpus stands at 137 missed and 410 extra Notes exactly
  where it did. The negative is specific rather than general — the *ratio* form
  of a per-boundary pace gate is closed at its stated operating point, and the
  sequence claim DECISION-028 named is untouched, because this was never a
  sequence decoder: it reads one fragment against one scalar. **The next
  measurement is named and small:** this estimator's own ratio to the oracle
  rate at the candidates, per take. If it is 0.82 then 0.50 is derived rather
  than fitted and the gate deserves re-reading against reviewed labels; if it
  is not, the ratio form is finished. The label review on the eight takes is a
  precondition for either reading, since two of the cost labels sit there.
* **Amendment (2026-09-16):** The retained module described above was
  withdrawn the same day, in `a10d0e5`, when the branches were reconciled:
  DECISION-030's announce-bar form of the same rate insight measured better
  (32 fewer extra Notes and 21 fewer split events for zero missed labels) and
  does not retract a Note, so the absorb mechanism — `tracker/pace.ts`, its
  test, the `pace.*` config block and `absorbAtPace()` — came out rather
  than being merged alongside a second rate estimator doing the same job. The
  rate estimator the tracker uses is `localIoiMs` in `note-tracker.ts`.
  The absorb form is closed; the announce-bar form is not.

---

#### [DECISION-036]: Revision is the contract, not a cost; latency to be correct is accepted
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

#### [DECISION-035]: The fine onset's dip requirement stays; measured off, it is a direct-input trade that leaves the amped renders untouched
* **Date:** 2026-09-15
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** With the eight 120bpm same-pitch takes and the DI repair in one
  tree (DECISION-034), `held-then-picked-six-strings-120bpm-di` reads 14 missed
  of 120. The tracker's trace names the refusals: seven `rejected: gated` at
  the amplitude gate on a string decayed below it, three `ring-out-not-sharp`,
  three `band-only transient`, one with no transient in the window at all —
  twelve of the fourteen C3 or C4 re-picks, the other two an F#2 and a G4. The
  fine-hop witness of DECISION-033 sees the gated ones with a 19-26dB rebound
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
  DI derivation material DECISION-033 already names as its precondition, and a
  reviewed label pass over the eight takes (`docs/validate-relabelled-material-prompt.md`).
  Negative cost: anyone reading the take's ledger will find the misses and the
  witness that sees them, and has to read this entry to learn why the two are
  not connected in the shipped engine. The full measurement is in
  `docs/DETECTION-FINDINGS.md`, "The DI repair, scored on the eight 120bpm
  takes it was never measured against".

---

#### [DECISION-034]: Merge the direct-input repair with the 120bpm same-pitch material; the merge has one engine parent, not two
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
  is renumbered clear of it — first to `DECISION-029`, then to `DECISION-033`
  when the sibling branch's own 029-032 arrived — with its cross-references
  moved with it each time (`docs/DETECTION-FINDINGS.md`,
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

#### [DECISION-033]: Adopt the direct-input roadmap: fine-hop flux proposals, transitions belong to the pick, octave-consistent cancellation; DI derivation material is the precondition
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

#### [DECISION-032]: The two same-pitch benches measure different targets; name which question each answers
* **Date:** 2026-09-15
* **Status:** Accepted
* **Owner:** Evaluation methodology
* **Context:** DECISION-031's gate measured the DECISION-030 rate feature at
  0.533 on the re-articulation decision table, against 0.826 in the study that
  produced it. The discrepancy was assumed to be estimator error and was not:
  scored on the rate study's own sub-population (accepted, settled, same-pitch,
  1,038 derivation rows) the same feature on the same rows reads **0.805**
  against the rate study's target and **0.526** against the decision table's,
  reproducing each study's own number. The inputs agree; the ground truth does
  not.
* **Decision:** **Record that the two benches ask different questions, and which
  question each answers, because both files describe themselves as being about
  "the same-pitch re-articulation decision".**
  `measure-decision-separability.ts` asks a BOUNDARY-shaped question: does an
  uncovered label begin within 70ms of this decision, so should the split have
  been made? `measure-rate-relative-merge.ts` asks an OUTCOME-shaped question:
  did the matcher pair the Note this split created with a label, so is this
  emitted Note surplus? **They disagree on 278 of 1,038 shared rows, 26.8%** —
  162 where the boundary was right but the child went unpaired, 116 where the
  boundary was wrong but the child got the label. Neither is wrong; they are
  answers to different questions. Choose by what is being decided: a consumer
  scoring one target per pick pays for surplus Notes, so the outcome-shaped
  target governs anything about fragmentation, and the boundary-shaped target
  governs anything about segmentation.
* **Alternatives Considered:** (a) **Treating one as the correct target and
  retiring the other** — rejected: both questions are real, and the 73.2%
  agreement means neither is a noisy version of the other. (b) **Reconciling
  them into a single target** — rejected for now; the 278 disagreements are
  where a Note is right about the boundary and wrong about its own extent, or
  vice versa, and collapsing that loses the distinction rather than resolving
  it. (c) **Assuming the gap was estimator error**, which was the first
  hypothesis — refuted by scoring both targets on identical rows.
* **Consequences:** Positive — a class of future confusion is closed, and two
  existing conclusions can now be read correctly. **DECISION-021's rejection of
  the learned onset head was measured against the BOUNDARY-shaped target**, on
  161 rows with 59 positives; that verdict stands for the question it asked and
  is not evidence about a model trained and judged on surplus Notes, which has
  never been run. DECISION-030's shipped gate operates on the outcome-shaped
  target, which is why it improves the fragmentation numbers while moving
  nothing on this table. Negative — every AUC in this repository predating this
  entry now needs its target identified before it is compared with another, and
  the two ceiling figures most often quoted (0.698 at the boundary, 0.926 for
  the rate feature) are NOT on the same scale and must never be cited as though
  they were. This is the fifth instance of "a bench ranking is not a pipeline
  ranking" and the sharpest: not a bench disagreeing with the engine, but two
  benches disagreeing with each other about the ground truth.

---

#### [DECISION-031]: Rhythm features do not transfer across takes at the boundary; the learned-model gate fails
* **Date:** 2026-09-15
* **Status:** Rejected
* **Owner:** Detection architecture
* **Context:** DECISION-030 shipped a rate-relative fragment bar whose leading
  feature scores 0.926 against a true clock, far above the 0.698 every witness
  read AT the boundary tops out at, and the owner asked whether a neural network
  could separate a real pluck from an invented boundary. DECISION-021 already
  spent a 19,833-parameter conv net on this decision and failed its falsifier at
  0.7157. Rather than train a second one, the cheap gate: offer the same rhythm
  features to a plain L2 logistic regression on the existing decision table and
  measure cross-take generalisation. A regression is the floor — if the
  information does not appear there, no network over the same inputs will find
  it. Falsifier stated in advance: leave-one-take-out AUC must clear 0.702 by
  more than the spread across folds, AND must remove materially more than 0 of
  635 false positives at zero label cost.
* **Decision:** **Both clauses fail; nothing is wired and `src/` is unchanged.**
  Leave-one-take-out goes 0.593 (twelve witnesses) to **0.603** with the
  prospective rhythm group added, against a bar of 0.828, and false positives
  removable at zero label cost go 0 to **2 of 635**. The retrospective group,
  which the brief named in advance as the interesting outcome because it would
  have argued for a retraction-based design, is the WEAKER of the two: it moves
  leave-one-take-out by −0.001 and scores 0.431 alone, worse than chance
  out-of-take, and the fitted model assigns it a weight of −0.01. A lambda sweep
  changes nothing. In-sample rose 0.717 to 0.742 and pooled 5-fold 0.711 to
  0.733, but both pool across takes, which is the within-take memorisation this
  table exists to expose.
* **Alternatives Considered:** (a) **Training a model anyway** — rejected as the
  expensive version of an experiment that just came back negative on its floor.
  (b) **Selecting lambda or the feature subset on the leave-one-take-out
  column** — rejected as tuning on the falsifier's own rows, the same trap
  DECISION-021 named. (c) **Reading the pooled held-out gain (0.723 -> 0.749) as
  generalisation** — rejected: it pools twelve takes and is the same kind of
  number as the 5-fold one. (d) **Concluding the rate feature does not work** —
  refuted; see DECISION-032. It works, on a different target.
* **Consequences:** Positive — a training run is not attempted on a feature set
  that does not clear its floor, and one genuinely useful feature is identified:
  pace-normalising `soundedMs` takes it 0.646 to **0.708**, a real +0.062 and
  the only new feature to beat any existing witness, which is the DECISION-030
  framing working as advertised even though it correlates 0.794 with the raw
  quantity and only ties `fluxRatio`. The best of all 171 witness pairs is now
  `fluxRatio` + `localIoiMs` at 0.687 leave-one-take-out, up from 0.679.
  Negative, and the sharpest limit found — **the rate abstains where it is most
  needed.** `localIoiMs` is missing on 71% of rows on one cowboy take and 59-64%
  on the three 140bpm cowboy takes, against 0.4-1.3% on the same-pitch material,
  because sparse chord playing keeps tripping the 1,500ms reset. Adding the
  group also hurts `held-then-picked-amped`, 0.479 -> 0.463, the largest
  negative-heavy take. **What this does NOT close** is a model judged on surplus
  Notes rather than on boundaries: this table asks the boundary-shaped question
  and DECISION-032 records that the two differ on 26.8% of shared rows, so the
  learned direction is closed only for the question this table asks.

---

#### [DECISION-030]: A same-pitch fragment is judged against the local note rate, not against a fixed duration
* **Date:** 2026-09-14
* **Status:** Accepted
* **Owner:** Detection architecture
* **Context:** DECISION-028 closed the per-boundary threshold family — every
  witness available at the decision tops out at 0.698 AUC, the new envelope dip
  reaches 0.763, and at roughly five real re-picks per phantom a 0.78 witness
  removes about one played note per phantom. It named the opening rather than a
  fix: "what a listener uses on this material is not one number at one boundary
  — it is four evenly spaced events carrying the same envelope shape, which is a
  claim about a SEQUENCE." Separately, the owner pressed the point that the
  session had produced analysis rather than accuracy. The defect is stereotyped:
  294 of 318 extra Notes are at the label's own pitch class and butted against
  their neighbour, and the median shortest Note in a split event is 93ms.
* **Decision:** **Ship the sequence claim as an announce bar.** A Note opened by
  a same-pitch re-articulation whose boundary showed no envelope dip
  (`dipRatio >= tracking.rateFragmentDipRatio`, 0.85) must outlast
  `tracking.rateFragmentSpanFraction` (0.35) of the LOCAL inter-onset interval
  before it is announced; one that dies first is discarded by `end()` as a Note
  that never cleared its bar. Measured over 1,237 same-pitch re-articulations,
  fragment span over the true local interval scores **0.905 AUC** against 0.788
  for the span alone and 0.698 for everything read at the boundary. End to end:
  **missed labels 159 -> 159, false positives 346 -> 314, events split 339 ->
  318, extra Notes 407 -> 379**, eval PASS with the one pre-existing
  informational failure, `clean-lead` gated pitch class unchanged at 92.9%, 499
  tests passing, `fixtures/` untouched. It is the first gate in this line that
  removes phantom Notes at zero cost in played ones. 0.35 is the largest span
  bar costing nothing on the derivation material (0.40 costs two); held-out was
  reported only after the bar was fixed and costs nothing either.
* **Alternatives Considered:** (a) **A fixed-duration bar** — refuted by the
  populations: the median spurious fragment is 93ms and a real sixteenth at
  140bpm is 107ms, so 80ms costs 77 played notes and 100ms costs 173. (b) **The
  rate test alone** — costs one played note on `lead-line-di-sixteenths`,
  hand-labelled held-out data at 107ms spacing where fragment and note are the
  same length; the dip as a second, independent witness removes that cost
  entirely, which is why both ship. (c) **A deep-lane retraction** (announce,
  then withdraw via `structuralRevision` / `relation: "absorbed"`) — measured to
  give identical numbers to simply never announcing, so the far simpler
  mechanism ships. (d) **Estimating the rate from the audio envelope's own
  periodicity**, to break the circularity at the source — measured and rejected:
  envelope-over-truth spreads 0.31 to 2.02 across the quartiles with octave
  errors both ways, dropping the test to 0.622 AUC. `docs/SAME-PITCH-MATERIAL.md`
  already records why, the A3 take's strongest periodicity sitting at twice the
  note period. (e) **An upper percentile, and a two-pass re-estimate**, both
  aimed at the same contamination — each fixed the bias without improving the
  end-to-end trade. (f) **Keeping DECISION-028's dip GATE** — removed rather than
  left inert; the witness is load-bearing here, the rejected bar is not.
* **Consequences:** Positive — 32 fewer false positives and 28 fewer extra Notes
  for no missed label anywhere, and the sequence framing is now measured rather
  than proposed: 0.905 against 0.698 for everything read at the boundary. The
  estimator's error is understood and one-directional, which is what makes the
  rule safe: a missed onset can only lengthen a gap and a phantom can only
  shorten one, and only the long reading is dangerous. Negative — the amp-sim
  takes still carry most of the defect (`held-then-picked-amped` 48 of 120 split
  against 8 of 120 on the direct render of the same performance), and the rule
  says nothing about a fragment that is a full note long. **The methodological
  cost is worth naming:** the offline simulation predicted -43 extras and zero
  missed labels, and the first engine build delivered -25 with a NEW
  informational failure on `lead-line-amped-sixteenths`. That was a 500ms
  FALLBACK rate applied 3.7s into a take playing 107ms sixteenths, before any
  gap had been measured, which suppressed a real 147ms note under a 175ms bar.
  Removing the fallback — abstaining when no pace is known — fixed it. Two
  hypotheses were tried and failed before the instrument was read; that ordering
  is the mistake, not the fallback.

  *Amended 2026-09-15:* restricting this gate to MONOPHONIC Notes was proposed,
  measured and refused. It was expected to be a no-op and is a regression —
  false positives 314 -> 319, extra Notes 379 -> 383, missed unchanged — and it
  fails at its own purpose: discards on the chord takes stay at 9 while firings
  fall 31 to 17, because a power chord is a dyad and a decayed strum is one
  ringing string, so `polyphonic` is silent exactly where the restriction was
  wanted. All five lost discards are on `held-then-picked-amped`, which is
  monophonic by construction, so the flag also fires wrongly on distorted
  single-note material. The finding is about the flag rather than the idea; a
  per-Note test on the predecessor's `harmonyBloomed` is the untested
  alternative. `src/` is unchanged.

---

#### [DECISION-029]: Keep the automated re-timing of the two gridded DI sections; the A3 sixteenth section is flagged, not reverted
* **Date:** 2026-09-14
* **Status:** Accepted
* **Owner:** Fixture ground truth (validation pass)
* **Context:** `fixtures/labels/**` is read-only against the detector, and was
  edited twice on the owner's instruction: `b5cf94b` applied nine corrections
  from his own listening pass (human annotation, the highest authority in the
  repository), and `7a216fe` re-timed roughly 330 labels in the two gridded DI
  sections with `scripts/retime-gridded-labels.ts`, on envelope evidence that is
  weaker than an ear, against material this project has mis-measured before.
  The re-timing's own check — 6/6 of the owner's picks within 30ms — is nearly
  circular, four of the six being values it is forbidden to move. The brief
  (`docs/validate-relabelled-material-prompt.md`) asked whether the automated
  pass is sound, with the instruction to revert `7a216fe` alone if not, never
  to touch `src/`, and never to consult Tuninator's output.
* **Decision:** **Keep `7a216fe`; `b5cf94b` stands; no further label edit.**
  The re-timing reproduces byte for byte from the script; every structural,
  count, lock and eval check passes. Three of its four sections are confirmed
  by evidence it never read: on `e5-di` the re-timed sixteenth labels sit on
  2.7× the onset energy in the *amped* render that the grid did (0.49 vs 0.18,
  chance 0.10; 115 vs 99 of 127 within 25ms of a strong amped peak), the
  verifier's attack-offset spread tightens three- to four-fold on all four
  sections, inter-onset intervals scatter like this player's measured
  quarter-note takes (SD 21–22ms against 16–20), and a leave-one-out at the
  owner's six ear points lands five within 11ms. The fourth section, `a3-di`'s
  sixteenths, located 78 of 111 picks and is not verifiable from the amped
  render (that audio is too compressed for any crude onset function); per label
  it is no worse than the grid, but as a sequence it is non-physical (39 of 110
  intervals outside 85–175ms, every one involving an unmoved grid label). It is
  flagged as unreliable in `docs/SAME-PITCH-MATERIAL.md` with its 33 unmoved
  ids listed, rather than reverted, because a wholesale revert would discard the
  three verified sections and improve nothing.
* **Alternatives Considered:** (a) **Revert `7a216fe`** — rejected: the grid it
  would restore is measurably further from the picks on three sections and no
  closer on the fourth. (b) **Revert only the A3 sixteenth section** — rejected:
  the brief permits a wholesale revert or nothing, and any partial edit of
  `fixtures/labels/**` needs the owner's ear. (c) **Re-run the script with the
  lock changed to hold times rather than (id, time) pairs**, which would fix the
  one place the lock demonstrably hurt (`s1614`/`s1615`) — rejected here for the
  same reason: a further automated edit of ground truth is not this pass's to
  make; the limitation is recorded in the script header and the findings. (d)
  **Carry the re-timed DI times to the amped files** at the measured +2.5ms
  render offset — deferred to the owner; it would be the right repair for amped
  sixteenth labels that currently sit at chance on their own audio. (e) **Trust
  the re-timing's own 6/6** — rejected as the circular check the brief named.
* **Consequences:** Positive — the two DI takes that were the corpus's worst
  onset data now carry measured onsets on 318 of their 374 labels, checked from
  a second recording of the same performance; the two renders are established
  as aligned to 2.5ms (both earlier offset measurements, 9–56ms and 80–90ms,
  were wrong); and three false premises in the record are corrected: the amped
  label files of the two fast takes were never the DI timings (their grids are
  anchored 195/225ms later, so label ids do not name the same pick across
  renders), `verify-fixtures.ts`'s concern count cannot see a sub-window move by
  construction (its per-label offsets can, and do), and a removal cannot be
  carried across renders by id. Negative — the A3 sixteenth section remains
  unusable for anything needing better than ±65ms, now with a non-physical
  interval structure; the amped fast-take labels are unchanged and known to be
  off their picks in the sixteenth sections; and four questions are left with
  the owner (which sixteenth the 19.613s pick is; whether A3's sixteenths run
  19.89–33.96s against 111 labels; whether to carry DI times to the amped
  files; the three weak off-beats at 21.05/21.30/21.55s in `e5-di`). The
  material stays PROVISIONAL and unassigned to derivation or held-out.
  `src/` is unchanged. *Same day, later:* the owner listened to those DI
  sections and gave 37 pick times; they are applied verbatim (findings entry,
  "Resolved the same day, by ear"), closing the first, second and fourth open
  items — the 19.614s pick is `s1614`, both A3 section-end picks are labelled,
  `s1628` is restored at 21.297s — and leaving the amped files deferred on his
  instruction.

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
