/**
 * Polyphonic segmentation: chroma + chord matches -> one chord per event.
 *
 * Segmentation is driven by chord CHANGE, not silence: the power-chord and
 * cowboy-chord labels are contiguous 2s bars with no gaps between them, so
 * waiting for a gap would merge all eight into one event.
 *
 * Naming is a vote, not a snapshot, and the vote can decline to answer. Those
 * two facts are the whole file — see `judgeChordVotes`.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import type { EventPitch, PitchClass } from "../../types.js";
import type { ChordCandidate, ChordMatch, ChordQuality } from "../chords.js";
import type { EngineFrame } from "../pitch-engine.js";
import { describeFrequency } from "../notes.js";
import { BaseTracker } from "./base-tracker.js";
import type { ActiveEvent, TrackerEmission } from "./active-event.js";

/** Runner-up chord interpretations kept on an event. */
const MAX_ALTERNATIVES = 4;

/**
 * Distinct spectra the winning root needs before the event is willing to be
 * named.
 *
 * Counted in chroma *observations*, not hops. The chroma path runs once every
 * few hops and its result is cached in between, so a run of identical hops can
 * be a single look at the spectrum; `ChordTracker` votes once per distinct
 * reading so this constant means what it says. Below it the evidence is a
 * flash, and the honest answer is `unknown`.
 *
 * A ratio was tried here instead — confident readings as a share of everything
 * the event saw — on the theory that two readings mean more in a 150ms upstrum
 * than in a 2s bar that never resolved. It does not survive the fixtures: the
 * third Bm upstrum (2 confident of 15 seen) and the synthetic late-flash case
 * (2 of 20) are within 0.03 of each other on that measure and must resolve
 * oppositely, so any threshold between them is fitted to noise rather than to
 * a real distinction. The absolute count is the bar that can be justified.
 */
const MIN_CHORD_EVIDENCE_FRAMES = 3;

/**
 * Distinct chroma readings a NEW root needs before it splits the event.
 *
 * The chroma runs once every few hops and its result is cached in between, so a
 * wall-clock persistence rule alone can be satisfied by a single look at the
 * spectrum. A real chord change survives being looked at repeatedly.
 */
const MIN_CHORD_CHANGE_OBSERVATIONS = 3;

/**
 * How far the winning ROOT must outweigh the best rival root.
 *
 * This is the abstention rule, lifted from the hop to the event. `matchChord`
 * already refuses to commit when one hop's top two roots are within `margin`;
 * without the same test on the pooled evidence, an event whose readings are
 * split between two roots still gets confidently named after whichever led at
 * the end. Extended voicings are exactly that case — `Cmaj9` (C E G B D)
 * contains `Em`, `G` and `C`, so its readings scatter and no single root is
 * what was played.
 *
 * Measured against the best RIVAL rather than the summed field, for the same
 * reason `matchChord` does: a decisive winner is otherwise diluted by a tail of
 * one-off readings that are not competing with it. On the strummed fixture the
 * muted Bm upstrums score B 3.60 against G 1.66 (a ratio of 2.17) while a
 * genuinely divided Cmaj9 scores E 6.92 against B 4.98 (1.39). 1.8 sits in the
 * gap: a chord whose evidence is merely noisy keeps its name, one whose
 * evidence is split loses it.
 *
 * A ratio rather than a difference because weight accumulates with an event's
 * length, and the test has to mean the same thing on a 200ms upstrum as on a
 * 2s ringing bar.
 *
 * Pooling is by root rather than by label on purpose: a decayed `B5` and a full
 * `Bm` are the same chord seen at two moments, and they must reinforce each
 * other rather than split the vote.
 */
const MIN_ROOT_DOMINANCE = 1.8;

/** One chord reading's accumulated evidence over an event's life. */
type ChordVote = {
  label: string;
  root: PitchClass;
  quality: ChordQuality;
  /** Summed match score across the confident readings that voted for it. */
  weight: number;
  /** How many confident readings voted for it. */
  hops: number;
};

/** Chord-mode state, layered onto `ActiveEvent`. */
type ChordState = {
  /**
   * Every confident reading seen while this event was active, keyed by label.
   * A strum's third decays far faster than its root and fifth, so by the end of
   * an event the chroma has collapsed to a power chord and the last frame names
   * a Bm "B5". The event is named from the weight of its evidence instead.
   */
  chordVotes: Map<string, ChordVote>;
  /** Root this event has committed to. Null until a confident reading lands. */
  chordRoot: PitchClass | null;
  /** A candidate replacement ROOT, held until it proves it is not a flap. */
  pendingRoot: PitchClass | null;
  pendingSince: number;
  /** Distinct chroma readings backing `pendingRoot`. */
  pendingObservations: number;
  /**
   * Votes cast since `pendingSince` — the evidence arguing for the change. A
   * split backdates the boundary to `pendingSince`, so these hops end up inside
   * the NEW event's span and are handed to it when the change is confirmed.
   * Without that the new event loses its whole attack as evidence, which is the
   * part where the third is still sounding.
   */
  pendingVotes: Map<string, ChordVote>;
};

type ActiveChord = ActiveEvent & ChordState;

/** What the pooled evidence supports, and how strongly. */
type ChordVerdict = {
  /** Null means abstain: the evidence does not name a chord. */
  winner: ChordVote | null;
  /**
   * How well the evidence fit, 0..1 — reported as `confidenceParts.spectralFit`
   * when the event abstains. Each bar the verdict failed pulls it down, so an
   * `unknown` event cannot carry a confident-looking score.
   */
  fit: number;
};

export class ChordTracker extends BaseTracker<ActiveChord> {
  /**
   * The last chord object voted on.
   *
   * `PitchEngine` runs the 4096-point chroma once every few hops and hands the
   * SAME `ChordMatch` instance back on the hops in between, so identity is what
   * separates a new look at the spectrum from a cached one. Voting per hop
   * counted every reading three or four times over and made any evidence
   * threshold meaningless.
   */
  private lastVotedChord: ChordMatch | null = null;

  protected createModeState(): ChordState {
    return {
      chordVotes: new Map(),
      chordRoot: null,
      pendingRoot: null,
      pendingSince: 0,
      pendingObservations: 0,
      pendingVotes: new Map(),
    };
  }

  process(engineFrame: EngineFrame): TrackerEmission[] {
    const out: TrackerEmission[] = [];
    const { frame, chord, onset } = engineFrame;
    const t = frame.timestamp;
    const policy = this.policy;
    const gated = frame.amplitude.rms < policy.analysis.rmsGate;

    if (gated) {
      const active = this.active;
      if (active !== null) {
        if (active.unvoicedSince === null) active.unvoicedSince = t;
        active.event.state = "release";
        if (t - active.unvoicedSince >= policy.tracking.releaseGraceMs) {
          this.end(active.unvoicedSince, out);
        }
      }
      this.flushEmissions(out);
      return out;
    }

    // A genuine re-strum is a new event, even when the chord did not change.
    //
    // Merging on root (below) is right for a chord decaying through C -> C5, and
    // wrong for a chord played twice: the strummed fixture is four chords played
    // TWICE each, sixteen events, and root-merging alone collapsed each pair
    // into one. What separates the two cases is energy -- a re-strum puts it
    // back into the strings, a decay does not -- which is the same test the note
    // tracker applies to a re-picked note.
    if (onset && this.active !== null) {
      const rearticulated =
        frame.amplitude.rms >= this.active.recentRms * policy.chords.restrikeRmsRise;
      if (rearticulated) this.end(t, out);
    }

    const confident = chord?.isConfident === true && chord.best !== null;
    const root = confident ? chord!.best!.root : null;
    // Whether this hop is a NEW look at the spectrum or the cached previous one.
    // Computed before segmentation because segmentation counts these.
    const isFreshReading = chord !== null && chord !== this.lastVotedChord;

    if (this.active === null) {
      const fresh = this.beginChord(frame.frequencyHz, t, engineFrame);
      fresh.chordRoot = root;
    } else {
      const active = this.active;
      active.unvoicedSince = null;

      if (confident && active.chordRoot === null) {
        // The attack transient is noisy and often unclassifiable; when it
        // resolves, upgrade this event in place rather than splitting. That
        // keeps `startedAt` on the actual attack, which is what onset error
        // measures.
        active.chordRoot = root;
      } else if (confident && root !== active.chordRoot) {
        // A different ROOT, not merely a different label.
        //
        // C and C5 are the same chord at two moments of its decay -- the third
        // dies first, so a ringing C becomes a C5 on its way out -- and
        // splitting there cut single strummed bars into two events apiece: on
        // the power-chord fixture the C bar came out as C + C5, the E bar as E5
        // + Esus2. Both halves then had half the evidence to be named from, and
        // whichever half the matcher did not pick became a false positive.
        //
        // `judgeChordVotes` has always pooled by root for exactly this reason.
        // Segmenting by label while naming by root was the two halves of this
        // file disagreeing about what counts as the same chord.
        if (active.pendingRoot !== root) {
          active.pendingRoot = root;
          active.pendingSince = t;
          active.pendingObservations = 0;
          active.pendingVotes = new Map();
        }
        if (isFreshReading) active.pendingObservations += 1;

        // Persistence in wall-clock time is not enough on its own: the chroma
        // runs once every few hops and is cached in between, so 120ms of "a
        // different root" can be a single look at the spectrum. Demand distinct
        // looks as well, the same evidence a name requires.
        if (
          active.pendingObservations >= MIN_CHORD_CHANGE_OBSERVATIONS &&
          t - active.pendingSince >= policy.tracking.minStableMs
        ) {
          const carried = active.pendingVotes;
          this.end(active.pendingSince, out);
          const fresh = this.beginChord(frame.frequencyHz, active.pendingSince, engineFrame);
          fresh.chordRoot = root;
          fresh.chordVotes = carried;
        }
      } else if (confident) {
        // Same root. The quality may have moved (C -> C5); the vote decides the
        // name, and this event keeps going.
        active.pendingRoot = null;
        active.pendingObservations = 0;
        active.pendingVotes = new Map();
      }
    }

    // One vote per DISTINCT reading, cast for whichever event is active once
    // segmentation has had its say. A reading observed while a change was
    // merely pending votes for the event it was observed under; if that change
    // is later confirmed, the backdated boundary puts the same reading inside
    // the new event's span, and `pendingVotes` hands it over so it counts there
    // too.
    const current = this.active;
    if (current !== null) {
      if (isFreshReading) {
        this.lastVotedChord = chord;
        if (confident) {
          recordChordVote(current.chordVotes, chord.best!);
          if (current.pendingRoot !== null) recordChordVote(current.pendingVotes, chord.best!);
        }
      }
      this.applyChordLabel(current, engineFrame);
      if (current.event.state === "release") current.event.state = "sustain";
    }
    this.observe(engineFrame, t);

    this.flushEmissions(out);
    return out;
  }

  /**
   * A chord event is named by `applyChordLabel` or not at all. `begin()` labels
   * from the monophonic pitch estimate, which on a strum is whichever string
   * YIN happened to lock onto — a note name on a chord event, and one that can
   * never match a chord label.
   */
  private beginChord(hz: number | null, t: number, engineFrame: EngineFrame): ActiveChord {
    const active = this.begin("chord", hz, t, engineFrame);
    active.event.label = { name: "unknown" };
    return active;
  }

  /** Chord mode reads the spectrum, not the monophonic pitch track. */
  protected onVoicedFrame(): void {
    /* no-op */
  }

  /** Writes the event's best-supported chord interpretation onto it, honestly. */
  private applyChordLabel(active: ActiveChord, engineFrame: EngineFrame): void {
    const chord = engineFrame.chord;
    if (!chord) return;

    const verdict = judgeChordVotes(active.chordVotes, this.policy.chords.floor);

    if (verdict.winner !== null) {
      const { label, root, quality } = verdict.winner;
      active.event.label = { name: label, root, quality };
    } else {
      // Either nothing ever cleared the per-hop margin rule, or what did was too
      // thin or too divided to name the event. Say `unknown` and show the work,
      // rather than committing to a confident wrong label.
      active.event.label = { name: "unknown" };
    }

    // `matchChord` scores all 120 (root, quality) pairs and hands back every
    // runner-up. Only the near-misses are informative — and this list crosses
    // the worklet port on every update, so keep it short.
    const alternatives = [
      ...(chord.best && !chord.isConfident
        ? [{ label: chord.best.label, confidence: chord.best.score }]
        : []),
      ...chord.alternatives
        .slice(0, MAX_ALTERNATIVES)
        .map((c) => ({ label: c.label, confidence: c.score })),
    ].slice(0, MAX_ALTERNATIVES);
    active.event.ambiguity = {
      ...active.event.ambiguity,
      alternatives: alternatives.length > 0 ? alternatives : undefined,
      polyphony: engineFrame.chroma?.polyphony,
    };

    // The fit that backs the NAME, not the fit of whatever the newest frame
    // happened to see. When the event abstains, the fit is the evidence that
    // failed to name it — a divided vote reports a low number, which is what
    // stops an `unknown` event from carrying a confident-looking score.
    active.event.confidenceParts.spectralFit =
      verdict.winner !== null ? verdict.winner.weight / verdict.winner.hops : verdict.fit;

    if (engineFrame.chroma) {
      active.event.pitches = chordPitches(engineFrame);
      active.event.primaryPitch = active.event.pitches[0] ?? null;
    }
  }
}

/** Folds one confident reading into a tally. */
function recordChordVote(votes: Map<string, ChordVote>, best: ChordCandidate): void {
  const vote = votes.get(best.label) ?? {
    label: best.label,
    root: best.root,
    quality: best.quality,
    weight: 0,
    hops: 0,
  };
  vote.weight += best.score;
  vote.hops++;
  votes.set(best.label, vote);
}

/**
 * The event's name, decided in two stages: root first, then quality among the
 * readings that agreed on that root — or no name at all.
 *
 * Root before quality because the root is the robust part — it is carried by
 * the bass and the loudest partials and survives the decay — while the quality
 * lives in the third, the first thing to disappear. Pooling by root means a
 * decayed `B5` and a full `Bm` reinforce each other on the root rather than
 * splitting the vote, and the quality is then settled only among readings that
 * were looking at the same chord.
 *
 * Three bars, all of which must clear, or the event abstains:
 *
 *  - **Enough looks.** `MIN_CHORD_EVIDENCE_FRAMES` distinct spectra agreed on
 *    the root. One or two is a flash.
 *  - **Good enough fit.** The winning root's mean match score clears the same
 *    `floor` a single hop has to clear. A weak reading repeated is still weak.
 *  - **Undivided.** The winning root outweighs the best rival root by
 *    `MIN_ROOT_DOMINANCE`. This is what makes an extended voicing abstain
 *    instead of being named after whichever of its plausible roots led at the
 *    end.
 *
 * Ties break toward the first reading seen, which is deterministic: `Map`
 * iterates in insertion order and insertion order is observation order.
 */
function judgeChordVotes(votes: Map<string, ChordVote>, floor: number): ChordVerdict {
  const roots = new Map<string, { weight: number; hops: number }>();
  for (const vote of votes.values()) {
    const agg = roots.get(vote.root) ?? { weight: 0, hops: 0 };
    agg.weight += vote.weight;
    agg.hops += vote.hops;
    roots.set(vote.root, agg);
  }

  let bestRoot: string | null = null;
  let bestWeight = 0;
  let bestHops = 0;
  let rivalWeight = 0;
  for (const [root, agg] of roots) {
    if (agg.weight > bestWeight) {
      rivalWeight = bestWeight;
      bestRoot = root;
      bestWeight = agg.weight;
      bestHops = agg.hops;
    } else if (agg.weight > rivalWeight) {
      rivalWeight = agg.weight;
    }
  }
  if (bestRoot === null || bestHops === 0) return { winner: null, fit: 0 };

  const dominance = rivalWeight > 0 ? bestWeight / rivalWeight : Number.POSITIVE_INFINITY;
  const meanScore = bestWeight / bestHops;
  if (bestHops < MIN_CHORD_EVIDENCE_FRAMES || meanScore < floor || dominance < MIN_ROOT_DOMINANCE) {
    // Discounted by every bar it failed: how well the best root fit, how
    // contested it was, and how little of it there was to look at.
    const fit =
      meanScore *
      Math.min(1, dominance / MIN_ROOT_DOMINANCE) *
      Math.min(1, bestHops / MIN_CHORD_EVIDENCE_FRAMES);
    return { winner: null, fit: Math.max(0, Math.min(1, fit)) };
  }

  let winner: ChordVote | null = null;
  for (const vote of votes.values()) {
    if (vote.root !== bestRoot) continue;
    if (winner === null || vote.weight > winner.weight) winner = vote;
  }
  return { winner, fit: meanScore };
}

function chordPitches(engineFrame: EngineFrame): EventPitch[] {
  const pitches: EventPitch[] = [];
  const chroma = engineFrame.chroma;
  if (!chroma || chroma.bassFrequencyHz === null) return pitches;

  const nearest = describeFrequency(chroma.bassFrequencyHz);
  pitches.push({
    frequencyHz: nearest.frequencyHz,
    midi: nearest.midi,
    name: nearest.name,
    pitchClass: nearest.pitchClass,
    octave: nearest.octave,
    cents: nearest.cents,
    role: "bass",
    confidence: chroma.salience,
    salience: chroma.salience,
  });
  return pitches;
}
