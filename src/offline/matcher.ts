/**
 * Matching and scoring for the offline eval harness.
 *
 * This module answers one question: given a list of ground-truth labels and a
 * list of detected `MusicEvent`s, which detection corresponds to which label,
 * and how good was the correspondence?
 *
 * It is deliberately dependency-free — no audio, no detector, not even
 * `core/notes.js`. That is the point: the scoring rules have to be trustworthy
 * *before* the detector works, so they are unit-testable on hand-built cases.
 *
 * Two conventions used throughout:
 *  - A "canonical" note is sharp-spelled scientific notation, e.g. `A#2`.
 *  - A "canonical" chord is `root:quality`, e.g. `C:maj`, `A:m11`, `C:5`.
 *    The colon form exists so a chord can never accidentally compare equal to a
 *    note (`C5` the power chord vs. `C5` the note two octaves above middle C —
 *    both appear in these fixtures, which is exactly why parsing is kind-aware).
 */

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/** One entry from a `fixtures/labels/*.json` `events` array. */
export type LabeledEvent = {
  id: string;
  startMs: number;
  endMs: number;
  kind: "note" | "chord" | "unknown";
  /** Human label, e.g. "B2", "Cmaj9", "A3 bend to B3". */
  label: string;
  /**
   * For a note: the pitches this single event takes (a bend lists both ends).
   * For a chord: the voicing's component notes — NOT alternative labels.
   */
  pitches?: string[];
  pitchClasses?: string[];
  /** Present on a bent note. The bend target is an accepted answer. */
  bendTo?: string;
  voicing?: string;
  required?: boolean;
};

/**
 * The subset of `MusicEvent` the matcher needs. A real `MusicEvent` satisfies
 * this structurally, so `eval.ts` passes them straight through and tests can
 * hand-build two-line literals.
 */
export type DetectedEvent = {
  id: string;
  kind: string;
  startedAt: number;
  endedAt: number | null;
  label: { name: string };
  confidence: number;
};

/* -------------------------------------------------------------------------- */
/* Label parsing                                                               */
/* -------------------------------------------------------------------------- */

const LETTER_SEMITONE: Readonly<Record<string, number>> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

const SHARP_NAMES: readonly string[] = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/** Alias table for chord qualities. Keys are lowercased suffixes. */
const QUALITY_ALIASES: Readonly<Record<string, string>> = {
  "": "maj", "maj": "maj", "major": "maj", "M": "maj", "ma": "maj",
  "m": "min", "min": "min", "minor": "min", "-": "min",
  "5": "5", "no3": "5", "power": "5",
  "7": "7", "dom7": "7",
  "m7": "m7", "min7": "m7", "-7": "m7",
  "maj7": "maj7", "M7": "maj7", "ma7": "maj7",
  "maj9": "maj9", "M9": "maj9", "ma9": "maj9",
  "m9": "m9", "min9": "m9",
  "m11": "m11", "min11": "m11", "-11": "m11",
  "11": "11", "9": "9", "6": "6", "m6": "m6", "min6": "m6",
  "add9": "add9", "sus": "sus4", "sus2": "sus2", "sus4": "sus4",
  "dim": "dim", "aug": "aug",
};

function accidentalShift(accidentals: string): number {
  let shift = 0;
  for (const ch of accidentals) {
    if (ch === "#" || ch === "♯") shift += 1;
    else if (ch === "b" || ch === "♭") shift -= 1;
  }
  return shift;
}

/** A label resolved into comparable parts. */
export type ParsedLabel = {
  raw: string;
  /** Sharp-spelled root, e.g. "F#". Null when unparseable or `unknown`. */
  pitchClass: string | null;
  /** Scientific octave. Only ever set for notes. */
  octave: number | null;
  /** Normalised chord quality. Null for notes. */
  quality: string | null;
  /** `A#2` for a note, `A:m11` for a chord, null when unparseable. */
  canonical: string | null;
  /** The label is an explicit abstention. */
  isUnknown: boolean;
};

const UNPARSEABLE: ParsedLabel = {
  raw: "", pitchClass: null, octave: null, quality: null,
  canonical: null, isUnknown: false,
};

/** True when a label is the detector's honest "I don't know". */
export function isAbstentionLabel(name: string): boolean {
  return name.trim().toLowerCase() === "unknown";
}

/**
 * Parse a label. `kind` is load-bearing: `"C5"` is the C power chord as a chord
 * and the note C in octave 5 as a note.
 */
export function parseLabel(raw: string, kind: string): ParsedLabel {
  const text = (raw ?? "").trim();
  if (text === "") return { ...UNPARSEABLE, raw: text };
  if (isAbstentionLabel(text)) {
    return { ...UNPARSEABLE, raw: text, isUnknown: true };
  }

  if (kind === "chord") {
    const m = /^([A-Ga-g])([#b♯♭]*)(.*)$/.exec(text);
    if (!m) return { ...UNPARSEABLE, raw: text };
    const letter = (m[1] as string).toUpperCase();
    const base = LETTER_SEMITONE[letter];
    if (base === undefined) return { ...UNPARSEABLE, raw: text };
    const pcIndex = (((base + accidentalShift(m[2] ?? "")) % 12) + 12) % 12;
    const pitchClass = SHARP_NAMES[pcIndex] as string;

    // A slash bass ("C/G") does not change the chord's identity here.
    const suffix = (m[3] ?? "").split("/")[0] ?? "";
    const quality = normaliseQuality(suffix);
    return {
      raw: text, pitchClass, octave: null, quality,
      canonical: `${pitchClass}:${quality}`, isUnknown: false,
    };
  }

  // Notes (and anything else) parse as scientific pitch notation.
  const m = /^([A-Ga-g])([#b♯♭]*)(-?\d+)$/.exec(text);
  if (!m) return { ...UNPARSEABLE, raw: text };
  const letter = (m[1] as string).toUpperCase();
  const base = LETTER_SEMITONE[letter];
  if (base === undefined) return { ...UNPARSEABLE, raw: text };

  const shifted = base + accidentalShift(m[2] ?? "");
  const octaveRaw = Number.parseInt(m[3] as string, 10);
  // "Cb4" belongs to octave 3, "B#3" to octave 4. Keep octaves musical.
  const absolute = (octaveRaw + 1) * 12 + shifted;
  const pcIndex = ((absolute % 12) + 12) % 12;
  const octave = Math.floor(absolute / 12) - 1;
  const pitchClass = SHARP_NAMES[pcIndex] as string;

  return {
    raw: text, pitchClass, octave, quality: null,
    canonical: `${pitchClass}${octave}`, isUnknown: false,
  };
}

function normaliseQuality(suffix: string): string {
  const trimmed = suffix.trim();
  const direct = QUALITY_ALIASES[trimmed];
  if (direct !== undefined) return direct;
  const lower = QUALITY_ALIASES[trimmed.toLowerCase()];
  if (lower !== undefined) return lower;
  return trimmed.toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* Acceptance sets                                                             */
/* -------------------------------------------------------------------------- */

export type AcceptedAnswer = {
  /** Canonical forms that count as an exact match. */
  canonical: Set<string>;
  /** Pitch classes that count as a pitch-class match. */
  pitchClasses: Set<string>;
};

/**
 * The set of answers that count as correct for one label.
 *
 * For a bent note (`q7`: "A3 bend to B3") both endpoints are accepted, so a
 * single detected event calling it either A3 or B3 is credited. The tracker is
 * contractually required to keep a bend as ONE event, so matching stays
 * one-to-one and a split bend correctly shows up as a false positive.
 */
export function acceptedAnswers(label: LabeledEvent): AcceptedAnswer {
  const canonical = new Set<string>();
  const pitchClasses = new Set<string>();

  const add = (raw: string | undefined, kind: string): void => {
    if (!raw) return;
    const parsed = parseLabel(raw, kind);
    if (parsed.canonical) canonical.add(parsed.canonical);
    if (parsed.pitchClass) pitchClasses.add(parsed.pitchClass);
  };

  if (label.kind === "chord") {
    // `pitches` is the voicing, not a set of alternative names.
    add(label.label, "chord");
  } else {
    const alternatives = label.pitches && label.pitches.length > 0
      ? label.pitches
      : [label.label];
    for (const name of alternatives) add(name, "note");
    add(label.bendTo, "note");
    // "A3 bend to B3" itself will not parse; that is fine, `pitches` covered it.
    if (canonical.size === 0) add(label.label, "note");
  }

  if (label.pitchClasses) {
    for (const pc of label.pitchClasses) {
      const parsed = parseLabel(`${pc}4`, "note");
      if (parsed.pitchClass) pitchClasses.add(parsed.pitchClass);
    }
  }

  return { canonical, pitchClasses };
}

/** How a detection compares against one label. */
export type LabelAgreement = {
  exact: boolean;
  pitchClass: boolean;
  /** Pitch class agrees but the octave does not — the classic label-estimate case. */
  octaveOnly: boolean;
};

export function compareLabels(label: LabeledEvent, detection: DetectedEvent): LabelAgreement {
  if (isAbstentionLabel(detection.label.name)) {
    return { exact: false, pitchClass: false, octaveOnly: false };
  }
  const accepted = acceptedAnswers(label);
  const parsed = parseLabel(detection.label.name, detection.kind);

  const exact = parsed.canonical !== null && accepted.canonical.has(parsed.canonical);
  const pitchClass = parsed.pitchClass !== null && accepted.pitchClasses.has(parsed.pitchClass);
  return { exact, pitchClass, octaveOnly: pitchClass && !exact && parsed.octave !== null };
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

/** A detection whose onset is within this of a label's onset is a candidate. */
export const ONSET_WINDOW_MS = 300;

/**
 * Score weights. Onset proximity dominates; label agreement breaks ties.
 *
 * `W_IN_WINDOW` is larger than every other term combined, so a pair whose
 * onsets actually line up always outranks a pair that merely overlaps. Without
 * it, a long merged detection gets assigned to whichever label it happens to
 * agree with — a 5s event covering D, Em and G matches the G three bars away,
 * and the report claims a 3.8s timing error instead of the merge that really
 * happened. Overlap-only pairing is the fallback for when nothing lines up.
 */
const W_IN_WINDOW = 4.0;
const W_ONSET = 1.0;
const W_LABEL = 0.75;
const W_OVERLAP = 0.25;
const AGREE_EXACT = 1.0;
const AGREE_PITCH_CLASS = 0.6;

export type Match = {
  label: LabeledEvent;
  labelIndex: number;
  detection: DetectedEvent;
  detectionIndex: number;
  score: number;
  /** Signed, detection minus label. Positive means the detection was late. */
  onsetDeltaMs: number;
  /** Signed, detection minus label. Null when the detection never ended. */
  endDeltaMs: number | null;
  agreement: LabelAgreement;
  /** The detection honestly abstained (`label.name === "unknown"`). */
  abstained: boolean;
};

export type MatchResult = {
  matches: Match[];
  missed: Array<{ label: LabeledEvent; labelIndex: number }>;
  falsePositives: Array<{ detection: DetectedEvent; detectionIndex: number }>;
};

export type MatchOptions = {
  /** Candidate window for onset-only pairing. Default `ONSET_WINDOW_MS`. */
  onsetWindowMs?: number;
};

function detectionEnd(detection: DetectedEvent): number {
  return detection.endedAt ?? detection.startedAt;
}

function overlapMs(label: LabeledEvent, detection: DetectedEvent): number {
  const start = Math.max(label.startMs, detection.startedAt);
  const end = Math.min(label.endMs, detectionEnd(detection));
  return Math.max(0, end - start);
}

/**
 * One-to-one greedy best-first assignment.
 *
 * Candidate pairs need time overlap OR an onset within `onsetWindowMs`. Pairs
 * are scored, sorted, and assigned greedily; each label and each detection can
 * be used at most once, so two detections competing for one label produce
 * exactly one match and one false positive.
 */
export function matchEvents(
  labels: readonly LabeledEvent[],
  detections: readonly DetectedEvent[],
  options: MatchOptions = {}
): MatchResult {
  const window = options.onsetWindowMs ?? ONSET_WINDOW_MS;

  type Pair = {
    labelIndex: number;
    detectionIndex: number;
    score: number;
    onsetDeltaMs: number;
    agreement: LabelAgreement;
  };

  const pairs: Pair[] = [];

  for (let li = 0; li < labels.length; li++) {
    const label = labels[li] as LabeledEvent;
    for (let di = 0; di < detections.length; di++) {
      const detection = detections[di] as DetectedEvent;

      const onsetDeltaMs = detection.startedAt - label.startMs;
      const overlap = overlapMs(label, detection);
      const onsetAligned = Math.abs(onsetDeltaMs) <= window;
      const isCandidate = overlap > 0 || onsetAligned;
      if (!isCandidate) continue;

      const agreement = compareLabels(label, detection);
      const onsetScore = Math.max(0, 1 - Math.abs(onsetDeltaMs) / window);
      const labelScore = agreement.exact
        ? AGREE_EXACT
        : agreement.pitchClass
          ? AGREE_PITCH_CLASS
          : 0;
      const spans = Math.max(
        1,
        Math.min(label.endMs - label.startMs, detectionEnd(detection) - detection.startedAt)
      );
      const overlapScore = Math.min(1, overlap / spans);

      pairs.push({
        labelIndex: li,
        detectionIndex: di,
        score:
          (onsetAligned ? W_IN_WINDOW : 0) +
          W_ONSET * onsetScore +
          W_LABEL * labelScore +
          W_OVERLAP * overlapScore,
        onsetDeltaMs,
        agreement,
      });
    }
  }

  // Deterministic ordering: best score, then tightest onset, then input order.
  pairs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = Math.abs(a.onsetDeltaMs);
    const db = Math.abs(b.onsetDeltaMs);
    if (da !== db) return da - db;
    if (a.labelIndex !== b.labelIndex) return a.labelIndex - b.labelIndex;
    return a.detectionIndex - b.detectionIndex;
  });

  const usedLabels = new Set<number>();
  const usedDetections = new Set<number>();
  const matches: Match[] = [];

  for (const pair of pairs) {
    if (usedLabels.has(pair.labelIndex)) continue;
    if (usedDetections.has(pair.detectionIndex)) continue;
    usedLabels.add(pair.labelIndex);
    usedDetections.add(pair.detectionIndex);

    const label = labels[pair.labelIndex] as LabeledEvent;
    const detection = detections[pair.detectionIndex] as DetectedEvent;
    matches.push({
      label,
      labelIndex: pair.labelIndex,
      detection,
      detectionIndex: pair.detectionIndex,
      score: pair.score,
      onsetDeltaMs: pair.onsetDeltaMs,
      endDeltaMs: detection.endedAt === null ? null : detection.endedAt - label.endMs,
      agreement: pair.agreement,
      abstained: isAbstentionLabel(detection.label.name),
    });
  }

  matches.sort((a, b) => a.label.startMs - b.label.startMs || a.labelIndex - b.labelIndex);

  const missed = labels
    .map((label, labelIndex) => ({ label, labelIndex }))
    .filter((entry) => !usedLabels.has(entry.labelIndex));

  const falsePositives = detections
    .map((detection, detectionIndex) => ({ detection, detectionIndex }))
    .filter((entry) => !usedDetections.has(entry.detectionIndex));

  return { matches, missed, falsePositives };
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                    */
/* -------------------------------------------------------------------------- */

export type SectionSpec = {
  /** Event ids starting with this belong to the section. */
  idPrefix?: string;
  startMs?: number;
  endMs?: number;
  /** False excludes the section from the required gate — never from the report. */
  required?: boolean;
};

export type SectionMap = Readonly<Record<string, SectionSpec>>;

/** Longest id prefix wins; falls back to time containment. */
export function sectionForLabel(label: LabeledEvent, sections: SectionMap): string | null {
  let best: string | null = null;
  let bestLength = -1;
  for (const [name, spec] of Object.entries(sections)) {
    if (spec.idPrefix && label.id.startsWith(spec.idPrefix) && spec.idPrefix.length > bestLength) {
      best = name;
      bestLength = spec.idPrefix.length;
    }
  }
  if (best !== null) return best;

  for (const [name, spec] of Object.entries(sections)) {
    if (spec.startMs === undefined || spec.endMs === undefined) continue;
    if (label.startMs >= spec.startMs && label.startMs < spec.endMs) return name;
  }
  return null;
}

/** A detection belongs to whichever section's time window contains its onset. */
export function sectionForDetection(
  detection: DetectedEvent,
  sections: SectionMap
): string | null {
  for (const [name, spec] of Object.entries(sections)) {
    if (spec.startMs === undefined || spec.endMs === undefined) continue;
    if (detection.startedAt >= spec.startMs && detection.startedAt < spec.endMs) return name;
  }
  return null;
}

/**
 * Restrict a match result to a subset without re-matching.
 *
 * Matching runs once over the whole fixture — that is the real behaviour — and
 * the result is partitioned afterwards, so excluding a section from the gate
 * can never change how the rest of the take was matched.
 */
export function filterResult(
  result: MatchResult,
  keepLabel: (label: LabeledEvent) => boolean,
  keepDetection: (detection: DetectedEvent) => boolean
): MatchResult {
  return {
    matches: result.matches.filter((m) => keepLabel(m.label)),
    missed: result.missed.filter((m) => keepLabel(m.label)),
    falsePositives: result.falsePositives.filter((f) => keepDetection(f.detection)),
  };
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (idx - lo);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export type ConfidentDisagreement = {
  labelId: string;
  labelKind: string;
  expected: string;
  detected: string;
  confidence: number;
  onsetDeltaMs: number;
  detectedStartMs: number;
  detectedEndMs: number | null;
  /** What kind of disagreement it is — octave-only is the likely label fix. */
  disagreement: "octave" | "quality" | "pitchClass";
};

export type ScoreOptions = {
  /** A detection at or above this confidence is "confident". Default 0.6. */
  confidentLabelThreshold?: number;
  /** Which agreement a confidently-wrong label must fail. Default "pitchClass". */
  confidentlyWrongOn?: "exact" | "pitchClass";
};

export type EvalStats = {
  labelCount: number;
  detectionCount: number;
  matchedCount: number;
  missedCount: number;
  falsePositiveCount: number;

  /** Matched detections that said "unknown". Honest abstention, not an error. */
  abstainedCount: number;
  /** Every detection that said "unknown", matched or not. */
  unknownDetectionCount: number;
  /** `unknownDetectionCount / detectionCount` — the honest-abstention rate. */
  abstentionRate: number | null;

  /** Labels that actually got a committed answer — the accuracy denominator. */
  scoredLabelCount: number;
  exactCorrect: number;
  pitchClassCorrect: number;
  /** `exactCorrect / scoredLabelCount`. Null when nothing was scored. */
  exactAccuracy: number | null;
  pitchClassAccuracy: number | null;
  /** Correct but only on pitch class — an octave disagreement. */
  octaveOnlyCount: number;

  confidentlyWrongCount: number;
  confidentlyWrong: ConfidentDisagreement[];

  onsetErrorMs: {
    medianSigned: number | null;
    p90Signed: number | null;
    medianAbs: number | null;
    p90Abs: number | null;
  };
  endErrorMs: {
    medianSigned: number | null;
    medianAbs: number | null;
  };

  meanConfidenceMatched: number | null;
  meanConfidenceUnmatched: number | null;
};

/**
 * Turn a match result into the numbers the report prints.
 *
 * Accuracy denominator: every label in scope, MINUS the ones whose matched
 * detection abstained. So a missed label counts against accuracy (a detector
 * cannot win by staying quiet on the hard notes), while an honest "unknown"
 * does not count as a wrong answer — it shows up in `abstentionRate` instead.
 */
export function scoreMatches(result: MatchResult, options: ScoreOptions = {}): EvalStats {
  const confidentThreshold = options.confidentLabelThreshold ?? 0.6;
  const wrongOn = options.confidentlyWrongOn ?? "pitchClass";

  const labelCount = result.matches.length + result.missed.length;
  const detectionCount = result.matches.length + result.falsePositives.length;

  const decided = result.matches.filter((m) => !m.abstained);
  const abstainedCount = result.matches.length - decided.length;
  const scoredLabelCount = labelCount - abstainedCount;
  const unknownDetectionCount =
    abstainedCount +
    result.falsePositives.filter((f) => isAbstentionLabel(f.detection.label.name)).length;

  const exactCorrect = decided.filter((m) => m.agreement.exact).length;
  const pitchClassCorrect = decided.filter((m) => m.agreement.pitchClass).length;
  const octaveOnlyCount = decided.filter((m) => m.agreement.octaveOnly).length;

  const confidentlyWrong: ConfidentDisagreement[] = decided
    .filter((m) => {
      if (m.detection.confidence < confidentThreshold) return false;
      return wrongOn === "exact" ? !m.agreement.exact : !m.agreement.pitchClass;
    })
    .map((m) => ({
      labelId: m.label.id,
      labelKind: m.label.kind,
      expected: m.label.label,
      detected: m.detection.label.name,
      confidence: m.detection.confidence,
      onsetDeltaMs: m.onsetDeltaMs,
      detectedStartMs: m.detection.startedAt,
      detectedEndMs: m.detection.endedAt,
      disagreement: m.agreement.octaveOnly
        ? "octave"
        : m.agreement.pitchClass
          ? "quality"
          : "pitchClass",
    }));

  const onsetErrors = result.matches.map((m) => m.onsetDeltaMs);
  const onsetAbs = onsetErrors.map(Math.abs);
  const endErrors = result.matches
    .map((m) => m.endDeltaMs)
    .filter((v): v is number => v !== null);

  return {
    labelCount,
    detectionCount,
    matchedCount: result.matches.length,
    missedCount: result.missed.length,
    falsePositiveCount: result.falsePositives.length,

    abstainedCount,
    unknownDetectionCount,
    abstentionRate: detectionCount > 0 ? unknownDetectionCount / detectionCount : null,

    scoredLabelCount,
    exactCorrect,
    pitchClassCorrect,
    exactAccuracy: scoredLabelCount > 0 ? exactCorrect / scoredLabelCount : null,
    pitchClassAccuracy: scoredLabelCount > 0 ? pitchClassCorrect / scoredLabelCount : null,
    octaveOnlyCount,

    confidentlyWrongCount: confidentlyWrong.length,
    confidentlyWrong,

    onsetErrorMs: {
      medianSigned: percentile(onsetErrors, 0.5),
      p90Signed: percentile(onsetErrors, 0.9),
      medianAbs: percentile(onsetAbs, 0.5),
      p90Abs: percentile(onsetAbs, 0.9),
    },
    endErrorMs: {
      medianSigned: percentile(endErrors, 0.5),
      medianAbs: percentile(endErrors.map(Math.abs), 0.5),
    },

    meanConfidenceMatched: mean(result.matches.map((m) => m.detection.confidence)),
    meanConfidenceUnmatched: mean(
      result.falsePositives.map((f) => f.detection.confidence)
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Thresholds                                                                  */
/* -------------------------------------------------------------------------- */

export type Thresholds = {
  /** Which accuracy `minLabelAccuracy` is checked against. */
  gateOn?: "exact" | "pitchClass";
  minLabelAccuracy?: number;
  /** Checked against the ABSOLUTE median onset error. */
  maxMedianOnsetErrorMs?: number;
  maxP90OnsetErrorMs?: number;
  maxFalsePositives?: number;
  maxMissed?: number;
  /** Cap on confidently-wrong labels. The pass criterion for spicy chords. */
  maxFalseLabels?: number;
};

export type ThresholdCheck = {
  name: string;
  actual: number | null;
  limit: number;
  comparison: "min" | "max";
  passed: boolean;
  /** Why a null actual was treated the way it was. */
  note?: string;
};

/** Evaluate every configured threshold. A null actual fails a real limit. */
export function checkThresholds(stats: EvalStats, thresholds: Thresholds): ThresholdCheck[] {
  const checks: ThresholdCheck[] = [];
  const gateOn = thresholds.gateOn ?? "pitchClass";

  const atLeast = (
    name: string,
    actual: number | null,
    limit: number | undefined,
    note?: string
  ): void => {
    if (limit === undefined) return;
    if (actual === null) {
      // Two different things produce a null accuracy and they deserve opposite
      // verdicts. If labels were in scope and none of them scored, the detector
      // answered nothing about material it was asked about, and passing that
      // would let a detector that emits nothing clear every gate. If no labels
      // were in scope at all - every section of this fixture marked
      // informational - there is nothing to be right or wrong about, and
      // failing it reports a defect that does not exist.
      const nothingInScope = stats.labelCount === 0;
      checks.push({
        name, actual, limit, comparison: "min",
        passed: nothingInScope || limit <= 0,
        note: note ?? (nothingInScope ? "no labels in scope" : "no scored labels"),
      });
      return;
    }
    checks.push({ name, actual, limit, comparison: "min", passed: actual >= limit - 1e-9 });
  };

  const atMost = (name: string, actual: number | null, limit: number | undefined): void => {
    if (limit === undefined) return;
    if (actual === null) {
      checks.push({
        name, actual, limit, comparison: "max",
        passed: true,
        note: "nothing matched",
      });
      return;
    }
    checks.push({ name, actual, limit, comparison: "max", passed: actual <= limit + 1e-9 });
  };

  atLeast(
    `minLabelAccuracy (${gateOn})`,
    gateOn === "exact" ? stats.exactAccuracy : stats.pitchClassAccuracy,
    thresholds.minLabelAccuracy
  );
  atMost("maxMedianOnsetErrorMs", stats.onsetErrorMs.medianAbs, thresholds.maxMedianOnsetErrorMs);
  atMost("maxP90OnsetErrorMs", stats.onsetErrorMs.p90Abs, thresholds.maxP90OnsetErrorMs);
  atMost("maxFalsePositives", stats.falsePositiveCount, thresholds.maxFalsePositives);
  atMost("maxMissed", stats.missedCount, thresholds.maxMissed);
  atMost("maxFalseLabels", stats.confidentlyWrongCount, thresholds.maxFalseLabels);

  return checks;
}
