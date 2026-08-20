/**
 * A sample-addressed audio ring.
 *
 * The deep lane's whole reason for existing is that it may revisit audio
 * hundreds of milliseconds after the fast lane already reported on it. That is
 * only cheap if "the audio between sample A and sample B" is a plain array
 * read, which is what this provides: reads are addressed by absolute sample
 * index, not by an offset from the write head, so a deep job can be queued with
 * a sample range and resolved later without anyone tracking how far the ring
 * has moved in between.
 *
 * Capacity is rounded up to a power of two so the wrap is a mask, not a modulo.
 * A read whose range has fallen out of the ring fails rather than returning
 * stale audio — a dropped deep job is a diagnostic, silently analysing the
 * wrong 3 seconds is a bug nobody would ever see.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

export class AudioRing {
  private readonly buffer: Float32Array;
  private readonly mask: number;
  /** Absolute index of the next sample to be written. Never wraps. */
  private written = 0;

  constructor(capacitySamples: number) {
    if (!Number.isFinite(capacitySamples) || capacitySamples < 1) {
      throw new RangeError(`AudioRing: capacity must be >= 1, got ${capacitySamples}`);
    }
    const capacity = nextPowerOfTwo(Math.ceil(capacitySamples));
    this.buffer = new Float32Array(capacity);
    this.mask = capacity - 1;
  }

  get capacity(): number {
    return this.buffer.length;
  }

  /** Absolute index one past the newest sample. Equals total samples written. */
  get writeIndex(): number {
    return this.written;
  }

  /** Absolute index of the oldest sample still readable. */
  get oldestIndex(): number {
    return Math.max(0, this.written - this.buffer.length);
  }

  write(block: Float32Array): void {
    const n = block.length;
    for (let i = 0; i < n; i++) {
      this.buffer[(this.written + i) & this.mask] = block[i] as number;
    }
    this.written += n;
  }

  /** True when [startSample, startSample+count) is entirely still in the ring. */
  has(startSample: number, count: number): boolean {
    return (
      count >= 0 &&
      startSample >= this.oldestIndex &&
      startSample + count <= this.written
    );
  }

  /**
   * Copy `out.length` samples starting at absolute `startSample`, oldest first.
   * Returns false and leaves `out` untouched when the range is not available.
   */
  read(out: Float32Array, startSample: number): boolean {
    const count = out.length;
    if (!this.has(startSample, count)) return false;
    for (let i = 0; i < count; i++) {
      out[i] = this.buffer[(startSample + i) & this.mask] as number;
    }
    return true;
  }

  /**
   * Copy the most recent `out.length` samples. Zero-fills the leading part when
   * fewer samples have been written than requested, so a warm-up read is
   * silence rather than whatever the allocation happened to contain.
   */
  readLatest(out: Float32Array): void {
    const count = out.length;
    const start = this.written - count;
    if (start >= this.oldestIndex) {
      this.read(out, start);
      return;
    }
    const missing = this.oldestIndex - start;
    out.fill(0, 0, missing);
    for (let i = missing; i < count; i++) {
      out[i] = this.buffer[(start + i) & this.mask] as number;
    }
  }

  reset(): void {
    this.buffer.fill(0);
    this.written = 0;
  }
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
