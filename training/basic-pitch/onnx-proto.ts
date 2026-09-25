/**
 * A minimal, dependency-free reader for the parts of an ONNX file this
 * evaluation needs: the graph's initializers (name, shape, element type, and
 * float values) and its nodes (operator, inputs, outputs, attributes).
 *
 * Why hand-rolled: the parameter count and the convolution shapes must be read
 * from the published weight file itself, not from a runtime's summary, and the
 * root typecheck must not depend on a package only this directory installs.
 * ONNX is plain protobuf; only the wire format and a dozen field numbers from
 * `onnx.proto` are needed:
 *
 *   ModelProto      7 graph
 *   GraphProto      1 node, 5 initializer, 11 input, 12 output
 *   NodeProto       1 input, 2 output, 3 name, 4 op_type, 5 attribute
 *   AttributeProto  1 name, 2 f, 3 i, 4 s, 5 t, 7 floats, 8 ints, 20 type
 *   TensorProto     1 dims, 2 data_type, 4 float_data, 5 int32_data,
 *                   7 int64_data, 8 name, 9 raw_data
 *
 * Nothing here executes the model.
 */

export type OnnxTensor = {
  name: string;
  dims: number[];
  /** ONNX TensorProto.DataType: 1 float32, 6 int32, 7 int64, 11 float64. */
  dataType: number;
  /** Element count (product of dims; 1 for a scalar). */
  size: number;
  /** Float values when the tensor is float32 or float64, else null. */
  floats: Float64Array | null;
  /** Integer values when the tensor is int32 or int64, else null. */
  ints: number[] | null;
};

export type OnnxAttribute = {
  name: string;
  f?: number;
  i?: number;
  s?: string;
  t?: OnnxTensor;
  floats?: number[];
  ints?: number[];
};

export type OnnxNode = {
  name: string;
  opType: string;
  inputs: string[];
  outputs: string[];
  attributes: Map<string, OnnxAttribute>;
};

export type OnnxGraph = {
  initializers: OnnxTensor[];
  nodes: OnnxNode[];
  inputs: string[];
  outputs: string[];
};

type Field = { no: number; wire: number; varint?: bigint; bytes?: Uint8Array; fixed?: Uint8Array };

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const b = buf[pos++];
    if (b === undefined) throw new Error("truncated varint");
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
}

function fields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [key, p1] = readVarint(buf, pos);
    pos = p1;
    const no = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      const [v, p2] = readVarint(buf, pos);
      pos = p2;
      out.push({ no, wire, varint: v });
    } else if (wire === 1) {
      out.push({ no, wire, fixed: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      pos = p2;
      const n = Number(len);
      out.push({ no, wire, bytes: buf.subarray(pos, pos + n) });
      pos += n;
    } else if (wire === 5) {
      out.push({ no, wire, fixed: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else {
      throw new Error(`unsupported wire type ${wire} at ${pos}`);
    }
  }
  return out;
}

const utf8 = new TextDecoder();

/** Signed 64-bit from a varint, as a JS number (the values here are small). */
function int64(v: bigint): number {
  return Number(BigInt.asIntN(64, v));
}

/** A repeated int64 field, packed or not. */
function repeatedInt64(fs: Field[], no: number): number[] {
  const out: number[] = [];
  for (const f of fs) {
    if (f.no !== no) continue;
    if (f.wire === 0 && f.varint !== undefined) out.push(int64(f.varint));
    else if (f.wire === 2 && f.bytes !== undefined) {
      let p = 0;
      while (p < f.bytes.length) {
        const [v, p2] = readVarint(f.bytes, p);
        p = p2;
        out.push(int64(v));
      }
    }
  }
  return out;
}

/** A repeated float field, packed or not. */
function repeatedFloat(fs: Field[], no: number): number[] {
  const out: number[] = [];
  for (const f of fs) {
    if (f.no !== no) continue;
    if (f.wire === 5 && f.fixed !== undefined) {
      out.push(new DataView(f.fixed.buffer, f.fixed.byteOffset, 4).getFloat32(0, true));
    } else if (f.wire === 2 && f.bytes !== undefined) {
      const dv = new DataView(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
      for (let p = 0; p + 4 <= f.bytes.length; p += 4) out.push(dv.getFloat32(p, true));
    }
  }
  return out;
}

function str(fs: Field[], no: number): string {
  const f = fs.find((x) => x.no === no && x.wire === 2);
  return f?.bytes === undefined ? "" : utf8.decode(f.bytes);
}

function strs(fs: Field[], no: number): string[] {
  return fs.filter((x) => x.no === no && x.wire === 2 && x.bytes !== undefined).map((x) => utf8.decode(x.bytes as Uint8Array));
}

export function parseTensor(buf: Uint8Array): OnnxTensor {
  const fs = fields(buf);
  const dims = repeatedInt64(fs, 1);
  const dataType = Number(fs.find((f) => f.no === 2)?.varint ?? 0n);
  const name = str(fs, 8);
  const size = dims.reduce((a, b) => a * b, 1);
  const raw = fs.find((f) => f.no === 9 && f.wire === 2)?.bytes;
  let floats: Float64Array | null = null;
  let ints: number[] | null = null;
  if (dataType === 1 || dataType === 11) {
    floats = new Float64Array(size);
    if (raw !== undefined && raw.length > 0) {
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const w = dataType === 1 ? 4 : 8;
      if (raw.length !== size * w) throw new Error(`${name}: raw_data ${raw.length} bytes for ${size} elements`);
      for (let i = 0; i < size; i++) floats[i] = w === 4 ? dv.getFloat32(i * 4, true) : dv.getFloat64(i * 8, true);
    } else {
      const fd = repeatedFloat(fs, 4);
      if (fd.length !== size) throw new Error(`${name}: float_data ${fd.length} for ${size} elements`);
      floats.set(fd);
    }
  } else if (dataType === 6 || dataType === 7) {
    if (raw !== undefined && raw.length > 0) {
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      ints = [];
      const w = dataType === 6 ? 4 : 8;
      for (let i = 0; i < size; i++) {
        ints.push(w === 4 ? dv.getInt32(i * 4, true) : Number(dv.getBigInt64(i * 8, true)));
      }
    } else {
      ints = dataType === 6 ? repeatedInt64(fs, 5) : repeatedInt64(fs, 7);
    }
  }
  return { name, dims, dataType, size, floats, ints };
}

function parseAttribute(buf: Uint8Array): OnnxAttribute {
  const fs = fields(buf);
  const a: OnnxAttribute = { name: str(fs, 1) };
  const f = fs.find((x) => x.no === 2 && x.wire === 5);
  if (f?.fixed !== undefined) a.f = new DataView(f.fixed.buffer, f.fixed.byteOffset, 4).getFloat32(0, true);
  const i = fs.find((x) => x.no === 3 && x.wire === 0);
  if (i?.varint !== undefined) a.i = int64(i.varint);
  const s = fs.find((x) => x.no === 4 && x.wire === 2);
  if (s?.bytes !== undefined) a.s = utf8.decode(s.bytes);
  const t = fs.find((x) => x.no === 5 && x.wire === 2);
  if (t?.bytes !== undefined) a.t = parseTensor(t.bytes);
  const floats = repeatedFloat(fs, 7);
  if (floats.length > 0) a.floats = floats;
  const ints = repeatedInt64(fs, 8);
  if (ints.length > 0) a.ints = ints;
  return a;
}

function parseNode(buf: Uint8Array): OnnxNode {
  const fs = fields(buf);
  const attributes = new Map<string, OnnxAttribute>();
  for (const f of fs) {
    if (f.no === 5 && f.wire === 2 && f.bytes !== undefined) {
      const a = parseAttribute(f.bytes);
      attributes.set(a.name, a);
    }
  }
  return { name: str(fs, 3), opType: str(fs, 4), inputs: strs(fs, 1), outputs: strs(fs, 2), attributes };
}

function valueInfoName(buf: Uint8Array): string {
  return str(fields(buf), 1);
}

export function parseOnnx(file: Uint8Array): OnnxGraph {
  const model = fields(file);
  const g = model.find((f) => f.no === 7 && f.wire === 2)?.bytes;
  if (g === undefined) throw new Error("no graph in model");
  const gf = fields(g);
  const initializers: OnnxTensor[] = [];
  const nodes: OnnxNode[] = [];
  const inputs: string[] = [];
  const outputs: string[] = [];
  for (const f of gf) {
    if (f.wire !== 2 || f.bytes === undefined) continue;
    if (f.no === 5) initializers.push(parseTensor(f.bytes));
    else if (f.no === 1) nodes.push(parseNode(f.bytes));
    else if (f.no === 11) inputs.push(valueInfoName(f.bytes));
    else if (f.no === 12) outputs.push(valueInfoName(f.bytes));
  }
  return { initializers, nodes, inputs, outputs };
}
