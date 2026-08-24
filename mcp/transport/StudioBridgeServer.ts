import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { BRIDGE_PROTOCOL_VERSION, bridgeHelloSchema, bridgeResponseSchema, type BridgeActivity, type BridgeRequest, type BridgeResponse } from "../../src/agent-control/protocol/messages";
import type { StudioEventType } from "../../src/agent-control/events/StudioEventBus";
import type { StudioToolName } from "../../src/agent-control/validation/toolSchemas";
import { DiagnosticReportExporter, type DiagnosticReportRequest } from "../storage/diagnosticReportExporter";
import { ManagedGenerationStorage, type GenerationImportRequest } from "../storage/managedGenerationStorage";
import { ImageProductionService, type GenerateImageCandidatesRequest } from "../../src/image-production/service/ImageProductionService";
import { ImageGenerationJobService } from "../../src/image-production/service/ImageGenerationJobService";
import { ComfyCharacterPipelineService } from "../../src/image-production/service/ComfyCharacterPipelineService";
import { suitabilityReviewSchema } from "../../src/character-generation/providers/characterPipelineProvider";
import type { ImageApprovalPolicy, ImageProposalReviewInput } from "../../src/image-production/proposals/imageProposal";
import { ImageProposalStorage } from "../../src/image-production/assets/imageProposalStorage";
import { LocalProjectStore } from "../storage/localProjectStore";
import type { LocalProjectSnapshot } from "../../src/project-storage/types";

type PendingRequest = { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> };

export type StudioBridgeOptions = { readonly port?: number; readonly host?: string; readonly requestTimeoutMs?: number; readonly cwd?: string; readonly imageProductionService?: ImageProductionService };

export class StudioBridgeServer {
  private readonly httpServer;
  private readonly server: WebSocketServer;
  private studio: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private sessionId: string | null = null;
  private latestPreviewPath: string | null = null;
  private readonly requestTimeoutMs: number;
  private readonly cwd: string;
  private readonly listening: Promise<void>;
  private pollingSeenAt = 0;
  private pollQueue: (BridgeRequest | BridgeActivity)[] = [];
  private readonly generationStorage: ManagedGenerationStorage;
  private readonly diagnosticExporter: DiagnosticReportExporter;
  projectStorage: LocalProjectStore;
  readonly imageProduction: ImageProductionService;
  readonly imageGenerationJobs: ImageGenerationJobService;
  readonly characterPipeline: ComfyCharacterPipelineService;

  constructor(options: StudioBridgeOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.cwd = options.cwd ?? process.cwd();
    this.generationStorage = new ManagedGenerationStorage({ cwd: this.cwd });
    this.diagnosticExporter = new DiagnosticReportExporter({ cwd: this.cwd });
    this.projectStorage = new LocalProjectStore({ cwd: this.cwd, ...(this.configuredProjectRoot() ? { root: this.configuredProjectRoot() } : {}) });
    this.imageProduction = options.imageProductionService ?? new ImageProductionService({
      storage: new ImageProposalStorage({ cwd: this.cwd }),
      currentSessionId: () => this.sessionId,
      analyzeCandidate: async (proposal, candidate) => {
        const port = await this.waitUntilListening();
        const imageUrl = `http://127.0.0.1:${port}/image-production/assets/${encodeURIComponent(proposal.proposalId)}/${encodeURIComponent(candidate.imageFileName)}`;
        const result = await this.request("image_analyze_candidate_suitability", { proposalId: proposal.proposalId, candidateId: candidate.candidateId, imageUrl, width: candidate.width, height: candidate.height, prompt: proposal.sourcePrompt });
        if (!result || typeof result !== "object" || !("suitability" in result)) return undefined;
        return suitabilityReviewSchema.parse((result as { suitability: unknown }).suitability);
      },
      resolveRepairAssets: async (request) => {
        if (!request.targetPartId) throw new Error("Repair workflow requires a target part");
        const result = await this.request("image_prepare_repair_context", { projectId: request.projectId, targetPartId: request.targetPartId });
        if (!result || typeof result !== "object") throw new Error("Studio did not return managed repair context");
        const record = result as Record<string, unknown>; const source = record.sourceImage; const mask = record.maskImage;
        if (!source || typeof source !== "object" || !mask || typeof mask !== "object") throw new Error("Studio repair context is missing source or mask data");
        const sourceRecord = source as Record<string, unknown>; const maskRecord = mask as Record<string, unknown>;
        if ((sourceRecord.mimeType !== "image/png" && sourceRecord.mimeType !== "image/jpeg") || typeof sourceRecord.imageBase64 !== "string" || maskRecord.mimeType !== "image/png" || typeof maskRecord.imageBase64 !== "string") throw new Error("Studio repair context has invalid image data");
        return {
          sourceImage: { bytes: Buffer.from(sourceRecord.imageBase64, "base64"), mimeType: sourceRecord.mimeType },
          maskImage: { bytes: Buffer.from(maskRecord.imageBase64, "base64"), mimeType: "image/png" },
        };
      },
    });
    this.characterPipeline = new ComfyCharacterPipelineService(this.imageProduction);
    this.imageGenerationJobs = new ImageGenerationJobService(this.imageProduction);
    this.httpServer = createServer((request, response) => { void this.onHttpRequest(request, response); });
    this.server = new WebSocketServer({ server: this.httpServer });
    this.listening = new Promise((resolve, reject) => {
      this.httpServer.once("listening", () => resolve());
      this.httpServer.once("error", reject);
    });
    void this.listening.catch(() => undefined);
    this.server.on("connection", (socket) => this.onConnection(socket));
    this.server.on("error", (error) => console.error(`[rigging-studio bridge] ${error.message}`));
    this.httpServer.listen(options.port ?? 47831, options.host ?? "127.0.0.1");
  }

  get connected(): boolean { return this.studio?.readyState === WebSocket.OPEN || Date.now() - this.pollingSeenAt < 2_500; }
  get activeSessionId(): string | null { return this.sessionId; }
  get previewPath(): string | null { return this.latestPreviewPath; }
  async waitUntilListening(): Promise<number> {
    await this.listening;
    const address = this.httpServer.address() as AddressInfo;
    return address.port;
  }

  async request(tool: StudioToolName, input: unknown, actor = process.env.RIGGING_STUDIO_AGENT_NAME ?? "MCP Agent"): Promise<unknown> {
    const socket = this.studio;
    const websocketConnected = socket?.readyState === WebSocket.OPEN;
    if (!websocketConnected && Date.now() - this.pollingSeenAt >= 2_500) throw new Error("Rigging Studio is not connected. Start the browser app and keep the editor open.");
    const id = `bridge-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    const message: BridgeRequest = { type: "request", protocolVersion: BRIDGE_PROTOCOL_VERSION, id, tool, input, actor };
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Studio command ${tool} timed out`)); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (websocketConnected && socket) socket.send(JSON.stringify(message), (error) => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
      else this.pollQueue.push(message);
    });
    return tool === "preview_render" ? this.persistPreview(result, input) : result;
  }

  notifyActivity(eventType: StudioEventType, summary: string, entityId?: string, actor = process.env.RIGGING_STUDIO_AGENT_NAME ?? "MCP Agent"): void {
    const message: BridgeActivity = { type: "activity", protocolVersion: BRIDGE_PROTOCOL_VERSION, id: `activity-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`, actor, eventType, summary, ...(entityId ? { entityId } : {}) };
    const socket = this.studio;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    else if (Date.now() - this.pollingSeenAt < 2_500) this.pollQueue.push(message);
  }

  async ingestGeneration(request: GenerationImportRequest): Promise<unknown> {
    const port = await this.waitUntilListening();
    const normalized = await this.generationStorage.ingest(request, `http://127.0.0.1:${port}`);
    return this.request("character_import_generation", normalized);
  }

  imageProviderStatus(refreshWorkflows = false) { return this.imageProduction.status(refreshWorkflows); }
  generateImageCandidates(request: GenerateImageCandidatesRequest) { return this.imageProduction.generateCandidates(request); }
  startImageGenerationJob(request: GenerateImageCandidatesRequest) { return this.imageGenerationJobs.start(request); }
  getImageGenerationJob(jobId: string) { return this.imageGenerationJobs.get(jobId); }
  getImageProposal(proposalId: string) { return this.imageProduction.getProposal(proposalId); }
  listImageProposals(projectId?: string) { return this.imageProduction.listProposals(projectId); }
  reviewImageProposal(input: ImageProposalReviewInput, reviewer: string) { return this.imageProduction.review(input, reviewer); }
  rejectImageCandidate(proposalId: string, candidateId: string, reviewer: string, reason: string) { return this.imageProduction.rejectCandidate(proposalId, candidateId, reviewer, reason); }
  regenerateImageProposal(proposalId: string, amendedPrompt?: string) { return this.imageProduction.regenerate(proposalId, amendedPrompt); }
  setImageApprovalPolicy(projectId: string, policy: ImageApprovalPolicy) { return this.imageProduction.setApprovalPolicy(projectId, policy); }
  cancelImageProposal(proposalId: string) { return this.imageProduction.cancel(proposalId); }

  async getImageCandidate(proposalId: string, candidateId: string) {
    return this.imageProduction.getCandidate(proposalId, candidateId);
  }

  async renderImageCandidateSheet(proposalId: string, width: number) {
    const rendered = await this.request("image_render_candidate_sheet", { proposalId, width });
    if (!rendered || typeof rendered !== "object" || typeof (rendered as Record<string, unknown>).imageBase64 !== "string") throw new Error("Studio did not return a candidate contact sheet");
    const record = rendered as Record<string, unknown>;
    const proposal = await this.imageProduction.recordContactSheet(proposalId, record.imageBase64 as string);
    const bytes = await this.imageProduction.storage.readAsset(proposalId, proposal.contactSheetFileName!);
    return { proposal, bytes, width: record.width, height: record.height };
  }

  async approveImageCandidate(proposalId: string, candidateId: string, source: "agent" | "human"): Promise<unknown> {
    const pending = await this.imageProduction.getProposal(proposalId);
    if (pending.operationType === "CHARACTER_SEGMENTATION" || pending.operationType === "MASK_REFINEMENT" || pending.operationType === "OCCLUSION_RECONSTRUCTION") throw new Error(`${pending.operationType} must be accepted through the part-review tools, not generation ingress`);
    const approved = await this.imageProduction.approve(proposalId, candidateId, source);
    const port = await this.waitUntilListening();
    const normalized = await this.generationStorage.ingest({
      projectId: approved.proposal.projectId,
      imageSource: { type: "provider_asset", path: approved.filePath, assetId: approved.candidate.imageAssetId },
      generationId: `${approved.proposal.proposalId}-${approved.candidate.candidateId}`,
      provider: approved.proposal.provider, prompt: approved.proposal.sourcePrompt, accepted: true,
      operation: pending.operationType, targetPartId: approved.proposal.targetPartId, generationMode: "provider_generated",
      metadata: {
        proposalId: approved.proposal.proposalId, candidateId: approved.candidate.candidateId, workflowId: approved.proposal.workflowId,
        provider: approved.proposal.provider, seed: approved.candidate.seed, negativePrompt: approved.proposal.negativePrompt,
        approvalPolicy: approved.proposal.approvalPolicy, proposalRound: approved.proposal.proposalRound,
        generationParameters: approved.proposal.generationParameters, providerMetadata: approved.candidate.providerMetadata,
      },
    }, `http://127.0.0.1:${port}`);
    const ingress = await this.request("character_import_generation", normalized, source === "human" ? "Human" : process.env.RIGGING_STUDIO_AGENT_NAME ?? "MCP Agent");
    this.notifyActivity("generation.completed", `${source === "human" ? "Human" : "Agent"} approved ${approved.candidate.candidateId} from ${approved.proposal.proposalId}`, approved.proposal.proposalId, source === "human" ? "Human" : undefined);
    return { success: true, proposalId, candidateId, proposalStatus: "approved", projectIngress: ingress };
  }

  exportDiagnosticReport(request: DiagnosticReportRequest) { return this.diagnosticExporter.export(request); }
  exportTortureTestReport(results: Readonly<Record<string, import("../../src/rigging/schema/types").JsonValue>>, markdown: string, overwrite: boolean) {
    return this.diagnosticExporter.exportTortureTest(results, markdown, overwrite);
  }

  async close(): Promise<void> {
    this.studio?.close();
    this.pending.forEach((pending) => { clearTimeout(pending.timer); pending.reject(new Error("Studio bridge closed")); });
    this.pending.clear();
    this.pollQueue = [];
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.httpServer.address()) await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  private configuredProjectRoot(): string | undefined {
    if (process.env.RIGGING_STUDIO_PROJECTS_ROOT) return undefined;
    try {
      const input = JSON.parse(readFileSync(path.join(this.cwd, ".rigging-studio", "storage-config.json"), "utf8")) as unknown;
      if (input && typeof input === "object" && !Array.isArray(input) && typeof (input as Record<string, unknown>).root === "string") return (input as Record<string, string>).root;
    } catch { /* the repository default is used until a folder has been selected */ }
    return undefined;
  }

  private async chooseProjectStorageRoot(): Promise<Awaited<ReturnType<LocalProjectStore["status"]>>> {
    if (process.env.RIGGING_STUDIO_PROJECTS_ROOT) throw new Error("Project storage is fixed by RIGGING_STUDIO_PROJECTS_ROOT for this process");
    if (process.platform !== "darwin") throw new Error("The native folder picker is currently available on macOS; use RIGGING_STUDIO_PROJECTS_ROOT on this platform");
    const selected = await new Promise<string>((resolve, reject) => {
      execFile("osascript", ["-e", "POSIX path of (choose folder with prompt \"Choose a Rig Studio project storage folder\")"], (error, stdout) => error ? reject(new Error(/canceled/i.test(error.message) ? "Folder selection was canceled" : error.message)) : resolve(stdout.trim()));
    });
    if (!selected) throw new Error("No project storage folder was selected");
    const next = new LocalProjectStore({ cwd: this.cwd, root: path.resolve(selected) }); const status = await next.status(); if (!status.available || !status.writable) throw new Error("The selected project storage folder is not writable");
    const configDirectory = path.join(this.cwd, ".rigging-studio"); await mkdir(configDirectory, { recursive: true });
    await writeFile(path.join(configDirectory, "storage-config.json"), `${JSON.stringify({ storageVersion: 1, root: status.root }, null, 2)}\n`, "utf8");
    this.projectStorage = next; return status;
  }

  private onConnection(socket: WebSocket): void {
    this.studio?.close(4001, "Superseded by a newer Studio session");
    this.studio = socket;
    socket.on("message", (data) => this.onMessage(data.toString()));
    socket.on("close", () => {
      if (this.studio === socket) { this.studio = null; this.sessionId = null; }
      this.pending.forEach((pending) => { clearTimeout(pending.timer); pending.reject(new Error("Rigging Studio disconnected")); });
      this.pending.clear();
    });
  }

  private onMessage(raw: string): void {
    let input: unknown;
    try { input = JSON.parse(raw) as unknown; } catch { return; }
    const hello = bridgeHelloSchema.safeParse(input);
    if (hello.success) { this.sessionId = hello.data.sessionId; return; }
    const response = bridgeResponseSchema.safeParse(input);
    if (!response.success) return;
    const pending = this.pending.get(response.data.id); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(response.data.id); pending.resolve(response.data.result);
  }

  private async onHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
    if (request.url?.startsWith("/project-storage")) {
      try {
        const url = new URL(request.url, "http://127.0.0.1"); const parts = url.pathname.split("/").filter(Boolean);
        if (request.method === "GET" && parts.length === 2 && parts[1] === "status") { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(await this.projectStorage.status())); return; }
        if (request.method === "GET" && parts.length === 2 && parts[1] === "projects") { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ projects: await this.projectStorage.list() })); return; }
        if (request.method === "GET" && parts.length >= 4 && parts[1] === "assets") {
          const projectId = decodeURIComponent(parts[2]); const assetPath = parts.slice(3).map(decodeURIComponent).join("/"); const asset = await this.projectStorage.readAsset(projectId, assetPath);
          response.writeHead(200, { "Content-Type": asset.mimeType, "Content-Length": asset.bytes.length, "Cache-Control": "private, max-age=60" }).end(asset.bytes); return;
        }
        if (request.method !== "POST" || parts.length !== 2) throw new Error("Unsupported project-storage route");
        const body = await this.readJsonBody(request, 64_000_000); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Project-storage request must be an object");
        const values = body as Record<string, unknown>; let result: unknown;
        if (parts[1] === "choose-root") result = await this.chooseProjectStorageRoot();
        else if (parts[1] === "save") result = await this.projectStorage.save(values.snapshot as LocalProjectSnapshot, { ...(typeof values.expectedModifiedAt === "string" ? { expectedModifiedAt: values.expectedModifiedAt } : {}) });
        else if (parts[1] === "load" && typeof values.projectId === "string") result = await this.projectStorage.load(values.projectId);
        else if (parts[1] === "save-as" && typeof values.name === "string") result = await this.projectStorage.saveAs(values.snapshot as LocalProjectSnapshot, values.name);
        else if (parts[1] === "import" && typeof values.zipBase64 === "string") result = await this.projectStorage.importPortableZip(Buffer.from(values.zipBase64, "base64"), typeof values.name === "string" ? values.name : undefined);
        else if (parts[1] === "import") result = await this.projectStorage.save(values.snapshot as LocalProjectSnapshot, typeof values.name === "string" ? { saveAs: { name: values.name } } : {});
        else if (parts[1] === "archive" && typeof values.projectId === "string" && values.confirm === true) result = await this.projectStorage.archive(values.projectId);
        else if (parts[1] === "export-snapshot" && typeof values.projectId === "string") result = await this.projectStorage.exportSnapshot(values.projectId);
        else if (parts[1] === "reveal" && typeof values.projectId === "string") result = await this.projectStorage.reveal(values.projectId);
        else throw new Error("Invalid project-storage action or input");
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result)); return;
      } catch (error: unknown) {
        response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Project storage failed" })); return;
      }
    }
    if (request.method === "POST" && request.url === "/character-pipeline") {
      try {
        const input = await this.readJsonBody(request, 32_000_000);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Character pipeline request must be an object");
        const record = input as Record<string, unknown>;
        if (!record.body || typeof record.body !== "object" || Array.isArray(record.body)) throw new Error("Character pipeline body must be an object");
        let result: unknown;
        if (record.capability === "status") result = await this.characterPipeline.status();
        else if (record.capability === "segment") result = await this.characterPipeline.segmentCharacter(record.body as import("../../src/character-generation/segmentation/segmentationProvider").CharacterSegmentationRequest);
        else if (record.capability === "refine-mask") result = await this.characterPipeline.refinePartMasks(record.body as import("../../src/character-generation/providers/characterPipelineProvider").CharacterMaskRefinementRequest);
        else if (record.capability === "reconstruct") result = await this.characterPipeline.reconstructPart(record.body as import("../../src/character-generation/providers/characterPipelineProvider").OcclusionReconstructionRequest);
        else throw new Error(`Unsupported trusted character-pipeline capability ${String(record.capability)}`);
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      } catch (error: unknown) {
        response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Character pipeline failed" }));
      }
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/poll")) {
      this.pollingSeenAt = Date.now();
      const next = this.pollQueue.shift();
      if (!next) { response.writeHead(204).end(); return; }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(next));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/generations/")) {
      const rawName = request.url.slice("/generations/".length).split("?")[0];
      let fileName: string;
      try { fileName = decodeURIComponent(rawName); } catch { response.writeHead(400).end(); return; }
      const filePath = this.generationStorage.assetPath(fileName);
      if (!filePath) { response.writeHead(404).end(); return; }
      try {
        const bytes = await readFile(filePath);
        response.writeHead(200, { "Content-Type": fileName.endsWith(".png") ? "image/png" : "image/jpeg", "Content-Length": bytes.length, "Cache-Control": "private, max-age=31536000, immutable" }).end(bytes);
      } catch { response.writeHead(404).end(); }
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/image-production/assets/")) {
      const parts = request.url.split("?")[0].split("/").filter(Boolean);
      if (parts.length !== 4) { response.writeHead(404).end(); return; }
      const proposalId = decodeURIComponent(parts[2]); const fileName = decodeURIComponent(parts[3]);
      const filePath = this.imageProduction.storage.assetPath(proposalId, fileName);
      if (!filePath) { response.writeHead(404).end(); return; }
      try {
        const bytes = await readFile(filePath); response.writeHead(200, { "Content-Type": fileName.endsWith(".png") ? "image/png" : "image/jpeg", "Content-Length": bytes.length, "Cache-Control": "private, max-age=31536000, immutable" }).end(bytes);
      } catch { response.writeHead(404).end(); }
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/image-production/status")) {
      try { const force = new URL(request.url, "http://localhost").searchParams.get("refresh") === "1"; response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(await this.imageProduction.status(force))); }
      catch (error: unknown) { response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Image provider status failed" })); }
      return;
    }
    if (request.method === "POST" && request.url === "/image-generation/jobs") {
      try {
        const body = await this.readJsonBody(request); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Generation request must be an object");
        const record = body as Record<string, unknown>;
        if (typeof record.projectId !== "string" || typeof record.prompt !== "string" || (record.provider !== "comfyui" && record.provider !== "draw_things")) throw new Error("projectId, provider, and prompt are required");
        const studioStatus = await this.request("studio_get_status", { includeActivity: false }, "Human");
        if (!studioStatus || typeof studioStatus !== "object" || (studioStatus as Record<string, unknown>).activeProjectId !== record.projectId) throw new Error(`Project ${record.projectId} is not the active Studio project`);
        const job = this.imageGenerationJobs.start({
          projectId: record.projectId, provider: record.provider, operation: record.generationIntent === "character_variant" ? "character_variant" : record.generationIntent === "equipment_variant" ? "equipment_variant" : "character_generation",
          prompt: record.prompt, candidateCount: typeof record.candidateCount === "number" ? record.candidateCount : 1,
          ...(typeof record.negativePrompt === "string" ? { negativePrompt: record.negativePrompt } : {}), ...(typeof record.width === "number" ? { width: record.width } : {}),
          ...(typeof record.height === "number" ? { height: record.height } : {}), ...(typeof record.seed === "number" ? { seed: record.seed } : {}),
          ...(typeof record.model === "string" ? { model: record.model } : {}),
        });
        response.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify(job));
      } catch (error: unknown) { response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Image generation job could not start" })); }
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/image-generation/jobs/")) {
      try { const jobId = decodeURIComponent(request.url.split("?")[0].slice("/image-generation/jobs/".length)); response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(this.imageGenerationJobs.get(jobId))); }
      catch (error: unknown) { response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Image generation job is unavailable" })); }
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/image-production/proposals")) {
      try {
        const url = new URL(request.url, "http://127.0.0.1"); const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length === 2) {
          const proposals = await this.imageProduction.listProposals(url.searchParams.get("projectId") ?? undefined);
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ proposals: proposals.map((proposal) => this.publicProposal(proposal)) })); return;
        }
        const proposalId = decodeURIComponent(parts[2] ?? "");
        if (parts.length === 4 && parts[3] === "candidates") {
          let proposal = await this.imageProduction.getProposal(proposalId);
          for (const candidate of proposal.candidates) proposal = (await this.imageProduction.getCandidate(proposalId, candidate.candidateId, "human-ui")).proposal;
          const port = await this.waitUntilListening();
          const candidates = proposal.candidates.map((candidate) => ({
            candidateId: candidate.candidateId, width: candidate.width, height: candidate.height, seed: candidate.seed, status: candidate.status,
            suitabilityScore: candidate.diagnostics.suitability?.score, providerMetadata: candidate.providerMetadata,
            imageUrl: `http://127.0.0.1:${port}/image-production/assets/${encodeURIComponent(proposalId)}/${encodeURIComponent(candidate.imageFileName)}`,
          }));
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ proposal: this.publicProposal(proposal), candidates })); return;
        }
        if (parts.length === 3) {
          const proposal = await this.imageProduction.getProposal(proposalId); response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(this.publicProposal(proposal))); return;
        }
      } catch (error: unknown) { response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Proposal unavailable" })); return; }
    }
    if (request.method === "POST" && request.url?.startsWith("/image-production/proposals/")) {
      try {
        const url = new URL(request.url, "http://127.0.0.1"); const parts = url.pathname.split("/").filter(Boolean); const proposalId = decodeURIComponent(parts[2] ?? ""); const action = parts[3];
        const body = await this.readJsonBody(request); if (!body || typeof body !== "object") throw new Error("Request body must be an object");
        const values = body as Record<string, unknown>;
        if (values.confirm !== true) throw new Error("Explicit confirmation is required");
        if (action === "approve" && typeof values.candidateId === "string") {
          const result = await this.approveImageCandidate(proposalId, values.candidateId, "human"); response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result)); return;
        }
        if (action === "reject" && typeof values.candidateId === "string" && typeof values.reason === "string") {
          const proposal = await this.imageProduction.rejectCandidate(proposalId, values.candidateId, "Human", values.reason); response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(this.publicProposal(proposal))); return;
        }
        throw new Error("Unsupported image proposal action");
      } catch (error: unknown) { response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Image proposal action failed" })); return; }
    }
    if (request.method === "POST" && (request.url === "/hello" || request.url === "/response")) {
      try {
        const input = await this.readJsonBody(request);
        if (request.url === "/hello") {
          const hello = bridgeHelloSchema.parse(input); this.sessionId = hello.sessionId; this.pollingSeenAt = Date.now();
        } else {
          const result = bridgeResponseSchema.parse(input); this.resolveResponse(result); this.pollingSeenAt = Date.now();
        }
        response.writeHead(204).end();
      } catch (error: unknown) {
        response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Malformed bridge message" }));
      }
      return;
    }
    response.writeHead(404).end();
  }

  private readJsonBody(request: IncomingMessage, maximumBytes = 1_000_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0;
      request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maximumBytes) { reject(new Error(`Bridge message exceeds ${Math.round(maximumBytes / 1_000_000)} MB`)); request.destroy(); return; } chunks.push(chunk); });
      request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); } catch { reject(new Error("Bridge message is not valid JSON")); } });
      request.on("error", reject);
    });
  }

  private resolveResponse(response: BridgeResponse): void {
    const pending = this.pending.get(response.id); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(response.id); pending.resolve(response.result);
  }

  private publicProposal(proposal: Awaited<ReturnType<ImageProductionService["getProposal"]>>) {
    return {
      proposalId: proposal.proposalId, projectId: proposal.projectId, operationType: proposal.operationType, provider: proposal.provider, workflowId: proposal.workflowId, status: proposal.status,
      sourcePrompt: proposal.sourcePrompt, negativePrompt: proposal.negativePrompt, generationParameters: proposal.generationParameters,
      approvalPolicy: proposal.approvalPolicy, createdAt: proposal.createdAt, updatedAt: proposal.updatedAt, progress: proposal.progress,
      candidateCount: proposal.candidates.length, candidateIds: proposal.candidateIds, warnings: proposal.warnings, errors: proposal.errors,
      agentReview: proposal.agentReview, humanReview: proposal.humanReview, approvedCandidateId: proposal.approvedCandidateId,
      requiresHumanApproval: proposal.approvalPolicy === "manual" && proposal.status === "awaiting_review",
    };
  }

  private async persistPreview(result: unknown, input?: unknown): Promise<unknown> {
    if (!result || typeof result !== "object") return result;
    const record = result as Record<string, unknown>;
    const preview = record.preview;
    if (!preview || typeof preview !== "object") return result;
    const data = preview as Record<string, unknown>;
    if (typeof data.imageBase64 !== "string" || typeof data.renderId !== "string") return result;
    const directory = path.resolve(this.cwd, ".rigging-studio", "previews");
    await mkdir(directory, { recursive: true });
    const filePath = path.resolve(directory, `${data.renderId}.png`);
    if (!filePath.startsWith(`${directory}${path.sep}`)) throw new Error("Preview path escaped its fixed output directory");
    const bytes = Buffer.from(data.imageBase64, "base64"); await writeFile(filePath, bytes);
    this.latestPreviewPath = filePath;
    const projectId = input && typeof input === "object" && typeof (input as Record<string, unknown>).projectId === "string" ? String((input as Record<string, unknown>).projectId) : null;
    const projectPreviewPath = projectId ? await this.projectStorage.savePreview(projectId, data.renderId, bytes).catch(() => null) : null;
    const safePreview = { ...data, imageBase64: undefined, imagePath: projectPreviewPath ?? filePath, resourceUri: "rigging://active-project/preview/latest" };
    return { ...record, preview: safePreview };
  }
}
