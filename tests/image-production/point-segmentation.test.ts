import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { ImageProposalStorage } from "../../src/image-production/assets/imageProposalStorage";
import { ComfyUIAdapter } from "../../src/image-production/comfy/ComfyUIAdapter";
import type { ImageProductionProvider, ImageProviderExecutionResult, ImageProviderStatus } from "../../src/image-production/providers/imageProductionProvider";
import { ComfyCharacterPipelineService } from "../../src/image-production/service/ComfyCharacterPipelineService";
import { ImageProductionService } from "../../src/image-production/service/ImageProductionService";
import { TrustedWorkflowRegistry } from "../../src/image-production/workflows/registry";
import type { ComfyApiWorkflow } from "../../src/image-production/workflows/workflowManifest";

async function pointRegistry(): Promise<{ cwd: string; registry: TrustedWorkflowRegistry }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "comfy-points-")); const root = path.join(cwd, "comfy-workflows"); await mkdir(root, { recursive: true });
  for (const file of ["point-segmentation.manifest.json", "point-segmentation.json"]) await copyFile(new URL(`../../comfy-workflows/${file}`, import.meta.url), path.join(root, file));
  return { cwd, registry: new TrustedWorkflowRegistry({ rootDirectory: root }) };
}
function solidPng(width: number, height: number): string {
  const png = new PNG({ width, height }); png.data.fill(255);
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}
/** A grey mask whose pixel value is `value(x, y)`. */
function greyMask(width: number, height: number, value: (x: number, y: number) => number): Uint8Array {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const o = (y * width + x) * 4; png.data[o] = png.data[o + 1] = png.data[o + 2] = value(x, y); png.data[o + 3] = 255; }
  return PNG.sync.write(png);
}

class FakeComfy implements ImageProductionProvider {
  readonly id = "comfyui"; readonly name = "fake"; readonly workflows: ComfyApiWorkflow[] = [];
  reachable = true; statusCalls = 0; onStatus: (() => void) | null = null;
  constructor(private readonly mask: Uint8Array) {}
  async status(): Promise<ImageProviderStatus> { this.statusCalls += 1; this.onStatus?.(); return { provider: "comfyui", reachable: this.reachable, url: "http://127.0.0.1:8188", queue: { running: 0, pending: 0 }, message: this.reachable ? "ready" : "connection refused" }; }
  async inspectDependencies() { return { available: true, missingNodeClasses: [], missingModels: [] }; }
  async uploadImage(name: string) { return name; }
  async submit(workflow: ComfyApiWorkflow) { this.workflows.push(workflow); return { promptId: "p1" }; }
  async waitForCompletion(promptId: string): Promise<ImageProviderExecutionResult> { return { promptId, outputs: [{ bytes: this.mask, mimeType: "image/png", providerAsset: { filename: "m.png", subfolder: "", type: "output" } }], warnings: [] }; }
}

async function serviceWith(provider: ImageProductionProvider, wake?: ConstructorParameters<typeof ComfyCharacterPipelineService>[1]) {
  const { cwd, registry } = await pointRegistry();
  return new ComfyCharacterPipelineService(new ImageProductionService({ provider, registry, storage: new ImageProposalStorage({ cwd }) }), wake);
}

describe("POINT_SEGMENTATION", () => {
  it("omits coordinates_negative when there are no negative points and includes it when given", async () => {
    const provider = new FakeComfy(greyMask(6, 4, () => 255)); const service = await serviceWith(provider);
    await service.segmentAtPoints({ image: solidPng(6, 4), width: 6, height: 4, positive: [{ x: 2, y: 1 }] });
    await service.segmentAtPoints({ image: solidPng(6, 4), width: 6, height: 4, positive: [{ x: 2, y: 1 }, { x: 3, y: 2 }], negative: [{ x: 5, y: 3 }] });
    const [without, withNegative] = provider.workflows;
    expect(without?.["3"]?.inputs).not.toHaveProperty("coordinates_negative");
    expect(JSON.parse(String(without?.["3"]?.inputs.coordinates_positive))).toEqual([{ x: 2, y: 1 }]);
    expect(without?.["3"]?.inputs).toMatchObject({ keep_model_loaded: true, individual_objects: false });
    expect(without?.["2"]?.inputs.model).toBe("sam2.1_hiera_base_plus.safetensors");
    expect(JSON.parse(String(withNegative?.["3"]?.inputs.coordinates_negative))).toEqual([{ x: 5, y: 3 }]);
    expect(JSON.parse(String(withNegative?.["3"]?.inputs.coordinates_positive))).toHaveLength(2);
  });

  it("uses COMFYUI_SAM2_POINT_MODEL when set", async () => {
    const previous = process.env.COMFYUI_SAM2_POINT_MODEL; process.env.COMFYUI_SAM2_POINT_MODEL = "other.safetensors";
    try {
      const provider = new FakeComfy(greyMask(4, 4, () => 0)); const service = await serviceWith(provider);
      await service.segmentAtPoints({ image: solidPng(4, 4), width: 4, height: 4, positive: [{ x: 1, y: 1 }] });
      expect(provider.workflows[0]?.["2"]?.inputs.model).toBe("other.safetensors");
    } finally { if (previous === undefined) delete process.env.COMFYUI_SAM2_POINT_MODEL; else process.env.COMFYUI_SAM2_POINT_MODEL = previous; }
  });

  it("thresholds the grey mask at 128 into a full-canvas 0/255 mask", async () => {
    const provider = new FakeComfy(greyMask(4, 2, (x) => [0, 127, 128, 255][x]!)); const service = await serviceWith(provider);
    const result = await service.segmentAtPoints({ image: solidPng(4, 2), width: 4, height: 2, positive: [{ x: 0, y: 0 }] });
    expect([result.width, result.height]).toEqual([4, 2]);
    expect(result.alpha).toEqual([0, 0, 255, 255, 0, 0, 255, 255]);
    expect(result.runtimeMs).toBeGreaterThanOrEqual(0);
  });

  it("validates points before touching ComfyUI", async () => {
    const provider = new FakeComfy(greyMask(4, 4, () => 255)); const service = await serviceWith(provider);
    const base = { image: solidPng(4, 4), width: 4, height: 4 };
    await expect(service.segmentAtPoints({ ...base, positive: [] })).rejects.toThrow(/at least one positive/i);
    await expect(service.segmentAtPoints({ ...base, positive: [{ x: 4, y: 0 }] })).rejects.toThrow(/outside the 4×4 image/);
    await expect(service.segmentAtPoints({ ...base, positive: [{ x: 1, y: 1 }], negative: [{ x: -1, y: 0 }] })).rejects.toThrow(/negative point 1/);
    await expect(service.segmentAtPoints({ ...base, positive: [{ x: Number.NaN, y: 0 }] })).rejects.toThrow(/not a number pair/);
    await expect(service.segmentAtPoints({ ...base, width: 5, positive: [{ x: 1, y: 1 }] })).rejects.toThrow(/declares 5×4/);
    expect(provider.workflows).toHaveLength(0);
  });

  it("wakes an unreachable engine once through COMFYUI_WAKE_URL, then succeeds", async () => {
    const provider = new FakeComfy(greyMask(4, 4, () => 255)); provider.reachable = false;
    const wakeCalls: string[] = [];
    const fetcher = (async (url: string) => { wakeCalls.push(String(url)); setTimeout(() => { provider.reachable = true; }, 5); return new Response("ok"); }) as unknown as typeof fetch;
    const service = await serviceWith(provider, { wakeUrl: "http://10.77.77.2:8193/", wakePollMs: 10, wakeTimeoutMs: 2_000, fetcher });
    const result = await service.segmentAtPoints({ image: solidPng(4, 4), width: 4, height: 4, positive: [{ x: 1, y: 1 }] });
    expect(wakeCalls).toEqual(["http://10.77.77.2:8193/"]);
    expect(result.alpha).toHaveLength(16);
  });

  it("fails with the offline reason when the wake does not bring the engine up, and never wakes when unset", async () => {
    const stuck = new FakeComfy(greyMask(4, 4, () => 255)); stuck.reachable = false; let woke = 0;
    const fetcher = (async () => { woke += 1; return new Response("ok"); }) as unknown as typeof fetch;
    const request = { image: solidPng(4, 4), width: 4, height: 4, positive: [{ x: 1, y: 1 }] };
    await expect((await serviceWith(stuck, { wakeUrl: "http://10.77.77.2:8193/", wakePollMs: 5, wakeTimeoutMs: 30, fetcher })).segmentAtPoints(request)).rejects.toThrow(/ComfyUI is offline/);
    expect(woke).toBe(1);
    const previous = process.env.COMFYUI_WAKE_URL; delete process.env.COMFYUI_WAKE_URL;
    try {
      woke = 0;
      await expect((await serviceWith(stuck, { fetcher })).segmentAtPoints(request)).rejects.toThrow(/ComfyUI is offline/);
      expect(woke).toBe(0);
    } finally { if (previous !== undefined) process.env.COMFYUI_WAKE_URL = previous; }
  });

  it("reports unavailable with a plain reason unless /object_info lists both SAM2 point nodes", async () => {
    const statusWith = async (objectInfo: Record<string, unknown>) => {
      const fetcher = (async (url: string) => new Response(JSON.stringify(String(url).endsWith("/object_info") ? objectInfo : { queue_running: [], queue_pending: [] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
      const { cwd, registry } = await pointRegistry();
      const service = new ComfyCharacterPipelineService(new ImageProductionService({ provider: new ComfyUIAdapter({ fetcher, baseUrl: "http://127.0.0.1:8188" }), registry, storage: new ImageProposalStorage({ cwd }) }));
      return (await service.status()).capabilities.pointSegmentation;
    };
    const base = { LoadImage: {}, MaskToImage: {}, SaveImage: {} };
    const missing = await statusWith({ ...base });
    expect(missing).toMatchObject({ available: false, mode: "unavailable" });
    expect(missing?.reason).toMatch(/ComfyUI-segment-anything-2/);
    expect(missing?.reason).toMatch(/Sam2Segmentation/);
    const present = await statusWith({ ...base, Sam2Segmentation: {}, DownloadAndLoadSAM2Model: { input: { required: { model: [["sam2.1_hiera_base_plus.safetensors"]] } } } });
    expect(present).toMatchObject({ available: true, mode: "provider", workflow: "point_segmentation_v1" });
  });
});
