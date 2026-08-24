import { z } from "zod";
import type { GeneratedCharacterProject } from "../project/generatedCharacterProject";
import { pointSchema, rectSchema, type Point, type Rect } from "../segmentation/segmentationSchema";
import { jsonValueSchema } from "../../rigging/schema/schemas";
import type { JsonValue } from "../../rigging/schema/types";

export type CharacterConsistencyContext = {
  readonly projectId: string;
  readonly sourceImageId: string;
  readonly sourceCanvasWidth: number;
  readonly sourceCanvasHeight: number;
  readonly characterPrompt: string;
  readonly stylePrompt: string;
  readonly generationProvider: string;
  readonly generationModel?: string;
  readonly negativePrompt?: string;
  readonly generationSeed?: number;
  readonly canonicalSourceImage?: string;
  readonly styleReferenceAssetId?: string;
  readonly poseReferenceAssetId?: string;
  readonly loraMetadata?: readonly JsonValue[];
  readonly providerMetadata?: Readonly<Record<string, JsonValue>>;
  readonly canonicalScale: { readonly width: number; readonly height: number };
  readonly acceptedParts: readonly string[];
  readonly semanticBBoxes: Readonly<Record<string, Rect>>;
  readonly jointHints: Readonly<Record<string, Point>>;
  readonly paletteHints: readonly string[];
  readonly equipmentHints: readonly string[];
  readonly referenceAssetIds: readonly string[];
};

const sizeSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict();
export const characterConsistencyContextSchema: z.ZodType<CharacterConsistencyContext> = z.object({
  projectId: z.string().min(1), sourceImageId: z.string().min(1), sourceCanvasWidth: z.number().int().positive(), sourceCanvasHeight: z.number().int().positive(),
  characterPrompt: z.string(), stylePrompt: z.string(), generationProvider: z.string().min(1), generationModel: z.string().min(1).optional(), negativePrompt: z.string().optional(), generationSeed: z.number().int().optional(), canonicalSourceImage: z.string().min(1).optional(),
  styleReferenceAssetId: z.string().min(1).optional(), poseReferenceAssetId: z.string().min(1).optional(), loraMetadata: z.array(jsonValueSchema).optional(), providerMetadata: z.record(z.string(), jsonValueSchema).optional(), canonicalScale: sizeSchema,
  acceptedParts: z.array(z.string().min(1)), semanticBBoxes: z.record(z.string(), rectSchema), jointHints: z.record(z.string(), pointSchema),
  paletteHints: z.array(z.string()), equipmentHints: z.array(z.string()), referenceAssetIds: z.array(z.string().min(1)),
}).strict();

export function buildCharacterConsistencyContext(project: GeneratedCharacterProject): CharacterConsistencyContext {
  const source = project.sourceImage;
  if (!source) throw new Error("Character consistency context requires a source image");
  const parts = project.segmentationData?.parts ?? [];
  const provider = source.provider || String(source.providerMetadata.provider ?? "unknown");
  const metadata = source.providerMetadata;
  const model = stringValue(metadata.model) ?? stringValue(source.generationSettings.model);
  const negativePrompt = stringValue(metadata.negativePrompt) ?? stringValue(project.generationMetadata.negativePrompt);
  const styleReferenceAssetId = stringValue(metadata.styleReferenceAssetId);
  const poseReferenceAssetId = stringValue(metadata.poseReferenceAssetId);
  const loraMetadata = Array.isArray(metadata.loras) ? metadata.loras : [];
  const paletteHints = Array.isArray(metadata.paletteHints) ? metadata.paletteHints.filter((value): value is string => typeof value === "string") : [];
  const equipmentHints = parts.filter((part) => /Equipment|accessory|cape|tail|helmet/i.test(part.semanticType)).map((part) => part.semanticType);
  return characterConsistencyContextSchema.parse({
    projectId: project.id, sourceImageId: source.generationId, sourceCanvasWidth: source.width, sourceCanvasHeight: source.height,
    characterPrompt: project.originalUserPrompt, stylePrompt: project.generationPrompt, generationProvider: provider,
    ...(model ? { generationModel: model } : {}), ...(negativePrompt !== undefined ? { negativePrompt } : {}),
    ...(typeof source.seed === "number" ? { generationSeed: source.seed } : {}), canonicalSourceImage: source.sourceArtifact,
    ...(styleReferenceAssetId ? { styleReferenceAssetId } : {}), ...(poseReferenceAssetId ? { poseReferenceAssetId } : {}), loraMetadata, providerMetadata: metadata,
    canonicalScale: { width: source.width, height: source.height },
    acceptedParts: parts.filter((part) => part.accepted).map((part) => part.id),
    semanticBBoxes: Object.fromEntries(parts.map((part) => [part.semanticType, part.bounds])),
    jointHints: Object.fromEntries(parts.map((part) => [part.semanticType, part.pivotHint])),
    paletteHints, equipmentHints, referenceAssetIds: [source.sourceArtifact, styleReferenceAssetId, poseReferenceAssetId].filter((value): value is string => Boolean(value)),
  });
}

function stringValue(value: JsonValue | undefined): string | undefined { return typeof value === "string" && value ? value : undefined; }
