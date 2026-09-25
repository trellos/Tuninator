#!/usr/bin/env bash
# Fetch every pinned input and build the runtime this evaluation reads the
# model with. Idempotent: re-running skips what is already in place.
#
#   bash training/hft-transformer/build.sh            # everything
#   JOBS=2 bash training/hft-transformer/build.sh     # parallel compile jobs (default 2)
#
# Everything lands under training/out/hft-transformer/ (gitignored):
#   hf/        the model card and the f32 GGUF, huggingface.co/cstr/hft-transformer-GGUF @ 17d72a24
#   ckpt/      the training checkpoint the GGUF was converted from,
#              huggingface.co/ddPn08/hft-transformer-rewrite @ 9c0f9836, epoch=9-step=46600.ckpt
#   src/       github.com/sony/hFT-Transformer @ 71a2ee06        (the original model)
#              github.com/ddPn08/hft-transformers-rewrite @ 53c2033b  (the checkpoint's code)
#              github.com/CrispStrobe/CrispASR @ 0864a3e0 (+ its ggml and c2pa-audio submodules)
#              github.com/CrispStrobe/flutter_tuner @ 2e2edcc1   (the ONNX export and its report)
#   build/     the CrispASR CMake build: the `crispasr` CLI (the model card's
#              advertised example) and the static libraries hft-read links
#   bin/       hft-read (hft-read.cpp), the activation reader
#
# No network access happens after this script. CMake is configured so that
# nothing is fetched at configure or build time (tests off, which is what pulls
# Catch2; Opus and AMR off, which are what FetchContent would clone).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$REPO/training/out/hft-transformer"
JOBS="${JOBS:-2}"
mkdir -p "$OUT/hf" "$OUT/ckpt" "$OUT/src" "$OUT/build" "$OUT/bin"

HF_REV=17d72a2429f10579d590ae66b7db4985886c89be
CKPT_REV=9c0f9836432e6720931c9ed181ed0adab47e8090

fetch() { # url dest sha256
  if [ ! -f "$2" ]; then curl -sSL -o "$2" "$1"; fi
  echo "$3  $2" | sha256sum -c --quiet
}
fetch "https://huggingface.co/cstr/hft-transformer-GGUF/resolve/$HF_REV/README.md" \
  "$OUT/hf/README.md" 17b23870f50b013ecee06aead4fc9b161cfaad3308430b331216816bd526217a
fetch "https://huggingface.co/cstr/hft-transformer-GGUF/resolve/$HF_REV/hft-transformer-f32.gguf" \
  "$OUT/hf/hft-transformer-f32.gguf" 577652db638f31b60b09e8651e6920faab83a35db84b103e29301d24ffaca935
fetch "https://huggingface.co/ddPn08/hft-transformer-rewrite/resolve/$CKPT_REV/epoch%3D9-step%3D46600.ckpt" \
  "$OUT/ckpt/epoch=9-step=46600.ckpt" 7b7b575c2f02b3c36f1c3e2079b29eaca020ecb79fee40a1a473ef60052e9d12

clone() { # url dir commit
  if [ ! -d "$2/.git" ]; then git clone -q "$1" "$2"; fi
  git -C "$2" checkout -q "$3"
}
clone https://github.com/sony/hFT-Transformer.git "$OUT/src/hFT-Transformer" 71a2ee06e9ced1ea24673c95ee0acded2fc98d04
clone https://github.com/ddPn08/hft-transformers-rewrite.git "$OUT/src/hft-transformers-rewrite" 53c2033bced1642ac3c8ed5bff4fb9ea153b541c
clone https://github.com/CrispStrobe/CrispASR.git "$OUT/src/CrispASR" 0864a3e01f54e3a56c476a318a5c20cd02720a1e
git -C "$OUT/src/CrispASR" submodule update --init ggml third_party/c2pa-audio
clone https://github.com/CrispStrobe/flutter_tuner.git "$OUT/src/flutter_tuner" 2e2edcc1fc19b0718a9a8e1e978fba4b3837c1ee
# The ONNX export kernel and its logged results were removed from flutter_tuner
# after the export ran; they are read at the commit that added them.
mkdir -p "$OUT/src/onnx-export"
git -C "$OUT/src/flutter_tuner" show 8cb104abc5f6a8756a5deb2c87d0968e48f156a5:bench/tool/kaggle/onnx-export/onnx_export.py \
  > "$OUT/src/onnx-export/onnx_export.py"
git -C "$OUT/src/flutter_tuner" show 8cb104abc5f6a8756a5deb2c87d0968e48f156a5:bench/tool/kaggle/onnx-export/results.json \
  > "$OUT/src/onnx-export/results.json"

B="$OUT/build/crispasr"
cmake -S "$OUT/src/CrispASR" -B "$B" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DCRISPASR_BUILD_TESTS=OFF -DCRISPASR_BUILD_SERVER=OFF -DCRISPASR_BUILD_EXAMPLES=ON \
  -DCRISPASR_OPUS=OFF -DCRISPASR_AMR=OFF -DCRISPASR_CURL=OFF -DGGML_NATIVE=ON > "$OUT/build/cmake-configure.log"
cmake --build "$B" --target crispasr-cli crispasr-core ggml ggml-cpu ggml-base -j"$JOBS" > "$OUT/build/build.log"

g++ -O3 -march=native -std=c++17 -fopenmp \
  -I"$OUT/src/CrispASR/src" -I"$OUT/src/CrispASR/ggml/include" \
  "$HERE/hft-read.cpp" -o "$OUT/bin/hft-read" \
  "$B/src/libcrispasr-core.a" "$B/ggml/src/libggml.a" "$B/ggml/src/libggml-cpu.a" "$B/ggml/src/libggml-base.a" \
  -lpthread -ldl -lm
echo "built: $B/bin/crispasr (the model card's CLI), $OUT/bin/hft-read"
