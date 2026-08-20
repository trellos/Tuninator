/**
 * Spectral-flux onset detection against a short-memory reference spectrum,
 * decided band by band.
 *
 * RMS envelope alone misses a re-picked same-pitch note, which the eval scores
 * as a missed event. Spectral flux is what catches it.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the DSP-core
 * workstream.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import { RealFFT, hannWindow } from "./fft.js";

export type OnsetOptions = {
  sampleRate: number;
  fftSize: number;
  /** Minimum inter-onset interval, ms. 120bpm sixteenths are 125ms apart. */
  minIntervalMs: number;
  /** Frames in the adaptive median window. */
  medianWindow: number;
  /** Multiplier on the adaptive median. Higher = fewer onsets. */
  sensitivity: number;
  /**
   * Lower edge of the band the flux is summed over, Hz. Zero means broadband.
   *
   * A pick is an impulse and spreads its energy across the spectrum; a string
   * already ringing is a few narrow low partials. Summing the flux over the
   * region where the pick's transient lives and the ringing note's fundamental
   * does not is what lets a quiet pick be heard over a loud sustain.
   */
  bandLoHz?: number;
  /** Upper edge of that band, Hz. Defaults to Nyquist. */
  bandHiHz?: number;
  /**
   * Threshold floor as a multiple of a band's own magnitude.
   *
   * See `ARRIVAL_FLOOR_FACTOR`. Exposed because this — not the adaptive median
   * — is the term that actually decides nearly every onset.
   */
  floorFactor?: number;
  /**
   * Hops of spectrum the flux reference remembers. See `REFERENCE_FRAMES`.
   * The caller knows the hop; the kernel does not, so the span in milliseconds
   * is the caller's to convert.
   */
  referenceFrames?: number;
  /**
   * How many arrival bands must fire together before the hop is an onset.
   * Zero puts the detector back on a single broadband comparison against
   * `threshold`; see `MIN_ARRIVAL_BANDS`.
   */
  minArrivalBands?: number;
};

export type OnsetResult = {
  isOnset: boolean;
  /**
   * Positive half-wave rectified spectral flux for this hop, measured against
   * the short reference the decision uses: "how much energy arrived since a
   * few hops ago".
   */
  flux: number;
  /** The adaptive threshold, on the same scale as `flux`. */
  threshold: number;
  /**
   * The same flux measured against a decaying per-bin peak hold: "how much of
   * this frame is new since the note began".
   *
   * The two answer different questions and the tracker needs both. A quiet
   * pick landing on a ringing note is plainly visible to the first and nearly
   * invisible to the second, which is why the second cannot be allowed to
   * decide that an onset happened. The sustain of a compressed chord is the
   * other way round — it churns from hop to hop and is flat against where the
   * chord started — which is why the first cannot be allowed to decide that a
   * chord was struck again.
   */
  heldFlux: number;
  /** The threshold `heldFlux` is measured against; same scale. */
  heldThreshold: number;
};

/**
 * Hops of spectrum the reference remembers: it is the per-bin MAXIMUM of the
 * last `REFERENCE_FRAMES` frames, and nothing older.
 *
 * A plain previous-frame reference is unusable at `fftSize` 1024 and 44.1kHz:
 * bin spacing is 43Hz, so the harmonics of a low E (82.4Hz, 1.9 bins apart)
 * are unresolved and their overlapping main lobes beat against each other as
 * the frame phase advances. Measured on a *perfectly steady* synthetic low E,
 * the successive-frame flux swings between 0.003 and 0.68 on alternate hops —
 * as large as a real pick attack. Taking the maximum over a few hops removes
 * that ripple: a bin that dips and comes back is measured against its own
 * recent peak, so the return reads as nothing new.
 *
 * What this must NOT do is remember a peak for as long as a note rings. The
 * detector held a decaying per-bin peak (0.95 a hop, so half a second of
 * memory) until it was measured against the corpus: during a ringing note that
 * reference stays high, and a quiet pick landing on top of a sounding note
 * cannot raise any bin above it. On the three sixteenths takes — 48 alternate-
 * picked strokes each — the decaying hold put a transient within 60ms of 131 of
 * the 144 labelled strokes; four hops of memory puts one on 143. On the five
 * 120bpm fixtures it moved coverage from 65 of 78 labels to 72 while LOWERING
 * the off-label firing rate, so the memory was buying nothing that the band
 * rule below does not buy more cheaply.
 *
 * Three hops is ~32ms at the engine's hop, and is a local optimum in both
 * directions on the derivation fixtures. `FluxTransientDetector` converts.
 */
const REFERENCE_FRAMES = 3;

/**
 * Edges of the arrival bands, Hz. The last edge is open — it is clamped to
 * Nyquist (or to `bandHiHz`) at construction.
 *
 * Roughly octave-spaced across the guitar's range and the pick noise above it.
 * The point is not the exact edges but that a band is judged against ITS OWN
 * magnitude: a threshold set as a fraction of the whole frame's magnitude is a
 * bar the loudest thing sounding sets, so a quiet upstroke over a ringing low
 * string has to out-shout the note it is interrupting. Per band, the ringing
 * note is loud only where it lives, and the pick's broadband arrival is
 * visible everywhere else.
 */
const ARRIVAL_BAND_EDGES_HZ = [0, 200, 500, 1200, 3000, 8000] as const;

/**
 * How many bands must show new energy at once before the hop is an onset.
 *
 * This is the half of the design that keeps precision. A pick is an impulse:
 * it arrives everywhere at once. The two things that fire a single band are
 * the low-frequency beating described under `REFERENCE_FRAMES` and a partial
 * wobbling as a note decays, and neither has any reason to fire a second band
 * in the same hop. Swept on the five 120bpm fixtures against `floorFactor`,
 * the reference length and `BAND_SHARE_FLOOR`: two is a local maximum of label
 * coverage in all four directions.
 */
const MIN_ARRIVAL_BANDS = 2;

/**
 * A band holding less than this share of the frame's magnitude does not get a
 * vote. Without it, a band that is empty on this signal path — everything above
 * 8kHz on a direct input — votes on its own noise, because a floor expressed as
 * a fraction of nothing is nothing.
 */
const BAND_SHARE_FLOOR = 0.005;

/**
 * Bins a band needs before it is allowed to vote; a narrower one is merged
 * into the band above it.
 *
 * At `fftSize` 1024 and 44.1kHz a bin is 43Hz, so the lowest edge pair above
 * spans four and a half bins. Rectified flux over four bins is not a
 * measurement, it is a coin toss: half of a Rayleigh-distributed bin exceeding
 * a three-hop maximum is an everyday event, and with only four of them nothing
 * averages out. Measured on a stationary white-noise floor, the four-bin band
 * votes often enough to carry an onset with any one other band three or four
 * times a second; merged into its neighbour, the same signal fires once, at
 * the moment the noise begins, which is the only true answer.
 */
const BAND_RISE = 1.05;

const BAND_MIN_BINS = 8;

/**
 * Highest frequency allowed to vote, Hz. Energy above it still counts toward
 * the reported flux; it just does not get a say in whether this hop is an
 * attack.
 *
 * The band-limited witness's own sweep found the same edge from the other
 * direction: raising it past 6kHz never bought a single label and only cost
 * off-label firing. What lives up there is signal-path character rather than
 * playing — a room-mic take in this corpus carries 28% of its magnitude above
 * 12kHz where every direct input carries 0.2% — and on a bright synthetic it
 * is where aliasing lives, so a vibrato sweeping its upper partials across a
 * few dozen bins reads as an arrival there and nowhere else.
 */
const ARRIVAL_TOP_HZ = 24000;

/**
 * Threshold floor as a fraction of a band's own magnitude: "did more than this
 * much of what is sounding here arrive just now".
 *
 * Derived on the five 120bpm fixtures by sweeping it against the reference
 * length and reading label coverage against the fraction of above-gate hops
 * that fire off-label — the method the attack band was chosen by. The detector
 * this replaced put a transient within 60ms of 50 of the 78 labels and fired
 * off-label on 2.75% of above-gate hops. This point reaches 70 at 1.81%. It is
 * the highest coverage available at or under the old off-label rate, and among
 * the settings that reach 70 (0.16 through 0.20 at three hops) it is the one
 * that fires least: 0.16 covers 71 but at 3.10%, which is worse than what it
 * replaced on the axis that costs false Notes.
 */
const ARRIVAL_FLOOR_FACTOR = 0.22;

/*
 * Which term of the threshold actually decides an onset, measured.
 *
 * Instrumented over every labelled attack in the five 120bpm fixtures, the
 * relative floor is the binding term at 41 of clean-lead's 43 labels and at
 * every label of the other four: `sensitivity * median` runs 0.000-0.020 where
 * the relative floor runs 0.006-0.130, and forcing the sensitivity as high as 4
 * does not change a single decision on the fixtures or on a synthetic steady
 * low E. The adaptive median is not a gate on this material, it is a floor
 * under a floor — which is why the decision now reads band by band, and why
 * `threshold` survives as a REPORTED figure rather than the deciding one:
 * `FluxTransientDetector` divides the flux by it to get a level-independent
 * "sharper than this signal usually is", and the tracker's re-strum tests are
 * derived against that ratio.
 */

/**
 * Absolute lower bound, in the same normalised units as `flux`: magnitudes are
 * scaled so a sinusoid of amplitude A contributes about A across its main lobe.
 * This is what stops the first speck of dither after a stretch of digital
 * silence — where the adaptive median and the relative floor are both zero —
 * from reading as an onset.
 */
const ABSOLUTE_FLUX_FLOOR = 1e-3;

/**
 * Per-hop decay of the REPORTED flux's reference spectrum, and the threshold
 * floor that goes with it.
 *
 * Two references, because `flux` answers two different questions and the right
 * memory for each is different. Deciding that a hop is an onset asks "did
 * energy arrive here just now", and any memory longer than the beating it
 * exists to suppress makes a ringing note set the bar its own re-pick has to
 * clear — see `REFERENCE_FRAMES`. Reporting how sharp the transient was asks
 * "how much of this frame is new since the note began", and there a long
 * memory is exactly right: it is what makes an ordinary sustaining note read
 * as flat, which is what `FluxTransientDetector.sharpness` and the tracker's
 * re-strum tests are built on.
 *
 * Measured: with the short reference reported instead, the sustain of a
 * compressed chord on `cowboy-chords-amped` reads at sharpness 1.5-3.7 and
 * flux ratio 0.6-1.2 while its real strums read 1.9-5.3 and 0.8-1.7 — the two
 * populations overlap and no threshold separates them. Against the decaying
 * hold the same recording separates them as it always did. The decision moved;
 * the measurement did not.
 */
const REPORTED_REFERENCE_DECAY = 0.95;
const HELD_CORROBORATION = 0.45;

/**
 * The decaying reference leaks `1 - REPORTED_REFERENCE_DECAY` of the frame's
 * magnitude back into the reported flux every hop even when nothing is
 * happening, so the reported threshold's floor is that leak times a safety
 * factor. Expressing it as a fraction of the current frame's magnitude is what
 * makes the reported ratio level-independent.
 */
const REPORTED_FLOOR_FACTOR = 2 * (1 - REPORTED_REFERENCE_DECAY);

export class OnsetDetector {
  /** Number of samples `process()` expects. Equals `fftSize`. */
  readonly windowSize: number;

  readonly sampleRate: number;
  readonly minIntervalMs: number;
  readonly medianWindow: number;
  readonly sensitivity: number;

  private readonly fft: RealFFT;
  /** Periodic Hann, applied before every transform. */
  private readonly hann: Float32Array;
  /** Scratch for the windowed frame. */
  private readonly windowed: Float32Array;
  /** Magnitude spectrum of this hop. */
  private readonly magnitude: Float32Array;
  /**
   * The last `referenceFrames` magnitude spectra, oldest slot arbitrary — a
   * flat ring of `referenceFrames * bins`. The reference for a bin is the
   * maximum over the ring, which is why the order does not matter.
   */
  private readonly history: Float32Array;
  private readonly referenceFrames: number;
  private historyIndexFrames = 0;
  private historyFilled = 0;
  /** Decaying per-bin peak hold; the reference the REPORTED flux is measured against. */
  private readonly reportedReference: Float32Array;
  /** Amplitude-correcting scale for the Hann-windowed magnitudes. */
  private readonly magnitudeScale: number;
  /** Threshold floor as a fraction of a band's own magnitude. */
  private readonly relativeFloor: number;
  /** First bin summed into the flux, inclusive. */
  private readonly binFrom: number;
  /** Last bin summed into the flux, exclusive. */
  private readonly binTo: number;
  /** Arrival band edges as bin indices; `bandEdges.length - 1` bands. */
  private readonly bandEdges: Int32Array;
  private readonly minArrivalBands: number;

  /** Ring buffer of the last `medianWindow` flux values. */
  private readonly fluxHistory: Float64Array;
  /** Scratch the median sorts into, so `process()` never allocates. */
  private readonly medianScratch: Float64Array;
  private historyCount = 0;
  private historyIndex = 0;

  private lastOnsetMs: number | null = null;

  constructor(options: OnsetOptions) {
    const { sampleRate, fftSize, minIntervalMs, medianWindow, sensitivity } = options;

    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error(`OnsetDetector: sampleRate must be > 0, got ${sampleRate}`);
    }
    if (!Number.isInteger(medianWindow) || medianWindow < 1) {
      throw new Error(`OnsetDetector: medianWindow must be an integer >= 1, got ${medianWindow}`);
    }
    const referenceFrames = options.referenceFrames ?? REFERENCE_FRAMES;
    if (!Number.isInteger(referenceFrames) || referenceFrames < 1) {
      throw new Error(
        `OnsetDetector: referenceFrames must be an integer >= 1, got ${referenceFrames}`
      );
    }

    this.windowSize = fftSize;
    this.sampleRate = sampleRate;
    this.minIntervalMs = minIntervalMs;
    this.medianWindow = medianWindow;
    this.sensitivity = sensitivity;
    this.referenceFrames = referenceFrames;

    // Throws for a non-power-of-two or undersized fftSize.
    this.fft = new RealFFT(fftSize);
    this.hann = hannWindow(fftSize);
    this.windowed = new Float32Array(fftSize);
    this.magnitude = new Float32Array(this.fft.bins);
    this.history = new Float32Array(this.fft.bins * referenceFrames);
    this.reportedReference = new Float32Array(this.fft.bins);

    // A sinusoid of amplitude A peaks at A*sum(w)/2 in the raw transform.
    let windowSum = 0;
    for (let i = 0; i < fftSize; i++) windowSum += this.hann[i]!;
    this.magnitudeScale = windowSum > 0 ? 2 / windowSum : 1;

    this.relativeFloor = options.floorFactor ?? ARRIVAL_FLOOR_FACTOR;

    const binHz = sampleRate / fftSize;
    const lo = options.bandLoHz ?? 0;
    const hi = options.bandHiHz ?? sampleRate / 2;
    if (hi <= lo) throw new Error(`OnsetDetector: bandHiHz must exceed bandLoHz`);
    this.binFrom = Math.max(0, Math.min(this.fft.bins - 1, Math.floor(lo / binHz)));
    this.binTo = Math.max(this.binFrom + 1, Math.min(this.fft.bins, Math.ceil(hi / binHz)));

    // Arrival bands are the fixed edges clipped into whatever range this
    // detector was given, so a band-limited instance subdivides its own band.
    const votingTo = Math.min(this.binTo, Math.max(this.binFrom + 1, Math.round(ARRIVAL_TOP_HZ / binHz)));
    const edges: number[] = [this.binFrom];
    for (const hz of ARRIVAL_BAND_EDGES_HZ) {
      const bin = Math.round(hz / binHz);
      if (bin - (edges[edges.length - 1] as number) >= BAND_MIN_BINS && bin < votingTo) {
        edges.push(bin);
      }
    }
    if (edges.length > 1 && votingTo - (edges[edges.length - 1] as number) < BAND_MIN_BINS) {
      edges.pop();
    }
    edges.push(votingTo);
    this.bandEdges = Int32Array.from(edges);

    const requested = options.minArrivalBands ?? MIN_ARRIVAL_BANDS;
    // A range too narrow to hold that many bands cannot vote; it falls back to
    // the single broadband comparison rather than never firing.
    this.minArrivalBands = this.bandEdges.length - 1 >= requested ? requested : 0;

    this.bandHistory = new Float64Array(referenceFrames * this.bandFlux.length);

    this.fluxHistory = new Float64Array(medianWindow);
    this.medianScratch = new Float64Array(medianWindow);
  }

  /**
   * Call once per analysis hop with the most recent `windowSize` samples.
   * `timestampMs` gates the minimum inter-onset interval.
   *
   * `audible` is the caller's amplitude gate. A caller that discards onsets
   * below its gate MUST say so here rather than filtering afterwards: the
   * minimum-interval lockout is armed by whatever fires, so an onset the
   * caller was never going to act on otherwise steals the dead time from the
   * attack that follows it. Measured on the five 120bpm fixtures, arming the
   * lockout from below-gate hops costs fifteen of the seventy-eight labels —
   * a decaying note ripples across the gate, fires, and swallows the pick
   * landing 70ms later. The reference and the median advance either way, so
   * the detector keeps tracking the signal through the quiet.
   */
  process(window: Float32Array, timestampMs: number, audible = true): OnsetResult {
    if (window.length !== this.windowSize) {
      throw new Error(
        `OnsetDetector.process: expected ${this.windowSize} samples, got ${window.length}`
      );
    }

    const { hann, windowed, magnitude, history, magnitudeScale, bandEdges } = this;
    const size = this.windowSize;
    const bins = magnitude.length;

    for (let i = 0; i < size; i++) {
      windowed[i] = window[i]! * hann[i]!;
    }
    this.fft.magnitudes(windowed, magnitude);
    for (let k = 0; k < bins; k++) {
      magnitude[k] = magnitude[k]! * magnitudeScale;
    }

    // Positive half-wave rectified difference against the reference spectrum,
    // accumulated per arrival band. Rectification is the whole point: only
    // energy *appearing* is an attack, energy decaying is not — which is why
    // this fires on a re-picked note at the same pitch, where the RMS envelope
    // barely moves.
    let flux = 0;
    let totalMagnitude = 0;
    let heldFlux = 0;
    const bandCount = bandEdges.length - 1;
    // Two passes over the bands: the share test needs the frame's total, which
    // is only known once every band has been summed.
    for (let b = 0; b < bandCount; b++) {
      let bandFlux = 0;
      let bandMagnitude = 0;
      for (let k = bandEdges[b]!; k < bandEdges[b + 1]!; k++) {
        const scaled = magnitude[k]!;
        bandMagnitude += scaled;
        const held = scaled - this.reportedReference[k]!;
        if (held > 0) heldFlux += held;
        let reference = 0;
        for (let f = 0; f < this.historyFilled; f++) {
          const past = history[f * bins + k]!;
          if (past > reference) reference = past;
        }
        const delta = scaled - reference;
        if (delta > 0) bandFlux += delta;
      }
      this.bandFlux[b] = bandFlux;
      this.bandMagnitude[b] = bandMagnitude;
      flux += bandFlux;
      totalMagnitude += bandMagnitude;
    }

    // Bins above the voting range still count toward the reported flux, which
    // is what `FluxTransientDetector` normalises into sharpness.
    for (let k = bandEdges[bandCount]!; k < this.binTo; k++) {
      const scaled = magnitude[k]!;
      totalMagnitude += scaled;
      const held = scaled - this.reportedReference[k]!;
      if (held > 0) heldFlux += held;
      let reference = 0;
      for (let f = 0; f < this.historyFilled; f++) {
        const past = history[f * bins + k]!;
        if (past > reference) reference = past;
      }
      const delta = scaled - reference;
      if (delta > 0) flux += delta;
    }

    const bandSlots = this.bandFlux.length;
    for (let b = 0; b < bandCount; b++) {
      let peak = 0;
      for (let f = 0; f < this.historyFilled; f++) {
        const past = this.bandHistory[f * bandSlots + b]!;
        if (past > peak) peak = past;
      }
      this.bandMagnitudeReference[b] = peak;
    }

    // Reported, not decisive: `FluxTransientDetector` divides the flux by this
    // to get "how far above what this signal usually does", and the tracker's
    // re-strum escape is derived against that ratio.
    const heldThreshold = Math.max(
      this.sensitivity * this.medianFlux(),
      REPORTED_FLOOR_FACTOR * totalMagnitude,
      ABSOLUTE_FLUX_FLOOR
    );
    const threshold = Math.max(this.relativeFloor * totalMagnitude, ABSOLUTE_FLUX_FLOOR);

    let isOnset: boolean;
    if (this.minArrivalBands === 0) {
      // A range too narrow to subdivide falls back to one comparison, against
      // the same short reference and the same relative floor the bands use —
      // never against `threshold`, which is measured on the reported scale.
      isOnset = flux > threshold;
    } else {
      let arrived = 0;
      for (let b = 0; b < bandCount; b++) {
        const bandMagnitude = this.bandMagnitude[b]!;
        if (bandMagnitude < BAND_SHARE_FLOOR * totalMagnitude) continue;
        if (this.bandFlux[b]! <= this.relativeFloor * bandMagnitude) continue;
        // ...and the band has to be LOUDER than it has recently been. Bins
        // gaining while their neighbours lose is energy moving, not arriving:
        // a vibrato sweeps every partial across its neighbouring bins and
        // shows rectified flux in every band at once, and broadband noise
        // fluctuates above a four-hop maximum for the same reason. Neither
        // makes its band louder. A pick does — including a quiet one over a
        // ringing note, in the bands where the ringing note does not live.
        if (bandMagnitude <= BAND_RISE * this.bandMagnitudeReference[b]!) continue;
        arrived++;
      }
      isOnset =
        arrived >= this.minArrivalBands &&
        flux > ABSOLUTE_FLUX_FLOOR &&
        heldFlux >= HELD_CORROBORATION * heldThreshold;
    }

    if (!audible) isOnset = false;
    if (isOnset && this.lastOnsetMs !== null) {
      // Timestamps come from the caller; `src/core/` never reads a clock.
      if (timestampMs - this.lastOnsetMs < this.minIntervalMs) isOnset = false;
    }
    if (isOnset) this.lastOnsetMs = timestampMs;

    // History and the reference advance regardless of suppression, so the
    // adaptive threshold keeps tracking the signal during the dead time.
    this.pushFlux(heldFlux);
    const slot = this.historyIndexFrames * bins;
    for (let k = 0; k < bins; k++) history[slot + k] = magnitude[k]!;
    for (let k = this.binFrom; k < this.binTo; k++) {
      const decayed = this.reportedReference[k]! * REPORTED_REFERENCE_DECAY;
      const current = magnitude[k]!;
      this.reportedReference[k] = current > decayed ? current : decayed;
    }
    const bandSlot = this.historyIndexFrames * bandSlots;
    for (let b = 0; b < bandCount; b++) this.bandHistory[bandSlot + b] = this.bandMagnitude[b]!;
    this.historyIndexFrames = (this.historyIndexFrames + 1) % this.referenceFrames;
    if (this.historyFilled < this.referenceFrames) this.historyFilled++;

    return { isOnset, flux, threshold, heldFlux, heldThreshold };
  }

  reset(): void {
    this.history.fill(0);
    this.bandHistory.fill(0);
    this.reportedReference.fill(0);
    this.historyIndexFrames = 0;
    this.historyFilled = 0;
    this.fluxHistory.fill(0);
    this.historyCount = 0;
    this.historyIndex = 0;
    this.lastOnsetMs = null;
  }

  /** Per-band scratch, sized at construction so `process()` never allocates. */
  private readonly bandFlux = new Float64Array(ARRIVAL_BAND_EDGES_HZ.length + 2);
  private readonly bandMagnitude = new Float64Array(ARRIVAL_BAND_EDGES_HZ.length + 2);
  /** Maximum each band reached over the reference span, excluding this hop. */
  private readonly bandMagnitudeReference = new Float64Array(ARRIVAL_BAND_EDGES_HZ.length + 2);
  /** `referenceFrames` rows of per-band magnitude, same ring as `history`. */
  private readonly bandHistory: Float64Array;

  private pushFlux(flux: number): void {
    this.fluxHistory[this.historyIndex] = flux;
    this.historyIndex = (this.historyIndex + 1) % this.medianWindow;
    if (this.historyCount < this.medianWindow) this.historyCount++;
  }

  /**
   * Median of the flux values seen before this hop. Insertion sort on a
   * preallocated scratch buffer — `medianWindow` is ~17, and this keeps
   * `process()` allocation-free (a `subarray().sort()` would not).
   */
  private medianFlux(): number {
    const n = this.historyCount;
    if (n === 0) return 0;

    const scratch = this.medianScratch;
    const history = this.fluxHistory;
    for (let i = 0; i < n; i++) scratch[i] = history[i]!;

    for (let i = 1; i < n; i++) {
      const value = scratch[i]!;
      let j = i - 1;
      while (j >= 0 && scratch[j]! > value) {
        scratch[j + 1] = scratch[j]!;
        j--;
      }
      scratch[j + 1] = value;
    }

    const mid = n >> 1;
    return (n & 1) === 1 ? scratch[mid]! : (scratch[mid - 1]! + scratch[mid]!) / 2;
  }
}
