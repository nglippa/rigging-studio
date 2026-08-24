import { describe, expect, it } from "vitest";
import { ProviderHealthService, automaticCutReadiness, characterPipelineCapabilitiesFromHealth } from "../../src/local-services/providerHealth";

const capability = (id: string, available = true, reason?: string) => ({ capability: id, capabilityAvailable: available, workflowId: available ? `${id.toLowerCase()}-v1` : undefined, requiredModels: available ? ["configured-model"] : [], reason });
const payload = (options: { reachable?: boolean; segmentation?: boolean; providers?: readonly unknown[] } = {}) => ({
  provider: { reachable: options.reachable ?? true, url: "http://127.0.0.1:8188", message: options.reachable === false ? "connect refused" : "ready", queue: { running: 0, pending: 0 } },
  capabilities: [
    capability("CHARACTER_SEGMENTATION", options.segmentation ?? true, options.segmentation === false ? "Missing ComfyUI-SAM2 nodes" : undefined),
    capability("MASK_REFINEMENT"), capability("OCCLUSION_RECONSTRUCTION"), capability("BACKGROUND_REMOVAL", false, "Optional workflow unavailable"), capability("ALPHA_EDGE_CLEANUP", false, "Optional workflow unavailable"),
  ],
  providers: options.providers ?? [],
});

const service = (body: unknown, requests: string[] = []) => new ProviderHealthService({
  endpoint: "http://bridge/image-production/status",
  fetcher: (async (input) => { requests.push(String(input)); return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch,
  setTimer: (() => 1 as unknown as ReturnType<typeof setTimeout>), clearTimer: (() => undefined),
  now: () => new Date("2026-08-24T01:00:00.000Z"),
});

describe("central provider health", () => {
  it("marks ComfyUI READY only when the required segmentation capability is present", async () => {
    const health = await service(payload()).probe();
    expect(health).toMatchObject({ state: "READY", dependency: "FALLBACK_AVAILABLE", automaticCutRequiredForZeroTouch: true, manualFallbackAvailable: true, lastSuccessfulCheckAt: "2026-08-24T01:00:00.000Z" });
    expect(automaticCutReadiness(health)).toEqual({ allowed: true, manualFallbackAvailable: true, reason: null });
    expect(characterPipelineCapabilitiesFromHealth(health).segmentation.available).toBe(true);
  });

  it("classifies a reachable endpoint with missing nodes/models as MISCONFIGURED", async () => {
    const health = await service(payload({ segmentation: false })).probe();
    expect(health.state).toBe("MISCONFIGURED");
    expect(health.lastError).toContain("Missing ComfyUI-SAM2 nodes");
    expect(automaticCutReadiness(health)).toMatchObject({ allowed: false, manualFallbackAvailable: true });
  });

  it("classifies a required provider outage as OFFLINE without disabling manual fallback", async () => {
    const health = await service(payload({ reachable: false, segmentation: false })).probe();
    expect(health.state).toBe("OFFLINE");
    expect(automaticCutReadiness(health)).toMatchObject({ allowed: false, manualFallbackAvailable: true });
  });

  it("does not degrade automatic cutting because an optional generation provider is offline", async () => {
    const health = await service(payload({ providers: [{ provider: "draw_things", label: "Draw Things", connected: false, mode: "disabled", characterGeneration: { available: false, reason: "disabled" }, message: "disabled" }] })).probe();
    expect(health.state).toBe("READY");
    expect(health.generationProviders[0]).toMatchObject({ provider: "draw_things", connected: false });
  });

  it("manual Retry bypasses the timer and forces a capability refresh", async () => {
    const requests: string[] = []; const healthService = service(payload(), requests);
    await healthService.retry();
    expect(requests).toEqual(["http://bridge/image-production/status?refresh=1"]);
    expect(healthService.snapshot.state).toBe("READY");
  });

  it("rejects an HTTP-only or schema-incompatible health response", async () => {
    const health = await service({ provider: { reachable: true }, capabilities: [{ capability: "CHARACTER_SEGMENTATION" }] }).probe();
    expect(health.state).toBe("OFFLINE");
    expect(health.lastError).toContain("schema is incompatible");
  });

  it("marks provider loss mid-job without inventing a partial success", async () => {
    const healthService = service(payload()); await healthService.probe();
    healthService.reportJobFailure(new Error("network connection lost during segmentation"));
    expect(healthService.snapshot).toMatchObject({ state: "OFFLINE", lastError: "network connection lost during segmentation" });
  });
});

