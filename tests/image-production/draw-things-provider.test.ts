import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DrawThingsProvider } from "../../src/image-production/draw-things/DrawThingsProvider";
import { ImageProposalStorage } from "../../src/image-production/assets/imageProposalStorage";
import { ImageProductionService } from "../../src/image-production/service/ImageProductionService";
import { buildCharacterConsistencyContext } from "../../src/character-generation/context/characterConsistencyContext";
import { createGeneratedCharacterProject, parseGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";

const fixture = new URL("../../public/rig-test/body-base.png", import.meta.url);
const request = { prompt: "silver knight", negativePrompt: "busy background", width: 512, height: 512, model: "Local Model XL", seed: 44, steps: 20, guidance: 6, candidateCount: 2, generationIntent: "character" as const };

describe("Draw Things local generation provider", () => {
  it("reports disabled and unreachable direct modes truthfully", async () => {
    const disabled = new DrawThingsProvider({ enabled: false });
    await expect(disabled.getCapabilities()).resolves.toMatchObject({ provider: "draw_things", connected: false, mode: "unavailable", characterGeneration: { available: false } });
    const offline = new DrawThingsProvider({ enabled: true, mode: "direct", fetchImpl: async () => { throw new Error("connection refused"); } });
    await expect(offline.getCapabilities()).resolves.toMatchObject({ connected: false, message: expect.stringContaining("connection refused") });
  });

  it("uses the official localhost txt2img surface and preserves available and unavailable metadata", async () => {
    const bytes = await readFile(fixture); const calls: { readonly url: string; readonly body?: Record<string, unknown> }[] = [];
    const provider = new DrawThingsProvider({ enabled: true, mode: "direct", now: () => new Date("2026-08-21T12:00:00.000Z"), fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) });
      if (url.endsWith("/sdapi/v1/options")) return new Response(JSON.stringify({ sd_model_checkpoint: "Local Model XL" }));
      if (url.endsWith("/sdapi/v1/txt2img")) return new Response(JSON.stringify({ images: [Buffer.from(bytes).toString("base64"), Buffer.from(bytes).toString("base64")], info: JSON.stringify({ all_seeds: [44, 45], sampler_name: "DPM++ 2M", steps: 20, cfg_scale: 6, sd_model_name: "Local Model XL" }) }));
      return new Response("not found", { status: 404 });
    } });
    const capabilities = await provider.getCapabilities();
    expect(capabilities).toMatchObject({ connected: true, mode: "direct", characterGeneration: { available: true }, characterVariant: { available: true }, metadataCapture: { level: "full" }, models: [{ name: "Local Model XL" }] });
    const outputs = await provider.generateCharacter(request);
    expect(outputs).toHaveLength(2);
    expect(outputs.map((output) => output.seed)).toEqual([44, 45]);
    expect(outputs[0]?.metadata).toMatchObject({ provider: "draw_things", prompt: "silver knight", negativePrompt: "busy background", model: "Local Model XL", sampler: "DPM++ 2M", scheduler: null, loras: null });
    expect(calls.find((call) => call.url.endsWith("/sdapi/v1/txt2img"))?.body).toMatchObject({ prompt: "silver knight", batch_size: 2, seed: 44 });
  });

  it("waits for stable watched-folder files, parses a JSON sidecar, and deduplicates content hashes", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "draw-things-watch-")); const inbox = path.join(cwd, "inbox"); await mkdir(inbox);
    const provider = new DrawThingsProvider({ enabled: true, mode: "watched_folder", exportDirectory: inbox, cwd, pollIntervalMs: 2, stableWindowMs: 5, timeoutMs: 250 });
    await expect(provider.getCapabilities()).resolves.toMatchObject({ connected: true, mode: "watched_folder", metadataCapture: { level: "partial" }, watchedFolder: { available: true } });
    const collecting = provider.generateCharacter({ ...request, candidateCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const outputPath = path.join(inbox, "knight.png");
    await copyFile(fixture, outputPath);
    await writeFile(path.join(inbox, "knight.json"), JSON.stringify({ prompt: "sidecar prompt", seed: 812, model: "DreamShaper local", sampler: "Euler", loras: [{ name: "armor", weight: .7 }] }));
    const [output] = await collecting;
    expect(output).toMatchObject({ seed: 812, sourcePath: outputPath, metadata: { mode: "watched_folder", prompt: "sidecar prompt", model: "DreamShaper local", sampler: "Euler", loras: [{ name: "armor", weight: .7 }] } });
    await expect(provider.generateCharacter({ ...request, candidateCount: 1 })).rejects.toThrow("Timed out");
  });

  it("rejects incomplete exports, reports a disconnected external volume, and supports cancellation", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "draw-things-invalid-")); const inbox = path.join(cwd, "inbox"); await mkdir(inbox);
    const provider = new DrawThingsProvider({ enabled: true, mode: "watched_folder", exportDirectory: inbox, cwd, pollIntervalMs: 2, stableWindowMs: 3, timeoutMs: 80 });
    const collecting = provider.generateCharacter({ ...request, candidateCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 8)); await writeFile(path.join(inbox, "broken.png"), Buffer.from("not a png"));
    await expect(collecting).rejects.toThrow("not a complete supported PNG or JPEG");
    const volume = new DrawThingsProvider({ enabled: true, mode: "watched_folder", exportDirectory: "/Volumes/Disconnected-AI/Draw Things", cwd });
    await expect(volume.getCapabilities()).resolves.toMatchObject({ connected: false, message: expect.stringContaining("volume is unavailable") });
    const controller = new AbortController(); const waiting = provider.generateCharacter({ ...request, candidateCount: 1 }, controller.signal); controller.abort();
    await expect(waiting).rejects.toThrow("cancelled");
  });

  it("creates review-only multi-candidate proposals, approves one candidate, and carries Draw Things context", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "draw-things-proposal-")); const bytes = await readFile(fixture);
    const provider = new DrawThingsProvider({ enabled: true, mode: "direct", fetchImpl: async (input) => String(input).endsWith("/sdapi/v1/options")
      ? new Response(JSON.stringify({ sd_model_checkpoint: "Local Model XL" }))
      : new Response(JSON.stringify({ images: [Buffer.from(bytes).toString("base64"), Buffer.from(bytes).toString("base64")], info: JSON.stringify({ all_seeds: [71, 72], sd_model_name: "Local Model XL", loras: [{ name: "linework", weight: .8 }] }) })) });
    const service = new ImageProductionService({ generationProviders: [provider], storage: new ImageProposalStorage({ cwd }), currentSessionId: () => "agent-session" });
    const proposal = await service.generateCandidates({ projectId: "character-draw", provider: "draw_things", operation: "character_generation", prompt: "silver knight", candidateCount: 2, seed: 71 });
    expect(proposal).toMatchObject({ provider: "draw_things", status: "awaiting_review", candidateIds: ["candidate-01", "candidate-02"] });
    expect(proposal.approvedCandidateId).toBeUndefined();
    await service.getCandidate(proposal.proposalId, "candidate-01", "human-ui");
    const approved = await service.approve(proposal.proposalId, "candidate-01", "human");
    expect(approved.proposal.candidates.map((candidate) => candidate.status)).toEqual(["approved", "rejected"]);

    const base = createGeneratedCharacterProject("Knight", "silver knight");
    const parsed = parseGeneratedCharacterProject({ ...base, stage: "prepare", generationPrompt: proposal.sourcePrompt, generationMetadata: {}, generationHistory: [{ generationId: "draw-1", image: "http://127.0.0.1/image.png", width: 512, height: 512, generationPrompt: proposal.sourcePrompt, generationSettings: proposal.generationParameters, seed: 71, providerMetadata: approved.candidate.providerMetadata, warnings: [], generationMode: "provider_generated", novelArtwork: true, provider: "draw_things", sourceArtifact: approved.filePath }], imageProductionHistory: [{ proposalId: proposal.proposalId, provider: "draw_things", operation: "CHARACTER_GENERATION", candidateId: "candidate-01", workflowId: proposal.workflowId, approvalPolicy: "manual", acceptedAt: "2026-08-21T12:00:00.000Z" }], sourceImage: { generationId: "draw-1", image: "http://127.0.0.1/image.png", width: 512, height: 512, generationPrompt: proposal.sourcePrompt, generationSettings: proposal.generationParameters, seed: 71, providerMetadata: approved.candidate.providerMetadata, warnings: [], generationMode: "provider_generated", novelArtwork: true, provider: "draw_things", sourceArtifact: approved.filePath } });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(buildCharacterConsistencyContext(parsed.data)).toMatchObject({ generationProvider: "draw_things", generationModel: "Local Model XL", generationSeed: 71, canonicalSourceImage: approved.filePath, loraMetadata: [{ name: "linework", weight: .8 }] });
  });
});
