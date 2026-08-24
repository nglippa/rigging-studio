import type { CharacterSegmentationRequest } from "../segmentation/segmentationProvider";
import { characterImageGenerationResultSchema, occlusionReconstructionResultSchema, suitabilityReviewSchema, validateProviderResult, validateSegmentationProviderResult, type CharacterGenerationRequest, type CharacterImageGenerationResult, type CharacterMaskRefinementRequest, type CharacterPipelineCapabilities, type CharacterPipelineCapability, type CharacterPipelineProvider, type OcclusionReconstructionRequest, type OcclusionReconstructionResult, type SuitabilityRequest, type SuitabilityReview } from "./characterPipelineProvider";
import type { CharacterSegmentationResponse } from "../segmentation/segmentationSchema";

type Capability = "status" | "generate" | "regenerate" | "variant" | "suitability" | "segment" | "refine-mask" | "reconstruct";

const unavailable = (provider: string, reason: string): CharacterPipelineCapability => ({ available: false, imageConditioned: false, mode: "unavailable", provider, confidenceSource: "unavailable", reason });
const initialCapabilities = (provider: string): CharacterPipelineCapabilities => ({
  segmentation: unavailable(provider, "Provider capability status has not been verified"),
  maskRefinement: unavailable(provider, "Provider capability status has not been verified"),
  reconstruction: unavailable(provider, "Provider capability status has not been verified"),
  backgroundRemoval: unavailable(provider, "Provider capability status has not been verified"),
  alphaCleanup: unavailable(provider, "Provider capability status has not been verified"),
});

export class HttpCharacterPipelineProvider implements CharacterPipelineProvider {
  readonly id = "http-character-pipeline";
  readonly name = "Configured provider";
  capabilities: CharacterPipelineCapabilities = initialCapabilities(this.id);
  private readonly pendingControllers = new Set<AbortController>();
  constructor(private readonly endpoint: string, private readonly fetcher: typeof fetch = fetch) {}
  private async request(capability: Capability, body: unknown): Promise<unknown> {
    const controller = new AbortController(); this.pendingControllers.add(controller);
    try {
      const response = await this.fetcher(this.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability, body }), signal: controller.signal });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { readonly error?: unknown } | null;
        throw new Error(typeof failure?.error === "string" ? failure.error : `Character provider failed (${response.status})`);
      }
      return response.json() as Promise<unknown>;
    } finally { this.pendingControllers.delete(controller); }
  }
  cancelPending(): void { this.pendingControllers.forEach((controller) => controller.abort()); this.pendingControllers.clear(); }
  async refreshCapabilities(): Promise<CharacterPipelineCapabilities> {
    try {
      const response = await this.request("status", {});
      if (!response || typeof response !== "object" || !("capabilities" in response)) throw new Error("Provider status omitted capabilities");
      this.capabilities = (response as { readonly capabilities: CharacterPipelineCapabilities }).capabilities;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "Provider capability check failed";
      this.capabilities = initialCapabilities(this.id);
      this.capabilities = Object.fromEntries(Object.entries(this.capabilities).map(([name, capability]) => [name, { ...capability, reason }])) as CharacterPipelineCapabilities;
    }
    return this.capabilities;
  }
  async generateCharacter(request: CharacterGenerationRequest): Promise<CharacterImageGenerationResult> { return validateProviderResult(characterImageGenerationResultSchema, await this.request("generate", request), "Image provider"); }
  async regenerateCharacter(request: CharacterGenerationRequest): Promise<CharacterImageGenerationResult> { return validateProviderResult(characterImageGenerationResultSchema, await this.request("regenerate", request), "Image provider"); }
  async generateVariant(request: CharacterGenerationRequest): Promise<CharacterImageGenerationResult> { return validateProviderResult(characterImageGenerationResultSchema, await this.request("variant", request), "Image provider"); }
  async checkSuitability(request: SuitabilityRequest): Promise<SuitabilityReview> { return validateProviderResult(suitabilityReviewSchema, await this.request("suitability", request), "Suitability provider"); }
  async segmentCharacter(request: CharacterSegmentationRequest): Promise<CharacterSegmentationResponse> { return validateSegmentationProviderResult(await this.request("segment", request)); }
  async refinePartMasks(request: CharacterMaskRefinementRequest): Promise<CharacterSegmentationResponse> { return validateSegmentationProviderResult(await this.request("refine-mask", request)); }
  async reconstructPart(request: OcclusionReconstructionRequest): Promise<OcclusionReconstructionResult> { return validateProviderResult(occlusionReconstructionResultSchema, await this.request("reconstruct", request), "Reconstruction provider"); }
}
