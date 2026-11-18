#!/bin/sh
# Copies the MediaPipe WASM runtime out of node_modules and downloads the pose model into public/mediapipe, where
# src/character-generation/pose/poseDetector.ts loads them. Both are git-ignored. Run after npm install.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MODEL_URL="https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task"
MODEL_SHA256="5134a3aad27a58b93da0"
mkdir -p "$ROOT/public/mediapipe/wasm" "$ROOT/public/mediapipe/models"
cp "$ROOT/node_modules/@mediapipe/tasks-vision/wasm/"* "$ROOT/public/mediapipe/wasm/"
MODEL="$ROOT/public/mediapipe/models/pose_landmarker_full.task"
[ -f "$MODEL" ] || curl -sfL -o "$MODEL" "$MODEL_URL"
case "$(shasum -a 256 "$MODEL")" in "$MODEL_SHA256"*) echo "Pose model ready: $MODEL";; *) echo "Pose model checksum mismatch: $MODEL" >&2; exit 1;; esac
