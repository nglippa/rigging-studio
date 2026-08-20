import { z } from "zod";
import type { RigDefinition } from "../../rigging/schema/types";
import type { CharacterPromptControls } from "../prompt/generationPreset";
import { characterSegmentationResponseSchema, type CharacterSegmentationResponse, type ProposedCharacterPart } from "../segmentation/segmentationSchema";
import type { CharacterConsistencyContext } from "../context/characterConsistencyContext";
import type { CharacterSegmentationRequest } from "../segmentation/segmentationProvider";

export type ProviderMetadata = Readonly<Record<string, string | number | boolean | null>>;
export const GENERATION_MODES = ["fixture", "provider_generated", "imported_external"] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];
export type CharacterGenerationRequest = {
  readonly userPrompt: string;
  readonly generationPrompt: string;
  readonly negativePrompt: string;
  readonly controls: CharacterPromptControls;
  readonly seed?: number;
  readonly sourceGenerationId?: string;
};
export type CharacterImageGenerationResult = {
  readonly generationId: string;
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly generationPrompt: string;
  readonly generationSettings: ProviderMetadata;
  readonly seed?: number;
  readonly providerMetadata: ProviderMetadata;
  readonly warnings: readonly string[];
  readonly generationMode: GenerationMode;
  readonly novelArtwork: boolean;
  readonly provider: string;
  readonly sourceArtifact: string;
};

export const SUITABILITY_ISSUES = [
  "limb-overlap", "hidden-hand", "overlapping-feet", "weapon-crosses-torso", "cape-obscures-legs",
  "unclear-silhouette", "not-side-view", "multiple-characters", "cropped-part", "complex-background", "merged-equipment",
] as const;
export type SuitabilityIssueType = (typeof SUITABILITY_ISSUES)[number];
export type SuitabilityIssue = { readonly type: SuitabilityIssueType; readonly severity: "info" | "warning" | "blocking"; readonly message: string; readonly confidence: number };
export type SuitabilityReview = { readonly usable: boolean; readonly score: number; readonly issues: readonly SuitabilityIssue[]; readonly summary: string };
export type SuitabilityRequest = { readonly image: string; readonly width: number; readonly height: number; readonly userPrompt: string };

export type OcclusionReconstructionRequest = {
  readonly generationId: string;
  readonly image: string;
  readonly part: ProposedCharacterPart;
  readonly stylePrompt: string;
  readonly visiblePartImage?: string;
  readonly reconstructionMask?: { readonly width: number; readonly height: number; readonly alpha: readonly number[] };
  readonly reconstructionMaskBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly expectedPivot?: { readonly x: number; readonly y: number };
  readonly consistencyContext?: CharacterConsistencyContext;
};
export type OcclusionReconstructionResult = {
  readonly reconstructionId: string;
  readonly partId: string;
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly providerMetadata: ProviderMetadata;
  readonly warnings: readonly string[];
  readonly runtimeMs?: number;
};
export type RigProposalProviderRequest = { readonly segmentation: CharacterSegmentationResponse; readonly userPrompt: string };
export type RigProposalProviderResult = { readonly rig: RigDefinition; readonly confidence: Readonly<Record<string, number>>; readonly warnings: readonly string[] };
export type VisualRigValidationRequest = { readonly rig: RigDefinition; readonly rotationDegrees: number };
export type VisualRigValidationResult = { readonly passed: boolean; readonly warnings: readonly string[]; readonly providerMetadata: ProviderMetadata };
export type CharacterPipelineCapability = {
  readonly available: boolean;
  readonly imageConditioned: boolean;
  readonly mode: "provider" | "mock" | "unavailable";
  readonly provider: string;
  readonly workflow?: string;
  readonly modelFamily?: string;
  readonly confidenceSource?: "provider" | "heuristic" | "unavailable" | "mock-fixture";
  readonly reason?: string;
};
export type CharacterPipelineCapabilities = {
  readonly segmentation: CharacterPipelineCapability;
  readonly maskRefinement: CharacterPipelineCapability;
  readonly reconstruction: CharacterPipelineCapability;
  readonly backgroundRemoval: CharacterPipelineCapability;
  readonly alphaCleanup: CharacterPipelineCapability;
};
export type CharacterMaskRefinementRequest = {
  readonly generationId: string;
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly current: CharacterSegmentationResponse;
  readonly instruction: string;
  readonly targetPartId?: string;
  readonly boxHint?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly clickHints?: readonly { readonly x: number; readonly y: number; readonly positive: boolean }[];
  readonly consistencyContext?: CharacterConsistencyContext;
};

const metadataSchema = z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()]));
export const characterImageGenerationResultSchema: z.ZodType<CharacterImageGenerationResult> = z.object({
  generationId: z.string().min(1), image: z.string().min(1), width: z.number().int().positive(), height: z.number().int().positive(),
  generationPrompt: z.string().min(1), generationSettings: metadataSchema, seed: z.number().int().optional(), providerMetadata: metadataSchema, warnings: z.array(z.string()),
  generationMode: z.enum(GENERATION_MODES), novelArtwork: z.boolean(), provider: z.string().min(1), sourceArtifact: z.string().min(1),
}).strict();
export const suitabilityReviewSchema: z.ZodType<SuitabilityReview> = z.object({
  usable: z.boolean(), score: z.number().min(0).max(1), issues: z.array(z.object({ type: z.enum(SUITABILITY_ISSUES), severity: z.enum(["info", "warning", "blocking"]), message: z.string().min(1), confidence: z.number().min(0).max(1) }).strict()), summary: z.string().min(1),
}).strict();
export const occlusionReconstructionResultSchema: z.ZodType<OcclusionReconstructionResult> = z.object({
  reconstructionId: z.string().min(1), partId: z.string().min(1), image: z.string().min(1), width: z.number().int().positive(), height: z.number().int().positive(), providerMetadata: metadataSchema, warnings: z.array(z.string()), runtimeMs: z.number().nonnegative().optional(),
}).strict();

export interface CharacterImageGenerationProvider {
  generateCharacter(request: CharacterGenerationRequest): Promise<CharacterImageGenerationResult>;
  regenerateCharacter(request: CharacterGenerationRequest): Promise<CharacterImageGenerationResult>;
  generateVariant(request: CharacterGenerationRequest): Promise<CharacterImageGenerationResult>;
}
export interface RigSuitabilityProvider { checkSuitability(request: SuitabilityRequest): Promise<SuitabilityReview>; }
export interface OcclusionReconstructionProvider { reconstructPart(request: OcclusionReconstructionRequest): Promise<OcclusionReconstructionResult>; }
export interface RigProposalProvider { proposeRig?(request: RigProposalProviderRequest): Promise<RigProposalProviderResult>; }
export interface VisualRigValidationProvider { validateRigVisual?(request: VisualRigValidationRequest): Promise<VisualRigValidationResult>; }
export interface CharacterPipelineProvider extends CharacterImageGenerationProvider, RigSuitabilityProvider, OcclusionReconstructionProvider, RigProposalProvider, VisualRigValidationProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: CharacterPipelineCapabilities;
  refreshCapabilities?(): Promise<CharacterPipelineCapabilities>;
  segmentCharacter(request: CharacterSegmentationRequest): Promise<CharacterSegmentationResponse>;
  refinePartMasks?(request: CharacterMaskRefinementRequest): Promise<CharacterSegmentationResponse>;
}

export function validateProviderResult<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`${label} returned invalid data: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return result.data;
}

export const validateSegmentationProviderResult = (input: unknown): CharacterSegmentationResponse => validateProviderResult(characterSegmentationResponseSchema, input, "Segmentation provider");
