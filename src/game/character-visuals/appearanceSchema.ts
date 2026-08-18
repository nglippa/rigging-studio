import { z } from "zod";
import { CHARACTER_FACINGS, CHARACTER_VISUAL_BACKENDS, EQUIPMENT_SLOTS, type CharacterAppearanceDefinition, type CharacterAppearanceSave, type EquipmentAttachmentTransform, type EquipmentItemDefinition } from "./types";

const finite = z.number().finite();
const tint = z.number().int().min(0).max(0xffffff);
const transformSchema: z.ZodType<EquipmentAttachmentTransform> = z.object({
  offsetX: finite.optional(), offsetY: finite.optional(), rotation: finite.optional(), scaleX: finite.optional(), scaleY: finite.optional(), pivotX: finite.optional(), pivotY: finite.optional(), tint: tint.optional(),
}).strict();
const itemSchema: z.ZodType<EquipmentItemDefinition> = z.object({
  id: z.string().min(1), slot: z.enum(EQUIPMENT_SLOTS), attachmentId: z.string().min(1).nullable(), transform: transformSchema,
  animationOverrides: z.record(z.string(), transformSchema),
}).strict();

export const characterAppearanceSchema: z.ZodType<CharacterAppearanceDefinition> = z.object({
  schemaVersion: z.literal(1), characterId: z.string().min(1), visualBackend: z.enum(CHARACTER_VISUAL_BACKENDS), rigId: z.string().min(1).nullable(), rigPath: z.string().min(1).optional(), skinId: z.string().min(1).nullable(),
  equipmentSlots: z.partialRecord(z.enum(EQUIPMENT_SLOTS), z.string().min(1).nullable()),
  equipmentRigSlots: z.partialRecord(z.enum(EQUIPMENT_SLOTS), z.string().min(1)),
  equipmentCatalog: z.record(z.string(), itemSchema),
  palette: z.object({ baseTint: tint, namedTints: z.record(z.string(), tint) }).strict(),
  animationMapping: z.record(z.string(), z.string().min(1)),
  animations: z.record(z.string(), z.object({ id: z.string().min(1), path: z.string().min(1).optional(), legacyFramePaths: z.array(z.string().min(1)), legacyFps: finite.positive(), loop: z.boolean().optional(), fallbackClipId: z.string().min(1).optional() }).strict()),
  fallbackAnimation: z.string().min(1), directionalBehavior: z.object({ strategy: z.literal("horizontalFlip"), authoredFacing: z.enum(CHARACTER_FACINGS) }).strict(),
  scale: finite.positive(), worldOffset: z.object({ x: finite, y: finite }).strict(), snapToPixels: z.boolean(),
  shadow: z.object({ enabled: z.boolean(), offsetX: finite, offsetY: finite, radiusX: finite.nonnegative(), radiusY: finite.nonnegative(), alpha: finite.min(0).max(1), color: tint }).strict(),
  expressionSlotId: z.string().min(1).optional(), expressionMapping: z.record(z.string(), z.string().min(1).nullable()),
  legacy: z.object({ imagePath: z.string().min(1), width: finite.positive(), height: finite.positive(), anchorX: finite, anchorY: finite }).strict(),
}).strict();

export const characterAppearanceSaveSchema: z.ZodType<CharacterAppearanceSave> = z.object({
  saveVersion: z.literal(1), characterId: z.string().min(1), skinId: z.string().min(1).nullable(), equipment: z.partialRecord(z.enum(EQUIPMENT_SLOTS), z.string().min(1).nullable()), tint, expression: z.string().min(1).nullable(),
}).strict();

export const parseCharacterAppearance = (input: unknown): CharacterAppearanceDefinition => characterAppearanceSchema.parse(input);
export const parseCharacterAppearanceJson = (source: string): CharacterAppearanceDefinition => parseCharacterAppearance(JSON.parse(source) as unknown);
