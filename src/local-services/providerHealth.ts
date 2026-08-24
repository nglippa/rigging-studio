import { OptionalServiceRetryBackoff } from "./retryBackoff";
import type { CharacterPipelineCapabilities, CharacterPipelineCapability } from "../character-generation/providers/characterPipelineProvider";

export const PROVIDER_READINESS_STATES = ["DISABLED", "CHECKING", "READY", "DEGRADED", "OFFLINE", "MISCONFIGURED"] as const;
export type ProviderReadinessState = (typeof PROVIDER_READINESS_STATES)[number];
export type ProviderDependencyPolicy = "REQUIRED" | "OPTIONAL" | "FALLBACK_AVAILABLE";

export type ProviderCapabilityHealth = {
  readonly id: string;
  readonly available: boolean;
  readonly workflowId: string | null;
  readonly requiredModels: readonly string[];
  readonly reason: string | null;
};

export type ProviderHealthSnapshot = {
  readonly providerId: "comfyui";
  readonly label: "ComfyUI";
  readonly state: ProviderReadinessState;
  readonly endpoint: string | null;
  readonly dependency: ProviderDependencyPolicy;
  readonly productionPolicy: "COMFYUI_OPTIONAL_WITH_MANUAL_FALLBACK";
  readonly automaticCutRequiredForZeroTouch: true;
  readonly manualFallbackAvailable: true;
  readonly capabilities: readonly ProviderCapabilityHealth[];
  readonly generationProviders: readonly {
    readonly provider: string;
    readonly label: string;
    readonly connected: boolean;
    readonly mode: string;
    readonly characterGeneration: { readonly available: boolean; readonly reason?: string };
    readonly message: string;
  }[];
  readonly lastCheckedAt: string | null;
  readonly lastSuccessfulCheckAt: string | null;
  readonly lastError: string | null;
  readonly queue: { readonly running: number; readonly pending: number };
};

type StatusPayload = {
  readonly provider?: { readonly reachable?: unknown; readonly url?: unknown; readonly message?: unknown; readonly queue?: { readonly running?: unknown; readonly pending?: unknown } };
  readonly capabilities?: readonly { readonly capability?: unknown; readonly capabilityAvailable?: unknown; readonly workflowId?: unknown; readonly requiredModels?: unknown; readonly reason?: unknown }[];
  readonly providers?: readonly { readonly provider?: unknown; readonly label?: unknown; readonly connected?: unknown; readonly mode?: unknown; readonly characterGeneration?: { readonly available?: unknown; readonly reason?: unknown }; readonly message?: unknown }[];
};

type Options = {
  readonly endpoint?: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

const initialSnapshot = (): ProviderHealthSnapshot => ({
  providerId: "comfyui", label: "ComfyUI", state: "CHECKING", endpoint: null, dependency: "FALLBACK_AVAILABLE",
  productionPolicy: "COMFYUI_OPTIONAL_WITH_MANUAL_FALLBACK", automaticCutRequiredForZeroTouch: true, manualFallbackAvailable: true,
  capabilities: [], generationProviders: [], lastCheckedAt: null, lastSuccessfulCheckAt: null, lastError: null, queue: { running: 0, pending: 0 },
});

const stringValue = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const nonnegativeInteger = (value: unknown): number => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

export class ProviderHealthService {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly setTimer: NonNullable<Options["setTimer"]>;
  private readonly clearTimer: NonNullable<Options["clearTimer"]>;
  private readonly backoff = new OptionalServiceRetryBackoff();
  private readonly listeners = new Set<() => void>();
  private snapshotValue = initialSnapshot();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<ProviderHealthSnapshot> | null = null;

  constructor(options: Options = {}) {
    this.endpoint = options.endpoint ?? `${typeof process !== "undefined" ? process.env.NEXT_PUBLIC_RIGGING_STUDIO_BRIDGE_URL ?? "http://127.0.0.1:47831" : "http://127.0.0.1:47831"}/image-production/status`;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  get snapshot(): ProviderHealthSnapshot { return this.snapshotValue; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.probe();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    };
  }

  probe(forceCapabilityRefresh = false): Promise<ProviderHealthSnapshot> {
    if (this.pending) return this.pending;
    const request = this.runProbe(forceCapabilityRefresh).finally(() => { if (this.pending === request) this.pending = null; });
    this.pending = request;
    return request;
  }

  retry(): Promise<ProviderHealthSnapshot> {
    this.backoff.reset();
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    this.publish({ ...this.snapshotValue, state: "CHECKING", lastError: null });
    return this.probe(true);
  }

  reportJobFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : "ComfyUI job failed";
    const unavailable = /fetch|network|offline|connect|timed? out|abort/i.test(message);
    this.publish({ ...this.snapshotValue, state: unavailable ? "OFFLINE" : "DEGRADED", lastCheckedAt: this.now().toISOString(), lastError: message });
    this.schedule(false);
  }

  private async runProbe(force: boolean): Promise<ProviderHealthSnapshot> {
    const checkedAt = this.now().toISOString();
    try {
      const response = await this.fetcher(`${this.endpoint}${force ? `${this.endpoint.includes("?") ? "&" : "?"}refresh=1` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Provider health request failed (${response.status})`);
      const parsed = this.parse(await response.json() as StatusPayload, checkedAt);
      this.publish(parsed);
      this.schedule(parsed.state === "READY");
      return parsed;
    } catch (error: unknown) {
      const failed = { ...this.snapshotValue, state: "OFFLINE" as const, lastCheckedAt: checkedAt, lastError: error instanceof Error ? error.message : "Provider health check failed" };
      this.publish(failed); this.schedule(false); return failed;
    }
  }

  private parse(payload: StatusPayload, checkedAt: string): ProviderHealthSnapshot {
    if (!payload.provider || typeof payload.provider.reachable !== "boolean" || !Array.isArray(payload.capabilities)) throw new Error("Provider health response schema is incompatible");
    const capabilities = payload.capabilities.map((item): ProviderCapabilityHealth => {
      const id = stringValue(item.capability); if (!id || typeof item.capabilityAvailable !== "boolean") throw new Error("Provider capability response schema is incompatible");
      return { id, available: item.capabilityAvailable, workflowId: stringValue(item.workflowId), requiredModels: Array.isArray(item.requiredModels) ? item.requiredModels.filter((value: unknown): value is string => typeof value === "string") : [], reason: stringValue(item.reason) };
    });
    const segmentation = capabilities.find((item) => item.id === "CHARACTER_SEGMENTATION");
    const generationProviders = (payload.providers ?? []).flatMap((item) => {
      const provider = stringValue(item.provider); const label = stringValue(item.label);
      if (!provider || !label || typeof item.connected !== "boolean" || typeof item.characterGeneration?.available !== "boolean") return [];
      return [{ provider, label, connected: item.connected, mode: stringValue(item.mode) ?? "unavailable", characterGeneration: { available: item.characterGeneration.available, ...(stringValue(item.characterGeneration.reason) ? { reason: stringValue(item.characterGeneration.reason)! } : {}) }, message: stringValue(item.message) ?? "Provider status unavailable" }];
    });
    const reachable = payload.provider.reachable;
    const state: ProviderReadinessState = !reachable ? "OFFLINE" : segmentation?.available ? "READY" : "MISCONFIGURED";
    const message = stringValue(payload.provider.message);
    return {
      ...initialSnapshot(), state, endpoint: stringValue(payload.provider.url), capabilities, generationProviders, lastCheckedAt: checkedAt,
      lastSuccessfulCheckAt: state === "READY" ? checkedAt : this.snapshotValue.lastSuccessfulCheckAt,
      lastError: state === "READY" ? null : segmentation?.reason ?? message ?? "Required segmentation capability is unavailable",
      queue: { running: nonnegativeInteger(payload.provider.queue?.running), pending: nonnegativeInteger(payload.provider.queue?.pending) },
    };
  }

  private schedule(succeeded: boolean): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    if (!this.listeners.size) { this.timer = null; return; }
    this.timer = this.setTimer(() => { this.timer = null; void this.probe(); }, this.backoff.nextDelay(succeeded));
  }

  private publish(next: ProviderHealthSnapshot): void {
    this.snapshotValue = next;
    this.listeners.forEach((listener) => listener());
  }
}

let singleton: ProviderHealthService | null = null;
export const getProviderHealthService = (): ProviderHealthService => singleton ??= new ProviderHealthService();

export const automaticCutReadiness = (health: ProviderHealthSnapshot): { readonly allowed: boolean; readonly manualFallbackAvailable: true; readonly reason: string | null } => ({
  allowed: health.state === "READY" && Boolean(health.capabilities.find((capability) => capability.id === "CHARACTER_SEGMENTATION")?.available),
  manualFallbackAvailable: true,
  reason: health.state === "READY" ? null : health.lastError ?? "ComfyUI segmentation is unavailable",
});

export function characterPipelineCapabilitiesFromHealth(health: ProviderHealthSnapshot): CharacterPipelineCapabilities {
  const capability = (id: string, modelFamily: string): CharacterPipelineCapability => {
    const found = health.capabilities.find((item) => item.id === id);
    return {
      available: Boolean(health.state === "READY" && found?.available), imageConditioned: true,
      mode: health.state === "READY" && found?.available ? "provider" : "unavailable", provider: "comfyui",
      ...(found?.workflowId ? { workflow: found.workflowId } : {}), modelFamily,
      confidenceSource: found?.available ? "provider" : "unavailable",
      ...(!found?.available ? { reason: found?.reason ?? health.lastError ?? "Capability is unavailable" } : {}),
    };
  };
  return {
    segmentation: capability("CHARACTER_SEGMENTATION", "Grounding DINO + SAM2"),
    maskRefinement: capability("MASK_REFINEMENT", "Grounding DINO + SAM2"),
    reconstruction: capability("OCCLUSION_RECONSTRUCTION", "checkpoint inpainting"),
    backgroundRemoval: capability("BACKGROUND_REMOVAL", "configured trusted workflow"),
    alphaCleanup: capability("ALPHA_EDGE_CLEANUP", "configured trusted workflow"),
  };
}
