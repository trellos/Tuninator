/**
 * Block-in -> PitchFrame-out. Drives YIN, onset, and chroma at the hop.
 *
 * Window and hop are decoupled: a ring buffer accumulates input, and every hop
 * the detector analyses the most recent N samples. That is what gives a ~13ms
 * update rate without breaking low E (one period of 82.4Hz is ~582 samples, and
 * YIN needs roughly two, so the long window is 2048 even though the hop is 640).
 *
 * 640, not the 576 that `pitchHopMs: 12` literally asks for at 48kHz: the hop is
 * snapped to a whole number of 128-sample render quanta, and 576 is 4.5 of them.
 * `hopSamples` is the number that actually governs everything downstream.
 *
 * The dual-window trick is what makes fast passages tractable. In the fixtures
 * the timing pressure and the pitch range are inversely correlated: the slow
 * quarter notes are low (123-220Hz) and need the long window, while the 125ms
 * sixteenths are high (440-554Hz), where two periods is ~200 samples. So both
 * windows run every hop and the short one wins whenever it is confident and
 * high enough to be trustworthy.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports. This exact code runs
 * in the AudioWorklet, in Node, and in Vitest; the offline eval is trustworthy
 * only because there is no separate offline detector.
 */

import type { PitchFrame } from "../types.js";
import type { Policy } from "./policy.js";
import { YinDetector, zeroCrossingRateHz, rms as windowRms, peak as windowPeak } from "./yin.js";
import { OnsetDetector } from "./onset.js";
import { ChromaAnalyzer, ChromaSmoother } from "./chroma.js";
import { matchChord } from "./chords.js";
import { describeFrequency } from "./notes.js";
import type { ChordMatch } from "./chords.js";
import type { ChromaResult } from "./chroma.js";

/** One hop's worth of analysis: the public frame plus tracker-only detail. */
export type EngineFrame = {
  frame: PitchFrame;
  /** True when the onset detector fired on this hop. */
  onset: boolean;
  /**
   * When that attack actually happened. The onset detector needs to see the
   * hops after a flux peak before it can call it one, so it reports a few hops
   * late and stamps the report with the real time. Null when `onset` is false.
   */
  onsetAt: number | null;
  onsetFlux: number;
  /** Null when chord detection is disabled by policy. */
  chroma: ChromaResult | null;
  chord: ChordMatch | null;
};

/** Matches the AudioWorklet render quantum. */
const RENDER_QUANTUM = 128;

/** Ring capacity. Power of two, and >= the largest analysis window (4096). */
const RING_CAPACITY = 8192;

/** Run the (expensive) 4096-point chroma path once every N hops. */
const CHORD_HOP_DIVISOR = 4;

/**
 * How close to a whole number of octaves a disagreement must be before it is
 * treated as an octave error rather than two detectors seeing different notes.
 * ~0.12 octaves is a little over a semitone.
 */
const OCTAVE_TOLERANCE = 0.12;

export class PitchEngine {
  readonly sampleRate: number;
  /** Hop in samples, snapped to a whole number of 128-sample render quanta. */
  readonly hopSamples: number;

  private policy: Policy;

  private readonly ring = new Float32Array(RING_CAPACITY);
  private writeIndex = 0;
  private samplesWritten = 0;
  private samplesSinceHop = 0;

  private longWindow: Float32Array;
  private shortWindow: Float32Array;
  private onsetWindow: Float32Array;
  private chromaWindow: Float32Array;

  private yinLong: YinDetector;
  private yinShort: YinDetector;
  private onsetDetector: OnsetDetector;
  private chromaAnalyzer: ChromaAnalyzer | null = null;
  private chromaSmoother: ChromaSmoother | null = null;
  /** Set by an onset, cleared once the next chroma hop has acted on it. */
  private chromaBoundaryPending = false;

  /** Circular buffer of recent voiced frequencies, for the temporal median. */
  private readonly medianBuf: number[] = [];
  private hopCounter = 0;

  /** Cached across hops so every frame carries the most recent chord estimate. */
  private lastChroma: ChromaResult | null = null;
  private lastChord: ChordMatch | null = null;

  constructor(sampleRate: number, policy: Policy) {
    this.sampleRate = sampleRate;
    this.policy = policy;

    assertWindowsFitRing(policy);

    this.hopSamples = snapHop(policy.analysis.pitchHopMs, sampleRate);

    this.longWindow = new Float32Array(policy.pitch.longWindow);
    this.shortWindow = new Float32Array(policy.pitch.shortWindow);
    this.onsetWindow = new Float32Array(policy.onset.fftSize);
    this.chromaWindow = new Float32Array(policy.chords.fftSize);

    this.yinLong = new YinDetector({
      sampleRate,
      windowSize: policy.pitch.longWindow,
      minFrequencyHz: policy.analysis.minFrequencyHz,
      maxFrequencyHz: policy.analysis.maxFrequencyHz,
      threshold: policy.pitch.yinThreshold,
    });

    // The short window physically cannot resolve two periods of a low note, so
    // its search is bounded below. Asking it for low E would only produce
    // confident nonsense.
    this.yinShort = new YinDetector({
      sampleRate,
      windowSize: policy.pitch.shortWindow,
      minFrequencyHz: Math.max(
        policy.analysis.minFrequencyHz,
        (2 * sampleRate) / policy.pitch.shortWindow
      ),
      maxFrequencyHz: policy.analysis.maxFrequencyHz,
      threshold: policy.pitch.yinThreshold,
    });

    this.onsetDetector = new OnsetDetector({
      sampleRate,
      fftSize: policy.onset.fftSize,
      minIntervalMs: policy.onset.minIntervalMs,
      medianWindow: policy.onset.medianWindow,
      sensitivity: policy.onset.sensitivity,
        peakWindow: policy.onset.peakWindow,
        rippleFloorFactor: policy.onset.rippleFloorFactor,
    });

    if (policy.chords.enabled) {
      this.chromaAnalyzer = new ChromaAnalyzer({
        sampleRate,
        fftSize: policy.chords.fftSize,
        minFrequencyHz: policy.analysis.minFrequencyHz,
        maxFrequencyHz: policy.analysis.maxFrequencyHz,
        magnitudeExponent: policy.chords.magnitudeExponent,
        harmonicDecay: policy.chords.harmonicDecay,
        envelopes: policy.chords.envelopes,
        fundamentalMinRatio: policy.chords.fundamentalMinRatio,
        presenceRatio: policy.chords.presenceRatio,
        contrast: policy.chords.contrast,
      });
      this.chromaSmoother = new ChromaSmoother(policy.chords.smoothingFrames);
    }
  }

  /**
   * Swaps policy in place. `setMode()` must never restart the audio graph, so
   * this only rebuilds the pieces whose *shape* changed; the ring buffer and
   * accumulated audio survive untouched.
   */
  setPolicy(policy: Policy): void {
    assertWindowsFitRing(policy);
    const prev = this.policy;
    this.policy = policy;

    const pitchShapeChanged =
      policy.pitch.longWindow !== prev.pitch.longWindow ||
      policy.pitch.shortWindow !== prev.pitch.shortWindow ||
      policy.pitch.yinThreshold !== prev.pitch.yinThreshold ||
      policy.analysis.minFrequencyHz !== prev.analysis.minFrequencyHz ||
      policy.analysis.maxFrequencyHz !== prev.analysis.maxFrequencyHz;

    if (pitchShapeChanged) {
      this.longWindow = new Float32Array(policy.pitch.longWindow);
      this.shortWindow = new Float32Array(policy.pitch.shortWindow);
      this.yinLong = new YinDetector({
        sampleRate: this.sampleRate,
        windowSize: policy.pitch.longWindow,
        minFrequencyHz: policy.analysis.minFrequencyHz,
        maxFrequencyHz: policy.analysis.maxFrequencyHz,
        threshold: policy.pitch.yinThreshold,
      });
      this.yinShort = new YinDetector({
        sampleRate: this.sampleRate,
        windowSize: policy.pitch.shortWindow,
        minFrequencyHz: Math.max(
          policy.analysis.minFrequencyHz,
          (2 * this.sampleRate) / policy.pitch.shortWindow
        ),
        maxFrequencyHz: policy.analysis.maxFrequencyHz,
        threshold: policy.pitch.yinThreshold,
      });
    }

    const onsetShapeChanged =
      policy.onset.fftSize !== prev.onset.fftSize ||
      policy.onset.minIntervalMs !== prev.onset.minIntervalMs ||
      policy.onset.medianWindow !== prev.onset.medianWindow ||
      policy.onset.sensitivity !== prev.onset.sensitivity ||
      policy.onset.peakWindow !== prev.onset.peakWindow ||
      policy.onset.rippleFloorFactor !== prev.onset.rippleFloorFactor;

    if (onsetShapeChanged) {
      this.onsetWindow = new Float32Array(policy.onset.fftSize);
      this.onsetDetector = new OnsetDetector({
        sampleRate: this.sampleRate,
        fftSize: policy.onset.fftSize,
        minIntervalMs: policy.onset.minIntervalMs,
        medianWindow: policy.onset.medianWindow,
        sensitivity: policy.onset.sensitivity,
        peakWindow: policy.onset.peakWindow,
        rippleFloorFactor: policy.onset.rippleFloorFactor,
      });
    }

    if (policy.chords.enabled) {
      const chromaShapeChanged =
        !this.chromaAnalyzer ||
        policy.chords.fftSize !== prev.chords.fftSize ||
        policy.chords.magnitudeExponent !== prev.chords.magnitudeExponent ||
        policy.chords.harmonicDecay !== prev.chords.harmonicDecay ||
        policy.chords.envelopes !== prev.chords.envelopes ||
        policy.chords.fundamentalMinRatio !== prev.chords.fundamentalMinRatio ||
        policy.chords.presenceRatio !== prev.chords.presenceRatio ||
        policy.chords.contrast !== prev.chords.contrast;
      if (chromaShapeChanged) {
        this.chromaWindow = new Float32Array(policy.chords.fftSize);
        this.chromaAnalyzer = new ChromaAnalyzer({
          sampleRate: this.sampleRate,
          fftSize: policy.chords.fftSize,
          minFrequencyHz: policy.analysis.minFrequencyHz,
          maxFrequencyHz: policy.analysis.maxFrequencyHz,
          magnitudeExponent: policy.chords.magnitudeExponent,
          harmonicDecay: policy.chords.harmonicDecay,
          envelopes: policy.chords.envelopes,
          fundamentalMinRatio: policy.chords.fundamentalMinRatio,
            presenceRatio: policy.chords.presenceRatio,
          contrast: policy.chords.contrast,
        });
      }
      if (chromaShapeChanged || policy.chords.smoothingFrames !== prev.chords.smoothingFrames) {
        this.chromaSmoother = new ChromaSmoother(policy.chords.smoothingFrames);
      }
    } else {
      this.chromaAnalyzer = null;
      this.chromaSmoother = null;
      this.lastChroma = null;
      this.lastChord = null;
    }

    if (policy.pitch.medianFrames < this.medianBuf.length) {
      this.medianBuf.length = policy.pitch.medianFrames;
    }
  }

  /**
   * Push one render quantum. Returns a frame only on hop boundaries.
   * `timestampMs` is the time of the *first* sample in `block`.
   */
  push(block: Float32Array, timestampMs: number): EngineFrame | null {
    const n = block.length;
    const mask = RING_CAPACITY - 1;
    for (let i = 0; i < n; i++) {
      this.ring[this.writeIndex] = block[i]!;
      this.writeIndex = (this.writeIndex + 1) & mask;
    }
    this.samplesWritten += n;
    this.samplesSinceHop += n;

    if (this.samplesSinceHop < this.hopSamples) return null;
    this.samplesSinceHop -= this.hopSamples;

    // Timestamp the END of the analysed audio: that is the moment the frame
    // describes, and it keeps frame times comparable with event times.
    const hopTimestamp = timestampMs + (n / this.sampleRate) * 1000;
    return this.analyze(hopTimestamp);
  }

  reset(): void {
    this.ring.fill(0);
    this.writeIndex = 0;
    this.samplesWritten = 0;
    this.samplesSinceHop = 0;
    this.medianBuf.length = 0;
    this.hopCounter = 0;
    this.lastChroma = null;
    this.lastChord = null;
    this.chromaBoundaryPending = false;
    this.chromaSmoother?.reset();
    this.onsetDetector.reset();
  }

  /** Copies the most recent `count` samples out of the ring, oldest first. */
  private readRecent(out: Float32Array, count: number): void {
    const mask = RING_CAPACITY - 1;
    let read = (this.writeIndex - count) & mask;
    for (let i = 0; i < count; i++) {
      out[i] = this.ring[read]!;
      read = (read + 1) & mask;
    }
  }

  private analyze(timestamp: number): EngineFrame {
    const policy = this.policy;
    this.hopCounter++;

    this.readRecent(this.longWindow, this.longWindow.length);
    const rms = windowRms(this.longWindow);
    const peak = windowPeak(this.longWindow);

    const gatedByAmplitude = rms < policy.analysis.rmsGate;
    // Until the ring holds a full long window the detector would be analysing
    // zeros, which reads as a confident low pitch. Suppress rather than lie.
    const warmedUp = this.samplesWritten >= this.longWindow.length;

    // Onset runs BEFORE pitch, because an attack invalidates the pitch history:
    // the median buffer holds the previous note's frequencies, and letting them
    // outvote the first frames of a new note delays its identity by up to
    // `medianFrames` hops. On a 166ms triplet that lag is enough to push the
    // event's dominant pitch onto the following note.
    let onset = false;
    let onsetAt: number | null = null;
    let onsetFlux = 0;
    if (policy.onset.enabled && warmedUp) {
      this.readRecent(this.onsetWindow, this.onsetWindow.length);
      const result = this.onsetDetector.process(this.onsetWindow, timestamp);
      onset = result.isOnset && !gatedByAmplitude;
      onsetAt = onset ? result.onsetTimestampMs : null;
      onsetFlux = result.flux;
      if (onset) {
        this.medianBuf.length = 0;
        // The chroma runs at a fraction of the hop rate, so the attack usually
        // lands between chroma frames. Remember it until the next one, or the
        // smoother would average the old chord into the new one.
        this.chromaBoundaryPending = true;
      }
    }

    let frequencyHz: number | null = null;
    let confidence = 0;
    let tau: number | null = null;
    let cmnd: number | null = null;
    let zeroCrossingHz: number | null = null;

    if (!gatedByAmplitude && warmedUp) {
      const long = this.yinLong.detect(this.longWindow);

      this.readRecent(this.shortWindow, this.shortWindow.length);
      const short = this.yinShort.detect(this.shortWindow);

      zeroCrossingHz = zeroCrossingRateHz(this.longWindow, this.sampleRate);

      // Prefer the short window when it is confident and high enough that its
      // window really does span two periods: at 512 against 2048 that is 4x
      // better time resolution, which is what makes 125ms sixteenths resolvable.
      const shortUsable =
        short.frequencyHz !== null &&
        short.frequencyHz >= policy.pitch.shortWindowMinHz &&
        short.confidence >= policy.analysis.confidenceGate;

      let chosen = shortUsable ? short : long;

      // The two windows are independent witnesses, and they fail differently.
      // The long window searches lags all the way down to minFrequencyHz, so on
      // a high note its CMND dips at every multiple of the true period and it
      // can lock onto one — E5 read as E2 is a real observed failure, a clean
      // 8x. The short window's search range physically excludes those lags, so
      // when the long window reports an exact octave-multiple BELOW the short
      // one, the short one is the trustworthy witness.
      if (
        short.frequencyHz !== null &&
        long.frequencyHz !== null &&
        short.frequencyHz >= policy.pitch.shortWindowMinHz &&
        chosen === long
      ) {
        const octaves = Math.log2(short.frequencyHz / long.frequencyHz);
        const nearest = Math.round(octaves);
        if (nearest >= 1 && Math.abs(octaves - nearest) < OCTAVE_TOLERANCE) {
          chosen = short;
        }
      }

      frequencyHz = chosen.frequencyHz;
      confidence = chosen.confidence;
      tau = chosen.tau;
      cmnd = chosen.cmnd;

      // Zero crossing is crude, but it fails in different ways than YIN does,
      // which is exactly what makes it usable as an arbiter. Rather than merely
      // distrusting an octave disagreement, correct it: if the reading is an
      // exact octave multiple away from the ZCR estimate, move it onto the
      // octave ZCR supports. Halving confidence instead just pushed the frame
      // under the gate, which read as a dropout and split the note in two.
      //
      // Only multi-octave gaps qualify. Zero crossing counts run HIGH on a
      // harmonic-rich string, so a one-octave disagreement is genuinely
      // ambiguous — acting on those turned correct readings into octave-up
      // errors (C#5 reported as B5). A 3-octave gap has no such excuse.
      if (frequencyHz !== null && zeroCrossingHz > 0) {
        const octaves = Math.log2(zeroCrossingHz / frequencyHz);
        const nearest = Math.round(octaves);
        if (Math.abs(nearest) >= 2 && Math.abs(octaves - nearest) < OCTAVE_TOLERANCE) {
          const corrected = frequencyHz * Math.pow(2, nearest);
          if (
            corrected >= policy.analysis.minFrequencyHz &&
            corrected <= policy.analysis.maxFrequencyHz
          ) {
            frequencyHz = corrected;
            if (tau !== null) tau /= Math.pow(2, nearest);
          } else {
            confidence *= 0.5;
          }
        }
      }

      if (confidence < policy.analysis.confidenceGate) {
        frequencyHz = null;
      }
    }

    // Temporal median over recent voiced frames. Median (not mean) keeps the
    // value an actually-observed one, so a single octave-flipped frame is
    // discarded rather than averaged into a pitch that was never played.
    if (frequencyHz !== null && policy.pitch.medianFrames > 1) {
      this.medianBuf.push(frequencyHz);
      if (this.medianBuf.length > policy.pitch.medianFrames) this.medianBuf.shift();
      frequencyHz = medianOf(this.medianBuf);
    } else if (frequencyHz === null) {
      this.medianBuf.length = 0;
    }

    const frame: PitchFrame = {
      timestamp,
      frequencyHz,
      confidence,
      nearest: frequencyHz === null ? null : describeFrequency(frequencyHz),
      amplitude: { rms, peak },
      detector: {
        tau,
        cmnd,
        zeroCrossingHz,
        effectiveSampleRate: this.sampleRate,
      },
    };

    if (
      this.chromaAnalyzer &&
      !gatedByAmplitude &&
      warmedUp &&
      this.hopCounter % CHORD_HOP_DIVISOR === 0
    ) {
      this.readRecent(this.chromaWindow, this.chromaWindow.length);
      const chroma = this.chromaAnalyzer.analyze(this.chromaWindow);
      if (this.chromaBoundaryPending) {
        this.chromaSmoother?.reset();
        this.chromaBoundaryPending = false;
      }
      const smoothed = this.chromaSmoother?.push(chroma.chroma) ?? chroma.chroma;
      this.lastChroma = chroma;
      this.lastChord = matchChord(smoothed, {
        floor: policy.chords.floor,
        margin: policy.chords.margin,
        bassPitchClass: chroma.bassPitchClass,
      });
    } else if (gatedByAmplitude) {
      this.lastChroma = null;
      this.lastChord = null;
      this.chromaSmoother?.reset();
    }

    return {
      frame,
      onset,
      onsetAt,
      onsetFlux,
      chroma: this.lastChroma,
      chord: this.lastChord,
    };
  }
}

/**
 * `readRecent` walks backwards from the write head with a wrapping mask, so a
 * window larger than the ring silently reads samples the same pass just
 * overwrote — aliased audio, no error, and plausible-looking output. Refuse it
 * at the point the policy arrives rather than producing nonsense later.
 */
function assertWindowsFitRing(policy: Policy): void {
  const largest = Math.max(
    policy.pitch.longWindow,
    policy.pitch.shortWindow,
    policy.onset.fftSize,
    policy.chords.fftSize
  );
  if (largest > RING_CAPACITY) {
    throw new Error(
      `PitchEngine: analysis window of ${largest} samples exceeds the ` +
        `${RING_CAPACITY}-sample ring buffer`
    );
  }
}

/** Snap a requested hop to a whole number of render quanta, minimum one. */
export function snapHop(pitchHopMs: number, sampleRate: number): number {
  const requested = (pitchHopMs / 1000) * sampleRate;
  const quanta = Math.max(1, Math.round(requested / RENDER_QUANTUM));
  return quanta * RENDER_QUANTUM;
}

/** Median of a small array. Copies, so it never reorders the caller's buffer. */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
