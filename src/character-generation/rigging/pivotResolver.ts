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

/**
 * Where two parts that do not touch come closest: the pixel of `childPartId` nearest to `parentPartId`, when it lies within
 * `maxDistance`. Parts drawn with something between them (a sword across the hip) have no shared edge but are still jointed there.
 */
export function nearestApproach(state: PartCutterState, childPartId: string, parentPartId: string, maxDistance: number): Point | null {
  const partition = state.ownership; if (!partition) return null;
  const child = partition.regionIds.indexOf(childPartId) + 1; const parent = partition.regionIds.indexOf(parentPartId) + 1;
  if (child <= 0 || parent <= 0) return null;
  const { width, height } = partition; const labels = decodeOwnership(partition);
  const distance = new Int32Array(width * height).fill(-1); let frontier: number[] = [];
  for (let index = 0; index < labels.length; index += 1) if (labels[index] === parent) { distance[index] = 0; frontier.push(index); }
  for (let step = 1; step <= maxDistance && frontier.length; step += 1) {
    const next: number[] = []; let xTotal = 0; let yTotal = 0; let count = 0;
    for (const index of frontier) {
      const x = index % width;
      for (const neighbour of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, index - width, index + width]) {
        if (neighbour < 0 || neighbour >= labels.length || distance[neighbour] >= 0) continue;
        distance[neighbour] = step;
        if (labels[neighbour] === child) { xTotal += neighbour % width + .5; yTotal += Math.floor(neighbour / width) + .5; count += 1; } else next.push(neighbour);
      }
    }
    if (count) return { x: xTotal / count, y: yTotal / count };
    frontier = next;
  }
  return null;
}

/** The nearest part up the body chain that was actually cut: a forearm whose upper arm is hidden hangs from the torso. */
function presentParent(part: ProposedCharacterPart, parts: readonly ProposedCharacterPart[]): ProposedCharacterPart | undefined {
  const seen = new Set<string>([part.semanticType]);
  for (let semantic = PART_RIGGING_SPECS[part.semanticType].adjacentSemantic; semantic && !seen.has(semantic); semantic = PART_RIGGING_SPECS[semantic].adjacentSemantic) {
    seen.add(semantic);
    const found = parts.find((candidate) => candidate.accepted && candidate.semanticType === semantic);
    if (found) return found;
  }
  return undefined;
}

/** The joint between a part and the part it hangs from: their shared edge, or where they come closest when something lies between them. */
function jointBetween(state: PartCutterState, partId: string, parentId: string): { readonly point: Point; readonly touching: boolean } | null {
  const shared = sharedBoundaryCentroid(state, partId, parentId);
  if (shared) return { point: shared, touching: true };
  const reach = Math.max(4, Math.round(Math.hypot(state.sourceCanvasSize.width, state.sourceCanvasSize.height) * .08));
  const near = nearestApproach(state, partId, parentId, reach);
  return near ? { point: near, touching: false } : null;
}

export function resolvePartPivot(part: ProposedCharacterPart, parts: readonly ProposedCharacterPart[], state?: PartCutterState): ResolvedPivot {
  const prepared = state?.parts.find((candidate) => candidate.partId === part.id);
  // A hand-cut part starts with a pivot guessed from its outline. Only a pivot someone deliberately placed is authoritative;
  // a guess gives way to the seam where the part meets its parent, which is where the joint really is. (Comparing the pivot
  // with a fresh guess does not work: carving and joining stray artwork change the outline, so an old guess looks "moved".)
  const userPlaced = prepared?.pivotSetByUser === true;
  if (prepared && userPlaced) return { point: clampPointToBounds(prepared.pivot, part.bounds), source: "manual", confidence: 1, detail: `Prepare pivot ${part.id}` };
  const spec = PART_RIGGING_SPECS[part.semanticType];
  const adjacent = presentParent(part, parts);
  const joint = adjacent && state ? jointBetween(state, part.id, adjacent.id) : null;
  const seam = joint?.point ?? null;
  const handCut = prepared?.provenance === "manual";
  if (handCut && joint) return { point: joint.point, source: "boundary", confidence: joint.touching ? .8 : .7, detail: `${adjacent!.id}${joint.touching ? "↔" : "⋯"}${part.id}` };
  if (handCut && part.semanticType === "torso" && state) {
    // The torso bends at the waist, so it pivots where it meets the legs, not at the chest.
    // Where the torso meets each thigh, or comes closest to it when a weapon or belt piece was cut out between them.
    const hips = parts.filter((candidate) => candidate.accepted && (candidate.semanticType === "leftThigh" || candidate.semanticType === "rightThigh")).map((thigh) => jointBetween(state, part.id, thigh.id)?.point ?? null).filter((point): point is Point => point !== null);
    if (hips.length) return { point: { x: hips.reduce((sum, point) => sum + point.x, 0) / hips.length, y: hips.reduce((sum, point) => sum + point.y, 0) / hips.length }, source: "boundary", confidence: .76, detail: `${part.id}↔hips` };
    return { point: { x: part.bounds.x + part.bounds.width / 2, y: part.bounds.y + part.bounds.height * .9 }, source: "geometry", confidence: .55, detail: "torso waist estimate" };
  }
  const landmark = spec.pivotLandmark ? state?.anatomicalGuide?.landmarks.find((candidate) => candidate.landmarkId === spec.pivotLandmark) : undefined;
  // A landmark with no method comes from the fixed body template, not from this character. It says nothing about a part the user cut by hand.
  if (landmark && (!handCut || landmark.method)) return { point: spec.bindingKind === "equipment" ? clampPointToBounds(landmark.point, part.bounds) : landmark.point, source: "landmark", confidence: landmark.confidence ?? .82, detail: landmark.landmarkId };
  const boundary = seam;
  if (boundary) return { point: boundary, source: "boundary", confidence: .76, detail: `${adjacent!.id}↔${part.id}` };
  if (handCut && prepared) return { point: clampPointToBounds(prepared.pivot, part.bounds), source: "geometry", confidence: .5, detail: `Estimated from the shape of ${part.id}` };
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
