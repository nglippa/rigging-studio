import type { AnimatedProperty, AnimationDefinition, Easing, JsonValue } from "../../../rigging/schema/types";

export const ANIMATION_LIBRARY_FORMAT = "rig-studio-animation-library" as const;

export type AnimationLibrary = {
  readonly format: typeof ANIMATION_LIBRARY_FORMAT;
  readonly formatVersion: 1;
  readonly rigId: string;
  readonly animations: readonly AnimationDefinition[];
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly extensions: Readonly<Record<string, JsonValue>>;
};

export type KeyframeSelection = {
  readonly boneId: string;
  readonly property: AnimatedProperty;
  readonly time: number;
};

export type CopiedKeyframe = {
  readonly boneId: string;
  readonly property: AnimatedProperty;
  readonly relativeTime: number;
  readonly value: number;
  readonly easing: Easing;
};

export type KeyframeClipboard = {
  readonly duration: number;
  readonly keyframes: readonly CopiedKeyframe[];
};

export type DurationPolicy = "clamp" | "expand";
export type AnimationBonePatch = Partial<Record<AnimatedProperty, number>>;

export const keyframeSelectionKey = (selection: KeyframeSelection): string => `${selection.boneId}\u0000${selection.property}\u0000${selection.time.toFixed(6)}`;
