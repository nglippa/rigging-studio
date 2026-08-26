import { buildVisionReviewPrompt, validateVisionReviewResult, VISION_REVIEW_JOB_TYPES, VISION_REVIEW_RESULT_JSON_SCHEMA, type VisionReviewCapabilities, type VisionReviewInvocation, type VisionReviewJob, type VisionReviewProvider } from "../../src/vision-review";
import { normalizeOllamaEndpoint } from "../../src/intelligence";
import { readFile } from "node:fs/promises";

type Options = { readonly endpoint?: string; readonly model?: string | null; readonly fetcher?: typeof fetch; readonly timeoutMs?: number };
const withTimeout = async (fetcher: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { return await fetcher(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); } };

export class OllamaVisionReviewProvider implements VisionReviewProvider {
  readonly id = "ollama-vision"; private readonly endpoint: string; private readonly fetcher: typeof fetch; private readonly timeoutMs: number; private model: string | null; private cached: VisionReviewCapabilities | null = null;
  constructor(options: Options = {}) { this.endpoint = normalizeOllamaEndpoint(options.endpoint ?? "http://127.0.0.1:11434"); this.model = options.model ?? null; this.fetcher = options.fetcher ?? fetch; this.timeoutMs = options.timeoutMs ?? 120_000; }
  async capabilities(): Promise<VisionReviewCapabilities> {
    if (this.cached) return this.cached;
    try {
      const tags = await withTimeout(this.fetcher, `${this.endpoint}/api/tags`, {}, 2500); if (!tags.ok) throw new Error(`Ollama returned HTTP ${tags.status}`);
      const payload = await tags.json() as { readonly models?: readonly { readonly name?: string; readonly model?: string }[] }; const models = payload.models ?? [];
      for (const entry of models) {
        const name = entry.name ?? entry.model; if (!name) continue; const shown = await withTimeout(this.fetcher, `${this.endpoint}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name, verbose: false }) }, 2500);
        if (!shown.ok) continue; const detail = await shown.json() as { readonly capabilities?: unknown }; if (Array.isArray(detail.capabilities) && detail.capabilities.includes("vision")) { this.model = this.model && this.model === name ? this.model : name; break; }
      }
      if (!this.model) return this.cached = this.state("UNAVAILABLE", "Ollama is reachable but no installed model advertises vision capability", null);
      return this.cached = { providerId: this.id, label: "Ollama vision", state: "AVAILABLE_AND_MULTIMODAL", available: true, multimodal: true, supportsSourceImage: true, supportsMaskImage: true, supportsRenderedPose: true, supportsAnimationFrames: true, structuredOutput: true, localOnly: true, usesExistingAccountSession: false, supportsIterativeReview: true, supportsRelativeRanking: true, supportedJobTypes: [...VISION_REVIEW_JOB_TYPES], transport: `${this.endpoint}/api/chat`, version: null, model: this.model, failureReason: null };
    } catch (error: unknown) { return this.cached = this.state("UNAVAILABLE", error instanceof Error ? error.message : "Ollama is not running", null); }
  }
  async isAvailable(): Promise<boolean> { return (await this.capabilities()).available; }
  async review(job: VisionReviewJob, artifactPaths: Readonly<Record<string, string>>): Promise<VisionReviewInvocation> {
    const capabilities = await this.capabilities(); if (!capabilities.available || !this.model) throw new Error(capabilities.failureReason ?? "Ollama vision unavailable");
    const images = await Promise.all(job.artifacts.map(async (artifact) => (await readFile(artifactPaths[artifact.name])).toString("base64")));
    const response = await withTimeout(this.fetcher, `${this.endpoint}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: this.model, stream: false, format: VISION_REVIEW_RESULT_JSON_SCHEMA, options: { temperature: 0 }, messages: [{ role: "user", content: buildVisionReviewPrompt(job), images }] }) }, this.timeoutMs);
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`); const payload = await response.json() as { readonly message?: { readonly content?: unknown } }; if (typeof payload.message?.content !== "string") throw new Error("Ollama omitted structured review content");
    return { result: validateVisionReviewResult(JSON.parse(payload.message.content) as unknown, job), providerVersion: null, model: this.model, classification: "local", authenticatedViaExistingSession: false };
  }
  private state(state: VisionReviewCapabilities["state"], reason: string, model: string | null): VisionReviewCapabilities { return { providerId: this.id, label: "Ollama vision", state, available: false, multimodal: false, supportsSourceImage: false, supportsMaskImage: false, supportsRenderedPose: false, supportsAnimationFrames: false, structuredOutput: false, localOnly: true, usesExistingAccountSession: false, supportsIterativeReview: false, supportsRelativeRanking: false, supportedJobTypes: [], transport: `${this.endpoint}/api/chat`, version: null, model, failureReason: reason }; }
}
