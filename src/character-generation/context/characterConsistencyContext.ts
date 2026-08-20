import { z } from "zod";
import type { GeneratedCharacterProject } from "../project/generatedCharacterProject";
import { pointSchema, rectSchema, type Point, type Rect } from "../segmentation/segmentationSchema";

export type CharacterConsistencyContext = {
  readonly projectId: string;
  readonly sourceImageId: string;
  readonly sourceCanvasWidth: number;
  readonly sourceCanvasHeight: number;
  readonly characterPrompt: string;
  readonly stylePrompt: string;
  readonly generationProvider: string;
  readonly generationSeed?: number;
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
  characterPrompt: z.string(), stylePrompt: z.string(), generationProvider: z.string().min(1), generationSeed: z.number().int().optional(), canonicalScale: sizeSchema,
  acceptedParts: z.array(z.string().min(1)), semanticBBoxes: z.record(z.string(), rectSchema), jointHints: z.record(z.string(), pointSchema),
  paletteHints: z.array(z.string()), equipmentHints: z.array(z.string()), referenceAssetIds: z.array(z.string().min(1)),
}).strict();

export function buildCharacterConsistencyContext(project: GeneratedCharacterProject): CharacterConsistencyContext {
  const source = project.sourceImage;
  if (!source) throw new Error("Character consistency context requires a source image");
  const parts = project.segmentationData?.parts ?? [];
  const provider = source.provider || String(source.providerMetadata.provider ?? "unknown");
  const equipmentHints = parts.filter((part) => /Equipment|accessory|cape|tail|helmet/i.test(part.semanticType)).map((part) => part.semanticType);
  return characterConsistencyContextSchema.parse({
    projectId: project.id, sourceImageId: source.generationId, sourceCanvasWidth: source.width, sourceCanvasHeight: source.height,
    characterPrompt: project.originalUserPrompt, stylePrompt: project.generationPrompt, generationProvider: provider,
    ...(source.seed === undefined ? {} : { generationSeed: source.seed }), canonicalScale: { width: source.width, height: source.height },
    acceptedParts: parts.filter((part) => part.accepted).map((part) => part.id),
    semanticBBoxes: Object.fromEntries(parts.map((part) => [part.semanticType, part.bounds])),
    jointHints: Object.fromEntries(parts.map((part) => [part.semanticType, part.pivotHint])),
    paletteHints: [], equipmentHints, referenceAssetIds: [source.sourceArtifact],
  });
}
