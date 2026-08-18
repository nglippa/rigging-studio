import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ImageProposalStorage } from "../../src/image-production/assets/imageProposalStorage";
import { ComfyUIAdapter, validateComfyBaseUrl } from "../../src/image-production/comfy/ComfyUIAdapter";
import type { ImageProductionProvider, ImageProviderExecutionResult, ImageProviderProgress, ImageProviderStatus } from "../../src/image-production/providers/imageProductionProvider";
import { ImageProductionService } from "../../src/image-production/service/ImageProductionService";
import { TrustedWorkflowRegistry } from "../../src/image-production/workflows/registry";
import type { ComfyApiWorkflow } from "../../src/image-production/workflows/workflowManifest";
import { RiggingCommandService } from "../../src/agent-control/commands/RiggingCommandService";

const fixture = new URL("../../public/rig-test/body-base.png", import.meta.url);

async function trustedRegistry(cwd: string): Promise<TrustedWorkflowRegistry> {
  const root = path.join(cwd, "comfy-workflows"); await mkdir(root, { recursive: true });
  await copyFile(new URL("../../comfy-workflows/character-generation.manifest.json", import.meta.url), path.join(root, "character-generation.manifest.json"));
  await copyFile(new URL("../../comfy-workflows/character-generation.json", import.meta.url), path.join(root, "character-generation.json"));
  return new TrustedWorkflowRegistry({ rootDirectory: root });
}

async function registryForCapability(cwd: string, capability: "OCCLUSION_RECONSTRUCTION" | "ALPHA_EDGE_CLEANUP"): Promise<TrustedWorkflowRegistry> {
  const root = path.join(cwd, "comfy-workflows"); await mkdir(root, { recursive: true });
  const workflowFile = `${capability.toLowerCase()}.json`; const manifestFile = `${capability.toLowerCase()}.manifest.json`;
  await copyFile(new URL("../../comfy-workflows/character-generation.json", import.meta.url), path.join(root, workflowFile));
  const base = JSON.parse(await readFile(new URL("../../comfy-workflows/character-generation.manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const inputs = base.inputs as Record<string, unknown>;
  await writeFile(path.join(root, manifestFile), JSON.stringify({ ...base, id: `${capability.toLowerCase()}_test`, capability, workflowFile, requiredModels: [], inputs: { ...inputs, sourceImage: { nodeId: "6", field: "source_image", required: true, defaultValue: "" }, maskImage: { nodeId: "7", field: "mask_image", required: true, defaultValue: "" } } }));
  return new TrustedWorkflowRegistry({ rootDirectory: root });
}

class MockImageProvider implements ImageProductionProvider {
  readonly id = "comfyui"; readonly name = "Mock ComfyUI";
  readonly submissions: ComfyApiWorkflow[] = [];
  attempts = 0;
  constructor(private readonly bytes: Uint8Array, private readonly failAttempts: readonly number[] = []) {}
  async status(): Promise<ImageProviderStatus> { return { provider: "comfyui", reachable: true, url: "http://127.0.0.1:8188", queue: { running: 0, pending: 0 }, message: "ready" }; }
  async inspectDependencies() { return { available: true, missingNodeClasses: [], missingModels: [] }; }
  async submit(workflow: ComfyApiWorkflow) { this.submissions.push(workflow); this.attempts += 1; return { promptId: `prompt-${this.attempts}` }; }
  async waitForCompletion(promptId: string, _outputNodeId: string, onProgress?: (progress: ImageProviderProgress) => void): Promise<ImageProviderExecutionResult> {
    onProgress?.({ phase: "sampling", percent: 50, message: "sampling" });
    if (this.failAttempts.includes(this.attempts)) throw new Error(`node failure ${this.attempts}`);
    return { promptId, outputs: [{ bytes: this.bytes, mimeType: "image/png", providerAsset: { filename: `${promptId}.png`, subfolder: "", type: "output" } }], warnings: [] };
  }
  async uploadImage(name: string) { return `managed-input/${name}`; }
}

describe("trusted ComfyUI image production", () => {
  it("restricts ComfyUI to localhost and reconnects on a later status check without hidden retries", async () => {
    expect(validateComfyBaseUrl("http://127.0.0.1:8188/")).toBe("http://127.0.0.1:8188");
    expect(() => validateComfyBaseUrl("https://example.com:8188")).toThrow("localhost");
    let calls = 0;
    const adapter = new ComfyUIAdapter({ fetcher: async () => { calls += 1; if (calls === 1) throw new Error("offline"); return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), { status: 200 }); } });
    await expect(adapter.status()).resolves.toMatchObject({ reachable: false });
    expect(calls).toBe(1);
    await expect(adapter.status()).resolves.toMatchObject({ reachable: true });
    expect(calls).toBe(2);
  });

  it("discovers status, validates dependencies, submits one trusted graph, and collects its declared output", async () => {
    const bytes = await readFile(fixture); const requests: { readonly url: string; readonly init?: RequestInit }[] = [];
    const nodeClasses = ["CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage"];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input); requests.push({ url, init });
      if (url.endsWith("/queue")) return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }));
      if (url.endsWith("/object_info")) {
        const objectInfo = Object.fromEntries(nodeClasses.map((name) => [name, name === "CheckpointLoaderSimple" ? { input: { required: { ckpt_name: [["test.safetensors"]] } } } : {}]));
        return new Response(JSON.stringify(objectInfo));
      }
      if (url.endsWith("/prompt")) return new Response(JSON.stringify({ prompt_id: "prompt-1", number: 1 }));
      if (url.endsWith("/history/prompt-1")) return new Response(JSON.stringify({ "prompt-1": { status: { completed: true }, outputs: { "9": { images: [{ filename: "candidate.png", subfolder: "", type: "output" }] } } } }));
      if (url.includes("/view?")) return new Response(bytes, { headers: { "content-type": "image/png" } });
      throw new Error(`unexpected ${url}`);
    };
    const previous = process.env.COMFYUI_CHECKPOINT; process.env.COMFYUI_CHECKPOINT = "test.safetensors";
    try {
      const cwd = await mkdtemp(path.join(tmpdir(), "comfy-adapter-")); const registry = await trustedRegistry(cwd); const workflow = await registry.require("CHARACTER_GENERATION");
      const adapter = new ComfyUIAdapter({ fetcher, pollIntervalMs: 1 });
      await expect(adapter.status()).resolves.toMatchObject({ reachable: true, queue: { running: 0, pending: 0 } });
      await expect(adapter.inspectDependencies(workflow)).resolves.toMatchObject({ available: true });
      const submitted = await adapter.submit(workflow.workflow); const result = await adapter.waitForCompletion(submitted.promptId, "9");
      expect(result.outputs[0]?.bytes.length).toBe(bytes.length);
      expect(requests.filter((request) => request.url.endsWith("/prompt"))).toHaveLength(1);
    } finally { if (previous === undefined) delete process.env.COMFYUI_CHECKPOINT; else process.env.COMFYUI_CHECKPOINT = previous; }
  });

  it("validates manifests, injects prompts and deterministic seeds, preserves partial success, and stores suitability metadata", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "comfy-service-")); const bytes = await readFile(fixture); const provider = new MockImageProvider(bytes, [2]);
    const service = new ImageProductionService({ provider, registry: await trustedRegistry(cwd), storage: new ImageProposalStorage({ cwd }), randomSeed: () => 100, currentSessionId: () => "session-a", analyzeCandidate: async () => ({ usable: true, score: .82, issues: [], summary: "Review aid" }) });
    const status = await service.status();
    expect(status.capabilities.find((capability) => capability.capability === "CHARACTER_GENERATION")).toMatchObject({ capabilityAvailable: true });
    expect(status.capabilities.find((capability) => capability.capability === "PART_REPAIR")).toMatchObject({ capabilityAvailable: false });
    const proposal = await service.generateCandidates({ projectId: "character-a", operation: "character_generation", prompt: "stocky goblin", candidateCount: 3, seed: 77, width: 512, height: 512 });
    expect(proposal).toMatchObject({ status: "awaiting_review", candidateIds: ["candidate-01", "candidate-03"] });
    expect(proposal.errors[0]).toContain("Candidate 2");
    expect(proposal.candidates[0]?.diagnostics.suitability?.score).toBe(.82);
    expect(provider.submissions[0]?.["6"]?.inputs.text).toContain("stocky goblin");
    expect(provider.submissions.map((workflow) => workflow["3"]?.inputs.seed)).toEqual([77, 78, 79]);
    expect(await readFile(path.join(cwd, ".rigging-studio", "image-production", "proposals", proposal.proposalId, "metadata.json"), "utf8")).toContain("awaiting_review");
  });

  it("enforces inspection, manual and agent-recommendation policies, and the two-round regeneration limit", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "comfy-policy-")); const bytes = await readFile(fixture); const provider = new MockImageProvider(bytes);
    const service = new ImageProductionService({ provider, registry: await trustedRegistry(cwd), storage: new ImageProposalStorage({ cwd }), currentSessionId: () => "agent-session", randomSeed: () => 4 });
    const manual = await service.generateCandidates({ projectId: "character-policy", operation: "character_generation", prompt: "goblin", candidateCount: 1 });
    const sheetProposal = await service.recordContactSheet(manual.proposalId, Buffer.from(bytes).toString("base64"));
    expect(sheetProposal.contactSheetFileName).toBe("candidate-contact-sheet.png");
    await expect(service.getContactSheet(manual.proposalId)).resolves.toMatchObject({ proposal: { proposalId: manual.proposalId } });
    await service.getCandidate(manual.proposalId, "candidate-01");
    await expect(service.approve(manual.proposalId, "candidate-01", "agent")).rejects.toThrow("explicit human");
    await expect(service.approve(manual.proposalId, "candidate-01", "human")).rejects.toThrow("visually inspected");
    await service.getCandidate(manual.proposalId, "candidate-01", "human-ui");
    await expect(service.approve(manual.proposalId, "candidate-01", "human")).resolves.toMatchObject({ proposal: { status: "approved" } });

    service.setApprovalPolicy("character-agent", "agent_recommendation");
    const agent = await service.generateCandidates({ projectId: "character-agent", operation: "character_generation", prompt: "witch", candidateCount: 1 });
    await expect(service.approve(agent.proposalId, "candidate-01", "agent")).rejects.toThrow("visually inspected");
    await service.getCandidate(agent.proposalId, "candidate-01");
    await service.review({ proposalId: agent.proposalId, recommendedCandidateId: "candidate-01", candidateReviews: [{ candidateId: "candidate-01", decision: "recommend", reasons: ["clean silhouette"] }] }, "Codex");
    await expect(service.approve(agent.proposalId, "candidate-01", "agent")).resolves.toMatchObject({ proposal: { status: "approved" } });

    const first = await service.generateCandidates({ projectId: "character-rounds", operation: "character_generation", prompt: "first", candidateCount: 1 });
    const second = await service.regenerate(first.proposalId, "second");
    expect(second.parentProposalId).toBe(first.proposalId);
    await expect(service.regenerate(second.proposalId, "third")).rejects.toThrow("maximum of 2");
  });

  it("rejects arbitrary workflow fields, unavailable repairs, and managed-storage traversal", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "comfy-security-")); const bytes = await readFile(fixture); const storage = new ImageProposalStorage({ cwd });
    const service = new ImageProductionService({ provider: new MockImageProvider(bytes), registry: await trustedRegistry(cwd), storage, currentSessionId: () => "s" });
    await expect(service.generateCandidates({ projectId: "p", operation: "part_repair", prompt: "repair" })).rejects.toThrow(/unavailable|No trusted/);
    expect(() => storage.proposalDirectory("../../escape")).toThrow("Invalid proposal ID");
    const manifestPath = path.join(cwd, "comfy-workflows", "bad.manifest.json");
    await writeFile(manifestPath, JSON.stringify({ manifestVersion: 1, id: "bad", capability: "PART_REPAIR", workflowFile: "../escape.json", description: "bad", inputs: {}, outputs: { images: { nodeId: "1" } }, requiredNodeClasses: [], requiredModels: [] }));
    const capabilities = await new TrustedWorkflowRegistry({ rootDirectory: path.join(cwd, "comfy-workflows") }).listCapabilities(true);
    expect(capabilities.find((capability) => capability.capability === "PART_REPAIR")).toMatchObject({ capabilityAvailable: false });
  });

  it("keeps configured reconstruction and alpha cleanup outputs proposal-driven", async () => {
    const bytes = await readFile(fixture);
    const repairCwd = await mkdtemp(path.join(tmpdir(), "comfy-reconstruction-"));
    const repairProvider = new MockImageProvider(bytes);
    const repairService = new ImageProductionService({ provider: repairProvider, registry: await registryForCapability(repairCwd, "OCCLUSION_RECONSTRUCTION"), storage: new ImageProposalStorage({ cwd: repairCwd }), currentSessionId: () => "s", resolveRepairAssets: async () => ({ sourceImage: { bytes, mimeType: "image/png" }, maskImage: { bytes, mimeType: "image/png" } }) });
    const repair = await repairService.generateCandidates({ projectId: "p", operation: "occlusion_reconstruction", prompt: "complete the hidden forearm", targetPartId: "left-forearm", candidateCount: 1 });
    expect(repair).toMatchObject({ status: "awaiting_review", operationType: "OCCLUSION_RECONSTRUCTION", targetPartId: "left-forearm" });
    expect(repair.approvedCandidateId).toBeUndefined();
    expect(repairProvider.submissions[0]?.["6"]?.inputs.source_image).toContain("managed-input/");
    expect(repairProvider.submissions[0]?.["7"]?.inputs.mask_image).toContain("managed-input/");
    const rejected = await repairService.rejectCandidate(repair.proposalId, "candidate-01", "Codex", "silhouette does not match");
    expect(rejected.status).toBe("rejected");

    const alphaCwd = await mkdtemp(path.join(tmpdir(), "comfy-alpha-"));
    const alphaService = new ImageProductionService({ provider: new MockImageProvider(bytes), registry: await registryForCapability(alphaCwd, "ALPHA_EDGE_CLEANUP"), storage: new ImageProposalStorage({ cwd: alphaCwd }), currentSessionId: () => "s" });
    const alpha = await alphaService.generateCandidates({ projectId: "p", operation: "alpha_edge_cleanup", prompt: "remove matte halo only", candidateCount: 1 });
    expect(alpha).toMatchObject({ status: "awaiting_review", operationType: "ALPHA_EDGE_CLEANUP" });
    expect(alpha.approvedCandidateId).toBeUndefined();
  });

  it("routes approved generation and reconstruction candidates through existing project state", async () => {
    const service = new RiggingCommandService();
    const created = await service.executeTool("project_create", { name: "Comfy ingress", prompt: "goblin" });
    expect(created.success).toBe(true);
    const projectId = service.queries.getActiveProject(true)?.id;
    expect(projectId).toBeTruthy();
    const baseIngress = {
      projectId, provider: "comfyui", prompt: "goblin", accepted: true, generationMode: "provider_generated" as const,
      metadata: { proposalId: "proposal-a", candidateId: "candidate-01", workflowId: "character_generation_v1", approvalPolicy: "manual" },
      managedImage: { image: "http://127.0.0.1:47831/generations/approved.png", sourceArtifact: "/managed/approved.png", width: 512, height: 512, mimeType: "image/png" as const }, ingressToken: "x".repeat(48),
    };
    const generation = await service.executeTool("character_import_generation", { ...baseIngress, generationId: "comfy-approved", operation: "CHARACTER_GENERATION" });
    expect(generation).toMatchObject({ success: true, generationMode: "provider_generated", provider: "comfyui" });
    expect(service.queries.getActiveProject(true)).toMatchObject({
      sourceImage: { generationId: "comfy-approved", generationMode: "provider_generated", provider: "comfyui", novelArtwork: true },
      imageProductionHistory: [{ proposalId: "proposal-a", candidateId: "candidate-01", operation: "CHARACTER_GENERATION" }],
    });

    await service.executeTool("character_segment", { projectId });
    const targetPartId = service.queries.getCharacterParts()[0]?.id;
    expect(targetPartId).toBeTruthy();
    const repair = await service.executeTool("character_import_generation", {
      ...baseIngress, generationId: "comfy-repair", operation: "OCCLUSION_RECONSTRUCTION", targetPartId,
      metadata: { proposalId: "proposal-repair", candidateId: "candidate-01", workflowId: "occlusion_v1", approvalPolicy: "manual" },
      managedImage: { ...baseIngress.managedImage, image: "http://127.0.0.1:47831/generations/repair.png", sourceArtifact: "/managed/repair.png" },
    });
    expect(repair).toMatchObject({ success: true, operation: "OCCLUSION_RECONSTRUCTION", targetPartId });
    const active = service.queries.getActiveProject(true);
    if (!active || !("reconstructedParts" in active)) throw new Error("Full project was not returned");
    expect(active.reconstructedParts.find((part) => part.partId === targetPartId)).toMatchObject({ reconstructedImage: "http://127.0.0.1:47831/generations/repair.png", reconstructionAccepted: true });
  });
});
