import type { RigDefinition } from "../schema/types";
import { degreesToRadians } from "../math/rotation";
import type { BonePosePatch, RigPose } from "./types";

export const createRestPose = (rig: RigDefinition): RigPose => ({
  bones: Object.fromEntries(rig.bones.map((bone) => [bone.id, {
    x: bone.x, y: bone.y, rotation: degreesToRadians(bone.rotation), scaleX: bone.scaleX, scaleY: bone.scaleY,
  }])),
});

export function updateBonePose(pose: RigPose, boneId: string, patch: BonePosePatch): RigPose {
  const current = pose.bones[boneId];
  if (!current) return pose;
  return { bones: { ...pose.bones, [boneId]: { ...current, ...patch } } };
}
