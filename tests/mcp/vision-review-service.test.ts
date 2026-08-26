import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ManualReviewProvider, VisionReviewQueue, VisionReviewService } from "../../mcp/vision-review";
import type { VisionReviewCapabilities, VisionReviewInvocation, VisionReviewProvider } from "../../src/vision-review";
import { acceptedReview, artifact } from "./vision-review-fixtures";

const capabilities = (id: string, available = true): VisionReviewCapabilities => ({ providerId: id, label: id, state: available ? "AVAILABLE_AND_MULTIMODAL" : "UNAVAILABLE", available, multimodal: available, supportsSourceImage: available, supportsMaskImage: available, supportsRenderedPose: available, supportsAnimationFrames: available, structuredOutput: available, localOnly: id === "ollama-vision", usesExistingAccountSession: id.includes("codex"), supportsIterativeReview: available, supportsRelativeRanking: available, supportedJobTypes: available ? ["CUT_MASK_REVIEW", "OCCLUSION_RECONSTRUCTION_REVIEW", "CANONICAL_OWNERSHIP_REVIEW", "RIG_POSE_REVIEW", "ANIMATION_REVIEW"] : [], transport: "fixture", version: "1", model: "fixture", failureReason: available ? null : "not running" });
const provider = (id: string, behavior: "accept" | "fail" | "invalid" | "unavailable"): VisionReviewProvider => ({
  id, capabilities: async () => capabilities(id, behavior !== "unavailable"), isAvailable: async () => behavior !== "unavailable",
  review: async (): Promise<VisionReviewInvocation> => { if (behavior === "fail") throw new Error("provider failed"); if (behavior === "invalid") return { result: { decision: "PASS" } as never, providerVersion: "1", model: "fixture", classification: "local", authenticatedViaExistingSession: false }; return { result: acceptedReview(), providerVersion: "1", model: "fixture", classification: id.includes("codex") ? "account-backed-cloud" : "local", authenticatedViaExistingSession: id.includes("codex") }; },
});
const setup = async (providers: readonly VisionReviewProvider[]) => { const root = await mkdtemp(path.join(tmpdir(), "review-service-")); const queue = new VisionReviewQueue({ root, idFactory: () => "job" }); const service = new VisionReviewService({ queue, providers, policy: { policy: "local-first", maxAttempts: 3 } }); const job = await service.createJob({ type: "CUT_MASK_REVIEW", subject: "mask", artifacts: [artifact()] }); return { queue, service, job }; };

describe("vision review broker fallback and veto", () => {
  it("falls back when Ollama is unavailable and records the successful next provider", async () => {
    const { service, job, queue } = await setup([provider("ollama-vision", "unavailable"), provider("codex-local-agent", "accept"), new ManualReviewProvider()]); const result = await service.review(job.jobId);
    expect(result).toMatchObject({ result: { decision: "ACCEPT" }, provenance: { providerId: "codex-local-agent", authenticatedViaExistingSession: true } }); expect((await queue.loadStatus(job.jobId)).providerAttempts.map((item) => item.outcome)).toEqual(["unavailable", "completed"]);
  });
  it("falls back after malformed provider output", async () => {
    const { service, job, queue } = await setup([provider("ollama-vision", "invalid"), provider("codex-local-agent", "accept"), new ManualReviewProvider()]); expect((await service.review(job.jobId)).provenance.providerId).toBe("codex-local-agent"); expect((await queue.loadStatus(job.jobId)).providerAttempts[0].outcome).toBe("invalid");
  });
  it("lets deterministic prechecks skip AI and postchecks veto AI ACCEPT", async () => {
    const first = await setup([provider("ollama-vision", "accept"), new ManualReviewProvider()]); const pre = await first.service.review(first.job.jobId, { precheck: () => ["mask clips source bounds"] }); expect(pre).toMatchObject({ result: { decision: "HUMAN_REVIEW" }, provenance: { providerId: "manual", deterministicVetoes: ["mask clips source bounds"] } }); expect((await first.queue.loadStatus(first.job.jobId)).providerAttempts).toHaveLength(1);
    const second = await setup([provider("ollama-vision", "accept"), new ManualReviewProvider()]); const post = await second.service.review(second.job.jobId, { postcheck: () => ["canonical ownership overlap"] }); expect(post).toMatchObject({ result: { decision: "HUMAN_REVIEW" }, provenance: { deterministicVetoes: ["canonical ownership overlap"] } });
  });
  it("returns HUMAN_REVIEW when all automatic providers fail", async () => {
    const { service, job } = await setup([provider("ollama-vision", "fail"), provider("codex-local-agent", "fail"), new ManualReviewProvider()]); expect((await service.review(job.jobId)).result.decision).toBe("HUMAN_REVIEW");
  });
});
