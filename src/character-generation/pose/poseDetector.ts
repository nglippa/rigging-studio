/**
 * Body keypoints from Google's MediaPipe Pose Landmarker (Apache-2.0), run in the browser. Browser only.
 *
 * The runtime and the model are served by the app from /mediapipe (copied by scripts/fetch-pose-model.sh), never from a
 * CDN. Tiny pixel sprites are scaled up with nearest-neighbour sampling first, because the model expects a person a
 * few hundred pixels tall.
 */
import type { PoseLandmarker as Landmarker } from "@mediapipe/tasks-vision";

export const POSE_KEYPOINTS = [
  "nose", "leftEyeInner", "leftEye", "leftEyeOuter", "rightEyeInner", "rightEye", "rightEyeOuter", "leftEar", "rightEar",
  "mouthLeft", "mouthRight", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist",
  "leftPinky", "rightPinky", "leftIndex", "rightIndex", "leftThumb", "rightThumb", "leftHip", "rightHip", "leftKnee",
  "rightKnee", "leftAnkle", "rightAnkle", "leftHeel", "rightHeel", "leftFootIndex", "rightFootIndex",
] as const;
export type PoseKeypointName = typeof POSE_KEYPOINTS[number];

/** One keypoint in source-image pixels. `visibility` is the model's 0–1 estimate that the joint is in view; `z` is depth relative to the hips (smaller is nearer the viewer). */
export type PoseKeypoint = { readonly x: number; readonly y: number; readonly z: number; readonly visibility: number };
export type DetectedPose = { readonly keypoints: Readonly<Record<PoseKeypointName, PoseKeypoint>>; readonly width: number; readonly height: number };

const WASM_ROOT = "/mediapipe/wasm";
const MODEL_PATH = "/mediapipe/models/pose_landmarker_full.task";
/** The model sees the character at least this tall. */
const MIN_INPUT_SIDE = 512;

let landmarker: Promise<Landmarker> | null = null;

function loadLandmarker(): Promise<Landmarker> {
  landmarker ??= (async () => {
    const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
    return PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_PATH },
      runningMode: "IMAGE", numPoses: 1,
      // Drawn characters score lower than photos; the visibility of each keypoint is checked by the caller instead.
      minPoseDetectionConfidence: .1, minPosePresenceConfidence: .1,
    });
  })().catch((error: unknown) => { landmarker = null; throw error; });
  return landmarker;
}

async function loadImage(source: string): Promise<HTMLImageElement> {
  const image = new Image(); image.crossOrigin = "anonymous"; image.src = source; await image.decode(); return image;
}

/** Margin added on every side, as a fraction of the image. The person detector misses figures that fill the frame. */
const MARGIN = .25;

/** The character on a neutral grey background with a margin, scaled up when small. Transparent sprites confuse the model on black. */
function prepareInput(image: HTMLImageElement): { readonly canvas: HTMLCanvasElement; readonly scale: number; readonly padX: number; readonly padY: number } {
  const scale = Math.max(1, Math.ceil(MIN_INPUT_SIDE / Math.max(image.naturalWidth, image.naturalHeight)));
  const padX = Math.round(image.naturalWidth * scale * MARGIN); const padY = Math.round(image.naturalHeight * scale * MARGIN);
  const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth * scale + padX * 2; canvas.height = image.naturalHeight * scale + padY * 2;
  const context = canvas.getContext("2d"); if (!context) throw new Error("Pose detection needs a 2D canvas");
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high"; context.fillStyle = "#8a8a8a"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, padX, padY, image.naturalWidth * scale, image.naturalHeight * scale);
  return { canvas, scale, padX, padY };
}

const results = new Map<string, Promise<DetectedPose | null>>();

/** Keypoints for the one character in the image, or null when the model finds no person. Results are kept per image. */
export function detectPose(source: string): Promise<DetectedPose | null> {
  let result = results.get(source);
  if (!result) { result = detect(source); results.set(source, result); result.catch(() => results.delete(source)); }
  return result;
}

async function detect(source: string): Promise<DetectedPose | null> {
  const [model, image] = await Promise.all([loadLandmarker(), loadImage(source)]);
  const input = prepareInput(image);
  const result = model.detect(input.canvas);
  const landmarks = result.landmarks[0];
  if (!landmarks || landmarks.length < POSE_KEYPOINTS.length) return null;
  const keypoints = Object.fromEntries(POSE_KEYPOINTS.map((name, index) => {
    const point = landmarks[index];
    const x = (point.x * input.canvas.width - input.padX) / input.scale; const y = (point.y * input.canvas.height - input.padY) / input.scale;
    return [name, { x, y, z: point.z, visibility: point.visibility ?? 0 }];
  })) as Record<PoseKeypointName, PoseKeypoint>;
  return { keypoints, width: image.naturalWidth, height: image.naturalHeight };
}
