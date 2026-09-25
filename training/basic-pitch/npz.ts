/**
 * Reads the reference outputs the model's own repository ships as `.npz`.
 *
 * `tests/resources/vocadito_10/model_output.npz` holds ONE object array: a
 * pickled Python dict of three float32 ndarrays (`np.savez(path, dict)`). No
 * numpy is available here, so this is a small zip reader, a `.npy` header
 * reader, and a pickle machine that implements only the opcodes numpy's
 * pickling of such a dict uses (protocol 3: GLOBAL, REDUCE, BUILD, the tuple
 * and container opcodes, memo get/put, ints, bytes, unicode). An opcode
 * outside that set throws rather than guessing.
 */

import { inflateRawSync } from "node:zlib";

export type NdArray = { shape: number[]; dtype: string; data: Float32Array | Float64Array | Int32Array | BigInt64Array };

/** Every entry of a zip archive, by name. Stored or deflated only. */
export function readZip(buf: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Map<string, Uint8Array>();
  // End of central directory: the last 0x06054b50 in the file.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const entries = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder();
  for (let e = 0; e < entries; e++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory");
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = view.getUint16(local + 26, true);
    const lExtraLen = view.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(raw)));
    else throw new Error(`${name}: zip method ${method}`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

type Obj =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | Obj[]
  | { kind: "tuple"; items: Obj[] }
  | { kind: "dict"; map: Map<string, Obj> }
  | { kind: "global"; name: string }
  | { kind: "dtype"; name: string; order: string }
  | { kind: "ndarray"; shape: number[]; dtype: { name: string; order: string } | null; bytes: Uint8Array | null; fortran: boolean }
  | { kind: "mark" };

const MARK: Obj = { kind: "mark" };

function unpickle(b: Uint8Array): Obj {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const utf8 = new TextDecoder();
  const stack: Obj[] = [];
  const memo = new Map<number, Obj>();
  let p = 0;
  const popMark = (): Obj[] => {
    const items: Obj[] = [];
    for (;;) {
      const x = stack.pop();
      if (x === undefined) throw new Error("pickle: mark not found");
      if (x === MARK) return items.reverse();
      items.push(x);
    }
  };
  const line = (): string => {
    let e = p;
    while (b[e] !== 0x0a) e++;
    const s = utf8.decode(b.subarray(p, e));
    p = e + 1;
    return s;
  };
  const tuple = (items: Obj[]): Obj => ({ kind: "tuple", items });
  const itemsOf = (o: Obj): Obj[] => {
    if (o !== null && typeof o === "object" && "kind" in o && o.kind === "tuple") return o.items;
    throw new Error("pickle: expected a tuple");
  };
  for (;;) {
    const op = b[p++];
    switch (op) {
      case 0x80: // PROTO
        p++;
        break;
      case 0x63: {
        // GLOBAL
        const mod = line();
        const name = line();
        stack.push({ kind: "global", name: `${mod}.${name}` });
        break;
      }
      case 0x71: // BINPUT
        memo.set(b[p++] as number, stack[stack.length - 1] as Obj);
        break;
      case 0x72: // LONG_BINPUT
        memo.set(view.getUint32(p, true), stack[stack.length - 1] as Obj);
        p += 4;
        break;
      case 0x68: // BINGET
        stack.push(memo.get(b[p++] as number) as Obj);
        break;
      case 0x6a: // LONG_BINGET
        stack.push(memo.get(view.getUint32(p, true)) as Obj);
        p += 4;
        break;
      case 0x4b: // BININT1
        stack.push(b[p++] as number);
        break;
      case 0x4d: // BININT2
        stack.push(view.getUint16(p, true));
        p += 2;
        break;
      case 0x4a: // BININT
        stack.push(view.getInt32(p, true));
        p += 4;
        break;
      case 0x43: {
        // SHORT_BINBYTES
        const n = b[p++] as number;
        stack.push(b.slice(p, p + n));
        p += n;
        break;
      }
      case 0x42: {
        // BINBYTES
        const n = view.getUint32(p, true);
        p += 4;
        stack.push(b.slice(p, p + n));
        p += n;
        break;
      }
      case 0x58: {
        // BINUNICODE
        const n = view.getUint32(p, true);
        p += 4;
        stack.push(utf8.decode(b.subarray(p, p + n)));
        p += n;
        break;
      }
      case 0x8c: {
        // SHORT_BINUNICODE
        const n = b[p++] as number;
        stack.push(utf8.decode(b.subarray(p, p + n)));
        p += n;
        break;
      }
      case 0x4e: // NONE
        stack.push(null);
        break;
      case 0x88: // NEWTRUE
        stack.push(true);
        break;
      case 0x89: // NEWFALSE
        stack.push(false);
        break;
      case 0x28: // MARK
        stack.push(MARK);
        break;
      case 0x29: // EMPTY_TUPLE
        stack.push(tuple([]));
        break;
      case 0x5d: // EMPTY_LIST
        stack.push([]);
        break;
      case 0x7d: // EMPTY_DICT
        stack.push({ kind: "dict", map: new Map() });
        break;
      case 0x74: // TUPLE
        stack.push(tuple(popMark()));
        break;
      case 0x85: // TUPLE1
        stack.push(tuple([stack.pop() as Obj]));
        break;
      case 0x86: {
        // TUPLE2
        const y = stack.pop() as Obj;
        const x = stack.pop() as Obj;
        stack.push(tuple([x, y]));
        break;
      }
      case 0x87: {
        // TUPLE3
        const z = stack.pop() as Obj;
        const y = stack.pop() as Obj;
        const x = stack.pop() as Obj;
        stack.push(tuple([x, y, z]));
        break;
      }
      case 0x61: {
        // APPEND
        const v = stack.pop() as Obj;
        (stack[stack.length - 1] as Obj[]).push(v);
        break;
      }
      case 0x65: {
        // APPENDS
        const items = popMark();
        (stack[stack.length - 1] as Obj[]).push(...items);
        break;
      }
      case 0x73: {
        // SETITEM
        const v = stack.pop() as Obj;
        const k = stack.pop() as string;
        (stack[stack.length - 1] as { map: Map<string, Obj> }).map.set(k, v);
        break;
      }
      case 0x75: {
        // SETITEMS
        const items = popMark();
        const d = stack[stack.length - 1] as { map: Map<string, Obj> };
        for (let i = 0; i < items.length; i += 2) d.map.set(items[i] as string, items[i + 1] as Obj);
        break;
      }
      case 0x52: {
        // REDUCE
        const args = itemsOf(stack.pop() as Obj);
        const fn = stack.pop() as { kind: "global"; name: string };
        if (fn.name === "numpy.core.multiarray._reconstruct" || fn.name === "numpy._core.multiarray._reconstruct") {
          stack.push({ kind: "ndarray", shape: [], dtype: null, bytes: null, fortran: false });
        } else if (fn.name === "numpy.dtype") {
          stack.push({ kind: "dtype", name: args[0] as string, order: "|" });
        } else {
          throw new Error(`pickle: REDUCE on ${fn.name}`);
        }
        break;
      }
      case 0x62: {
        // BUILD
        const state = itemsOf(stack.pop() as Obj);
        const target = stack[stack.length - 1] as Obj;
        if (target !== null && typeof target === "object" && "kind" in target && target.kind === "dtype") {
          target.order = state[1] as string;
        } else if (target !== null && typeof target === "object" && "kind" in target && target.kind === "ndarray") {
          target.shape = itemsOf(state[1] as Obj).map((x) => x as number);
          const dt = state[2] as { kind: "dtype"; name: string; order: string };
          target.dtype = { name: dt.name, order: dt.order };
          target.fortran = state[3] as boolean;
          const raw = state[4];
          target.bytes = raw instanceof Uint8Array ? raw : null;
          if (target.bytes === null && Array.isArray(raw)) target.bytes = null; // object payload handled by caller
          if (Array.isArray(raw)) (target as unknown as { objects: Obj[] }).objects = raw;
        } else {
          throw new Error("pickle: BUILD on an unsupported object");
        }
        break;
      }
      case 0x2e: // STOP
        return stack.pop() as Obj;
      default:
        throw new Error(`pickle: opcode 0x${(op ?? 0).toString(16)} at ${p - 1} is not implemented`);
    }
  }
}

function typed(dtype: string, bytes: Uint8Array): NdArray["data"] {
  const copy = bytes.slice().buffer;
  if (dtype === "f4") return new Float32Array(copy);
  if (dtype === "f8") return new Float64Array(copy);
  if (dtype === "i4") return new Int32Array(copy);
  if (dtype === "i8") return new BigInt64Array(copy);
  throw new Error(`dtype ${dtype} not supported`);
}

/**
 * The dict of arrays stored in one `.npy` object array, as numpy's `np.savez`
 * writes it for `np.savez(path, {"note": a, ...})`.
 */
export function readPickledArrayDict(npy: Uint8Array): Map<string, NdArray> {
  if (npy[0] !== 0x93 || new TextDecoder().decode(npy.subarray(1, 6)) !== "NUMPY") throw new Error("not a .npy file");
  const major = npy[6] as number;
  const view = new DataView(npy.buffer, npy.byteOffset, npy.byteLength);
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const start = (major === 1 ? 10 : 12) + headerLen;
  const header = new TextDecoder().decode(npy.subarray(major === 1 ? 10 : 12, start));
  if (!header.includes("'descr': '|O'")) throw new Error(`expected an object array, header ${header}`);
  const top = unpickle(npy.subarray(start)) as { kind: "ndarray"; objects?: Obj[] };
  const dict = top.objects?.[0] as { kind: "dict"; map: Map<string, Obj> } | undefined;
  if (dict?.kind !== "dict") throw new Error("expected a dict inside the object array");
  const out = new Map<string, NdArray>();
  for (const [k, v] of dict.map) {
    const a = v as { kind: "ndarray"; shape: number[]; dtype: { name: string; order: string }; bytes: Uint8Array; fortran: boolean };
    if (a.fortran) throw new Error(`${k}: Fortran order not supported`);
    if (a.dtype.order === ">") throw new Error(`${k}: big-endian not supported`);
    out.set(k, { shape: a.shape, dtype: a.dtype.name, data: typed(a.dtype.name, a.bytes) });
  }
  return out;
}
