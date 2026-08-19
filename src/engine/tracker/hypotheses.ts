/**
 * Stateful hypotheses and their curated trail.
 *
 * The old surface had `ambiguity.alternatives`: a flat list of runner-up labels
 * rebuilt from whatever the newest frame happened to see. It could not answer
 * the question a player actually asks when they disagree with the answer —
 * "did you consider X?" — because nothing remembered that X had been leading
 * 200ms ago and then lost.
 *
 * A hypothesis here accumulates. It has a first-seen time, a peak confidence it
 * reached, and a state that only moves in musically meaningful ways:
 *
 *   candidate -> contender -> leading -> confirmed
 *                     \-> superseded | discredited | incorporated
 *
 * Promotion is by *support*, not by a single frame's score: a reading that has
 * been climbing for 300ms and one that appeared this hop are not equally
 * believable even at identical instantaneous confidence. Demotion is separate
 * from deletion — a hypothesis that loses becomes a trail entry with the reason
 * recorded in its state, because that is the interesting part.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { Hypothesis, HypothesisKind, HypothesisState, SourceTimeMs } from "../../types.js";

/** Support (in evidence-weighted hops) below which a reading stays a candidate. */
const CONTENDER_SUPPORT = 2;
/** Support at which the leading hypothesis is considered settled. */
const CONFIRMED_SUPPORT = 8;
/** How far ahead of the runner-up the leader must be to confirm. */
const CONFIRM_MARGIN = 0.15;
/** Active hypotheses kept per kind. Everything else moves to the trail. */
const MAX_ACTIVE_PER_KIND = 4;
/** Trail entries kept per Note. Oldest go first. */
const MAX_TRAIL = 12;

type Record = {
  id: string;
  kind: HypothesisKind;
  label: string;
  state: HypothesisState;
  confidence: number;
  peakConfidence: number;
  firstSeenAt: SourceTimeMs;
  lastUpdatedAt: SourceTimeMs;
  resolvedInto: string | undefined;
  /** Evidence-weighted hop count. The thing promotion is actually based on. */
  support: number;
};

export type HypothesisTransition = {
  hypothesis: Hypothesis;
  from: HypothesisState;
  to: HypothesisState;
};

export class StatefulHypothesisTracker {
  private readonly active = new Map<string, Record>();
  private readonly trail: Record[] = [];
  private nextId = 1;

  constructor(private readonly noteId: string) {}

  /**
   * Fold one hop's reading into the hypothesis for `label`, creating it if this
   * is the first time it has been seen.
   */
  observe(
    kind: HypothesisKind,
    label: string,
    confidence: number,
    at: SourceTimeMs
  ): void {
    const key = `${kind}:${label}`;
    let record = this.active.get(key);
    if (record === undefined) {
      record = {
        id: `${this.noteId}-h${this.nextId++}`,
        kind,
        label,
        state: "candidate",
        confidence,
        peakConfidence: confidence,
        firstSeenAt: at,
        lastUpdatedAt: at,
        resolvedInto: undefined,
        support: 0,
      };
      this.active.set(key, record);
    }
    record.confidence = confidence;
    record.peakConfidence = Math.max(record.peakConfidence, confidence);
    record.lastUpdatedAt = at;
    // Weight support by the confidence of the evidence, so ten hops of a weak
    // reading do not outrank three hops of a strong one.
    record.support += Math.max(0, Math.min(1, confidence));
  }

  /**
   * Re-rank one kind and move states accordingly. Returns every transition, so
   * the caller can emit `hypothesisPromoted`/`hypothesisDiscredited` changes
   * without diffing anything.
   */
  settle(kind: HypothesisKind, at: SourceTimeMs): HypothesisTransition[] {
    const of = [...this.active.values()].filter((r) => r.kind === kind);
    if (of.length === 0) return [];

    of.sort((a, b) => b.support - a.support || b.confidence - a.confidence);
    const leader = of[0] as Record;
    const runnerUp = of[1];

    const transitions: HypothesisTransition[] = [];
    const move = (record: Record, to: HypothesisState): void => {
      if (record.state === to) return;
      const from = record.state;
      record.state = to;
      record.lastUpdatedAt = at;
      transitions.push({ hypothesis: snapshotOf(record), from, to });
    };

    for (let i = 0; i < of.length; i++) {
      const record = of[i] as Record;
      if (record === leader) {
        const confirmable =
          record.support >= CONFIRMED_SUPPORT &&
          (runnerUp === undefined ||
            record.support - runnerUp.support >= CONFIRM_MARGIN * record.support);
        move(record, confirmable ? "confirmed" : "leading");
      } else if (record.support >= CONTENDER_SUPPORT) {
        move(record, "contender");
      } else {
        move(record, "candidate");
      }
    }

    // Anything past the active budget stops being entertained. It is demoted,
    // not deleted: what was considered and rejected is the useful part.
    for (let i = MAX_ACTIVE_PER_KIND; i < of.length; i++) {
      const record = of[i] as Record;
      move(record, "discredited");
      this.retire(record);
    }

    return transitions;
  }

  /** The current leader for a kind, if there is one. */
  leader(kind: HypothesisKind): Hypothesis | null {
    let best: Record | null = null;
    for (const record of this.active.values()) {
      if (record.kind !== kind) continue;
      if (best === null || record.support > best.support) best = record;
    }
    return best === null ? null : snapshotOf(best);
  }

  /**
   * Mark `label` as having been replaced by a better explanation. The loser
   * keeps its trail entry and points at whatever replaced it, so a consumer can
   * follow "I said A, now I say B" back to the evidence.
   */
  supersede(kind: HypothesisKind, label: string, byLabel: string, at: SourceTimeMs): void {
    const record = this.active.get(`${kind}:${label}`);
    if (record === undefined) return;
    const winner = this.active.get(`${kind}:${byLabel}`);
    record.state = "superseded";
    record.resolvedInto = winner?.id;
    record.lastUpdatedAt = at;
    this.retire(record);
  }

  /** Mark a pitch hypothesis as folded into a harmony that explains it. */
  incorporate(kind: HypothesisKind, label: string, intoLabel: string, at: SourceTimeMs): void {
    const record = this.active.get(`${kind}:${label}`);
    if (record === undefined) return;
    const winner = this.active.get(`harmony:${intoLabel}`);
    record.state = "incorporated";
    record.resolvedInto = winner?.id;
    record.lastUpdatedAt = at;
    this.retire(record);
  }

  snapshot(): { active: Hypothesis[]; trail: Hypothesis[] } {
    const active = [...this.active.values()]
      .sort((a, b) => b.support - a.support)
      .map(snapshotOf);
    return { active, trail: this.trail.map(snapshotOf) };
  }

  private retire(record: Record): void {
    this.active.delete(`${record.kind}:${record.label}`);
    this.trail.push(record);
    if (this.trail.length > MAX_TRAIL) this.trail.shift();
  }
}

function snapshotOf(record: Record): Hypothesis {
  const out: Hypothesis = {
    id: record.id,
    kind: record.kind,
    label: record.label,
    state: record.state,
    confidence: record.confidence,
    peakConfidence: record.peakConfidence,
    firstSeenAt: record.firstSeenAt,
    lastUpdatedAt: record.lastUpdatedAt,
  };
  if (record.resolvedInto !== undefined) out.resolvedInto = record.resolvedInto;
  return out;
}
