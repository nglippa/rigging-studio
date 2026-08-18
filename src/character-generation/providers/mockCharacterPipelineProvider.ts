import { partTypeToBoneId, partTypeToSlotId, type PartType } from "../segmentation/partTaxonomy";
import type { CharacterSegmentationResponse, ProposedCharacterPart, Rect } from "../segmentation/segmentationSchema";
import type { CharacterGenerationRequest, CharacterImageGenerationResult, CharacterPipelineProvider, OcclusionReconstructionRequest, OcclusionReconstructionResult, SuitabilityRequest, SuitabilityReview } from "./characterPipelineProvider";

type FixturePart = { readonly type: PartType; readonly bounds: Rect; readonly path: string; readonly z: number; readonly warnings?: readonly string[] };
const fixtureParts: readonly FixturePart[] = [
  { type: "torso", bounds: { x: 80, y: 85, width: 96, height: 112 }, path: "/rig-test/parts/torso.png", z: 0 },
  { type: "head", bounds: { x: 98, y: 25, width: 64, height: 76 }, path: "/rig-test/parts/head.png", z: 8 },
  { type: "helmet", bounds: { x: 91, y: 15, width: 78, height: 62 }, path: "/rig-test/parts/helmet.png", z: 9 },
  { type: "leftUpperArm", bounds: { x: 58, y: 92, width: 34, height: 66 }, path: "/rig-test/parts/upper-arm-left.png", z: -3, warnings: ["Part is partially hidden beneath torso armor"] },
  { type: "leftForearm", bounds: { x: 43, y: 143, width: 32, height: 62 }, path: "/rig-test/parts/lower-arm-left.png", z: -2 },
  { type: "leftHand", bounds: { x: 37, y: 195, width: 28, height: 24 }, path: "/rig-test/parts/hand-left.png", z: 4 },
  { type: "rightUpperArm", bounds: { x: 165, y: 92, width: 34, height: 66 }, path: "/rig-test/parts/upper-arm-right.png", z: 2 },
  { type: "rightForearm", bounds: { x: 184, y: 143, width: 32, height: 62 }, path: "/rig-test/parts/lower-arm-right.png", z: 3 },
  { type: "rightHand", bounds: { x: 193, y: 195, width: 28, height: 24 }, path: "/rig-test/parts/hand-right.png", z: 5 },
  { type: "leftThigh", bounds: { x: 86, y: 184, width: 37, height: 65 }, path: "/rig-test/parts/upper-leg-left.png", z: -6, warnings: ["Upper edge is likely occluded by the tabard"] },
  { type: "leftLowerLeg", bounds: { x: 82, y: 238, width: 35, height: 61 }, path: "/rig-test/parts/lower-leg-left.png", z: -5 },
  { type: "leftFoot", bounds: { x: 76, y: 292, width: 48, height: 24 }, path: "/rig-test/parts/foot-left.png", z: -4 },
  { type: "rightThigh", bounds: { x: 133, y: 184, width: 37, height: 65 }, path: "/rig-test/parts/upper-leg-right.png", z: -9 },
  { type: "rightLowerLeg", bounds: { x: 139, y: 238, width: 35, height: 61 }, path: "/rig-test/parts/lower-leg-right.png", z: -8 },
  { type: "rightFoot", bounds: { x: 133, y: 292, width: 48, height: 24 }, path: "/rig-test/parts/foot-right.png", z: -7 },
  { type: "mainHandEquipment", bounds: { x: 208, y: 112, width: 30, height: 145 }, path: "/rig-test/parts/sword-a.png", z: 11 },
  { type: "offHandEquipment", bounds: { x: 12, y: 115, width: 70, height: 92 }, path: "/rig-test/parts/shield.png", z: 10 },
] as const;

const proposedPart = (part: FixturePart, index: number): ProposedCharacterPart => ({
  id: part.type, name: part.type, semanticType: part.type, confidence: part.warnings ? 0.72 : 0.92, bounds: part.bounds, sourceImageRegion: part.bounds,
  suggestedBoneId: partTypeToBoneId(part.type), suggestedSlotId: partTypeToSlotId(part.type), suggestedZIndex: part.z,
  pivotHint: { x: part.bounds.x + part.bounds.width / 2, y: part.bounds.y + Math.min(part.bounds.height * .2, 18) }, warnings: part.warnings ?? [],
  fixtureImagePath: part.path, accepted: true, provenance: index === 0 ? "accepted" : "generated",
});

export class MockCharacterPipelineProvider implements CharacterPipelineProvider {
  readonly id = "local-mock";
  readonly name = "Local deterministic fixture";
  readonly capabilities = {
    segmentation: { available: false, imageConditioned: false, mode: "mock" as const },
    maskRefinement: { available: false, imageConditioned: false },
    reconstruction: { available: false, mode: "mock" as const },
  };
  private sequence = 0;
  private imageResult(request: CharacterGenerationRequest, mode: string): CharacterImageGenerationResult {
    this.sequence += 1;
    return {
      generationId: `mock-${mode}-${this.sequence}`, image: "/rig-test/body-base.png", width: 256, height: 320,
      generationPrompt: request.generationPrompt, generationSettings: { preset: "MODULAR_2D_RIG_CHARACTER", mode },
      seed: request.seed ?? 44021 + this.sequence, providerMetadata: { provider: this.id, offline: true },
      warnings: ["Development fixture: replace the configured server endpoint to generate new artwork"],
      generationMode: "fixture", novelArtwork: false, provider: this.id, sourceArtifact: "/rig-test/body-base.png",
    };
  }
  async generateCharacter(request: CharacterGenerationRequest): Promise<CharacterImageGenerationResult> { return this.imageResult(request, "generate"); }
  async regenerateCharacter(request: CharacterGenerationRequest): Promise<CharacterImageGenerationResult> { return this.imageResult(request, "regenerate"); }
  async generateVariant(request: CharacterGenerationRequest): Promise<CharacterImageGenerationResult> { return this.imageResult(request, "variant"); }
  async checkSuitability(request: SuitabilityRequest): Promise<SuitabilityReview> {
    void request;
    return { usable: true, score: .78, summary: "The source is usable with two likely hidden-area repairs.", issues: [{ type: "limb-overlap", severity: "warning", message: "The rear upper arm meets the torso armor with little visible continuation.", confidence: .81 }, { type: "merged-equipment", severity: "info", message: "Confirm that the tabard remains part of the torso attachment.", confidence: .67 }] };
  }
  async segmentCharacter(request: { readonly generationId: string; readonly image: string; readonly width: number; readonly height: number; readonly expectedEquipment: readonly string[] }): Promise<CharacterSegmentationResponse> {
    const scaleX = request.width / 256; const scaleY = request.height / 320;
    const scaledRect = (bounds: Rect): Rect => { const x = Math.max(0, Math.floor(bounds.x * scaleX)); const y = Math.max(0, Math.floor(bounds.y * scaleY)); return { x, y, width: Math.max(1, Math.min(request.width - x, Math.round(bounds.width * scaleX))), height: Math.max(1, Math.min(request.height - y, Math.round(bounds.height * scaleY))) }; };
    const parts = fixtureParts.map(proposedPart).map((part) => { const bounds = scaledRect(part.bounds); return { ...part, bounds, sourceImageRegion: bounds, pivotHint: { x: Math.min(bounds.x + bounds.width, Math.max(bounds.x, part.pivotHint.x * scaleX)), y: Math.min(bounds.y + bounds.height, Math.max(bounds.y, part.pivotHint.y * scaleY)) } }; });
    return { segmentationId: `segment-${request.generationId}`, imageWidth: request.width, imageHeight: request.height, parts, warnings: ["MOCK FIXTURE: these regions are not image-conditioned", "2 fixture parts need occlusion review"], providerMetadata: { provider: this.id, deterministic: true, mock: true, imageConditioned: false, confidenceSource: "mock-fixture" } };
  }
  async reconstructPart(request: OcclusionReconstructionRequest): Promise<OcclusionReconstructionResult> {
    return { reconstructionId: `repair-${request.generationId}-${request.part.id}`, partId: request.part.id, image: request.part.fixtureImagePath ?? request.image, width: Math.round(request.part.bounds.width), height: Math.round(request.part.bounds.height), providerMetadata: { provider: this.id, offline: true }, warnings: ["Mock reconstruction uses the clean fixture part and must still be accepted"] };
  }
}
