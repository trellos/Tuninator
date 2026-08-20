/**
 * Fixture evidence report — is every label actually recoverable from the audio?
 *
 * The completion bar for the recognizer is "detect all 78 labeled events".
 * That bar is only honest if the audio can support it, so this script asks the
 * recordings three questions and writes down the answers *before* any detector
 * work can be blamed for a miss:
 *
 *  1. **Room tone.** Is the unlabeled head of each file genuinely silent by the
 *     engine's own standard (`rmsGate`, 0.008), or is there signal there that
 *     the labels do not account for?
 *  2. **Onset alignment.** Does a real energy rise exist near each label's
 *     `startMs`? A label with no attack anywhere near it is either mistimed or
 *     describes something that was never played.
 *  3. **Pitch evidence.** Is the labeled pitch (or, for a chord, its labeled
 *     voicing) actually present in the audio during the label's own span?
 *
 * `fixtures/labels/*.json` is READ-ONLY ground truth. Nothing here writes to it.
 * Disagreements are evidence for a human, never an automatic correction.
 *
 * Usage:  npx tsx scripts/verify-fixtures.ts
 * Output: .cache/fixture-verification.json  +  a console table
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ChromaAnalyzer } from "../src/engine/kernels/chroma.js";
import { describeFrequency, nameToMidi, midiToFrequency } from "../src/engine/kernels/notes.js";
import { YinDetector, peak as windowPeak, rms as windowRms } from "../src/engine/kernels/yin.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { CACHE_DIR, REPO_ROOT, decodeFixtures, type DecodeOutcome } from "./decode-fixtures.js";

/* -------------------------------------------------------------------------- */
/* Constants — deliberately the engine's own numbers, not fresh guesses        */
/* -------------------------------------------------------------------------- */

/** The engine's amplitude gate. Anything under this the detector never sees. */
const RMS_GATE = 0.008;
/** Envelope analysis hop. 10ms is finer than any label's stated precision. */
const ENVELOPE_HOP_MS = 10;
const ENVELOPE_WINDOW_MS = 20;
/**
 * How far from a label's `startMs` an energy rise still counts as its attack.
 *
 * An outer bound only. The search is also stopped at the midpoint to the
 * neighbouring labels, because 150ms is wider than a sixteenth note at 140bpm
 * and an unbounded nearest-attack search then reports the PREVIOUS stroke's
 * transient as this label's, one subdivision early. That reads exactly like a
 * label annotated late, and it is not: on the amped sixteenths take 19 of the
 * 19 labels whose nearest attack sat 30ms or more early had it within 25ms of
 * the previous label's own onset, and the same holds 4 of 4, 3 of 3 and 1 of 1
 * on the other fast held-out takes.
 */
const ONSET_SEARCH_MS = 150;
/** Fractional rise over the preceding baseline that counts as an attack. */
const ATTACK_RISE_RATIO = 1.35;
/** YIN window for the per-label pitch probe. Two periods of low E fits in 2048. */
const PITCH_WINDOW = 2048;
const CHROMA_FFT = 4096;
/** Probe this many evenly spaced points inside each label's span. */
const PROBE_COUNT = 9;
/** A chroma bin at or above this fraction of the max counts as "present". */
const CHROMA_PRESENCE = 0.4;

const PITCH_CLASS_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

/* -------------------------------------------------------------------------- */
/* Report shape                                                               */
/* -------------------------------------------------------------------------- */

type RoomToneReport = {
  headStartMs: number;
  headEndMs: number;
  meanRms: number;
  maxRms: number;
  maxPeak: number;
  /** Fraction of the head above the engine's gate. */
  aboveGateFraction: number;
  /** True when the head is silence as far as the engine is concerned. */
  isRoomTone: boolean;
};

type LabelReport = {
  id: string;
  kind: string;
  label: string;
  startMs: number;
  endMs: number;
  required: boolean;

  /** Nearest detected energy rise to `startMs`, signed (detected - labeled). */
  nearestAttackDeltaMs: number | null;
  attackAligned: boolean;

  /** Mean RMS over the label's own span. */
  spanMeanRms: number;
  spanMaxRms: number;
  /** True when the span is loud enough for the engine to analyse at all. */
  audible: boolean;

  /** Pitch classes YIN/chroma actually found inside the span, most salient first. */
  observedPitchClasses: string[];
  /** Scientific-notation pitches YIN locked onto inside the span. */
  observedPitches: string[];
  /** Every pitch class the label claims (label + `pitches` + `pitchClasses`). */
  expectedPitchClasses: string[];
  /** Expected pitch classes actually observed. */
  supportedPitchClasses: string[];
  /** True when at least one of the label's pitch classes is present. */
  pitchSupported: boolean;

  /** Set only when something looks wrong; this is the human-readable evidence. */
  concerns: string[];
};

type FixtureReport = {
  stem: string;
  wavPath: string;
  sampleRate: number;
  durationMs: number;
  labelCount: number;
  roomTone: RoomToneReport | null;
  labels: LabelReport[];
  /** Labels with at least one concern. The only rows a human needs to read. */
  concerningLabelIds: string[];
};

/* -------------------------------------------------------------------------- */
/* Envelope + attacks                                                          */
/* -------------------------------------------------------------------------- */

type Envelope = { hopMs: number; rms: Float64Array; peak: Float64Array };

function envelopeOf(mono: Float32Array, sampleRate: number): Envelope {
  const hop = Math.max(1, Math.round((ENVELOPE_HOP_MS / 1000) * sampleRate));
  const win = Math.max(hop, Math.round((ENVELOPE_WINDOW_MS / 1000) * sampleRate));
  const count = Math.max(0, Math.floor((mono.length - win) / hop) + 1);
  const rms = new Float64Array(count);
  const peak = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const start = i * hop;
    let sum = 0;
    let mx = 0;
    for (let j = 0; j < win; j++) {
      const v = mono[start + j] as number;
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > mx) mx = a;
    }
    rms[i] = Math.sqrt(sum / win);
    peak[i] = mx;
  }
  return { hopMs: (hop / sampleRate) * 1000, rms, peak };
}

/**
 * Every point where energy climbs sharply over its own recent baseline.
 *
 * Deliberately cruder and more permissive than the engine's spectral-flux
 * detector: the question here is "did the player put energy into the string
 * near this timestamp", not "would our onset detector fire". Using the engine's
 * own detector would make this report agree with the engine by construction,
 * which is exactly the circularity a ground-truth check has to avoid.
 */
function attackTimesMs(env: Envelope): number[] {
  const baselineFrames = Math.max(2, Math.round(60 / env.hopMs));
  const out: number[] = [];
  let lastMs = -Infinity;
  for (let i = baselineFrames; i < env.rms.length; i++) {
    const here = env.rms[i] as number;
    if (here < RMS_GATE) continue;
    let baseline = 0;
    for (let j = i - baselineFrames; j < i; j++) baseline += env.rms[j] as number;
    baseline /= baselineFrames;
    if (baseline <= 0) baseline = 1e-9;
    if (here / baseline < ATTACK_RISE_RATIO) continue;
    const ms = i * env.hopMs;
    // One attack per rise, not one per frame of the rise.
    if (ms - lastMs < 60) continue;
    lastMs = ms;
    out.push(ms);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Per-label pitch probing                                                     */
/* -------------------------------------------------------------------------- */

function expectedPitchClassesOf(event: DecodeOutcome["label"]["events"][number]): string[] {
  const out = new Set<string>();
  const addName = (raw: string | undefined): void => {
    if (!raw) return;
    const midi = safeNameToMidi(raw);
    if (midi !== null) out.add(PITCH_CLASS_NAMES[((midi % 12) + 12) % 12] as string);
  };

  if (event.kind === "chord") {
    // A chord's identity is its root; its `pitches` are the voicing, which is
    // the strongest available statement of what is physically sounding.
    const root = /^([A-Ga-g][#b♯♭]?)/.exec(event.label)?.[1];
    if (root) addName(`${root}4`);
    for (const p of event.pitches ?? []) addName(p);
  } else {
    for (const p of event.pitches ?? [event.label]) addName(p);
    addName(event.bendTo);
  }
  for (const pc of event.pitchClasses ?? []) addName(`${pc}4`);
  return [...out];
}

function safeNameToMidi(name: string): number | null {
  try {
    return nameToMidi(name.trim());
  } catch {
    return null;
  }
}

type Probe = { pitchClasses: string[]; pitches: string[] };

function probeSpan(
  mono: Float32Array,
  sampleRate: number,
  startMs: number,
  endMs: number,
  yin: YinDetector,
  chroma: ChromaAnalyzer,
  pitchWindow: Float32Array,
  chromaWindow: Float32Array
): Probe {
  const pitchWeight = new Map<string, number>();
  const noteCounts = new Map<string, number>();

  const startSample = Math.max(0, Math.round((startMs / 1000) * sampleRate));
  const endSample = Math.min(mono.length, Math.round((endMs / 1000) * sampleRate));

  for (let k = 0; k < PROBE_COUNT; k++) {
    const at = startSample + Math.round(((endSample - startSample) * k) / PROBE_COUNT);

    if (at + pitchWindow.length <= mono.length) {
      pitchWindow.set(mono.subarray(at, at + pitchWindow.length));
      const result = yin.detect(pitchWindow);
      if (result.frequencyHz !== null && result.confidence >= 0.4) {
        const note = describeFrequency(result.frequencyHz);
        noteCounts.set(note.name, (noteCounts.get(note.name) ?? 0) + 1);
        pitchWeight.set(
          note.pitchClass,
          (pitchWeight.get(note.pitchClass) ?? 0) + result.confidence
        );
      }
    }

    if (at + chromaWindow.length <= mono.length) {
      chromaWindow.set(mono.subarray(at, at + chromaWindow.length));
      const result = chroma.analyze(chromaWindow);
      let max = 0;
      for (let b = 0; b < 12; b++) max = Math.max(max, result.chroma[b] as number);
      if (max > 0) {
        for (let b = 0; b < 12; b++) {
          const v = (result.chroma[b] as number) / max;
          if (v >= CHROMA_PRESENCE) {
            const name = PITCH_CLASS_NAMES[b] as string;
            pitchWeight.set(name, (pitchWeight.get(name) ?? 0) + v);
          }
        }
      }
    }
  }

  const pitchClasses = [...pitchWeight.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  const pitches = [...noteCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  return { pitchClasses, pitches };
}

/* -------------------------------------------------------------------------- */
/* Per-fixture verification                                                    */
/* -------------------------------------------------------------------------- */

function verifyFixture(fixture: DecodeOutcome): FixtureReport {
  const wav = readWav(readFileSync(fixture.wavPath));
  const mono = downmixToMono(wav.samples, wav.channels);
  const sampleRate = wav.sampleRate;
  const durationMs = (mono.length / sampleRate) * 1000;

  const env = envelopeOf(mono, sampleRate);
  const attacks = attackTimesMs(env);

  const events = [...fixture.label.events].sort((a, b) => a.startMs - b.startMs);

  /* Room tone: everything before the first label. */
  let roomTone: RoomToneReport | null = null;
  const firstStart = events[0]?.startMs;
  if (firstStart !== undefined && firstStart > 0) {
    const frames = Math.max(1, Math.floor(firstStart / env.hopMs));
    let sum = 0;
    let maxRms = 0;
    let maxPeak = 0;
    let above = 0;
    for (let i = 0; i < frames && i < env.rms.length; i++) {
      const r = env.rms[i] as number;
      sum += r;
      if (r > maxRms) maxRms = r;
      if ((env.peak[i] as number) > maxPeak) maxPeak = env.peak[i] as number;
      if (r >= RMS_GATE) above++;
    }
    const counted = Math.min(frames, env.rms.length);
    roomTone = {
      headStartMs: 0,
      headEndMs: firstStart,
      meanRms: sum / Math.max(1, counted),
      maxRms,
      maxPeak,
      aboveGateFraction: above / Math.max(1, counted),
      isRoomTone: maxRms < RMS_GATE,
    };
  }

  const yin = new YinDetector({
    sampleRate,
    windowSize: PITCH_WINDOW,
    minFrequencyHz: 70,
    maxFrequencyHz: 1400,
    threshold: 0.13,
  });
  const chroma = new ChromaAnalyzer({
    sampleRate,
    fftSize: CHROMA_FFT,
    minFrequencyHz: 70,
    maxFrequencyHz: 1400,
  });
  const pitchWindow = new Float32Array(PITCH_WINDOW);
  const chromaWindow = new Float32Array(CHROMA_FFT);

  // Neighbour onsets, so the attack search cannot reach past the midpoint into
  // the stroke before or after. See `ONSET_SEARCH_MS`.
  const starts = events.map((event) => event.startMs).sort((a, b) => a - b);

  const labels: LabelReport[] = events.map((event) => {
    const concerns: string[] = [];

    /* Attack alignment. */
    const index = starts.indexOf(event.startMs);
    const previous = index > 0 ? (starts[index - 1] as number) : null;
    const next = index >= 0 && index < starts.length - 1 ? (starts[index + 1] as number) : null;
    const earliest = Math.max(
      event.startMs - ONSET_SEARCH_MS,
      previous === null ? -Infinity : (previous + event.startMs) / 2
    );
    const latest = Math.min(
      event.startMs + ONSET_SEARCH_MS,
      next === null ? Infinity : (event.startMs + next) / 2
    );
    let nearest: number | null = null;
    for (const at of attacks) {
      if (at < earliest || at > latest) continue;
      const delta = at - event.startMs;
      if (nearest === null || Math.abs(delta) < Math.abs(nearest)) nearest = delta;
    }
    const attackAligned = nearest !== null;

    /* Audibility over the label's own span. */
    const from = Math.max(0, Math.floor(event.startMs / env.hopMs));
    const to = Math.min(env.rms.length, Math.ceil(event.endMs / env.hopMs));
    let sum = 0;
    let maxRms = 0;
    for (let i = from; i < to; i++) {
      const r = env.rms[i] as number;
      sum += r;
      if (r > maxRms) maxRms = r;
    }
    const spanMeanRms = sum / Math.max(1, to - from);
    const audible = maxRms >= RMS_GATE;

    /* Pitch evidence. */
    const probe = probeSpan(
      mono, sampleRate, event.startMs, event.endMs,
      yin, chroma, pitchWindow, chromaWindow
    );
    const expected = expectedPitchClassesOf(event);
    const observedSet = new Set(probe.pitchClasses);
    const supported = expected.filter((pc) => observedSet.has(pc));

    if (!audible) concerns.push("span never rises above the engine's rmsGate");
    if (!attackAligned) {
      // Reported, never disqualifying. Two ordinary things produce a played
      // event with no energy rise of its own: a legato or tied note, where the
      // pick never re-attacks, and a MUTED restrum, which damps the strings and
      // so puts total energy DOWN while plainly re-articulating the chord —
      // eight of the sixteen strokes on each power-chord take are muted by
      // construction, and `scripts/measure-mute-witness.ts` shows every one of
      // them is real. Only inaudibility or an absent pitch class can put a label
      // on the exception list.
      const window = Math.round(Math.min(event.startMs - earliest, latest - event.startMs));
      concerns.push(
        `no energy rise within ${window}ms of startMs ` +
          "(a legato, tied or muted event has none of its own)"
      );
    }
    if (expected.length > 0 && supported.length === 0) {
      concerns.push(
        `none of the labeled pitch classes (${expected.join(", ")}) found; ` +
          `observed ${probe.pitchClasses.slice(0, 4).join(", ") || "nothing"}`
      );
    }

    return {
      id: event.id,
      kind: event.kind,
      label: event.label,
      startMs: event.startMs,
      endMs: event.endMs,
      required: event.required !== false,
      nearestAttackDeltaMs: nearest,
      attackAligned,
      spanMeanRms,
      spanMaxRms: maxRms,
      audible,
      observedPitchClasses: probe.pitchClasses.slice(0, 6),
      observedPitches: probe.pitches.slice(0, 4),
      expectedPitchClasses: expected,
      supportedPitchClasses: supported,
      pitchSupported: expected.length === 0 || supported.length > 0,
      concerns,
    };
  });

  return {
    stem: fixture.stem,
    wavPath: relative(REPO_ROOT, fixture.wavPath),
    sampleRate,
    durationMs,
    labelCount: labels.length,
    roomTone,
    labels,
    concerningLabelIds: labels.filter((l) => l.concerns.length > 0).map((l) => l.id),
  };
}

/* -------------------------------------------------------------------------- */
/* Printing                                                                    */
/* -------------------------------------------------------------------------- */

function printFixture(report: FixtureReport): void {
  const out = process.stdout;
  out.write(`\n${"-".repeat(88)}\n${report.stem}\n`);
  out.write(
    `  audio ${(report.durationMs / 1000).toFixed(2)}s @ ${report.sampleRate}Hz   ` +
      `${report.labelCount} labels\n`
  );

  if (report.roomTone) {
    const rt = report.roomTone;
    out.write(
      `  head 0-${rt.headEndMs}ms: meanRms ${rt.meanRms.toExponential(2)} ` +
        `maxRms ${rt.maxRms.toExponential(2)} maxPeak ${rt.maxPeak.toFixed(4)} ` +
        `-> ${rt.isRoomTone ? "ROOM TONE (below rmsGate)" : `SIGNAL PRESENT (${(rt.aboveGateFraction * 100).toFixed(1)}% of frames above gate)`}\n`
    );
  }

  const head = ["id", "label", "startMs", "attackΔ", "rms", "aud", "pitch", "observed"];
  const rows = report.labels.map((l) => [
    l.id,
    l.label,
    String(l.startMs),
    l.nearestAttackDeltaMs === null ? "none" : l.nearestAttackDeltaMs.toFixed(0),
    l.spanMaxRms.toFixed(4),
    l.audible ? "y" : "N",
    l.pitchSupported ? "y" : "N",
    l.observedPitchClasses.slice(0, 4).join(",") || "-",
  ]);
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] as string).length))
  );
  out.write(`  ${head.map((h, i) => h.padEnd(widths[i] as number)).join("  ")}\n`);
  out.write(`  ${widths.map((w) => "-".repeat(w)).join("  ")}\n`);
  for (const row of rows) {
    out.write(`  ${row.map((c, i) => (c as string).padEnd(widths[i] as number)).join("  ")}\n`);
  }

  const concerning = report.labels.filter((l) => l.concerns.length > 0);
  if (concerning.length === 0) {
    out.write("  no concerns: every label is audible, attack-aligned and pitch-supported.\n");
  } else {
    out.write(`\n  ${concerning.length} label(s) with concerns:\n`);
    for (const l of concerning) {
      for (const c of l.concerns) out.write(`    ${l.id} (${l.label}): ${c}\n`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

function main(): number {
  mkdirSync(CACHE_DIR, { recursive: true });
  const fixtures = decodeFixtures({ quiet: true });

  process.stdout.write("tuninator fixture verification\n");
  process.stdout.write(
    `  ${fixtures.length} fixtures   rmsGate=${RMS_GATE}   ` +
      "labels are READ-ONLY; this reports evidence only\n"
  );

  const reports = fixtures.map((fixture) => {
    const report = verifyFixture(fixture);
    printFixture(report);
    return report;
  });

  const totalLabels = reports.reduce((n, r) => n + r.labelCount, 0);
  const totalConcerns = reports.reduce((n, r) => n + r.concerningLabelIds.length, 0);
  const unsupported = reports.flatMap((r) =>
    r.labels.filter((l) => !l.audible || !l.pitchSupported).map((l) => `${r.stem}:${l.id}`)
  );

  process.stdout.write(`\n${"-".repeat(88)}\nsummary\n`);
  process.stdout.write(`  ${totalLabels} labels, ${totalConcerns} with at least one concern\n`);
  process.stdout.write(
    `  labels the audio does NOT support (inaudible or wrong pitch): ` +
      `${unsupported.length === 0 ? "none" : unsupported.join(", ")}\n`
  );
  process.stdout.write(
    "  -> a label listed above is the ONLY kind that may become a missed-label\n" +
      "     exception in fixtures/eval.config.json, and only with a written justification.\n"
  );

  const path = join(CACHE_DIR, "fixture-verification.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        rmsGate: RMS_GATE,
        onsetSearchMs: ONSET_SEARCH_MS,
        note:
          "Evidence only. fixtures/labels/*.json is ground truth and is never " +
          "written to. A label is only eligible for a missed-label exception if " +
          "`audible` is false or `pitchSupported` is false.",
        totals: { labels: totalLabels, withConcerns: totalConcerns, unsupported },
        fixtures: reports,
      },
      null,
      2
    )}\n`
  );
  process.stdout.write(`\n  report: ${relative(REPO_ROOT, path)}\n`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`verify-fixtures: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
