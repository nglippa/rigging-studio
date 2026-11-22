/**
 * The part model: a small segmentation network (U-Net, ResNet-34 encoder) trained on the hand-labelled cut bench, which
 * says for every pixel of a sprite which of the 14 body parts it is, or held equipment. It runs on this machine with
 * onnxruntime-web, in the browser (partModelDetector.ts) and under Node for the bench (scripts/cut-pipeline.mts), so both
 * prepare and read it with exactly this code. Training and export: scripts/part-model/ (see docs/part-cutting.md).
 *
 * The figure is scaled to 440 px tall in the middle of a 512×512 canvas, once as drawn and once mirrored (the mirrored
 * answer is mirrored back with left and right swapped), and the two answers are averaged. Left and right are screen sides.
 */
import { PLAN_EQUIPMENT, PLAN_PARTS } from "./cutPlan";

export const PART_MODEL_SIZE = 512;
/** Model classes: 0 background, 1..14 PLAN_PARTS, 15 equipment. */
export const PART_MODEL_CLASSES = 16;
const FIGURE_HEIGHT = 440;
/** Class swapped by a mirror: left and right limbs trade places. */
const MIRROR = Array.from({ length: PART_MODEL_CLASSES }, (_, index) => index);
for (const [a, b] of [[3, 6], [4, 7], [5, 8], [9, 12], [10, 13], [11, 14]]) { MIRROR[a] = b; MIRROR[b] = a; }

export type PartModelImage = { readonly width: number; readonly height: number; readonly data: ArrayLike<number> };
export type PartModelFrame = { readonly centreX: number; readonly centreY: number; readonly scale: number };
/** Each pixel's part (PLAN_PARTS index + 1), PLAN_EQUIPMENT for equipment, 0 for background, and how sure the model is (0..1). */
export type PartPrediction = { readonly labels: Uint8Array; readonly confidence: Float32Array };
export type PartModelRunner = (input: Float32Array) => Promise<ArrayLike<number>>;

/** The model's input: two 4×512×512 planes (premultiplied RGB and alpha, 0..1), as drawn and mirrored. Null for an empty image. */
export function preparePartModelInput(image: PartModelImage): { readonly input: Float32Array; readonly frame: PartModelFrame } | null {
  const { width, height, data } = image; let top = height; let bottom = -1; let left = width; let right = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (data[(y * width + x) * 4 + 3] > 16) { if (y < top) top = y; if (y > bottom) bottom = y; if (x < left) left = x; if (x > right) right = x; }
  if (bottom < 0) return null;
  const frame: PartModelFrame = { centreX: (left + right) / 2, centreY: (top + bottom) / 2, scale: FIGURE_HEIGHT / (bottom - top + 1) };
  const size = PART_MODEL_SIZE; const plane = size * size; const input = new Float32Array(2 * 4 * plane);
  for (let mirror = 0; mirror < 2; mirror += 1) for (let gy = 0; gy < size; gy += 1) for (let gx = 0; gx < size; gx += 1) {
    const dx = (gx - size / 2) / frame.scale;
    const sx = Math.round(frame.centreX + (mirror ? -dx : dx)); const sy = Math.round(frame.centreY + (gy - size / 2) / frame.scale);
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
    const s = (sy * width + sx) * 4; const alpha = data[s + 3] / 255; const o = mirror * 4 * plane + gy * size + gx;
    input[o] = data[s] / 255 * alpha; input[o + plane] = data[s + 1] / 255 * alpha; input[o + 2 * plane] = data[s + 2] / 255 * alpha; input[o + 3 * plane] = alpha;
  }
  return { input, frame };
}

/** Reads the model's logits (2×16×512×512) back onto the image's own pixels. */
export function decodePartModel(logits: ArrayLike<number>, frame: PartModelFrame, image: PartModelImage): PartPrediction {
  const size = PART_MODEL_SIZE; const plane = size * size; const classes = PART_MODEL_CLASSES;
  // Averaged class probabilities on the canvas (the mirrored pass read back unmirrored, its sides swapped).
  const probability = new Float32Array(classes * plane); const exp = new Float32Array(classes);
  for (let mirror = 0; mirror < 2; mirror += 1) for (let gy = 0; gy < size; gy += 1) for (let gx = 0; gx < size; gx += 1) {
    const at = mirror * classes * plane + gy * size + gx; let max = -Infinity;
    for (let c = 0; c < classes; c += 1) max = Math.max(max, logits[at + c * plane]);
    let sum = 0; for (let c = 0; c < classes; c += 1) { exp[c] = Math.exp(logits[at + c * plane] - max); sum += exp[c]; }
    const tx = mirror ? size - 1 - gx : gx;
    for (let c = 0; c < classes; c += 1) probability[(mirror ? MIRROR[c] : c) * plane + gy * size + tx] += exp[c] / sum / 2;
  }
  const { width, height, data } = image; const labels = new Uint8Array(width * height); const confidence = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = y * width + x; if (data[index * 4 + 3] <= 16) continue;
    const cx = Math.min(size - 1, Math.max(0, Math.round(size / 2 + (x - frame.centreX) * frame.scale)));
    const cy = Math.min(size - 1, Math.max(0, Math.round(size / 2 + (y - frame.centreY) * frame.scale)));
    let best = 0; let bestP = -1; for (let c = 0; c < classes; c += 1) { const p = probability[c * plane + cy * size + cx]; if (p > bestP) { bestP = p; best = c; } }
    labels[index] = best === 15 ? PLAN_EQUIPMENT : best; confidence[index] = bestP;
  }
  return { labels, confidence };
}

export async function predictParts(image: PartModelImage, run: PartModelRunner): Promise<PartPrediction | null> {
  const prepared = preparePartModelInput(image); if (!prepared) return null;
  return decodePartModel(await run(prepared.input), prepared.frame, image);
}

/** Model classes 1..14 are PLAN_PARTS in order; kept here so a change to either is caught by the type check. */
export const PART_MODEL_PARTS: readonly string[] = PLAN_PARTS;

/**
 * The seeds a cut grows from: pixels the model is sure of (confidence ≥ `threshold`) whose four neighbours it gives the same
 * part, so the seams are left to the drawing. Equipment is kept as equipment. Background and unsure pixels are 0.
 */
export function partModelSeeds(prediction: PartPrediction, width: number, height: number, threshold = .7): Uint8Array {
  const { labels, confidence } = prediction; const seeds = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const index = y * width + x; const label = labels[index];
    if (!label || confidence[index] < threshold) continue;
    if (labels[index - 1] === label && labels[index + 1] === label && labels[index - width] === label && labels[index + width] === label) seeds[index] = label;
  }
  return seeds;
}
