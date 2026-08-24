import type { BoneDefinition } from "../../rigging/schema/types";
import type { PartCutterState } from "../../part-cutter/schema";
import type { Point, ProposedCharacterPart } from "../segmentation/segmentationSchema";
import { selectAutoRigTopology, topologyBones, type AutoRigTopology, type TopologySelection } from "./autoRigTopology";
import { inferredJoint, midpoint, resolvePartPivot, sharedBoundaryCentroid, type ResolvedPivot } from "./pivotResolver";

export type ProposedHierarchy = {
  readonly bones: readonly BoneDefinition[];
  readonly confidence: Readonly<Record<string, number>>;
  readonly worldJoints: Readonly<Record<string, Point>>;
  readonly pivotSources: Readonly<Record<string, ResolvedPivot>>;
  readonly topology: TopologySelection;
};

export type HierarchyBuildOptions = { readonly name?: string; readonly partCutterState?: PartCutterState; readonly topology?: AutoRigTopology };

const distance = (left: Point, right: Point): number => Math.hypot(right.x - left.x, right.y - left.y);
const average = (values: readonly Point[], fallback: Point): Point => values.length
  ? { x: values.reduce((sum, point) => sum + point.x, 0) / values.length, y: values.reduce((sum, point) => sum + point.y, 0) / values.length }
  : fallback;

const makeBone = (id: string, parentId: string | null, point: Point, parentPoint: Point | null, length: number): BoneDefinition => ({
  id, parentId, x: parentPoint ? point.x - parentPoint.x : point.x, y: parentPoint ? point.y - parentPoint.y : point.y,
  rotation: 0, scaleX: 1, scaleY: 1, length, inheritRotation: true, inheritScale: true,
});

export function buildProposedHierarchy(parts: readonly ProposedCharacterPart[], width: number, height: number, options: HierarchyBuildOptions = {}): ProposedHierarchy {
  const accepted = parts.filter((part) => part.accepted);
  const selected = options.topology
    ? { topology: options.topology, source: "prepare-metadata" as const, supported: options.topology !== "custom" }
    : selectAutoRigTopology(options.name ?? "", accepted, options.partCutterState);
  const graph = topologyBones(selected.topology);
  const pivots = new Map(accepted.map((part) => [part.semanticType, resolvePartPivot(part, accepted, options.partCutterState)]));
  const landmark = (id: string): ResolvedPivot | undefined => {
    const value = options.partCutterState?.anatomicalGuide?.landmarks.find((candidate) => candidate.landmarkId === id);
    return value ? { point: value.point, source: "landmark", confidence: value.confidence ?? .82, detail: value.landmarkId } : undefined;
  };
  const prior = (x: number, y: number, detail: string): ResolvedPivot => inferredJoint({ x: width * x, y: height * y }, "fallback", detail, .42);
  const torso = pivots.get("torso") ?? landmark("chest") ?? prior(.5, .43, "torso topology prior");
  const head = pivots.get("head") ?? landmark("head") ?? prior(.5, .22, "head topology prior");
  const hips = [pivots.get("leftThigh")?.point, pivots.get("rightThigh")?.point].filter((point): point is Point => Boolean(point));
  const pelvis = landmark("pelvis") ?? inferredJoint(average(hips, { x: torso.point.x, y: torso.point.y + height * .18 }), hips.length ? "geometry" : "fallback", hips.length ? "hip midpoint" : "pelvis topology prior", hips.length ? .72 : .45);
  const root = landmark("root") ?? inferredJoint(pelvis.point, "fallback", "root follows pelvis", .65);
  const neckBoundary = options.partCutterState ? (() => {
    const torsoPart = accepted.find((part) => part.semanticType === "torso"); const headPart = accepted.find((part) => part.semanticType === "head");
    return torsoPart && headPart ? sharedBoundaryCentroid(options.partCutterState!, torsoPart.id, headPart.id) : null;
  })() : null;
  const neck = landmark("neck") ?? (neckBoundary
    ? inferredJoint(neckBoundary, "boundary", "torso↔head", .76)
    : inferredJoint(midpoint(torso.point, head.point, .72), "geometry", "torso/head centerline", .58));
  const resolved: Record<string, ResolvedPivot> = { root, pelvis, torso, neck, head };
  graph.forEach((entry) => {
    if (resolved[entry.id]) return;
    const direct = entry.semanticType ? pivots.get(entry.semanticType) : undefined;
    const fromLandmark = entry.landmarkId ? landmark(entry.landmarkId) : undefined;
    if (direct) { resolved[entry.id] = direct; return; }
    if (fromLandmark) { resolved[entry.id] = fromLandmark; return; }
    const side = entry.id.startsWith("left-") ? -1 : 1;
    const fallbackById: Readonly<Record<string, Point>> = {
      "left-upper-arm": { x: torso.point.x - width * .15, y: torso.point.y - height * .04 }, "right-upper-arm": { x: torso.point.x + width * .15, y: torso.point.y - height * .04 },
      "left-lower-arm": { x: torso.point.x - width * .22, y: torso.point.y + height * .12 }, "right-lower-arm": { x: torso.point.x + width * .22, y: torso.point.y + height * .12 },
      "left-hand": { x: torso.point.x - width * .25, y: torso.point.y + height * .25 }, "right-hand": { x: torso.point.x + width * .25, y: torso.point.y + height * .25 },
      "left-upper-leg": { x: pelvis.point.x - width * .07, y: pelvis.point.y }, "right-upper-leg": { x: pelvis.point.x + width * .07, y: pelvis.point.y },
      "left-lower-leg": { x: pelvis.point.x - width * .08, y: pelvis.point.y + height * .18 }, "right-lower-leg": { x: pelvis.point.x + width * .08, y: pelvis.point.y + height * .18 },
      "left-foot": { x: pelvis.point.x - width * .09, y: pelvis.point.y + height * .36 }, "right-foot": { x: pelvis.point.x + width * .09, y: pelvis.point.y + height * .36 },
    };
    if (entry.id.endsWith("-hock")) {
      const lower = resolved[`${side < 0 ? "left" : "right"}-lower-leg`]?.point ?? fallbackById[`${side < 0 ? "left" : "right"}-lower-leg`];
      const foot = pivots.get(side < 0 ? "leftFoot" : "rightFoot")?.point ?? fallbackById[`${side < 0 ? "left" : "right"}-foot`];
      resolved[entry.id] = inferredJoint(midpoint(lower, foot, .64), "fallback", "digitigrade hock prior", .55);
    } else resolved[entry.id] = inferredJoint(fallbackById[entry.id] ?? { x: pelvis.point.x, y: pelvis.point.y }, "fallback", `${entry.id} topology prior`, .38);
  });

  const sourceScale = Math.max(1, Math.min(width, height));
  const localMinimum = Math.max(1, sourceScale * .004);
  const terminalLength = (id: string): number => {
    const semantic = graph.find((entry) => entry.id === id)?.semanticType;
    const part = semantic ? accepted.find((candidate) => candidate.semanticType === semantic) : undefined;
    return Math.max(localMinimum, part ? Math.min(part.bounds.width, part.bounds.height) * .32 : sourceScale * .025);
  };
  const bones = graph.map((entry) => {
    const point = resolved[entry.id].point;
    const parentPoint = entry.parentId ? resolved[entry.parentId].point : null;
    const primaryChild = graph.find((candidate) => candidate.parentId === entry.id);
    const measured = primaryChild ? distance(point, resolved[primaryChild.id].point) : terminalLength(entry.id);
    const length = Number.isFinite(measured) && measured >= localMinimum ? measured : terminalLength(entry.id);
    return makeBone(entry.id, entry.parentId, point, parentPoint, length);
  });
  return {
    bones,
    confidence: Object.fromEntries(graph.map((entry) => [entry.id, resolved[entry.id].confidence])),
    worldJoints: Object.fromEntries(graph.map((entry) => [entry.id, resolved[entry.id].point])),
    pivotSources: resolved,
    topology: selected,
  };
}

export function wouldCreateHierarchyCycle(bones: readonly BoneDefinition[], boneId: string, parentId: string | null): boolean {
  let cursor = parentId;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === boneId || visited.has(cursor)) return true;
    visited.add(cursor); cursor = bones.find((bone) => bone.id === cursor)?.parentId ?? null;
  }
  return false;
}
