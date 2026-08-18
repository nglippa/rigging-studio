import { safeParseAnimationDefinition } from "../schema/parsing";
import type { AnimatedProperty, RigDefinition } from "../schema/types";
import { safeParseAnimationProposal, type AnimationProposal } from "./animationProposalSchema";

export type AnimationSafetyLimits = {
  readonly maximumRotationByBone: Readonly<Record<string, number>>;
  readonly defaultMaximumRotation: number;
  readonly minimumScale: number;
  readonly maximumScale: number;
  readonly maximumRootTranslation: number;
  readonly maximumKeyframesPerTrack: number;
  readonly maximumTotalKeyframes: number;
};

export const DEFAULT_ANIMATION_SAFETY_LIMITS: AnimationSafetyLimits = {
  maximumRotationByBone: {},
  defaultMaximumRotation: 180,
  minimumScale: .25,
  maximumScale: 3,
  maximumRootTranslation: 240,
  maximumKeyframesPerTrack: 64,
  maximumTotalKeyframes: 2000,
};

export type ProposalValidationIssue = { readonly path: string; readonly message: string };
export type ProposalValidationResult =
  | { readonly success: true; readonly proposal: AnimationProposal; readonly warnings: readonly string[] }
  | { readonly success: false; readonly issues: readonly ProposalValidationIssue[]; readonly message: string };

type ProposalValidationOptions = {
  readonly selectedBoneIds?: readonly string[];
  readonly selectedBonesOnly?: boolean;
};

const propertySetupValue = (rig: RigDefinition, boneId: string, property: AnimatedProperty): number => {
  const bone = rig.bones.find((candidate) => candidate.id === boneId);
  return bone?.[property] ?? (property.startsWith("scale") ? 1 : 0);
};

export const validateAnimationProposal = (
  input: unknown,
  rig: RigDefinition,
  limits: AnimationSafetyLimits = DEFAULT_ANIMATION_SAFETY_LIMITS,
  options: ProposalValidationOptions = {},
): ProposalValidationResult => {
  const parsed = safeParseAnimationProposal(input);
  if (!parsed.success) return {
    success: false,
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    message: "The provider returned malformed proposal JSON.",
  };
  const proposal = parsed.data;
  const animationResult = safeParseAnimationDefinition(proposal.animation, rig);
  const issues: ProposalValidationIssue[] = [];
  if (!animationResult.success) animationResult.issues.forEach((issue) => issues.push({ path: issue.path.join("."), message: issue.message }));
  const boneIds = new Set(rig.bones.map((bone) => bone.id));
  proposal.affectedBones.forEach((boneId, index) => {
    if (!boneIds.has(boneId)) issues.push({ path: `affectedBones.${index}`, message: `Unknown bone "${boneId}"` });
  });
  if (options.selectedBonesOnly) {
    const allowed = new Set(options.selectedBoneIds ?? []);
    proposal.animation.tracks.forEach((track, index) => {
      if (!allowed.has(track.boneId)) issues.push({ path: `animation.tracks.${index}.boneId`, message: `Track for "${track.boneId}" is outside the selected-bones scope` });
    });
  }
  let totalKeys = 0;
  proposal.animation.tracks.forEach((track, trackIndex) => {
    totalKeys += track.keyframes.length;
    if (track.keyframes.length > limits.maximumKeyframesPerTrack) issues.push({ path: `animation.tracks.${trackIndex}.keyframes`, message: `Track has ${track.keyframes.length} keys; limit is ${limits.maximumKeyframesPerTrack}` });
    track.keyframes.forEach((frame, frameIndex) => {
      const path = `animation.tracks.${trackIndex}.keyframes.${frameIndex}.value`;
      if (track.property === "rotation") {
        const maximum = limits.maximumRotationByBone[track.boneId] ?? limits.defaultMaximumRotation;
        const setup = propertySetupValue(rig, track.boneId, track.property);
        if (Math.abs(frame.value - setup) > maximum) issues.push({ path, message: `Rotation differs from setup by more than ${maximum}°` });
      }
      if ((track.property === "scaleX" || track.property === "scaleY") && (frame.value < limits.minimumScale || frame.value > limits.maximumScale)) {
        issues.push({ path, message: `Scale ${frame.value} is outside ${limits.minimumScale}–${limits.maximumScale}` });
      }
      if (track.boneId === rig.rootBoneId && (track.property === "x" || track.property === "y")) {
        const setup = propertySetupValue(rig, track.boneId, track.property);
        if (Math.abs(frame.value - setup) > limits.maximumRootTranslation) issues.push({ path, message: `Root translation exceeds ${limits.maximumRootTranslation}px from setup` });
      }
    });
  });
  if (totalKeys > limits.maximumTotalKeyframes) issues.push({ path: "animation.tracks", message: `Proposal has ${totalKeys} total keys; limit is ${limits.maximumTotalKeyframes}` });
  if (issues.length) return { success: false, issues, message: `Proposal rejected: ${issues.map((issue) => issue.message).join("; ")}` };
  return { success: true, proposal, warnings: proposal.warnings };
};
