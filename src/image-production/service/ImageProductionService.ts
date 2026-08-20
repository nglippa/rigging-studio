import { buildCharacterGenerationPrompt } from "../../character-generation/prompt/characterPromptBuilder";
import type { CharacterPromptControls } from "../../character-generation/prompt/generationPreset";
import type { SuitabilityReview } from "../../character-generation/providers/characterPipelineProvider";
import { ImageProposalStorage } from "../assets/imageProposalStorage";
import { ComfyUIAdapter } from "../comfy/ComfyUIAdapter";
import { imageProposalReviewInputSchema, type ImageApprovalPolicy, type ImageCandidate, type ImageProductionCapability, type ImageProductionJson, type ImageProposal, type ImageProposalReviewInput } from "../proposals/imageProposal";
import type { ImageProductionProvider, ImageProviderProgress } from "../providers/imageProductionProvider";
import { TrustedWorkflowRegistry } from "../workflows/registry";
import { bindTrustedWorkflow } from "../workflows/workflowManifest";

const DEFAULT_CONTROLS: CharacterPromptControls = {
  style: "stylized-game", bodyProportions: "compact readable game proportions", viewDirection: "right",
  mainHandEquipment: "separable weapon", offHandEquipment: "separable shield", hair: "readable modular hair", headwear: "optional modular headwear",
  characterScale: "medium", artResolution: "1024", background: "flat-contrast",
};

const OPERATION_CAPABILITY: Readonly<Record<string, ImageProductionCapability>> = {
  character_generation: "CHARACTER_GENERATION", character_variant: "CHARACTER_VARIANT", occlusion_reconstruction: "OCCLUSION_RECONSTRUCTION",
  part_repair: "PART_REPAIR", background_removal: "BACKGROUND_REMOVAL", alpha_edge_cleanup: "ALPHA_EDGE_CLEANUP",
  equipment_variant: "EQUIPMENT_VARIANT", hand_repair: "HAND_REPAIR",
};

export type GenerateImageCandidatesRequest = {
  readonly projectId: string;
  readonly operation: keyof typeof OPERATION_CAPABILITY;
  readonly prompt: string;
  readonly candidateCount?: number;
  readonly preset?: "MODULAR_2D_RIG_CHARACTER";
  readonly negativePrompt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly seed?: number;
  readonly steps?: number;
  readonly guidance?: number;
  readonly stylePreset?: string;
  readonly targetPartId?: string;
  readonly parentProposalId?: string;
};

export type ImageProductionServiceOptions = {
  readonly provider?: ImageProductionProvider;
  readonly registry?: TrustedWorkflowRegistry;
  readonly storage?: ImageProposalStorage;
  readonly now?: () => Date;
  readonly randomSeed?: () => number;
  readonly currentSessionId?: () => string | null;
  readonly analyzeCandidate?: (proposal: ImageProposal, candidate: ImageCandidate) => Promise<SuitabilityReview | undefined>;
  readonly resolveRepairAssets?: (request: GenerateImageCandidatesRequest) => Promise<{
    readonly sourceImage: { readonly bytes: Uint8Array; readonly mimeType: "image/png" | "image/jpeg" };
    readonly maskImage: { readonly bytes: Uint8Array; readonly mimeType: "image/png" };
  }>;
};

export class ImageProductionService {
  readonly provider: ImageProductionProvider;
  readonly registry: TrustedWorkflowRegistry;
  readonly storage: ImageProposalStorage;
  private readonly now: () => Date;
  private readonly randomSeed: () => number;
  private readonly currentSessionId: () => string | null;
  private readonly analyzeCandidate?: (proposal: ImageProposal, candidate: ImageCandidate) => Promise<SuitabilityReview | undefined>;
  private readonly resolveRepairAssets?: ImageProductionServiceOptions["resolveRepairAssets"];
  private readonly policies = new Map<string, ImageApprovalPolicy>();
  private readonly activePromptIds = new Map<string, string>();

  constructor(options: ImageProductionServiceOptions = {}) {
    this.provider = options.provider ?? new ComfyUIAdapter();
    this.registry = options.registry ?? new TrustedWorkflowRegistry();
    this.storage = options.storage ?? new ImageProposalStorage();
    this.now = options.now ?? (() => new Date());
    this.randomSeed = options.randomSeed ?? (() => Math.floor(Math.random() * 2_147_483_647));
    this.currentSessionId = options.currentSessionId ?? (() => null);
    this.analyzeCandidate = options.analyzeCandidate;
    this.resolveRepairAssets = options.resolveRepairAssets;
  }

  async status(refreshWorkflows = false) {
    const [provider, capabilities] = await Promise.all([this.provider.status(), this.registry.listCapabilities(refreshWorkflows)]);
    const checked = await Promise.all(capabilities.map(async (capability) => {
      if (!provider.reachable) return { ...capability, capabilityAvailable: false, reason: `ComfyUI offline at ${provider.url}: ${provider.message}` };
      if (!capability.capabilityAvailable) return capability;
      try {
        const workflow = await this.registry.require(capability.capability);
        const dependencies = await this.provider.inspectDependencies(workflow);
        return dependencies.available ? capability : { ...capability, capabilityAvailable: false, reason: formatDependencyFailure(dependencies) };
      } catch (error: unknown) { return { ...capability, capabilityAvailable: false, reason: error instanceof Error ? error.message : "Dependency inspection failed" }; }
    }));
    return { provider, capabilities: checked, conservativeDefaults: { candidateCount: 3, maximumCandidateCount: 4, candidateConcurrency: 1, maximumProposalRounds: 2 } };
  }

  async generateCandidates(request: GenerateImageCandidatesRequest): Promise<ImageProposal> {
    const capability = OPERATION_CAPABILITY[request.operation];
    if (!capability) throw new Error(`Unsupported trusted image operation ${request.operation}`);
    const workflow = await this.registry.require(capability);
    const providerStatus = await this.provider.status();
    if (!providerStatus.reachable) throw new Error(`ComfyUI is offline at ${providerStatus.url}: ${providerStatus.message}`);
    const dependencies = await this.provider.inspectDependencies(workflow);
    if (!dependencies.available) throw new Error(formatDependencyFailure(dependencies));
    const candidateCount = request.candidateCount ?? 3;
    if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 4) throw new Error("Candidate count must be between 1 and 4");
    if (request.parentProposalId) {
      const parent = await this.storage.readProposal(request.parentProposalId);
      if (parent.projectId !== request.projectId) throw new Error("Parent proposal belongs to another project");
      if (parent.proposalRound >= 2) throw new Error("The maximum of 2 image proposal rounds has been reached");
    }
    if (isRepairCapability(capability) && !request.targetPartId) throw new Error(`${capability} requires a targetPartId`);
    let repairBindings: Readonly<Record<string, ImageProductionJson>> = {};
    if (isRepairCapability(capability)) {
      if (!workflow.manifest.inputs.sourceImage || !workflow.manifest.inputs.maskImage) throw new Error(`Trusted ${capability} workflow must declare sourceImage and maskImage bindings`);
      if (!this.resolveRepairAssets || !this.provider.uploadImage) throw new Error(`${capability} managed source/mask preparation is unavailable`);
      const assets = await this.resolveRepairAssets(request);
      const sourceImage = await this.provider.uploadImage(`${request.projectId}-${request.targetPartId}-source.${assets.sourceImage.mimeType === "image/png" ? "png" : "jpg"}`, assets.sourceImage.bytes, assets.sourceImage.mimeType);
      const maskImage = await this.provider.uploadImage(`${request.projectId}-${request.targetPartId}-mask.png`, assets.maskImage.bytes, "image/png");
      repairBindings = { sourceImage, maskImage };
    }

    const built = buildCharacterGenerationPrompt({ description: request.prompt, controls: DEFAULT_CONTROLS });
    const prompt = capability === "CHARACTER_GENERATION" || capability === "CHARACTER_VARIANT" ? built.prompt : request.prompt;
    const negativePrompt = request.negativePrompt ?? built.negativePrompt;
    const proposalId = `proposal-${crypto.randomUUID()}`;
    const timestamp = this.now().toISOString();
    const parent = request.parentProposalId ? await this.storage.readProposal(request.parentProposalId) : undefined;
    const approvalPolicy = this.policies.get(request.projectId) ?? await this.storage.readApprovalPolicy(request.projectId);
    this.policies.set(request.projectId, approvalPolicy);
    let proposal: ImageProposal = {
      proposalVersion: 1, proposalId, projectId: request.projectId, operationType: capability, provider: "comfyui", workflowId: workflow.manifest.id,
      status: "generating", approvalPolicy, createdAt: timestamp, updatedAt: timestamp,
      sourcePrompt: prompt, negativePrompt,
      generationParameters: {
        candidateCount, preset: request.preset ?? "MODULAR_2D_RIG_CHARACTER", width: request.width ?? 768, height: request.height ?? 768,
        steps: request.steps ?? 24, guidance: request.guidance ?? 7, stylePreset: request.stylePreset ?? "stylized-game", candidateConcurrency: 1,
      },
      ...(request.targetPartId ? { targetPartId: request.targetPartId } : {}), ...(request.parentProposalId ? { parentProposalId: request.parentProposalId } : {}),
      proposalRound: (parent?.proposalRound ?? 0) + 1, candidateIds: [], candidates: [], warnings: [], errors: [], inspectionEvidence: [],
      progress: { phase: "queued", candidateIndex: 0, candidateCount, message: `ComfyUI · queued 0 of ${candidateCount}` },
    };
    await this.storage.create(proposal);

    const candidates: ImageCandidate[] = [];
    const errors: string[] = [];
    for (let index = 0; index < candidateCount; index += 1) {
      const seed = request.seed === undefined ? this.randomSeed() : request.seed + index;
      proposal = await this.progress(proposal, { phase: "queued", candidateIndex: index + 1, candidateCount, message: `Generating candidate ${index + 1} of ${candidateCount}` });
      try {
        const values: Readonly<Record<string, ImageProductionJson>> = {
          positivePrompt: prompt, negativePrompt, width: request.width ?? 768, height: request.height ?? 768, seed,
          steps: request.steps ?? 24, guidance: request.guidance ?? 7, checkpoint: process.env.COMFYUI_CHECKPOINT ?? "model.safetensors",
          ...repairBindings,
        };
        const bound = bindTrustedWorkflow(workflow, values);
        const submitted = await this.provider.submit(bound); this.activePromptIds.set(proposalId, submitted.promptId);
        let progressQueue = Promise.resolve();
        const result = await this.provider.waitForCompletion(submitted.promptId, workflow.manifest.outputs.images.nodeId, (progress) => {
          progressQueue = progressQueue.then(async () => { proposal = await this.progress(proposal, this.mapProgress(progress, index + 1, candidateCount)); }).catch(() => undefined);
        });
        await progressQueue;
        const output = result.outputs[0];
        if (!output) throw new Error("ComfyUI returned no candidate image");
        const candidateId = `candidate-${String(index + 1).padStart(2, "0")}`;
        const asset = await this.storage.writeCandidate(proposalId, candidateId, output.bytes, output.mimeType);
        let candidate: ImageCandidate = {
          candidateId, imageAssetId: asset.imageAssetId, imageFileName: asset.imageFileName, width: asset.width, height: asset.height, seed,
          providerMetadata: { promptId: result.promptId, providerFilename: output.providerAsset.filename, providerSubfolder: output.providerAsset.subfolder, workflowId: workflow.manifest.id },
          diagnostics: { warnings: result.warnings }, status: "generated",
        };
        candidates.push(candidate);
        proposal = { ...proposal, candidates: [...candidates], candidateIds: candidates.map((item) => item.candidateId), updatedAt: this.now().toISOString() };
        await this.storage.writeProposal(proposal);
        if (this.analyzeCandidate && capability === "CHARACTER_GENERATION") {
          try {
            const suitability = await this.analyzeCandidate(proposal, candidate);
            if (suitability) {
              candidate = { ...candidate, diagnostics: { ...candidate.diagnostics, suitability } };
              candidates[candidates.length - 1] = candidate;
              proposal = { ...proposal, candidates: [...candidates], warnings: [...proposal.warnings, ...suitability.issues.map((issue) => `${candidateId}: ${issue.message}`)], updatedAt: this.now().toISOString() };
              await this.storage.writeProposal(proposal);
            }
          } catch (error: unknown) { proposal = { ...proposal, warnings: [...proposal.warnings, `${candidateId} suitability unavailable: ${error instanceof Error ? error.message : "analysis failed"}`] }; }
        }
      } catch (error: unknown) {
        errors.push(`Candidate ${index + 1}: ${error instanceof Error ? error.message : "generation failed"}`);
        proposal = { ...proposal, errors: [...errors], updatedAt: this.now().toISOString() }; await this.storage.writeProposal(proposal);
      } finally { this.activePromptIds.delete(proposalId); }
    }

    proposal = {
      ...proposal, status: candidates.length ? "awaiting_review" : "failed", candidates: [...candidates], candidateIds: candidates.map((candidate) => candidate.candidateId),
      errors: [...errors], updatedAt: this.now().toISOString(),
      progress: candidates.length
        ? { phase: "ready", candidateIndex: candidateCount, candidateCount, percent: 100, message: `${candidates.length} candidate${candidates.length === 1 ? "" : "s"} ready for review` }
        : { phase: "failed", candidateIndex: candidateCount, candidateCount, message: "ComfyUI produced no usable candidates" },
    };
    await this.storage.writeProposal(proposal);
    return proposal;
  }

  async getProposal(proposalId: string): Promise<ImageProposal> { return this.storage.readProposal(proposalId); }
  async listProposals(projectId?: string): Promise<readonly ImageProposal[]> { return this.storage.list(projectId); }

  async getCandidate(proposalId: string, candidateId: string, sessionId = this.requireSessionId()): Promise<{ readonly proposal: ImageProposal; readonly candidate: ImageCandidate; readonly bytes: Uint8Array; readonly mimeType: "image/png" | "image/jpeg" }> {
    let proposal = await this.storage.readProposal(proposalId);
    const candidate = requireCandidate(proposal, candidateId);
    proposal = await this.recordInspection(proposal, `rigging://image-proposals/${proposalId}/candidates/${candidateId}`, [candidateId], sessionId);
    const bytes = await this.storage.readAsset(proposalId, candidate.imageFileName);
    return { proposal, candidate, bytes, mimeType: candidate.imageFileName.endsWith(".png") ? "image/png" : "image/jpeg" };
  }

  async recordContactSheet(proposalId: string, pngBase64: string, sessionId = this.requireSessionId()): Promise<ImageProposal> {
    let proposal = await this.storage.readProposal(proposalId);
    if (!proposal.candidates.length) throw new Error("Proposal has no candidates to render");
    const bytes = Buffer.from(pngBase64, "base64");
    const sheet = await this.storage.writeContactSheet(proposalId, bytes);
    proposal = { ...proposal, contactSheetFileName: sheet.fileName, updatedAt: this.now().toISOString() };
    proposal = await this.recordInspection(proposal, `rigging://image-proposals/${proposalId}/contact-sheet`, proposal.candidateIds, sessionId);
    return proposal;
  }

  async getContactSheet(proposalId: string, sessionId = this.requireSessionId()): Promise<{ readonly proposal: ImageProposal; readonly bytes: Uint8Array }> {
    let proposal = await this.storage.readProposal(proposalId);
    if (!proposal.contactSheetFileName) throw new Error("Render the candidate contact sheet first");
    const contactSheetFileName = proposal.contactSheetFileName;
    proposal = await this.recordInspection(proposal, `rigging://image-proposals/${proposalId}/contact-sheet`, proposal.candidateIds, sessionId);
    return { proposal, bytes: await this.storage.readAsset(proposalId, contactSheetFileName) };
  }

  async review(input: ImageProposalReviewInput, reviewer: string): Promise<ImageProposal> {
    const parsed = imageProposalReviewInputSchema.parse(input);
    let proposal = await this.storage.readProposal(parsed.proposalId);
    if (proposal.status !== "awaiting_review") throw new Error(`Proposal ${proposal.proposalId} is not awaiting review`);
    const reviewedIds = new Set(parsed.candidateReviews.map((review) => review.candidateId));
    parsed.candidateReviews.forEach((review) => requireCandidate(proposal, review.candidateId));
    if (parsed.recommendedCandidateId) {
      requireCandidate(proposal, parsed.recommendedCandidateId);
      if (!reviewedIds.has(parsed.recommendedCandidateId)) throw new Error("Recommended candidate must have a structured candidate review");
    }
    const timestamp = this.now().toISOString();
    const decisions = new Map(parsed.candidateReviews.map((review) => [review.candidateId, review.decision]));
    proposal = {
      ...proposal, updatedAt: timestamp,
      agentReview: { reviewer, reviewedAt: timestamp, ...(parsed.recommendedCandidateId ? { recommendedCandidateId: parsed.recommendedCandidateId } : {}), candidateReviews: parsed.candidateReviews },
      candidates: proposal.candidates.map((candidate) => decisions.get(candidate.candidateId) === "reject" ? { ...candidate, status: "rejected" } : parsed.recommendedCandidateId === candidate.candidateId ? { ...candidate, status: "recommended" } : candidate),
    };
    await this.storage.writeProposal(proposal); return proposal;
  }

  async approve(proposalId: string, candidateId: string, source: "agent" | "human"): Promise<{ readonly proposal: ImageProposal; readonly candidate: ImageCandidate; readonly filePath: string }> {
    let proposal = await this.storage.readProposal(proposalId);
    const candidate = requireCandidate(proposal, candidateId);
    if (proposal.status !== "awaiting_review") throw new Error(`Proposal ${proposalId} is not awaiting review`);
    if (source === "agent" && proposal.approvalPolicy === "manual") throw new Error("This proposal requires explicit human/UI approval (requiresHumanApproval: true)");
    const sessionId = source === "human" ? "human-ui" : this.requireSessionId();
    const inspected = proposal.inspectionEvidence.some((evidence) => evidence.sessionId === sessionId && evidence.candidateIds.includes(candidateId));
    if (!inspected) throw new Error(`Candidate ${candidateId} must be visually inspected in the current session before approval`);
    if (source === "agent") {
      const review = proposal.agentReview?.candidateReviews.find((item) => item.candidateId === candidateId);
      if (!review || review.decision === "reject") throw new Error("Agent approval requires a structured recommend or acceptable review for the candidate");
    }
    const timestamp = this.now().toISOString();
    proposal = {
      ...proposal, status: "approved", approvedCandidateId: candidateId, updatedAt: timestamp,
      ...(source === "human" ? { humanReview: { reviewer: "human" as const, reviewedAt: timestamp, decision: "approved" as const, candidateId } } : {}),
      candidates: proposal.candidates.map((item) => ({ ...item, status: item.candidateId === candidateId ? "approved" as const : item.status === "rejected" ? item.status : "rejected" as const })),
    };
    await this.storage.writeProposal(proposal);
    const filePath = this.storage.assetPath(proposalId, candidate.imageFileName);
    if (!filePath) throw new Error("Approved candidate asset is unavailable");
    return { proposal, candidate: requireCandidate(proposal, candidateId), filePath };
  }

  async rejectCandidate(proposalId: string, candidateId: string, reviewer: string, reason: string): Promise<ImageProposal> {
    let proposal = await this.storage.readProposal(proposalId); requireCandidate(proposal, candidateId);
    if (proposal.status !== "awaiting_review") throw new Error(`Proposal ${proposalId} is not awaiting review`);
    const candidates = proposal.candidates.map((candidate) => candidate.candidateId === candidateId ? { ...candidate, status: "rejected" as const, diagnostics: { ...candidate.diagnostics, warnings: [...candidate.diagnostics.warnings, `Rejected by ${reviewer}: ${reason}`] } } : candidate);
    proposal = { ...proposal, candidates, status: candidates.every((candidate) => candidate.status === "rejected") ? "rejected" : proposal.status, updatedAt: this.now().toISOString() };
    await this.storage.writeProposal(proposal); return proposal;
  }

  async regenerate(proposalId: string, amendedPrompt?: string): Promise<ImageProposal> {
    const parent = await this.storage.readProposal(proposalId);
    if (parent.proposalRound >= 2) throw new Error("The maximum of 2 image proposal rounds has been reached");
    return this.generateCandidates({
      projectId: parent.projectId, operation: operationName(parent.operationType), prompt: amendedPrompt ?? parent.sourcePrompt,
      candidateCount: numberParameter(parent, "candidateCount", 3), width: numberParameter(parent, "width", 768), height: numberParameter(parent, "height", 768),
      steps: numberParameter(parent, "steps", 24), guidance: numberParameter(parent, "guidance", 7), targetPartId: parent.targetPartId, parentProposalId: parent.proposalId,
    });
  }

  async setApprovalPolicy(projectId: string, policy: ImageApprovalPolicy): Promise<ImageApprovalPolicy> {
    await this.storage.writeApprovalPolicy(projectId, policy);
    this.policies.set(projectId, policy);
    return policy;
  }

  async getApprovalPolicy(projectId: string): Promise<ImageApprovalPolicy> {
    const cached = this.policies.get(projectId);
    if (cached) return cached;
    const policy = await this.storage.readApprovalPolicy(projectId);
    this.policies.set(projectId, policy);
    return policy;
  }

  async cancel(proposalId: string): Promise<boolean> {
    const promptId = this.activePromptIds.get(proposalId); if (!promptId || !this.provider.cancel) return false;
    return this.provider.cancel(promptId);
  }

  private async progress(proposal: ImageProposal, progress: ImageProposal["progress"]): Promise<ImageProposal> {
    const next = { ...proposal, progress, updatedAt: this.now().toISOString() }; await this.storage.writeProposal(next); return next;
  }

  private mapProgress(progress: ImageProviderProgress, candidateIndex: number, candidateCount: number): ImageProposal["progress"] {
    return { phase: progress.phase, candidateIndex, candidateCount, ...(progress.percent === undefined ? {} : { percent: progress.percent }), message: progress.message };
  }

  private async recordInspection(proposal: ImageProposal, resourceId: string, candidateIds: readonly string[], sessionId: string): Promise<ImageProposal> {
    const evidence = { resourceId, candidateIds: [...candidateIds], sessionId, inspectedAt: this.now().toISOString() };
    const next = { ...proposal, inspectionEvidence: [...proposal.inspectionEvidence, evidence], updatedAt: this.now().toISOString() };
    await this.storage.writeProposal(next); return next;
  }

  private requireSessionId(): string {
    const sessionId = this.currentSessionId(); if (!sessionId) throw new Error("A connected Rigging Studio session is required for inspection evidence"); return sessionId;
  }
}

function requireCandidate(proposal: ImageProposal, candidateId: string): ImageCandidate {
  const candidate = proposal.candidates.find((item) => item.candidateId === candidateId);
  if (!candidate) throw new Error(`Candidate ${candidateId} does not belong to proposal ${proposal.proposalId}`);
  return candidate;
}
function isRepairCapability(capability: ImageProductionCapability): boolean { return capability === "OCCLUSION_RECONSTRUCTION" || capability === "PART_REPAIR" || capability === "HAND_REPAIR"; }
function formatDependencyFailure(dependencies: { readonly missingNodeClasses: readonly string[]; readonly missingModels: readonly string[] }): string {
  return [`Missing ComfyUI node classes: ${dependencies.missingNodeClasses.join(", ") || "none"}`, `Missing workflow/model configuration: ${dependencies.missingModels.join(", ") || "none"}`].join("; ");
}
function operationName(capability: ImageProductionCapability): keyof typeof OPERATION_CAPABILITY {
  const entry = Object.entries(OPERATION_CAPABILITY).find(([, value]) => value === capability);
  if (!entry) throw new Error(`No trusted operation mapping for ${capability}`);
  return entry[0] as keyof typeof OPERATION_CAPABILITY;
}
function numberParameter(proposal: ImageProposal, key: string, fallback: number): number { const value = proposal.generationParameters[key]; return typeof value === "number" ? value : fallback; }
