/**
 * Notes -> the flat `DetectedEvent` shape the eval matcher scores.
 *
 * The matcher is deliberately dependency-free and its contract is fixed: an id,
 * a kind, a start, an end, one label name, a confidence. A `Note` is a great
 * deal richer than that, so something has to decide which of a Note's several
 * answers is *the* answer. That decision lives here rather than in the matcher,
 * because it is a property of the recognizer, not of the scoring rules.
 *
 * Two projections come out of one run:
 *
 *  - **final** — the Note as it stood when it ended, after every correction the
 *    deep lane made. This is what the accuracy gates score, because it is what
 *    a consumer who waited for `noteEnded` would have seen.
 *  - **fast**  — the Note as it stood at `noteStarted`, before any deep-lane
 *    revision. Reported, never gated: it is the honest measure of how good the
 *    first guess is, and the gap between the two is the value the deep lane
 *    adds. Hiding it would let a recognizer look good while being useless in
 *    real time.
 *
 * Honest abstention survives the projection: a Note that knows it is a chord
 * but will not name it reports `"unknown"`, which the matcher scores as an
 * abstention rather than as a wrong answer.
 */

import type { Note } from "../types.js";
import type { TrackerEmission } from "../engine/tracker/note-tracker.js";
import type { DetectedEvent } from "./matcher.js";

export type EvalProjection = {
  /** One entry per ended Note, in start order. */
  detections: DetectedEvent[];
};

export type EvalProjections = {
  final: DetectedEvent[];
  fast: DetectedEvent[];
  /** Per-Note revision statistics, reported alongside accuracy. */
  revisions: {
    notes: number;
    /** Notes whose final label differs from their first announced label. */
    corrected: number;
    /** Total `noteChanged` emissions across all Notes. */
    changes: number;
    /** ms from `noteStarted` to the first emission carrying the final label. */
    timeToFinalLabelMs: number[];
  };
};

/** The name a Note answers to. Chord if it bloomed, pitch otherwise. */
export function labelOf(note: Note): string {
  if (note.harmony !== undefined) return note.harmony.chordName ?? "unknown";
  return note.pitch.current?.name ?? note.origin.firstDetectedPitch?.name ?? "unknown";
}

/** `"chord"` only when the Note actually believes it is one. */
export function kindOf(note: Note): string {
  return note.harmony !== undefined ? "chord" : "note";
}

function toDetection(note: Note, label: string, endedAt: number | null): DetectedEvent {
  return {
    id: note.id,
    kind: kindOf(note),
    startedAt: note.startTime,
    endedAt,
    label: { name: label },
    confidence: note.confidence,
  };
}

/**
 * Replay an emission stream into both projections.
 *
 * Driven by emissions rather than by the ended Notes alone, because the fast
 * projection needs the Note as it was at `noteStarted` — by the time it ends,
 * that version no longer exists anywhere.
 */
export function projectEmissions(emissions: readonly TrackerEmission[]): EvalProjections {
  const firstLabel = new Map<string, string>();
  const startedAt = new Map<string, number>();
  const changeCount = new Map<string, number>();
  const finalLabelSeenAt = new Map<string, number>();
  const fast: DetectedEvent[] = [];
  const final: DetectedEvent[] = [];

  // A Note's final label is only known at the end, so the "when did it first
  // say that?" question is answered in a second pass over a recorded history
  // of label changes rather than guessed forward.
  const labelHistory = new Map<string, Array<{ at: number; label: string }>>();

  for (const emission of emissions) {
    const note = emission.note;
    switch (emission.type) {
      case "started": {
        const label = labelOf(note);
        firstLabel.set(note.id, label);
        startedAt.set(note.id, note.startTime);
        labelHistory.set(note.id, [{ at: note.startTime, label }]);
        fast.push(toDetection(note, label, null));
        break;
      }
      case "changed": {
        changeCount.set(note.id, (changeCount.get(note.id) ?? 0) + 1);
        const history = labelHistory.get(note.id);
        const label = labelOf(note);
        if (history !== undefined && history[history.length - 1]?.label !== label) {
          history.push({ at: emission.change.at, label });
        }
        break;
      }
      case "ended": {
        const label = labelOf(note);
        final.push(toDetection(note, label, note.endTime));
        const history = labelHistory.get(note.id) ?? [];
        const first = history.find((entry) => entry.label === label);
        if (first !== undefined) {
          finalLabelSeenAt.set(note.id, first.at - (startedAt.get(note.id) ?? note.startTime));
        }
        break;
      }
      default:
        break;
    }
  }

  // The fast projection has to span the same timeline as the final one, or the
  // matcher's overlap rule scores it differently for reasons that have nothing
  // to do with labels.
  const endById = new Map(final.map((d) => [d.id, d.endedAt]));
  for (const detection of fast) detection.endedAt = endById.get(detection.id) ?? null;

  // A fast detection for a Note that never ended has nothing to compare against.
  const fastScored = fast.filter((d) => endById.has(d.id));

  const corrected = final.filter((d) => firstLabel.get(d.id) !== d.label.name).length;
  let changes = 0;
  for (const count of changeCount.values()) changes += count;

  final.sort((a, b) => a.startedAt - b.startedAt);
  fastScored.sort((a, b) => a.startedAt - b.startedAt);

  return {
    final,
    fast: fastScored,
    revisions: {
      notes: final.length,
      corrected,
      changes,
      timeToFinalLabelMs: [...finalLabelSeenAt.values()],
    },
  };
}
