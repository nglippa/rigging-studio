import { z } from "zod";
import { PART_TYPES, type PartType } from "./partTaxonomy";

export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type Point = { readonly x: number; readonly y: number };
export type SegmentationMask = { readonly width: number; readonly height: number; readonly alpha: readonly number[] };
export const CONFIDENCE_SOURCES = ["provider", "heuristic", "unavailable", "mock-fixture"] as const;
export type ConfidenceSource = (typeof CONFIDENCE_SOURCES)[number];
export type ProposedCharacterPart = {
  readonly id: string;
  readonly name: string;
  readonly semanticType: PartType;
  readonly confidence: number | null;
  readonly confidenceSource: ConfidenceSource;
  readonly bounds: Rect;
  readonly mask?: SegmentationMask;
  readonly sourceImageRegion: Rect;
  readonly suggestedBoneId: string;
  readonly suggestedSlotId: string;
  readonly suggestedZIndex: number;
  readonly pivotHint: Point;
  readonly warnings: readonly string[];
  readonly fixtureImagePath?: string;
  readonly accepted: boolean;
  readonly provenance: "generated" | "reconstructed" | "manual" | "accepted";
};

export type CharacterSegmentationResponse = {
  readonly segmentationId: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly parts: readonly ProposedCharacterPart[];
  readonly warnings: readonly string[];
  readonly providerMetadata: Readonly<Record<string, string | number | boolean>>;
};

const finite = z.number().finite();
export const rectSchema: z.ZodType<Rect> = z.object({ x: finite, y: finite, width: finite.positive(), height: finite.positive() }).strict();
export const pointSchema: z.ZodType<Point> = z.object({ x: finite, y: finite }).strict();
export const maskSchema: z.ZodType<SegmentationMask> = z.object({
  width: z.number().int().positive(), height: z.number().int().positive(), alpha: z.array(z.number().int().min(0).max(255)),
}).strict().superRefine((mask, context) => {
  if (mask.alpha.length !== mask.width * mask.height) context.addIssue({ code: "custom", message: "Mask alpha length must equal width × height", path: ["alpha"] });
});
export const proposedCharacterPartSchema: z.ZodType<ProposedCharacterPart> = z.object({
  id: z.string().trim().min(1), name: z.string().trim().min(1), semanticType: z.enum(PART_TYPES), confidence: finite.min(0).max(1).nullable(), confidenceSource: z.enum(CONFIDENCE_SOURCES).default("heuristic"),
  bounds: rectSchema, mask: maskSchema.optional(), sourceImageRegion: rectSchema, suggestedBoneId: z.string().trim().min(1),
  suggestedSlotId: z.string().trim().min(1), suggestedZIndex: z.number().int(), pivotHint: pointSchema,
  warnings: z.array(z.string()), fixtureImagePath: z.string().min(1).optional(), accepted: z.boolean(),
  provenance: z.enum(["generated", "reconstructed", "manual", "accepted"]),
}).strict();
export const characterSegmentationResponseSchema: z.ZodType<CharacterSegmentationResponse> = z.object({
  segmentationId: z.string().min(1), imageWidth: z.number().int().positive(), imageHeight: z.number().int().positive(),
  parts: z.array(proposedCharacterPartSchema), warnings: z.array(z.string()),
  providerMetadata: z.record(z.string(), z.union([z.string(), finite, z.boolean()])),
}).strict();
