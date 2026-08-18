import type { GeneratedCharacterProject } from "../../character-generation/project/generatedCharacterProject";
import type { AnimationDefinition, RigDefinition } from "../../rigging/schema/types";
import type { AnimationLibrary } from "../../tools/rig-editor/animation/types";

export const projectSummary = (project: GeneratedCharacterProject) => ({
  id: project.id,
  name: project.name,
  stage: project.stage,
  prompt: project.originalUserPrompt,
  generationId: project.sourceImage?.generationId ?? null,
  hasSourceImage: Boolean(project.sourceImage),
  suitability: project.suitability ? { usable: project.suitability.usable, score: project.suitability.score, issueCount: project.suitability.issues.length } : null,
  partCount: project.segmentationData?.parts.length ?? 0,
  acceptedPartCount: project.segmentationData?.parts.filter((part) => part.accepted).length ?? 0,
  hasRig: Boolean(project.rigDefinition),
  warningCount: project.warnings.length,
  updatedAt: project.updatedAt,
});

export const rigSummary = (rig: RigDefinition, includeHierarchy = true) => ({
  id: rig.id,
  schemaVersion: rig.schemaVersion,
  canvas: rig.canvas,
  rootBoneId: rig.rootBoneId,
  boneCount: rig.bones.length,
  slotCount: rig.slots.length,
  attachmentCount: rig.attachments.length,
  skinIds: rig.skins.map((skin) => skin.id),
  ...(includeHierarchy ? { bones: rig.bones.map((bone) => ({ id: bone.id, parentId: bone.parentId, x: bone.x, y: bone.y, rotation: bone.rotation, length: bone.length })) } : {}),
  slots: rig.slots.map((slot) => ({ id: slot.id, boneId: slot.boneId, attachmentId: slot.attachmentId, zIndex: slot.zIndex, visible: slot.visible })),
});

export const animationSummary = (animation: AnimationDefinition, includeTracks = true) => ({
  id: animation.id,
  name: animation.name,
  duration: animation.duration,
  loop: animation.loop,
  trackCount: animation.tracks.length,
  keyframeCount: animation.tracks.reduce((sum, track) => sum + track.keyframes.length, 0),
  boneIds: [...new Set(animation.tracks.map((track) => track.boneId))],
  ...(includeTracks ? { tracks: animation.tracks.map((track) => ({ boneId: track.boneId, property: track.property, keyframeCount: track.keyframes.length, firstTime: track.keyframes[0]?.time ?? null, lastTime: track.keyframes.at(-1)?.time ?? null })) } : {}),
});

export const animationListSummary = (library: AnimationLibrary) => library.animations.map((animation) => animationSummary(animation, false));

