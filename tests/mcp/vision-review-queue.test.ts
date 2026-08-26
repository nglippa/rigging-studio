import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VisionReviewQueue } from "../../mcp/vision-review";
import { acceptedReview, artifact } from "./vision-review-fixtures";

describe("contained visual-review queue", () => {
  it("persists self-contained jobs, prompt, artifacts, and exact hashes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "review-queue-")); const queue = new VisionReviewQueue({ root, idFactory: () => "job-a", now: () => new Date("2026-08-25T00:00:00.000Z") });
    const job = await queue.create({ type: "CUT_MASK_REVIEW", subject: "left forearm mask", expectedSemantic: "leftForearm", deterministicFindings: ["inside source bounds"], artifacts: [artifact("source.png"), artifact("mask.png", "mask")] });
    expect(job.artifacts).toHaveLength(2); expect(job.artifacts.every((item) => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
    const packet = await queue.openPacket(job.jobId); expect(packet.prompt).toContain("semantic ownership"); expect(packet.artifactResources[0].uri).toContain("rigging://review-queue/job-a/artifacts/");
    expect((await queue.readArtifact(job.jobId, "source.png")).bytes).toEqual(artifact().bytes); expect(await queue.listPending()).toHaveLength(1);
  });
  it("rejects traversal, undeclared reads, hash changes, oversized metadata, and suspected secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "review-containment-")); const queue = new VisionReviewQueue({ root, idFactory: () => "safe" });
    await expect(queue.create({ type: "CUT_MASK_REVIEW", subject: "safe", artifacts: [artifact("../escape.png")] })).rejects.toThrow(/identifier|path/i);
    await expect(queue.create({ type: "CUT_MASK_REVIEW", subject: "api_key=sk-abcdefghijklmnop", artifacts: [artifact()] })).rejects.toThrow(/authentication/);
    const job = await queue.create({ type: "CUT_MASK_REVIEW", subject: "safe", artifacts: [artifact()] }); await expect(queue.readArtifact(job.jobId, "other.png")).rejects.toThrow(/not attached/);
    const paths = await queue.artifactPaths(job.jobId); await writeFile(paths["source.png"], artifact().bytes.subarray(0, 40)); await expect(queue.readArtifact(job.jobId, "source.png")).rejects.toThrow(/size|hash/);
  });
  it("tracks parent/child rounds and stops exactly at max attempts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "review-rounds-")); let sequence = 0; const queue = new VisionReviewQueue({ root, idFactory: () => `round-${++sequence}` });
    const first = await queue.create({ type: "RIG_POSE_REVIEW", subject: "pose", maxAttempts: 2, artifacts: [artifact()] });
    const second = await queue.create({ type: "RIG_POSE_REVIEW", subject: "pose revised", parentJobId: first.jobId, repairApplied: "moved elbow pivot", artifacts: [artifact()] });
    expect(second).toMatchObject({ parentJobId: first.jobId, attempt: 2, maxAttempts: 2, repairApplied: "moved elbow pivot" });
    await expect(queue.create({ type: "RIG_POSE_REVIEW", subject: "third", parentJobId: second.jobId, artifacts: [artifact()] })).rejects.toThrow(/max attempts/);
    await expect(queue.requestRerender(second.jobId, "another pass")).rejects.toThrow(/max attempts/);
  });
  it("consumes valid manual result.json, rejects malformed result, and records provenance without credentials", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "review-manual-")); let sequence = 0; const queue = new VisionReviewQueue({ root, idFactory: () => `manual-${++sequence}`, now: () => new Date("2026-08-25T00:00:00.000Z") });
    const good = await queue.create({ type: "CANONICAL_OWNERSHIP_REVIEW", subject: "ownership", artifacts: [artifact()] });
    await writeFile(path.join(root, good.jobId, "result.json"), JSON.stringify(acceptedReview())); const consumed = await queue.consumeManualResult(good.jobId);
    expect(consumed).toMatchObject({ result: { decision: "ACCEPT" }, provenance: { providerId: "manual", classification: "manual", authenticatedViaExistingSession: false } });
    expect(JSON.stringify(consumed.provenance)).not.toMatch(/sk-|api[_-]?key|cookie|bearer/i); expect(await queue.listPending()).toHaveLength(0);
    const bad = await queue.create({ type: "CUT_MASK_REVIEW", subject: "bad", artifacts: [artifact()] }); await writeFile(path.join(root, bad.jobId, "result.json"), "{\"decision\":\"PASS\"}"); await expect(queue.consumeManualResult(bad.jobId)).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(root, good.jobId, "provider-result.json"), "utf8")).provenance.sourceArtifactHashes["source.png"]).toBe(good.artifacts[0].sha256);
  });
});
