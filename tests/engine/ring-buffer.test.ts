import { describe, expect, it } from "vitest";
import { AudioRing } from "../../src/engine/ring-buffer.js";

function ramp(from: number, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = from + i;
  return out;
}

describe("AudioRing", () => {
  it("rounds capacity up to a power of two", () => {
    expect(new AudioRing(1000).capacity).toBe(1024);
    expect(new AudioRing(1024).capacity).toBe(1024);
  });

  it("reads back by absolute sample index", () => {
    const ring = new AudioRing(64);
    ring.write(ramp(0, 40));
    const out = new Float32Array(10);
    expect(ring.read(out, 5)).toBe(true);
    expect([...out]).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("keeps absolute addressing correct across a wrap", () => {
    const ring = new AudioRing(64);
    ring.write(ramp(0, 100));
    const out = new Float32Array(8);
    expect(ring.read(out, 90)).toBe(true);
    expect([...out]).toEqual([90, 91, 92, 93, 94, 95, 96, 97]);
  });

  it("refuses a read that has fallen out of the ring", () => {
    const ring = new AudioRing(64);
    ring.write(ramp(0, 200));
    const out = new Float32Array(8);
    out.fill(-1);
    // 200 written, capacity 64, so the oldest readable sample is 136.
    expect(ring.oldestIndex).toBe(136);
    expect(ring.read(out, 10)).toBe(false);
    expect([...out]).toEqual([-1, -1, -1, -1, -1, -1, -1, -1]);
    expect(ring.has(136, 64)).toBe(true);
    expect(ring.has(135, 1)).toBe(false);
  });

  it("refuses a read that runs past the write head", () => {
    const ring = new AudioRing(64);
    ring.write(ramp(0, 20));
    expect(ring.read(new Float32Array(8), 16)).toBe(false);
  });

  it("zero-fills a warm-up read rather than returning garbage", () => {
    const ring = new AudioRing(64);
    ring.write(ramp(1, 4));
    const out = new Float32Array(8);
    out.fill(99);
    ring.readLatest(out);
    expect([...out]).toEqual([0, 0, 0, 0, 1, 2, 3, 4]);
  });

  it("readLatest tracks the write head", () => {
    const ring = new AudioRing(64);
    ring.write(ramp(0, 100));
    const out = new Float32Array(4);
    ring.readLatest(out);
    expect([...out]).toEqual([96, 97, 98, 99]);
  });

  it("resets to an empty ring", () => {
    const ring = new AudioRing(64);
    ring.write(ramp(0, 100));
    ring.reset();
    expect(ring.writeIndex).toBe(0);
    expect(ring.oldestIndex).toBe(0);
  });
});
