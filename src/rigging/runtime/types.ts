import type { AnimatedProperty } from "../schema/types";
import type { Matrix2D } from "../math/matrix";

export type BonePose = {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
};
export type RigPose = { readonly bones: Readonly<Record<string, BonePose>> };
export type WorldBoneTransform = BonePose & { readonly matrix: Matrix2D };
export type WorldTransforms = Readonly<Record<string, WorldBoneTransform>>;
export type BonePosePatch = Partial<Record<AnimatedProperty, number>>;
