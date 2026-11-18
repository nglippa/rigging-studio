#!/bin/sh
# Downloads the DWPose model (yzd-v/DWPose, dw-ll_ucoco_384.onnx, Apache-2.0) into public/models/dwpose, where
# src/character-generation/pose/poseDetector.ts loads it and tests/rigging/guide-accuracy.test.ts runs it. It is
# git-ignored (134 MB). The onnxruntime-web runtime comes from node_modules through the bundler.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MODEL_URL="https://huggingface.co/yzd-v/DWPose/resolve/main/dw-ll_ucoco_384.onnx"
MODEL_SHA256="724f4ff2439ed61afb86fb8a1951ec39c6220682803b4a8bd4f598cd913b1843"
mkdir -p "$ROOT/public/models/dwpose"
MODEL="$ROOT/public/models/dwpose/dw-ll_ucoco_384.onnx"
[ -f "$MODEL" ] || curl -sfL -o "$MODEL" "$MODEL_URL"
case "$(shasum -a 256 "$MODEL")" in "$MODEL_SHA256"*) echo "Pose model ready: $MODEL";; *) echo "Pose model checksum mismatch: $MODEL" >&2; exit 1;; esac
