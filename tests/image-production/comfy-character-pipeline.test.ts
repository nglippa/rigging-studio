import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { ImageProposalStorage } from "../../src/image-production/assets/imageProposalStorage";
import type { ImageProductionProvider, ImageProviderExecutionResult, ImageProviderStatus } from "../../src/image-production/providers/imageProductionProvider";
import { ComfyCharacterPipelineService } from "../../src/image-production/service/ComfyCharacterPipelineService";
import { ImageProductionService } from "../../src/image-production/service/ImageProductionService";
import { TrustedWorkflowRegistry } from "../../src/image-production/workflows/registry";
import type { ComfyApiWorkflow } from "../../src/image-production/workflows/workflowManifest";

const WORKFLOWS = ["character-segmentation", "mask-refinement", "occlusion-reconstruction"] as const;

async function characterRegistry(cwd: string): Promise<TrustedWorkflowRegistry> {
  const root = path.join(cwd, "comfy-workflows"); await mkdir(root, { recursive: true });
  for (const name of WORKFLOWS) {
    await copyFile(new URL(`../../comfy-workflows/${name}.manifest.json`, import.meta.url), path.join(root, `${name}.manifest.json`));
    await copyFile(new URL(`../../comfy-workflows/${name}.json`, import.meta.url), path.join(root, `${name}.json`));
  }
  return new TrustedWorkflowRegistry({ rootDirectory: root });
}

class ImageConditionedProvider implements ImageProductionProvider {
  readonly id = "comfyui"; readonly name = "Fake image-conditioned ComfyUI";
  readonly uploads = new Map<string, Uint8Array>();
  readonly segmentationPrompts: string[] = [];
  private workflow: ComfyApiWorkflow | null = null;
  async status(): Promise<ImageProviderStatus> { return { provider: "comfyui", reachable: true, url: "http://127.0.0.1:8188", queue: { running: 0, pending: 0 }, message: "ready" }; }
  async inspectDependencies() { return { available: true, missingNodeClasses: [], missingModels: [] }; }
  async uploadImage(name: string, bytes: Uint8Array) { this.uploads.set(name, Uint8Array.from(bytes)); return name; }
  async submit(workflow: ComfyApiWorkflow) { this.workflow = workflow; return { promptId: `prompt-${this.uploads.size}` }; }
  async waitForCompletion(promptId: string): Promise<ImageProviderExecutionResult> {
    if (!this.workflow) throw new Error("No workflow submitted");
    const isRefinement = Object.values(this.workflow).some((node) => node.class_type === "MaskComposite");
    const isReconstruction = Object.values(this.workflow).some((node) => node.class_type === "VAEEncodeForInpaint");
    let bytes: Uint8Array;
    if (isReconstruction) {
      const sourceName = String(this.workflow["1"]?.inputs.image); bytes = this.uploads.get(sourceName) ?? new Uint8Array();
    } else if (isRefinement) {
      const maskName = String(this.workflow["5"]?.inputs.image); const current = PNG.sync.read(Buffer.from(this.uploads.get(maskName) ?? []));
      const operation = String(this.workflow["7"]?.inputs.operation); const target = (0 * current.width + current.width - 1) * 4;
      current.data[target] = operation === "subtract" ? 0 : 255; current.data[target + 1] = current.data[target]; current.data[target + 2] = current.data[target]; current.data[target + 3] = 255;
      bytes = PNG.sync.write(current);
    } else {
      const sourceName = String(this.workflow["1"]?.inputs.image); const source = PNG.sync.read(Buffer.from(this.uploads.get(sourceName) ?? []));
      const prompt = String(this.workflow["4"]?.inputs.prompt).toLowerCase();
      const crop = {
        x: Number(this.workflow["7"]?.inputs.x), y: Number(this.workflow["7"]?.inputs.y),
        width: Number(this.workflow["7"]?.inputs.width), height: Number(this.workflow["7"]?.inputs.height),
      };
      const mask = new PNG({ width: crop.width, height: crop.height });
      this.segmentationPrompts.push(prompt);
      const blueFixture = source.data[2] > source.data[0];
      const headPixels: readonly [number, number][] = blueFixture ? [[1, 0], [1, 1], [2, 1]] : [[0, 0], [1, 0], [0, 1], [1, 1]];
      const torsoPixels: readonly [number, number][] = [[2, 3], [3, 3], [2, 4], [3, 4], [2, 5], [3, 5]];
      const pixels: readonly [number, number][] = prompt === "person"
        ? [...headPixels, ...torsoPixels]
        : prompt.includes("head")
        ? blueFixture ? [[1, 0], [1, 1], [2, 1]] : [[0, 0], [1, 0], [0, 1], [1, 1]]
        : /torso|chest|armor/.test(prompt) ? torsoPixels : [];
      pixels.forEach(([sourceX, sourceY]) => {
        const x = sourceX - crop.x; const y = sourceY - crop.y;
        if (x < 0 || y < 0 || x >= crop.width || y >= crop.height) return;
        const offset = (y * crop.width + x) * 4; mask.data[offset] = 255; mask.data[offset + 1] = 255; mask.data[offset + 2] = 255; mask.data[offset + 3] = 255;
      });
      bytes = PNG.sync.write(mask);
    }
    return { promptId, outputs: [{ bytes, mimeType: "image/png", providerAsset: { filename: `${promptId}.png`, subfolder: "", type: "output" } }], warnings: [] };
  }
}

function sourcePng(color: "red" | "blue"): Uint8Array {
  const png = new PNG({ width: 8, height: 8 });
  for (let index = 0; index < 64; index += 1) { const offset = index * 4; png.data[offset] = color === "red" ? 255 : 0; png.data[offset + 2] = color === "blue" ? 255 : 0; png.data[offset + 3] = 255; }
  return PNG.sync.write(png);
}
const dataUrl = (bytes: Uint8Array): string => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
const context = {
  projectId: "project-a", sourceImageId: "source-a", sourceCanvasWidth: 8, sourceCanvasHeight: 8, characterPrompt: "knight", stylePrompt: "flat sprite",
  generationProvider: "fixture", canonicalScale: { width: 8, height: 8 }, acceptedParts: [], semanticBBoxes: {}, jointHints: {}, paletteHints: [], equipmentHints: [], referenceAssetIds: ["source-a"],
} as const;

describe("real character pipeline contract over trusted Comfy workflows", () => {
  it("keeps masks source-conditioned, pixel-accurate, semantically labeled, truthful, unresolved, and managed", async () => {
    const previousSam = process.env.COMFYUI_SAM2_MODEL; const previousDino = process.env.COMFYUI_GROUNDING_DINO_MODEL;
    process.env.COMFYUI_SAM2_MODEL = "sam2.pt"; process.env.COMFYUI_GROUNDING_DINO_MODEL = "grounding-dino.pth";
    try {
      const cwd = await mkdtemp(path.join(tmpdir(), "comfy-character-")); const provider = new ImageConditionedProvider();
      const production = new ImageProductionService({ provider, registry: await characterRegistry(cwd), storage: new ImageProposalStorage({ cwd }) }); const service = new ComfyCharacterPipelineService(production);
      const base = { width: 8, height: 8, expectedEquipment: [], taxonomy: ["head", "torso", "leftHand"] as const, consistencyContext: context };
      const red = await service.segmentCharacter({ ...base, generationId: "red", image: dataUrl(sourcePng("red")), semanticPrompt: "cut the whole swordsman into head torso left hand sword and shield" });
      expect(provider.segmentationPrompts).toEqual(["person", "head", "human head", "chest armor", "torso", "body armor", "chest and abdomen", "hand", "gloved hand"]);
      expect(provider.segmentationPrompts).not.toContain("cut the whole swordsman into head torso left hand sword and shield");
      const blue = await service.segmentCharacter({ ...base, generationId: "blue", image: dataUrl(sourcePng("blue")) });
      expect(red.parts.map((part) => part.semanticType)).toEqual(["head", "torso"]);
      expect(red.warnings.some((warning) => warning.startsWith("Unresolved leftHand:"))).toBe(true);
      expect(red.parts.every((part) => part.confidence !== null && part.confidenceSource === "heuristic")).toBe(true);
      expect(red.parts.every((part) => part.warnings.some((warning) => warning.includes("detectorConfidence=unavailable")))).toBe(true);
      expect(red.parts.filter((part) => part.accepted)).toHaveLength(Number(red.providerMetadata.safeCount));
      expect(red.parts.filter((part) => part.accepted).every((part) => part.warnings.length > 0)).toBe(true);
      expect(red.parts.every((part) => part.mask?.width === Math.round(part.bounds.width) && part.mask?.height === Math.round(part.bounds.height))).toBe(true);
      expect(red.parts[0]?.mask?.alpha).not.toEqual(blue.parts[0]?.mask?.alpha);
      expect(red.parts[0]?.sourceImageRegion).toEqual(red.parts[0]?.bounds);
      const managedProposalId = String(red.providerMetadata.managedProposalId); const metadata = await readFile(path.join(cwd, ".rigging-studio", "image-production", "proposals", managedProposalId, "metadata.json"), "utf8");
      expect(metadata).toContain("CHARACTER_SEGMENTATION");
      expect(metadata).toContain("detectorPhrase");
      expect(metadata).toContain("sourceCrop");
      expect(metadata).toContain("detectorConfidenceAvailable");
      expect(red.providerMetadata).toMatchObject({ workflow: "character_segmentation_staged_v2", detectorBoxesAvailable: false, detectorConfidenceAvailable: false, detectorCalls: 9 });

      const refined = await service.refinePartMasks({ generationId: "red", image: dataUrl(sourcePng("red")), width: 8, height: 8, current: red, instruction: "Include the rest of the head silhouette", targetPartId: "head", consistencyContext: context });
      expect(refined.parts.find((part) => part.id === "torso")).toEqual(red.parts.find((part) => part.id === "torso"));
      expect(refined.parts.find((part) => part.id === "head")?.mask).not.toEqual(red.parts.find((part) => part.id === "head")?.mask);
      expect(refined.providerMetadata.targetPartId).toBe("head");
    } finally {
      if (previousSam === undefined) delete process.env.COMFYUI_SAM2_MODEL; else process.env.COMFYUI_SAM2_MODEL = previousSam;
      if (previousDino === undefined) delete process.env.COMFYUI_GROUNDING_DINO_MODEL; else process.env.COMFYUI_GROUNDING_DINO_MODEL = previousDino;
    }
  });

  it("normalizes reconstruction to the selected part and preserves managed proposal metadata", async () => {
    const previous = process.env.COMFYUI_CHECKPOINT; process.env.COMFYUI_CHECKPOINT = "inpaint.safetensors";
    try {
      const cwd = await mkdtemp(path.join(tmpdir(), "comfy-reconstruct-")); const provider = new ImageConditionedProvider();
      const production = new ImageProductionService({ provider, registry: await characterRegistry(cwd), storage: new ImageProposalStorage({ cwd }) }); const service = new ComfyCharacterPipelineService(production);
      const part = { id: "leftForearm", name: "Left Forearm", semanticType: "leftForearm" as const, confidence: null, confidenceSource: "unavailable" as const, bounds: { x: 2, y: 2, width: 3, height: 4 }, mask: { width: 3, height: 4, alpha: new Array(12).fill(255) }, sourceImageRegion: { x: 2, y: 2, width: 3, height: 4 }, suggestedBoneId: "left-forearm", suggestedSlotId: "left-forearm-slot", suggestedZIndex: 1, pivotHint: { x: 3, y: 2 }, warnings: ["partly hidden"], accepted: true, provenance: "accepted" as const };
      const result = await service.reconstructPart({ generationId: "source-a", image: dataUrl(sourcePng("red")), part, stylePrompt: "flat sprite", reconstructionMask: { width: 2, height: 2, alpha: [255, 255, 255, 255] }, reconstructionMaskBounds: { x: 3, y: 4, width: 2, height: 2 }, expectedPivot: part.pivotHint, consistencyContext: context });
      expect(result).toMatchObject({ partId: "leftForearm", width: 3, height: 4, providerMetadata: { scaleLocked: true, managedProposalId: expect.stringContaining("pipeline-occlusion-reconstruction") } });
      const decoded = PNG.sync.read(Buffer.from(result.image.slice(result.image.indexOf(",") + 1), "base64")); expect([decoded.width, decoded.height]).toEqual([3, 4]);
      await expect(production.getProposal(String(result.providerMetadata.managedProposalId))).resolves.toMatchObject({ status: "awaiting_review", operationType: "OCCLUSION_RECONSTRUCTION", targetPartId: "leftForearm" });
    } finally { if (previous === undefined) delete process.env.COMFYUI_CHECKPOINT; else process.env.COMFYUI_CHECKPOINT = previous; }
  });
});
