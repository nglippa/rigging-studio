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
    expect(tools.tools.map((tool) => tool.name)).not.toContain("image_prepare_repair_context");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("image_analyze_candidate_suitability");
    expect(tools.tools.some((tool) => /shell|eval|javascript|arbitrary_file/i.test(tool.name))).toBe(false);
    const status = await client.callTool({ name: "studio_get_status", arguments: { includeActivity: false } });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({ connected: false });
    const malformed = await client.callTool({ name: "rig_move_bone", arguments: { boneId: "head", x: "not-a-number", y: 1 } });
    expect(malformed.isError).toBe(true);
    await client.close(); await server.close();
  });
});
