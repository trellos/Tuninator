"""
Read the published training checkpoint behind the GGUF, with the Python
standard library only (this environment has no torch and cannot install it).

The GGUF evaluated here (huggingface.co/cstr/hft-transformer-GGUF) was
converted from an ONNX export of `epoch=9-step=46600.ckpt` in
huggingface.co/ddPn08/hft-transformer-rewrite, made with the code of
github.com/ddPn08/hft-transformers-rewrite (the flutter_tuner export kernel
names both; see `phase1.ts`). This reads that checkpoint directly:

  1. what the Lightning training loop recorded (epoch, global step, the batch
     progress inside the last epoch), which pins how many batches an epoch
     held and so how large the training set was;
  2. the state dict: every tensor's name, shape and element count, so the
     parameter count is COUNTED rather than inferred from the GGUF;
  3. `--export <dir>`: every float32 tensor of the state dict as a raw
     little-endian file plus `index.json`, for `ckpt-vs-gguf.ts` (do the GGUF's
     weights equal the checkpoint's?) and `reference-forward.ts` (does the
     GGUF runtime compute what the checkpoint's own architecture computes?).

A PyTorch checkpoint is a zip holding `data.pkl` and one raw file per storage.
The unpickler below resolves the two torch callables a state dict needs
(`_rebuild_tensor_v2`, `_rebuild_parameter`) and the storage persistent ids,
and stands in a generic object for any other class the Lightning state names
(callbacks, optimizer state), which is only printed, never trusted.

Usage:
  python3 training/hft-transformer/read-ckpt.py <ckpt>
  python3 training/hft-transformer/read-ckpt.py <ckpt> --export <dir>
"""

import hashlib
import json
import os
import pickle
import struct
import sys
import zipfile

PINNED_SHA256 = "7b7b575c2f02b3c36f1c3e2079b29eaca020ecb79fee40a1a473ef60052e9d12"

DTYPES = {
    "FloatStorage": ("<f", 4, "float32"),
    "DoubleStorage": ("<d", 8, "float64"),
    "HalfStorage": ("<e", 2, "float16"),
    "LongStorage": ("<q", 8, "int64"),
    "IntStorage": ("<i", 4, "int32"),
    "BoolStorage": ("<?", 1, "bool"),
    "ByteStorage": ("<B", 1, "uint8"),
}


class Stub:
    """Any class the checkpoint names that a state dict does not need."""

    def __init__(self, *args, **kwargs):
        self.args = args

    def __setstate__(self, state):
        self.state = state

    def __repr__(self):
        return "<stub>"


class StorageType:
    def __init__(self, name):
        self.name = name


class Tensor:
    def __init__(self, storage, offset, size, stride):
        self.storage = storage  # (dtype name, key, numel)
        self.offset = offset
        self.size = tuple(size)
        self.stride = tuple(stride)

    @property
    def numel(self):
        n = 1
        for d in self.size:
            n *= d
        return n


def rebuild_tensor_v2(storage, offset, size, stride, *rest):
    return Tensor(storage, offset, size, stride)


def rebuild_parameter(data, requires_grad, backward_hooks, *rest):
    return data


class Unpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module == "torch._utils" and name == "_rebuild_tensor_v2":
            return rebuild_tensor_v2
        if module == "torch._utils" and name == "_rebuild_parameter":
            return rebuild_parameter
        if module == "torch" and name in DTYPES:
            return StorageType(name)
        if module == "collections" and name == "OrderedDict":
            import collections

            return collections.OrderedDict
        if module == "builtins" and name in ("set", "frozenset", "dict", "list", "tuple", "slice"):
            import builtins

            return getattr(builtins, name)
        return Stub

    def persistent_load(self, pid):
        # ('storage', storage_type, key, location, numel)
        kind, storage_type, key, _location, numel = pid
        if kind != "storage":
            raise ValueError(f"unknown persistent id {pid!r}")
        return (storage_type.name, key, numel)


def load(path):
    z = zipfile.ZipFile(path)
    root = z.namelist()[0].split("/")[0]
    with z.open(f"{root}/data.pkl") as f:
        obj = Unpickler(f).load()
    return z, root, obj


def tensor_bytes(z, root, t):
    dtype, key, _numel = t.storage
    fmt, width, _ = DTYPES[dtype]
    raw = z.read(f"{root}/data/{key}")
    # Contiguous row-major is all a state dict of this model holds; asserted.
    expect = []
    acc = 1
    for d in reversed(t.size):
        expect.insert(0, acc)
        acc *= d
    if t.numel > 1 and list(t.stride) != expect:
        raise ValueError(f"non-contiguous tensor (stride {t.stride}, size {t.size})")
    start = t.offset * width
    return raw[start : start + t.numel * width]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    path = sys.argv[1]
    export = sys.argv[sys.argv.index("--export") + 1] if "--export" in sys.argv else None

    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    print(f"checkpoint sha256 {digest}")
    if digest != PINNED_SHA256:
        print(f"DRIFT: pinned {PINNED_SHA256}")
        sys.exit(1)

    z, root, ck = load(path)
    print("top-level keys:", sorted(ck.keys()))
    print("epoch", ck.get("epoch"), "global_step", ck.get("global_step"))
    print("lightning version", ck.get("pytorch-lightning_version"))
    for k in ("hyper_parameters", "hparams_name"):
        if k in ck:
            print(k, ck[k])

    loops = ck.get("loops") or {}
    fit = loops.get("fit_loop") or {}
    for k in sorted(fit.keys()):
        v = fit[k]
        if isinstance(v, dict) and ("total" in v or "current" in v):
            print(f"  fit_loop.{k}: {json.dumps(v, default=str)}")

    sd = ck["state_dict"]
    total = 0
    by_part = {}
    rows = []
    for name, t in sd.items():
        if not isinstance(t, Tensor):
            continue
        total += t.numel
        part = name.split(".")[1] if name.startswith("model.") else name.split(".")[0]
        by_part[part] = by_part.get(part, 0) + t.numel
        rows.append((name, t))
    print(f"state_dict: {len(rows)} tensors, {total:,} elements")
    for part, n in by_part.items():
        print(f"  {part:10s} {n:,}")
    for name, t in rows:
        print(f"  {name} {list(t.size)} {t.storage[0]}")

    if export:
        os.makedirs(export, exist_ok=True)
        index = {}
        for name, t in rows:
            if t.storage[0] != "FloatStorage":
                continue
            fname = name.replace("/", "_") + ".f32"
            with open(os.path.join(export, fname), "wb") as f:
                f.write(tensor_bytes(z, root, t))
            index[name] = {"file": fname, "shape": list(t.size)}
        with open(os.path.join(export, "index.json"), "w") as f:
            json.dump({"checkpoint_sha256": digest, "tensors": index}, f, indent=1)
        print(f"exported {len(index)} float32 tensors to {export}")


if __name__ == "__main__":
    main()
