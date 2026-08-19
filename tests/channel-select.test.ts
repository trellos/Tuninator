/**
 * Input-channel selection.
 *
 * The unit half drives `ChannelSelector` directly with per-hop RMS, exactly the
 * way the worklet does. The last block is the reason the whole thing exists: a
 * mic and a DI of one guitar, summed, and what that does to pitch detection.
 */

import { describe, expect, it } from "vitest";
import {
  ChannelSelector,
  DEFAULT_MARGIN_DB,
  DEFAULT_SUSTAIN_WINDOWS,
  DEFAULT_WINDOW_MS,
  resolveChannel,
} from "../src/engine/kernels/channel-select.js";
import { RecognitionEngine } from "../src/engine/engine.js";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/config.js";

/** The real hop: 12ms requested, snapped to 576 samples at 48k. */
const HOP_MS = 12;
const SILENCE = 0.008;

function selector(channelCount = 2, overrides = {}): ChannelSelector {
  return new ChannelSelector({ channelCount, silenceRms: SILENCE, ...overrides });
}

/** Feeds a constant per-channel level for `ms`, one hop at a time. */
function feed(sel: ChannelSelector, levels: number[], ms: number): number | null {
  let out: number | null = sel.selected();
  const hops = Math.round(ms / HOP_MS);
  for (let i = 0; i < hops; i++) out = sel.observe(levels, HOP_MS);
  return out;
}

/** Deterministic LCG, so "noisy" tests fail the same way every run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe("ChannelSelector — mono", () => {
  it("is a no-op: one channel is answered immediately and never re-decided", () => {
    const sel = selector(1);
    expect(sel.selected()).toBe(0);
    // Even loud, even for a long time: there is nothing to decide, so no
    // window is ever evaluated and no work is done.
    expect(feed(sel, [0.4], 5000)).toBe(0);
    expect(sel.windowsEvaluated()).toBe(0);
  });

  it("resolves to channel 0 for every strategy when the input is mono", () => {
    const sel = selector(1);
    expect(resolveChannel("auto", 1, sel)).toBe(0);
    expect(resolveChannel("sum", 1, sel)).toBe(0);
    expect(resolveChannel(1, 1, sel)).toBe(0);
  });
});

describe("ChannelSelector — silence", () => {
  it("does not latch a decision from the noise floor", () => {
    const sel = selector(2);
    // Two idle preamps. Channel 1 hisses more, which is a fact about the
    // hardware and not about where the guitar is plugged in.
    feed(sel, [0.0004, 0.0009], 4000);
    expect(sel.selected()).toBeNull();
    expect(sel.windowsEvaluated()).toBe(0);
  });

  it("latches only once signal crosses the gate", () => {
    const sel = selector(2);
    feed(sel, [0.0004, 0.0009], 2000);
    expect(sel.selected()).toBeNull();

    feed(sel, [0.001, 0.12], DEFAULT_WINDOW_MS);
    expect(sel.selected()).toBe(1);
  });

  it("keeps a latched decision through silence", () => {
    const sel = selector(2);
    feed(sel, [0.001, 0.12], DEFAULT_WINDOW_MS);
    expect(sel.selected()).toBe(1);

    // Player stops for five seconds. Nothing about the rig changed.
    feed(sel, [0.0004, 0.0002], 5000);
    expect(sel.selected()).toBe(1);
  });
});

describe("ChannelSelector — choosing", () => {
  it("picks the loudest channel once a window of real signal has passed", () => {
    const sel = selector(2);
    // Guitar in input 2, input 1 unplugged: the case that motivated all of this.
    expect(feed(sel, [0.0006, 0.15], DEFAULT_WINDOW_MS)).toBe(1);
    expect(sel.windowsEvaluated()).toBe(1);
  });

  it("does not decide from a single hop", () => {
    const sel = selector(2);
    // A transient on the wrong channel — a chair creak into the room mic — must
    // not be able to steer the selection on its own.
    sel.observe([0.001, 0.3], HOP_MS);
    expect(sel.selected()).toBeNull();
  });

  it("integrates energy over the window rather than taking a per-hop argmax", () => {
    const sel = selector(2);
    // Channel 0 carries a sustained note; channel 1 gets one loud spike and is
    // otherwise dead. Per-hop argmax would hand a hop to channel 1; total
    // energy over the window belongs to channel 0.
    const hops = Math.round(DEFAULT_WINDOW_MS / HOP_MS);
    for (let i = 0; i < hops; i++) {
      sel.observe(i === 3 ? [0.05, 0.2] : [0.05, 0.0002], HOP_MS);
    }
    expect(sel.selected()).toBe(0);
  });

  it("ties go to the lower index, deterministically", () => {
    const sel = selector(2);
    expect(feed(sel, [0.1, 0.1], DEFAULT_WINDOW_MS)).toBe(0);
  });

  it("handles more than two channels", () => {
    const sel = selector(4);
    expect(feed(sel, [0.01, 0.02, 0.2, 0.03], DEFAULT_WINDOW_MS)).toBe(2);
  });
});

describe("ChannelSelector — hysteresis", () => {
  it("does not oscillate between two near-equal channels", () => {
    const sel = selector(2);
    const random = lcg(20240607);

    feed(sel, [0.06, 0.06], DEFAULT_WINDOW_MS);
    const latched = sel.selected();
    expect(latched).toBe(0);

    // A genuine stereo pair: the same instrument on both channels, each hop
    // wandering +/-40% around the same level, with the lead changing constantly.
    // Switching mid-note splices two uncorrelated waveforms into the ring
    // buffer, so this must never move.
    for (let i = 0; i < 4000; i++) {
      const a = 0.06 * (0.6 + 0.8 * random());
      const b = 0.06 * (0.6 + 0.8 * random());
      sel.observe([a, b], HOP_MS);
      expect(sel.selected()).toBe(latched);
    }
  });

  it("ignores a challenger that leads by less than the margin", () => {
    const sel = selector(2);
    feed(sel, [0.1, 0.05], DEFAULT_WINDOW_MS);
    expect(sel.selected()).toBe(0);

    // 4dB up on the incumbent, held for ten windows. Under the 6dB bar, so it
    // is not a switch and — importantly — never accumulates a streak either.
    const under = 0.1 * Math.pow(10, 4 / 20);
    feed(sel, [0.1, under], DEFAULT_WINDOW_MS * 10);
    expect(sel.selected()).toBe(0);
  });

  it("ignores a challenger that clears the margin only briefly", () => {
    const sel = selector(2);
    feed(sel, [0.1, 0.01], DEFAULT_WINDOW_MS);
    expect(sel.selected()).toBe(0);

    // Two windows over the bar, then back under: one window short of a switch.
    feed(sel, [0.02, 0.4], DEFAULT_WINDOW_MS * (DEFAULT_SUSTAIN_WINDOWS - 1));
    expect(sel.selected()).toBe(0);
    feed(sel, [0.2, 0.02], DEFAULT_WINDOW_MS * 4);
    expect(sel.selected()).toBe(0);
  });

  it("honours a sustained switch, and not before the sustain is met", () => {
    const sel = selector(2);
    feed(sel, [0.15, 0.001], DEFAULT_WINDOW_MS);
    expect(sel.selected()).toBe(0);

    // The player moves the cable to input 2. Channel 0 drops to noise, channel
    // 1 comes alive, and it stays that way.
    for (let w = 0; w < DEFAULT_SUSTAIN_WINDOWS - 1; w++) {
      feed(sel, [0.0007, 0.15], DEFAULT_WINDOW_MS);
      expect(sel.selected()).toBe(0);
    }
    feed(sel, [0.0007, 0.15], DEFAULT_WINDOW_MS);
    expect(sel.selected()).toBe(1);
  });

  it("requires the margin to be met by the same challenger each window", () => {
    const sel = selector(3);
    feed(sel, [0.15, 0.001, 0.001], DEFAULT_WINDOW_MS);
    expect(sel.selected()).toBe(0);

    // Channels 1 and 2 take turns beating the incumbent. Neither ever gets a
    // streak of its own, so the selection holds.
    for (let w = 0; w < 12; w++) {
      feed(sel, w % 2 === 0 ? [0.002, 0.3, 0.002] : [0.002, 0.002, 0.3], DEFAULT_WINDOW_MS);
      expect(sel.selected()).toBe(0);
    }
  });

  it("the margin default is the documented 6dB", () => {
    expect(DEFAULT_MARGIN_DB).toBe(6);
    expect(selector(2).marginRatio).toBeCloseTo(Math.pow(10, 6 / 20), 6);
  });
});

describe("ChannelSelector — housekeeping", () => {
  it("reset() forgets the latched selection", () => {
    const sel = selector(2);
    feed(sel, [0.001, 0.2], DEFAULT_WINDOW_MS);
    expect(sel.selected()).toBe(1);
    sel.reset();
    expect(sel.selected()).toBeNull();
    expect(sel.windowsEvaluated()).toBe(0);
  });

  it("tolerates an rms array shorter than the channel count", () => {
    const sel = selector(2);
    expect(() => feed(sel, [0.2], DEFAULT_WINDOW_MS)).not.toThrow();
    expect(sel.selected()).toBe(0);
  });

  it("ignores a non-positive hop", () => {
    const sel = selector(2);
    sel.observe([0.001, 0.5], 0);
    expect(sel.selected()).toBeNull();
  });
});

describe("resolveChannel", () => {
  it("sums when asked to sum", () => {
    expect(resolveChannel("sum", 2, selector(2))).toBeNull();
  });

  it("honours an explicit channel index", () => {
    expect(resolveChannel(1, 2, null)).toBe(1);
    expect(resolveChannel(0, 2, null)).toBe(0);
  });

  it("falls back to summing for an index the device does not have", () => {
    // A host that asks for input 3 on a 2-in interface has made a mistake.
    // Summing keeps every channel audible, so the mistake is visible as a
    // wrong-but-working signal rather than as silence.
    expect(resolveChannel(5, 2, null)).toBeNull();
    expect(resolveChannel(-1, 2, null)).toBeNull();
  });

  it("sums while auto has not yet decided, and follows it once it has", () => {
    const sel = selector(2);
    expect(resolveChannel("auto", 2, sel)).toBeNull();
    feed(sel, [0.001, 0.2], DEFAULT_WINDOW_MS);
    expect(resolveChannel("auto", 2, sel)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Why selection beats summing: comb filtering                                 */
/* -------------------------------------------------------------------------- */

const SAMPLE_RATE = 48000;
const RENDER_QUANTUM = 128;

/** Sawtooth, delayed by `delaySamples` — a harmonic stack, like a string. */
function sawtooth(
  frequencyHz: number,
  samples: number,
  amplitude: number,
  delaySamples = 0
): Float32Array {
  const out = new Float32Array(samples);
  const period = SAMPLE_RATE / frequencyHz;
  for (let i = 0; i < samples; i++) {
    const t = i - delaySamples;
    out[i] = t < 0 ? 0 : amplitude * (2 * ((t % period) / period) - 1);
  }
  return out;
}

/** Median detected frequency across a whole buffer, or NaN if never voiced. */
function detect(signal: Float32Array): number {
  const engine = new RecognitionEngine(SAMPLE_RATE, {
    ...DEFAULT_ENGINE_CONFIG,
    diagnostics: { pitchFrames: true, contour: false },
  });
  const voiced: number[] = [];
  const blocks = Math.floor(signal.length / RENDER_QUANTUM);
  for (let b = 0; b < blocks; b++) {
    const result = engine.processChunk(
      signal.subarray(b * RENDER_QUANTUM, (b + 1) * RENDER_QUANTUM),
      b * RENDER_QUANTUM
    );
    for (const frame of result.frames) {
      if (frame.frequencyHz !== null) voiced.push(frame.frequencyHz);
    }
  }
  if (voiced.length === 0) return Number.NaN;
  const sorted = voiced.sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

function cents(detected: number, reference: number): number {
  return 1200 * Math.log2(detected / reference);
}

describe("comb filtering: a mic and a DI of the same guitar", () => {
  // An ordinary rig. Guitar -> DI box -> input 1, and a mic on the cab about a
  // metre away -> input 2. One metre of air is ~3ms, and 3ms is half a period
  // of 166.7Hz, so around E3 the two copies arrive in antiphase: summing them
  // cancels the odd harmonics and leaves a signal whose strongest periodicity
  // is the SECOND harmonic. The detector is handed a clean octave error, and
  // nothing upstream looks broken.
  //
  // This is a worst case, not a typical one: the null sits wherever the mic
  // distance puts it, so other pitches through the same rig sum harmlessly. It
  // only has to be reachable to be disqualifying — a tuner that reports E4 for
  // an E3 is not a tuner.
  const E3 = 164.81;
  const DELAY_SAMPLES = 0.003 * SAMPLE_RATE;
  const SECONDS = SAMPLE_RATE;

  const di = sawtooth(E3, SECONDS, 0.3);
  const mic = sawtooth(E3, SECONDS, 0.24, DELAY_SAMPLES);

  it("each channel on its own is detected correctly", () => {
    expect(Math.abs(cents(detect(di), E3))).toBeLessThan(20);
    expect(Math.abs(cents(detect(mic), E3))).toBeLessThan(20);
  });

  it("summing the two channels produces an octave error", () => {
    const summed = new Float32Array(SECONDS);
    for (let i = 0; i < SECONDS; i++) summed[i] = di[i]! + mic[i]!;
    // Not "slightly worse": a full octave, +1200 cents.
    expect(cents(detect(summed), E3)).toBeGreaterThan(1000);
  });

  it("selection picks a channel and gets it right", () => {
    // The selector sees the two channels' RMS. The DI is the hotter of the two
    // by ~1.9dB — well under the 6dB switching margin, which is exactly the
    // point: the FIRST choice has no margin requirement, only later switches
    // do, so a near-tie still yields a decision instead of deadlocking.
    const sel = selector(2);
    const diRms = rmsOf(di);
    const micRms = rmsOf(mic);
    expect(20 * Math.log10(diRms / micRms)).toBeLessThan(DEFAULT_MARGIN_DB);

    const chosen = feed(sel, [diRms, micRms], DEFAULT_WINDOW_MS);
    expect(chosen).toBe(0);

    const block = chosen === 0 ? di : mic;
    expect(Math.abs(cents(detect(block), E3))).toBeLessThan(20);
  });
});

function rmsOf(signal: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i]! * signal[i]!;
  return Math.sqrt(sum / signal.length);
}
