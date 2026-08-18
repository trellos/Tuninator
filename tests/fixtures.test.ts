/**
 * The detector, against the recorded guitar. This is the correctness test.
 *
 * Every other test in this directory is synthetic — YIN on a sawtooth, chroma
 * on a synthesised triad, the matcher on hand-built literals. All of them can
 * pass while the detector is wrong about real audio, and for a long time they
 * did: fixture accuracy lived only in `npm run eval`, which is a separate
 * script that `npm test` never ran and CI ran with `continue-on-error`. "All
 * tests green" and "the detector mis-hears the sample input" were able to be
 * true at once.
 *
 * THE STANDARD IS COMPLETE IDENTIFICATION. A human listener can name every
 * chord and every note in these recordings, so the detector has to as well.
 * `unknown` is honest, and it is still not the answer: it counts here exactly
 * as a wrong label does. `npm run eval` is the place that measures honest
 * abstention and grades it kindly; this file does not.
 *
 * SO THIS SUITE IS EXPECTED TO BE RED until every event is named. That is the
 * point of it. `SHORTFALL` below lists what is still missed, event by event,
 * with the reason where the reason is known — it is a worklist, not a set of
 * permissions. Nothing here may be relaxed to make a change pass; the only
 * sanctioned edit is deleting an entry once the detector names that event.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSamples } from "../src/workers/offline.js";
import { downmixToMono, readWav } from "../src/eval/wav.js";
import { matchEvents, type DetectedEvent, type LabeledEvent } from "../src/eval/matcher.js";
import { CACHE_DIR, REPO_ROOT, decodeFixtures } from "../scripts/decode-fixtures.js";
import type { TuninatorMode } from "../src/types.js";

const MODES: Record<string, TuninatorMode> = {
  "power-chords-c-a-g-e-c-d-fsharp-e-120bpm": "chords",
  "cowboy-chords-c-d-em-g-c-d-em-am-120bpm": "chords",
  "chords-a-bm-g-d-2x-120bpm": "chords",
  "spicy-chords-cmaj9-g-am11": "chords",
  "clean-lead-120bpm": "lead",
};

/**
 * Labelled events the detector does not yet name, keyed by fixture and event
 * id, with what it says instead.
 *
 * This is the remaining work, written down. An entry means "known miss, still
 * failing" — the test below fails for every one of them, and reports them
 * together so the list can be worked through rather than rediscovered.
 */
const SHORTFALL: Record<string, Record<string, string>> = {
  "power-chords-c-a-g-e-c-d-fsharp-e-120bpm": {},

  "cowboy-chords-c-d-em-g-c-d-em-am-120bpm": {
    c2: "D -> unknown. Both D bars are strummed more than once; the votes split.",
    c6: "D -> D5. The third is transcribed at the attack and gone by the re-strum.",
  },

  "chords-a-bm-g-d-2x-120bpm": {
    s3: "Bm -> B5. D4 is in the chroma for ~200ms after the attack and absent after.",
    s6: "G -> unknown. Muted upstrum.",
    s12: "Bm -> unknown. Muted upstrum.",
    s15: "D -> D5.",
  },

  "spicy-chords-cmaj9-g-am11": {
    sp3: "Am11 -> unknown. Ranked first, blocked by Am7 — its own subset — at 0.079 against a 0.08 margin.",
  },

  /*
   * The lead fixture is the largest remaining gap, and it is a different
   * problem from the chords: YIN is a single-pitch estimator, and in this
   * playing the previous note is still ringing when the next is picked. Six of
   * these twelve are notes the tracker never emitted at all, five are the
   * neighbouring note of the phrase, and one is an octave.
   */
  "clean-lead-120bpm": {
    q1: "B2 -> B3. Octave: the fundamental of the low B is weaker than its second harmonic.",
    q7: "A3 bend to B3 -> A5. Octave, during a bend.",
    t2: "C#5 -> no event. Triplet run, 166ms per note.",
    t4: "E5 -> no event.",
    t6: "C#5 -> no event.",
    t10: "E5 -> D5. The previous note of the phrase.",
    t15: "D5 -> C#5. The previous note of the phrase.",
    t16: "E5 -> no event.",
    t24: "B5 -> B3. Octave.",
    s4: "A4 -> no event. 125ms sixteenths.",
    s5: "B4 -> no event.",
    s10: "C#5 -> B4. The previous note of the phrase.",
  },
};

type Named = { id: string; want: string; got: string };

const outcomes = new Map<string, Named[]>();

beforeAll(() => {
  // Cached after the first run; `npm run eval` shares the same cache.
  for (const fixture of decodeFixtures({ quiet: true })) {
    const mode = MODES[fixture.stem];
    if (!mode) continue;
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const labels = JSON.parse(
      readFileSync(join(REPO_ROOT, "fixtures", "labels", `${fixture.stem}.json`), "utf8")
    ).events as LabeledEvent[];
    const events = analyzeSamples(mono, wav.sampleRate, { mode })
      .events as unknown as DetectedEvent[];

    // Every LABEL, not every match: `matchEvents` leaves a label the detector
    // produced nothing for out of `matches` entirely, and a label with no
    // detection is the most complete way to fail to name it.
    const paired = new Map(
      matchEvents(labels, events).matches.map((m) => [
        m.label.id,
        m.detection?.label.name ?? "(no detection)",
      ])
    );
    outcomes.set(
      fixture.stem,
      labels.map((label) => ({
        id: label.id,
        want: label.label,
        got: paired.get(label.id) ?? "(no detection)",
      }))
    );
  }
}, 600_000);

describe("the detector, on the recorded fixtures", () => {
  it("decoded every fixture", () => {
    expect([...outcomes.keys()].sort()).toEqual(Object.keys(MODES).sort());
    expect(CACHE_DIR).toContain(".cache");
  });

  for (const stem of Object.keys(MODES)) {
    describe(stem, () => {
      it("names every labelled event exactly right", () => {
        const named = outcomes.get(stem);
        expect(named, "fixture was not scored").toBeDefined();
        const wrong = named!.filter((n) => n.got !== n.want);
        expect(
          wrong.map((n) => `${n.id}: want ${n.want}, got ${n.got}`).join("\n"),
          `${wrong.length}/${named!.length} events not named`
        ).toBe("");
      });

      it("has a written-down reason for each event it still misses", () => {
        const named = outcomes.get(stem)!;
        const wrong = new Set(named.filter((n) => n.got !== n.want).map((n) => n.id));
        const listed = new Set(Object.keys(SHORTFALL[stem] ?? {}));
        // Not "the list matches" — the list must not claim misses that are
        // fixed, or a stale entry would quietly become a licence.
        const stale = [...listed].filter((id) => !wrong.has(id));
        expect(stale, `SHORTFALL lists ${stem} events that now pass`).toEqual([]);
      });
    });
  }
});
