import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createRiggingStudioMcpServer } from "../../mcp/server";
import { StudioBridgeServer } from "../../mcp/transport/StudioBridgeServer";

const bridges: StudioBridgeServer[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map((bridge) => bridge.close())); });

describe("Rigging Studio MCP server", () => {
  it("negotiates with an MCP client and exposes only the deliberate control surface", async () => {
    const bridge = new StudioBridgeServer({ port: 0 }); bridges.push(bridge);
    const server = createRiggingStudioMcpServer(bridge);
    const client = new Client({ name: "rigging-studio-integration-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("rig_move_bone");
    expect(tools.tools.map((tool) => tool.name)).toContain("preview_render");
    expect(tools.tools.map((tool) => tool.name)).toContain("character_import_generation");
    expect(tools.tools.map((tool) => tool.name)).toContain("diagnostics_export_report");
    expect(tools.tools.map((tool) => tool.name)).toContain("character_generate_with_comfy");
    expect(tools.tools.map((tool) => tool.name)).toContain("image_render_candidate_sheet");
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["rigging_review_provider_status", "rigging_review_list_pending", "rigging_review_open_job", "rigging_review_submit_result", "rigging_review_request_rerender"]));
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["segmentation_status", "character_ai_cut", "part_refine_mask", "part_reconstruct_hidden", "part_get_reconstruction_proposal", "part_render_reconstruction_preview", "part_approve_reconstruction", "part_reject_reconstruction", "background_remove", "alpha_cleanup"]));
    expect(tools.tools.map((tool) => tool.name)).not.toContain("image_prepare_repair_context");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("image_analyze_candidate_suitability");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("parts_install_ai_proposal");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("part_install_reconstruction_proposal");
    expect(tools.tools.some((tool) => /shell|eval|javascript|arbitrary_file/i.test(tool.name))).toBe(false);
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual(expect.arrayContaining(["rigging://active-project/segmentation/{proposalId}", "rigging://active-project/reconstruction/{partId}", "rigging://review-queue/{jobId}/artifacts/{artifactName}"]));
    const status = await client.callTool({ name: "studio_get_status", arguments: { includeActivity: false } });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({ connected: false });
    const malformed = await client.callTool({ name: "rig_move_bone", arguments: { boneId: "head", x: "not-a-number", y: 1 } });
    expect(malformed.isError).toBe(true);
    await client.close(); await server.close();
  });
});
