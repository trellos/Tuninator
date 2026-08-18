/**
 * Scrolling note timeline.
 *
 * Geometry, exactly as specified:
 *   x(t) = width * (1 - (now - t) / windowMs)
 * so t == now lands on the RIGHT edge and older material slides LEFT. A bar's
 * length is the event's duration; an event that has not ended yet is drawn out
 * to the right edge and grows as time passes.
 *
 * The visible window is 16 beats of history. At 90bpm that is
 *   16 * (60000 / 90) = 16 * 666.667ms = 10666.67ms
 * and the beat gridlines come from the metronome's own grid, so what you see
 * lines up with what you hear.
 *
 * Everything in here works in `performance.now()` milliseconds ("wall" time).
 * Library timestamps are converted on the way in via `toWall`, because
 * `PitchFrame.timestamp` is only documented as "monotonic", never as sharing an
 * epoch with `performance.now()`.
 */

import type { MusicEvent, MusicEventKind, MusicEventState } from "tuninator";

import type { BeatGrid } from "./metronome.js";

/** Beats of history on screen. */
export const WINDOW_BEATS = 16;

const BAR_HEIGHT = 11;
const CHORD_TONE_HEIGHT = 7;
const MIN_SEMITONE_SPAN = 20;
const DEFAULT_LOW_MIDI = 40; // E2
const DEFAULT_HIGH_MIDI = 76; // E5
const TRACE_LIMIT = 512;
const PAD_TOP = 18;
const PAD_BOTTOM = 22;

type Trace = { t: number; pitch: number };

type TrackedEvent = {
  id: string;
  kind: MusicEventKind;
  state: MusicEventState;
  label: string;
  /** Wall-clock ms. */
  startMs: number;
  /** Wall-clock ms, or null while the event is still sounding. */
  endMs: number | null;
  confidence: number;
  /** Fractional MIDI for every pitch in the event, primary first. */
  pitches: number[];
  primary: number | null;
  bendCents: number;
  /** Primary-pitch history, so a bend draws as a curve rather than a step. */
  trace: Trace[];
};

export type TimelineOptions = {
  /** Converts a library timestamp into `performance.now()` space. */
  toWall: (libMs: number) => number;
};

/* -------------------------------------------------------------------------- */
/* Pitch extraction                                                            */
/* -------------------------------------------------------------------------- */

const PITCH_CLASS_SEMITONES: Record<string, number> = {
  C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5,
  "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11,
};

function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/** "A4", "F#3" -> fractional MIDI. Returns null for chord labels like "Am7". */
function midiFromScientificName(name: string): number | null {
  const match = /^([A-G])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!match) return null;
  const [, letter, accidental, octave] = match;
  if (letter === undefined || octave === undefined) return null;
  let semitone = PITCH_CLASS_SEMITONES[letter];
  if (semitone === undefined) return null;
  if (accidental === "#") semitone += 1;
  if (accidental === "b") semitone -= 1;
  return (Number(octave) + 1) * 12 + semitone;
}

/**
 * Every field of `EventPitch` except `role` and `confidence` is optional in
 * `types.ts`, so a consumer cannot rely on any single one being present. Try
 * them in order of precision rather than assuming.
 */
function pitchOfEventPitch(pitch: {
  midi?: number;
  frequencyHz?: number;
  name?: string;
  cents?: number;
}): number | null {
  if (typeof pitch.midi === "number" && Number.isFinite(pitch.midi)) {
    return pitch.midi + (pitch.cents ?? 0) / 100;
  }
  if (typeof pitch.frequencyHz === "number" && pitch.frequencyHz > 0) {
    return hzToMidi(pitch.frequencyHz);
  }
  if (typeof pitch.name === "string") {
    const fromName = midiFromScientificName(pitch.name);
    if (fromName !== null) return fromName + (pitch.cents ?? 0) / 100;
  }
  return null;
}

function extractPitches(event: MusicEvent): { pitches: number[]; primary: number | null } {
  const primary = event.primaryPitch ? pitchOfEventPitch(event.primaryPitch) : null;

  const others: number[] = [];
  for (const pitch of event.pitches) {
    const value = pitchOfEventPitch(pitch);
    if (value !== null) others.push(value);
  }

  // Last resort: a single-note label like "A4" still tells us where to draw.
  const fromLabel = midiFromScientificName(event.label.name);

  const resolvedPrimary = primary ?? others[0] ?? fromLabel;
  const pitches = others.length > 0 ? others : resolvedPrimary !== null && resolvedPrimary !== undefined ? [resolvedPrimary] : [];

  return { pitches, primary: resolvedPrimary ?? null };
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

/** Hue by pitch class, so the same note is always the same colour. */
function hueOf(midi: number): number {
  const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
  return (pitchClass * 30 + 190) % 360;
}

function colourFor(midi: number, alpha: number, lift = 0): string {
  const hue = hueOf(midi);
  // Higher notes read brighter, which reinforces the vertical axis.
  const light = Math.min(78, 44 + (midi - DEFAULT_LOW_MIDI) * 0.42 + lift);
  return `hsla(${hue}, 74%, ${light}%, ${alpha})`;
}

/* -------------------------------------------------------------------------- */
/* Timeline                                                                    */
/* -------------------------------------------------------------------------- */

export class Timeline {
  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #toWall: (libMs: number) => number;

  #events = new Map<string, TrackedEvent>();
  #grid: BeatGrid = { originMs: performance.now(), periodMs: 60_000 / 90, beatsPerBar: 4 };

  #cssWidth = 0;
  #cssHeight = 0;
  #dpr = 1;

  #lowMidi = DEFAULT_LOW_MIDI;
  #highMidi = DEFAULT_HIGH_MIDI;

  #rafId: number | null = null;
  #observer: ResizeObserver | null = null;
  #hint = "Press Start to listen.";

  constructor(canvas: HTMLCanvasElement, options: TimelineOptions) {
    this.#canvas = canvas;
    this.#toWall = options.toWall;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Timeline: 2D canvas context is unavailable.");
    this.#ctx = ctx;

    this.#resize();
    if (typeof ResizeObserver !== "undefined") {
      this.#observer = new ResizeObserver(() => this.#resize());
      this.#observer.observe(canvas);
    } else {
      window.addEventListener("resize", () => this.#resize());
    }
  }

  get windowMs(): number {
    return WINDOW_BEATS * this.#grid.periodMs;
  }

  setGrid(grid: BeatGrid): void {
    this.#grid = grid;
  }

  setHint(hint: string): void {
    this.#hint = hint;
  }

  /** Feed every `musicEventStart` / `Update` / `End` through here. */
  track(event: MusicEvent): void {
    const startMs = this.#toWall(event.startedAt);
    const endMs = event.endedAt === null ? null : this.#toWall(event.endedAt);
    const updatedMs = this.#toWall(event.updatedAt);
    const { pitches, primary } = extractPitches(event);

    const existing = this.#events.get(event.id);
    const trace = existing?.trace ?? [];

    if (primary !== null) {
      const last = trace[trace.length - 1];
      if (!last || updatedMs - last.t > 25 || Math.abs(last.pitch - primary) > 0.01) {
        trace.push({ t: updatedMs, pitch: primary });
        if (trace.length > TRACE_LIMIT) trace.splice(0, trace.length - TRACE_LIMIT);
      }
    }

    this.#events.set(event.id, {
      id: event.id,
      kind: event.kind,
      state: event.state,
      label: event.label.name,
      startMs,
      endMs,
      confidence: event.confidence,
      pitches,
      primary,
      bendCents: event.bend.centsFromStart,
      trace,
    });
  }

  clear(): void {
    this.#events.clear();
  }

  start(): void {
    if (this.#rafId !== null) return;
    const frame = (): void => {
      this.draw();
      this.#rafId = requestAnimationFrame(frame);
    };
    this.#rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    if (this.#rafId === null) return;
    cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
  }

  dispose(): void {
    this.stop();
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /* ---- rendering ---- */

  draw(): void {
    const now = performance.now();
    const width = this.#cssWidth;
    const height = this.#cssHeight;
    if (width <= 0 || height <= 0) return;

    this.#prune(now);
    this.#updatePitchRange();

    const ctx = this.#ctx;
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, width, height);

    this.#drawPitchGuides(width, height);
    this.#drawBeatGrid(now, width, height);
    this.#drawEvents(now, width, height);
    this.#drawPlayhead(width, height);

    if (this.#events.size === 0 && this.#hint) {
      ctx.fillStyle = "rgba(201, 209, 217, 0.45)";
      ctx.font = '13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.#hint, width / 2, height / 2);
      ctx.textAlign = "left";
    }
  }

  /** x position for a wall-clock timestamp. */
  #xOf(t: number, now: number, width: number): number {
    return width * (1 - (now - t) / this.windowMs);
  }

  #yOf(midi: number, height: number): number {
    const span = this.#highMidi - this.#lowMidi;
    const usable = height - PAD_TOP - PAD_BOTTOM;
    const ratio = (midi - this.#lowMidi) / span;
    return PAD_TOP + usable * (1 - Math.min(1, Math.max(0, ratio)));
  }

  #prune(now: number): void {
    const cutoff = now - this.windowMs - 2000;
    for (const [id, event] of this.#events) {
      const end = event.endMs ?? now;
      if (end < cutoff) this.#events.delete(id);
    }
  }

  /** Keep every visible note on screen, easing rather than snapping. */
  #updatePitchRange(): void {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const event of this.#events.values()) {
      for (const pitch of event.pitches) {
        if (pitch < lo) lo = pitch;
        if (pitch > hi) hi = pitch;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = DEFAULT_LOW_MIDI;
      hi = DEFAULT_HIGH_MIDI;
    }

    let targetLow = Math.floor(lo) - 3;
    let targetHigh = Math.ceil(hi) + 3;
    const deficit = MIN_SEMITONE_SPAN - (targetHigh - targetLow);
    if (deficit > 0) {
      targetLow -= deficit / 2;
      targetHigh += deficit / 2;
    }

    const ease = 0.08;
    this.#lowMidi += (targetLow - this.#lowMidi) * ease;
    this.#highMidi += (targetHigh - this.#highMidi) * ease;
  }

  #drawPitchGuides(width: number, height: number): void {
    const ctx = this.#ctx;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = "middle";

    const first = Math.ceil(this.#lowMidi / 12) * 12;
    for (let midi = first; midi <= this.#highMidi; midi += 12) {
      const y = this.#yOf(midi, height);
      ctx.strokeStyle = "rgba(139, 148, 158, 0.16)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(width, Math.round(y) + 0.5);
      ctx.stroke();

      ctx.fillStyle = "rgba(139, 148, 158, 0.5)";
      ctx.fillText(`C${Math.round(midi) / 12 - 1}`, 4, y - 7);
    }
  }

  /**
   * Beat lines straight off the metronome's grid, so a note played on the click
   * sits on a gridline.
   */
  #drawBeatGrid(now: number, width: number, height: number): void {
    const ctx = this.#ctx;
    const { originMs, periodMs, beatsPerBar } = this.#grid;
    const oldest = now - this.windowMs;
    const firstBeat = Math.ceil((oldest - originMs) / periodMs);
    const lastBeat = Math.floor((now - originMs) / periodMs);

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = "top";

    for (let beat = firstBeat; beat <= lastBeat; beat += 1) {
      const t = originMs + beat * periodMs;
      const x = Math.round(this.#xOf(t, now, width)) + 0.5;
      if (x < 0 || x > width) continue;

      const isBarLine = ((beat % beatsPerBar) + beatsPerBar) % beatsPerBar === 0;
      ctx.strokeStyle = isBarLine ? "rgba(88, 166, 255, 0.34)" : "rgba(139, 148, 158, 0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, isBarLine ? 0 : PAD_TOP);
      ctx.lineTo(x, height - PAD_BOTTOM + 6);
      ctx.stroke();

      // Bar 1 is the metronome's origin. Beats before it exist (the window is
      // all history at page load) but numbering them 0 and -1 reads as a bug,
      // so those bar lines are drawn without a number.
      if (isBarLine) {
        const barNumber = Math.floor(beat / beatsPerBar) + 1;
        if (barNumber >= 1) {
          ctx.fillStyle = "rgba(88, 166, 255, 0.6)";
          ctx.fillText(String(barNumber), x + 3, height - PAD_BOTTOM + 8);
        }
      }
    }
  }

  #drawEvents(now: number, width: number, height: number): void {
    const ctx = this.#ctx;
    const ordered = [...this.#events.values()].sort((a, b) => a.startMs - b.startMs);

    for (const event of ordered) {
      const endMs = event.endMs ?? now; // still sounding -> runs to the right edge
      const x0 = this.#xOf(event.startMs, now, width);
      const x1 = this.#xOf(endMs, now, width);
      if (x1 < -4 || x0 > width + 4) continue;

      // Dim low-confidence interpretations rather than hiding them.
      const alpha = 0.22 + 0.78 * clamp01(event.confidence);
      const left = Math.max(-2, x0);
      const right = Math.min(width, Math.max(x1, x0 + 2));
      const barWidth = Math.max(2, right - left);

      // Chord tones behind, thinner and dimmer than the primary.
      for (const pitch of event.pitches) {
        if (event.primary !== null && Math.abs(pitch - event.primary) < 0.001) continue;
        const y = this.#yOf(pitch, height);
        ctx.fillStyle = colourFor(pitch, alpha * 0.5);
        roundRect(ctx, left, y - CHORD_TONE_HEIGHT / 2, barWidth, CHORD_TONE_HEIGHT, 2);
        ctx.fill();
      }

      if (event.primary === null) continue;

      const bent = Math.abs(event.bendCents) >= 20 && event.trace.length > 2;
      if (bent) {
        this.#drawBentBar(event, now, width, height, alpha);
      } else {
        const y = this.#yOf(event.primary, height);
        ctx.fillStyle = colourFor(event.primary, alpha, 6);
        roundRect(ctx, left, y - BAR_HEIGHT / 2, barWidth, BAR_HEIGHT, 3);
        ctx.fill();
      }

      // Attack marker: a bright cap at the note's onset.
      if (x0 >= -2 && x0 <= width) {
        const y = this.#yOf(event.trace[0]?.pitch ?? event.primary, height);
        ctx.fillStyle = `rgba(255,255,255,${0.55 * alpha})`;
        ctx.fillRect(Math.max(0, x0), y - BAR_HEIGHT / 2, 2, BAR_HEIGHT);
      }

      this.#drawLabel(event, left, right, height, alpha);
    }
  }

  /** A bend stays one event: draw the primary as a ribbon through its trace. */
  #drawBentBar(
    event: TrackedEvent,
    now: number,
    width: number,
    height: number,
    alpha: number
  ): void {
    const ctx = this.#ctx;
    const points = event.trace.map((sample) => ({
      x: this.#xOf(sample.t, now, width),
      y: this.#yOf(sample.pitch, height),
    }));
    const last = points[points.length - 1];
    if (!last) return;
    // Extend the ribbon to the playhead while the note is still sounding.
    if (event.endMs === null) points.push({ x: width, y: last.y });

    const half = BAR_HEIGHT / 2;
    ctx.beginPath();
    const firstPoint = points[0];
    if (!firstPoint) return;
    ctx.moveTo(firstPoint.x, firstPoint.y - half);
    for (const point of points) ctx.lineTo(point.x, point.y - half);
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const point = points[i];
      if (point) ctx.lineTo(point.x, point.y + half);
    }
    ctx.closePath();
    ctx.fillStyle = colourFor(event.primary ?? 60, alpha, 6);
    ctx.fill();

    // A dashed ghost at the origin pitch makes the excursion legible.
    const originPitch = firstPoint ? event.trace[0]?.pitch : null;
    if (originPitch != null) {
      const y = this.#yOf(originPitch, height);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = `rgba(255,255,255,${0.3 * alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(firstPoint.x, y);
      ctx.lineTo(last.x, y);
      ctx.stroke();
      ctx.restore();
    }
  }

  #drawLabel(
    event: TrackedEvent,
    left: number,
    right: number,
    height: number,
    alpha: number
  ): void {
    const ctx = this.#ctx;
    const available = right - left;
    if (available < 22 || event.primary === null) return;

    const text = event.label;
    ctx.font =
      event.kind === "chord"
        ? '600 11px ui-sans-serif, system-ui, -apple-system, sans-serif'
        : '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const metrics = ctx.measureText(text);
    if (metrics.width + 8 > available) return;

    const y = this.#yOf(event.primary, height);
    ctx.fillStyle = `rgba(13, 17, 23, ${0.55 * alpha})`;
    ctx.fillRect(left + 3, y - BAR_HEIGHT / 2 - 14, metrics.width + 4, 13);
    ctx.fillStyle = `rgba(230, 237, 243, ${Math.min(1, alpha + 0.15)})`;
    ctx.textBaseline = "top";
    ctx.fillText(text, left + 5, y - BAR_HEIGHT / 2 - 13);
  }

  #drawPlayhead(width: number, height: number): void {
    const ctx = this.#ctx;
    const x = width - 0.5;
    ctx.strokeStyle = "rgba(255, 122, 89, 0.85)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();

    const gradient = ctx.createLinearGradient(width - 48, 0, width, 0);
    gradient.addColorStop(0, "rgba(255, 122, 89, 0)");
    gradient.addColorStop(1, "rgba(255, 122, 89, 0.10)");
    ctx.fillStyle = gradient;
    ctx.fillRect(width - 48, 0, 48, height);
  }

  /** Keep the backing store at device resolution so nothing is blurry. */
  #resize(): void {
    const rect = this.#canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, Math.round(rect.width));
    const cssHeight = Math.max(1, Math.round(rect.height));

    if (cssWidth === this.#cssWidth && cssHeight === this.#cssHeight && dpr === this.#dpr) {
      return;
    }

    this.#cssWidth = cssWidth;
    this.#cssHeight = cssHeight;
    this.#dpr = dpr;
    this.#canvas.width = Math.round(cssWidth * dpr);
    this.#canvas.height = Math.round(cssHeight * dpr);
    this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
