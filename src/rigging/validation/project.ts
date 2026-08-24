import type { LocalProjectSnapshot } from "../../project-storage/types";
import type { KeyframeSelection } from "../../tools/rig-editor/animation/types";
import { validateAnimationDefinition } from "./animation";
import type { ValidationIssue } from "./issues";
import { validateRigDefinition } from "./rig";

export type RigProjectSelectionState = {
  readonly boneIds?: readonly string[];
  readonly slotIds?: readonly string[];
  readonly attachmentIds?: readonly string[];
  readonly skinIds?: readonly string[];
  readonly partIds?: readonly string[];
  readonly animationId?: string | null;
  readonly keyframes?: readonly KeyframeSelection[];
};

const issue = (
  code: string,
  path: ValidationIssue["path"],
  message: string,
  options: Pick<ValidationIssue, "severity" | "objectId" | "mode" | "suggestedAction"> = {},
): ValidationIssue => ({ code, path, message, severity: "error", ...options });

const duplicates = (values: readonly string[], path: string, code: string): ValidationIssue[] => {
  const first = new Map<string, number>();
  const problems: ValidationIssue[] = [];
  values.forEach((value, index) => {
    const prior = first.get(value);
    if (prior === undefined) first.set(value, index);
    else problems.push(issue(code, [path, index], `ID "${value}" duplicates ${path}[${prior}]`));
  });
  return problems;
};

const finite = (value: number, path: ValidationIssue["path"], label: string): ValidationIssue[] => Number.isFinite(value)
  ? []
  : [issue("non_finite_value", path, `${label} must be finite`)];

/**
 * Canonical integrity boundary for the document that is actually persisted.
 *
 * Keyframes do not have standalone IDs in schema v1. Their identity is the
 * tuple (animation, bone, property, time), so a duplicate time in one track is
 * reported as a duplicate keyframe identity.
 */
export function validateRigProject(snapshot: LocalProjectSnapshot, selections: RigProjectSelectionState = {}): ValidationIssue[] {
  const problems: ValidationIssue[] = [];
  const { project, rig, animations } = snapshot;

  if (project?.partCutterState) {
    const state = project.partCutterState;
    problems.push(...duplicates(state.parts.map((part) => part.partId), "project.partCutterState.parts", "duplicate_part_id"));
    state.proposals.forEach((proposal, proposalIndex) => problems.push(...duplicates(
      proposal.parts.map((part) => part.proposedPartId),
      `project.partCutterState.proposals.${proposalIndex}.parts`,
      "duplicate_proposed_part_id",
    )));
    state.parts.forEach((part, index) => {
      const base = ["project", "partCutterState", "parts", index] as const;
      problems.push(
        ...finite(part.pivot.x, [...base, "pivot", "x"], "Part pivot x"),
        ...finite(part.pivot.y, [...base, "pivot", "y"], "Part pivot y"),
      );
      if (part.mask.width * part.mask.height !== part.mask.alpha.length) problems.push(issue("invalid_part_mask_size", [...base, "mask", "alpha"], `Mask has ${part.mask.alpha.length} samples; expected ${part.mask.width * part.mask.height}`, { objectId: part.partId, mode: "prepare" }));
      if (part.accepted && !part.mask.alpha.some((alpha) => alpha > 0)) problems.push(issue("empty_accepted_part_mask", [...base, "mask"], `Accepted part "${part.partId}" has no visible pixels`, { objectId: part.partId, mode: "prepare" }));
      const box = part.boundingBox;
      if (part.pivot.x < box.x || part.pivot.y < box.y || part.pivot.x > box.x + box.width || part.pivot.y > box.y + box.height) problems.push(issue("part_pivot_outside_source_bounds", [...base, "pivot"], `Pivot for "${part.partId}" is outside its source-coordinate bounds`, { severity: "warning", objectId: part.partId, mode: "prepare", suggestedAction: "Move the pivot onto the intended joint inside the part." }));
      if (part.sourceCanvasSize.width !== state.sourceCanvasSize.width || part.sourceCanvasSize.height !== state.sourceCanvasSize.height) problems.push(issue("part_source_canvas_mismatch", [...base, "sourceCanvasSize"], `Part "${part.partId}" does not use the Prepare source canvas`, { objectId: part.partId, mode: "prepare" }));
    });
    if (state.ownership) {
      problems.push(...duplicates(state.ownership.regionIds, "project.partCutterState.ownership.regionIds", "duplicate_ownership_region_id"));
      const partIds = new Set(state.parts.map((part) => part.partId));
      state.ownership.regionIds.forEach((id, index) => { if (!partIds.has(id)) problems.push(issue("orphan_ownership_region", ["project", "partCutterState", "ownership", "regionIds", index], `Ownership references missing part "${id}"`, { objectId: id, mode: "prepare" })); });
    }
  }

  if (project) {
    const accepted = project.segmentationData?.parts.filter((part) => part.accepted && part.semanticType !== "rootReference") ?? project.partCutterState?.parts.filter((part) => part.accepted && part.semanticType !== "root") ?? [];
    const acceptedIds = new Set(accepted.map((part) => "id" in part ? part.id : part.partId));
    problems.push(...duplicates(project.extractedParts.map((part) => part.partId), "project.extractedParts", "duplicate_extracted_part_id"));
    const extractedIds = new Set(project.extractedParts.map((part) => part.partId));
    if ((acceptedIds.size || project.extractedParts.length) && !project.sourceImage) problems.push(issue("missing_source_asset", ["project", "sourceImage"], "Prepared or extracted parts require their source asset", { mode: "prepare" }));
    project.extractedParts.forEach((part, index) => {
      if (!part.image.trim()) problems.push(issue("missing_extracted_part_asset", ["project", "extractedParts", index, "image"], `Extracted part "${part.partId}" has no image asset`, { objectId: part.partId, mode: "prepare" }));
      if (acceptedIds.size && !acceptedIds.has(part.partId)) problems.push(issue("orphan_extracted_part", ["project", "extractedParts", index], `Extracted part "${part.partId}" is not an accepted part`, { severity: "warning", objectId: part.partId, mode: "prepare" }));
    });
    if (project.extractedParts.length) acceptedIds.forEach((id) => { if (!extractedIds.has(id)) problems.push(issue("accepted_part_not_extracted", ["project", "extractedParts"], `Accepted part "${id}" has no persisted extraction`, { objectId: id, mode: "prepare" })); });
    if (project.rigDefinition && rig && project.rigDefinition.id !== rig.id) problems.push(issue("project_rig_mismatch", ["project", "rigDefinition", "id"], `Project rig "${project.rigDefinition.id}" does not match durable rig "${rig.id}"`, { mode: "setup" }));
  }

  if (!rig) {
    if (animations?.animations.length) problems.push(issue("animations_without_rig", ["animations"], "Animations require a rig"));
    return problems;
  }

  problems.push(...validateRigDefinition(rig));
  problems.push(...duplicates(rig.bones.map((bone) => bone.id), "rig.bones", "duplicate_bone_id"));
  const boneIds = new Set(rig.bones.map((bone) => bone.id));
  const slotIds = new Set(rig.slots.map((slot) => slot.id));
  const attachmentIds = new Set(rig.attachments.map((attachment) => attachment.id));
  const skinIds = new Set(rig.skins.map((skin) => skin.id));
  const referencedAttachments = new Set(rig.slots.flatMap((slot) => slot.attachmentId ? [slot.attachmentId] : []).concat(rig.skins.flatMap((skin) => Object.values(skin.slotAttachments).filter((id): id is string => id !== null))));
  rig.bones.forEach((bone, index) => problems.push(
    ...finite(bone.x, ["rig", "bones", index, "x"], "Bone x"), ...finite(bone.y, ["rig", "bones", index, "y"], "Bone y"),
    ...finite(bone.rotation, ["rig", "bones", index, "rotation"], "Bone rotation"), ...finite(bone.scaleX, ["rig", "bones", index, "scaleX"], "Bone scaleX"),
    ...finite(bone.scaleY, ["rig", "bones", index, "scaleY"], "Bone scaleY"), ...finite(bone.length, ["rig", "bones", index, "length"], "Bone length"),
  ));
  rig.slots.forEach((slot, index) => problems.push(...finite(slot.pivotX, ["rig", "slots", index, "pivotX"], "Slot pivotX"), ...finite(slot.pivotY, ["rig", "slots", index, "pivotY"], "Slot pivotY")));
  rig.attachments.forEach((attachment, index) => {
    problems.push(...finite(attachment.width, ["rig", "attachments", index, "width"], "Attachment width"), ...finite(attachment.height, ["rig", "attachments", index, "height"], "Attachment height"), ...finite(attachment.offsetX, ["rig", "attachments", index, "offsetX"], "Attachment offsetX"), ...finite(attachment.offsetY, ["rig", "attachments", index, "offsetY"], "Attachment offsetY"), ...finite(attachment.rotation, ["rig", "attachments", index, "rotation"], "Attachment rotation"), ...finite(attachment.scaleX, ["rig", "attachments", index, "scaleX"], "Attachment scaleX"), ...finite(attachment.scaleY, ["rig", "attachments", index, "scaleY"], "Attachment scaleY"));
    if (!referencedAttachments.has(attachment.id)) problems.push(issue("orphan_attachment", ["rig", "attachments", index], `Attachment "${attachment.id}" is not used by a slot or skin`, { severity: "warning", objectId: attachment.id, mode: "setup" }));
  });

  if (project?.segmentationData) {
    const partIds = new Set(project.segmentationData.parts.filter((part) => part.accepted && part.semanticType !== "rootReference").map((part) => part.id));
    rig.attachments.forEach((attachment, index) => { if (!partIds.has(attachment.id)) problems.push(issue("attachment_missing_part", ["rig", "attachments", index], `Attachment "${attachment.id}" is not backed by an accepted Prepare part`, { severity: "warning", objectId: attachment.id, mode: "setup" })); });
    partIds.forEach((partId) => {
      if (!attachmentIds.has(partId)) problems.push(issue("accepted_part_missing_attachment", ["rig", "attachments"], `Accepted part "${partId}" has no attachment`, { objectId: partId, mode: "setup" }));
      if (!rig.slots.some((slot) => slot.attachmentId === partId) && !rig.skins.some((skin) => Object.values(skin.slotAttachments).includes(partId))) problems.push(issue("accepted_part_missing_slot", ["rig", "slots"], `Accepted part "${partId}" is not connected to a slot`, { objectId: partId, mode: "setup" }));
    });
    project.partCutterState?.parts.filter((part) => part.accepted && part.equipment).forEach((part) => {
      const attachment = rig.attachments.find((candidate) => candidate.id === part.partId);
      if (attachment && attachment.category !== "equipment") problems.push(issue("stale_equipment_reference", ["rig", "attachments", rig.attachments.indexOf(attachment), "category"], `Equipment part "${part.partId}" is no longer categorized as equipment`, { objectId: part.partId, mode: "setup" }));
    });
  }

  if (animations) {
    if (animations.rigId !== rig.id) problems.push(issue("animation_library_rig_mismatch", ["animations", "rigId"], `Animation library targets "${animations.rigId}" instead of "${rig.id}"`, { mode: "animate" }));
    problems.push(...duplicates(animations.animations.map((animation) => animation.id), "animations.animations", "duplicate_animation_id"));
    animations.animations.forEach((animation, animationIndex) => {
      validateAnimationDefinition(animation, rig).forEach((problem) => problems.push({ ...problem, path: ["animations", "animations", animationIndex, ...problem.path], severity: problem.severity ?? "error", mode: "animate", objectId: problem.objectId ?? animation.id }));
      animation.tracks.forEach((track, trackIndex) => {
        const times = new Map<number, number>();
        track.keyframes.forEach((frame, frameIndex) => {
          problems.push(...finite(frame.time, ["animations", "animations", animationIndex, "tracks", trackIndex, "keyframes", frameIndex, "time"], "Keyframe time"), ...finite(frame.value, ["animations", "animations", animationIndex, "tracks", trackIndex, "keyframes", frameIndex, "value"], "Keyframe value"));
          const prior = times.get(frame.time);
          if (prior === undefined) times.set(frame.time, frameIndex);
          else problems.push(issue("duplicate_keyframe_identity", ["animations", "animations", animationIndex, "tracks", trackIndex, "keyframes", frameIndex], `Keyframe duplicates the ${track.boneId}.${track.property} keyframe at time ${frame.time}`, { objectId: animation.id, mode: "animate" }));
        });
      });
    });
  }

  if (snapshot.selectedSkinId && !rig.skins.some((skin) => skin.id === snapshot.selectedSkinId)) problems.push(issue("stale_selected_skin", ["selectedSkinId"], `Selected skin "${snapshot.selectedSkinId}" no longer exists`, { mode: "setup" }));
  selections.boneIds?.forEach((id, index) => { if (!boneIds.has(id)) problems.push(issue("stale_selected_bone", ["selections", "boneIds", index], `Selected bone "${id}" no longer exists`, { mode: "setup" })); });
  selections.slotIds?.forEach((id, index) => { if (!slotIds.has(id)) problems.push(issue("stale_selected_slot", ["selections", "slotIds", index], `Selected slot "${id}" no longer exists`, { mode: "setup" })); });
  selections.attachmentIds?.forEach((id, index) => { if (!attachmentIds.has(id)) problems.push(issue("stale_selected_attachment", ["selections", "attachmentIds", index], `Selected attachment "${id}" no longer exists`, { mode: "setup" })); });
  selections.skinIds?.forEach((id, index) => { if (!skinIds.has(id)) problems.push(issue("stale_selected_skin", ["selections", "skinIds", index], `Selected skin "${id}" no longer exists`, { mode: "setup" })); });
  const acceptedPartIds = new Set(project?.partCutterState?.parts.map((part) => part.partId) ?? []);
  selections.partIds?.forEach((id, index) => { if (!acceptedPartIds.has(id)) problems.push(issue("stale_selected_part", ["selections", "partIds", index], `Selected part "${id}" no longer exists`, { mode: "prepare" })); });
  if (selections.animationId && !animations?.animations.some((animation) => animation.id === selections.animationId)) problems.push(issue("stale_selected_animation", ["selections", "animationId"], `Selected animation "${selections.animationId}" no longer exists`, { mode: "animate" }));
  selections.keyframes?.forEach((selection, index) => {
    const animation = animations?.animations.find((candidate) => !selections.animationId || candidate.id === selections.animationId);
    const track = animation?.tracks.find((candidate) => candidate.boneId === selection.boneId && candidate.property === selection.property);
    if (!track?.keyframes.some((frame) => frame.time === selection.time)) problems.push(issue("stale_selected_keyframe", ["selections", "keyframes", index], `Selected keyframe ${selection.boneId}.${selection.property}@${selection.time} no longer exists`, { mode: "animate" }));
  });
  return problems;
}

export const blockingRigProjectProblems = (problems: readonly ValidationIssue[]): readonly ValidationIssue[] => problems.filter((problem) => problem.severity !== "warning");
