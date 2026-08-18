import type { RigDefinition } from "../../rigging/schema/types";
import { validateRigDefinition } from "../../rigging/validation/rig";

export type RigSmokeCheck = { readonly id: "schema" | "pivots" | "equipment" | "occlusion" | "joint-rotation"; readonly passed: boolean; readonly message: string };
export type RigSmokeTestResult = { readonly passed: boolean; readonly checks: readonly RigSmokeCheck[] };

export function runRigSmokeTest(rig: RigDefinition): RigSmokeTestResult {
  const validation = validateRigDefinition(rig);
  const pivotFailures = rig.slots.filter((slot) => { const attachment = rig.attachments.find((item) => item.id === slot.attachmentId); return attachment && (slot.pivotX < 0 || slot.pivotY < 0 || slot.pivotX > attachment.width || slot.pivotY > attachment.height); });
  const equipment = rig.slots.filter((slot) => /weapon|shield|helmet|equipment|cape|accessory/i.test(slot.id));
  const majorJoints = ["left-upper-arm", "right-upper-arm", "left-upper-leg", "right-upper-leg"].filter((id) => rig.bones.some((bone) => bone.id === id));
  const occlusionWarnings = Array.isArray(rig.metadata.occlusionWarnings) ? rig.metadata.occlusionWarnings.length : 0;
  const checks: RigSmokeCheck[] = [
    { id: "schema", passed: validation.length === 0, message: validation.length ? validation.map((issue) => issue.message).join("; ") : "Rig schema and hierarchy are valid" },
    { id: "pivots", passed: pivotFailures.length === 0, message: pivotFailures.length ? `${pivotFailures.length} pivot(s) leave attachment bounds` : "Attachment pivots are inside their images" },
    { id: "equipment", passed: equipment.length > 0, message: equipment.length ? `${equipment.length} modular equipment slot(s) found` : "No modular equipment slot was detected" },
    { id: "occlusion", passed: occlusionWarnings === 0, message: occlusionWarnings ? `${occlusionWarnings} occlusion warning(s) remain` : "No unresolved occlusion metadata" },
    { id: "joint-rotation", passed: majorJoints.length === 4, message: majorJoints.length === 4 ? "Major joints are available for ±20° rotation checks" : "Some major joints are missing" },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}
