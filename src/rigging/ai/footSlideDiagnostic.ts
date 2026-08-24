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
  readonly normalizedToHeight?: number;
  readonly normalizedToLegLength?: number;
  readonly tolerance?: number;
  readonly likelySliding: boolean;
  readonly message: string;
};

export type NormalizedFootSlideOptions = { readonly maximumHeightRatio?: number; readonly maximumLegLengthRatio?: number };

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

export const diagnoseNormalizedFootSliding = (
  rig: RigDefinition,
  animation: AnimationDefinition,
  footBones: { readonly leftFootBoneId: string | null; readonly rightFootBoneId: string | null },
  intervals: readonly FootContactInterval[],
  options: NormalizedFootSlideOptions = {},
): readonly FootSlideDiagnostic[] => {
  const world = computeWorldTransforms(rig, createRestPose(rig));
  const ys = Object.values(world).map((position) => position.y);
  const height = Math.max(1, Math.max(...ys) - Math.min(...ys));
  const chainLength = (side: "left" | "right"): number => rig.bones
    .filter((bone) => new RegExp(`${side}.*(?:upper.*leg|lower.*leg|hock|foot)`, "i").test(bone.id))
    .reduce((sum, bone) => sum + (bone.parentId ? Math.hypot(bone.x, bone.y) : 0), 0);
  const legLength = Math.max(1, (chainLength("left") + chainLength("right")) / 2);
  const tolerance = Math.min(height * (options.maximumHeightRatio ?? .02), legLength * (options.maximumLegLengthRatio ?? .035));
  return diagnoseFootSliding(rig, animation, footBones, intervals, tolerance).map((item) => {
    const normalizedToHeight = item.drift / height; const normalizedToLegLength = item.drift / legLength;
    const likelySliding = item.drift > tolerance;
    return {
      ...item, normalizedToHeight, normalizedToLegLength, tolerance, likelySliding,
      message: likelySliding
        ? `${item.boneId} drifts ${(normalizedToHeight * 100).toFixed(2)}% height / ${(normalizedToLegLength * 100).toFixed(2)}% leg length during contact`
        : `${item.boneId} contact drift ${(normalizedToHeight * 100).toFixed(2)}% height / ${(normalizedToLegLength * 100).toFixed(2)}% leg length`,
    };
  });
};
