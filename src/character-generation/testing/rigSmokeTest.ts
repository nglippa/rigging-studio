import type { RigDefinition } from "../../rigging/schema/types";
import { validateRigDefinition } from "../../rigging/validation/rig";
import { createRestPose, updateBonePose } from "../../rigging/runtime/pose";
import { computeWorldTransforms } from "../../rigging/runtime/worldTransforms";
import { degreesToRadians } from "../../rigging/math/rotation";

export type RigSmokeCheck = { readonly id: "schema" | "pivots" | "equipment" | "occlusion" | "joint-rotation" | "rotation-continuity"; readonly passed: boolean; readonly message: string };
export type RigSmokeTestResult = { readonly passed: boolean; readonly checks: readonly RigSmokeCheck[] };
export type RotationContinuityResult = { readonly passed: boolean; readonly maximumChildDistanceError: number; readonly maximumEquipmentDrift: number; readonly samples: number };

export function runRotationContinuitySmoke(rig: RigDefinition, angles: readonly number[] = [-30, -20, 0, 20, 30]): RotationContinuityResult {
  const targets = ["left-upper-arm", "left-lower-arm", "right-upper-arm", "right-lower-arm", "left-upper-leg", "left-lower-leg", "right-upper-leg", "right-lower-leg"].filter((id) => rig.bones.some((bone) => bone.id === id));
  const rest = createRestPose(rig); const baseline = computeWorldTransforms(rig, rest);
  let maximumChildDistanceError = 0; let maximumEquipmentDrift = 0; let samples = 0;
  targets.forEach((boneId) => {
    const children = rig.bones.filter((bone) => bone.parentId === boneId);
    const baselineBone = baseline[boneId];
    angles.forEach((angle) => {
      const pose = updateBonePose(rest, boneId, { rotation: (rest.bones[boneId]?.rotation ?? 0) + degreesToRadians(angle) });
      const world = computeWorldTransforms(rig, pose); const bone = world[boneId];
      children.forEach((child) => {
        const before = Math.hypot(baseline[child.id].x - baselineBone.x, baseline[child.id].y - baselineBone.y);
        const after = Math.hypot(world[child.id].x - bone.x, world[child.id].y - bone.y);
        maximumChildDistanceError = Math.max(maximumChildDistanceError, Math.abs(before - after)); samples += 1;
      });
      rig.slots.filter((slot) => slot.boneId === boneId && slot.attachmentId && rig.attachments.find((attachment) => attachment.id === slot.attachmentId)?.category === "equipment").forEach(() => {
        maximumEquipmentDrift = Math.max(maximumEquipmentDrift, Math.hypot(bone.x - world[boneId].x, bone.y - world[boneId].y)); samples += 1;
      });
    });
  });
  return { passed: maximumChildDistanceError <= .001 && maximumEquipmentDrift <= .001, maximumChildDistanceError, maximumEquipmentDrift, samples };
}

export function runRigSmokeTest(rig: RigDefinition): RigSmokeTestResult {
  const validation = validateRigDefinition(rig);
  const pivotFailures = rig.slots.filter((slot) => { const attachment = rig.attachments.find((item) => item.id === slot.attachmentId); return attachment && (slot.pivotX < 0 || slot.pivotY < 0 || slot.pivotX > attachment.width || slot.pivotY > attachment.height); });
  const equipment = rig.slots.filter((slot) => rig.attachments.find((attachment) => attachment.id === slot.attachmentId)?.category === "equipment");
  const majorJoints = ["left-upper-arm", "right-upper-arm", "left-upper-leg", "right-upper-leg"].filter((id) => rig.bones.some((bone) => bone.id === id));
  const occlusionWarnings = Array.isArray(rig.metadata.occlusionWarnings) ? rig.metadata.occlusionWarnings.length : 0;
  const continuity = runRotationContinuitySmoke(rig);
  const checks: RigSmokeCheck[] = [
    { id: "schema", passed: validation.length === 0, message: validation.length ? validation.map((issue) => issue.message).join("; ") : "Rig schema and hierarchy are valid" },
    { id: "pivots", passed: pivotFailures.length === 0, message: pivotFailures.length ? `${pivotFailures.length} pivot(s) leave attachment bounds` : "Attachment pivots are inside their images" },
    { id: "equipment", passed: equipment.length > 0, message: equipment.length ? `${equipment.length} modular equipment slot(s) found` : "No modular equipment slot was detected" },
    { id: "occlusion", passed: occlusionWarnings === 0, message: occlusionWarnings ? `${occlusionWarnings} occlusion warning(s) remain` : "No unresolved occlusion metadata" },
    { id: "joint-rotation", passed: majorJoints.length === 4, message: majorJoints.length === 4 ? "Major joints are available for ±20° rotation checks" : "Some major joints are missing" },
    { id: "rotation-continuity", passed: continuity.passed, message: continuity.passed ? `Child and equipment anchors remained continuous across ${continuity.samples} samples` : `Rotation discontinuity: child ${continuity.maximumChildDistanceError.toFixed(3)}px, equipment ${continuity.maximumEquipmentDrift.toFixed(3)}px` },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}
