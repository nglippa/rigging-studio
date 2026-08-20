import type { ImageProductionJson } from "../proposals/imageProposal";
import type { ImageProductionProvider, ImageProviderExecutionResult, ImageProviderOutput, ImageProviderProgress, ImageProviderStatus } from "../providers/imageProductionProvider";
import type { ComfyApiWorkflow, LoadedTrustedWorkflow } from "../workflows/workflowManifest";

type ComfyUIAdapterOptions = {
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly pollIntervalMs?: number;
};

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asArray = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function validateComfyBaseUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("COMFYUI_BASE_URL must be a valid URL"); }
  const localhost = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "http:" || !localhost) throw new Error("ComfyUI must use an http:// localhost endpoint");
  if (url.username || url.password || url.search || url.hash) throw new Error("ComfyUI URL must not contain credentials, query parameters, or fragments");
  return url.toString().replace(/\/$/, "");
}

export class ComfyUIAdapter implements ImageProductionProvider {
  readonly id = "comfyui";
  readonly name = "Local ComfyUI";
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: ComfyUIAdapterOptions = {}) {
    this.baseUrl = validateComfyBaseUrl(options.baseUrl ?? process.env.COMFYUI_BASE_URL ?? "http://127.0.0.1:8188");
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.COMFYUI_EXECUTION_TIMEOUT_MS ?? 600_000);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
  }

  async status(): Promise<ImageProviderStatus> {
    try {
      const queue = await this.json("/queue", { method: "GET" });
      const running = asArray(isRecord(queue) ? queue.queue_running : []).length;
      const pending = asArray(isRecord(queue) ? queue.queue_pending : []).length;
      return { provider: this.id, reachable: true, url: this.baseUrl, queue: { running, pending }, message: running ? "ComfyUI is sampling" : pending ? "ComfyUI has queued work" : "ComfyUI is ready" };
    } catch (error: unknown) {
      return { provider: this.id, reachable: false, url: this.baseUrl, queue: { running: 0, pending: 0 }, message: error instanceof Error ? error.message : "ComfyUI is unavailable" };
    }
  }

  async inspectDependencies(workflow: LoadedTrustedWorkflow): Promise<{ readonly available: boolean; readonly missingNodeClasses: readonly string[]; readonly missingModels: readonly string[] }> {
    const objectInfo = await this.json("/object_info", { method: "GET" });
    const knownClasses = new Set(isRecord(objectInfo) ? Object.keys(objectInfo) : []);
    const missingNodeClasses = workflow.manifest.requiredNodeClasses.filter((nodeClass) => !knownClasses.has(nodeClass));
    const checkpoint = process.env.COMFYUI_CHECKPOINT;
    const objectInfoText = JSON.stringify(objectInfo);
    const missingModels = workflow.manifest.requiredModels.flatMap((environmentName) => {
      const configured = process.env[environmentName];
      if (!configured) return [environmentName];
      return objectInfoText.includes(configured) ? [] : [`${environmentName}:${configured}`];
    });
    if (checkpoint && isRecord(objectInfo)) {
      const loader = objectInfo.CheckpointLoaderSimple;
      const required = isRecord(loader) && isRecord(loader.input) && isRecord(loader.input.required) ? loader.input.required.ckpt_name : undefined;
      const installed = Array.isArray(required) && Array.isArray(required[0]) ? required[0].filter((value): value is string => typeof value === "string") : [];
      if (installed.length && !installed.includes(checkpoint) && !missingModels.includes(`COMFYUI_CHECKPOINT:${checkpoint}`)) missingModels.push(`COMFYUI_CHECKPOINT:${checkpoint}`);
    }
    return { available: missingNodeClasses.length === 0 && missingModels.length === 0, missingNodeClasses, missingModels };
  }

  async submit(workflow: ComfyApiWorkflow): Promise<{ readonly promptId: string; readonly queueNumber?: number }> {
    const clientId = `rigging-studio-${crypto.randomUUID()}`;
    const response = await this.json("/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: clientId }) });
    if (!isRecord(response) || typeof response.prompt_id !== "string") {
      const nodeErrors = isRecord(response) && response.node_errors ? JSON.stringify(response.node_errors) : "no prompt_id returned";
      throw new Error(`ComfyUI rejected the trusted workflow: ${nodeErrors}`);
    }
    return { promptId: response.prompt_id, ...(typeof response.number === "number" ? { queueNumber: response.number } : {}) };
  }

  async waitForCompletion(promptId: string, outputNodeId: string, onProgress?: (progress: ImageProviderProgress) => void): Promise<ImageProviderExecutionResult> {
    const started = Date.now();
    onProgress?.({ phase: "queued", message: "ComfyUI · queued" });
    while (Date.now() - started < this.timeoutMs) {
      const history = await this.json(`/history/${encodeURIComponent(promptId)}`, { method: "GET" });
      const entry = isRecord(history) && isRecord(history[promptId]) ? history[promptId] : undefined;
      if (isRecord(entry)) {
        const status = isRecord(entry.status) ? entry.status : undefined;
        if (status?.completed === false && status.status_str === "error") throw new Error(this.executionError(status));
        const outputs = isRecord(entry.outputs) ? entry.outputs : undefined;
        const output = outputs && isRecord(outputs[outputNodeId]) ? outputs[outputNodeId] : undefined;
        const images = isRecord(output) ? asArray(output.images) : [];
        if (status?.completed === true || images.length) {
          onProgress?.({ phase: "collecting", percent: 100, message: "ComfyUI · collecting output" });
          const collected: ImageProviderOutput[] = [];
          for (const image of images) {
            if (!isRecord(image) || typeof image.filename !== "string") continue;
            const subfolder = typeof image.subfolder === "string" ? image.subfolder : "";
            const type = typeof image.type === "string" ? image.type : "output";
            const params = new URLSearchParams({ filename: image.filename, subfolder, type });
            const response = await this.request(`/view?${params.toString()}`, { method: "GET" });
            const contentType = response.headers.get("content-type")?.split(";")[0];
            if (contentType !== "image/png" && contentType !== "image/jpeg") throw new Error(`ComfyUI output ${image.filename} is not a PNG or JPEG`);
            collected.push({ bytes: new Uint8Array(await response.arrayBuffer()), mimeType: contentType, providerAsset: { filename: image.filename, subfolder, type } });
          }
          if (!collected.length) throw new Error(`ComfyUI completed ${promptId} but returned no images from trusted output node ${outputNodeId}`);
          return { promptId, outputs: collected, warnings: [] };
        }
      }
      const queue = await this.json("/queue", { method: "GET" }).catch(() => null);
      const running = isRecord(queue) ? asArray(queue.queue_running).some((item) => JSON.stringify(item).includes(promptId)) : false;
      onProgress?.({ phase: running ? "sampling" : "queued", message: running ? "ComfyUI · sampling" : "ComfyUI · queued" });
      await delay(this.pollIntervalMs);
    }
    throw new Error(`ComfyUI workflow ${promptId} timed out after ${Math.round(this.timeoutMs / 1000)} seconds`);
  }

  async uploadImage(name: string, bytes: Uint8Array, mimeType: "image/png" | "image/jpeg", overwrite = false): Promise<string> {
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "-");
    const body = new FormData();
    body.append("image", new Blob([Uint8Array.from(bytes).buffer], { type: mimeType }), safeName);
    body.append("type", "input"); body.append("overwrite", overwrite ? "true" : "false");
    const response = await this.json("/upload/image", { method: "POST", body });
    if (!isRecord(response) || typeof response.name !== "string") throw new Error("ComfyUI image upload did not return a managed filename");
    return response.subfolder ? `${String(response.subfolder)}/${response.name}` : response.name;
  }

  async cancel(promptId: string): Promise<boolean> {
    const queue = await this.json("/queue", { method: "GET" }).catch(() => null);
    const pending = isRecord(queue) ? asArray(queue.queue_pending) : [];
    const pendingMatch = pending.some((item) => JSON.stringify(item).includes(promptId));
    if (pendingMatch) {
      await this.json("/queue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete: [promptId] }) });
      return true;
    }
    await this.json("/interrupt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt_id: promptId }) });
    return true;
  }

  private executionError(status: JsonRecord): string {
    const messages = asArray(status.messages);
    const execution = messages.find((message) => Array.isArray(message) && message[0] === "execution_error");
    if (Array.isArray(execution) && isRecord(execution[1])) {
      const detail = execution[1];
      return `ComfyUI node ${String(detail.node_id ?? "unknown")} failed: ${String(detail.exception_message ?? detail.exception_type ?? "execution error")}`;
    }
    return "ComfyUI workflow execution failed";
  }

  private async json(pathname: string, init: RequestInit): Promise<unknown> {
    const response = await this.request(pathname, init);
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text) as ImageProductionJson; }
    catch { throw new Error(`ComfyUI returned invalid JSON for ${pathname}`); }
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${pathname}`, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`ComfyUI ${pathname} failed (${response.status})`);
      return response;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`ComfyUI ${pathname} timed out`);
      throw error instanceof Error ? error : new Error(`ComfyUI ${pathname} failed`);
    } finally { clearTimeout(timer); }
  }
}
