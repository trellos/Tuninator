/**
 * Turning a sequence of windows into a sequence of events.
 *
 * The deep lane used to be a window-tagger: one 85ms window ending at "now",
 * analysed on behalf of whichever Notes happened to be open, and filed under
 * them. That contract cannot represent the two things that were actually
 * wrong. It cannot say "there were three notes here, you emitted two", because
 * a reading has to be filed under a Note that already exists; and it cannot say
 * "the voice that just arrived is not the loudest one", because a single window
 * has nothing to compare against.
 *
 * A region does. Walking a span of audio window by window turns both questions
 * into questions about a *sequence*, and both answers fall out of the same two
 * witnesses:
 *
 *  - **The dominant fundamental changed and stayed changed.** Over a run with
 *    an open string ringing under it, the loudest fundamental in any one window
 *    is routinely the open string; what identifies the melody is that the
 *    leader *moves* while the drone does not.
 *  - **The envelope rose above the quietest point since the last boundary.**
 *    A note re-picked at the same pitch is spectrally identical to itself, so
 *    nothing about the spectrum will ever separate the two picks. The envelope
 *    does, and over a region the trough between them is visible in a way it
 *    never is from one window ending at now.
 *
 * Both are decided from `RegionWindowReading`s and nothing else, so the rule is
 * testable against a handwritten sequence with no audio in sight.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { SourceTimeMs } from "../../types.js";
import type {
  HarmonicReading,
  PitchActivation,
  RegionSegment,
  RegionWindowReading,
} from "../contracts.js";

export type SegmentOptions = {
  /** Shortest span that may be called an event. */
  minSegmentMs: number;
  /** Consecutive windows a new dominant fundamental must hold. */
  holdWindows: number;
  /** Envelope rise over the segment's trough that counts as a re-articulation. */
  riseRatio: number;
  /**
   * Where the fast lane saw energy arrive, in absolute samples, ascending.
   *
   * Every transient it saw, including the ones it was not allowed to act on —
   * a quiet upstroke 107ms after the downstroke it answers is exactly that.
   * These are proposals, not boundaries: each one still has to be answered by
   * the envelope staying up afterwards.
   */
  attackSamples: readonly number[];
  /**
   * Envelope rise a boundary needs when the fast lane already saw a transient
   * at that exact moment.
   *
   * Lower than `riseRatio`, and it has to be: the rise is the only witness
   * `riseRatio` has, so it carries the whole burden of proof, while here the
   * question is only whether anything followed the pick. An 85ms window cannot
   * show a quiet upstroke's full rise anyway — it still holds most of the
   * downstroke that came 107ms before it.
   */
  attackRiseRatio: number;
  /** Samples in one analysis window, for placing a boundary in time. */
  windowSize: number;
  /** Samples per millisecond, so this file never touches a clock. */
  samplesPerMs: number;
};

/**
 * An abstaining reading, used when a segment never saw a confident one.
 *
 * Written out rather than borrowed from the last window, because "no window in
 * this segment named a chord" and "the last window declined to" are different
 * claims and only the first one is true here.
 */
function abstention(): HarmonicReading {
  return {
    root: null,
    quality: null,
    chordName: null,
    bass: null,
    intervals: [],
    confidence: 0,
    alternatives: [],
    isConfident: false,
  };
}

/**
 * Where the audio behind a window actually starts.
 *
 * A window ending at sample E describes the audio in `[E - windowSize, E)`, so
 * the first window showing a new note tells us the note began somewhere in that
 * span — and the previous window, which did not show it, tells us it began
 * after that window's own start. Taking the start of the first window that saw
 * it is the earliest defensible estimate, and biasing late is the expensive
 * direction: a boundary placed late gives the new event its predecessor's
 * frames, which is the failure this whole change exists to stop.
 */
function boundarySample(window: RegionWindowReading, windowSize: number): number {
  return Math.max(0, window.toSample - windowSize);
}

/**
 * Does `candidate` hold as the dominant fundamental for `holdWindows` windows?
 *
 * A single window disagreeing with its neighbours is the transform straddling a
 * boundary, not a note. Requiring the run to be *complete* inside the region
 * means the last window or two of a region never opens a segment — which is
 * right, because a region always ends at audio that is still arriving.
 */
function holds(
  windows: readonly RegionWindowReading[],
  index: number,
  candidate: number,
  holdWindows: number
): boolean {
  if (index + holdWindows > windows.length) return false;
  for (let k = index; k < index + holdWindows; k++) {
    if (pitchClassOf((windows[k] as RegionWindowReading).dominantMidi) !== candidate) return false;
  }
  return true;
}

/**
 * A leader's pitch class, or null when there is no leader.
 *
 * Compared by CLASS rather than by MIDI note, for the same reason the fast lane
 * does: an octave-sized jump is the best-known failure mode of every pitch
 * estimator, harmonic-sum peak-picking included — the cancellation pass keeps
 * whichever of a fundamental and its octave carried more weight in this
 * particular window, and on one ringing string that flips freely. Treating a
 * flip as a boundary splits a sustained note in two, and the half that keeps
 * the true octave then reads as a second event nobody played.
 */
function pitchClassOf(midi: number | null): number | null {
  return midi === null ? null : ((midi % 12) + 12) % 12;
}

/** Collapse the windows `[from, to)` into one segment. */
function makeSegment(
  windows: readonly RegionWindowReading[],
  from: number,
  to: number,
  startSample: number,
  endSample: number,
  boundary: RegionSegment["boundary"],
  samplesPerMs: number
): RegionSegment {
  /** Salience summed per fundamental, so a pitch present throughout wins. */
  const weight = new Map<number, { salience: number; activation: PitchActivation }>();
  let best: HarmonicReading | null = null;
  let confidenceSum = 0;

  for (let i = from; i < to; i++) {
    const window = windows[i] as RegionWindowReading;
    for (const activation of window.activations) {
      const entry = weight.get(activation.midi);
      if (entry === undefined) {
        weight.set(activation.midi, { salience: activation.salience, activation });
      } else {
        entry.salience += activation.salience;
        if (activation.salience > entry.activation.salience) entry.activation = activation;
      }
    }
    if (window.reading.isConfident && (best === null || window.reading.confidence > best.confidence)) {
      best = window.reading;
    }
    confidenceSum += window.reading.confidence;
  }

  // Ties break toward the lower MIDI note, so the result never depends on the
  // order a Map happened to be filled in.
  const ranked = [...weight.values()].sort((a, b) => {
    if (b.salience !== a.salience) return b.salience - a.salience;
    return a.activation.midi - b.activation.midi;
  });

  const span = Math.max(1, to - from);
  return {
    fromSample: startSample,
    toSample: endSample,
    from: (startSample / samplesPerMs) as SourceTimeMs,
    to: (endSample / samplesPerMs) as SourceTimeMs,
    dominantMidi: ranked[0]?.activation.midi ?? null,
    activations: ranked.map((entry) => entry.activation),
    reading: best ?? abstention(),
    windows: span,
    confidence: confidenceSum / span,
    boundary,
  };
}

/**
 * Split a region's windows into the events it contains.
 *
 * Returns one segment for a region with no boundary in it — the honest answer
 * when the fast lane got it right — and never returns zero segments for a
 * non-empty region.
 */
export function segmentRegion(
  windows: readonly RegionWindowReading[],
  options: SegmentOptions
): RegionSegment[] {
  if (windows.length === 0) return [];

  const { minSegmentMs, holdWindows, riseRatio, windowSize, samplesPerMs } = options;
  const minSegmentSamples = minSegmentMs * samplesPerMs;
  const segments: RegionSegment[] = [];
  const attacks = options.attackSamples;
  /** Next unconsidered proposal from the fast lane. */
  let attackIndex = 0;

  let segmentFrom = 0;
  let segmentStartSample = boundarySample(windows[0] as RegionWindowReading, windowSize);
  let segmentClass = pitchClassOf((windows[0] as RegionWindowReading).dominantMidi);
  let trough = (windows[0] as RegionWindowReading).rms;
  let boundaryKind: RegionSegment["boundary"] = "regionStart";

  for (let i = 1; i < windows.length; i++) {
    const window = windows[i] as RegionWindowReading;
    let at = boundarySample(window, windowSize);

    // A transient the fast lane saw between the previous window and this one.
    // The pick localises it; this window says whether anything followed it.
    let proposed: number | null = null;
    while (
      attackIndex < attacks.length &&
      (attacks[attackIndex] as number) <= boundarySample(windows[i - 1] as RegionWindowReading, windowSize)
    ) {
      attackIndex++;
    }
    if (attackIndex < attacks.length && (attacks[attackIndex] as number) <= at) {
      proposed = attacks[attackIndex] as number;
    }

    const windowClass = pitchClassOf(window.dominantMidi);
    let kind: RegionSegment["boundary"] | null = null;
    if (
      windowClass !== null &&
      segmentClass !== null &&
      windowClass !== segmentClass &&
      holds(windows, i, windowClass, holdWindows)
    ) {
      kind = "pitchChange";
    } else if (trough > 0 && window.rms >= trough * riseRatio) {
      kind = "energyRise";
    } else if (
      proposed !== null &&
      trough > 0 &&
      window.rms >= trough * options.attackRiseRatio
    ) {
      // The boundary is the transient, not the window that noticed it. That is
      // the whole reason for asking the fast lane: 21ms of hop localises a
      // boundary to 21ms at best, and a pick localises to one sample.
      kind = "attack";
      at = proposed;
    }

    // A boundary that would carve out less than one note's worth of audio is
    // the analysis window sliding across a boundary that is already there.
    if (kind !== null && at - segmentStartSample >= minSegmentSamples) {
      segments.push(
        makeSegment(
          windows,
          segmentFrom,
          i,
          segmentStartSample,
          at,
          boundaryKind,
          samplesPerMs
        )
      );
      segmentFrom = i;
      segmentStartSample = at;
      segmentClass = windowClass;
      trough = window.rms;
      boundaryKind = kind;
      continue;
    }

    if (segmentClass === null) segmentClass = windowClass;
    if (window.rms < trough) trough = window.rms;
  }

  const last = windows[windows.length - 1] as RegionWindowReading;
  segments.push(
    makeSegment(
      windows,
      segmentFrom,
      windows.length,
      segmentStartSample,
      last.toSample,
      boundaryKind,
      samplesPerMs
    )
  );
  return segments;
}
