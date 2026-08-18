import { readFile } from "node:fs/promises";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StudioBridgeServer } from "../transport/StudioBridgeServer";

const textResource = (uri: string, value: unknown) => ({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] });

export const registerStudioResources = (server: McpServer, bridge: StudioBridgeServer): void => {
  server.registerResource("active-project", "rigging://active-project", { mimeType: "application/json", description: "Live Studio session and active project summary" }, async () => {
    try { return textResource("rigging://active-project", await bridge.request("studio_get_status", { includeActivity: false })); }
    catch (error: unknown) { return textResource("rigging://active-project", { connected: false, error: error instanceof Error ? error.message : "Studio unavailable" }); }
  });
  server.registerResource("active-rig", "rigging://active-project/rig", { mimeType: "application/json", description: "Full validated active rig definition" }, async () =>
    textResource("rigging://active-project/rig", await bridge.request("rig_get_summary", { includeHierarchy: true, includeFull: true })));
  server.registerResource("active-animations", "rigging://active-project/animations", { mimeType: "application/json", description: "Concise active animation library summary" }, async () =>
    textResource("rigging://active-project/animations", await bridge.request("animation_list", {})));
  server.registerResource("active-warnings", "rigging://active-project/warnings", { mimeType: "application/json", description: "Current shared validation warnings and errors" }, async () =>
    textResource("rigging://active-project/warnings", await bridge.request("validation_get", { includeDetails: true })));
  server.registerResource("latest-preview", "rigging://active-project/preview/latest", { mimeType: "image/png", description: "Latest deterministic diagnostic contact sheet" }, async () => {
    const path = bridge.previewPath;
    if (!path) return textResource("rigging://active-project/preview/latest", { available: false, message: "Render a preview first" });
    return { contents: [{ uri: "rigging://active-project/preview/latest", mimeType: "image/png", blob: (await readFile(path)).toString("base64") }] };
  });
  server.registerResource("image-proposal-candidate", new ResourceTemplate("rigging://image-proposals/{proposalId}/candidates/{candidateId}", { list: undefined }), { mimeType: "image/png", description: "One managed ComfyUI proposal candidate; reading records inspection evidence" }, async (uri, variables) => {
    const result = await bridge.getImageCandidate(String(variables.proposalId), String(variables.candidateId));
    return { contents: [{ uri: uri.href, mimeType: result.mimeType, blob: Buffer.from(result.bytes).toString("base64") }] };
  });
  server.registerResource("image-proposal-contact-sheet", new ResourceTemplate("rigging://image-proposals/{proposalId}/contact-sheet", { list: undefined }), { mimeType: "image/png", description: "Managed candidate contact sheet; reading records inspection evidence" }, async (uri, variables) => {
    const result = await bridge.imageProduction.getContactSheet(String(variables.proposalId));
    return { contents: [{ uri: uri.href, mimeType: "image/png", blob: Buffer.from(result.bytes).toString("base64") }] };
  });
};
