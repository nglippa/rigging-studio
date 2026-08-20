import type { Point, ProposedCharacterPart, Rect } from "../segmentation/segmentationSchema";

export type PivotEstimate = { readonly point: Point; readonly confidence: number; readonly basis: string };

export function clampPointToBounds(point: Point, bounds: Rect): Point {
  return { x: Math.min(bounds.x + bounds.width, Math.max(bounds.x, point.x)), y: Math.min(bounds.y + bounds.height, Math.max(bounds.y, point.y)) };
}

export function estimatePartPivot(part: ProposedCharacterPart): PivotEstimate {
  const point = clampPointToBounds(part.pivotHint, part.bounds);
  const atEdge = point.x === part.bounds.x || point.x === part.bounds.x + part.bounds.width || point.y === part.bounds.y || point.y === part.bounds.y + part.bounds.height;
  const sourceConfidence = part.confidence ?? .5;
  return { point, confidence: Math.max(.25, Math.min(.95, sourceConfidence - (atEdge ? .15 : 0))), basis: part.pivotHint === point ? "provider pivot hint" : "provider hint clamped to part bounds" };
}

export function localPivot(point: Point, bounds: Rect, attachmentWidth = bounds.width, attachmentHeight = bounds.height): Point {
  return {
    x: (point.x - bounds.x) / bounds.width * attachmentWidth,
    y: (point.y - bounds.y) / bounds.height * attachmentHeight,
  };
}
