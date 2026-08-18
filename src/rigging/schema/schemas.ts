import { z } from "zod";
import {
  ANIMATED_PROPERTIES,
  ANIMATION_SCHEMA_VERSION,
  EASING_TYPES,
  RIG_SCHEMA_VERSION,
  SLOT_BLEND_MODES,
  type AnimationDefinition,
  type AnimationTrack,
  type AttachmentDefinition,
  type BoneDefinition,
  type JsonValue,
  type Keyframe,
  type RigDefinition,
  type SkinDefinition,
  type SlotDefinition,
} from "./types";

const id = z.string().trim().min(1, "ID must not be empty");
const finite = z.number().finite("Value must be finite");
const positive = finite.positive("Value must be greater than zero");
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), finite, z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
]));

export const boneDefinitionSchema: z.ZodType<BoneDefinition> = z.object({
  id, parentId: id.nullable(), x: finite, y: finite, rotation: finite, scaleX: finite, scaleY: finite,
  length: finite.nonnegative("Bone length cannot be negative"), inheritRotation: z.boolean(), inheritScale: z.boolean(),
}).strict();

export const slotDefinitionSchema: z.ZodType<SlotDefinition> = z.object({
  id, boneId: id, attachmentId: id.nullable(), zIndex: z.number().int(), visible: z.boolean(),
  blendMode: z.enum(SLOT_BLEND_MODES), tint: z.number().int().min(0).max(0xffffff), pivotX: finite, pivotY: finite,
}).strict();

export const attachmentDefinitionSchema: z.ZodType<AttachmentDefinition> = z.object({
  id, imagePath: z.string().trim().min(1), width: positive, height: positive, offsetX: finite, offsetY: finite,
  rotation: finite, scaleX: finite, scaleY: finite, category: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)),
}).strict();

export const skinDefinitionSchema: z.ZodType<SkinDefinition> = z.object({
  id, name: z.string().trim().min(1), slotAttachments: z.record(z.string(), id.nullable()),
}).strict();

export const rigDefinitionSchema: z.ZodType<RigDefinition> = z.object({
  schemaVersion: z.literal(RIG_SCHEMA_VERSION), id,
  canvas: z.object({ width: positive, height: positive }).strict(), rootBoneId: id,
  bones: z.array(boneDefinitionSchema).min(1, "Rig must contain at least one bone"),
  slots: z.array(slotDefinitionSchema), attachments: z.array(attachmentDefinitionSchema),
  skins: z.array(skinDefinitionSchema).min(1, "Rig must contain at least one skin"),
  defaultSkinId: id, metadata: z.record(z.string(), jsonValueSchema),
}).strict();

export const keyframeSchema: z.ZodType<Keyframe> = z.object({
  time: finite.nonnegative("Keyframe time cannot be negative"), value: finite, easing: z.enum(EASING_TYPES),
}).strict();
export const animationTrackSchema: z.ZodType<AnimationTrack> = z.object({
  boneId: id, property: z.enum(ANIMATED_PROPERTIES),
  keyframes: z.array(keyframeSchema).min(1, "Track must contain at least one keyframe"),
}).strict();
export const animationDefinitionSchema: z.ZodType<AnimationDefinition> = z.object({
  schemaVersion: z.literal(ANIMATION_SCHEMA_VERSION), id, name: z.string().trim().min(1), duration: positive,
  loop: z.boolean(), tracks: z.array(animationTrackSchema),
}).strict();
