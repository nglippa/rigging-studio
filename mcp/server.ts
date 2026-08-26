#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOL_NAMES, studioToolSchemas, type StudioToolName } from "../src/agent-control/validation/toolSchemas";
import { registerStudioResources } from "./resources/registerResources";
import { READ_ONLY_TOOLS, toolDescription } from "./tools/toolCatalog";
import { StudioBridgeServer } from "./transport/StudioBridgeServer";
import type { DiagnosticReportRequest } from "./storage/diagnosticReportExporter";
import type { GenerationImportRequest } from "./storage/managedGenerationStorage";
import { partCutProposalSchema } from "../src/part-cutter/schema";
import { proposalToSegmentation } from "../src/part-cutter/operations";
import type { CharacterImageGenerationResult } from "../src/character-generation/providers/characterPipelineProvider";
import type { ProposedCharacterPart } from "../src/character-generation/segmentation/segmentationSchema";
import type { LocalProjectSnapshot } from "../src/project-storage/types";

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
    if (name === "image_analyze_candidate_suitability" || name === "image_prepare_repair_context" || name === "parts_install_ai_proposal" || name === "part_install_reconstruction_proposal") continue;
    const readOnly = READ_ONLY_TOOLS.has(name);
    server.registerTool(name, {
      title: name.replaceAll("_", " "),
      description: toolDescription(name),
      inputSchema: studioToolSchemas[name],
      annotations: { readOnlyHint: readOnly, destructiveHint: name === "animation_delete" || name === "animation_delete_keyframe" || name === "project_archive", idempotentHint: readOnly, openWorldHint: false },
    }, async (input: unknown) => {
      if (name === "studio_get_status" && !bridge.connected) {
        const disconnected = { success: true, connected: false, sessionId: null, activeProjectId: null, warnings: [{ code: "studio_disconnected", message: "Start Rigging Studio and keep the editor open." }] };
        return { content: [{ type: "text", text: JSON.stringify(disconnected, null, 2) }], structuredContent: disconnected };
      }
      try {
        if (name === "rigging_review_provider_status") return toolResponse({ success: true, policy: bridge.visionReview.policy, providers: await bridge.visionReview.capabilities() });
        if (name === "rigging_review_list_pending") {
          const pending = await bridge.visionReview.listPending();
          return toolResponse({ success: true, jobs: pending.map(({ job, status }) => ({ jobId: job.jobId, type: job.type, mode: job.mode, subject: job.subject, attempt: job.attempt, maxAttempts: job.maxAttempts, parentJobId: job.parentJobId, status: status.status, artifactCount: job.artifacts.length, createdAt: job.createdAt })) });
        }
        if (name === "rigging_review_open_job") {
          const parsed = studioToolSchemas.rigging_review_open_job.parse(input) as { readonly jobId: string };
          return toolResponse({ success: true, ...(await bridge.visionReview.queue.openPacket(parsed.jobId)) });
        }
        if (name === "rigging_review_submit_result") {
          const parsed = studioToolSchemas.rigging_review_submit_result.parse(input) as { readonly jobId: string; readonly result: unknown };
          return toolResponse({ success: true, ...(await bridge.visionReview.queue.submitManualResult(parsed.jobId, parsed.result)) });
        }
        if (name === "rigging_review_request_rerender") {
          const parsed = studioToolSchemas.rigging_review_request_rerender.parse(input) as { readonly jobId: string; readonly reason: string };
          return toolResponse({ success: true, ...(await bridge.visionReview.queue.requestRerender(parsed.jobId, parsed.reason)) });
        }
        if (name === "project_storage_status") return toolResponse({ success: true, ...(await bridge.projectStorage.status()) });
        if (name === "project_list") return toolResponse({ success: true, projects: await bridge.projectStorage.list() });
        if (name === "project_open") {
          const parsed = studioToolSchemas.project_open.parse(input) as { readonly projectId?: string; readonly project?: unknown; readonly snapshot?: unknown };
          if (!parsed.projectId) { const result = await bridge.request("project_open", parsed); return toolResponse(result as Record<string, unknown>); }
          const loaded = await bridge.projectStorage.load(parsed.projectId); const opened = await bridge.request("project_open", { snapshot: loaded.snapshot });
          return toolResponse({ ...(opened as Record<string, unknown>), project: loaded.summary, openedFrom: "disk" });
        }
        if (name === "project_save") {
          const parsed = studioToolSchemas.project_save.parse(input) as { readonly projectId?: string }; if (parsed.projectId) await assertActiveProject(bridge, parsed.projectId);
          const cached = await bridge.request("project_save", parsed) as Record<string, unknown>; if (cached.success === false || !cached.snapshot) return toolResponse(cached);
          const saved = await bridge.projectStorage.save(cached.snapshot as LocalProjectSnapshot); return toolResponse({ success: true, ...saved, cachePersistence: cached.persistence });
        }
        if (name === "project_save_as") {
          const parsed = studioToolSchemas.project_save_as.parse(input) as { readonly projectId?: string; readonly name: string }; if (parsed.projectId) await assertActiveProject(bridge, parsed.projectId);
          const cached = await bridge.request("project_save", { projectId: parsed.projectId }) as Record<string, unknown>; if (!cached.snapshot) return toolResponse(cached);
          return toolResponse({ success: true, ...(await bridge.projectStorage.saveAs(cached.snapshot as LocalProjectSnapshot, parsed.name)) });
        }
        if (name === "project_import") {
          const parsed = studioToolSchemas.project_import.parse(input) as { readonly snapshot: LocalProjectSnapshot; readonly name?: string };
          const saved = parsed.name ? await bridge.projectStorage.saveAs(parsed.snapshot, parsed.name) : await bridge.projectStorage.save(parsed.snapshot); return toolResponse({ success: true, ...saved });
        }
        if (name === "project_export_snapshot") {
          const parsed = studioToolSchemas.project_export_snapshot.parse(input) as { readonly projectId?: string }; const projectId = parsed.projectId ?? await activeProjectId(bridge);
          return toolResponse({ success: true, ...(await bridge.projectStorage.exportSnapshot(projectId)) });
        }
        if (name === "project_reveal") { const parsed = studioToolSchemas.project_reveal.parse(input) as { readonly projectId: string }; return toolResponse({ success: true, ...(await bridge.projectStorage.reveal(parsed.projectId)) }); }
        if (name === "project_archive") { const parsed = studioToolSchemas.project_archive.parse(input) as { readonly projectId: string; readonly confirm: true }; return toolResponse({ success: true, ...(await bridge.projectStorage.archive(parsed.projectId)) }); }
        if (name === "segmentation_status") {
          const status = await bridge.characterPipeline.status();
          return toolResponse({ success: true, ...status });
        }
        if (name === "character_ai_cut") {
          const parsed = studioToolSchemas.character_ai_cut.parse(input) as { readonly projectId?: string; readonly instruction: string };
          const projectId = await activeProjectId(bridge, parsed.projectId); const generation = await activeGeneration(bridge, projectId);
          const segmentation = await bridge.characterPipeline.segmentCharacter({ generationId: generation.generationId, image: generation.image, width: generation.width, height: generation.height, expectedEquipment: [], semanticPrompt: parsed.instruction });
          const installed = await bridge.request("parts_install_ai_proposal", { projectId, instruction: parsed.instruction, segmentation });
          const proposalId = installed && typeof installed === "object" && typeof (installed as Record<string, unknown>).proposalId === "string" ? String((installed as Record<string, unknown>).proposalId) : segmentation.segmentationId;
          return toolResponse({ success: true, projectId, segmentationId: segmentation.segmentationId, proposalId, detectedParts: segmentation.parts.length, unresolved: segmentation.warnings, providerMetadata: segmentation.providerMetadata, proposal: installed, previewResource: `rigging://active-project/segmentation/${proposalId}`, requiresReview: true });
        }
        if (name === "part_refine_mask") {
          const parsed = studioToolSchemas.part_refine_mask.parse(input) as { readonly projectId?: string; readonly targetPartId: string; readonly instruction: string; readonly proposalId?: string };
          const projectId = await activeProjectId(bridge, parsed.projectId); const generation = await activeGeneration(bridge, projectId);
          const currentResult = await bridge.request("parts_get_proposal", { projectId, proposalId: parsed.proposalId, includeMasks: true });
          const currentRecord = currentResult as Record<string, unknown>; const proposal = partCutProposalSchema.parse(currentRecord.proposal);
          const segmentation = await bridge.characterPipeline.refinePartMasks({ generationId: generation.generationId, image: generation.image, width: generation.width, height: generation.height, current: proposalToSegmentation(proposal), instruction: parsed.instruction, targetPartId: parsed.targetPartId });
          const installed = await bridge.request("parts_install_ai_proposal", { projectId, instruction: parsed.instruction, parentProposalId: proposal.proposalId, segmentation });
          return toolResponse({ success: true, projectId, targetPartId: parsed.targetPartId, parentProposalId: proposal.proposalId, proposal: installed, providerMetadata: segmentation.providerMetadata, requiresReview: true, unrelatedPartsPreserved: true });
        }
        if (name === "part_reconstruct_hidden") {
          const parsed = studioToolSchemas.part_reconstruct_hidden.parse(input) as { readonly projectId?: string; readonly partId: string; readonly reconstructionMask: import("../src/character-generation/segmentation/segmentationSchema").SegmentationMask; readonly reconstructionMaskBounds: import("../src/character-generation/segmentation/segmentationSchema").Rect };
          const projectId = await activeProjectId(bridge, parsed.projectId); const generation = await activeGeneration(bridge, projectId);
          const partsResult = await bridge.request("character_get_parts", { projectId, includeFull: true }) as Record<string, unknown>;
          const part = (partsResult.parts as readonly ProposedCharacterPart[] | undefined)?.find((candidate) => candidate.id === parsed.partId);
          if (!part) throw new Error(`Part ${parsed.partId} is unavailable in the active segmentation`);
          const result = await bridge.characterPipeline.reconstructPart({
            generationId: generation.generationId, image: generation.image, part, stylePrompt: generation.generationPrompt,
            reconstructionMask: parsed.reconstructionMask, reconstructionMaskBounds: parsed.reconstructionMaskBounds, expectedPivot: part.pivotHint,
            consistencyContext: { projectId, sourceImageId: generation.generationId, sourceCanvasWidth: generation.width, sourceCanvasHeight: generation.height, characterPrompt: generation.generationPrompt, stylePrompt: generation.generationPrompt, generationProvider: generation.provider, ...(typeof generation.seed === "number" ? { generationSeed: generation.seed } : {}), canonicalSourceImage: generation.sourceArtifact, providerMetadata: generation.providerMetadata, canonicalScale: { width: generation.width, height: generation.height }, acceptedParts: (partsResult.parts as readonly ProposedCharacterPart[] | undefined)?.filter((candidate) => candidate.accepted).map((candidate) => candidate.id) ?? [], semanticBBoxes: Object.fromEntries(((partsResult.parts as readonly ProposedCharacterPart[] | undefined) ?? []).map((candidate) => [candidate.semanticType, candidate.bounds])), jointHints: Object.fromEntries(((partsResult.parts as readonly ProposedCharacterPart[] | undefined) ?? []).map((candidate) => [candidate.semanticType, candidate.pivotHint])), paletteHints: [], equipmentHints: [], referenceAssetIds: [generation.sourceArtifact] },
          });
          const installed = await bridge.request("part_install_reconstruction_proposal", { projectId, partId: parsed.partId, result });
          return toolResponse({ success: true, projectId, partId: parsed.partId, reconstructionId: result.reconstructionId, runtimeMs: result.runtimeMs ?? null, proposal: installed, previewResource: `rigging://active-project/reconstruction/${encodeURIComponent(parsed.partId)}`, requiresVisualInspection: true, requiresApproval: true });
        }
        if (name === "part_render_reconstruction_preview") {
          const parsed = studioToolSchemas.part_render_reconstruction_preview.parse(input) as { readonly projectId?: string; readonly partId: string; readonly recordInspection: boolean };
          await activeProjectId(bridge, parsed.projectId);
          const rendered = await bridge.request(name, parsed) as Record<string, unknown>;
          if (rendered.success === false) return toolResponse(rendered);
          if (typeof rendered.imageBase64 !== "string") throw new Error("Studio did not return a reconstruction preview image");
          const { imageBase64, ...metadata } = rendered;
          return imageToolResponse(metadata, { bytes: Buffer.from(imageBase64, "base64"), mimeType: "image/png" });
        }
        if (name === "background_remove" || name === "alpha_cleanup") {
          const status = await bridge.characterPipeline.status(); const capability = name === "background_remove" ? status.capabilities.backgroundRemoval : status.capabilities.alphaCleanup;
          if (!capability.available) return toolResponse({ success: false, capability: name, available: false, warnings: [], errors: [{ code: "capability_unavailable", message: capability.reason ?? `${name} trusted workflow is unavailable` }] });
          return toolResponse({ success: false, capability: name, available: true, warnings: [], errors: [{ code: "capability_not_bound", message: `${name} requires a reviewed narrow source-binding implementation before it can execute` }] });
        }
        if (name === "image_provider_status" || name === "image_provider_list_capabilities" || name === "image_provider_list" || name === "comfy_get_status") {
          const refresh = name === "image_provider_list_capabilities" && Boolean((studioToolSchemas.image_provider_list_capabilities.parse(input) as { readonly refresh: boolean }).refresh);
          const status = await bridge.imageProviderStatus(refresh);
          return toolResponse({ success: true, ...status });
        }
        if (name === "character_generate" || name === "character_generate_variant") {
          const parsed = studioToolSchemas[name].parse(input) as Record<string, unknown>;
          const projectId = String(parsed.projectId); await assertActiveProject(bridge, projectId);
          const providerId = String(parsed.provider);
          const status = await bridge.imageProviderStatus(false);
          const providerStatus = status.providers.find((provider) => provider.provider === providerId);
          const readiness = name === "character_generate_variant" ? providerStatus?.characterVariant : providerStatus?.characterGeneration;
          if (!providerStatus || !readiness?.available) return toolResponse({ success: false, provider: providerId, warnings: [], errors: [{ code: "provider_unavailable", message: readiness && "reason" in readiness ? readiness.reason ?? providerStatus?.message : providerStatus?.message ?? `Provider ${providerId} is not registered` }] });
          const job = bridge.startImageGenerationJob({
            projectId, provider: providerId as "comfyui" | "draw_things", operation: name === "character_generate_variant" ? "character_variant" : parsed.generationIntent === "equipment_variant" ? "equipment_variant" : "character_generation",
            prompt: String(parsed.prompt), candidateCount: Number(parsed.candidateCount), width: Number(parsed.width), height: Number(parsed.height),
            ...(typeof parsed.negativePrompt === "string" ? { negativePrompt: parsed.negativePrompt } : {}), ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
            ...(typeof parsed.seed === "number" ? { seed: parsed.seed } : {}), ...(typeof parsed.sourceProposalId === "string" ? { parentProposalId: parsed.sourceProposalId } : {}),
          });
          bridge.notifyActivity("generation.started", `Started ${providerStatus.label} ${name === "character_generate_variant" ? "variant" : "character"} job`, job.jobId);
          return toolResponse({ success: true, ...job, asynchronous: true, nextTool: "image_generation_get_job" });
        }
        if (name === "image_generation_get_job") {
          const parsed = studioToolSchemas.image_generation_get_job.parse(input) as { readonly jobId: string }; const job = bridge.getImageGenerationJob(parsed.jobId);
          const proposal = job.proposalId ? await bridge.getImageProposal(job.proposalId).catch(() => undefined) : undefined;
          return toolResponse({ success: job.status !== "failed", ...job, proposalStatus: proposal?.status, candidateIds: proposal?.candidateIds, requiresReview: proposal?.status === "awaiting_review", requiresHumanApproval: proposal?.approvalPolicy === "manual" && proposal.status === "awaiting_review" });
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
        if (name === "image_get_proposal" || name === "image_generation_get_proposal") {
          const parsed = studioToolSchemas[name].parse(input) as { readonly proposalId: string }; const proposal = await bridge.getImageProposal(parsed.proposalId);
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
        if (name === "image_render_candidate_sheet" || name === "image_generation_render_proposal") {
          const parsed = studioToolSchemas[name].parse(input) as { readonly proposalId: string; readonly width: number }; const result = await bridge.renderImageCandidateSheet(parsed.proposalId, parsed.width);
          return imageToolResponse({ success: true, proposalId: parsed.proposalId, resourceUri: `rigging://image-proposals/${parsed.proposalId}/contact-sheet`, width: result.width, height: result.height, candidateIds: result.proposal.candidateIds, inspectionTimestamp: result.proposal.inspectionEvidence.at(-1)?.inspectedAt }, { bytes: result.bytes, mimeType: "image/png" });
        }
        if (name === "image_review_proposal") {
          const parsed = studioToolSchemas.image_review_proposal.parse(input) as import("../src/image-production/proposals/imageProposal").ImageProposalReviewInput; const proposal = await bridge.reviewImageProposal(parsed, process.env.RIGGING_STUDIO_AGENT_NAME ?? "MCP Agent");
          bridge.notifyActivity("project.changed", `${process.env.RIGGING_STUDIO_AGENT_NAME ?? "Agent"} reviewed ${proposal.proposalId}`, proposal.proposalId);
          return toolResponse({ success: true, proposalId: proposal.proposalId, status: proposal.status, review: proposal.agentReview, requiresHumanApproval: proposal.approvalPolicy === "manual" });
        }
        if (name === "image_approve_candidate" || name === "image_generation_approve_candidate") {
          const parsed = studioToolSchemas[name].parse(input) as { readonly proposalId: string; readonly candidateId: string };
          try { return toolResponse(await bridge.approveImageCandidate(parsed.proposalId, parsed.candidateId, "agent") as Record<string, unknown>); }
          catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Candidate approval failed";
            return toolResponse({ success: false, proposalId: parsed.proposalId, candidateId: parsed.candidateId, requiresHumanApproval: /requires explicit human/.test(message), warnings: [], errors: [{ code: "approval_blocked", message }] });
          }
        }
        if (name === "image_reject_candidate" || name === "image_generation_reject_candidate") {
          const parsed = studioToolSchemas[name].parse(input) as { readonly proposalId: string; readonly candidateId: string; readonly reason: string }; const proposal = await bridge.rejectImageCandidate(parsed.proposalId, parsed.candidateId, process.env.RIGGING_STUDIO_AGENT_NAME ?? "MCP Agent", parsed.reason);
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
          return toolResponse({ success: true, projectId: parsed.projectId, approvalPolicy: await bridge.setImageApprovalPolicy(parsed.projectId, parsed.policy) });
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

async function activeProjectId(bridge: StudioBridgeServer, requested?: string): Promise<string> {
  const status = await bridge.request("studio_get_status", { includeActivity: false });
  const active = status && typeof status === "object" ? (status as Record<string, unknown>).activeProjectId : null;
  if (typeof active !== "string") throw new Error("No active Rigging Studio project");
  if (requested && requested !== active) throw new Error(`Project ${requested} is not the active Studio project`);
  return active;
}

async function activeGeneration(bridge: StudioBridgeServer, projectId: string): Promise<CharacterImageGenerationResult> {
  const result = await bridge.request("character_get_generation", { projectId, includeHistory: false });
  const generation = result && typeof result === "object" ? (result as Record<string, unknown>).generation : null;
  if (!generation || typeof generation !== "object") throw new Error("The active project has no source generation");
  return generation as CharacterImageGenerationResult;
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
