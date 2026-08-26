import type { Point } from "../character-generation/segmentation/segmentationSchema";

export type CandidateTruthMetrics = { readonly iou: number; readonly precision: number; readonly recall: number; readonly foreignPixelContamination: number; readonly centroidError: number; readonly jointAnchorContainment: boolean; readonly usable: boolean };
const count = (values: readonly number[]): number => values.reduce((total, value) => total + (value > 0 ? 1 : 0), 0);
const centroid = (values: readonly number[], width: number): Point | null => { let x = 0; let y = 0; let pixels = 0; values.forEach((value, index) => { if (!value) return; x += index % width; y += Math.floor(index / width); pixels += 1; }); return pixels ? { x: x / pixels, y: y / pixels } : null; };

export function compareCandidateToTruth(candidate: readonly number[], truth: readonly number[], width: number, anchors: readonly Point[], thresholds: { readonly minimumIou?: number; readonly minimumPrecision?: number; readonly minimumRecall?: number; readonly maximumCentroidError?: number } = {}): CandidateTruthMetrics {
  if (candidate.length !== truth.length || candidate.length % width !== 0) throw new Error("Candidate and truth dimensions must match");
  let intersection = 0; let union = 0; let foreign = 0; candidate.forEach((value, index) => { const selected = value > 0; const expected = (truth[index] ?? 0) > 0; if (selected && expected) intersection += 1; if (selected || expected) union += 1; if (selected && !expected) foreign += 1; });
  const selected = count(candidate); const expected = count(truth); const candidateCenter = centroid(candidate, width); const truthCenter = centroid(truth, width); const centroidError = candidateCenter && truthCenter ? Math.hypot(candidateCenter.x - truthCenter.x, candidateCenter.y - truthCenter.y) : Number.POSITIVE_INFINITY;
  const jointAnchorContainment = anchors.every((anchor) => { const radius = 2; for (let y = Math.floor(anchor.y - radius); y <= Math.ceil(anchor.y + radius); y += 1) for (let x = Math.floor(anchor.x - radius); x <= Math.ceil(anchor.x + radius); x += 1) if (x >= 0 && y >= 0 && x < width && y * width + x < candidate.length && candidate[y * width + x] > 0) return true; return false; });
  const iou = intersection / Math.max(1, union); const precision = intersection / Math.max(1, selected); const recall = intersection / Math.max(1, expected); const contamination = foreign / Math.max(1, selected);
  const usable = iou >= (thresholds.minimumIou ?? .6) && precision >= (thresholds.minimumPrecision ?? .8) && recall >= (thresholds.minimumRecall ?? .65) && centroidError <= (thresholds.maximumCentroidError ?? 6) && jointAnchorContainment;
  return { iou, precision, recall, foreignPixelContamination: contamination, centroidError, jointAnchorContainment, usable };
}
