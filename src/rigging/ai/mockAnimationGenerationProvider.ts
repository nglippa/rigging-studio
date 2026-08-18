import type { AnimatedProperty, AnimationDefinition, AnimationTrack, Easing } from "../schema/types";
import type { AnimationGenerationContext } from "./animationContextBuilder";
import type { AnimationGenerationInput, AnimationGenerationProvider } from "./animationGenerationProvider";
import type { AnimationProposal } from "./animationProposalSchema";

const setupValue = (context: AnimationGenerationContext, boneId: string, property: AnimatedProperty): number => {
  const bone = context.bones.find((candidate) => candidate.id === boneId);
  return bone?.setup[property] ?? (property.startsWith("scale") ? 1 : 0);
};

const normalizedId = (request: string): string => request.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 42) || "ai_animation";
export const mockAnimationName = (request: string): string => {
  const normalized = request.toLowerCase();
  const known = ["walk", "run", "idle", "melee", "attack", "ranged", "cast", "hurt", "death", "celebrate", "interact"].find((name) => normalized.includes(name));
  return known ? known.replace(/^./, (letter) => letter.toUpperCase()) : request.trim().split(/\s+/).slice(0, 4).join(" ") || "Generated animation";
};
const findBone = (context: AnimationGenerationContext, ...needles: string[]): string | undefined => context.bones.find((bone) => needles.every((needle) => bone.id.toLowerCase().includes(needle)))?.id;
const frame = (time: number, value: number, easing: Easing = "easeInOut") => ({ time, value, easing });

const setTrack = (animation: AnimationDefinition, boneId: string | undefined, property: AnimatedProperty, values: readonly { readonly time: number; readonly value: number; readonly easing: Easing }[]): AnimationDefinition => {
  if (!boneId) return animation;
  const track: AnimationTrack = { boneId, property, keyframes: values };
  return { ...animation, tracks: [...animation.tracks.filter((candidate) => candidate.boneId !== boneId || candidate.property !== property), track] };
};

const allowedBone = (context: AnimationGenerationContext, boneId: string | undefined): string | undefined =>
  boneId && (context.mode !== "reviseSelectedBones" || context.selectedBoneIds.includes(boneId)) ? boneId : undefined;

const seamless = (animation: AnimationDefinition): AnimationDefinition => ({ ...animation, tracks: animation.tracks.map((track) => {
  const first = track.keyframes[0];
  if (!first) return track;
  return { ...track, keyframes: [...track.keyframes.filter((key) => Math.abs(key.time - animation.duration) > .0001), { ...first, time: animation.duration }] };
}) });

const buildTemplate = (context: AnimationGenerationContext): AnimationDefinition => {
  const request = context.motionDescription.toLowerCase();
  const duration = context.requestedDuration;
  const half = duration / 2;
  const quarter = duration / 4;
  const current = context.currentAnimation;
  let animation: AnimationDefinition = current
    ? { ...structuredClone(current), duration, loop: context.loop, tracks: context.mode === "reviseSelectedBones" ? current.tracks.filter((track) => context.selectedBoneIds.includes(track.boneId)) : [...current.tracks] }
    : { schemaVersion: 1, id: normalizedId(context.motionDescription), name: mockAnimationName(context.motionDescription), duration, loop: context.loop, tracks: [] };

  const torso = allowedBone(context, findBone(context, "torso"));
  const head = allowedBone(context, findBone(context, "head"));
  const root = allowedBone(context, context.bones.find((bone) => bone.parentId === null)?.id);
  const leftArm = allowedBone(context, findBone(context, "left", "upper", "arm"));
  const rightArm = allowedBone(context, findBone(context, "right", "upper", "arm"));
  const leftLeg = allowedBone(context, findBone(context, "left", "upper", "leg"));
  const rightLeg = allowedBone(context, findBone(context, "right", "upper", "leg"));
  const leftLowerLeg = allowedBone(context, findBone(context, "left", "lower", "leg"));
  const rightLowerLeg = allowedBone(context, findBone(context, "right", "lower", "leg"));
  const intensity = .55 + context.constraints.intensity * .9;
  const exaggeration = .75 + context.constraints.exaggeration * .75;
  const weight = context.constraints.weight;

  if (request.includes("walk") || request.includes("run")) {
    const run = request.includes("run");
    const swing = (run ? 55 : 32) * intensity * exaggeration;
    const bob = (run ? 8 : 5) * intensity * (1 + weight * .2);
    animation = setTrack(animation, torso, "y", [frame(0, setupValue(context, torso ?? "", "y")), frame(quarter, setupValue(context, torso ?? "", "y") - bob), frame(half, setupValue(context, torso ?? "", "y")), frame(quarter * 3, setupValue(context, torso ?? "", "y") - bob), frame(duration, setupValue(context, torso ?? "", "y"))]);
    for (const [boneId, sign] of [[leftArm, -1], [rightArm, 1], [leftLeg, 1], [rightLeg, -1]] as const) {
      if (!boneId) continue;
      const base = setupValue(context, boneId, "rotation");
      animation = setTrack(animation, boneId, "rotation", [frame(0, base + swing * sign), frame(half, base - swing * sign), frame(duration, base + swing * sign)]);
    }
    for (const [boneId, sign] of [[leftLowerLeg, 1], [rightLowerLeg, -1]] as const) {
      if (!boneId) continue;
      const base = setupValue(context, boneId, "rotation");
      animation = setTrack(animation, boneId, "rotation", [frame(0, base + 14 * sign * intensity), frame(half, base - 14 * sign * intensity), frame(duration, base + 14 * sign * intensity)]);
    }
  } else if (request.includes("attack") || request.includes("melee")) {
    const arm = rightArm ?? leftArm;
    const base = arm ? setupValue(context, arm, "rotation") : 0;
    animation = setTrack(animation, arm, "rotation", [frame(0, base, "easeOut"), frame(duration * .18, base + 58 * intensity, "easeIn"), frame(duration * .46, base - 92 * intensity, "easeOut"), frame(duration, base, "easeInOut")]);
    if (torso) {
      const baseTorso = setupValue(context, torso, "rotation");
      animation = setTrack(animation, torso, "rotation", [frame(0, baseTorso, "easeOut"), frame(duration * .18, baseTorso - 9 * intensity, "easeIn"), frame(duration * .46, baseTorso + 16 * intensity, "easeOut"), frame(duration, baseTorso)]);
    }
  } else if (request.includes("death")) {
    const baseY = setupValue(context, root ?? "", "y");
    const baseRotation = setupValue(context, root ?? "", "rotation");
    animation = setTrack(animation, root, "y", [frame(0, baseY, "easeIn"), frame(duration * .65, baseY + Math.min(context.constraints.rootMovementAllowance, 70), "easeOut"), frame(duration, baseY + Math.min(context.constraints.rootMovementAllowance, 78), "easeOut")]);
    animation = setTrack(animation, root, "rotation", [frame(0, baseRotation, "easeIn"), frame(duration * .7, baseRotation - 78, "easeOut"), frame(duration, baseRotation - 90, "easeOut")]);
  } else if (request.includes("hurt")) {
    const base = setupValue(context, torso ?? "", "rotation");
    animation = setTrack(animation, torso, "rotation", [frame(0, base, "easeOut"), frame(duration * .15, base - 15 * intensity, "easeOut"), frame(duration * .4, base + 6 * intensity), frame(duration, base)]);
  } else if (request.includes("cast") || request.includes("ranged")) {
    for (const boneId of [leftArm, rightArm]) if (boneId) {
      const base = setupValue(context, boneId, "rotation");
      animation = setTrack(animation, boneId, "rotation", [frame(0, base), frame(half, base + (boneId === leftArm ? -45 : 45) * intensity), frame(duration, base)]);
    }
  } else if (request.includes("celebrate")) {
    for (const boneId of [leftArm, rightArm]) if (boneId) {
      const base = setupValue(context, boneId, "rotation");
      animation = setTrack(animation, boneId, "rotation", [frame(0, base), frame(quarter, base - 55), frame(half, base - 38), frame(quarter * 3, base - 58), frame(duration, base)]);
    }
  } else {
    const bob = 3 + 4 * context.constraints.intensity;
    animation = setTrack(animation, torso, "y", [frame(0, setupValue(context, torso ?? "", "y")), frame(half, setupValue(context, torso ?? "", "y") - bob), frame(duration, setupValue(context, torso ?? "", "y"))]);
    const headBase = setupValue(context, head ?? "", "rotation");
    animation = setTrack(animation, head, "rotation", [frame(0, headBase + 1.5 * intensity), frame(half, headBase - 2.5 * intensity), frame(duration, headBase + 1.5 * intensity)]);
  }

  if (request.includes("reduce head") && head) animation = { ...animation, tracks: animation.tracks.map((track) => track.boneId === head && track.property === "rotation" ? { ...track, keyframes: track.keyframes.map((key) => ({ ...key, value: setupValue(context, head, "rotation") + (key.value - setupValue(context, head, "rotation")) * .45 })) } : track) };
  if (request.includes("energetic")) animation = { ...animation, tracks: animation.tracks.map((track) => track.property === "rotation" ? { ...track, keyframes: track.keyframes.map((key) => ({ ...key, value: setupValue(context, track.boneId, "rotation") + (key.value - setupValue(context, track.boneId, "rotation")) * 1.2 })) } : track) };
  return context.loop || request.includes("loop smoothly") ? seamless(animation) : animation;
};

export class MockAnimationGenerationProvider implements AnimationGenerationProvider {
  readonly id = "mock";
  readonly name = "Local mock provider";

  async generateAnimationProposal(input: AnimationGenerationInput): Promise<AnimationProposal> {
    const animation = buildTemplate(input.context);
    const affectedBones = [...new Set(animation.tracks.map((track) => track.boneId))];
    const request = input.context.motionDescription.toLowerCase();
    const warnings = request.includes("foot sliding") ? ["Foot stabilization is approximate. Review the contact diagnostics before acceptance."] : [];
    const proposal: AnimationProposal = {
      proposalVersion: 1,
      summary: `Mock proposal for: ${input.context.motionDescription}${input.refinement ? ` (${input.refinement})` : ""}`,
      animation,
      warnings,
      assumptions: ["Bone roles were inferred from bone names.", "The mock provider uses reusable motion templates rather than a remote model."],
      affectedBones,
      confidenceNotes: [affectedBones.length ? "High confidence in schema validity; artistic quality requires preview." : "No matching bones were available for the requested template."],
      recommendedRigChanges: [],
    };
    return proposal;
  }
}
