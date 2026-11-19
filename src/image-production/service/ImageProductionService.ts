import { buildCharacterGenerationPrompt } from "../../character-generation/prompt/characterPromptBuilder";
import type { CharacterPromptControls } from "../../character-generation/prompt/generationPreset";
import type { SuitabilityReview } from "../../character-generation/providers/characterPipelineProvider";
import { ImageProposalStorage } from "../assets/imageProposalStorage";
import { ComfyUIAdapter } from "../comfy/ComfyUIAdapter";
import { DrawThingsProvider } from "../draw-things/DrawThingsProvider";
import { imageProposalReviewInputSchema, type ImageApprovalPolicy, type ImageCandidate, type ImageProductionCapability, type ImageProductionJson, type ImageProposal, type ImageProposalProvider, type ImageProposalReviewInput } from "../proposals/imageProposal";
import type { ImageGenerationProvider } from "../providers/imageGenerationProvider";
import type { ImageProductionProvider, ImageProviderProgress } from "../providers/imageProductionProvider";
import { TrustedWorkflowRegistry } from "../workflows/registry";
import { bindTrustedWorkflow, type LoadedTrustedWorkflow } from "../workflows/workflowManifest";
import { createStudioQueue } from "../studio/studioSession";
import type { StudioWorkQueue } from "../studio/StudioWorkQueue";
import { PNG } from "pngjs";
import { pixelize } from "../pixel/pixelize";
import { removePlainBackground } from "../profiles/plainBackground";
import { bindProfile, coerceParam, CUTOUT_PROFILE_ID, DEFAULT_PROFILE_ID, findProfile, listProfiles, PROFILE_GUIDANCE, profilePrompt, profileRequirements, tunableParams, type CcMediaProfile } from "../profiles/ccMediaProfile";

const DEFAULT_CONTROLS: CharacterPromptControls = {
  style: "chibi-pixel-art", bodyProportions: "oversized head, compact torso, short separated limbs", viewDirection: "right",
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
  readonly provider?: ImageProposalProvider;
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
  readonly model?: string;
  readonly styleReferenceAssetId?: string;
  readonly poseReferenceAssetId?: string;
  readonly metadata?: Readonly<Record<string, ImageProductionJson>>;
  readonly onProposalCreated?: (proposalId: string) => void;
  /** Why the job is waiting for the Mac Studio (Command Center is using it, a model is loaded there...). */
  readonly onStudioWait?: (reason: string) => void;
  readonly targetPartId?: string;
  readonly parentProposalId?: string;
  /** A cc-media-profile/1 generation profile (model, LoRAs, ControlNet, custom nodes) to generate the character with. */
  readonly profileId?: string;
  /** Values for the profile's params (LoRA strengths, size, ...); each is clamped to the profile's limits. */
  readonly profileParams?: Readonly<Record<string, ImageProductionJson>>;
};

export type ImageProductionServiceOptions = {
  readonly provider?: ImageProductionProvider;
  /** Runs every job on the Studio's engine in turn, under Command Center's lease, and unloads the engine after. */
  readonly studio?: StudioWorkQueue;
  readonly generationProviders?: readonly ImageGenerationProvider[];
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

export type ProfileStatus = {
  readonly id: string; readonly label: string; readonly source: "built-in" | "studio" | "imported"; readonly available: boolean; readonly reason?: string;
  readonly missing: readonly string[]; readonly recommended: boolean; readonly benchRank?: number; readonly benchSummary?: string; readonly benchSeconds?: number;
  readonly bestFor?: string; readonly speed?: string; readonly params: ReturnType<typeof tunableParams>; readonly requires: readonly string[]; readonly nodeClasses: readonly string[];
};

/** A generation profile in the shape of a trusted workflow, so it is checked, run and reviewed like one. */
function profileWorkflow(profile: CcMediaProfile, capability: ImageProductionCapability): LoadedTrustedWorkflow {
  const requirements = profileRequirements(profile);
  return {
    manifest: {
      manifestVersion: 1, id: profile.id, capability, workflowFile: `${profile.id}.json`, description: profile.label, inputs: {},
      outputs: { images: { nodeId: profile.output.node } }, requiredNodeClasses: requirements.nodeClasses, requiredModels: requirements.files.map((file) => `file:${file}`),
    },
    workflow: profile.graph as unknown as LoadedTrustedWorkflow["workflow"], manifestPath: `profile:${profile.id}`, workflowPath: `profile:${profile.id}`,
  };
}

/** The candidate as true pixel art (see pixelize), or null when it is not a PNG or shows no pixel grid. */
function truePixels(image: { readonly bytes: Uint8Array; readonly mimeType: string }): { readonly bytes: Uint8Array; readonly scale: number; readonly nativeWidth: number; readonly nativeHeight: number; readonly colours: number } | null {
  if (image.mimeType !== "image/png") return null;
  const png = PNG.sync.read(Buffer.from(image.bytes));
  const result = pixelize({ width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) });
  if (result.grid.cell < 3 || result.scale < 2) return null;
  const out = new PNG({ width: result.exact.width, height: result.exact.height }); out.data.set(result.exact.data);
  return { bytes: PNG.sync.write(out), scale: result.scale, nativeWidth: result.native.width, nativeHeight: result.native.height, colours: result.colours };
}

export class ImageProductionService {
  readonly provider: ImageProductionProvider;
  readonly studio: StudioWorkQueue;
  readonly registry: TrustedWorkflowRegistry;
  readonly storage: ImageProposalStorage;
  private readonly now: () => Date;
  private readonly randomSeed: () => number;
  private readonly currentSessionId: () => string | null;
  private readonly analyzeCandidate?: (proposal: ImageProposal, candidate: ImageCandidate) => Promise<SuitabilityReview | undefined>;
  private readonly resolveRepairAssets?: ImageProductionServiceOptions["resolveRepairAssets"];
  private readonly policies = new Map<string, ImageApprovalPolicy>();
  private readonly activePromptIds = new Map<string, string>();
  private readonly activeGenerationControllers = new Map<string, AbortController>();
  private readonly generationProviders: ReadonlyMap<string, ImageGenerationProvider>;

  constructor(options: ImageProductionServiceOptions = {}) {
    this.provider = options.provider ?? new ComfyUIAdapter();
    this.studio = options.studio ?? createStudioQueue(async () => (await this.provider.status()).reachable);
    const generationProviders = options.generationProviders ?? [new DrawThingsProvider({ cwd: process.cwd() })];
    this.generationProviders = new Map(generationProviders.map((provider) => [provider.id, provider]));
    this.registry = options.registry ?? new TrustedWorkflowRegistry();
    this.storage = options.storage ?? new ImageProposalStorage();
    this.now = options.now ?? (() => new Date());
    this.randomSeed = options.randomSeed ?? (() => Math.floor(Math.random() * 2_147_483_647));
    this.currentSessionId = options.currentSessionId ?? (() => null);
    this.analyzeCandidate = options.analyzeCandidate;
    this.resolveRepairAssets = options.resolveRepairAssets;
  }

  /** Capabilities that passed their dependency check the last time ComfyUI answered. */
  private readonly lastAvailable = new Set<string>();

  async status(refreshWorkflows = false) {
    const [reported, capabilities, generationProviders] = await Promise.all([
      this.provider.status(), this.registry.listCapabilities(refreshWorkflows),
      Promise.all([...this.generationProviders.values()].map((item) => item.getCapabilities())),
    ]);
    // An engine that stops itself when idle (the Mac Studio's gate) is asleep, not broken, when the bridge can start it
    // (COMFYUI_WAKE_URL). Looking never loads it: what worked at the last check is offered, or, before any check, everything
    // is offered and checked when a job first starts the engine.
    const wakeUrl = process.env.COMFYUI_WAKE_URL;
    const asleep = !reported.reachable && Boolean(wakeUrl);
    const provider = asleep ? { ...reported, asleep: true, message: "Asleep · wakes on first use (up to a minute)" } : reported;
    const checked = await Promise.all(capabilities.map(async (capability) => {
      if (asleep) return !this.lastAvailable.size || this.lastAvailable.has(capability.capability) ? { ...capability, capabilityAvailable: true, reason: "ComfyUI is asleep and wakes on first use" } : { ...capability, capabilityAvailable: false, reason: "ComfyUI is asleep" };
      if (!provider.reachable) return { ...capability, capabilityAvailable: false, reason: `ComfyUI offline at ${provider.url}: ${provider.message}` };
      if (!capability.capabilityAvailable) return capability;
      try {
        const workflow = await this.registry.require(capability.capability);
        const dependencies = await this.provider.inspectDependencies(workflow);
        return dependencies.available ? capability : { ...capability, capabilityAvailable: false, reason: formatDependencyFailure(dependencies) };
      } catch (error: unknown) { return { ...capability, capabilityAvailable: false, reason: error instanceof Error ? error.message : "Dependency inspection failed" }; }
    }));
    if (reported.reachable) { this.lastAvailable.clear(); for (const item of checked) if (item.capabilityAvailable) this.lastAvailable.add(item.capability); }
    // A character can be made with any ready generation profile, even when the plain checkpoint workflow is not set up.
    // While the engine sleeps (and can be woken), a profile that cannot be checked is still offered: generating wakes the
    // engine and checks it then. A sleeping Studio is not an error to show a newcomer.
    const sleeping = !reported.reachable && Boolean(wakeUrl);
    const profilesReady = await this.profileStatus().then((items) => items.some((item) => item.available) || (sleeping && items.length > 0), () => false);
    return {
      provider, capabilities: checked,
      providers: [
        { provider: "comfyui", label: "ComfyUI — Mac Studio", local: true, connected: provider.reachable, mode: provider.reachable ? "direct" : "unavailable", characterGeneration: { available: profilesReady || checked.some((item) => item.capability === "CHARACTER_GENERATION" && item.capabilityAvailable), reason: provider.reachable ? undefined : sleeping ? "Asleep · wakes on first use (up to a minute)" : provider.message }, characterVariant: { available: checked.some((item) => item.capability === "CHARACTER_VARIANT" && item.capabilityAvailable) }, metadataCapture: { available: provider.reachable, level: provider.reachable ? "full" : "unavailable" }, watchedFolder: { available: false, reason: "ComfyUI uses its trusted workflow API" }, models: [], message: sleeping ? "The Mac Studio is asleep; it wakes when you generate (up to a minute)" : provider.message },
        ...generationProviders,
      ],
      conservativeDefaults: { candidateCount: 3, maximumCandidateCount: 4, candidateConcurrency: 1, maximumProposalRounds: 2 },
    };
  }

  /**
   * Every generation profile with what it needs and whether the engine has it. While the engine sleeps, a profile that
   * was ready at the last check is still offered (the first use wakes it).
   */
  private lastProfileReady = new Map<string, boolean>();
  async profileStatus(): Promise<readonly ProfileStatus[]> {
    const profiles = await listProfiles();
    const engine = await this.provider.status();
    return Promise.all(profiles.map(async ({ profile, source }) => {
      const requirements = profileRequirements(profile);
      const sleeping = !engine.reachable && Boolean(process.env.COMFYUI_WAKE_URL);
      let available = this.lastProfileReady.get(profile.id) ?? sleeping; let missing: readonly string[] = [];
      let reason = engine.reachable ? undefined : sleeping ? "The Studio is asleep; this is checked when it wakes" : "ComfyUI is offline";
      if (engine.reachable) {
        try {
          const dependencies = await this.provider.inspectDependencies(profileWorkflow(profile, "CHARACTER_GENERATION"));
          available = dependencies.available; missing = [...dependencies.missingNodeClasses.map((name) => `node ${name}`), ...dependencies.missingModels];
          reason = available ? undefined : `Missing on the engine: ${missing.join(", ")}`;
        } catch (error: unknown) { available = false; reason = error instanceof Error ? error.message : "Could not check the engine"; }
        this.lastProfileReady.set(profile.id, available);
      }
      const guidance = PROFILE_GUIDANCE[profile.id];
      return {
        id: profile.id, label: profile.label, source, available, ...(reason ? { reason } : {}), missing,
        recommended: profile.id === DEFAULT_PROFILE_ID, ...(guidance ? { benchRank: guidance.rank, benchSummary: guidance.summary, benchSeconds: guidance.seconds } : {}),
        bestFor: typeof profile.hints?.best_for === "string" ? profile.hints.best_for : undefined, speed: typeof profile.hints?.speed === "string" ? profile.hints.speed : undefined,
        params: tunableParams(profile), requires: requirements.files, nodeClasses: requirements.nodeClasses,
      } satisfies ProfileStatus;
    }));
  }

  /**
   * The image with its background removed, as an RGBA PNG: by the cut-out profile (RMBG-2.0, the sprite benchmark's
   * winner) when the engine has its model, otherwise by flooding the plain background the profiles are asked to draw on.
   */
  private async cutout<T extends { readonly bytes: Uint8Array; readonly mimeType: string }>(image: T, name: string): Promise<T> {
    const local = (): T => {
      if (image.mimeType !== "image/png") throw new Error("only PNG candidates can be cut out locally");
      const result = removePlainBackground(image.bytes);
      if (!result.removed) throw new Error("the background is not one plain colour");
      return { ...image, bytes: result.bytes, mimeType: "image/png" };
    };
    if (!this.provider.uploadImage) return local();
    const { profile } = await findProfile(CUTOUT_PROFILE_ID).catch(() => ({ profile: null }));
    if (!profile) return local();
    const dependencies = await this.provider.inspectDependencies(profileWorkflow(profile, "BACKGROUND_REMOVAL"));
    if (!dependencies.available) return local();
    const uploaded = await this.provider.uploadImage(`rigging-cutout-${name}.png`, image.bytes, image.mimeType === "image/jpeg" ? "image/jpeg" : "image/png");
    const submitted = await this.provider.submit(bindProfile(profile, { image: uploaded }));
    const result = await this.provider.waitForCompletion(submitted.promptId, profile.output.node);
    const output = result.outputs[0];
    if (!output || output.mimeType !== "image/png") throw new Error("the cut-out returned no PNG");
    return { ...image, ...output };
  }

  async generateCandidates(request: GenerateImageCandidatesRequest): Promise<ImageProposal> {
    const capability = OPERATION_CAPABILITY[request.operation];
    if (!capability) throw new Error(`Unsupported trusted image operation ${request.operation}`);
    if (request.provider && request.provider !== "comfyui") return this.generateWithCharacterProvider(request, capability);
    return this.studio.run(`${capability} for ${request.projectId}`, () => this.generateOnStudio(request, capability), request.onStudioWait);
  }

  private async generateOnStudio(request: GenerateImageCandidatesRequest, capability: ImageProductionCapability): Promise<ImageProposal> {
    const profile = request.profileId && (capability === "CHARACTER_GENERATION" || capability === "CHARACTER_VARIANT") ? (await findProfile(request.profileId)).profile : null;
    const workflow = profile ? profileWorkflow(profile, capability) : await this.registry.require(capability);
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
        candidateCount, preset: request.preset ?? "MODULAR_2D_RIG_CHARACTER",
        width: profile ? Number(coerceParam(profile.params.width ?? { type: "int", targets: [["", ""]], default: 1024 }, request.profileParams?.width) ?? 1024) : request.width ?? 768,
        height: profile ? Number(coerceParam(profile.params.height ?? { type: "int", targets: [["", ""]], default: 1024 }, request.profileParams?.height) ?? 1024) : request.height ?? 768,
        ...(profile ? { profileId: profile.id, profileParams: { ...request.profileParams } } : {}),
        steps: request.steps ?? 24, guidance: request.guidance ?? 7, stylePreset: "chibi-pixel-art", candidateConcurrency: 1,
      },
      ...(request.targetPartId ? { targetPartId: request.targetPartId } : {}), ...(request.parentProposalId ? { parentProposalId: request.parentProposalId } : {}),
      proposalRound: (parent?.proposalRound ?? 0) + 1, candidateIds: [], candidates: [], warnings: [], errors: [], inspectionEvidence: [],
      progress: { phase: "queued", candidateIndex: 0, candidateCount, message: `ComfyUI · queued 0 of ${candidateCount}` },
    };
    await this.storage.create(proposal);
    request.onProposalCreated?.(proposalId);

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
        const bound = profile ? bindProfile(profile, { ...request.profileParams, prompt: profilePrompt(prompt), seed }) : bindTrustedWorkflow(workflow, values);
        const submitted = await this.provider.submit(bound); this.activePromptIds.set(proposalId, submitted.promptId);
        let progressQueue = Promise.resolve();
        const result = await this.provider.waitForCompletion(submitted.promptId, workflow.manifest.outputs.images.nodeId, (progress) => {
          progressQueue = progressQueue.then(async () => { proposal = await this.progress(proposal, this.mapProgress(progress, index + 1, candidateCount)); }).catch(() => undefined);
        });
        await progressQueue;
        const generated = result.outputs[0];
        if (!generated) throw new Error("ComfyUI returned no candidate image");
        // A profile draws on a plain background; cut the character out so the rest of the pipeline sees its silhouette.
        const cut = profile ? await this.cutout(generated, `${proposalId}-${index + 1}`).catch((error: unknown) => { proposal = { ...proposal, warnings: [...proposal.warnings, `Candidate ${index + 1}: background not removed (${error instanceof Error ? error.message : "cut-out failed"})`] }; return generated; }) : generated;
        // A pixel-art profile draws blocks that sit on no exact grid; snap them to their true pixels so the character is real
        // pixel art (one colour per pixel, a limited palette) and the rig can move it in whole pixels.
        const pixels = profile && /pixel/i.test(profile.id) ? truePixels(cut) : null;
        const output = pixels ? { ...cut, bytes: pixels.bytes } : cut;
        const candidateId = `candidate-${String(index + 1).padStart(2, "0")}`;
        const asset = await this.storage.writeCandidate(proposalId, candidateId, output.bytes, output.mimeType);
        let candidate: ImageCandidate = {
          candidateId, imageAssetId: asset.imageAssetId, imageFileName: asset.imageFileName, width: asset.width, height: asset.height, seed,
          providerMetadata: { promptId: result.promptId, providerFilename: output.providerAsset.filename, providerSubfolder: output.providerAsset.subfolder, workflowId: workflow.manifest.id, ...(profile ? { model: profile.label } : {}), ...(pixels ? { pixelScale: pixels.scale, nativeWidth: pixels.nativeWidth, nativeHeight: pixels.nativeHeight, paletteColours: pixels.colours } : {}) },
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

  private async generateWithCharacterProvider(request: GenerateImageCandidatesRequest, capability: ImageProductionCapability): Promise<ImageProposal> {
    if (capability !== "CHARACTER_GENERATION" && capability !== "CHARACTER_VARIANT" && capability !== "EQUIPMENT_VARIANT") throw new Error(`${request.provider} is a character-creation provider; ${capability} remains a trusted ComfyUI workflow`);
    const provider = this.generationProviders.get(request.provider!);
    if (!provider) throw new Error(`Image provider ${request.provider} is not registered`);
    const capabilities = await provider.getCapabilities();
    const variant = capability === "CHARACTER_VARIANT" || capability === "EQUIPMENT_VARIANT";
    const readiness = variant ? capabilities.characterVariant : capabilities.characterGeneration;
    if (!readiness.available) throw new Error(`${capabilities.label} is unavailable: ${readiness.reason ?? capabilities.message}`);
    const candidateCount = request.candidateCount ?? 1;
    if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 4) throw new Error("Candidate count must be between 1 and 4");
    const parent = request.parentProposalId ? await this.storage.readProposal(request.parentProposalId) : undefined;
    if (parent && parent.projectId !== request.projectId) throw new Error("Parent proposal belongs to another project");
    if (parent && parent.proposalRound >= 2) throw new Error("The maximum of 2 image proposal rounds has been reached");
    const built = buildCharacterGenerationPrompt({ description: request.prompt, controls: DEFAULT_CONTROLS });
    const prompt = built.prompt;
    const negativePrompt = request.negativePrompt ?? built.negativePrompt;
    const proposalId = `proposal-${crypto.randomUUID()}`;
    const timestamp = this.now().toISOString();
    const approvalPolicy = this.policies.get(request.projectId) ?? await this.storage.readApprovalPolicy(request.projectId);
    this.policies.set(request.projectId, approvalPolicy);
    let proposal: ImageProposal = {
      proposalVersion: 1, proposalId, projectId: request.projectId, operationType: capability, provider: provider.id,
      workflowId: capabilities.mode === "direct" ? "draw-things-http-v1" : "draw-things-watched-folder-v1",
      status: "generating", approvalPolicy, createdAt: timestamp, updatedAt: timestamp, sourcePrompt: prompt, negativePrompt,
      generationParameters: {
        candidateCount, preset: request.preset ?? "MODULAR_2D_RIG_CHARACTER", rigFriendlyCharacter: true,
        width: request.width ?? 768, height: request.height ?? 768, steps: request.steps ?? 24, guidance: request.guidance ?? 7,
        model: request.model ?? null, styleReferenceAssetId: request.styleReferenceAssetId ?? null, poseReferenceAssetId: request.poseReferenceAssetId ?? null,
        providerMode: capabilities.mode, generationIntent: capability === "EQUIPMENT_VARIANT" ? "equipment_variant" : variant ? "character_variant" : "character",
        ...(request.metadata ?? {}),
      },
      ...(request.parentProposalId ? { parentProposalId: request.parentProposalId } : {}), proposalRound: (parent?.proposalRound ?? 0) + 1,
      candidateIds: [], candidates: [], warnings: [], errors: [], inspectionEvidence: [],
      progress: { phase: "queued", candidateIndex: 0, candidateCount, message: `${capabilities.label} · ${capabilities.mode === "direct" ? "queued" : "waiting for stable exports"}` },
    };
    await this.storage.create(proposal);
    request.onProposalCreated?.(proposalId);
    const controller = new AbortController(); this.activeGenerationControllers.set(proposalId, controller);
    try {
      proposal = await this.progress(proposal, { phase: "sampling", candidateIndex: 0, candidateCount, message: capabilities.mode === "direct" ? "Draw Things is generating locally" : `Export ${candidateCount} new image${candidateCount === 1 ? "" : "s"} from Draw Things` });
      const input = {
        projectId: request.projectId, prompt, negativePrompt, width: request.width ?? 768, height: request.height ?? 768,
        model: request.model, seed: request.seed ?? null, steps: request.steps ?? 24, guidance: request.guidance ?? 7, candidateCount,
        styleReferenceAssetId: request.styleReferenceAssetId, poseReferenceAssetId: request.poseReferenceAssetId,
        generationIntent: capability === "EQUIPMENT_VARIANT" ? "equipment_variant" as const : variant ? "character_variant" as const : "character" as const,
        metadata: request.metadata,
      };
      const outputs = variant && provider.generateVariant ? await provider.generateVariant(input, controller.signal) : await provider.generateCharacter(input, controller.signal);
      const candidates: ImageCandidate[] = [];
      for (const [index, output] of outputs.slice(0, candidateCount).entries()) {
        const candidateId = `candidate-${String(index + 1).padStart(2, "0")}`;
        const asset = await this.storage.writeCandidate(proposalId, candidateId, output.bytes, output.mimeType);
        const candidate: ImageCandidate = { candidateId, imageAssetId: asset.imageAssetId, imageFileName: asset.imageFileName, width: asset.width, height: asset.height, seed: output.seed, providerMetadata: output.metadata, diagnostics: { warnings: [] }, status: "generated" };
        candidates.push(candidate);
        if (provider instanceof DrawThingsProvider && typeof output.metadata.contentHash === "string" && output.sourcePath) await provider.recordImport(output.metadata.contentHash, output.sourcePath, proposalId);
        proposal = { ...proposal, candidates: [...candidates], candidateIds: candidates.map((item) => item.candidateId), updatedAt: this.now().toISOString(), progress: { phase: "collecting", candidateIndex: candidates.length, candidateCount, percent: Math.round(candidates.length / candidateCount * 100), message: `Collected candidate ${candidates.length} of ${candidateCount}` } };
        await this.storage.writeProposal(proposal);
      }
      proposal = { ...proposal, status: candidates.length ? "awaiting_review" : "failed", candidates, candidateIds: candidates.map((item) => item.candidateId), updatedAt: this.now().toISOString(), progress: candidates.length ? { phase: "ready", candidateIndex: candidates.length, candidateCount, percent: 100, message: `${candidates.length} Draw Things candidate${candidates.length === 1 ? "" : "s"} ready for review` } : { phase: "failed", candidateIndex: 0, candidateCount, message: "Draw Things produced no usable candidates" } };
      await this.storage.writeProposal(proposal); return proposal;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Draw Things generation failed";
      proposal = { ...proposal, status: "failed", errors: [...proposal.errors, errorMessage], updatedAt: this.now().toISOString(), progress: { phase: "failed", candidateIndex: proposal.candidates.length, candidateCount, message: errorMessage } };
      await this.storage.writeProposal(proposal); return proposal;
    } finally { this.activeGenerationControllers.delete(proposalId); }
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
      projectId: parent.projectId, provider: parent.provider, operation: operationName(parent.operationType), prompt: amendedPrompt ?? parent.sourcePrompt,
      candidateCount: numberParameter(parent, "candidateCount", 3), width: numberParameter(parent, "width", 768), height: numberParameter(parent, "height", 768),
      steps: numberParameter(parent, "steps", 24), guidance: numberParameter(parent, "guidance", 7), model: stringParameter(parent, "model"), targetPartId: parent.targetPartId, parentProposalId: parent.proposalId,
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
    const controller = this.activeGenerationControllers.get(proposalId);
    if (controller) { controller.abort(new Error("Draw Things generation was cancelled")); return true; }
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
function stringParameter(proposal: ImageProposal, key: string): string | undefined { const value = proposal.generationParameters[key]; return typeof value === "string" ? value : undefined; }
