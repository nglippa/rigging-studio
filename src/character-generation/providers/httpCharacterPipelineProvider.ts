import type { CharacterSegmentationRequest } from "../segmentation/segmentationProvider";
import { characterImageGenerationResultSchema, occlusionReconstructionResultSchema, suitabilityReviewSchema, validateProviderResult, validateSegmentationProviderResult, type CharacterGenerationRequest, type CharacterImageGenerationResult, type CharacterMaskRefinementRequest, type CharacterPipelineProvider, type OcclusionReconstructionRequest, type OcclusionReconstructionResult, type SuitabilityRequest, type SuitabilityReview } from "./characterPipelineProvider";
import type { CharacterSegmentationResponse } from "../segmentation/segmentationSchema";

type Capability = "generate" | "regenerate" | "variant" | "suitability" | "segment" | "refine-mask" | "reconstruct";

export class HttpCharacterPipelineProvider implements CharacterPipelineProvider {
  readonly id = "http-character-pipeline";
  readonly name = "Configured provider";
  readonly capabilities = {
    segmentation: { available: true, imageConditioned: true, mode: "provider" as const },
    maskRefinement: { available: true, imageConditioned: true },
    reconstruction: { available: true, mode: "provider" as const },
  };
  constructor(private readonly endpoint: string, private readonly fetcher: typeof fetch = fetch) {}
  private async request(capability: Capability, body: unknown): Promise<unknown> {
    const response = await this.fetcher(this.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability, body }) });
    if (!response.ok) throw new Error(`Character provider failed (${response.status})`);
    return response.json() as Promise<unknown>;
  }
  async generateCharacter(request: CharacterGenerationRequest): Promise<CharacterImageGenerationResult> { return validateProviderResult(characterImageGenerationResultSchema, await this.request("generate", request), "Image provider"); }
  async regenerateCharacter(request: CharacterGenerationRequest): Promise<CharacterImageGenerationResult> { return validateProviderResult(characterImageGenerationResultSchema, await this.request("regenerate", request), "Image provider"); }
  async generateVariant(request: CharacterGenerationRequest): Promise<CharacterImageGenerationResult> { return validateProviderResult(characterImageGenerationResultSchema, await this.request("variant", request), "Image provider"); }
  async checkSuitability(request: SuitabilityRequest): Promise<SuitabilityReview> { return validateProviderResult(suitabilityReviewSchema, await this.request("suitability", request), "Suitability provider"); }
  async segmentCharacter(request: CharacterSegmentationRequest): Promise<CharacterSegmentationResponse> { return validateSegmentationProviderResult(await this.request("segment", request)); }
  async refinePartMasks(request: CharacterMaskRefinementRequest): Promise<CharacterSegmentationResponse> { return validateSegmentationProviderResult(await this.request("refine-mask", request)); }
  async reconstructPart(request: OcclusionReconstructionRequest): Promise<OcclusionReconstructionResult> { return validateProviderResult(occlusionReconstructionResultSchema, await this.request("reconstruct", request), "Reconstruction provider"); }
}
