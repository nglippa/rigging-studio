import type { SegmentationMask } from "../character-generation/segmentation/segmentationSchema";
import type { AnatomicalPartitionGuide, AnatomicalZone, OwnershipPartition } from "./schema";
import { decodeOwnership } from "./ownership";

export const REGION_READINESS = ["READY", "MINOR FIX", "MAJOR FIX", "UNUSABLE"] as const;
export type RegionReadiness = (typeof REGION_READINESS)[number];
export const MANUAL_CORRECTION_TOOLS = ["region-selection", "boundary-drag", "landmark-move", "semantic-relabel", "split", "merge", "brush", "lasso", "polygon", "tool-change"] as const;
export type ManualCorrectionTool = (typeof MANUAL_CORRECTION_TOOLS)[number];
export type ManualCorrectionAction = {
  readonly tool: ManualCorrectionTool;
  readonly significance: "minor" | "significant";
  readonly regionIds: readonly string[];
  readonly changedPixels: number;
  readonly elapsedMs: number;
  readonly detail?: string;
};
export type ManualCorrectionCost = {
  readonly regionSelections: number;
  readonly boundaryDrags: number;
  readonly landmarkMoves: number;
  readonly semanticRelabels: number;
  readonly splitOperations: number;
  readonly mergeOperations: number;
  readonly brushStrokes: number;
  readonly lassoOperations: number;
  readonly polygonOperations: number;
  readonly toolChanges: number;
  readonly significantCorrections: number;
  readonly minorCorrections: number;
  readonly totalBoundaryActions: number;
  readonly fallbackPaintingUsed: boolean;
  readonly approximateCorrectionTimeMs: number;
};
export type RawZoneQuality = {
  readonly zoneId: string;
  readonly semanticType: string;
  readonly area: number;
  readonly sourceForegroundPixels: number;
  readonly sourceForegroundCoverage: number;
  readonly structuralContaminationPixels: number;
  readonly missingForegroundPixelsInsideBounds: number;
  readonly connectedComponents: number;
  readonly boundaryCompactness: number;
  readonly readiness: RegionReadiness;
};

const countComponents = (mask: readonly number[], width: number, height: number): number => {
  const seen = new Uint8Array(mask.length); let components = 0;
  const queue: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    components += 1; seen[start] = 1; queue.push(start);
    while (queue.length) {
      const index = queue.pop()!; const x = index % width; const y = Math.floor(index / width);
      const neighbors = [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1];
      for (const next of neighbors) if (next >= 0 && mask[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
    }
  }
  return components;
};

const perimeter = (mask: readonly number[], width: number, height: number): number => {
  let edges = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const x = index % width; const y = Math.floor(index / width);
    if (x === 0 || !mask[index - 1]) edges += 1;
    if (x + 1 === width || !mask[index + 1]) edges += 1;
    if (y === 0 || !mask[index - width]) edges += 1;
    if (y + 1 === height || !mask[index + width]) edges += 1;
  }
  return edges;
};

const zoneMask = (zone: AnatomicalZone): SegmentationMask => zone.mask ?? {
  width: Math.max(1, Math.round(zone.bounds.width)),
  height: Math.max(1, Math.round(zone.bounds.height)),
  alpha: new Array<number>(Math.max(1, Math.round(zone.bounds.width)) * Math.max(1, Math.round(zone.bounds.height))).fill(255),
};

export function evaluateRawAdaptiveZones(guide: AnatomicalPartitionGuide, foreground: readonly number[]): readonly RawZoneQuality[] {
  const { width, height } = guide.sourceCanvasSize; const owned = new Uint16Array(width * height);
  for (const zone of guide.zones) {
    const mask = zoneMask(zone); const left = Math.round(zone.bounds.x); const top = Math.round(zone.bounds.y);
    for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) if (mask.alpha[y * mask.width + x]) {
      const sourceX = left + x; const sourceY = top + y; if (sourceX >= 0 && sourceY >= 0 && sourceX < width && sourceY < height) owned[sourceY * width + sourceX] += 1;
    }
  }
  return guide.zones.map((zone) => {
    const mask = zoneMask(zone); const left = Math.round(zone.bounds.x); const top = Math.round(zone.bounds.y);
    let area = 0; let sourceForegroundPixels = 0; let contamination = 0; let foregroundInBounds = 0;
    for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) {
      const sourceX = left + x; const sourceY = top + y; const sourceIndex = sourceY * width + sourceX;
      if (sourceX < 0 || sourceY < 0 || sourceX >= width || sourceY >= height) continue;
      if (foreground[sourceIndex]) foregroundInBounds += 1;
      if (!mask.alpha[y * mask.width + x]) continue;
      area += 1; if (foreground[sourceIndex]) sourceForegroundPixels += 1; if (owned[sourceIndex] > 1) contamination += 1;
    }
    const connectedComponents = countComponents(mask.alpha, mask.width, mask.height);
    const boundary = perimeter(mask.alpha, mask.width, mask.height);
    const boundaryCompactness = area && boundary ? Math.min(1, 4 * Math.PI * area / (boundary * boundary)) : 0;
    const sourceForegroundCoverage = area ? sourceForegroundPixels / area : 0;
    const missingForegroundPixelsInsideBounds = Math.max(0, foregroundInBounds - sourceForegroundPixels);
    const readiness: RegionReadiness = !area || !sourceForegroundPixels ? "UNUSABLE"
      : contamination > 0 || connectedComponents > 6 || sourceForegroundCoverage < .7 ? "MAJOR FIX"
      : connectedComponents > 3 || sourceForegroundCoverage < .9 ? "MINOR FIX"
      : "READY";
    return { zoneId: zone.zoneId, semanticType: zone.semanticType, area, sourceForegroundPixels, sourceForegroundCoverage, structuralContaminationPixels: contamination, missingForegroundPixelsInsideBounds, connectedComponents, boundaryCompactness, readiness };
  });
}

export function summarizeManualCorrectionActions(actions: readonly ManualCorrectionAction[]): ManualCorrectionCost {
  const count = (tool: ManualCorrectionTool) => actions.filter((action) => action.tool === tool).length;
  const corrective = actions.filter((action) => action.tool !== "region-selection" && action.tool !== "tool-change");
  const fallbackPaintingUsed = actions.some((action) => action.tool === "brush" || action.tool === "lasso" || action.tool === "polygon");
  return {
    regionSelections: count("region-selection"),
    boundaryDrags: count("boundary-drag"),
    landmarkMoves: count("landmark-move"),
    semanticRelabels: count("semantic-relabel"),
    splitOperations: count("split"),
    mergeOperations: count("merge"),
    brushStrokes: count("brush"),
    lassoOperations: count("lasso"),
    polygonOperations: count("polygon"),
    toolChanges: count("tool-change"),
    significantCorrections: corrective.filter((action) => action.significance === "significant").length,
    minorCorrections: corrective.filter((action) => action.significance === "minor").length,
    totalBoundaryActions: actions.filter((action) => action.tool === "boundary-drag").length,
    fallbackPaintingUsed,
    approximateCorrectionTimeMs: actions.reduce((sum, action) => sum + Math.max(0, action.elapsedMs), 0),
  };
}

export function deriveOwnershipEditHeatmap(before: OwnershipPartition, after: OwnershipPartition): { readonly mask: SegmentationMask; readonly changedPixels: number; readonly changedRegionIds: readonly string[] } {
  if (before.width !== after.width || before.height !== after.height) throw new Error("Ownership heatmap requires matching canvases");
  const left = decodeOwnership(before); const right = decodeOwnership(after); const alpha = new Array<number>(left.length).fill(0); const ids = new Set<string>(); let changedPixels = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue;
    alpha[index] = 255; changedPixels += 1;
    if (left[index] > 0) ids.add(before.regionIds[left[index] - 1]!);
    if (right[index] > 0) ids.add(after.regionIds[right[index] - 1]!);
  }
  return { mask: { width: before.width, height: before.height, alpha }, changedPixels, changedRegionIds: [...ids].sort() };
}
