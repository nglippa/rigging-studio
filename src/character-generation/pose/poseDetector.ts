/**
 * Body keypoints for the character in an image, from DWPose run in the browser with onnxruntime-web. Browser only; the
 * model work itself is in dwpose.ts, shared with the benchmark.
 *
 * The model is served by the app (downloaded by scripts/fetch-pose-model.sh) and the runtime is bundled, never loaded
 * from a CDN. Keypoints keep the names below whichever model produced them, so the rest of the pose code does not change.
 */
import type { InferenceSession } from "onnxruntime-web";
import { detectDwpose } from "./dwpose";
import { readImagePixels } from "../segmentation/partImageProcessor";

export const POSE_KEYPOINTS = [
  "nose", "leftEyeInner", "leftEye", "leftEyeOuter", "rightEyeInner", "rightEye", "rightEyeOuter", "leftEar", "rightEar",
  "mouthLeft", "mouthRight", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist",
  "leftPinky", "rightPinky", "leftIndex", "rightIndex", "leftThumb", "rightThumb", "leftHip", "rightHip", "leftKnee",
  "rightKnee", "leftAnkle", "rightAnkle", "leftHeel", "rightHeel", "leftFootIndex", "rightFootIndex",
] as const;
export type PoseKeypointName = typeof POSE_KEYPOINTS[number];

/** One keypoint in source-image pixels. `visibility` is the model's 0–1 score for it; `z` is depth when the model gives one (0 otherwise). */
export type PoseKeypoint = { readonly x: number; readonly y: number; readonly z: number; readonly visibility: number };
export type DetectedPose = { readonly keypoints: Readonly<Record<PoseKeypointName, PoseKeypoint>>; readonly width: number; readonly height: number };

const MODEL_PATH = "/models/dwpose/dw-ll_ucoco_384.onnx";

let session: Promise<InferenceSession> | null = null;
/**
 * The WASM build of onnxruntime with its loader bundled in. Vite will not load a module from public/, so the runtime's
 * binary is imported as an asset URL instead: Vite serves it in development and copies it into production builds.
 */
const runtime = () => import("onnxruntime-web/wasm");

function loadSession(): Promise<InferenceSession> {
  session ??= (async () => {
    const [ort, binary] = await Promise.all([runtime(), import("onnxruntime-web/ort-wasm-simd-threaded.wasm?url")]);
    ort.env.wasm.wasmPaths = { wasm: binary.default };
    return ort.InferenceSession.create(MODEL_PATH, { executionProviders: ["wasm"] });
  })().catch((error: unknown) => { session = null; throw error; });
  return session;
}

const results = new Map<string, Promise<DetectedPose | null>>();

/** Keypoints for the character in the image (null when it is empty). Results are kept per image. */
export function detectPose(source: string): Promise<DetectedPose | null> {
  let result = results.get(source);
  if (!result) { result = detect(source); results.set(source, result); result.catch(() => results.delete(source)); }
  return result;
}

async function detect(source: string): Promise<DetectedPose | null> {
  const [model, pixels] = await Promise.all([loadSession(), readImagePixels(source)]);
  const ort = await runtime();
  return detectDwpose(pixels, async (input) => {
    const output = await model.run({ [model.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, 384, 288]) });
    return { simccX: output[model.outputNames[0]].data as Float32Array, simccY: output[model.outputNames[1]].data as Float32Array };
  });
}
