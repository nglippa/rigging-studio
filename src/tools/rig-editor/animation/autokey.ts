import type { AnimationDefinition, Easing, RigDefinition } from "../../../rigging/schema/types";
import { applyBonePatch } from "./operations";
import type { AnimationBonePatch } from "./types";

export type AutoKeyResult = { readonly animation: AnimationDefinition; readonly created: boolean; readonly pendingPatch: AnimationBonePatch | null };

export const applyViewportEdit = (animation: AnimationDefinition, boneId: string, time: number, patch: AnimationBonePatch, autoKey: boolean, easing: Easing = "linear"): AutoKeyResult => {
  if (!autoKey) return { animation, created: false, pendingPatch: patch };
  return { animation: applyBonePatch(animation, boneId, time, patch, easing), created: true, pendingPatch: null };
};

export const setupPoseUnchanged = (before: RigDefinition, after: RigDefinition): boolean => JSON.stringify(before) === JSON.stringify(after);
