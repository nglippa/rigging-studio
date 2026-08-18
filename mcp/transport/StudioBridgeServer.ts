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
import { suitabilityReviewSchema } from "../../src/character-generation/providers/characterPipelineProvider";
import type { ImageApprovalPolicy, ImageProposalReviewInput } from "../../src/image-production/proposals/imageProposal";
import { ImageProposalStorage } from "../../src/image-production/assets/imageProposalStorage";

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
  readonly imageProduction: ImageProductionService;

  constructor(options: StudioBridgeOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.cwd = options.cwd ?? process.cwd();
    this.generationStorage = new ManagedGenerationStorage({ cwd: this.cwd });
    this.diagnosticExporter = new DiagnosticReportExporter({ cwd: this.cwd });
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
    return tool === "preview_render" ? this.persistPreview(result) : result;
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
    const approved = await this.imageProduction.approve(proposalId, candidateId, source);
    const port = await this.waitUntilListening();
    const normalized = await this.generationStorage.ingest({
      projectId: approved.proposal.projectId,
      imageSource: { type: "provider_asset", path: approved.filePath, assetId: approved.candidate.imageAssetId },
      generationId: `${approved.proposal.proposalId}-${approved.candidate.candidateId}`,
      provider: "comfyui", prompt: approved.proposal.sourcePrompt, accepted: true,
      operation: approved.proposal.operationType, targetPartId: approved.proposal.targetPartId, generationMode: "provider_generated",
      metadata: {
        proposalId: approved.proposal.proposalId, candidateId: approved.candidate.candidateId, workflowId: approved.proposal.workflowId,
        seed: approved.candidate.seed, approvalPolicy: approved.proposal.approvalPolicy, proposalRound: approved.proposal.proposalRound,
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
      try { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(await this.imageProduction.status())); }
      catch (error: unknown) { response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Image provider status failed" })); }
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
            suitabilityScore: candidate.diagnostics.suitability?.score,
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

  private readJsonBody(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0;
      request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1_000_000) { reject(new Error("Bridge message exceeds 1 MB")); request.destroy(); return; } chunks.push(chunk); });
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
      proposalId: proposal.proposalId, projectId: proposal.projectId, operationType: proposal.operationType, workflowId: proposal.workflowId, status: proposal.status,
      approvalPolicy: proposal.approvalPolicy, createdAt: proposal.createdAt, updatedAt: proposal.updatedAt, progress: proposal.progress,
      candidateCount: proposal.candidates.length, candidateIds: proposal.candidateIds, warnings: proposal.warnings, errors: proposal.errors,
      agentReview: proposal.agentReview, humanReview: proposal.humanReview, approvedCandidateId: proposal.approvedCandidateId,
      requiresHumanApproval: proposal.approvalPolicy === "manual" && proposal.status === "awaiting_review",
    };
  }

  private async persistPreview(result: unknown): Promise<unknown> {
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
    await writeFile(filePath, Buffer.from(data.imageBase64, "base64"));
    this.latestPreviewPath = filePath;
    const safePreview = { ...data, imageBase64: undefined, imagePath: filePath, resourceUri: "rigging://active-project/preview/latest" };
    return { ...record, preview: safePreview };
  }
}
