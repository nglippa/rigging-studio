import type { AnimationDefinition, RigDefinition } from "../schema/types";

export type AnimationGenerationMode = "create" | "revise" | "reviseSelectedBones";
export type FootRole = "leftFoot" | "rightFoot";
export type FootContactInterval = { readonly foot: FootRole; readonly start: number; readonly end: number };
export type LeftRightMapping = { readonly left: string; readonly right: string };

export type AnimationAuthoringConstraints = {
  readonly duration: number;
  readonly loop: boolean;
  readonly intensity: number;
  readonly weight: number;
  readonly exaggeration: number;
  readonly rootMovementAllowance: number;
  readonly preserveTiming: boolean;
  readonly preserveContactFrames: boolean;
  readonly styleNotes: string;
};

export type AnimationContextOptions = {
  readonly request: string;
  readonly mode: AnimationGenerationMode;
  readonly constraints: AnimationAuthoringConstraints;
  readonly selectedBoneIds: readonly string[];
  readonly leftRightMappings: readonly LeftRightMapping[];
  readonly groundPlaneY: number;
  readonly leftFootBoneId: string | null;
  readonly rightFootBoneId: string | null;
  readonly contactIntervals: readonly FootContactInterval[];
  readonly currentAnimation?: AnimationDefinition;
  readonly referenceAnimations?: readonly AnimationDefinition[];
  readonly includeSlotNames?: boolean;
};

export type AnimationGenerationContext = {
  readonly rigSchemaVersion: number;
  readonly bones: readonly {
    readonly id: string;
    readonly parentId: string | null;
    readonly length: number;
    readonly setup: { readonly x: number; readonly y: number; readonly rotation: number; readonly scaleX: number; readonly scaleY: number };
  }[];
  readonly slotNames?: readonly string[];
  readonly currentAnimation?: AnimationDefinition;
  readonly referenceAnimations: readonly AnimationDefinition[];
  readonly requestedDuration: number;
  readonly loop: boolean;
  readonly mode: AnimationGenerationMode;
  readonly selectedBoneIds: readonly string[];
  readonly leftRightMappings: readonly LeftRightMapping[];
  readonly motionDescription: string;
  readonly groundPlaneY: number;
  readonly feet: { readonly leftFootBoneId: string | null; readonly rightFootBoneId: string | null; readonly contactIntervals: readonly FootContactInterval[] };
  readonly constraints: AnimationAuthoringConstraints;
  readonly authoringRules: readonly string[];
};

const RULES = [
  "Use only existing bone IDs and never rename a bone.",
  "Animation values are absolute local transforms. Rotation uses degrees and time uses seconds.",
  "Preserve every untouched track when revising an animation.",
  "Use x, y, rotation, scaleX, and scaleY tracks only.",
  "Keep keyframes strictly sorted and avoid excessive keys.",
  "When looping is requested, make the first and final poses seamless.",
  "Keep planted feet stable during marked contact intervals.",
  "Use opposing arm and leg motion for natural locomotion.",
  "Report assumptions and uncertainty instead of inventing rig structure.",
] as const;

export const buildAnimationGenerationContext = (rig: RigDefinition, options: AnimationContextOptions): AnimationGenerationContext => ({
  rigSchemaVersion: rig.schemaVersion,
  bones: rig.bones.map((bone) => ({
    id: bone.id,
    parentId: bone.parentId,
    length: bone.length,
    setup: { x: bone.x, y: bone.y, rotation: bone.rotation, scaleX: bone.scaleX, scaleY: bone.scaleY },
  })),
  ...(options.includeSlotNames ? { slotNames: rig.slots.map((slot) => slot.id) } : {}),
  ...(options.mode !== "create" && options.currentAnimation ? { currentAnimation: options.currentAnimation } : {}),
  referenceAnimations: options.referenceAnimations ?? [],
  requestedDuration: options.constraints.duration,
  loop: options.constraints.loop,
  mode: options.mode,
  selectedBoneIds: options.mode === "reviseSelectedBones" ? [...options.selectedBoneIds] : [],
  leftRightMappings: options.leftRightMappings,
  motionDescription: options.request,
  groundPlaneY: options.groundPlaneY,
  feet: {
    leftFootBoneId: options.leftFootBoneId,
    rightFootBoneId: options.rightFootBoneId,
    contactIntervals: options.contactIntervals,
  },
  constraints: options.constraints,
  authoringRules: RULES,
});
