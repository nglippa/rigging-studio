import { PART_SEMANTIC_TYPES } from "../part-cutter/semanticTaxonomy";
import { assistantProposalSchema, type AssistantProposal, type AssistantProposalRequest, type IntelligenceCapability, type IntelligenceModel, type IntelligenceProvider, type IntelligenceProviderStatus } from "./provider";
import { DEFAULT_OLLAMA_SETTINGS, normalizeOllamaEndpoint, type OllamaSettings } from "./settings";

type OllamaTag = { readonly name?: unknown; readonly model?: unknown; readonly size?: unknown; readonly details?: { readonly family?: unknown } };
type OllamaShow = { readonly capabilities?: unknown };

const timeoutFetch = async (fetcher: typeof fetch, url: string, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 2500);
  try { return await fetcher(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); }
};

export class OllamaProvider implements IntelligenceProvider {
  readonly id = "ollama"; readonly label = "Ollama";
  private settings: OllamaSettings;
  private cachedModels: readonly IntelligenceModel[] = [];
  constructor(settings: Partial<OllamaSettings> = {}, private readonly fetcher: typeof fetch = fetch) {
    this.settings = { ...DEFAULT_OLLAMA_SETTINGS, ...settings, endpoint: normalizeOllamaEndpoint(settings.endpoint ?? DEFAULT_OLLAMA_SETTINGS.endpoint) };
  }
  configure(settings: Partial<OllamaSettings>): void { this.settings = { ...this.settings, ...settings, ...(settings.endpoint ? { endpoint: normalizeOllamaEndpoint(settings.endpoint) } : {}) }; }
  selectModel(model: string): void {
    if (!this.cachedModels.some((item) => item.name === model)) throw new Error(`Ollama model ${model} is not installed`);
    this.settings = { ...this.settings, selectedModel: model };
  }
  get configuration(): OllamaSettings { return this.settings; }

  async listModels(): Promise<readonly IntelligenceModel[]> {
    const response = await timeoutFetch(this.fetcher, `${this.settings.endpoint}/api/tags`);
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    const payload = await response.json() as { readonly models?: unknown };
    if (!Array.isArray(payload.models)) throw new Error("Ollama model list was invalid");
    const models = await Promise.all((payload.models as OllamaTag[]).map(async (tag): Promise<IntelligenceModel | null> => {
      const name = typeof tag.name === "string" ? tag.name : typeof tag.model === "string" ? tag.model : null;
      if (!name) return null;
      let capabilities: readonly IntelligenceCapability[] = ["UNKNOWN"];
      try {
        const details = await timeoutFetch(this.fetcher, `${this.settings.endpoint}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name, verbose: false }) });
        if (details.ok) {
          const shown = await details.json() as OllamaShow; const raw = Array.isArray(shown.capabilities) ? shown.capabilities.filter((item): item is string => typeof item === "string") : [];
          const verified: IntelligenceCapability[] = [];
          if (raw.some((item) => item === "completion" || item === "chat" || item === "generate")) verified.push("TEXT");
          if (raw.includes("vision")) verified.push("VISION");
          capabilities = verified.length ? verified : ["UNKNOWN"];
        }
      } catch { /* older servers may list models without capability metadata */ }
      return { name, size: typeof tag.size === "number" ? tag.size : null, family: typeof tag.details?.family === "string" ? tag.details.family : null, capabilities };
    }));
    this.cachedModels = models.filter((model): model is IntelligenceModel => model !== null);
    return this.cachedModels;
  }

  async status(): Promise<IntelligenceProviderStatus> {
    try {
      const models = await this.listModels(); const selectedModel = this.settings.selectedModel && models.some((model) => model.name === this.settings.selectedModel) ? this.settings.selectedModel : models[0]?.name ?? null;
      if (selectedModel !== this.settings.selectedModel) this.settings = { ...this.settings, selectedModel };
      return { provider: this.id, label: this.label, local: true, reachable: true, enabled: this.settings.enabled, endpoint: this.settings.endpoint, selectedModel, models, message: models.length ? `${models.length} installed model${models.length === 1 ? "" : "s"}` : "Connected; no models installed" };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : "";
      return { provider: this.id, label: this.label, local: true, reachable: false, enabled: this.settings.enabled, endpoint: this.settings.endpoint, selectedModel: this.settings.selectedModel, models: [], message: /fetch failed|failed to fetch|abort/i.test(detail) ? "Not running" : detail || "Not running" };
    }
  }

  async propose(request: AssistantProposalRequest): Promise<AssistantProposal> {
    const model = request.selectedModel ?? this.settings.selectedModel;
    if (!this.settings.enabled) throw new Error("Ollama is disabled");
    if (!model) throw new Error("Select an installed Ollama model first");
    if (!this.cachedModels.length) await this.listModels();
    const descriptor = this.cachedModels.find((item) => item.name === model);
    if (!descriptor) throw new Error(`Ollama model ${model} is not installed`);
    const hasVision = descriptor.capabilities.includes("VISION");
    if (request.imageBase64 && !hasVision) throw new Error(`${model} has no verified VISION capability and cannot inspect the selection image`);
    const schema = {
      type: "object", additionalProperties: false,
      properties: { summary: { type: "string" }, semanticType: { anyOf: [{ type: "string", enum: PART_SEMANTIC_TYPES }, { type: "null" }] }, confidence: { anyOf: [{ type: "number", minimum: 0, maximum: 1 }, { type: "null" }] }, rationale: { type: "string" } },
      required: ["summary", "semanticType", "confidence", "rationale"],
    };
    const response = await timeoutFetch(this.fetcher, `${this.settings.endpoint}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: false, format: schema, options: { temperature: 0 }, messages: [{ role: "system", content: "You are Rig Studio's local proposal assistant. Return only the requested JSON. Never claim to see an image unless an image is supplied. Never invent IDs. You propose; you do not mutate project state." }, { role: "user", content: `${request.prompt}\nAction: ${request.action}\nExisting regions: ${(request.existingRegionNames ?? []).join(", ") || "none"}`, ...(request.imageBase64 ? { images: [request.imageBase64.replace(/^data:image\/[^;]+;base64,/, "")] } : {}) }] }) });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    const payload = await response.json() as { readonly message?: { readonly content?: unknown } };
    if (typeof payload.message?.content !== "string") throw new Error("Ollama response omitted structured content");
    const parsed = JSON.parse(payload.message.content) as Record<string, unknown>;
    return assistantProposalSchema.parse({ proposalId: `ollama-${Date.now().toString(36)}`, provider: this.id, model, action: request.action, summary: parsed.summary, semanticType: parsed.semanticType ?? null, confidence: parsed.confidence ?? null, rationale: parsed.rationale, targetPartId: request.targetPartId ?? null, requiresAcceptance: true, inspectedImage: Boolean(request.imageBase64 && hasVision), createdAt: new Date().toISOString() });
  }
}
