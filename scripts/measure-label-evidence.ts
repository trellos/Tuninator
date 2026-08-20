/**
 * What the audio actually looks like at one labelled instant.
 *
 * The downstream ledger names the branch that discarded a played note. This
 * answers the question one step further back: was there anything there to
 * discard. It mirrors `kernels/onset.ts` hop by hop — the same window, the same
 * hop, the same bands, the same reference — and prints, per hop, every quantity
 * the kernel's decision is made of: each band's flux against its own magnitude,
 * each band's magnitude against its own recent peak, the held corroboration,
 * and the broadband envelope against its baseline.
 *
 * The mirror is checked against the real kernel on every hop of every fixture
 * it reads (`--verify`), so a diagnostic can never describe a detector that no
 * longer exists.
 *
 * Every contrast printed here is WITHIN one file. Recording levels differ by
 * orders of magnitude between the direct, amped and mic paths, so a number
 * compared across files measures the recording rather than the playing.
 *
 * Usage:
 *   npx tsx scripts/measure-label-evidence.ts <stem-substring> <labelId>[,<labelId>...]
 *   npx tsx scripts/measure-label-evidence.ts --verify
 */

import { readFileSync } from "node:fs";
import { RealFFT, hannWindow } from "../src/engine/kernels/fft.js";
import { OnsetDetector } from "../src/engine/kernels/onset.js";
import { DEFAULT_ENGINE_CONFIG, snapHop } from "../src/engine/config.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/** Mirrors of the constants the kernel decides with. */
const ARRIVAL_BAND_EDGES_HZ = [0, 200, 500, 1200, 3000, 8000];
const BAND_MIN_BINS = 8;
const BAND_SHARE_FLOOR = 0.005;
const BAND_RISE = 1.05;
const ARRIVAL_FLOOR_FACTOR = 0.22;
const ABSOLUTE_FLUX_FLOOR = 1e-3;
const HELD_CORROBORATION = 0.45;
const REPORTED_REFERENCE_DECAY = 0.95;
const REPORTED_FLOOR_FACTOR = 2 * (1 - REPORTED_REFERENCE_DECAY);
const MIN_ARRIVAL_BANDS = 2;

type HopReading = {
  at: number;
  rms: number;
  audible: boolean;
  arrived: number;
  /** Per band: flux/(floor*magnitude), magnitude/recent peak, share of frame. */
  bands: Array<{ fluxOverFloor: number; rise: number; share: number }>;
  heldOverBar: number;
  isOnset: boolean;
  suppressed: boolean;
  riseRatio: number;
};

class Mirror {
  private readonly fft: RealFFT;
  private readonly hann: Float32Array;
  private readonly windowed: Float32Array;
  private readonly magnitude: Float32Array;
  private readonly history: Float32Array;
  private readonly reportedReference: Float32Array;
  private readonly bandEdges: number[];
  private readonly magnitudeScale: number;
  private readonly fluxHistory: number[] = [];
  private historyIndex = 0;
  private historyFilled = 0;
  private bandHistory: number[][] = [];
  private lastOnsetMs: number | null = null;

  constructor(
    private readonly sampleRate: number,
    private readonly fftSize: number,
    private readonly referenceFrames: number,
    private readonly minIntervalMs: number,
    private readonly medianWindow: number,
    private readonly sensitivity: number
  ) {
    this.fft = new RealFFT(fftSize);
    this.hann = hannWindow(fftSize);
    this.windowed = new Float32Array(fftSize);
    this.magnitude = new Float32Array(this.fft.bins);
    this.history = new Float32Array(this.fft.bins * referenceFrames);
    this.reportedReference = new Float32Array(this.fft.bins);
    let windowSum = 0;
    for (let i = 0; i < fftSize; i++) windowSum += this.hann[i] as number;
    this.magnitudeScale = 2 / windowSum;

    const binHz = sampleRate / fftSize;
    const edges = [0];
    for (const hz of ARRIVAL_BAND_EDGES_HZ) {
      const bin = Math.round(hz / binHz);
      if (bin - (edges[edges.length - 1] as number) >= BAND_MIN_BINS && bin < this.fft.bins) {
        edges.push(bin);
      }
    }
    if (edges.length > 1 && this.fft.bins - (edges[edges.length - 1] as number) < BAND_MIN_BINS) {
      edges.pop();
    }
    edges.push(this.fft.bins);
    this.bandEdges = edges;
    this.bandHistory = Array.from({ length: referenceFrames }, () =>
      new Array<number>(edges.length - 1).fill(0)
    );
  }

  process(window: Float32Array, at: number, audible: boolean): HopReading {
    const { magnitude, history, bandEdges } = this;
    const bins = magnitude.length;
    for (let i = 0; i < this.fftSize; i++) {
      this.windowed[i] = (window[i] as number) * (this.hann[i] as number);
    }
    this.fft.magnitudes(this.windowed, magnitude);
    for (let k = 0; k < bins; k++) magnitude[k] = (magnitude[k] as number) * this.magnitudeScale;

    const bandCount = bandEdges.length - 1;
    const bandFlux = new Array<number>(bandCount).fill(0);
    const bandMagnitude = new Array<number>(bandCount).fill(0);
    let flux = 0;
    let total = 0;
    let heldFlux = 0;
    for (let b = 0; b < bandCount; b++) {
      for (let k = bandEdges[b] as number; k < (bandEdges[b + 1] as number); k++) {
        const scaled = magnitude[k] as number;
        bandMagnitude[b] = (bandMagnitude[b] as number) + scaled;
        const held = scaled - (this.reportedReference[k] as number);
        if (held > 0) heldFlux += held;
        let reference = 0;
        for (let f = 0; f < this.historyFilled; f++) {
          const past = history[f * bins + k] as number;
          if (past > reference) reference = past;
        }
        const delta = scaled - reference;
        if (delta > 0) bandFlux[b] = (bandFlux[b] as number) + delta;
      }
      flux += bandFlux[b] as number;
      total += bandMagnitude[b] as number;
    }

    const peaks = new Array<number>(bandCount).fill(0);
    for (let b = 0; b < bandCount; b++) {
      for (let f = 0; f < this.historyFilled; f++) {
        const past = (this.bandHistory[f] as number[])[b] as number;
        if (past > (peaks[b] as number)) peaks[b] = past;
      }
    }

    const median = this.medianFlux();
    const heldThreshold = Math.max(
      this.sensitivity * median,
      REPORTED_FLOOR_FACTOR * total,
      ABSOLUTE_FLUX_FLOOR
    );

    let arrived = 0;
    const bands: HopReading["bands"] = [];
    for (let b = 0; b < bandCount; b++) {
      const mag = bandMagnitude[b] as number;
      const share = mag / Math.max(total, 1e-12);
      const fluxOverFloor = (bandFlux[b] as number) / Math.max(ARRIVAL_FLOOR_FACTOR * mag, 1e-12);
      const rise = mag / Math.max(peaks[b] as number, 1e-12);
      bands.push({ fluxOverFloor, rise, share });
      if (share < BAND_SHARE_FLOOR) continue;
      if (fluxOverFloor <= 1) continue;
      if (rise <= BAND_RISE) continue;
      arrived++;
    }
    let isOnset =
      arrived >= MIN_ARRIVAL_BANDS &&
      flux > ABSOLUTE_FLUX_FLOOR &&
      heldFlux >= HELD_CORROBORATION * heldThreshold;
    if (!audible) isOnset = false;
    let suppressed = false;
    if (isOnset && this.lastOnsetMs !== null && at - this.lastOnsetMs < this.minIntervalMs) {
      isOnset = false;
      suppressed = true;
    }
    if (isOnset) this.lastOnsetMs = at;

    this.fluxHistory.push(heldFlux);
    if (this.fluxHistory.length > this.medianWindow) this.fluxHistory.shift();
    const slot = this.historyIndex * bins;
    for (let k = 0; k < bins; k++) history[slot + k] = magnitude[k] as number;
    for (let k = 0; k < bins; k++) {
      const decayed = (this.reportedReference[k] as number) * REPORTED_REFERENCE_DECAY;
      const current = magnitude[k] as number;
      this.reportedReference[k] = current > decayed ? current : decayed;
    }
    this.bandHistory[this.historyIndex] = bandMagnitude.slice();
    this.historyIndex = (this.historyIndex + 1) % this.referenceFrames;
    if (this.historyFilled < this.referenceFrames) this.historyFilled++;

    return {
      at,
      rms: 0,
      audible,
      arrived,
      bands,
      heldOverBar: heldFlux / Math.max(HELD_CORROBORATION * heldThreshold, 1e-12),
      isOnset,
      suppressed,
      riseRatio: 1,
    };
  }

  private medianFlux(): number {
    const n = this.fluxHistory.length;
    if (n === 0) return 0;
    const sorted = [...this.fluxHistory].sort((a, b) => a - b);
    const mid = n >> 1;
    return (n & 1) === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }
}

function readFixture(stem: string): {
  mono: Float32Array;
  sampleRate: number;
  labels: Array<{ id: string; startMs: number; label: string }>;
} {
  const fixture = decodeFixtures({ quiet: true }).find((f) => f.stem.includes(stem));
  if (fixture === undefined) throw new Error(`no fixture matching ${stem}`);
  const wav = readWav(readFileSync(fixture.wavPath));
  return {
    mono: downmixToMono(wav.samples, wav.channels),
    sampleRate: wav.sampleRate,
    labels: fixture.label.events.map((e) => ({ id: e.id, startMs: e.startMs, label: e.label })),
  };
}

function drive(
  mono: Float32Array,
  sampleRate: number
): { readings: HopReading[]; kernel: boolean[] } {
  const config = DEFAULT_ENGINE_CONFIG;
  const fftSize = config.transient.fluxFftSize;
  const hop = snapHop(config.analysis.hopMs, sampleRate);
  const hopMs = (hop / sampleRate) * 1000;
  const referenceFrames = Math.max(1, Math.round(config.transient.fluxReferenceMs / hopMs));
  const detector = new OnsetDetector({
    sampleRate,
    fftSize,
    minIntervalMs: config.transient.minIntervalMs,
    medianWindow: config.transient.fluxMedianWindow,
    sensitivity: config.transient.fluxSensitivity,
    referenceFrames,
  });
  const mirror = new Mirror(
    sampleRate,
    fftSize,
    referenceFrames,
    config.transient.minIntervalMs,
    config.transient.fluxMedianWindow,
    config.transient.fluxSensitivity
  );
  // The envelope witness the fast lane runs beside the kernel.
  const envWindow = Math.max(1, Math.round((config.transient.envelopeWindowMs / 1000) * sampleRate));
  const baselineFrames = Math.max(
    1,
    Math.round((config.transient.envelopeBaselineMs / 1000) * sampleRate / hop)
  );
  const rmsHistory: number[] = [];

  const frame = new Float32Array(fftSize);
  const readings: HopReading[] = [];
  const kernel: boolean[] = [];
  for (let start = 0; start + fftSize <= mono.length; start += hop) {
    frame.set(mono.subarray(start, start + fftSize));
    let energy = 0;
    for (let i = 0; i < fftSize; i++) energy += (frame[i] as number) * (frame[i] as number);
    const rms = Math.sqrt(energy / fftSize);
    const end = start + fftSize;
    let shortEnergy = 0;
    for (let i = Math.max(0, end - envWindow); i < end; i++) {
      shortEnergy += (mono[i] as number) * (mono[i] as number);
    }
    const shortRms = Math.sqrt(shortEnergy / envWindow);
    let baseline = shortRms;
    if (rmsHistory.length >= baselineFrames) {
      let sum = 0;
      for (let i = rmsHistory.length - baselineFrames; i < rmsHistory.length; i++) {
        sum += rmsHistory[i] as number;
      }
      baseline = sum / baselineFrames;
    }
    const riseRatio = shortRms / Math.max(baseline, 1e-9);
    rmsHistory.push(shortRms);
    if (rmsHistory.length > baselineFrames * 2) rmsHistory.shift();

    const audible = rms >= DEFAULT_ENGINE_CONFIG.analysis.rmsGate;
    const at = (end / sampleRate) * 1000;
    kernel.push(detector.process(frame, at, audible).isOnset);
    const reading = mirror.process(frame, at, audible);
    reading.rms = rms;
    reading.riseRatio = riseRatio;
    readings.push(reading);
  }
  return { readings, kernel };
}

function verify(): void {
  let hops = 0;
  let disagreements = 0;
  for (const fixture of decodeFixtures({ quiet: true })) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const { readings, kernel } = drive(mono, wav.sampleRate);
    for (let i = 0; i < readings.length; i++) {
      hops++;
      if ((readings[i] as HopReading).isOnset !== kernel[i]) disagreements++;
    }
  }
  console.log(`  mirror vs kernel: ${disagreements} disagreements over ${hops} hops`);
}

function main(): void {
  if (process.argv.includes("--verify")) {
    verify();
    return;
  }
  const stem = process.argv[2];
  const ids = (process.argv[3] ?? "").split(",").filter((s) => s !== "");
  if (stem === undefined) throw new Error("usage: <stem-substring> <labelId>[,<labelId>]");

  const { mono, sampleRate, labels } = readFixture(stem);
  const { readings } = drive(mono, sampleRate);
  const wanted = ids.length > 0 ? labels.filter((l) => ids.includes(l.id)) : labels;

  if (process.argv.includes("--why")) {
    // One line per label: did the kernel fire, and if not, which term of the
    // decision was the closest to passing.
    console.log("\n  label     at  fired  best hop  arr  held/bar  env  what blocked");
    for (const label of labels) {
      const near = readings.filter((r) => r.at >= label.startMs - 15 && r.at <= label.startMs + 60);
      const fired = near.find((r) => r.isOnset);
      // The hop with the most arrival bands, ties broken by held corroboration.
      let best = near[0];
      for (const r of near) {
        if (best === undefined) best = r;
        else if (r.arrived > best.arrived || (r.arrived === best.arrived && r.heldOverBar > best.heldOverBar)) best = r;
      }
      const b = best as HopReading | undefined;
      const blocked =
        fired !== undefined
          ? ""
          : b === undefined
            ? "no hop"
            : !b.audible
              ? "gated"
              : b.suppressed
                ? "dead time"
                : b.arrived < MIN_ARRIVAL_BANDS
                  ? `only ${b.arrived} band(s) arrived`
                  : b.heldOverBar < 1
                    ? "held corroboration"
                    : "interval lockout";
      console.log(
        `  ${label.id.padEnd(5)} ${label.startMs.toFixed(0).padStart(6)} ${(fired ? "yes" : "NO").padStart(5)}` +
          `  ${(b?.at ?? 0).toFixed(0).padStart(8)} ${String(b?.arrived ?? 0).padStart(4)}` +
          `  ${(b?.heldOverBar ?? 0).toFixed(2).padStart(8)} ${(b?.riseRatio ?? 0).toFixed(2).padStart(4)}  ${blocked}`
      );
    }
    return;
  }

  for (const label of wanted) {
    console.log(`\n  ${label.id} @${label.startMs.toFixed(0)} ${label.label}`);
    console.log(
      "    at      rms      env   held   arr  " +
        "bands: flux/floor x rise (share)"
    );
    for (const r of readings) {
      if (Math.abs(r.at - label.startMs) > 80) continue;
      const bands = r.bands
        .map(
          (b) =>
            `${b.fluxOverFloor.toFixed(2)}x${b.rise.toFixed(2)}` +
            `${b.share < BAND_SHARE_FLOOR ? "-" : b.fluxOverFloor > 1 && b.rise > BAND_RISE ? "*" : " "}`
        )
        .join(" ");
      console.log(
        `    ${r.at.toFixed(0).padStart(6)} ${r.rms.toExponential(2)} ` +
          `${r.riseRatio.toFixed(2).padStart(6)} ${r.heldOverBar.toFixed(2).padStart(6)} ` +
          `${String(r.arrived).padStart(3)}  ${bands}` +
          `${r.isOnset ? "  ONSET" : r.suppressed ? "  (dead time)" : !r.audible ? "  (gated)" : ""}`
      );
    }
  }
}

main();
