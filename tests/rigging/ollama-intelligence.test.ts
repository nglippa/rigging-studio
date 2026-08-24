import { describe, expect, it } from "vitest";
import { OllamaProvider, assistantProposalSchema, loadOllamaSettings, normalizeOllamaEndpoint, saveOllamaSettings } from "../../src/intelligence";
import type { IntelligenceProvider } from "../../src/intelligence";
import { RiggingCommandService } from "../../src/agent-control/commands/RiggingCommandService";

const response = (value: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 500, json: async () => value } as Response);
const fetcher = async (input: string | URL | Request): Promise<Response> => {
  const url = String(input);
  if (url.endsWith("/api/tags")) return response({ models: [{ name: "vision-local:latest", size: 123, details: { family: "fixture" } }, { name: "text-local:latest", size: 45 }] });
  if (url.endsWith("/api/show")) return response({ capabilities: ["completion", url.includes("never") ? "vision" : "completion"] });
  if (url.endsWith("/api/chat")) return response({ message: { content: JSON.stringify({ summary: "Looks like hair", semanticType: "hair", confidence: .84, rationale: "Silhouette sits around the head" }) } });
  return response({}, false);
};

describe("Ollama local intelligence provider", () => {
  it("rejects non-local endpoints", () => expect(() => normalizeOllamaEndpoint("https://example.com")).toThrow(/localhost/));
  it("reports offline truthfully", async () => {
    const provider = new OllamaProvider({ enabled: true }, async () => { throw new TypeError("fetch failed"); });
    expect(await provider.status()).toMatchObject({ reachable: false, local: true, message: "Not running" });
  });
  it("discovers installed models dynamically and does not fabricate vision", async () => {
    const provider = new OllamaProvider({ enabled: true }, fetcher as typeof fetch);
    const status = await provider.status();
    expect(status.models.map((model) => model.name)).toEqual(["vision-local:latest", "text-local:latest"]);
    expect(status.models.every((model) => !model.capabilities.includes("VISION"))).toBe(true);
  });
  it("persists endpoint, enablement, and model selection", () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    saveOllamaSettings(storage, { enabled: true, endpoint: "http://localhost:11434", selectedModel: "qwen" });
    expect(loadOllamaSettings(storage)).toEqual({ enabled: true, endpoint: "http://localhost:11434", selectedModel: "qwen" });
  });
  it("validates structured proposals and always requires acceptance", () => {
    expect(assistantProposalSchema.safeParse({ proposalId: "p", provider: "ollama", model: "m", action: "check_partition", summary: "ok", confidence: null, rationale: "checked", requiresAcceptance: true, inspectedImage: false, createdAt: "now" }).success).toBe(true);
    expect(assistantProposalSchema.safeParse({ proposalId: "p", provider: "ollama", model: "m", action: "check_partition", summary: "ok", confidence: null, rationale: "checked", requiresAcceptance: false, inspectedImage: false, createdAt: "now" }).success).toBe(false);
  });
  it("prevents a text-only model from pretending to inspect an image", async () => {
    const provider = new OllamaProvider({ enabled: true }, fetcher as typeof fetch); await provider.status(); provider.selectModel("text-local:latest");
    await expect(provider.propose({ action: "suggest_semantic", prompt: "label", imageBase64: "AAAA" })).rejects.toThrow(/no verified VISION/);
  });
  it("sends image context only after the selected model advertises vision", async () => {
    const visionFetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/api/tags")) return response({ models: [{ name: "vision-local:latest" }] });
      if (url.endsWith("/api/show")) return response({ capabilities: ["completion", "vision"] });
      if (url.endsWith("/api/chat")) return response({ message: { content: JSON.stringify({ summary: "Cape edge", semanticType: "cape", confidence: .91, rationale: "Observed in the supplied crop" }) } });
      return response({}, false);
    };
    const provider = new OllamaProvider({ enabled: true }, visionFetcher as typeof fetch); await provider.status();
    const proposal = await provider.propose({ action: "suggest_semantic", prompt: "label", imageBase64: "AAAA" });
    expect(proposal).toMatchObject({ inspectedImage: true, requiresAcceptance: true, semanticType: "cape" });
  });
  it("exposes assistant output as a proposal and never as a direct mutation", async () => {
    const provider: IntelligenceProvider = {
      id: "ollama", label: "Ollama",
      status: async () => ({ provider: "ollama", label: "Ollama", local: true, reachable: true, enabled: true, endpoint: "http://127.0.0.1:11434", selectedModel: "fixture", models: [], message: "Connected" }),
      listModels: async () => [], selectModel: () => undefined,
      propose: async (request) => ({ proposalId: "fixture", provider: "ollama", model: "fixture", action: request.action, summary: "Suggestion only", confidence: .8, rationale: "Fixture", requiresAcceptance: true, inspectedImage: false, createdAt: "2026-08-22T00:00:00.000Z" }),
    };
    const service = new RiggingCommandService({ intelligenceProvider: provider });
    const result = await service.executeTool("assistant_propose", { action: "check_partition", prompt: "Review this partition" });
    expect(result).toMatchObject({ success: true, mutated: false, proposal: { requiresAcceptance: true } });
  });
});
