import { evaluateAnimationAtTime } from "../animation/evaluate";
import { createRestPose } from "../runtime/pose";
import { computeWorldTransforms } from "../runtime/worldTransforms";
import type { AnimationDefinition, RigDefinition } from "../schema/types";
import type { FootContactInterval, FootRole } from "./animationContextBuilder";

export type FootSlideDiagnostic = {
  readonly foot: FootRole;
  readonly boneId: string;
  readonly start: number;
  readonly end: number;
  readonly drift: number;
  readonly likelySliding: boolean;
  readonly message: string;
};

export const diagnoseFootSliding = (
  rig: RigDefinition,
  animation: AnimationDefinition,
  footBones: { readonly leftFootBoneId: string | null; readonly rightFootBoneId: string | null },
  intervals: readonly FootContactInterval[],
  tolerance = 3,
): readonly FootSlideDiagnostic[] => intervals.flatMap((interval) => {
  const boneId = interval.foot === "leftFoot" ? footBones.leftFootBoneId : footBones.rightFootBoneId;
  if (!boneId || !rig.bones.some((bone) => bone.id === boneId) || interval.end <= interval.start) return [];
  const positions = Array.from({ length: 9 }, (_, index) => {
    const time = interval.start + (interval.end - interval.start) * index / 8;
    const pose = evaluateAnimationAtTime(animation, createRestPose(rig), Math.min(animation.duration, Math.max(0, time)));
    return computeWorldTransforms(rig, pose)[boneId];
  }).filter((position) => position !== undefined);
  if (!positions.length) return [];
  const origin = positions[0];
  const drift = Math.max(...positions.map((position) => Math.hypot(position.x - origin.x, position.y - origin.y)));
  const likelySliding = drift > tolerance;
  return [{
    foot: interval.foot,
    boneId,
    start: interval.start,
    end: interval.end,
    drift,
    likelySliding,
    message: likelySliding ? `${boneId} drifts ${drift.toFixed(1)}px during marked contact` : `${boneId} stays within ${drift.toFixed(1)}px during marked contact`,
  }];
});
