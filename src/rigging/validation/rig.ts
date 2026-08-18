import type { RigDefinition } from "../schema/types";
import { validateBoneHierarchy } from "./hierarchy";
import type { ValidationIssue } from "./issues";

const duplicateIssues = (values: readonly { readonly id: string }[], collection: "slots" | "attachments" | "skins"): ValidationIssue[] => {
  const seen = new Map<string, number>();
  const issues: ValidationIssue[] = [];
  values.forEach((value, index) => {
    const first = seen.get(value.id);
    if (first === undefined) seen.set(value.id, index);
    else issues.push({ code: `duplicate_${collection.slice(0, -1)}_id`, path: [collection, index, "id"], message: `ID "${value.id}" duplicates ${collection}[${first}]` });
  });
  return issues;
};

export function validateRigDefinition(rig: RigDefinition): ValidationIssue[] {
  const issues = validateBoneHierarchy(rig);
  issues.push(...duplicateIssues(rig.slots, "slots"), ...duplicateIssues(rig.attachments, "attachments"), ...duplicateIssues(rig.skins, "skins"));
  const boneIds = new Set(rig.bones.map((bone) => bone.id));
  const slotIds = new Set(rig.slots.map((slot) => slot.id));
  const attachmentIds = new Set(rig.attachments.map((attachment) => attachment.id));
  const skinIds = new Set(rig.skins.map((skin) => skin.id));
  rig.slots.forEach((slot, index) => {
    if (!boneIds.has(slot.boneId)) issues.push({ code: "missing_slot_bone", path: ["slots", index, "boneId"], message: `Slot references missing bone "${slot.boneId}"`, severity: "error", objectId: slot.id, mode: "setup", suggestedAction: "Choose an existing target bone for this slot." });
    if (slot.attachmentId !== null && !attachmentIds.has(slot.attachmentId)) issues.push({ code: "missing_slot_attachment", path: ["slots", index, "attachmentId"], message: `Slot references missing attachment "${slot.attachmentId}"`, severity: "error", objectId: slot.id, mode: "setup", suggestedAction: "Choose an existing attachment or clear the slot." });
  });
  rig.skins.forEach((skin, skinIndex) => Object.entries(skin.slotAttachments).forEach(([slotId, attachmentId]) => {
    if (!slotIds.has(slotId)) issues.push({ code: "missing_skin_slot", path: ["skins", skinIndex, "slotAttachments", slotId], message: `Skin references missing slot "${slotId}"` });
    if (attachmentId !== null && !attachmentIds.has(attachmentId)) issues.push({ code: "missing_skin_attachment", path: ["skins", skinIndex, "slotAttachments", slotId], message: `Skin references missing attachment "${attachmentId}"` });
  }));
  if (!skinIds.has(rig.defaultSkinId)) issues.push({ code: "missing_default_skin", path: ["defaultSkinId"], message: `Default skin "${rig.defaultSkinId}" does not exist` });

  const explicitProfile = rig.metadata.anatomyProfile;
  const looksHumanoid = ["head", "torso", "left-upper-arm", "right-upper-arm", "left-upper-leg", "right-upper-leg"].every((token) => rig.bones.some((bone) => bone.id.toLowerCase().includes(token)));
  const semanticProfile = explicitProfile === "humanoid" || explicitProfile === "digitigrade" || (explicitProfile === undefined && looksHumanoid);
  if (semanticProfile) {
    rig.bones.forEach((bone, index) => {
      if (bone.id !== rig.rootBoneId && bone.length < .001) issues.push({ code: "zero_length_articulated_bone", path: ["bones", index, "length"], message: `Bone "${bone.id}" has zero effective length.`, severity: "error", objectId: bone.id, mode: "setup", suggestedAction: "Set a meaningful positive length or remove the unused bone." });
    });
    const requiredVisuals = ["head", "torso", "left-upper-arm", "left-lower-arm", "left-hand", "right-upper-arm", "right-lower-arm", "right-hand", "left-upper-leg", "left-lower-leg", "left-foot", "right-upper-leg", "right-lower-leg", "right-foot"];
    const normalized = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const visualAliases: Readonly<Record<string, readonly string[]>> = {
      leftlowerarm: ["leftforearm"], rightlowerarm: ["rightforearm"],
      leftupperleg: ["leftthigh"], rightupperleg: ["rightthigh"],
    };
    requiredVisuals.forEach((semantic) => {
      const token = normalized(semantic);
      const tokens = [token, ...(visualAliases[token] ?? [])];
      const slotIndex = rig.slots.findIndex((slot) => tokens.some((candidate) => normalized(slot.id).includes(candidate)));
      const attachmentIndex = rig.attachments.findIndex((attachment) => tokens.some((candidate) => normalized(attachment.id).includes(candidate) || attachment.tags.some((tag) => normalized(tag) === candidate)));
      if (slotIndex < 0) issues.push({ code: "missing_required_semantic_slot", path: ["slots"], message: `Missing required ${semantic} visual slot for the humanoid rig profile.`, severity: "error", objectId: semantic, mode: "prepare", suggestedAction: `Return to Prepare and create or relabel the ${semantic} part.` });
      else if (attachmentIndex < 0) issues.push({ code: "missing_required_semantic_attachment", path: ["slots", slotIndex, "attachmentId"], message: `The ${semantic} slot has no matching visual attachment.`, severity: "error", objectId: rig.slots[slotIndex].id, mode: "prepare", suggestedAction: `Return to Prepare and assign artwork for ${semantic}.` });
    });
  }

  return issues;
}
