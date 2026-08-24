import type { Point, ProposedCharacterPart } from "../segmentation/segmentationSchema";
import { PART_RIGGING_SPECS } from "../segmentation/partTaxonomy";
import { decodeOwnership } from "../../part-cutter/ownership";
import type { PartCutterState } from "../../part-cutter/schema";
import { clampPointToBounds } from "./pivotEstimator";

export type AutoRigPivotSource = "manual" | "landmark" | "boundary" | "geometry" | "fallback";
export type ResolvedPivot = { readonly point: Point; readonly source: AutoRigPivotSource; readonly confidence: number; readonly detail: string };

const midpoint = (left: Point, right: Point, ratio = .5): Point => ({ x: left.x + (right.x - left.x) * ratio, y: left.y + (right.y - left.y) * ratio });
const center = (part: ProposedCharacterPart): Point => ({ x: part.bounds.x + part.bounds.width / 2, y: part.bounds.y + part.bounds.height / 2 });

export function sharedBoundaryCentroid(state: PartCutterState, firstPartId: string, secondPartId: string): Point | null {
  const partition = state.ownership;
  if (!partition) return null;
  const first = partition.regionIds.indexOf(firstPartId) + 1;
  const second = partition.regionIds.indexOf(secondPartId) + 1;
  if (first <= 0 || second <= 0) return null;
  const labels = decodeOwnership(partition);
  let xTotal = 0; let yTotal = 0; let count = 0;
  const add = (x: number, y: number, a: number, b: number, horizontal: boolean): void => {
    if (!((a === first && b === second) || (a === second && b === first))) return;
    xTotal += x + (horizontal ? .5 : 0); yTotal += y + (horizontal ? 0 : .5); count += 1;
  };
  for (let y = 0; y < partition.height; y += 1) for (let x = 0; x < partition.width; x += 1) {
    const index = y * partition.width + x;
    if (x + 1 < partition.width) add(x, y, labels[index], labels[index + 1], true);
    if (y + 1 < partition.height) add(x, y, labels[index], labels[index + partition.width], false);
  }
  return count ? { x: xTotal / count, y: yTotal / count } : null;
}

export function resolvePartPivot(part: ProposedCharacterPart, parts: readonly ProposedCharacterPart[], state?: PartCutterState): ResolvedPivot {
  const prepared = state?.parts.find((candidate) => candidate.partId === part.id);
  if (prepared?.provenance === "manual") return { point: clampPointToBounds(prepared.pivot, part.bounds), source: "manual", confidence: 1, detail: `Prepare pivot ${part.id}` };
  const spec = PART_RIGGING_SPECS[part.semanticType];
  const landmark = spec.pivotLandmark ? state?.anatomicalGuide?.landmarks.find((candidate) => candidate.landmarkId === spec.pivotLandmark) : undefined;
  if (landmark) return { point: spec.bindingKind === "equipment" ? clampPointToBounds(landmark.point, part.bounds) : landmark.point, source: "landmark", confidence: landmark.confidence ?? .82, detail: landmark.landmarkId };
  const adjacent = spec.adjacentSemantic ? parts.find((candidate) => candidate.accepted && candidate.semanticType === spec.adjacentSemantic) : undefined;
  const boundary = adjacent && state ? sharedBoundaryCentroid(state, part.id, adjacent.id) : null;
  if (boundary) return { point: boundary, source: "boundary", confidence: .76, detail: `${adjacent!.id}↔${part.id}` };
  if (spec.bindingKind === "equipment" && adjacent) {
    const support = Number.isFinite(adjacent.pivotHint.x) && Number.isFinite(adjacent.pivotHint.y) ? adjacent.pivotHint : center(adjacent);
    const principalAxis = part.bounds.width >= part.bounds.height ? "horizontal" : "vertical";
    return { point: clampPointToBounds(support, part.bounds), source: "geometry", confidence: .62, detail: `${adjacent.id} proximity + ${principalAxis} equipment axis` };
  }
  if (Number.isFinite(part.pivotHint.x) && Number.isFinite(part.pivotHint.y)) return { point: clampPointToBounds(part.pivotHint, part.bounds), source: "geometry", confidence: Math.max(.45, part.confidence ?? .55), detail: "attachment geometry" };
  return { point: center(part), source: "fallback", confidence: .35, detail: "part center topology prior" };
}

export function inferredJoint(point: Point, source: AutoRigPivotSource, detail: string, confidence = .55): ResolvedPivot {
  return { point, source, confidence, detail };
}

export { midpoint };
