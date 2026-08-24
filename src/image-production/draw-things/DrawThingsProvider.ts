import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import type { ImageProductionJson } from "../proposals/imageProposal";
import type { CharacterGenerationRequest, GeneratedImageCandidate, ImageGenerationProvider, ProviderCapabilities } from "../providers/imageGenerationProvider";

type FetchLike = typeof fetch;
type DrawThingsMode = "direct" | "watched_folder" | "auto";
type DrawThingsOptions = {
  readonly enabled?: boolean;
  readonly baseUrl?: string;
  readonly exportDirectory?: string;
  readonly mode?: DrawThingsMode;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly stableWindowMs?: number;
  readonly cwd?: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
};

type ImportRecord = { readonly hash: string; readonly sourcePath: string; readonly importedAt: string; readonly proposalId?: string };
type ImportIndex = { readonly version: 1; readonly imports: readonly ImportRecord[] };

const DEFAULT_URL = "http://127.0.0.1:7860";
const IMAGE_PATTERN = /\.(png|jpe?g)$/i;

export class DrawThingsProvider implements ImageGenerationProvider {
  readonly id = "draw_things" as const;
  readonly exportDirectory?: string;
  private readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly mode: DrawThingsMode;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly stableWindowMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly indexPath: string;

  constructor(options: DrawThingsOptions = {}) {
    this.enabled = options.enabled ?? parseBoolean(process.env.DRAW_THINGS_ENABLED);
    this.baseUrl = validateLocalBaseUrl(options.baseUrl ?? process.env.DRAW_THINGS_BASE_URL ?? DEFAULT_URL);
    this.exportDirectory = options.exportDirectory ?? process.env.DRAW_THINGS_EXPORT_DIR;
    this.mode = options.mode ?? parseMode(process.env.DRAW_THINGS_MODE);
    this.timeoutMs = options.timeoutMs ?? parsePositiveInt(process.env.DRAW_THINGS_TIMEOUT_MS, 600_000);
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
    this.stableWindowMs = options.stableWindowMs ?? 1_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.indexPath = path.resolve(options.cwd ?? process.cwd(), ".rigging-studio", "image-production", "draw-things", "imports.json");
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    if (!this.enabled) return unavailable("Draw Things is disabled. Set DRAW_THINGS_ENABLED=true after configuring a supported local mode.", this.exportDirectory);
    const direct = this.mode !== "watched_folder" ? await this.directStatus() : { available: false, reason: "Direct mode is disabled by configuration", models: [] as string[] };
    const watched = this.mode !== "direct" ? await this.watchedStatus() : { available: false, reason: "Watched-folder mode is disabled by configuration" };
    const selectedMode = direct.available ? "direct" as const : watched.available ? "watched_folder" as const : "unavailable" as const;
    return {
      provider: this.id, label: "Draw Things — Local", local: true, connected: selectedMode !== "unavailable", mode: selectedMode,
      characterGeneration: state(selectedMode !== "unavailable", direct.reason ?? watched.reason),
      characterVariant: state(direct.available, direct.available ? undefined : "Programmatic variants require the Draw Things HTTP API"),
      metadataCapture: { available: selectedMode !== "unavailable", level: direct.available ? "full" : watched.available ? "partial" : "unavailable", reason: watched.available && !direct.available ? "Watched-folder metadata depends on embedded PNG fields or a JSON sidecar" : undefined },
      watchedFolder: state(watched.available, watched.reason),
      models: direct.models.map((name) => ({ name, available: true as const })),
      message: selectedMode === "direct" ? `Draw Things HTTP API is ready at ${this.baseUrl}` : selectedMode === "watched_folder" ? `Watching ${this.exportDirectory}` : this.mode === "watched_folder" ? watched.reason ?? "Draw Things watched folder is unavailable" : direct.reason ?? watched.reason ?? "Draw Things is unavailable",
    };
  }

  async generateCharacter(input: CharacterGenerationRequest, signal?: AbortSignal): Promise<readonly GeneratedImageCandidate[]> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.characterGeneration.available) throw new Error(capabilities.message);
    if (capabilities.mode === "direct") return this.generateDirect(input, signal);
    return this.collectWatchedFolder(input, signal);
  }

  async generateVariant(input: CharacterGenerationRequest, signal?: AbortSignal): Promise<readonly GeneratedImageCandidate[]> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.characterVariant.available) throw new Error(capabilities.characterVariant.reason ?? "Draw Things variant generation is unavailable");
    return this.generateDirect({ ...input, generationIntent: "character_variant" }, signal);
  }

  async recordImport(hash: string, sourcePath: string, proposalId: string): Promise<void> {
    const index = await this.readIndex();
    const imports = index.imports.map((item) => item.hash === hash ? { ...item, proposalId } : item);
    await this.writeIndex({ version: 1, imports });
  }

  private async directStatus(): Promise<{ available: boolean; reason?: string; models: string[] }> {
    try {
      const response = await this.fetchWithTimeout(new URL("/sdapi/v1/options", `${this.baseUrl}/`), { method: "GET" }, Math.min(this.timeoutMs, 3_000));
      if (!response.ok) return { available: false, reason: `Draw Things HTTP API returned ${response.status} at ${this.baseUrl}`, models: [] };
      const json = await response.json() as Record<string, unknown>;
      const model = typeof json.sd_model_checkpoint === "string" ? json.sd_model_checkpoint : typeof json.model === "string" ? json.model : undefined;
      return { available: true, models: model ? [model] : [] };
    } catch (error: unknown) {
      return { available: false, reason: `Draw Things HTTP API is not reachable at ${this.baseUrl}: ${message(error)}`, models: [] };
    }
  }

  private async watchedStatus(): Promise<{ available: boolean; reason?: string }> {
    if (!this.exportDirectory) return { available: false, reason: "Set DRAW_THINGS_EXPORT_DIR to enable watched-folder import" };
    const directory = path.resolve(this.exportDirectory);
    try {
      const info = await stat(directory);
      if (!info.isDirectory()) return { available: false, reason: `Draw Things export path is not a directory: ${directory}` };
      await access(directory);
      return { available: true };
    } catch (error: unknown) {
      if (directory.startsWith(`${path.sep}Volumes${path.sep}`)) return { available: false, reason: `Draw Things export volume is unavailable or disconnected: ${directory}` };
      return { available: false, reason: `Draw Things export folder is unavailable: ${directory} (${message(error)})` };
    }
  }

  private async generateDirect(input: CharacterGenerationRequest, signal?: AbortSignal): Promise<readonly GeneratedImageCandidate[]> {
    const candidateCount = clampCount(input.candidateCount);
    const body: Record<string, unknown> = {
      prompt: input.prompt, negative_prompt: input.negativePrompt ?? "", width: input.width ?? 768, height: input.height ?? 768,
      steps: input.steps ?? 24, cfg_scale: input.guidance ?? 7, batch_size: candidateCount, n_iter: 1,
      ...(input.seed === undefined || input.seed === null ? {} : { seed: input.seed }), ...(input.model ? { model: input.model } : {}),
    };
    const response = await this.fetchWithTimeout(new URL("/sdapi/v1/txt2img", `${this.baseUrl}/`), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
    }, this.timeoutMs);
    if (!response.ok) throw new Error(`Draw Things generation failed with HTTP ${response.status}: ${await safeText(response)}`);
    const payload = await response.json() as Record<string, unknown>;
    if (!Array.isArray(payload.images) || payload.images.length === 0) throw new Error("Draw Things returned no generated images");
    const info = parseInfo(payload.info);
    return payload.images.slice(0, candidateCount).map((value, index) => {
      if (typeof value !== "string") throw new Error(`Draw Things image ${index + 1} is not base64 data`);
      const decoded = decodeImage(value);
      const seed = numberOrNull(arrayValue(info.all_seeds, index) ?? info.seed ?? input.seed ?? null);
      return {
        bytes: decoded.bytes, mimeType: decoded.mimeType, seed,
        metadata: compactMetadata({
          provider: this.id, mode: "direct", model: info.sd_model_name ?? info.model ?? input.model ?? null,
          modelHash: info.sd_model_hash ?? info.model_hash ?? null, prompt: input.prompt, negativePrompt: input.negativePrompt ?? "",
          seed, sampler: info.sampler_name ?? info.sampler ?? null, steps: info.steps ?? input.steps ?? null,
          guidance: info.cfg_scale ?? input.guidance ?? null, width: input.width ?? 768, height: input.height ?? 768,
          scheduler: info.scheduler ?? null, loras: info.loras ?? null, controlNet: info.controlnet ?? null,
          styleReferenceAssetId: input.styleReferenceAssetId ?? null, poseReferenceAssetId: input.poseReferenceAssetId ?? null,
          generationIntent: input.generationIntent, generationTimestamp: this.now().toISOString(), providerResponse: jsonSafe(info),
        }),
      };
    });
  }

  private async collectWatchedFolder(input: CharacterGenerationRequest, signal?: AbortSignal): Promise<readonly GeneratedImageCandidate[]> {
    if (!this.exportDirectory) throw new Error("DRAW_THINGS_EXPORT_DIR is not configured");
    const directory = path.resolve(this.exportDirectory);
    const wanted = clampCount(input.candidateCount);
    const deadline = Date.now() + this.timeoutMs;
    const initiallySeen = new Set((await this.readIndex()).imports.map((item) => item.hash));
    const initialFiles = new Set(await this.listImagePaths(directory));
    const candidates: GeneratedImageCandidate[] = [];
    while (Date.now() < deadline) {
      abortIfNeeded(signal);
      for (const filePath of await this.listImagePaths(directory)) {
        if (initialFiles.has(filePath)) continue;
        const stable = await this.readStableFile(filePath, signal);
        if (!stable) continue;
        const hash = createHash("sha256").update(stable).digest("hex");
        if (initiallySeen.has(hash) || (await this.readIndex()).imports.some((item) => item.hash === hash)) continue;
        const decoded = validateImage(stable, filePath);
        const embedded = decoded.mimeType === "image/png" ? parsePngMetadata(stable) : {};
        const sidecar = await readJsonSidecar(filePath);
        const metadata = normalizeExportMetadata({ ...embedded, ...sidecar });
        const seed = numberOrNull(metadata.seed ?? input.seed ?? null);
        await this.appendImport({ hash, sourcePath: filePath, importedAt: this.now().toISOString() });
        candidates.push({
          bytes: stable, mimeType: decoded.mimeType, seed, sourcePath: filePath,
          metadata: compactMetadata({
            provider: this.id, mode: "watched_folder", contentHash: hash, sourcePath: filePath,
            model: metadata.model ?? null, modelHash: metadata.modelHash ?? null, prompt: metadata.prompt ?? input.prompt,
            negativePrompt: metadata.negativePrompt ?? input.negativePrompt ?? "", seed, sampler: metadata.sampler ?? null,
            steps: metadata.steps ?? input.steps ?? null, guidance: metadata.guidance ?? input.guidance ?? null,
            width: decoded.width, height: decoded.height, scheduler: metadata.scheduler ?? null, loras: metadata.loras ?? null,
            controlNet: metadata.controlNet ?? null, styleReferenceAssetId: input.styleReferenceAssetId ?? null,
            poseReferenceAssetId: input.poseReferenceAssetId ?? null, generationIntent: input.generationIntent,
            generationTimestamp: metadata.generationTimestamp ?? this.now().toISOString(), embeddedMetadata: jsonSafe(embedded), sidecarMetadata: jsonSafe(sidecar),
          }),
        });
        if (candidates.length >= wanted) return candidates;
      }
      await delay(this.pollIntervalMs, signal);
    }
    throw new Error(`Timed out after ${this.timeoutMs}ms waiting for ${wanted} stable Draw Things export${wanted === 1 ? "" : "s"} in ${directory}`);
  }

  private async readStableFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    try {
      const first = await stat(filePath);
      if (!first.isFile() || first.size === 0) return null;
      await delay(this.stableWindowMs, signal);
      const second = await stat(filePath);
      if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) return null;
      return readFile(filePath);
    } catch { return null; }
  }

  private async listImagePaths(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && IMAGE_PATTERN.test(entry.name)).map((entry) => path.resolve(directory, entry.name)).sort();
  }

  private async readIndex(): Promise<ImportIndex> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as ImportIndex;
      return parsed.version === 1 && Array.isArray(parsed.imports) ? parsed : { version: 1, imports: [] };
    } catch { return { version: 1, imports: [] }; }
  }

  private async appendImport(record: ImportRecord): Promise<void> {
    const index = await this.readIndex();
    if (index.imports.some((item) => item.hash === record.hash)) return;
    await this.writeIndex({ version: 1, imports: [...index.imports, record] });
  }

  private async writeIndex(index: ImportIndex): Promise<void> {
    await mkdir(path.dirname(this.indexPath), { recursive: true });
    const temporary = `${this.indexPath}-${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, this.indexPath);
  }

  private fetchWithTimeout(url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
    return this.fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  }
}

function unavailable(reason: string, exportDirectory?: string): ProviderCapabilities {
  return { provider: "draw_things", label: "Draw Things — Local", local: true, connected: false, mode: "unavailable", characterGeneration: state(false, reason), characterVariant: state(false, reason), metadataCapture: { available: false, level: "unavailable", reason }, watchedFolder: state(false, exportDirectory ? "Draw Things is disabled" : "Set DRAW_THINGS_EXPORT_DIR to enable watched-folder import"), models: [], message: reason };
}
function state(available: boolean, reason?: string) { return { available, ...(reason && !available ? { reason } : {}) }; }
function parseBoolean(value: string | undefined): boolean { return value === "1" || value?.toLowerCase() === "true"; }
function parseMode(value: string | undefined): DrawThingsMode { return value === "direct" || value === "watched_folder" ? value : "auto"; }
function parsePositiveInt(value: string | undefined, fallback: number): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function clampCount(value: number | undefined): number { return Math.min(4, Math.max(1, Number.isInteger(value) ? value! : 1)); }
function message(error: unknown): string { return error instanceof Error ? error.message : "unknown error"; }
function abortIfNeeded(signal?: AbortSignal): void { if (signal?.aborted) throw new Error("Draw Things generation was cancelled"); }
function delay(ms: number, signal?: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Draw Things generation was cancelled")); }, { once: true }); }); }
async function safeText(response: Response): Promise<string> { try { return (await response.text()).slice(0, 500) || response.statusText; } catch { return response.statusText; } }
function parseInfo(value: unknown): Record<string, unknown> { if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; if (typeof value === "string") { try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } } return {}; }
function arrayValue(value: unknown, index: number): unknown { return Array.isArray(value) ? value[index] : undefined; }
function numberOrNull(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null; }
function decodeImage(value: string): { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" } { const match = /^data:(image\/(?:png|jpeg));base64,([\s\S]*)$/.exec(value); const bytes = Buffer.from(match?.[2] ?? value, "base64"); return { bytes, mimeType: validateImage(bytes).mimeType }; }
function validateLocalBaseUrl(value: string): string { const url = new URL(value); if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error("DRAW_THINGS_BASE_URL must be a credential-free localhost HTTP URL"); return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")); }

function validateImage(bytes: Uint8Array, filePath = "Draw Things output"): { mimeType: "image/png" | "image/jpeg"; width: number; height: number } {
  if (bytes.length === 0 || bytes.length > 24 * 1024 * 1024) throw new Error(`${filePath} is empty or exceeds the 24 MB limit`);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    if (bytes.length < 33 || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") throw new Error(`${filePath} is an incomplete PNG`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const width = view.getUint32(16); const height = view.getUint32(20);
    const colorType = bytes[25]; if (!width || !height || width > 8192 || height > 8192 || ![0, 2, 3, 4, 6].includes(colorType)) throw new Error(`${filePath} has unsupported PNG dimensions or color format`);
    try {
      const decoded = PNG.sync.read(Buffer.from(bytes));
      if (decoded.width !== width || decoded.height !== height || !decoded.data.some((value) => value !== 0)) throw new Error("zero pixels");
    } catch (error: unknown) { throw new Error(`${filePath} is not a decodable non-empty PNG: ${message(error)}`); }
    return { mimeType: "image/png", width, height };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error(`${filePath} is an incomplete JPEG`);
    let offset = 2; const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 8 < bytes.length) { if (bytes[offset] !== 0xff) { offset += 1; continue; } const marker = bytes[offset + 1]; const length = (bytes[offset + 2] << 8) | bytes[offset + 3]; if (sof.has(marker)) { const height = (bytes[offset + 5] << 8) | bytes[offset + 6]; const width = (bytes[offset + 7] << 8) | bytes[offset + 8]; if (width > 8192 || height > 8192) throw new Error(`${filePath} exceeds supported dimensions`); return { mimeType: "image/jpeg", width, height }; } if (length < 2) break; offset += length + 2; }
  }
  throw new Error(`${filePath} is not a complete supported PNG or JPEG`);
}

function parsePngMetadata(bytes: Uint8Array): Record<string, unknown> {
  const output: Record<string, unknown> = {}; let offset = 8;
  while (offset + 12 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4); const length = view.getUint32(0); const type = Buffer.from(bytes.slice(offset + 4, offset + 8)).toString("ascii");
    if (offset + 12 + length > bytes.length) break;
    const data = Buffer.from(bytes.slice(offset + 8, offset + 8 + length));
    try {
      if (type === "tEXt") { const split = data.indexOf(0); if (split > 0) output[data.subarray(0, split).toString("latin1")] = data.subarray(split + 1).toString("utf8"); }
      if (type === "zTXt") { const split = data.indexOf(0); if (split > 0 && data[split + 1] === 0) output[data.subarray(0, split).toString("latin1")] = inflateSync(data.subarray(split + 2)).toString("utf8"); }
      if (type === "iTXt") { const first = data.indexOf(0); if (first > 0) { const key = data.subarray(0, first).toString("utf8"); let cursor = first + 3; const languageEnd = data.indexOf(0, cursor); cursor = languageEnd + 1; const translatedEnd = data.indexOf(0, cursor); cursor = translatedEnd + 1; const text = data[first + 1] === 1 ? inflateSync(data.subarray(cursor)).toString("utf8") : data.subarray(cursor).toString("utf8"); output[key] = text; } }
    } catch { /* retain other supported metadata if one chunk is malformed */ }
    offset += length + 12; if (type === "IEND") break;
  }
  return output;
}

async function readJsonSidecar(filePath: string): Promise<Record<string, unknown>> {
  const candidates = [`${filePath}.json`, filePath.replace(/\.[^.]+$/, ".json")];
  for (const candidate of candidates) { try { const value = JSON.parse(await readFile(candidate, "utf8")) as unknown; if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* optional */ } }
  return {};
}

function normalizeExportMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const nested = parseInfo(input.parameters ?? input.Parameters ?? input.generation ?? input.Generation ?? input);
  const source = { ...input, ...nested };
  return {
    prompt: source.prompt ?? source.positivePrompt ?? source.Prompt, negativePrompt: source.negativePrompt ?? source.negative_prompt ?? source.NegativePrompt,
    seed: source.seed ?? source.Seed, model: source.model ?? source.modelName ?? source.Model, modelHash: source.modelHash ?? source.model_hash,
    sampler: source.sampler ?? source.samplerName, steps: source.steps, guidance: source.guidance ?? source.cfgScale ?? source.cfg_scale,
    scheduler: source.scheduler, loras: source.loras ?? source.LoRAs, controlNet: source.controlNet ?? source.controlnet,
    generationTimestamp: source.generationTimestamp ?? source.createdAt,
  };
}

function jsonSafe(value: unknown): ImageProductionJson { if (value === null || typeof value === "string" || typeof value === "boolean") return value; if (typeof value === "number") return Number.isFinite(value) ? value : null; if (Array.isArray(value)) return value.map(jsonSafe); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)])); return null; }
function compactMetadata(input: Record<string, unknown>): Readonly<Record<string, ImageProductionJson>> { return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, jsonSafe(value)])); }
