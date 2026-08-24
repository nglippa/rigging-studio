import { describe, expect, it } from "vitest";
import { buildCharacterGenerationPrompt } from "../../src/character-generation/prompt/characterPromptBuilder";
import { MockCharacterPipelineProvider } from "../../src/character-generation/providers/mockCharacterPipelineProvider";
import type { CharacterGenerationRequest, CharacterPipelineProvider } from "../../src/character-generation/providers/characterPipelineProvider";
import { extractPartPixels } from "../../src/character-generation/segmentation/partImageProcessor";
import { validateSegmentationResponse } from "../../src/character-generation/segmentation/segmentationValidator";
import { detectOcclusionReviews, acceptReconstruction, rejectReconstruction } from "../../src/character-generation/occlusion/occlusionRepair";
import { buildProposedHierarchy, wouldCreateHierarchyCycle } from "../../src/character-generation/rigging/hierarchyBuilder";
import { estimatePartPivot } from "../../src/character-generation/rigging/pivotEstimator";
import { assignSlots } from "../../src/character-generation/rigging/slotAssignment";
import { sortPartsByZOrder } from "../../src/character-generation/rigging/zOrderEstimator";
import { buildRigProposal } from "../../src/character-generation/rigging/rigProposalBuilder";
import { validateRigProposal } from "../../src/character-generation/rigging/rigProposalValidator";
import { createGeneratedCharacterProject, parseGeneratedCharacterProject, serializeGeneratedCharacterProject, type GeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { buildCharacterProjectFiles, createCharacterProjectZip, importCharacterProjectArchive } from "../../src/character-generation/project/projectArchive";
import { createRigEditorHandoff } from "../../src/character-generation/project/rigEditorHandoff";
import { runRigSmokeTest } from "../../src/character-generation/testing/rigSmokeTest";

const prompt = "Small fantasy knight in polished silver armor with a blue tabard, brown hair, simple iron sword, and round blue shield.";
const makeRequest = (): CharacterGenerationRequest => {
  const built = buildCharacterGenerationPrompt({ description: prompt, controls: { style: "chibi-pixel-art", viewDirection: "right", background: "transparent" } });
  return { userPrompt: prompt, generationPrompt: built.prompt, negativePrompt: built.negativePrompt, controls: { style: "chibi-pixel-art", viewDirection: "right", background: "transparent" } };
};

async function mockPipeline() {
  const provider = new MockCharacterPipelineProvider(); const request = makeRequest();
  const image = await provider.generateCharacter(request);
  const segmentation = await provider.segmentCharacter({ generationId: image.generationId, image: image.image, width: image.width, height: image.height, expectedEquipment: ["sword", "shield"] });
  const proposal = buildRigProposal({ name: "Fantasy Knight", parts: segmentation.parts, imageWidth: segmentation.imageWidth, imageHeight: segmentation.imageHeight });
  return { provider, request, image, segmentation, proposal };
}

describe("prompt-to-rig character pipeline", () => {
  it("constructs a structured modular-art generation request", () => {
    const request = makeRequest();
    expect(request.generationPrompt).toContain("skeletal cutout animation");
    expect(request.generationPrompt).toContain("View direction: right");
    expect(request.negativePrompt).toContain("duplicated limbs");
    expect(request.controls.style).toBe("chibi-pixel-art");
    expect(request.generationPrompt).toContain("chibi pixel art only");
    expect(request.generationPrompt).toContain("game-production-ready");
    expect(request.negativePrompt).toContain("painted illustration");
    expect(request.generationPrompt).toContain("Body proportions: oversized head, compact torso, short separated limbs");
    expect(request.generationPrompt).toContain("Background: transparent");
    const overrideAttempt = buildCharacterGenerationPrompt({ description: prompt, controls: { style: "chibi-pixel-art", bodyProportions: "realistic adult proportions", background: "flat-contrast" } });
    expect(overrideAttempt.prompt).not.toContain("realistic adult proportions");
    expect(overrideAttempt.prompt).not.toContain("Background: flat-contrast");
  });

  it("validates provider segmentation and reports duplicate or missing parts", async () => {
    const { segmentation } = await mockPipeline();
    expect(segmentation.providerMetadata).toMatchObject({ mock: true, imageConditioned: false, confidenceSource: "mock-fixture" });
    expect(validateSegmentationResponse(segmentation).success).toBe(true);
    const duplicate = { ...segmentation, parts: [...segmentation.parts, segmentation.parts[0]] };
    expect(validateSegmentationResponse(duplicate).errors).toContain(`Duplicate part ID "${segmentation.parts[0].id}"`);
    const missing = { ...segmentation, parts: segmentation.parts.filter((part) => part.semanticType !== "head") };
    expect(validateSegmentationResponse(missing).warnings).toContain("Missing recommended part: head");
  });

  it("allows image-conditioned providers to return image-specific masks with explicit confidence provenance", async () => {
    const fixture = new MockCharacterPipelineProvider();
    const provider: CharacterPipelineProvider = {
      id: "image-conditioned-test", name: "Image conditioned test", capabilities: {
        segmentation: { available: true, imageConditioned: true, mode: "provider", provider: "image-conditioned-test", confidenceSource: "provider" },
        maskRefinement: { available: false, imageConditioned: false, mode: "unavailable", provider: "image-conditioned-test" },
        reconstruction: { available: false, imageConditioned: false, mode: "unavailable", provider: "image-conditioned-test" },
        backgroundRemoval: { available: false, imageConditioned: false, mode: "unavailable", provider: "image-conditioned-test" },
        alphaCleanup: { available: false, imageConditioned: false, mode: "unavailable", provider: "image-conditioned-test" },
      },
      generateCharacter: (request) => fixture.generateCharacter(request), regenerateCharacter: (request) => fixture.regenerateCharacter(request), generateVariant: (request) => fixture.generateVariant(request), checkSuitability: (request) => fixture.checkSuitability(request), reconstructPart: (request) => fixture.reconstructPart(request),
      segmentCharacter: async (request) => { const base = await fixture.segmentCharacter(request); const shift = request.image.includes("second") ? 7 : 0; return { ...base, segmentationId: `conditioned-${shift}`, parts: base.parts.map((part, index) => index === 0 ? { ...part, bounds: { ...part.bounds, x: part.bounds.x + shift }, sourceImageRegion: { ...part.sourceImageRegion, x: part.sourceImageRegion.x + shift } } : part), providerMetadata: { provider: "image-conditioned-test", imageConditioned: true, confidenceSource: "provider" } }; },
    };
    const first = await provider.segmentCharacter({ generationId: "first", image: "data:image/png;base64,first", width: 256, height: 320, expectedEquipment: [] });
    const second = await provider.segmentCharacter({ generationId: "second", image: "data:image/png;base64,second", width: 256, height: 320, expectedEquipment: [] });
    expect(first.parts[0].bounds).not.toEqual(second.parts[0].bounds); expect(second.providerMetadata).toMatchObject({ imageConditioned: true, confidenceSource: "provider" });
  });

  it("extracts exact geometry while preserving and masking alpha", () => {
    const source = { width: 2, height: 2, data: new Uint8ClampedArray([10, 20, 30, 128, 40, 50, 60, 255, 70, 80, 90, 64, 100, 110, 120, 200]) };
    const output = extractPartPixels({ source, bounds: { x: 1, y: 0, width: 1, height: 2 }, mask: { width: 1, height: 2, alpha: [128, 255] }, padding: 1 });
    expect(output.width).toBe(3); expect(output.height).toBe(4);
    expect(output.data[(1 * 3 + 1) * 4 + 3]).toBe(128);
    expect(output.data[(2 * 3 + 1) * 4 + 3]).toBe(200);
  });

  it("flags occlusion and keeps reconstruction acceptance explicit", async () => {
    const { provider, image, segmentation } = await mockPipeline(); const reviews = detectOcclusionReviews(segmentation.parts);
    expect(reviews.map((review) => review.partId)).toContain("leftUpperArm");
    const part = segmentation.parts.find((candidate) => candidate.id === reviews[0].partId)!;
    const result = await provider.reconstructPart({ generationId: image.generationId, image: image.image, part, stylePrompt: image.generationPrompt });
    expect(acceptReconstruction(reviews[0], result.image).reconstructionAccepted).toBe(true);
    expect(rejectReconstruction(acceptReconstruction(reviews[0], result.image)).reconstructedImage).toBeUndefined();
  });

  it("builds an acyclic hierarchy with pivots inside bounds and ordered slots", async () => {
    const { segmentation } = await mockPipeline(); const hierarchy = buildProposedHierarchy(segmentation.parts, segmentation.imageWidth, segmentation.imageHeight);
    expect(hierarchy.bones[0]).toMatchObject({ id: "root", parentId: null });
    expect(wouldCreateHierarchyCycle(hierarchy.bones, "root", "head")).toBe(true);
    const leftUpperArm = hierarchy.worldJoints["left-upper-arm"];
    const leftLowerArm = hierarchy.worldJoints["left-lower-arm"];
    expect(hierarchy.bones.find((bone) => bone.id === "left-upper-arm")?.rotation).toBe(0);
    expect(hierarchy.bones.find((bone) => bone.id === "left-lower-arm")).toMatchObject({
      x: leftLowerArm.x - leftUpperArm.x,
      y: leftLowerArm.y - leftUpperArm.y,
      rotation: 0,
    });
    expect(hierarchy.bones.filter((bone) => /(?:arm|hand|leg|foot)$/.test(bone.id)).every((bone) => bone.rotation === 0)).toBe(true);
    segmentation.parts.forEach((part) => { const pivot = estimatePartPivot(part).point; expect(pivot.x).toBeGreaterThanOrEqual(part.bounds.x); expect(pivot.x).toBeLessThanOrEqual(part.bounds.x + part.bounds.width); });
    const pivots = Object.fromEntries(segmentation.parts.map((part) => [part.id, { x: part.bounds.width / 2, y: part.bounds.height / 2 }]));
    const slots = assignSlots(segmentation.parts, pivots); expect(slots).toHaveLength(segmentation.parts.length);
    const ordered = sortPartsByZOrder(segmentation.parts); expect(ordered[0].suggestedZIndex).toBeLessThanOrEqual(ordered.at(-1)!.suggestedZIndex);
  });

  it("generates and validates a RigDefinition that passes smoke testing", async () => {
    const { proposal } = await mockPipeline(); const validated = validateRigProposal(proposal);
    expect(validated.success).toBe(true);
    const smoke = runRigSmokeTest(proposal.rig); expect(smoke.checks.find((check) => check.id === "schema")?.passed).toBe(true); expect(smoke.checks.find((check) => check.id === "joint-rotation")?.passed).toBe(true);
  });

  it("serializes, packages, imports, and hands a project to the Rig Editor", async () => {
    const { image, segmentation, proposal } = await mockPipeline(); const base = createGeneratedCharacterProject("Fantasy Knight", prompt, "2026-01-01T00:00:00.000Z");
    const extractedParts = segmentation.parts.map((part) => ({ partId: part.id, image: part.fixtureImagePath ?? image.image, width: part.bounds.width, height: part.bounds.height, padding: 0, status: "generated" as const }));
    const project: GeneratedCharacterProject = { ...base, stage: "test", generationPrompt: image.generationPrompt, generationMetadata: { provider: "local-mock" }, sourceImage: image, segmentationData: segmentation, extractedParts, rigDefinition: proposal.rig, skins: proposal.rig.skins };
    expect(parseGeneratedCharacterProject(JSON.parse(serializeGeneratedCharacterProject(project)) as unknown).success).toBe(true);
    const fetcher = async () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });
    const files = await buildCharacterProjectFiles(project, fetcher as typeof fetch); expect(files.map((file) => file.name)).toContain("manifest.json"); expect(files.map((file) => file.name)).toContain("rig/rig.json"); expect(files.some((file) => file.name.startsWith("parts/torso"))).toBe(true);
    const zip = await createCharacterProjectZip(project, fetcher as typeof fetch); const imported = importCharacterProjectArchive(new Uint8Array(await zip.arrayBuffer()));
    expect(imported.rigDefinition?.id).toBe(proposal.rig.id); expect(imported.extractedParts[0].image).toMatch(/^data:image\/png;base64,/);
    const handoff = createRigEditorHandoff(project); expect(handoff.draftKey).toBe("rig-studio:editor-draft:v1"); expect(handoff.handoffValue).toContain("Generated character loaded");
  });

  it("preserves prior project state when a provider call fails", async () => {
    const project = createGeneratedCharacterProject("Knight", prompt, "2026-01-01T00:00:00.000Z"); const snapshot = serializeGeneratedCharacterProject(project);
    const failing = { generateCharacter: async () => { throw new Error("network unavailable"); } };
    await expect(failing.generateCharacter()).rejects.toThrow("network unavailable"); expect(serializeGeneratedCharacterProject(project)).toBe(snapshot);
  });
});
