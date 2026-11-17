import { invertMatrix, matrixFromTransform, multiplyMatrices, transformPoint, type Point } from "../../rigging/math/matrix";
import { degreesToRadians } from "../../rigging/math/rotation";
import { createRestPose } from "../../rigging/runtime/pose";
import { computeWorldTransforms } from "../../rigging/runtime/worldTransforms";
import type { BoneDefinition, RigDefinition, SlotDefinition } from "../../rigging/schema/types";
import type { ValidationIssue } from "../../rigging/validation/issues";

/**
 * Rig review answers one question per joint in plain words: "will this bend the art it is supposed to?"
 * It is a presentation layer over the rig and its validator output and never mutates either.
 */
export type RigChainId = "torso" | "left-arm" | "right-arm" | "left-leg" | "right-leg" | "equipment" | "other";
export type JointProblem = "no-length" | "pivot-off-art" | "pivot-off-parent" | "guessed" | "invalid";
export type JointReview = {
  readonly boneId: string;
  /** Anatomical joint name when the bone id implies one (Shoulder, Elbow, Knee), otherwise null. */
  readonly joint: string | null;
  readonly problem: JointProblem | null;
  readonly reason: string | null;
};
export type ChainReview = { readonly id: RigChainId; readonly label: string; readonly joints: readonly JointReview[]; readonly ok: boolean };

const EQUIPMENT = /weapon|equipment|shield|sword|blade|staff|bow|helmet|armor|cape|tail|quiver|accessory/i;
const LEFT = /(^|[-_ ])l(eft)?([-_ ]|$)/i;
const CHAIN_ORDER: readonly RigChainId[] = ["torso", "left-arm", "right-arm", "left-leg", "right-leg", "equipment", "other"];
const CHAIN_LABELS: Readonly<Record<RigChainId, string>> = { torso: "Torso", "left-arm": "Left arm", "right-arm": "Right arm", "left-leg": "Left leg", "right-leg": "Right leg", equipment: "Equipment", other: "Other" };

export const isEquipmentId = (id: string): boolean => EQUIPMENT.test(id);

export function chainForBone(boneId: string): RigChainId {
  if (EQUIPMENT.test(boneId)) return "equipment";
  const left = LEFT.test(boneId);
  if (/arm|hand|wrist|elbow|shoulder/i.test(boneId)) return left ? "left-arm" : "right-arm";
  if (/leg|foot|ankle|knee|thigh|shin/i.test(boneId)) return left ? "left-leg" : "right-leg";
  if (/root|torso|chest|spine|waist|hip|pelvis|head|neck|face|hair/i.test(boneId)) return "torso";
  return "other";
}

export function jointName(boneId: string): string | null {
  const id = boneId.toLowerCase();
  if (/hand|wrist/.test(id)) return "Wrist";
  if (/lower[-_ ]?arm|forearm|elbow/.test(id)) return "Elbow";
  if (/upper[-_ ]?arm|shoulder/.test(id)) return "Shoulder";
  if (/foot|ankle/.test(id)) return "Ankle";
  if (/lower[-_ ]?leg|shin|knee/.test(id)) return "Knee";
  if (/upper[-_ ]?leg|thigh/.test(id)) return "Hip";
  if (/head/.test(id)) return "Head";
  if (/neck/.test(id)) return "Neck";
  if (/pelvis|hip/.test(id)) return "Pelvis";
  if (/torso|chest|spine|waist/.test(id)) return "Waist";
  return null;
}

/** Slots whose art rides on this bone, i.e. the parts the bone controls. */
export const partsForBone = (rig: RigDefinition, boneId: string): readonly SlotDefinition[] => rig.slots.filter((slot) => slot.boneId === boneId);

/** The art a slot shows in a skin, falling back to the slot's own default. */
export function attachmentIdForSlot(rig: RigDefinition, slot: SlotDefinition, skinId = rig.defaultSkinId): string | null {
  const skin = rig.skins.find((candidate) => candidate.id === skinId);
  const assigned = skin?.slotAttachments[slot.id];
  return assigned === undefined ? slot.attachmentId : assigned;
}

type WorldTransforms = ReturnType<typeof computeWorldTransforms>;

/** True when a world-space point lies on or near art carried by the given bone; null when that bone carries no art. */
function pointTouchesArt(rig: RigDefinition, world: WorldTransforms, artBoneId: string, point: Point, skinId: string): boolean | null {
  const bone = world[artBoneId];
  if (!bone) return null;
  let sawArt = false;
  for (const slot of partsForBone(rig, artBoneId)) {
    const attachment = rig.attachments.find((candidate) => candidate.id === attachmentIdForSlot(rig, slot, skinId));
    if (!attachment || slot.visible === false) continue;
    sawArt = true;
    const inverse = invertMatrix(multiplyMatrices(bone.matrix, matrixFromTransform({ x: attachment.offsetX, y: attachment.offsetY, rotation: degreesToRadians(attachment.rotation), scaleX: attachment.scaleX, scaleY: attachment.scaleY })));
    if (!inverse) continue;
    const local = transformPoint(inverse, point);
    const margin = Math.max(6, Math.min(attachment.width, attachment.height) * 0.25);
    if (local.x >= -slot.pivotX - margin && local.x <= attachment.width - slot.pivotX + margin && local.y >= -slot.pivotY - margin && local.y <= attachment.height - slot.pivotY + margin) return true;
  }
  return sawArt ? false : null;
}

/** The nearest ancestor that carries art: the part this bone's part is jointed to. */
function artParent(rig: RigDefinition, bone: BoneDefinition, skinId: string): BoneDefinition | null {
  const seen = new Set<string>([bone.id]);
  let cursor = bone.parentId ? rig.bones.find((candidate) => candidate.id === bone.parentId) ?? null : null;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const current = cursor;
    if (partsForBone(rig, current.id).some((slot) => slot.visible !== false && attachmentIdForSlot(rig, slot, skinId))) return current;
    cursor = current.parentId ? rig.bones.find((candidate) => candidate.id === current.parentId) ?? null : null;
  }
  return null;
}

/**
 * The child a bone is drawn toward. A limb continues along its own chain (shoulder → elbow → wrist);
 * the spine continues upward (pelvis → torso → neck → head). Null for a bone with no children.
 */
export function primaryChildId(rig: RigDefinition, boneId: string): string | null {
  const children = rig.bones.filter((bone) => bone.parentId === boneId && bone.id !== boneId);
  if (!children.length) return null;
  const chain = chainForBone(boneId);
  return (children.find((child) => chainForBone(child.id) === chain) ?? children[0]).id;
}

/**
 * Where a bone is drawn to, in world space: its primary child's joint, or for an end bone the far side of the art it carries.
 * Falls back to the bone's own axis and length. Generated rigs keep every bone at zero rest rotation, so the axis alone
 * would draw every bone pointing right; drawing joint to joint shows the skeleton that is actually there.
 */
export function boneDisplayEnd(rig: RigDefinition, world: WorldTransforms, bone: BoneDefinition, skinId = rig.defaultSkinId): Point {
  const transform = world[bone.id];
  const axisEnd = transformPoint(transform.matrix, { x: bone.length, y: 0 });
  const childId = primaryChildId(rig, bone.id);
  const child = childId ? world[childId] : undefined;
  if (child) return Math.hypot(child.x - transform.x, child.y - transform.y) >= 1 ? { x: child.x, y: child.y } : { x: transform.x, y: transform.y };
  for (const slot of partsForBone(rig, bone.id)) {
    const attachment = rig.attachments.find((candidate) => candidate.id === attachmentIdForSlot(rig, slot, skinId));
    if (!attachment || slot.visible === false) continue;
    const centre = transformPoint(multiplyMatrices(transform.matrix, matrixFromTransform({ x: attachment.offsetX, y: attachment.offsetY, rotation: degreesToRadians(attachment.rotation), scaleX: attachment.scaleX, scaleY: attachment.scaleY })), { x: attachment.width / 2 - slot.pivotX, y: attachment.height / 2 - slot.pivotY });
    const reach = Math.hypot(centre.x - transform.x, centre.y - transform.y);
    if (reach >= 2) return { x: transform.x + (centre.x - transform.x) * 1.5, y: transform.y + (centre.y - transform.y) * 1.5 };
  }
  return axisEnd;
}

const partLabel = (rig: RigDefinition, boneId: string): string => {
  const slot = partsForBone(rig, boneId)[0];
  return (slot ? slot.id.replace(/-slot$/, "") : boneId).replace(/[-_]+/g, " ");
};

export function reviewJoint(rig: RigDefinition, bone: BoneDefinition, issues: readonly ValidationIssue[] = [], skinId = rig.defaultSkinId, world: WorldTransforms = computeWorldTransforms(rig, createRestPose(rig))): JointReview {
  const joint = jointName(bone.id);
  const subject = joint ?? "This bone";
  const index = rig.bones.indexOf(bone);
  const invalid = issues.find((issue) => issue.severity !== "warning" && (issue.objectId === bone.id || (issue.path[0] === "bones" && issue.path[1] === index)));
  if (invalid) return { boneId: bone.id, joint, problem: "invalid", reason: invalid.message };
  const origin = world[bone.id];
  const touches = origin ? pointTouchesArt(rig, world, bone.id, { x: origin.x, y: origin.y }, skinId) : null;
  // A bone with no art is legitimate (hands that only carry a weapon, helper bones); the tree and inspector say so without flagging it.
  if (touches !== null && bone.length < 1 && bone.id !== rig.rootBoneId) return { boneId: bone.id, joint, problem: "no-length", reason: `${subject} has no length, so it cannot be aimed` };
  if (touches === false) return { boneId: bone.id, joint, problem: "pivot-off-art", reason: `${subject} pivot sits away from its art` };
  // A joint is where two parts meet. If the pivot is on this part but nowhere near the part it hangs from, bending it tears the two apart.
  const parent = touches === true ? artParent(rig, bone, skinId) : null;
  if (parent && origin && pointTouchesArt(rig, world, parent.id, { x: origin.x, y: origin.y }, skinId) === false) return { boneId: bone.id, joint, problem: "pivot-off-parent", reason: `${subject} pivot is not where the ${partLabel(rig, bone.id)} meets the ${partLabel(rig, parent.id)}` };
  // The builder records how it found each joint. A position it could only guess is worth a look before animating.
  const sources = rig.metadata.pivotSources as Record<string, { readonly source?: string; readonly confidence?: number }> | undefined;
  const overridden = Boolean((rig.metadata.manualOverrides as { readonly bones?: Record<string, unknown> } | undefined)?.bones?.[bone.id]);
  const found = sources?.[bone.id];
  if (touches === true && found && !overridden && (found.source === "fallback" || (found.confidence ?? 1) <= .5)) return { boneId: bone.id, joint, problem: "guessed", reason: `${subject} position was estimated. Drag it onto the real joint` };
  return { boneId: bone.id, joint, problem: null, reason: null };
}

/** Chains in reading order, each with its joints from parent to child. Empty chains are omitted. */
export function reviewRig(rig: RigDefinition, issues: readonly ValidationIssue[] = [], skinId = rig.defaultSkinId): readonly ChainReview[] {
  const depth = new Map<string, number>();
  const depthOf = (bone: BoneDefinition): number => {
    const known = depth.get(bone.id); if (known !== undefined) return known;
    const parent = bone.parentId ? rig.bones.find((candidate) => candidate.id === bone.parentId) : null;
    const value = parent && parent.id !== bone.id ? depthOf(parent) + 1 : 0;
    depth.set(bone.id, value); return value;
  };
  const world = computeWorldTransforms(rig, createRestPose(rig));
  return CHAIN_ORDER.flatMap((id) => {
    const bones = rig.bones.filter((bone) => chainForBone(bone.id) === id).sort((a, b) => depthOf(a) - depthOf(b));
    if (!bones.length) return [];
    const joints = bones.map((bone) => reviewJoint(rig, bone, issues, skinId, world));
    return [{ id, label: CHAIN_LABELS[id], joints, ok: joints.every((joint) => joint.problem === null) }];
  });
}

/** Bones in true parent/child order with their depth, for drawing the skeleton as a tree. */
export function skeletonRows(rig: RigDefinition): readonly { readonly bone: BoneDefinition; readonly depth: number }[] {
  const rows: { bone: BoneDefinition; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (bone: BoneDefinition, depth: number): void => {
    if (seen.has(bone.id)) return;
    seen.add(bone.id); rows.push({ bone, depth });
    rig.bones.filter((candidate) => candidate.parentId === bone.id).forEach((child) => visit(child, depth + 1));
  };
  rig.bones.filter((bone) => bone.parentId === null || !rig.bones.some((candidate) => candidate.id === bone.parentId)).forEach((bone) => visit(bone, 0));
  rig.bones.forEach((bone) => visit(bone, 0));
  return rows;
}
