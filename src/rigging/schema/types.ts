export const RIG_SCHEMA_VERSION = 1 as const;
export const ANIMATION_SCHEMA_VERSION = 1 as const;

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type BoneDefinition = {
  readonly id: string;
  readonly parentId: string | null;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly length: number;
  readonly inheritRotation: boolean;
  readonly inheritScale: boolean;
};

export const SLOT_BLEND_MODES = ["normal", "add", "multiply", "screen"] as const;
export type SlotBlendMode = (typeof SLOT_BLEND_MODES)[number];

export type SlotDefinition = {
  readonly id: string;
  readonly boneId: string;
  readonly attachmentId: string | null;
  readonly zIndex: number;
  readonly visible: boolean;
  readonly blendMode: SlotBlendMode;
  readonly tint: number;
  readonly pivotX: number;
  readonly pivotY: number;
};

export type AttachmentDefinition = {
  readonly id: string;
  readonly imagePath: string;
  readonly width: number;
  readonly height: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly category: string;
  readonly tags: readonly string[];
};

export type SkinDefinition = {
  readonly id: string;
  readonly name: string;
  readonly slotAttachments: Readonly<Record<string, string | null>>;
};

export type RigDefinition = {
  readonly schemaVersion: typeof RIG_SCHEMA_VERSION;
  readonly id: string;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly rootBoneId: string;
  readonly bones: readonly BoneDefinition[];
  readonly slots: readonly SlotDefinition[];
  readonly attachments: readonly AttachmentDefinition[];
  readonly skins: readonly SkinDefinition[];
  readonly defaultSkinId: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
};

export const ANIMATED_PROPERTIES = ["x", "y", "rotation", "scaleX", "scaleY"] as const;
export type AnimatedProperty = (typeof ANIMATED_PROPERTIES)[number];
export const EASING_TYPES = ["linear", "easeIn", "easeOut", "easeInOut", "stepped"] as const;
export type Easing = (typeof EASING_TYPES)[number];

export type Keyframe = { readonly time: number; readonly value: number; readonly easing: Easing };
export type AnimationTrack = {
  readonly boneId: string;
  readonly property: AnimatedProperty;
  readonly keyframes: readonly Keyframe[];
};
export type AnimationDefinition = {
  readonly schemaVersion: typeof ANIMATION_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly duration: number;
  readonly loop: boolean;
  readonly tracks: readonly AnimationTrack[];
};
