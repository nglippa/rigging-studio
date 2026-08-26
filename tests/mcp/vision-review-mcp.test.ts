import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createRiggingStudioMcpServer } from "../../mcp/server";
import { ManualReviewProvider, VisionReviewQueue, VisionReviewService } from "../../mcp/vision-review";
import { StudioBridgeServer } from "../../mcp/transport/StudioBridgeServer";
import { acceptedReview, artifact } from "./vision-review-fixtures";

const bridges: StudioBridgeServer[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map((bridge) => bridge.close())); });

describe("vision review MCP queue bridge", () => {
  it("lists, opens, reads only attached artifacts, submits, and requests bounded rerenders without a live editor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vision-mcp-")); let sequence = 0; const queue = new VisionReviewQueue({ root, idFactory: () => `mcp-job-${++sequence}` });
    const service = new VisionReviewService({ queue, providers: [new ManualReviewProvider()], policy: { policy: "manual-only", maxAttempts: 3 } });
    const first = await service.createJob({ type: "RIG_POSE_REVIEW", subject: "neutral pose", artifacts: [artifact("pose.png", "pose")] });
    const second = await service.createJob({ type: "ANIMATION_REVIEW", subject: "walk frames", artifacts: [artifact("frame.png", "animation_frame")] });
    const bridge = new StudioBridgeServer({ port: 0, cwd: root, visionReviewService: service }); bridges.push(bridge); const server = createRiggingStudioMcpServer(bridge);
    const port = await bridge.waitUntilListening().catch((error: unknown) => error instanceof Error && /EPERM|operation not permitted/i.test(error.message) ? null : Promise.reject(error));
    if (port !== null) { const browserStatus = await fetch(`http://127.0.0.1:${port}/vision-review/status`); expect(browserStatus.status).toBe(200); expect(await browserStatus.json()).toMatchObject({ policy: { policy: "manual-only", maxAttempts: 3 }, providers: [{ providerId: "manual", available: true, multimodal: true }] }); }
    const client = new Client({ name: "vision-review-test", version: "1" }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = await client.listTools(); expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["rigging_review_provider_status", "rigging_review_list_pending", "rigging_review_open_job", "rigging_review_submit_result", "rigging_review_request_rerender"]));
    const templates = await client.listResourceTemplates(); expect(templates.resourceTemplates.map((item) => item.uriTemplate)).toContain("rigging://review-queue/{jobId}/artifacts/{artifactName}");
    const pending = await client.callTool({ name: "rigging_review_list_pending", arguments: {} }); expect(pending.isError).not.toBe(true); expect((pending.structuredContent as { jobs: unknown[] }).jobs).toHaveLength(2);
    const opened = await client.callTool({ name: "rigging_review_open_job", arguments: { jobId: first.jobId } }); const resource = (opened.structuredContent as { artifactResources: { uri: string }[] }).artifactResources[0].uri;
    const image = await client.readResource({ uri: resource }); expect(image.contents[0]).toMatchObject({ mimeType: "image/png" });
    await expect(client.readResource({ uri: `rigging://review-queue/${first.jobId}/artifacts/not-attached.png` })).rejects.toThrow();
    const submitted = await client.callTool({ name: "rigging_review_submit_result", arguments: { jobId: first.jobId, result: acceptedReview() } }); expect(submitted.isError).not.toBe(true); expect(submitted.structuredContent).toMatchObject({ success: true, result: { decision: "ACCEPT" }, provenance: { providerId: "manual" } });
    const rerender = await client.callTool({ name: "rigging_review_request_rerender", arguments: { jobId: second.jobId, reason: "need attack midpoint" } }); expect(rerender.structuredContent).toMatchObject({ success: true, status: "RERENDER_REQUESTED", rerenderReason: "need attack midpoint" });
    await client.close(); await server.close();
  });
});
