/**
 * Phase 2: does spotify/basic-pitch carry note-boundary information the
 * engine's witnesses lack? The report over the rows `phase2-rows.ts` collects.
 *
 * EVERYTHING BELOW WAS FIXED IN WRITING, AND COMMITTED, BEFORE THE MODEL WAS
 * READ ON ANY FIXTURE (2026-09-25). Nothing in this header was changed after
 * a number was seen; any later note says so and why.
 *
 * ---------------------------------------------------------------------------
 * SETS
 * ---------------------------------------------------------------------------
 * Derivation: the 15 tuning takes (`engine-run.ts` DERIVATION): the five
 * originals, the eight 120bpm same-pitch takes, the two rest-repick takes.
 * Every bar, threshold and operating point is decided on these alone.
 * Held-out: the twelve 140bpm takes, read ONCE by `phase2-rows.ts --heldout`
 * after this file is committed, reported in a section labelled HELD-OUT, with
 * the operating points taken from derivation unchanged.
 *
 * ---------------------------------------------------------------------------
 * HOW THE MODEL IS READ (`causal.ts`, fixed in Phase 1)
 * ---------------------------------------------------------------------------
 * A reading at decision time T is one model window whose frame 156 is centred
 * on T, holding the 1807ms of audio before T and ZEROS after it; only frames
 * at or before T are used. Audio is the engine's own 48kHz decode, downmixed
 * as the engine does and resampled to 22050Hz by `resample.ts` (validated in
 * `parity.ts`).
 *   FAST  T = the engine's own decision time for that row (below). What a
 *         fast-lane decision could have had.
 *   DEEP  T = the row's event time + 200ms: `deep.regionSettleMs`, the audio
 *         the engine's deep lane already waits for after a Note before it
 *         rules on a region. The deep lane's ring is 4s; a reading holds
 *         1.8s of it and nothing that has not arrived.
 *   WHOLE the package's own windowing over the whole take (`framing.ts`):
 *         every frame with its look-ahead. NOT buildable in either lane;
 *         reported only to show what the look-ahead is worth. No bar may be
 *         met by a WHOLE reading.
 * Every window used here against 107ms: the onset window +-40ms (80ms wide);
 * the model's frame 11.6ms; its onset output's CNN reach +-116ms and the CQT
 * filters (313ms half-span at E2) are look-ahead, removed by the zeros in FAST
 * and DEEP, and their cost is the FAST/DEEP/WHOLE gap.
 *
 * ---------------------------------------------------------------------------
 * FEATURES (read on a reading R; pitch set PS; model bins are MIDI 21..108)
 * ---------------------------------------------------------------------------
 * PS for a single note of MIDI m: m's pitch class in every octave from E2 to
 * E6 (MIDI 40..88), so an octave error on either side does not hide it. For a
 * chord label, the union of its listed pitches' classes; for an engine chord
 * or "unknown" Note, all of MIDI 40..88.
 *   O(S)     onset: the largest onset activation over PS in the frames whose
 *            centre is within 40ms of the event time S (and at or before T).
 *   N(a,b)   sounding: the mean over frames centred in [a,b] of the largest
 *            note activation over PS.
 *   P(a,b,m) pitch agreement: 1 when the pitch class of the MIDI note with
 *            the highest mean note activation over [a,b] (MIDI 40..88) is m's,
 *            else 0. Single-note Notes only.
 * The model's own thresholds, from the package, are the fixed operating
 * points of every 2x2 table: onset 0.5, note 0.3.
 *
 * ---------------------------------------------------------------------------
 * Q1  GHOSTS  (OUTCOME-shaped: is this emitted Note surplus?)
 * ---------------------------------------------------------------------------
 * Rows: every Note in the final projection of a derivation take that the
 * matcher either paired with a required label (matched, y=0) or left unpaired
 * (extra, y=1). Notes paired with an optional label are neither and excluded.
 * S = the Note's start, E = its end (S + 1ms if none).
 *   FAST: T = the time the engine emitted the Note's `started` (announce).
 *         O(S); N(S, T); P(S, T).
 *   DEEP: O(S) read at T = S + 200; N and P over [S, min(E, S+1500)] read at
 *         T = min(E, S+1500) + 200.
 * AUC oriented in advance: LOW onset, LOW sounding, disagreeing pitch =
 * surplus. BAR: AUC >= 0.80 for O, N or P in the DEEP reading (a deep-lane
 * witness); the same in FAST makes it a fast-lane witness too.
 *
 * ---------------------------------------------------------------------------
 * Q2  SPLITS, pitch unchanged
 * ---------------------------------------------------------------------------
 * Rows: every `rearticulation` trace event on a derivation take that was
 * accepted, settled and same-pitch and opened a child Note — the rows of
 * `scripts/measure-decision-separability.ts`'s `collectFixture` with those
 * filters (its child rule: the next `opened` before any further decision).
 * S = the child's opening time, t = the decision's time. PS from the
 * predecessor Note's final label (else the child's, else all).
 * Q2a, BOUNDARY-shaped, "should this cut have been made?": target y = that
 * script's own (a label begins within 70ms of t and no Note opened before
 * the decision within 70ms of that label). Feature O(S): FAST at T = t, DEEP
 * at T = S + 200. HIGH onset = a real cut. BAR: AUC > 0.698 (DECISION-028's
 * best boundary witness, on its boundary-shaped target) in FAST or DEEP. The
 * engine's own witnesses on the same rows (sharpness, fluxRatio, dipRatio)
 * are printed beside it.
 * Q2b, OUTCOME-shaped, on the rows DECISION-030's rate gate lets through:
 * the Q2 rows whose child is in the final projection (announced, not
 * absorbed). Target: the matcher left the child unpaired (surplus, y=1) —
 * the target the gate itself acts on (DECISION-032). Feature O(S): FAST at T
 * = the child's announce time, DEEP at T = S + 200. LOW onset = surplus.
 * BAR: conditional AUC >= 0.70 in FAST or DEEP (the scale of the boundary
 * bar, asked of the rows the gate could not decide).
 * Q2 clears only if Q2a AND Q2b clear. The two AUCs are on different targets
 * and are never compared with each other.
 *
 * ---------------------------------------------------------------------------
 * Q3  LOST FAST NOTES
 * ---------------------------------------------------------------------------
 * Rows: every label the matcher missed on a derivation take, with the branch
 * `scripts/measure-downstream-ledger.ts`'s `classify` gives it. "The model sees
 * a distinct note" at label start L: in the DEEP reading at T = L + 200, some
 * frame centred within 40ms of L and nearer L than any other label's start
 * holds, at a bin of the label's PS, an onset activation that is a local
 * maximum in time and >= theta.
 * False alarms, on MATCHED labels: the same rule over the label's interior,
 * [L+40, min(end, next label start) - 40] (at most 1500ms, read at T = its end
 * + 200): a second distinct onset inside one played note. theta = 0.5, the
 * package's onset threshold, unless that fires on more than 10% of matched
 * labels' interiors; then the smallest theta in 0.55, 0.60, ... 0.95 at or
 * under 10%. theta is fixed on derivation and carried to held-out unchanged.
 * BAR: in some ledger branch with at least 4 derivation misses, the model sees
 * at least half of them, at a false-alarm rate <= 10%.
 *
 * ---------------------------------------------------------------------------
 * Q4  PITCH (secondary, descriptive, no bar)
 * ---------------------------------------------------------------------------
 * Matched required labels on derivation: the model's note (single notes: the
 * MIDI note with the highest mean note activation over the label's span; a
 * chord: the lowest MIDI note whose mean activation is >= 0.3, as its bass)
 * against the label, exact and pitch class, beside the engine's own matched
 * Note, by signal path, single note vs chord, and register (E2-D#3, E3-D#4,
 * E4 and up). DEEP reading at T = min(end, start+1500) + 200.
 *
 * ---------------------------------------------------------------------------
 * EVERY QUESTION: the 2x2 agreement table (only model right / only engine
 * right / both / neither) by signal path, at the fixed operating points above;
 * AUCs with a take-cluster bootstrap 95% interval (1000 resamples, seeded).
 * A clean negative is a result.
 * ---------------------------------------------------------------------------
 *
 * Usage:
 *   npx tsx training/basic-pitch/phase2-rows.ts --dir training/out/basic-pitch
 *   npx tsx training/basic-pitch/phase2.ts --dir training/out/basic-pitch
 *   npx tsx training/basic-pitch/phase2-rows.ts --dir training/out/basic-pitch --heldout   # ONCE
 *   npx tsx training/basic-pitch/phase2.ts --dir training/out/basic-pitch --heldout
 */

export const BARS = {
  q1Auc: 0.8,
  q2aAuc: 0.698,
  q2bAuc: 0.7,
  q3SeenShare: 0.5,
  q3MinBranch: 4,
  q3MaxFalseAlarm: 0.1,
  onsetThreshold: 0.5,
  noteThreshold: 0.3,
  windowMs: 40,
  deepDelayMs: 200,
  maxSpanMs: 1500,
} as const;
