/**
 * Unit tests for the eval harness's matching and scoring rules.
 *
 * Everything here is hand-built: no audio, no detector, no engine. That is the
 * whole point — the scoring must be trustworthy *before* the detector works, so
 * that when the eval says "missed 4, 2 false positives" the numbers can be
 * believed rather than debugged alongside the DSP.
 */

import { describe, expect, it } from "vitest";
import { downmixToMono, readWav, writeWav } from "../src/offline/wav.js";
import {
  ONSET_WINDOW_MS,
  acceptedAnswers,
  checkThresholds,
  compareLabels,
  filterResult,
  isAbstentionLabel,
  matchEvents,
  parseLabel,
  scoreMatches,
  sectionForDetection,
  sectionForLabel,
  type DetectedEvent,
  type LabeledEvent,
} from "../src/offline/matcher.js";

/* -------------------------------------------------------------------------- */
/* Builders                                                                    */
/* -------------------------------------------------------------------------- */

function label(
  id: string,
  startMs: number,
  endMs: number,
  name: string,
  extra: Partial<LabeledEvent> = {}
): LabeledEvent {
  return { id, startMs, endMs, kind: "note", label: name, pitches: [name], ...extra };
}

function chordLabel(
  id: string,
  startMs: number,
  endMs: number,
  name: string,
  extra: Partial<LabeledEvent> = {}
): LabeledEvent {
  return { id, startMs, endMs, kind: "chord", label: name, ...extra };
}

function detected(
  id: string,
  startedAt: number,
  endedAt: number | null,
  name: string,
  confidence = 0.9,
  kind = "note"
): DetectedEvent {
  return { id, kind, startedAt, endedAt, label: { name }, confidence };
}

/* -------------------------------------------------------------------------- */
/* Label parsing                                                               */
/* -------------------------------------------------------------------------- */

describe("parseLabel", () => {
  it("parses scientific pitch notation", () => {
    expect(parseLabel("A4", "note")).toMatchObject({
      pitchClass: "A",
      octave: 4,
      canonical: "A4",
    });
    expect(parseLabel("F#3", "note")).toMatchObject({ pitchClass: "F#", octave: 3 });
    expect(parseLabel("E2", "note")).toMatchObject({ pitchClass: "E", octave: 2 });
  });

  it("normalises flats to sharps", () => {
    expect(parseLabel("Bb2", "note").canonical).toBe("A#2");
    expect(parseLabel("Db4", "note").canonical).toBe("C#4");
  });

  it("keeps octave boundaries musical for edge accidentals", () => {
    // Cb4 sounds a semitone below C4, i.e. B3.
    expect(parseLabel("Cb4", "note").canonical).toBe("B3");
    expect(parseLabel("B#3", "note").canonical).toBe("C4");
  });

  it("parses chord labels into root and quality", () => {
    expect(parseLabel("C", "chord")).toMatchObject({ pitchClass: "C", quality: "maj" });
    expect(parseLabel("Em", "chord")).toMatchObject({ pitchClass: "E", quality: "min" });
    expect(parseLabel("Am11", "chord")).toMatchObject({ pitchClass: "A", quality: "m11" });
    expect(parseLabel("Cmaj9", "chord")).toMatchObject({ pitchClass: "C", quality: "maj9" });
    expect(parseLabel("F#5", "chord")).toMatchObject({ pitchClass: "F#", quality: "5" });
  });

  it("does not confuse the C5 power chord with the note C5", () => {
    // Both spellings appear in these fixtures. Kind is what disambiguates them.
    const powerChord = parseLabel("C5", "chord");
    const note = parseLabel("C5", "note");
    expect(powerChord.canonical).toBe("C:5");
    expect(note.canonical).toBe("C5");
    expect(powerChord.canonical).not.toBe(note.canonical);
  });

  it("treats 'unknown' as an abstention, not a parse failure", () => {
    expect(isAbstentionLabel("unknown")).toBe(true);
    expect(isAbstentionLabel("UNKNOWN")).toBe(true);
    expect(isAbstentionLabel("Am")).toBe(false);
    expect(parseLabel("unknown", "chord")).toMatchObject({
      isUnknown: true,
      canonical: null,
    });
  });

  it("returns a null canonical for prose it cannot parse", () => {
    expect(parseLabel("A3 bend to B3", "note").canonical).toBeNull();
    expect(parseLabel("", "note").canonical).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance and agreement                                                    */
/* -------------------------------------------------------------------------- */

describe("acceptedAnswers", () => {
  it("accepts both endpoints of a bend", () => {
    const bend = label("q7", 6950, 7950, "A3 bend to B3", {
      pitches: ["A3", "B3"],
      pitchClasses: ["A", "B"],
      bendTo: "B3",
    });
    const accepted = acceptedAnswers(bend);
    expect([...accepted.canonical].sort()).toEqual(["A3", "B3"]);
    expect([...accepted.pitchClasses].sort()).toEqual(["A", "B"]);
  });

  it("treats a chord's pitches as a voicing, not as alternative names", () => {
    const chord = chordLabel("sp1", 5180, 8880, "Cmaj9", {
      pitches: ["C3", "E3", "B3", "D4", "E4"],
    });
    const accepted = acceptedAnswers(chord);
    // E3 is in the voicing but "E" is not an acceptable answer for a Cmaj9.
    expect([...accepted.canonical]).toEqual(["C:maj9"]);
    expect([...accepted.pitchClasses]).toEqual(["C"]);
  });
});

describe("compareLabels", () => {
  const target = label("q1", 1000, 1500, "B2");

  it("scores an exact hit", () => {
    expect(compareLabels(target, detected("d", 1000, 1500, "B2"))).toEqual({
      exact: true,
      pitchClass: true,
      octaveOnly: false,
    });
  });

  it("separates an octave error from a pitch-class error", () => {
    // The label files say octaves are first-pass estimates, so this distinction
    // is how a detector bug is told apart from a label estimate.
    expect(compareLabels(target, detected("d", 1000, 1500, "B3"))).toEqual({
      exact: false,
      pitchClass: true,
      octaveOnly: true,
    });
    expect(compareLabels(target, detected("d", 1000, 1500, "C3"))).toEqual({
      exact: false,
      pitchClass: false,
      octaveOnly: false,
    });
  });

  it("credits either end of a bend as exact", () => {
    const bend = label("q7", 6950, 7950, "A3 bend to B3", {
      pitches: ["A3", "B3"],
      pitchClasses: ["A", "B"],
      bendTo: "B3",
    });
    expect(compareLabels(bend, detected("d", 6950, 7950, "A3")).exact).toBe(true);
    expect(compareLabels(bend, detected("d", 6950, 7950, "B3")).exact).toBe(true);
    expect(compareLabels(bend, detected("d", 6950, 7950, "G3")).pitchClass).toBe(false);
  });

  it("never counts an abstention as agreement", () => {
    const agreement = compareLabels(target, detected("d", 1000, 1500, "unknown"));
    expect(agreement).toEqual({ exact: false, pitchClass: false, octaveOnly: false });
  });

  it("matches chord roots across quality mismatches", () => {
    const chord = chordLabel("c1", 0, 2000, "Am");
    expect(compareLabels(chord, detected("d", 0, 2000, "Am", 0.9, "chord")).exact).toBe(true);
    const wrongQuality = compareLabels(chord, detected("d", 0, 2000, "Am7", 0.9, "chord"));
    expect(wrongQuality).toMatchObject({ exact: false, pitchClass: true });
    const wrongRoot = compareLabels(chord, detected("d", 0, 2000, "Em", 0.9, "chord"));
    expect(wrongRoot).toMatchObject({ exact: false, pitchClass: false });
  });

  it("accepts a bare major spelled either way", () => {
    const chord = chordLabel("c1", 0, 2000, "C");
    expect(compareLabels(chord, detected("d", 0, 2000, "C", 0.9, "chord")).exact).toBe(true);
    expect(compareLabels(chord, detected("d", 0, 2000, "Cmaj", 0.9, "chord")).exact).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

describe("matchEvents", () => {
  it("matches a perfect run one-to-one", () => {
    const labels = [
      label("a", 1000, 1500, "B2"),
      label("b", 1500, 2000, "C#3"),
      label("c", 2000, 2500, "D3"),
    ];
    const detections = [
      detected("d1", 1000, 1500, "B2"),
      detected("d2", 1500, 2000, "C#3"),
      detected("d3", 2000, 2500, "D3"),
    ];

    const result = matchEvents(labels, detections);
    expect(result.matches).toHaveLength(3);
    expect(result.missed).toHaveLength(0);
    expect(result.falsePositives).toHaveLength(0);
    expect(result.matches.map((m) => [m.label.id, m.detection.id])).toEqual([
      ["a", "d1"],
      ["b", "d2"],
      ["c", "d3"],
    ]);
    expect(result.matches.every((m) => m.onsetDeltaMs === 0)).toBe(true);
    expect(result.matches.every((m) => m.agreement.exact)).toBe(true);
  });

  it("matches a shifted onset and records the signed delta", () => {
    const labels = [label("a", 1000, 1500, "B2")];
    const late = matchEvents(labels, [detected("d1", 1060, 1560, "B2")]);
    expect(late.matches).toHaveLength(1);
    expect(late.matches[0]?.onsetDeltaMs).toBe(60);
    expect(late.matches[0]?.endDeltaMs).toBe(60);

    const early = matchEvents(labels, [detected("d1", 940, 1440, "B2")]);
    expect(early.matches[0]?.onsetDeltaMs).toBe(-60);
    expect(early.matches[0]?.endDeltaMs).toBe(-60);
  });

  it("reports an unmatched label as missed", () => {
    const labels = [label("a", 1000, 1500, "B2"), label("b", 5000, 5500, "D3")];
    const result = matchEvents(labels, [detected("d1", 1000, 1500, "B2")]);

    expect(result.matches).toHaveLength(1);
    expect(result.missed.map((m) => m.label.id)).toEqual(["b"]);
    expect(result.falsePositives).toHaveLength(0);
  });

  it("reports an unmatched detection as a false positive", () => {
    const labels = [label("a", 1000, 1500, "B2")];
    const result = matchEvents(labels, [
      detected("d1", 1000, 1500, "B2"),
      detected("d2", 8000, 8500, "G3"),
    ]);

    expect(result.matches).toHaveLength(1);
    expect(result.missed).toHaveLength(0);
    expect(result.falsePositives.map((f) => f.detection.id)).toEqual(["d2"]);
  });

  it("lets exactly one of two competing detections win a label", () => {
    // Both detections are plausible for the single label; the matcher must not
    // credit the label twice, and the loser must become a false positive.
    const labels = [label("a", 1000, 1500, "B2")];
    const detections = [
      detected("early", 900, 1400, "B2"),
      detected("exact", 1000, 1500, "B2"),
    ];

    const result = matchEvents(labels, detections);
    expect(result.matches).toHaveLength(1);
    expect(result.falsePositives).toHaveLength(1);
    expect(result.missed).toHaveLength(0);
    // The tighter onset wins.
    expect(result.matches[0]?.detection.id).toBe("exact");
    expect(result.falsePositives[0]?.detection.id).toBe("early");
  });

  it("is order-independent when two detections collide", () => {
    const labels = [label("a", 1000, 1500, "B2")];
    const forwards = matchEvents(labels, [
      detected("early", 900, 1400, "B2"),
      detected("exact", 1000, 1500, "B2"),
    ]);
    const backwards = matchEvents(labels, [
      detected("exact", 1000, 1500, "B2"),
      detected("early", 900, 1400, "B2"),
    ]);
    expect(forwards.matches[0]?.detection.id).toBe(backwards.matches[0]?.detection.id);
    expect(forwards.matches).toHaveLength(1);
    expect(backwards.matches).toHaveLength(1);
  });

  it("prefers the agreeing label when onsets are equally close", () => {
    const labels = [label("a", 1000, 1500, "B2")];
    const result = matchEvents(labels, [
      detected("wrong", 1050, 1550, "G3"),
      detected("right", 1050, 1550, "B2"),
    ]);
    expect(result.matches[0]?.detection.id).toBe("right");
    expect(result.falsePositives[0]?.detection.id).toBe("wrong");
  });

  it("credits a bend as a single event without penalising it", () => {
    const bend = label("q7", 6950, 7950, "A3 bend to B3", {
      pitches: ["A3", "B3"],
      pitchClasses: ["A", "B"],
      bendTo: "B3",
    });
    // One detected event covering the whole bend, labelled by its origin note.
    const result = matchEvents([bend], [detected("d1", 6960, 7940, "A3")]);

    expect(result.matches).toHaveLength(1);
    expect(result.falsePositives).toHaveLength(0);
    expect(result.missed).toHaveLength(0);
    expect(result.matches[0]?.agreement.exact).toBe(true);

    // And the same holds when the tracker names it by the bend target.
    const byTarget = matchEvents([bend], [detected("d1", 6960, 7940, "B3")]);
    expect(byTarget.matches[0]?.agreement.exact).toBe(true);
    expect(byTarget.falsePositives).toHaveLength(0);
  });

  it("prefers an onset-aligned label over a far-away one whose label agrees", () => {
    // Modelled on a real cowboy-chords result: one merged 5.1s event labelled
    // "G5" spanning the D, Em and G bars. Assigning it to the G three bars
    // later would report a 3.8s timing error; the truth is a merge, which
    // should read as one on-time match plus two missed labels.
    const labels = [
      chordLabel("c2", 6550, 8550, "D"),
      chordLabel("c3", 8550, 10550, "Em"),
      chordLabel("c4", 10550, 12550, "G"),
    ];
    const merged = detected("ev2", 6747, 11840, "G5", 0.85, "chord");

    const result = matchEvents(labels, [merged]);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.label.id).toBe("c2");
    expect(result.matches[0]?.onsetDeltaMs).toBe(197);
    expect(result.missed.map((m) => m.label.id)).toEqual(["c3", "c4"]);
  });

  it("pairs on overlap even when onsets are far apart", () => {
    // A 2s chord whose detection starts 500ms late still overlaps heavily.
    const labels = [chordLabel("c1", 0, 2000, "C")];
    const result = matchEvents(labels, [detected("d1", 500, 2000, "C", 0.9, "chord")]);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.onsetDeltaMs).toBe(500);
  });

  it("refuses to pair events that neither overlap nor share an onset", () => {
    // A short label, so the detections below sit clear of its span and the
    // onset window is the only thing being tested.
    const labels = [label("a", 1000, 1100, "B2")];

    const justInside = matchEvents(labels, [
      detected("d1", 1000 + ONSET_WINDOW_MS, 1000 + ONSET_WINDOW_MS + 50, "B2"),
    ]);
    expect(justInside.matches).toHaveLength(1);

    const justOutside = matchEvents(labels, [
      detected("d1", 1000 + ONSET_WINDOW_MS + 1, 1000 + ONSET_WINDOW_MS + 51, "B2"),
    ]);
    expect(justOutside.matches).toHaveLength(0);
    expect(justOutside.missed).toHaveLength(1);
    expect(justOutside.falsePositives).toHaveLength(1);
  });

  it("still pairs a far-onset detection when the two overlap in time", () => {
    // Overlap OR onset proximity — a detection landing inside a long label
    // stays a candidate even though its onset is well past the window.
    const labels = [label("a", 1000, 2000, "B2")];
    const result = matchEvents(labels, [detected("d1", 1500, 1900, "B2")]);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.onsetDeltaMs).toBe(500);
  });

  it("handles an empty detection list and an empty label list", () => {
    const noDetections = matchEvents([label("a", 0, 100, "B2")], []);
    expect(noDetections.missed).toHaveLength(1);
    expect(noDetections.matches).toHaveLength(0);

    const noLabels = matchEvents([], [detected("d1", 0, 100, "B2")]);
    expect(noLabels.falsePositives).toHaveLength(1);
    expect(noLabels.matches).toHaveLength(0);
  });

  it("tolerates a detection that never ended", () => {
    const result = matchEvents([label("a", 1000, 1500, "B2")], [detected("d1", 1000, null, "B2")]);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.endDeltaMs).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

describe("scoreMatches", () => {
  it("counts missed labels against accuracy so silence cannot win", () => {
    const labels = [
      label("a", 1000, 1500, "B2"),
      label("b", 2000, 2500, "C#3"),
      label("c", 3000, 3500, "D3"),
      label("d", 4000, 4500, "E3"),
    ];
    // Two right, two never detected at all.
    const stats = scoreMatches(
      matchEvents(labels, [
        detected("d1", 1000, 1500, "B2"),
        detected("d2", 2000, 2500, "C#3"),
      ])
    );

    expect(stats.labelCount).toBe(4);
    expect(stats.matchedCount).toBe(2);
    expect(stats.missedCount).toBe(2);
    expect(stats.scoredLabelCount).toBe(4);
    expect(stats.exactAccuracy).toBeCloseTo(0.5, 10);
  });

  it("excludes honest abstentions from the accuracy denominator", () => {
    const labels = [
      chordLabel("a", 0, 2000, "Cmaj9"),
      chordLabel("b", 2000, 4000, "G"),
      chordLabel("c", 4000, 6000, "Am11"),
    ];
    const stats = scoreMatches(
      matchEvents(labels, [
        detected("d1", 0, 2000, "unknown", 0.4, "chord"),
        detected("d2", 2000, 4000, "G", 0.9, "chord"),
        detected("d3", 4000, 6000, "unknown", 0.3, "chord"),
      ])
    );

    expect(stats.matchedCount).toBe(3);
    expect(stats.abstainedCount).toBe(2);
    expect(stats.unknownDetectionCount).toBe(2);
    expect(stats.abstentionRate).toBeCloseTo(2 / 3, 10);
    // Only the G was actually answered, and it was right.
    expect(stats.scoredLabelCount).toBe(1);
    expect(stats.exactAccuracy).toBe(1);
    expect(stats.confidentlyWrongCount).toBe(0);
  });

  it("reports null accuracy rather than 0 when everything abstained", () => {
    const stats = scoreMatches(
      matchEvents(
        [chordLabel("a", 0, 2000, "Cmaj9")],
        [detected("d1", 0, 2000, "unknown", 0.2, "chord")]
      )
    );
    expect(stats.scoredLabelCount).toBe(0);
    expect(stats.exactAccuracy).toBeNull();
    expect(stats.pitchClassAccuracy).toBeNull();
    expect(stats.abstentionRate).toBe(1);
  });

  it("counts a confident wrong answer but not a hesitant one", () => {
    const labels = [chordLabel("a", 0, 2000, "Cmaj9"), chordLabel("b", 2000, 4000, "G")];
    const stats = scoreMatches(
      matchEvents(labels, [
        detected("d1", 0, 2000, "F#m", 0.95, "chord"),
        detected("d2", 2000, 4000, "Bm", 0.2, "chord"),
      ]),
      { confidentLabelThreshold: 0.6, confidentlyWrongOn: "pitchClass" }
    );

    expect(stats.confidentlyWrongCount).toBe(1);
    expect(stats.confidentlyWrong[0]).toMatchObject({
      labelId: "a",
      expected: "Cmaj9",
      detected: "F#m",
      disagreement: "pitchClass",
    });
  });

  it("classifies an octave-only disagreement separately from a wrong pitch class", () => {
    const labels = [label("a", 1000, 1500, "B2"), label("b", 2000, 2500, "C#3")];
    const stats = scoreMatches(
      matchEvents(labels, [
        detected("d1", 1000, 1500, "B3", 0.9),
        detected("d2", 2000, 2500, "G3", 0.9),
      ]),
      { confidentlyWrongOn: "exact" }
    );

    expect(stats.exactCorrect).toBe(0);
    expect(stats.pitchClassCorrect).toBe(1);
    expect(stats.octaveOnlyCount).toBe(1);
    expect(stats.confidentlyWrong.map((c) => c.disagreement).sort()).toEqual([
      "octave",
      "pitchClass",
    ]);
  });

  it("computes signed and absolute onset percentiles", () => {
    const labels = [
      label("a", 1000, 1500, "B2"),
      label("b", 2000, 2500, "C#3"),
      label("c", 3000, 3500, "D3"),
    ];
    const stats = scoreMatches(
      matchEvents(labels, [
        detected("d1", 900, 1400, "B2"),
        detected("d2", 2010, 2510, "C#3"),
        detected("d3", 3200, 3700, "D3"),
      ])
    );

    // Signed deltas: -100, +10, +200. Absolute: 10, 100, 200.
    expect(stats.onsetErrorMs.medianSigned).toBe(10);
    expect(stats.onsetErrorMs.medianAbs).toBe(100);
    expect(stats.onsetErrorMs.p90Signed).toBeCloseTo(162, 6);
    expect(stats.onsetErrorMs.p90Abs).toBeCloseTo(180, 6);
    expect(stats.endErrorMs.medianSigned).toBe(10);
  });

  it("separates mean confidence for matched and unmatched detections", () => {
    const stats = scoreMatches(
      matchEvents(
        [label("a", 1000, 1500, "B2")],
        [detected("d1", 1000, 1500, "B2", 0.8), detected("d2", 9000, 9500, "G3", 0.2)]
      )
    );
    expect(stats.meanConfidenceMatched).toBeCloseTo(0.8, 10);
    expect(stats.meanConfidenceUnmatched).toBeCloseTo(0.2, 10);
  });

  it("returns null confidences when there is nothing to average", () => {
    const stats = scoreMatches(matchEvents([], []));
    expect(stats.meanConfidenceMatched).toBeNull();
    expect(stats.meanConfidenceUnmatched).toBeNull();
    expect(stats.onsetErrorMs.medianSigned).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Sections                                                                    */
/* -------------------------------------------------------------------------- */

describe("sections", () => {
  const sections = {
    quarters: { idPrefix: "q", startMs: 3950, endMs: 7950, required: true },
    triplets: { idPrefix: "t", startMs: 11860, endMs: 16193, required: true },
    sixteenths: { idPrefix: "s", startMs: 19870, endMs: 21745, required: false },
  };

  it("assigns labels by id prefix and detections by onset time", () => {
    expect(sectionForLabel(label("q3", 4950, 5450, "D3"), sections)).toBe("quarters");
    expect(sectionForLabel(label("s12", 21245, 21745, "A4"), sections)).toBe("sixteenths");
    expect(sectionForDetection(detected("d", 20000, 20100, "B4"), sections)).toBe("sixteenths");
    expect(sectionForDetection(detected("d", 9000, 9100, "B4"), sections)).toBeNull();
  });

  it("excludes a non-required section from the gate without re-matching", () => {
    const labels = [
      label("q1", 3950, 4450, "B2"),
      label("s1", 19870, 19995, "B4"),
      label("s2", 19995, 20120, "C#5"),
    ];
    const detections = [
      detected("d1", 3950, 4450, "B2"),
      detected("d2", 19870, 19995, "G4"), // wrong, inside the excluded section
      detected("d3", 20500, 20600, "E5"), // spurious, inside the excluded section
    ];

    const result = matchEvents(labels, detections);
    const overall = scoreMatches(result);
    expect(overall.labelCount).toBe(3);
    expect(overall.falsePositiveCount).toBe(1);
    expect(overall.exactAccuracy).toBeCloseTo(1 / 3, 10);

    const excluded = new Set(["sixteenths"]);
    const gated = scoreMatches(
      filterResult(
        result,
        (l) => !excluded.has(sectionForLabel(l, sections) ?? ""),
        (d) => !excluded.has(sectionForDetection(d, sections) ?? "")
      )
    );

    // The excluded section's labels, its miss and its false positive all drop
    // out of the gate — but the numbers above still report them.
    expect(gated.labelCount).toBe(1);
    expect(gated.exactAccuracy).toBe(1);
    expect(gated.falsePositiveCount).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Thresholds                                                                  */
/* -------------------------------------------------------------------------- */

describe("checkThresholds", () => {
  const stats = scoreMatches(
    matchEvents(
      [
        label("a", 1000, 1500, "B2"),
        label("b", 2000, 2500, "C#3"),
        label("c", 3000, 3500, "D3"),
      ],
      [
        detected("d1", 1050, 1550, "B2"),
        detected("d2", 2050, 2550, "C#4"), // right class, wrong octave
        detected("d3", 3050, 3550, "D3"),
        detected("d4", 8000, 8100, "G3"),
      ]
    )
  );

  it("gates on pitch-class accuracy when asked to", () => {
    const checks = checkThresholds(stats, { gateOn: "pitchClass", minLabelAccuracy: 0.9 });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "minLabelAccuracy (pitchClass)", passed: true });
    expect(checks[0]?.actual).toBe(1);
  });

  it("gates on exact accuracy when asked to, and fails on the octave", () => {
    const checks = checkThresholds(stats, { gateOn: "exact", minLabelAccuracy: 0.9 });
    expect(checks[0]).toMatchObject({ name: "minLabelAccuracy (exact)", passed: false });
    expect(checks[0]?.actual).toBeCloseTo(2 / 3, 10);
  });

  it("checks the absolute median onset error, not the signed one", () => {
    const passing = checkThresholds(stats, { maxMedianOnsetErrorMs: 100 });
    expect(passing[0]).toMatchObject({ name: "maxMedianOnsetErrorMs", passed: true });
    expect(passing[0]?.actual).toBe(50);

    const failing = checkThresholds(stats, { maxMedianOnsetErrorMs: 10 });
    expect(failing[0]?.passed).toBe(false);
  });

  it("checks false positives and confidently-wrong labels", () => {
    expect(checkThresholds(stats, { maxFalsePositives: 3 })[0]?.passed).toBe(true);
    expect(checkThresholds(stats, { maxFalsePositives: 0 })[0]?.passed).toBe(false);
    expect(checkThresholds(stats, { maxFalseLabels: 0 })[0]?.passed).toBe(true);
  });

  it("distinguishes nothing in scope from nothing scored", () => {
    // Every section of a held-out fixture marked informational leaves the gated
    // subset empty. There is nothing to be right or wrong about, so failing the
    // accuracy gate would report a defect that does not exist.
    const empty = scoreMatches(matchEvents([], []));
    const nothingInScope = checkThresholds(empty, { minLabelAccuracy: 0.9 });
    expect(nothingInScope[0]).toMatchObject({
      passed: true,
      note: "no labels in scope",
    });

    // Labels in scope that all abstained is the opposite case: the detector
    // answered nothing about material it was asked about, and passing that
    // would let a detector that emits nothing clear every gate.
    const abstained = scoreMatches(
      matchEvents([label("a", 1000, 1500, "B2")], [detected("d1", 1050, 1550, "unknown")])
    );
    const nothingScored = checkThresholds(abstained, { minLabelAccuracy: 0.9 });
    expect(nothingScored[0]).toMatchObject({
      passed: false,
      note: "no scored labels",
    });
  });

  it("emits no checks when nothing is configured", () => {
    expect(checkThresholds(stats, {})).toHaveLength(0);
  });

  it("fails a real accuracy floor when nothing could be scored", () => {
    const empty = scoreMatches(
      matchEvents(
        [chordLabel("a", 0, 2000, "Cmaj9")],
        [detected("d1", 0, 2000, "unknown", 0.2, "chord")]
      )
    );
    expect(checkThresholds(empty, { minLabelAccuracy: 0.5 })[0]?.passed).toBe(false);
    // ...but a zero floor is a deliberate "abstention is acceptable here".
    expect(checkThresholds(empty, { minLabelAccuracy: 0 })[0]?.passed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Fixture-shaped end-to-end check (still no audio, no detector)               */
/* -------------------------------------------------------------------------- */

describe("a realistic fixture slice", () => {
  it("scores a plausible imperfect run the way the report will", () => {
    // Modelled on the quarters section of clean-lead-120bpm, including the bend.
    const labels: LabeledEvent[] = [
      label("q1", 3950, 4450, "B2"),
      label("q2", 4450, 4950, "C#3"),
      label("q3", 4950, 5450, "D3"),
      label("q4", 5450, 5950, "E3"),
      label("q5", 5950, 6450, "F#3"),
      label("q6", 6450, 6950, "G3"),
      label("q7", 6950, 7950, "A3 bend to B3", {
        pitches: ["A3", "B3"],
        pitchClasses: ["A", "B"],
        bendTo: "B3",
      }),
    ];

    const detections: DetectedEvent[] = [
      detected("e1", 3970, 4440, "B2", 0.91),
      detected("e2", 4480, 4950, "C#3", 0.88),
      detected("e3", 4990, 5440, "D3", 0.9),
      // q4 missed entirely.
      detected("e5", 5980, 6440, "F#4", 0.86), // octave error
      detected("e6", 6470, 6940, "G3", 0.89),
      detected("e7", 6980, 7930, "A3", 0.84), // the bend, as one event
      detected("e8", 9000, 9200, "D4", 0.31), // spurious, low confidence
    ];

    const result = matchEvents(labels, detections);
    const stats = scoreMatches(result, { confidentlyWrongOn: "exact" });

    expect(stats.labelCount).toBe(7);
    expect(stats.matchedCount).toBe(6);
    expect(stats.missedCount).toBe(1);
    expect(result.missed[0]?.label.id).toBe("q4");
    expect(stats.falsePositiveCount).toBe(1);
    expect(result.falsePositives[0]?.detection.id).toBe("e8");

    // 5 exact of 7 labels; the octave error and the miss are the other two.
    expect(stats.exactCorrect).toBe(5);
    expect(stats.pitchClassCorrect).toBe(6);
    expect(stats.octaveOnlyCount).toBe(1);
    expect(stats.exactAccuracy).toBeCloseTo(5 / 7, 10);
    expect(stats.pitchClassAccuracy).toBeCloseTo(6 / 7, 10);

    // The only confident exact-disagreement is the octave, which is exactly the
    // evidence that belongs in proposed-label-corrections.json.
    expect(stats.confidentlyWrong).toHaveLength(1);
    expect(stats.confidentlyWrong[0]).toMatchObject({ labelId: "q5", disagreement: "octave" });

    // Matched onset deltas: 20, 30, 40, 30, 20, 30 -> median 30.
    expect(stats.onsetErrorMs.medianAbs).toBeCloseTo(30, 10);
    expect(stats.meanConfidenceUnmatched).toBeCloseTo(0.31, 10);
    expect(stats.meanConfidenceMatched as number).toBeGreaterThan(0.8);
  });
});

/* -------------------------------------------------------------------------- */
/* WAV I/O                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The harness's own file format. These live here rather than in a separate file
 * because they guard the same deliverable: if `readWav` mis-parses, every
 * number above is measured against the wrong audio.
 */
describe("wav", () => {
  function ramp(length: number): Float32Array {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = Math.sin((i / length) * Math.PI * 8) * 0.9;
    return out;
  }

  it("round-trips samples within 16-bit quantisation error", () => {
    const original = ramp(4096);
    const wav = readWav(writeWav(original, 48000));

    expect(wav.sampleRate).toBe(48000);
    expect(wav.channels).toBe(1);
    expect(wav.samples).toHaveLength(original.length);

    let worst = 0;
    for (let i = 0; i < original.length; i++) {
      worst = Math.max(worst, Math.abs((wav.samples[i] as number) - (original[i] as number)));
    }
    // Reader and writer are exact inverses, so the only loss is rounding to
    // the nearest of 65536 steps: at most half an LSB, 1.53e-5.
    expect(worst).toBeLessThanOrEqual(0.5 / 32768);
  });

  it("preserves the exact sample count, including an odd one", () => {
    const odd = ramp(1001);
    expect(readWav(writeWav(odd, 48000)).samples).toHaveLength(1001);
    expect(readWav(writeWav(new Float32Array(0), 48000)).samples).toHaveLength(0);
  });

  it("clips out-of-range samples instead of wrapping them", () => {
    const hot = Float32Array.from([2, -2, 0.5, -0.5]);
    const back = readWav(writeWav(hot, 48000)).samples;
    expect(back[0]).toBeGreaterThan(0.99);
    expect(back[1]).toBeLessThan(-0.99);
    expect(back[2]).toBeCloseTo(0.5, 4);
    expect(back[3]).toBeCloseTo(-0.5, 4);
  });

  it("walks past a LIST chunk instead of assuming a 44-byte header", () => {
    // Exactly what ffmpeg writes: fmt, then LIST/INFO, then data. Anything that
    // hardcodes byte 44 reads the encoder name as audio.
    const base = writeWav(Float32Array.from([0.25, -0.25, 0.5]), 48000);
    const listBody = new Uint8Array([
      0x49, 0x4e, 0x46, 0x4f, // "INFO"
      0x49, 0x53, 0x46, 0x54, // "ISFT"
      0x06, 0x00, 0x00, 0x00, // size 6
      0x4c, 0x61, 0x76, 0x66, 0x00, 0x00, // "Lavf\0\0"
    ]);
    const chunk = new Uint8Array(8 + listBody.length);
    chunk.set([0x4c, 0x49, 0x53, 0x54], 0); // "LIST"
    new DataView(chunk.buffer).setUint32(4, listBody.length, true);
    chunk.set(listBody, 8);

    const withList = new Uint8Array(base.length + chunk.length);
    withList.set(base.subarray(0, 36), 0); // RIFF + fmt
    withList.set(chunk, 36);
    withList.set(base.subarray(36), 36 + chunk.length); // data
    new DataView(withList.buffer).setUint32(4, withList.length - 8, true);

    const wav = readWav(withList);
    expect(wav.samples).toHaveLength(3);
    expect(wav.samples[0]).toBeCloseTo(0.25, 4);
    expect(wav.samples[2]).toBeCloseTo(0.5, 4);
  });

  it("rejects files that are not WAV", () => {
    expect(() => readWav(new Uint8Array([1, 2, 3]))).toThrow(/too short/);
    expect(() => readWav(new Uint8Array(64))).toThrow(/not a RIFF file/);
  });

  it("downmixes interleaved channels and leaves mono untouched", () => {
    const stereo = Float32Array.from([1, 0, 0.5, -0.5, -1, 1]);
    expect(Array.from(downmixToMono(stereo, 2))).toEqual([0.5, 0, 0]);

    const mono = Float32Array.from([0.25, 0.5]);
    expect(downmixToMono(mono, 1)).toBe(mono);
  });
});
