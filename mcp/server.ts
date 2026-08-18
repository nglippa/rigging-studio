#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOL_NAMES, studioToolSchemas, type StudioToolName } from "../src/agent-control/validation/toolSchemas";
import { registerStudioResources } from "./resources/registerResources";
import { READ_ONLY_TOOLS, toolDescription } from "./tools/toolCatalog";
import { StudioBridgeServer } from "./transport/StudioBridgeServer";
import type { DiagnosticReportRequest } from "./storage/diagnosticReportExporter";
import type { GenerationImportRequest } from "./storage/managedGenerationStorage";

const toolResponse = (structured: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
  structuredContent: structured,
  isError: structured.success === false,
});

const imageToolResponse = (structured: Record<string, unknown>, image?: { readonly bytes: Uint8Array; readonly mimeType: "image/png" | "image/jpeg" }) => ({
  content: [
    { type: "text" as const, text: JSON.stringify(structured, null, 2) },
    ...(image ? [{ type: "image" as const, data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType }] : []),
  ],
  structuredContent: structured,
  isError: structured.success === false,
});

export const createRiggingStudioMcpServer = (bridge: StudioBridgeServer): McpServer => {
  const server = new McpServer({ name: "rigging-studio", version: "1.0.0" }, { capabilities: { resources: { listChanged: false }, tools: { listChanged: false } } });

  for (const name of TOOL_NAMES) {
    if (name === "image_analyze_candidate_suitability" || name === "image_prepare_repair_context") continue;
    const readOnly = READ_ONLY_TOOLS.has(name);
    server.registerTool(name, {
      title: name.replaceAll("_", " "),
      description: toolDescription(name),
      inputSchema: studioToolSchemas[name],
      annotations: { readOnlyHint: readOnly, destructiveHint: name === "animation_delete" || name === "animation_delete_keyframe", idempotentHint: readOnly, openWorldHint: false },
    }, async (input: unknown) => {
      if (name === "studio_get_status" && !bridge.connected) {
        const disconnected = { success: true, connected: false, sessionId: null, activeProjectId: null, warnings: [{ code: "studio_disconnected", message: "Start Rigging Studio and keep the editor open." }] };
        return { content: [{ type: "text", text: JSON.stringify(disconnected, null, 2) }], structuredContent: disconnected };
      }
      try {
        if (name === "image_provider_status" || name === "image_provider_list_capabilities" || name === "comfy_get_status") {
          const refresh = name === "image_provider_list_capabilities" && Boolean((studioToolSchemas.image_provider_list_capabilities.parse(input) as { readonly refresh: boolean }).refresh);
          const status = await bridge.imageProviderStatus(refresh);
          return toolResponse({ success: true, ...status });
        }
        if (name === "image_generate_candidates" || name === "character_generate_with_comfy") {
          const parsed = studioToolSchemas[name].parse(input) as Record<string, unknown>;
          const projectId = String(parsed.projectId); await assertActiveProject(bridge, projectId);
          bridge.notifyActivity("generation.started", `Submitted ${name === "character_generate_with_comfy" ? "character generation" : String(parsed.operation)} to ComfyUI`, projectId);
          const proposal = await bridge.generateImageCandidates({
            projectId, operation: name === "character_generate_with_comfy" ? "character_generation" : parsed.operation as import("../src/image-production/service/ImageProductionService").GenerateImageCandidatesRequest["operation"],
            prompt: String(parsed.prompt), candidateCount: Number(parsed.candidateCount), preset: "MODULAR_2D_RIG_CHARACTER",
            ...(typeof parsed.negativePrompt === "string" ? { negativePrompt: parsed.negativePrompt } : {}),
            ...(typeof parsed.width === "number" ? { width: parsed.width } : {}), ...(typeof parsed.height === "number" ? { height: parsed.height } : {}),
            ...(typeof parsed.seed === "number" ? { seed: parsed.seed } : {}), ...(typeof parsed.steps === "number" ? { steps: parsed.steps } : {}),
            ...(typeof parsed.guidance === "number" ? { guidance: parsed.guidance } : {}), ...(typeof parsed.stylePreset === "string" ? { stylePreset: parsed.stylePreset } : {}),
            ...(typeof parsed.targetPartId === "string" ? { targetPartId: parsed.targetPartId } : {}), ...(typeof parsed.parentProposalId === "string" ? { parentProposalId: parsed.parentProposalId } : {}),
          });
          let sheet: Record<string, unknown> | null = null; let sheetWarning: string | null = null;
          if (name === "character_generate_with_comfy" && proposal.candidates.length) {
            try {
              const rendered = await bridge.renderImageCandidateSheet(proposal.proposalId, 1200);
              sheet = { resourceUri: `rigging://image-proposals/${proposal.proposalId}/contact-sheet`, width: rendered.width, height: rendered.height };
            } catch (error: unknown) { sheetWarning = error instanceof Error ? error.message : "Candidate sheet could not be rendered"; }
          }
          bridge.notifyActivity(proposal.status === "failed" ? "generation.failed" : "generation.completed", proposal.status === "failed" ? `ComfyUI proposal ${proposal.proposalId} failed` : `ComfyUI produced ${proposal.candidates.length} candidate${proposal.candidates.length === 1 ? "" : "s"}`, proposal.proposalId);
          return toolResponse({
            success: proposal.status !== "failed", proposalId: proposal.proposalId, status: proposal.status, candidateIds: proposal.candidateIds,
            candidateCountRequested: parsed.candidateCount, candidateCountCompleted: proposal.candidates.length, candidateSheet: sheet,
            suitabilitySummaries: proposal.candidates.map((candidate) => ({ candidateId: candidate.candidateId, suitability: candidate.diagnostics.suitability ?? null })),
            requiresReview: true, requiresHumanApproval: proposal.approvalPolicy === "manual", warnings: [...proposal.warnings, ...(sheetWarning ? [sheetWarning] : [])], errors: proposal.errors,
          });
        }
        if (name === "image_get_proposal") {
          const parsed = studioToolSchemas.image_get_proposal.parse(input) as { readonly proposalId: string }; const proposal = await bridge.getImageProposal(parsed.proposalId);
          return toolResponse({ success: true, proposal, requiresHumanApproval: proposal.approvalPolicy === "manual" && proposal.status === "awaiting_review" });
        }
        if (name === "image_get_candidates") {
          const parsed = studioToolSchemas.image_get_candidates.parse(input) as { readonly proposalId: string }; const proposal = await bridge.getImageProposal(parsed.proposalId);
          return toolResponse({ success: true, proposalId: proposal.proposalId, status: proposal.status, candidates: proposal.candidates.map((candidate) => ({
            candidateId: candidate.candidateId, width: candidate.width, height: candidate.height, seed: candidate.seed, status: candidate.status, diagnostics: candidate.diagnostics,
            resourceUri: `rigging://image-proposals/${proposal.proposalId}/candidates/${candidate.candidateId}`,
            managedPath: bridge.imageProduction.storage.assetPath(proposal.proposalId, candidate.imageFileName),
          })) });
        }
        if (name === "image_get_candidate") {
          const parsed = studioToolSchemas.image_get_candidate.parse(input) as { readonly proposalId: string; readonly candidateId: string }; const result = await bridge.getImageCandidate(parsed.proposalId, parsed.candidateId);
          return imageToolResponse({ success: true, proposalId: parsed.proposalId, candidate: result.candidate, inspectedResourceId: `rigging://image-proposals/${parsed.proposalId}/candidates/${parsed.candidateId}`, inspectionTimestamp: result.proposal.inspectionEvidence.at(-1)?.inspectedAt }, { bytes: result.bytes, mimeType: result.mimeType });
        }
        if (name === "image_render_candidate_sheet") {
          const parsed = studioToolSchemas.image_render_candidate_sheet.parse(input) as { readonly proposalId: string; readonly width: number }; const result = await bridge.renderImageCandidateSheet(parsed.proposalId, parsed.width);
          return imageToolResponse({ success: true, proposalId: parsed.proposalId, resourceUri: `rigging://image-proposals/${parsed.proposalId}/contact-sheet`, width: result.width, height: result.height, candidateIds: result.proposal.candidateIds, inspectionTimestamp: result.proposal.inspectionEvidence.at(-1)?.inspectedAt }, { bytes: result.bytes, mimeType: "image/png" });
        }
        if (name === "image_review_proposal") {
          const parsed = studioToolSchemas.image_review_proposal.parse(input) as import("../src/image-production/proposals/imageProposal").ImageProposalReviewInput; const proposal = await bridge.reviewImageProposal(parsed, process.env.RIGGING_STUDIO_AGENT_NAME ?? "MCP Agent");
          bridge.notifyActivity("project.changed", `${process.env.RIGGING_STUDIO_AGENT_NAME ?? "Agent"} reviewed ${proposal.proposalId}`, proposal.proposalId);
          return toolResponse({ success: true, proposalId: proposal.proposalId, status: proposal.status, review: proposal.agentReview, requiresHumanApproval: proposal.approvalPolicy === "manual" });
        }
        if (name === "image_approve_candidate") {
          const parsed = studioToolSchemas.image_approve_candidate.parse(input) as { readonly proposalId: string; readonly candidateId: string };
          try { return toolResponse(await bridge.approveImageCandidate(parsed.proposalId, parsed.candidateId, "agent") as Record<string, unknown>); }
          catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Candidate approval failed";
            return toolResponse({ success: false, proposalId: parsed.proposalId, candidateId: parsed.candidateId, requiresHumanApproval: /requires explicit human/.test(message), warnings: [], errors: [{ code: "approval_blocked", message }] });
          }
        }
        if (name === "image_reject_candidate") {
          const parsed = studioToolSchemas.image_reject_candidate.parse(input) as { readonly proposalId: string; readonly candidateId: string; readonly reason: string }; const proposal = await bridge.rejectImageCandidate(parsed.proposalId, parsed.candidateId, process.env.RIGGING_STUDIO_AGENT_NAME ?? "MCP Agent", parsed.reason);
          bridge.notifyActivity("project.changed", `Rejected ${parsed.candidateId} from ${parsed.proposalId}`, parsed.proposalId);
          return toolResponse({ success: true, proposalId: proposal.proposalId, candidateId: parsed.candidateId, status: proposal.status });
        }
        if (name === "image_regenerate_proposal") {
          const parsed = studioToolSchemas.image_regenerate_proposal.parse(input) as { readonly proposalId: string; readonly amendedPrompt?: string }; const proposal = await bridge.regenerateImageProposal(parsed.proposalId, parsed.amendedPrompt);
          bridge.notifyActivity("generation.completed", `Regenerated ${parsed.proposalId} as ${proposal.proposalId}`, proposal.proposalId);
          return toolResponse({ success: proposal.status !== "failed", proposalId: proposal.proposalId, parentProposalId: parsed.proposalId, status: proposal.status, candidateIds: proposal.candidateIds, requiresReview: true, requiresHumanApproval: proposal.approvalPolicy === "manual", warnings: proposal.warnings, errors: proposal.errors });
        }
        if (name === "image_set_approval_policy") {
          const parsed = studioToolSchemas.image_set_approval_policy.parse(input) as { readonly projectId: string; readonly policy: "manual" | "agent_recommendation" }; await assertActiveProject(bridge, parsed.projectId);
          return toolResponse({ success: true, projectId: parsed.projectId, approvalPolicy: bridge.setImageApprovalPolicy(parsed.projectId, parsed.policy) });
        }
        if (name === "image_cancel_proposal") {
          const parsed = studioToolSchemas.image_cancel_proposal.parse(input) as { readonly proposalId: string }; return toolResponse({ success: true, proposalId: parsed.proposalId, cancellationRequested: await bridge.cancelImageProposal(parsed.proposalId) });
        }
        if (name === "character_import_generation") {
          const parsed = studioToolSchemas.character_import_generation.parse(input) as GenerationImportRequest;
          const result = await bridge.ingestGeneration(parsed);
          return toolResponse(result && typeof result === "object" ? result as Record<string, unknown> : { value: result });
        }
        if (name === "diagnostics_export_report") {
          const parsed = studioToolSchemas.diagnostics_export_report.parse(input) as DiagnosticReportRequest;
          return toolResponse(await bridge.exportDiagnosticReport(parsed));
        }
        if (name === "diagnostics_export_torture_test") {
          const parsed = studioToolSchemas.diagnostics_export_torture_test.parse(input) as {
            readonly results: Readonly<Record<string, import("../src/rigging/schema/types").JsonValue>>;
            readonly markdown: string;
            readonly overwrite: boolean;
          };
          return toolResponse(await bridge.exportTortureTestReport(parsed.results, parsed.markdown, parsed.overwrite));
        }
        const result = await bridge.request(name as StudioToolName, input);
        const structured = result && typeof result === "object" ? result as Record<string, unknown> : { value: result };
        return toolResponse(structured);
      } catch (error: unknown) {
        const failure = { success: false, warnings: [], errors: [{ code: "studio_bridge_error", message: error instanceof Error ? error.message : "Studio bridge failed" }] };
        return toolResponse(failure);
      }
    });
  }

  registerStudioResources(server, bridge);
  return server;
};

async function assertActiveProject(bridge: StudioBridgeServer, projectId: string): Promise<void> {
  const status = await bridge.request("studio_get_status", { includeActivity: false });
  if (!status || typeof status !== "object" || (status as Record<string, unknown>).activeProjectId !== projectId) throw new Error(`Project ${projectId} is not the active Studio project`);
}

export const main = async (): Promise<void> => {
  const bridge = new StudioBridgeServer();
  const server = createRiggingStudioMcpServer(bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Rigging Studio MCP server ready on stdio; browser bridge listening on 127.0.0.1:47831 (WebSocket with HTTP polling fallback)");
  const shutdown = async (): Promise<void> => { await bridge.close(); await server.close(); process.exit(0); };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
};

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error: unknown) => { console.error(error); process.exit(1); });
}
