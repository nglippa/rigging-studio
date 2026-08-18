import type { BoneDefinition } from "../../rigging/schema/types";
import type { Point, ProposedCharacterPart } from "../segmentation/segmentationSchema";
import { estimatePartPivot } from "./pivotEstimator";

export type ProposedHierarchy = { readonly bones: readonly BoneDefinition[]; readonly confidence: Readonly<Record<string, number>>; readonly worldJoints: Readonly<Record<string, Point>> };

const partFor = (parts: readonly ProposedCharacterPart[], semanticType: ProposedCharacterPart["semanticType"]): ProposedCharacterPart | undefined => parts.find((part) => part.accepted && part.semanticType === semanticType);
const joint = (parts: readonly ProposedCharacterPart[], type: ProposedCharacterPart["semanticType"], fallback: Point): Point => {
  const part = partFor(parts, type); return part ? estimatePartPivot(part).point : fallback;
};
const bone = (id: string, parentId: string | null, point: Point, parentPoint: Point | null, rotation: number, length: number): BoneDefinition => ({
  id, parentId, x: parentPoint ? point.x - parentPoint.x : point.x, y: parentPoint ? point.y - parentPoint.y : point.y,
  rotation, scaleX: 1, scaleY: 1, length: Math.max(1, length), inheritRotation: true, inheritScale: true,
});

export function buildProposedHierarchy(parts: readonly ProposedCharacterPart[], width: number, height: number): ProposedHierarchy {
  const root = { x: width / 2, y: height * .6 };
  const pelvis = { x: root.x, y: root.y };
  const torso = joint(parts, "torso", { x: root.x, y: root.y - height * .18 });
  const head = joint(parts, "head", { x: root.x, y: torso.y - height * .25 });
  const lu = joint(parts, "leftUpperArm", { x: torso.x - width * .15, y: torso.y - height * .2 });
  const lf = joint(parts, "leftForearm", { x: lu.x, y: lu.y + height * .18 });
  const lh = joint(parts, "leftHand", { x: lf.x, y: lf.y + height * .18 });
  const ru = joint(parts, "rightUpperArm", { x: torso.x + width * .15, y: torso.y - height * .2 });
  const rf = joint(parts, "rightForearm", { x: ru.x, y: ru.y + height * .18 });
  const rh = joint(parts, "rightHand", { x: rf.x, y: rf.y + height * .18 });
  const lt = joint(parts, "leftThigh", { x: pelvis.x - width * .08, y: pelvis.y });
  const ll = joint(parts, "leftLowerLeg", { x: lt.x, y: lt.y + height * .18 });
  const lfoot = joint(parts, "leftFoot", { x: ll.x, y: ll.y + height * .18 });
  const rt = joint(parts, "rightThigh", { x: pelvis.x + width * .08, y: pelvis.y });
  const rl = joint(parts, "rightLowerLeg", { x: rt.x, y: rt.y + height * .18 });
  const rfoot = joint(parts, "rightFoot", { x: rl.x, y: rl.y + height * .18 });
  const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
  const bones = [
    bone("root", null, root, null, 0, 24), bone("pelvis", "root", pelvis, root, 0, Math.max(20, distance(pelvis, torso))),
    bone("torso", "pelvis", torso, pelvis, 0, distance(torso, head)), bone("head", "torso", head, torso, 0, 34),
    bone("left-upper-arm", "torso", lu, torso, 90, distance(lu, lf)), bone("left-lower-arm", "left-upper-arm", { x: distance(lu, lf), y: 0 }, { x: 0, y: 0 }, 0, distance(lf, lh)), bone("left-hand", "left-lower-arm", { x: distance(lf, lh), y: 0 }, { x: 0, y: 0 }, 0, 22),
    bone("right-upper-arm", "torso", ru, torso, 90, distance(ru, rf)), bone("right-lower-arm", "right-upper-arm", { x: distance(ru, rf), y: 0 }, { x: 0, y: 0 }, 0, distance(rf, rh)), bone("right-hand", "right-lower-arm", { x: distance(rf, rh), y: 0 }, { x: 0, y: 0 }, 0, 22),
    bone("left-upper-leg", "pelvis", lt, pelvis, 90, distance(lt, ll)), bone("left-lower-leg", "left-upper-leg", { x: distance(lt, ll), y: 0 }, { x: 0, y: 0 }, 0, distance(ll, lfoot)), bone("left-foot", "left-lower-leg", { x: distance(ll, lfoot), y: 0 }, { x: 0, y: 0 }, -90, 38),
    bone("right-upper-leg", "pelvis", rt, pelvis, 90, distance(rt, rl)), bone("right-lower-leg", "right-upper-leg", { x: distance(rt, rl), y: 0 }, { x: 0, y: 0 }, 0, distance(rl, rfoot)), bone("right-foot", "right-lower-leg", { x: distance(rl, rfoot), y: 0 }, { x: 0, y: 0 }, -90, 38),
  ];
  const worldJoints = { root, pelvis, torso, head, "left-upper-arm": lu, "left-lower-arm": lf, "left-hand": lh, "right-upper-arm": ru, "right-lower-arm": rf, "right-hand": rh, "left-upper-leg": lt, "left-lower-leg": ll, "left-foot": lfoot, "right-upper-leg": rt, "right-lower-leg": rl, "right-foot": rfoot };
  const confidence = Object.fromEntries(bones.map((candidate) => [candidate.id, candidate.id === "root" || candidate.id === "pelvis" ? .7 : .78]));
  return { bones, confidence, worldJoints };
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
