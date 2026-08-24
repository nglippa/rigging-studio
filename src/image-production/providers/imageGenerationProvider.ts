import type { ImageProductionJson } from "../proposals/imageProposal";

export const IMAGE_GENERATION_PROVIDER_IDS = ["comfyui", "draw_things"] as const;
export type ImageGenerationProviderId = (typeof IMAGE_GENERATION_PROVIDER_IDS)[number];
export type CharacterGenerationIntent = "character" | "character_variant" | "equipment_variant";

export type CharacterGenerationRequest = {
  readonly projectId?: string;
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly model?: string;
  readonly seed?: number | null;
  readonly steps?: number;
  readonly guidance?: number;
  readonly candidateCount?: number;
  readonly styleReferenceAssetId?: string;
  readonly poseReferenceAssetId?: string;
  readonly generationIntent: CharacterGenerationIntent;
  readonly metadata?: Readonly<Record<string, ImageProductionJson>>;
};

export type ProviderCapabilityState = {
  readonly available: boolean;
  readonly level?: "full" | "partial" | "unavailable";
  readonly reason?: string;
};

export type ProviderCapabilities = {
  readonly provider: ImageGenerationProviderId;
  readonly label: string;
  readonly local: true;
  readonly connected: boolean;
  readonly mode: "direct" | "watched_folder" | "unavailable";
  readonly characterGeneration: ProviderCapabilityState;
  readonly characterVariant: ProviderCapabilityState;
  readonly metadataCapture: ProviderCapabilityState;
  readonly watchedFolder: ProviderCapabilityState;
  readonly models: readonly { readonly name: string; readonly family?: string; readonly available: true }[];
  readonly message: string;
};

export type GeneratedImageCandidate = {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly seed: number | null;
  readonly metadata: Readonly<Record<string, ImageProductionJson>>;
  readonly sourcePath?: string;
};

export type ImageGenerationProvider = {
  readonly id: ImageGenerationProviderId;
  getCapabilities(): Promise<ProviderCapabilities>;
  generateCharacter(input: CharacterGenerationRequest, signal?: AbortSignal): Promise<readonly GeneratedImageCandidate[]>;
  generateVariant?(input: CharacterGenerationRequest, signal?: AbortSignal): Promise<readonly GeneratedImageCandidate[]>;
};
