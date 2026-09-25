/**
 * A minimal GGUF (version 3) reader: the key-value metadata, and every
 * tensor's name, shape, type and bytes. Enough to count a model's parameters
 * from the file itself and to compare its weights with the checkpoint they
 * were converted from. F32 tensors only are decoded; the evaluation reads the
 * f32 build, and a quantised tensor is reported by type rather than guessed at.
 *
 * Shapes are in ggml order: `dims[0]` is the fastest-varying axis. A
 * `[in, out]` ggml matrix has the same memory layout as a PyTorch
 * `Linear.weight` of shape `[out, in]`.
 */

import { readFileSync } from "node:fs";

export type GgufValue = number | bigint | boolean | string | GgufValue[];

export type GgufTensor = {
  name: string;
  dims: number[];
  /** ggml type id: 0 = F32, 1 = F16, 2 = Q4_0, 8 = Q8_0. */
  type: number;
  /** Offset into the data section, in bytes. */
  offset: number;
  elements: number;
};

export type Gguf = {
  version: number;
  kv: Map<string, GgufValue>;
  tensors: GgufTensor[];
  /** Absolute byte offset of the data section. */
  dataStart: number;
  bytes: Buffer;
};

export const GGML_TYPE_NAME: Readonly<Record<number, string>> = { 0: "F32", 1: "F16", 2: "Q4_0", 8: "Q8_0" };

export function readGguf(path: string): Gguf {
  const bytes = readFileSync(path);
  let o = 0;
  const u32 = (): number => {
    const v = bytes.readUInt32LE(o);
    o += 4;
    return v;
  };
  const u64 = (): number => {
    const v = bytes.readBigUInt64LE(o);
    o += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("gguf: 64-bit value out of range");
    return Number(v);
  };
  const str = (): string => {
    const n = u64();
    const s = bytes.toString("utf8", o, o + n);
    o += n;
    return s;
  };
  const value = (type: number): GgufValue => {
    switch (type) {
      case 0: {
        const v = bytes.readUInt8(o);
        o += 1;
        return v;
      }
      case 1: {
        const v = bytes.readInt8(o);
        o += 1;
        return v;
      }
      case 2: {
        const v = bytes.readUInt16LE(o);
        o += 2;
        return v;
      }
      case 3: {
        const v = bytes.readInt16LE(o);
        o += 2;
        return v;
      }
      case 4:
        return u32();
      case 5: {
        const v = bytes.readInt32LE(o);
        o += 4;
        return v;
      }
      case 6: {
        const v = bytes.readFloatLE(o);
        o += 4;
        return v;
      }
      case 7: {
        const v = bytes.readUInt8(o) !== 0;
        o += 1;
        return v;
      }
      case 8:
        return str();
      case 9: {
        const itemType = u32();
        const n = u64();
        const out: GgufValue[] = [];
        for (let i = 0; i < n; i++) out.push(value(itemType));
        return out;
      }
      case 10: {
        const v = bytes.readBigUInt64LE(o);
        o += 8;
        return v;
      }
      case 11: {
        const v = bytes.readBigInt64LE(o);
        o += 8;
        return v;
      }
      case 12: {
        const v = bytes.readDoubleLE(o);
        o += 8;
        return v;
      }
      default:
        throw new Error(`gguf: unknown value type ${type}`);
    }
  };

  if (bytes.toString("latin1", 0, 4) !== "GGUF") throw new Error(`${path}: not a GGUF file`);
  o = 4;
  const version = u32();
  const nTensors = u64();
  const nKv = u64();
  const kv = new Map<string, GgufValue>();
  for (let i = 0; i < nKv; i++) {
    const key = str();
    kv.set(key, value(u32()));
  }
  const tensors: GgufTensor[] = [];
  for (let i = 0; i < nTensors; i++) {
    const name = str();
    const nd = u32();
    const dims: number[] = [];
    for (let d = 0; d < nd; d++) dims.push(u64());
    const type = u32();
    const offset = u64();
    tensors.push({ name, dims, type, offset, elements: dims.reduce((a, b) => a * b, 1) });
  }
  const alignmentValue = kv.get("general.alignment");
  const alignment = typeof alignmentValue === "number" ? alignmentValue : 32;
  const dataStart = Math.ceil(o / alignment) * alignment;
  return { version, kv, tensors, dataStart, bytes };
}

/** An F32 tensor's values, copied out of the file. */
export function f32Tensor(g: Gguf, name: string): Float32Array {
  const t = g.tensors.find((x) => x.name === name);
  if (t === undefined) throw new Error(`gguf: no tensor ${name}`);
  if (t.type !== 0) throw new Error(`gguf: ${name} is ${GGML_TYPE_NAME[t.type] ?? t.type}, not F32`);
  const start = g.dataStart + t.offset;
  const out = new Float32Array(t.elements);
  for (let i = 0; i < t.elements; i++) out[i] = g.bytes.readFloatLE(start + 4 * i);
  return out;
}

export function kvNumber(g: Gguf, key: string): number {
  const v = g.kv.get(key);
  if (typeof v !== "number") throw new Error(`gguf: ${key} is not a number`);
  return v;
}

export function kvString(g: Gguf, key: string): string {
  const v = g.kv.get(key);
  if (typeof v !== "string") throw new Error(`gguf: ${key} is not a string`);
  return v;
}
