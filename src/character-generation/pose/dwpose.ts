/**
 * DWPose (yzd-v/DWPose, dw-ll_ucoco_384, Apache-2.0): body keypoints for drawn characters, sprites and creatures.
 *
 * This file has no browser or Node dependencies: preparing the input and reading the output are plain array work, so the
 * app (onnxruntime-web in the browser) and the benchmark (onnxruntime-web under Node) run exactly the same code. Only
 * the runner that executes the model differs.
 *
 * Chosen by measurement (tests/rigging/guide-accuracy.test.ts, 2026-11-18): on hand-marked joints DWPose was far better
 * than the silhouette guide on detailed art (courier 1.8% against 5.9% of height, goblin 4.5% against 6.2%) and worse on
 * 48 px pixel sprites, where its own scores were low. So each joint is taken from DWPose only when its score is at least
 * DWPOSE_MIN_SCORE; the rest come from the silhouette. At 0.5, no benchmark sprite got worse.
 */
import type { DetectedPose, PoseKeypoint, PoseKeypointName } from "./poseDetector";

export const DWPOSE_INPUT = { width: 288, height: 384 } as const;
export const DWPOSE_MIN_SCORE = .5;
/** Margin around the silhouette, as a share of its size on each side (the usual top-down crop scale of 1.5). */
const MARGIN = .25;
const BACKGROUND = 138;
const MEAN = [123.675, 116.28, 103.53] as const;
const STD = [58.395, 57.12, 57.375] as const;
/** SimCC outputs are at twice the input resolution. */
const SIMCC_SPLIT = 2;

/** COCO body keypoints, the first 17 of DWPose's 133, under the names the rest of the pose code uses. */
const COCO_BODY: readonly PoseKeypointName[] = [
  "nose", "leftEye", "rightEye", "leftEar", "rightEar", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow",
  "leftWrist", "rightWrist", "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle",
];

export type RgbaImage = { readonly width: number; readonly height: number; readonly data: ArrayLike<number> };
/** Where the model's input sits in the source image: input pixel (u, v) is source (x + u * scaleX, y + v * scaleY). */
export type DwposeCrop = { readonly x: number; readonly y: number; readonly scaleX: number; readonly scaleY: number };

/**
 * The model's input: the character's silhouette plus a margin, fitted to 288×384, on grey, sampled nearest-neighbour
 * (smoothing blurred pixel art and measured worse), normalised and laid out channel by channel. Null for an empty image.
 */
export function prepareDwposeInput(image: RgbaImage): { readonly input: Float32Array; readonly crop: DwposeCrop } | null {
  const { width, height, data } = image;
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (data[(y * width + x) * 4 + 3] > 16) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (maxX < 0) return null;
  let boxWidth = (maxX - minX + 1) * (1 + 2 * MARGIN); let boxHeight = (maxY - minY + 1) * (1 + 2 * MARGIN);
  const aspect = DWPOSE_INPUT.width / DWPOSE_INPUT.height;
  if (boxWidth / boxHeight > aspect) boxHeight = boxWidth / aspect; else boxWidth = boxHeight * aspect;
  const crop: DwposeCrop = { x: (minX + maxX + 1) / 2 - boxWidth / 2, y: (minY + maxY + 1) / 2 - boxHeight / 2, scaleX: boxWidth / DWPOSE_INPUT.width, scaleY: boxHeight / DWPOSE_INPUT.height };
  const plane = DWPOSE_INPUT.width * DWPOSE_INPUT.height; const input = new Float32Array(plane * 3);
  for (let v = 0; v < DWPOSE_INPUT.height; v += 1) for (let u = 0; u < DWPOSE_INPUT.width; u += 1) {
    const sx = Math.floor(crop.x + (u + .5) * crop.scaleX); const sy = Math.floor(crop.y + (v + .5) * crop.scaleY);
    let rgb = [BACKGROUND, BACKGROUND, BACKGROUND];
    if (sx >= 0 && sy >= 0 && sx < width && sy < height) {
      const offset = (sy * width + sx) * 4; const alpha = data[offset + 3] / 255;
      rgb = [0, 1, 2].map((channel) => data[offset + channel] * alpha + BACKGROUND * (1 - alpha));
    }
    for (let channel = 0; channel < 3; channel += 1) input[channel * plane + v * DWPOSE_INPUT.width + u] = (rgb[channel] - MEAN[channel]) / STD[channel];
  }
  return { input, crop };
}

/** Joints from the model's SimCC outputs (shape [1, 133, 576] and [1, 133, 768]), in source pixels, scored 0–1. */
export function decodeDwpose(simccX: ArrayLike<number>, simccY: ArrayLike<number>, crop: DwposeCrop, image: { readonly width: number; readonly height: number }): DetectedPose {
  const binsX = DWPOSE_INPUT.width * SIMCC_SPLIT; const binsY = DWPOSE_INPUT.height * SIMCC_SPLIT;
  const peak = (values: ArrayLike<number>, offset: number, bins: number) => { let best = 0; let at = 0; for (let index = 0; index < bins; index += 1) { const value = values[offset + index]; if (index === 0 || value > best) { best = value; at = index; } } return { at, best }; };
  const keypoints: Partial<Record<PoseKeypointName, PoseKeypoint>> = {};
  COCO_BODY.forEach((name, keypoint) => {
    const x = peak(simccX, keypoint * binsX, binsX); const y = peak(simccY, keypoint * binsY, binsY);
    keypoints[name] = { x: crop.x + (x.at / SIMCC_SPLIT) * crop.scaleX, y: crop.y + (y.at / SIMCC_SPLIT) * crop.scaleY, z: 0, visibility: Math.max(0, Math.min(1, Math.min(x.best, y.best))) };
  });
  return { keypoints: fillMissing(keypoints), width: image.width, height: image.height };
}

/** Keypoints DWPose's body set does not have (heels, toes, fingers, mouth) are present but never trusted. */
function fillMissing(found: Partial<Record<PoseKeypointName, PoseKeypoint>>): Record<PoseKeypointName, PoseKeypoint> {
  const unseen: PoseKeypoint = { x: 0, y: 0, z: 0, visibility: 0 };
  const names: readonly PoseKeypointName[] = [
    "nose", "leftEyeInner", "leftEye", "leftEyeOuter", "rightEyeInner", "rightEye", "rightEyeOuter", "leftEar", "rightEar", "mouthLeft", "mouthRight",
    "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist", "leftPinky", "rightPinky", "leftIndex", "rightIndex",
    "leftThumb", "rightThumb", "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle", "leftHeel", "rightHeel", "leftFootIndex", "rightFootIndex",
  ];
  return Object.fromEntries(names.map((name) => [name, found[name] ?? unseen])) as Record<PoseKeypointName, PoseKeypoint>;
}

/** Runs the model on prepared input; supplied by the browser or the benchmark. */
export type DwposeRunner = (input: Float32Array) => Promise<{ readonly simccX: ArrayLike<number>; readonly simccY: ArrayLike<number> }>;

/** Keypoints for the character in an RGBA image, or null when it is empty. */
export async function detectDwpose(image: RgbaImage, run: DwposeRunner): Promise<DetectedPose | null> {
  const prepared = prepareDwposeInput(image); if (!prepared) return null;
  const output = await run(prepared.input);
  return decodeDwpose(output.simccX, output.simccY, prepared.crop, image);
}
