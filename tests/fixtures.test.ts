/**
 * The detector, against the recorded guitar.
 *
 * Every other test in this directory is synthetic — YIN on a sawtooth, chroma on
 * a synthesised triad, the matcher on hand-built literals. All of them can pass
 * while the detector is wrong about real audio, and for a long time they did:
 * fixture accuracy lived only in `npm run eval`, which is a separate script that
 * `npm test` never ran and CI ran with `continue-on-error`. "All tests green"
 * and "the detector mis-hears the sample input" were able to be true at once.
 *
 * These are the floors that stop that. They are RATCHETS, not targets: each
 * number is what the detector actually achieves today, so any regression fails
 * the suite. Raising one after a genuine improvement is expected and welcome;
 * lowering one to make a change pass is the thing this file exists to prevent.
 *
 * The aspirational numbers — what the fixtures are gated on in
 * `fixtures/eval.config.json` — are deliberately NOT here. `npm run eval` owns
 * those, and it still exits nonzero. This file owns "do not get worse".
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSamples } from "../src/workers/offline.js";
import { downmixToMono, readWav } from "../src/eval/wav.js";
import {
  matchEvents,
  scoreMatches,
  type DetectedEvent,
  type EvalStats,
  type LabeledEvent,
} from "../src/eval/matcher.js";
import { CACHE_DIR, REPO_ROOT, decodeFixtures } from "../scripts/decode-fixtures.js";
import type { TuninatorMode } from "../src/types.js";

type Floor = {
  mode: TuninatorMode;
  /** Every one of these is a lower/upper bound met by the detector today. */
  minPitchClass: number;
  minExact: number;
  maxMissed: number;
  maxConfidentlyWrong: number;
};

/**
 * Measured on the recordings, not chosen. Written as the fractions they really
 * are, so nobody has to wonder whether a rounded decimal is the true value.
 * Update by running the suite, reading the actual number out of the failure,
 * and only then editing — upward.
 */
const FLOORS: Record<string, Floor> = {
  "power-chords-c-a-g-e-c-d-fsharp-e-120bpm": {
    mode: "chords",
    // Every chord in the file, named exactly right.
    minPitchClass: 8 / 8,
    minExact: 8 / 8,
    maxMissed: 0,
    maxConfidentlyWrong: 0,
  },
  "cowboy-chords-c-d-em-g-c-d-em-am-120bpm": {
    mode: "chords",
    minPitchClass: 7 / 7,
    minExact: 6 / 7,
    maxMissed: 0,
    maxConfidentlyWrong: 0,
  },
  "chords-a-bm-g-d-2x-120bpm": {
    mode: "chords",
    minPitchClass: 11 / 13,
    minExact: 10 / 13,
    maxMissed: 2,
    maxConfidentlyWrong: 0,
  },
  "spicy-chords-cmaj9-g-am11": {
    mode: "chords",
    minPitchClass: 2 / 2,
    minExact: 1 / 2,
    maxMissed: 0,
    // The whole point of this fixture: extended voicings may abstain, they may
    // not commit to the wrong chord.
    maxConfidentlyWrong: 0,
  },
  "clean-lead-120bpm": {
    mode: "lead",
    minPitchClass: 34 / 43,
    minExact: 31 / 43,
    maxMissed: 7,
    maxConfidentlyWrong: 1,
  },
};

const scored = new Map<string, EvalStats>();

beforeAll(() => {
  // Cached after the first run; `npm run eval` shares the same cache.
  const fixtures = decodeFixtures({ quiet: true });
  for (const fixture of fixtures) {
    const floor = FLOORS[fixture.stem];
    if (!floor) continue;
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const labels = JSON.parse(
      readFileSync(join(REPO_ROOT, "fixtures", "labels", `${fixture.stem}.json`), "utf8")
    ).events as LabeledEvent[];
    const events = analyzeSamples(mono, wav.sampleRate, { mode: floor.mode })
      .events as unknown as DetectedEvent[];
    scored.set(fixture.stem, scoreMatches(matchEvents(labels, events)));
  }
}, 600_000);

describe("the detector, on the recorded fixtures", () => {
  it("decoded every fixture it has a floor for", () => {
    expect([...scored.keys()].sort()).toEqual(Object.keys(FLOORS).sort());
    expect(CACHE_DIR).toContain(".cache");
  });

  for (const [stem, floor] of Object.entries(FLOORS)) {
    describe(stem, () => {
      it("names at least as many pitch classes correctly as it does today", () => {
        const stats = scored.get(stem);
        expect(stats, "fixture was not scored").toBeDefined();
        expect(stats!.pitchClassAccuracy ?? 0).toBeGreaterThanOrEqual(floor.minPitchClass - 1e-9);
      });

      it("names at least as many chords/notes exactly as it does today", () => {
        const stats = scored.get(stem)!;
        expect(stats.exactAccuracy ?? 0).toBeGreaterThanOrEqual(floor.minExact - 1e-9);
      });

      it("misses no more events than it does today", () => {
        const stats = scored.get(stem)!;
        expect(stats.missedCount).toBeLessThanOrEqual(floor.maxMissed);
      });

      it("commits to no more wrong labels than it does today", () => {
        const stats = scored.get(stem)!;
        expect(stats.confidentlyWrongCount).toBeLessThanOrEqual(floor.maxConfidentlyWrong);
      });
    });
  }
});
