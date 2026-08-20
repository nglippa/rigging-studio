import { z } from "zod";
import { jsonValueSchema, rigDefinitionSchema, skinDefinitionSchema } from "../../rigging/schema/schemas";
import type { JsonValue, RigDefinition, SkinDefinition } from "../../rigging/schema/types";
import { safeParseRigDefinition } from "../../rigging/schema/parsing";
import { characterSegmentationResponseSchema, type CharacterSegmentationResponse } from "../segmentation/segmentationSchema";
import type { OcclusionReview } from "../occlusion/occlusionRepair";
import type { CharacterImageGenerationResult, SuitabilityReview } from "../providers/characterPipelineProvider";
import { partCutterStateSchema, type PartCutterState } from "../../part-cutter/schema";

export const CHARACTER_PROJECT_STAGES = ["describe", "generate", "prepare", "rig", "test", "edit"] as const;
export type CharacterProjectStage = (typeof CHARACTER_PROJECT_STAGES)[number];
export type ExtractedCharacterPart = {
  readonly partId: string;
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly padding: number;
  readonly status: "generated" | "reconstructed" | "manual" | "accepted";
};
export type GeneratedCharacterProject = {
  readonly projectVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly stage: CharacterProjectStage;
  readonly originalUserPrompt: string;
  readonly generationPrompt: string;
  readonly generationMetadata: Readonly<Record<string, JsonValue>>;
  readonly generationHistory: readonly CharacterImageGenerationResult[];
  readonly imageProductionHistory: readonly {
    readonly proposalId: string;
    readonly operation: string;
    readonly candidateId: string;
    readonly workflowId: string;
    readonly approvalPolicy: "manual" | "agent_recommendation";
    readonly targetPartId?: string;
    readonly acceptedAt: string;
  }[];
  readonly sourceImage?: CharacterImageGenerationResult;
  readonly suitability?: SuitabilityReview;
  readonly segmentationData?: CharacterSegmentationResponse;
  readonly partCutterState?: PartCutterState;
  readonly extractedParts: readonly ExtractedCharacterPart[];
  readonly reconstructedParts: readonly OcclusionReview[];
  readonly rigDefinition?: RigDefinition;
  readonly skins: readonly SkinDefinition[];
  readonly warnings: readonly string[];
  readonly userCorrections: readonly { readonly stage: CharacterProjectStage; readonly description: string; readonly timestamp: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

const providerMetadataSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const imageSchema: z.ZodType<CharacterImageGenerationResult> = z.object({
  generationId: z.string(), image: z.string(), width: z.number().int().positive(), height: z.number().int().positive(), generationPrompt: z.string(), generationSettings: providerMetadataSchema, seed: z.number().int().optional(), providerMetadata: providerMetadataSchema, warnings: z.array(z.string()),
  generationMode: z.enum(["fixture", "provider_generated", "imported_external"]), novelArtwork: z.boolean(), provider: z.string().min(1), sourceArtifact: z.string().min(1),
}).strict();
const suitabilitySchema: z.ZodType<SuitabilityReview> = z.object({
  usable: z.boolean(), score: z.number().min(0).max(1), summary: z.string(), issues: z.array(z.object({ type: z.enum(["limb-overlap", "hidden-hand", "overlapping-feet", "weapon-crosses-torso", "cape-obscures-legs", "unclear-silhouette", "not-side-view", "multiple-characters", "cropped-part", "complex-background", "merged-equipment"]), severity: z.enum(["info", "warning", "blocking"]), message: z.string(), confidence: z.number().min(0).max(1) }).strict()),
}).strict();
const occlusionSchema: z.ZodType<OcclusionReview> = z.object({
  partId: z.string(), likelyOccluded: z.boolean(), confidence: z.number().min(0).max(1), reason: z.string(), decision: z.enum(["unreviewed", "keep-visible-fragment", "reconstruct", "acceptable", "regenerate-source"]), reconstructedImage: z.string().optional(), reconstructionAccepted: z.boolean(),
  previewResourceInspected: z.string().optional(), inspectedAt: z.string().optional(), inspectedBy: z.string().optional(),
}).strict();
export const generatedCharacterProjectSchema: z.ZodType<GeneratedCharacterProject> = z.object({
  projectVersion: z.literal(1), id: z.string().min(1), name: z.string().min(1), stage: z.enum(CHARACTER_PROJECT_STAGES), originalUserPrompt: z.string(), generationPrompt: z.string(),
  generationMetadata: z.record(z.string(), jsonValueSchema), generationHistory: z.array(imageSchema), sourceImage: imageSchema.optional(), suitability: suitabilitySchema.optional(), segmentationData: characterSegmentationResponseSchema.optional(),
  partCutterState: partCutterStateSchema.optional(),
  imageProductionHistory: z.array(z.object({ proposalId: z.string().min(1), operation: z.string().min(1), candidateId: z.string().min(1), workflowId: z.string().min(1), approvalPolicy: z.enum(["manual", "agent_recommendation"]), targetPartId: z.string().min(1).optional(), acceptedAt: z.string() }).strict()),
  extractedParts: z.array(z.object({ partId: z.string(), image: z.string(), width: z.number().positive(), height: z.number().positive(), padding: z.number().int().nonnegative(), status: z.enum(["generated", "reconstructed", "manual", "accepted"]) }).strict()),
  reconstructedParts: z.array(occlusionSchema), rigDefinition: rigDefinitionSchema.optional(), skins: z.array(skinDefinitionSchema), warnings: z.array(z.string()),
  userCorrections: z.array(z.object({ stage: z.enum(CHARACTER_PROJECT_STAGES), description: z.string(), timestamp: z.string() }).strict()), createdAt: z.string(), updatedAt: z.string(),
}).strict();

export const createGeneratedCharacterProject = (name: string, prompt: string, now = new Date().toISOString()): GeneratedCharacterProject => ({
  projectVersion: 1, id: `character-${Math.random().toString(36).slice(2, 10)}`, name, stage: "describe", originalUserPrompt: prompt, generationPrompt: "", generationMetadata: {}, generationHistory: [], imageProductionHistory: [],
  extractedParts: [], reconstructedParts: [], skins: [], warnings: [], userCorrections: [], createdAt: now, updatedAt: now,
});

const migrateGeneration = (input: unknown): unknown => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const metadata = record.providerMetadata && typeof record.providerMetadata === "object" && !Array.isArray(record.providerMetadata)
    ? record.providerMetadata as Record<string, unknown>
    : {};
  const provider = typeof record.provider === "string" ? record.provider : typeof metadata.provider === "string" ? metadata.provider : "legacy-provider";
  const fixture = provider === "local-mock" || (typeof record.generationId === "string" && record.generationId.startsWith("mock-"));
  return {
    ...record,
    generationMode: record.generationMode ?? (fixture ? "fixture" : provider === "imagegen" ? "imported_external" : "provider_generated"),
    novelArtwork: record.novelArtwork ?? !fixture,
    provider,
    sourceArtifact: record.sourceArtifact ?? record.image ?? "legacy-source",
  };
};

export function parseGeneratedCharacterProject(input: unknown): { readonly success: true; readonly data: GeneratedCharacterProject } | { readonly success: false; readonly message: string } {
  const migrated = input && typeof input === "object" && !Array.isArray(input)
    ? (() => {
      const record = input as Record<string, unknown>;
      const sourceImage = migrateGeneration(record.sourceImage);
      const history = Array.isArray(record.generationHistory) ? record.generationHistory.map(migrateGeneration) : sourceImage ? [sourceImage] : [];
      return { ...record, sourceImage, generationHistory: history, imageProductionHistory: Array.isArray(record.imageProductionHistory) ? record.imageProductionHistory : [] };
    })()
    : input;
  const parsed = generatedCharacterProjectSchema.safeParse(migrated);
  if (!parsed.success) return { success: false, message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "project"}: ${issue.message}`).join("; ") };
  if (parsed.data.rigDefinition) {
    const rig = safeParseRigDefinition(parsed.data.rigDefinition);
    if (!rig.success) return { success: false, message: rig.message };
  }
  return { success: true, data: parsed.data };
}

export function serializeGeneratedCharacterProject(project: GeneratedCharacterProject): string {
  const parsed = parseGeneratedCharacterProject(project);
  if (!parsed.success) throw new Error(parsed.message);
  return `${JSON.stringify(parsed.data, null, 2)}\n`;
}
