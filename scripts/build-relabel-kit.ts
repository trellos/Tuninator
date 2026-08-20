/**
 * Build the second-annotation listening kit: the contested moments of the
 * corpus, rendered as anonymised WAV snippets an annotator can judge without
 * knowing what the detector or the shipped labels say.
 *
 * WHY. Eight converging negatives put a ~0.73 AUC ceiling on the same-pitch
 * re-articulation decision, and the literature (Dixon DAFx-06; the 2022
 * soft-onset string-ensemble study) reports high inter-annotator variance for
 * exactly this kind of onset. Some unknown fraction of the ceiling may be
 * label noise rather than feature failure. Every experiment after this one is
 * graded against these labels, so that fraction has to be bounded FIRST.
 *
 * THE CONTESTED SET, from one analysis pass with the unchanged engine:
 *
 *  1. Every missed label (baseline 32), with its ledger cause
 *     (`measure-downstream-ledger.ts`'s own `classify`).
 *  2. Every extra-Note boundary (baseline 107): for each labelled event that
 *     came out as more than one Note under `measure-splits.ts`'s ownership
 *     rule, the start of every Note but the one nearest the label's onset.
 *  3. Every decision-table row within 70ms of a label where the detector and
 *     the target disagree (`measure-decision-separability.ts`'s population):
 *     acted splits at covered labels, and rejected/unacted decisions at
 *     uncovered ones.
 *
 * Deduplicated by time (50ms radius, misses > extras > decisions), then ~20%
 * uncontested CONTROL points are added — matched labels far from anything
 * contested, chosen by a seeded PRNG — so an annotator cannot learn that
 * everything in the kit is a trick question.
 *
 * WHAT A SNIPPET IS. ~1.5s of the fixture, peak-normalised, 20ms fades. The
 * moment under test sits inside the MIDDLE THIRD of the snippet, jittered
 * ±150ms off centre so its exact position never encodes the claim. Snippets
 * are named by an opaque id derived from a hash; nothing in the audio or the
 * answer sheet reveals fixture, time, or what any detector thinks.
 *
 * OUTPUTS (all under `.cache/relabel/`, never committed):
 *   audio/<id>.wav      the snippets
 *   manifest.json       id -> fixture/time/cause — the answer KEY; annotators
 *                       must not open it while answering
 *   answers-blank.csv   the answer sheet: id, "does a new note start in the
 *                       middle third" yes/no/unsure, optional onset offset(s)
 *                       in ms from snippet start (semicolon-separated)
 *   README.md           annotator instructions
 *
 * The shipped labels are never edited; this kit produces a SECOND annotation
 * set for comparison by `score-relabel.ts`.
 *
 * Usage:
 *   npx tsx scripts/build-relabel-kit.ts
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { matchEvents, type LabeledEvent } from "../src/offline/matcher.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import { downmixToMono, readWav, writeWav } from "../src/offline/wav.js";
import { CACHE_DIR, decodeFixtures } from "./decode-fixtures.js";
import { classify, fatesOf } from "./measure-downstream-ledger.js";
import { ownerIndexOf } from "./measure-splits.js";
import { collectFixture } from "./measure-decision-separability.js";

export const KIT_DIR = join(CACHE_DIR, "relabel");
const AUDIO_DIR = join(KIT_DIR, "audio");

export const SNIPPET_MS = 1500;
/** The moment under test is jittered this far off snippet centre, at most. */
const JITTER_MS = 150;
/** Two contested moments closer than this are one moment. */
const DEDUP_MS = 50;
/** Controls must sit at least this far from anything contested. */
const CONTROL_CLEARANCE_MS = 120;
const FADE_MS = 20;
const CONTROL_FRACTION = 0.2;

export type KitPoint = {
  id: string;
  stem: string;
  /** The contested moment, in fixture time. */
  momentMs: number;
  snippetStartMs: number;
  snippetMs: number;
  /** Gain applied to the snippet on rendering. */
  gain: number;
  kind: "miss" | "extra-note" | "decision-false-split" | "decision-missed-accept" | "control";
  control: boolean;
  /** Ledger cause, for misses. */
  cause: string | null;
  /** The shipped label this point is nearest to, when there is one in 70ms. */
  labelId: string | null;
};

/** Deterministic PRNG — the kit must be reproducible run to run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, hex — the opaque snippet id. */
function opaqueId(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

type Candidate = {
  stem: string;
  momentMs: number;
  kind: KitPoint["kind"];
  cause: string | null;
  labelId: string | null;
  /** Lower wins dedup. */
  priority: number;
};

function main(): void {
  const rng = mulberry32(0x7e1abe1);
  rmSync(KIT_DIR, { recursive: true, force: true });
  mkdirSync(AUDIO_DIR, { recursive: true });

  const points: KitPoint[] = [];
  const counts = new Map<string, number>();
  const bump = (k: string): void => void counts.set(k, (counts.get(k) ?? 0) + 1);

  for (const fixture of decodeFixtures({ quiet: true })) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const events: TrackerTraceEvent[] = [];
    const analysis = analyzeSamples(mono, wav.sampleRate, {
      trackerTrace: (event) => events.push(event),
    });
    const detections = projectEmissions(analysis.emissions).final;
    const labels = [...(fixture.label.events as LabeledEvent[])].sort(
      (a, b) => a.startMs - b.startMs
    );
    const result = matchEvents(labels, detections);
    const fates = fatesOf(events, new Set(detections.map((d) => d.id)));
    const spokenFor = new Set(result.matches.map((m) => m.detection.id));
    const matchedLabels = new Set(result.matches.map((m) => m.label.id));

    const candidates: Candidate[] = [];

    // 1. Misses, with their ledger cause.
    for (const { label } of result.missed) {
      candidates.push({
        stem: fixture.stem,
        momentMs: label.startMs,
        kind: "miss",
        cause: classify(label.startMs, events, fates, spokenFor).cause,
        labelId: label.id,
        priority: 0,
      });
    }

    // 2. Extra-Note boundaries under the splits ownership rule.
    const owned = new Map<number, Array<{ startedAt: number }>>();
    for (const detection of detections) {
      const owner = ownerIndexOf(labels, detection.startedAt);
      if (owner === -1) continue;
      const list = owned.get(owner) ?? [];
      list.push({ startedAt: detection.startedAt });
      owned.set(owner, list);
    }
    for (const [owner, notes] of owned) {
      if (notes.length < 2) continue;
      const label = labels[owner] as LabeledEvent;
      const nearest = notes.reduce((a, b) =>
        Math.abs(b.startedAt - label.startMs) < Math.abs(a.startedAt - label.startMs) ? b : a
      );
      for (const note of notes) {
        if (note === nearest) continue;
        candidates.push({
          stem: fixture.stem,
          momentMs: note.startedAt,
          kind: "extra-note",
          cause: null,
          labelId: label.id,
          priority: 1,
        });
      }
    }

    // 3. Decision rows at a label where the detector and the target disagree.
    for (const row of collectFixture(fixture.stem, labels, events, matchedLabels)) {
      if (row.nearLabelId === null) continue;
      const acted = row.accepted && row.settled;
      if (acted === (row.y === 1)) continue;
      candidates.push({
        stem: fixture.stem,
        momentMs: row.at,
        kind: acted ? "decision-false-split" : "decision-missed-accept",
        cause: null,
        labelId: row.nearLabelId,
        priority: 2,
      });
    }

    // Dedup by time: misses beat extras beat decisions, then earliest first.
    candidates.sort((a, b) => a.priority - b.priority || a.momentMs - b.momentMs);
    const kept: Candidate[] = [];
    for (const candidate of candidates) {
      if (kept.some((k) => Math.abs(k.momentMs - candidate.momentMs) < DEDUP_MS)) continue;
      kept.push(candidate);
    }

    // Controls: matched labels clear of anything contested.
    const eligible = labels.filter(
      (label) =>
        matchedLabels.has(label.id) &&
        !kept.some((k) => Math.abs(k.momentMs - label.startMs) < CONTROL_CLEARANCE_MS)
    );
    const controlCount = Math.ceil(kept.length * CONTROL_FRACTION);
    for (let i = 0; i < controlCount && eligible.length > 0; i++) {
      const pick = Math.floor(rng() * eligible.length);
      const label = eligible.splice(pick, 1)[0] as LabeledEvent;
      kept.push({
        stem: fixture.stem,
        momentMs: label.startMs,
        kind: "control",
        cause: null,
        labelId: label.id,
        priority: 3,
      });
    }

    // Render the snippets.
    const durationMs = (mono.length / wav.sampleRate) * 1000;
    for (const candidate of kept) {
      const jitter = (rng() * 2 - 1) * JITTER_MS;
      let snippetStartMs = candidate.momentMs - SNIPPET_MS / 2 + jitter;
      snippetStartMs = Math.max(0, Math.min(durationMs - SNIPPET_MS, snippetStartMs));

      const start = Math.round((snippetStartMs / 1000) * wav.sampleRate);
      const length = Math.round((SNIPPET_MS / 1000) * wav.sampleRate);
      const snippet = new Float32Array(length);
      snippet.set(mono.subarray(start, Math.min(mono.length, start + length)));

      // Fades keep the cut edges from reading as onsets of their own.
      const fade = Math.round((FADE_MS / 1000) * wav.sampleRate);
      for (let i = 0; i < fade && i < length; i++) {
        const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
        snippet[i] = (snippet[i] as number) * g;
        snippet[length - 1 - i] = (snippet[length - 1 - i] as number) * g;
      }

      let peak = 0;
      for (const v of snippet) peak = Math.max(peak, Math.abs(v));
      const gain = peak > 0 ? Math.min(0.5 / peak, 8) : 1;
      for (let i = 0; i < length; i++) snippet[i] = (snippet[i] as number) * gain;

      const id = opaqueId(`${candidate.stem}:${candidate.momentMs.toFixed(1)}:${candidate.kind}`);
      writeFileSync(join(AUDIO_DIR, `${id}.wav`), writeWav(snippet, wav.sampleRate));
      points.push({
        id,
        stem: candidate.stem,
        momentMs: candidate.momentMs,
        snippetStartMs,
        snippetMs: SNIPPET_MS,
        gain,
        kind: candidate.kind,
        control: candidate.kind === "control",
        cause: candidate.cause,
        labelId: candidate.labelId,
      });
      bump(candidate.kind);
    }
    console.log(`  ${fixture.stem}: ${kept.length} snippets`);
  }

  const ids = new Set(points.map((p) => p.id));
  if (ids.size !== points.length) throw new Error("opaque id collision — change the salt");

  writeFileSync(join(KIT_DIR, "manifest.json"), JSON.stringify(points, null, 2));

  const sheet = [...points]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((p) => `${p.id},,,`)
    .join("\n");
  writeFileSync(
    join(KIT_DIR, "answers-blank.csv"),
    `id,new_note_middle_third,onset_offset_ms,notes\n${sheet}\n`
  );

  writeFileSync(
    join(KIT_DIR, "README.md"),
    `# Relabel listening kit

Each WAV in \`audio/\` is a ${SNIPPET_MS / 1000}s excerpt of a guitar recording.
For each snippet, answer ONE question about the MIDDLE THIRD of the clip
(from ${SNIPPET_MS / 3}ms to ${Math.round((2 * SNIPPET_MS) / 3)}ms):

  Does a NEW note or strum START inside the middle third — a fresh pick,
  strum, or re-strike of a string, as opposed to a note that merely keeps
  ringing (or nothing at all)?

Fill \`answers-blank.csv\` (copy it first, e.g. to \`answers-yourname.csv\`):

  - \`new_note_middle_third\`: \`yes\`, \`no\`, or \`unsure\`.
  - \`onset_offset_ms\`: if yes, WHERE — in ms from the start of the snippet.
    Several new notes in the middle third: separate offsets with \`;\`
    (e.g. \`612;719\`). Please give offsets whenever you can; on the fast
    passages a bare \`yes\` cannot be scored at tight tolerances.
  - \`notes\`: anything you want to flag (optional).

Rules of the game:

  - Judge by EAR (and, if you like, a waveform view of the snippet in any
    editor). Loop the middle of the clip and slow it down if it helps.
  - Do NOT open \`manifest.json\` until your answer sheet is complete: it is
    the answer key. Nothing in the audio or the file names tells you what any
    detector or any existing annotation thinks — that is deliberate.
  - There is no target rate of yes or no. Some snippets are ordinary clear
    strokes; some are the corpus's hardest moments. Answer what you hear.

Scoring (after the sheet is complete):

  npx tsx scripts/score-relabel.ts .cache/relabel/answers-yourname.csv
`
  );

  console.log(`\n  kit written to ${KIT_DIR}`);
  for (const [kind, count] of [...counts.entries()].sort()) {
    console.log(`    ${kind.padEnd(22)} ${count}`);
  }
  console.log(`    total                  ${points.length}`);
}

main();
