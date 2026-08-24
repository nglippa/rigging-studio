import { buildCharacterGenerationPrompt } from "../../character-generation/prompt/characterPromptBuilder";
import type { CharacterPromptControls } from "../../character-generation/prompt/generationPreset";
import { detectOcclusionReviews } from "../../character-generation/occlusion/occlusionRepair";
import { createGeneratedCharacterProject, parseGeneratedCharacterProject, serializeGeneratedCharacterProject, type GeneratedCharacterProject } from "../../character-generation/project/generatedCharacterProject";
import { getGeneratedCharacterStorage } from "../../character-generation/project/generatedCharacterStorage";
import { HttpCharacterPipelineProvider } from "../../character-generation/providers/httpCharacterPipelineProvider";
import { MockCharacterPipelineProvider } from "../../character-generation/providers/mockCharacterPipelineProvider";
import type { CharacterImageGenerationResult, CharacterPipelineProvider, OcclusionReconstructionResult } from "../../character-generation/providers/characterPipelineProvider";
import { buildRigProposal } from "../../character-generation/rigging/rigProposalBuilder";
import type { RigProposal } from "../../character-generation/rigging/rigProposalSchema";
import { validateRigProposal } from "../../character-generation/rigging/rigProposalValidator";
import { validateSegmentationResponse } from "../../character-generation/segmentation/segmentationValidator";
import { runRigSmokeTest } from "../../character-generation/testing/rigSmokeTest";
import { buildAnimationGenerationContext } from "../../rigging/ai/animationContextBuilder";
import { MockAnimationGenerationProvider } from "../../rigging/ai/mockAnimationGenerationProvider";
import { validateAnimationProposal } from "../../rigging/ai/animationProposalValidator";
import { DiagnosticFrameRenderer } from "../../rigging/ai-vision/diagnosticFrameRenderer";
import { createDiagnosticCapturePlan } from "../../rigging/ai-vision/diagnosticCapturePlan";
import { safeParseAnimationDefinition, safeParseRigDefinition } from "../../rigging/schema/parsing";
import type { AnimatedProperty, Easing, JsonValue, RigDefinition } from "../../rigging/schema/types";
import { validateRigDefinition } from "../../rigging/validation/rig";
import { blockingRigProjectProblems, validateRigProject } from "../../rigging/validation/project";
import { assignSkinAttachment, updateBone, updateSlot } from "../../tools/rig-editor/document";
import { addAnimation, animationById, createAnimationLibrary, deleteAnimation, parseAnimationLibraryJson, replaceAnimation, uniqueAnimationId } from "../../tools/rig-editor/animation/library";
import { removeKeyframes, upsertKeyframe } from "../../tools/rig-editor/animation/operations";
import type { AnimationLibrary } from "../../tools/rig-editor/animation/types";
import { StudioEventBus, type StudioEvent, type StudioEventType } from "../events/StudioEventBus";
import { StudioQueryService } from "../queries/StudioQueryService";
import { animationListSummary, animationSummary, projectSummary, rigSummary } from "../queries/summaries";
import { StudioSession } from "../session/StudioSession";
import { parseToolInput, type StudioToolName } from "../validation/toolSchemas";
import { managedGenerationIngressSchema, type ManagedGenerationIngress } from "../validation/managedGenerationIngress";
import type { AnimationEditorAdapter, CharacterProjectAdapter, RigEditorAdapter } from "./adapters";
import type { CommandResult } from "./results";
import { LOCAL_PROJECT_STORAGE_VERSION, type LocalProjectSnapshot } from "../../project-storage/types";
import { canonicalProjectStateDigest } from "../../project-storage/digest";
import { ProjectLifecycleCoordinator, type DurableSaveRequest, type ProjectOperationContext, type ProjectSwitchTransaction } from "../../project-storage/projectLifecycle";
import { extractPartToDataUrl } from "../../character-generation/segmentation/partImageProcessor";
import type { CharacterSegmentationResponse, Point, Rect, SegmentationMask } from "../../character-generation/segmentation/segmentationSchema";
import {
  SEMANTIC_TAXONOMY, acceptProposal as acceptPartCutProposal, anatomicalGuidePrompt, analyzeCoverage, assignOwnershipSelection, buildAnatomicalPartitionGuide, constrainProviderMaskToZone, createPartCutterState, deriveRiggingExtraction, ensureOwnershipPartition, evaluateRotationTest, guidedProposalFromSegmentation, mergeParts as mergePartCuts,
  partCutToSegmentation, proposalToSegmentation, rejectProposal as rejectPartCutProposal, renderProposalSvg,
  recordOwnershipRelabel, reshapeRegionEdge, splitPart as splitPartCut, validateReconstructionAsset, type PartCutterState, type PartSemanticType, type RegionEdge,
} from "../../part-cutter";
import { OllamaProvider, type IntelligenceProvider } from "../../intelligence";

type JsonObject = Readonly<Record<string, unknown>>;
const isJsonObject = (value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> => Boolean(value && typeof value === "object" && !Array.isArray(value));
type LatestPreview = {
  readonly renderId: string;
  readonly animationId: string;
  readonly mimeType: "image/png";
  readonly imageBase64: string;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly frameTimes: readonly number[];
  readonly warnings: readonly string[];
  readonly diagnostics: readonly string[];
};
type PendingAnimationCommand = { readonly label: string; readonly library: AnimationLibrary };
type ProjectActivationSource = "none" | "startup" | "draft" | "explicit";
export type RiggingCommandServiceOptions = { readonly characterProvider?: CharacterPipelineProvider; readonly intelligenceProvider?: IntelligenceProvider };

const DEFAULT_CONTROLS: CharacterPromptControls = {
  style: "chibi-pixel-art", bodyProportions: "oversized head, compact torso, short separated limbs", viewDirection: "right",
  mainHandEquipment: "weapon", offHandEquipment: "shield", hair: "readable modular hair", headwear: "optional modular headwear",
  characterScale: "medium", artResolution: "512", background: "transparent",
};
const now = (): string => new Date().toISOString();
const updatedProject = (project: GeneratedCharacterProject, patch: Partial<GeneratedCharacterProject>): GeneratedCharacterProject => ({ ...project, ...patch, updatedAt: now() });
const warningObjects = (warnings: readonly string[]) => warnings.map((message) => ({ code: "studio_warning", message }));
const asObject = (input: unknown): JsonObject => input as JsonObject;
const asString = (input: unknown): string => input as string;
const asOptionalString = (input: unknown): string | undefined => input as string | undefined;
const asNumber = (input: unknown): number => input as number;
const asBoolean = (input: unknown): boolean => input as boolean;
const polygonMask = (points: readonly Point[], canvas: { readonly width: number; readonly height: number }): { readonly bounds: Rect; readonly mask: SegmentationMask } => {
  const left = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x)))); const top = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y)))); const right = Math.min(canvas.width, Math.ceil(Math.max(...points.map((point) => point.x)))); const bottom = Math.min(canvas.height, Math.ceil(Math.max(...points.map((point) => point.y))));
  const width = Math.max(1, right - left); const height = Math.max(1, bottom - top);
  const inside = (x: number, y: number): boolean => { let result = false; for (let index = 0, prior = points.length - 1; index < points.length; prior = index++) { const a = points[index]; const b = points[prior]; if (((a.y > y) !== (b.y > y)) && x < (b.x - a.x) * (y - a.y) / Math.max(.000001, b.y - a.y) + a.x) result = !result; } return result; };
  return { bounds: { x: left, y: top, width, height }, mask: { width, height, alpha: Array.from({ length: width * height }, (_, index) => inside(left + index % width + .5, top + Math.floor(index / width) + .5) ? 255 : 0) } };
};
const blobBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};
const loadBrowserImage = async (source: string): Promise<HTMLImageElement> => {
  if (typeof Image === "undefined") throw new Error("Visual reconstruction review requires the running browser workspace");
  const image = new Image();
  if (!source.startsWith("data:")) image.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Reconstruction review image could not be decoded"));
    image.src = source;
  });
  if (typeof image.decode === "function") await image.decode().catch(() => undefined);
  return image;
};
const browserImagePixels = async (source: string): Promise<{ readonly width: number; readonly height: number; readonly alpha: readonly number[] }> => {
  const image = await loadBrowserImage(source);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Reconstruction review canvas is unavailable");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const alpha = new Array<number>(canvas.width * canvas.height);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = rgba[index * 4 + 3] ?? 0;
  return { width: canvas.width, height: canvas.height, alpha };
};
const drawContained = (
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
  options: { readonly crop?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } } = {},
): void => {
  const crop = options.crop;
  const sourceWidth = crop?.width ?? (image as HTMLImageElement).naturalWidth ?? (image as HTMLImageElement).width;
  const sourceHeight = crop?.height ?? (image as HTMLImageElement).naturalHeight ?? (image as HTMLImageElement).height;
  const scale = Math.min(width / Math.max(1, sourceWidth), height / Math.max(1, sourceHeight));
  const targetWidth = sourceWidth * scale; const targetHeight = sourceHeight * scale;
  const targetX = x + (width - targetWidth) / 2; const targetY = y + (height - targetHeight) / 2;
  if (crop) context.drawImage(image, crop.x, crop.y, crop.width, crop.height, targetX, targetY, targetWidth, targetHeight);
  else context.drawImage(image, targetX, targetY, targetWidth, targetHeight);
};

export class RiggingCommandService {
  readonly events = new StudioEventBus();
  readonly session = new StudioSession();
  readonly queries: StudioQueryService;
  private project: GeneratedCharacterProject | null = null;
  private standaloneRig: RigDefinition | null = null;
  private animations: AnimationLibrary | null = null;
  private rigAdapter: RigEditorAdapter | null = null;
  private animationAdapter: AnimationEditorAdapter | null = null;
  private projectAdapter: CharacterProjectAdapter | null = null;
  private pendingRigProposal: RigProposal | null = null;
  private latestPreview: LatestPreview | null = null;
  private activeSkinId: string | null = null;
  private transactionId: string | null = null;
  private pendingAnimationCommands: PendingAnimationCommand[] = [];
  private operationSequence = 0;
  private readonly characterProvider: CharacterPipelineProvider;
  private intelligenceProvider: IntelligenceProvider;
  private readonly animationProvider = new MockAnimationGenerationProvider();
  private activationVersion = 0;
  private activationSource: ProjectActivationSource = "none";
  private readonly durableListeners = new Set<() => void>();
  private durableProjectId: string | null = null;
  private readonly projectLifecycle = new ProjectLifecycleCoordinator({ digest: (snapshot) => canonicalProjectStateDigest(snapshot) });

  constructor(options: RiggingCommandServiceOptions = {}) {
    const endpoint = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_CHARACTER_PIPELINE_ENDPOINT : undefined;
    this.characterProvider = options.characterProvider ?? (endpoint ? new HttpCharacterPipelineProvider(endpoint) : new MockCharacterPipelineProvider());
    this.intelligenceProvider = options.intelligenceProvider ?? new OllamaProvider();
    this.queries = new StudioQueryService(() => ({
      session: this.session.snapshot,
      project: this.project,
      rig: this.standaloneRig,
      animations: this.animations,
      activeSkinId: this.activeSkinId,
      liveUi: Boolean(this.rigAdapter || this.projectAdapter),
      previewAvailable: typeof document !== "undefined",
    }));
    this.events.subscribe((event) => this.session.record(event));
  }

  setIntelligenceProvider(provider: IntelligenceProvider): void { this.intelligenceProvider = provider; }

  attachRigEditor(adapter: RigEditorAdapter): () => void {
    this.rigAdapter = adapter;
    this.syncRigFromUi(adapter.getRig());
    return () => { if (this.rigAdapter === adapter) this.rigAdapter = null; };
  }

  attachAnimationEditor(adapter: AnimationEditorAdapter): () => void {
    this.animationAdapter = adapter;
    if (this.pendingAnimationCommands.length) {
      const rigId = adapter.getLibrary().rigId;
      const pending = this.pendingAnimationCommands.map((command) => ({ ...command, library: { ...command.library, rigId } }));
      this.pendingAnimationCommands = [];
      this.animations = pending.reduce((current, command) => adapter.replace ? adapter.replace(command.library) : adapter.execute(command.label, () => command.library), adapter.getLibrary());
      const selected = this.session.snapshot.selectedAnimationId;
      if (selected && this.animations.animations.some((animation) => animation.id === selected)) adapter.setActiveAnimation(selected);
    } else {
      this.pendingAnimationCommands = [];
      this.animations = adapter.getLibrary();
      this.session.update({ selectedAnimationId: adapter.getActiveAnimationId() });
    }
    return () => { if (this.animationAdapter === adapter) this.animationAdapter = null; };
  }

  syncAnimationsFromUi(library: AnimationLibrary, selectedAnimationId: string | null): void {
    this.projectLifecycle.assertMutationsAllowed();
    let rig: RigDefinition | null = null; try { rig = this.requireRig(); } catch { rig = null; }
    const normalized = rig && library.rigId !== rig.id ? { ...library, rigId: rig.id } : library;
    if (rig) normalized.animations.forEach((animation) => { const result = safeParseAnimationDefinition(animation, rig!); if (!result.success) throw new Error(result.message); });
    this.animations = structuredClone(normalized);
    this.pendingAnimationCommands = [];
    this.session.update({ selectedAnimationId });
    if (this.projectLifecycle.snapshot.activeProjectId) this.projectLifecycle.recordMutation(this.projectLifecycle.snapshot.activeProjectId);
    this.notifyDurableListeners();
  }

  attachCharacterProject(adapter: CharacterProjectAdapter): () => void {
    this.projectAdapter = adapter;
    if (this.project) adapter.replaceProject(this.project);
    else this.syncProjectFromUi(adapter.getProject(), "startup");
    return () => { if (this.projectAdapter === adapter) this.projectAdapter = null; };
  }

  syncRigFromUi(rig: RigDefinition, actor = "Human"): void {
    this.projectLifecycle.assertMutationsAllowed();
    this.standaloneRig = structuredClone(rig);
    this.activeSkinId ??= rig.defaultSkinId;
    const issues = validateRigDefinition(rig);
    this.session.update({
      activeProjectId: this.project?.id ?? `editor:${rig.id}`, activeStage: this.project?.stage ?? "edit", selectedRigId: rig.id,
      dirtyState: true, validationState: { valid: issues.length === 0, errorCount: issues.length, checkedAt: now() },
    });
    if (actor !== "Human") this.emit("rig.changed", actor, `Changed rig ${rig.id}`, rig.id);
    if (this.projectLifecycle.snapshot.activeProjectId && !this.projectLifecycle.snapshot.switching) this.projectLifecycle.recordMutation(this.projectLifecycle.snapshot.activeProjectId);
    this.notifyDurableListeners();
  }

  syncProjectFromUi(project: GeneratedCharacterProject, source: "startup" | "mutation" = "mutation"): boolean {
    if (this.projectLifecycle.snapshot.switching) {
      if (this.project) this.projectAdapter?.replaceProject(this.project);
      return false;
    }
    if (this.project && project.id !== this.project.id && this.activationSource === "explicit") {
      this.projectAdapter?.replaceProject(this.project);
      return false;
    }
    this.project = structuredClone(project);
    if (this.activationSource === "none") this.activationSource = source === "startup" ? "startup" : "explicit";
    if (!this.projectLifecycle.snapshot.activeProjectId) this.projectLifecycle.activateInitial(project.id, null, project.stage);
    else this.projectLifecycle.setRequestedStage(project.stage);
    if (project.rigDefinition) this.standaloneRig = structuredClone(project.rigDefinition);
    this.session.update({ activeProjectId: project.id, activeStage: project.stage, selectedRigId: project.rigDefinition?.id ?? null, dirtyState: true, warnings: project.warnings });
    this.notifyDurableListeners();
    return true;
  }

  subscribeDurableSnapshot(listener: () => void): () => void { this.durableListeners.add(listener); return () => this.durableListeners.delete(listener); }
  subscribeProjectLifecycle(listener: () => void): () => void { return this.projectLifecycle.subscribe(listener); }
  getProjectLifecycleSnapshot() { return this.projectLifecycle.snapshot; }
  getProjectLifecycleTrace() { return this.projectLifecycle.getTrace(); }
  captureProjectOperation(operation: string): ProjectOperationContext { return this.projectLifecycle.capture(operation); }
  isProjectOperationCurrent(context: ProjectOperationContext): boolean { return this.projectLifecycle.isCurrent(context); }
  isCurrentHydration(projectId: string | null, projectSessionToken: string, hydrationToken: string): boolean { return this.projectLifecycle.isCurrentHydration(projectId, projectSessionToken, hydrationToken); }
  assertProjectOperationCurrent(context: ProjectOperationContext, componentSource?: string): void { this.projectLifecycle.assertCurrent(context, componentSource); }
  beginDurableProjectOpen(projectId: string, storagePath: string | null = null, requestedStage: string | null = null): ProjectSwitchTransaction { return this.projectLifecycle.beginSwitch(projectId, storagePath, requestedStage); }
  abortDurableProjectOpen(transaction: ProjectSwitchTransaction): void { this.projectLifecycle.abortSwitch(transaction); }
  createDurableSaveRequest(operation: "save" | "autosave" = "save"): DurableSaveRequest {
    const snapshot = this.getDurableSnapshot();
    return this.projectLifecycle.beginSave(snapshot, operation);
  }
  completeDurableSave(request: DurableSaveRequest, projectId: string): boolean {
    if (!projectId.trim()) throw new Error("A managed project ID is required");
    if (!this.projectLifecycle.completeSave(request, projectId)) return false;
    this.durableProjectId = projectId; this.session.update({ dirtyState: false }); return true;
  }
  markDurableProjectSaved(projectId: string): void {
    if (!projectId.trim()) throw new Error("A managed project ID is required");
    this.durableProjectId = projectId;
    if (!this.projectLifecycle.snapshot.activeProjectId) this.projectLifecycle.activateInitial(projectId, null, this.project?.stage ?? null);
    this.session.update({ dirtyState: false });
  }
  getDurableSnapshot(): LocalProjectSnapshot {
    let rig: RigDefinition | null = null; try { rig = this.requireRig(); } catch { rig = null; }
    const animations = rig ? this.animationAdapter?.getLibrary() ?? this.animations : null; if (!this.project && !rig) throw new Error("No active project or rig is ready to save");
    const snapshot = { storageVersion: LOCAL_PROJECT_STORAGE_VERSION, localProjectId: this.durableProjectId, project: this.project ? structuredClone(this.project) : null, rig: rig ? structuredClone(rig) : null, animations: animations ? structuredClone(animations) : null, selectedSkinId: this.activeSkinId } satisfies LocalProjectSnapshot;
    const problems = blockingRigProjectProblems(validateRigProject(snapshot));
    if (problems.length) throw new Error(`Project integrity validation failed: ${problems.map((problem) => problem.message).join("; ")}`);
    return snapshot;
  }
  installDurableSnapshot(snapshot: LocalProjectSnapshot, actor = "Human"): void {
    const targetProjectId = snapshot.localProjectId ?? snapshot.project?.id ?? `editor:${snapshot.rig?.id ?? "unknown"}`;
    const transaction = this.beginDurableProjectOpen(targetProjectId, null, snapshot.project?.stage ?? (snapshot.rig ? "edit" : null));
    if (!this.commitDurableProjectOpen(transaction, snapshot, actor)) throw new Error(`Stale project open for ${targetProjectId} was discarded`);
  }
  commitDurableProjectOpen(transaction: ProjectSwitchTransaction, snapshot: LocalProjectSnapshot, actor = "Human"): boolean {
    if (snapshot.storageVersion !== LOCAL_PROJECT_STORAGE_VERSION) throw new Error(`Unsupported project storage version ${String(snapshot.storageVersion)}`);
    const rigResult = snapshot.rig ? safeParseRigDefinition(snapshot.rig) : null; if (rigResult && !rigResult.success) throw new Error(rigResult.message);
    if (snapshot.animations && !rigResult?.success) throw new Error("Disk animations require a valid rig");
    const animationResult = snapshot.animations && rigResult?.success ? parseAnimationLibraryJson(JSON.stringify(snapshot.animations), rigResult.data) : null; if (animationResult && !animationResult.success) throw new Error(animationResult.message);
    const normalizedSnapshot: LocalProjectSnapshot = { ...snapshot, rig: rigResult?.success ? rigResult.data : null, animations: animationResult?.success ? animationResult.data : null };
    const integrityProblems = blockingRigProjectProblems(validateRigProject(normalizedSnapshot));
    if (integrityProblems.length) throw new Error(`Project integrity validation failed: ${integrityProblems.map((problem) => problem.message).join("; ")}`);
    const durableProjectId = snapshot.localProjectId ?? snapshot.project?.id ?? null;
    const projectResult = snapshot.project ? parseGeneratedCharacterProject(rigResult?.success ? { ...snapshot.project, rigDefinition: rigResult.data, skins: rigResult.data.skins } : snapshot.project) : null;
    if (projectResult && !projectResult.success) throw new Error(projectResult.message);
    if (!this.projectLifecycle.commitSwitch(transaction)) return false;
    this.transactionId = null;
    this.pendingRigProposal = null;
    this.latestPreview = null;
    if (projectResult?.success) this.setProject(projectResult.data, true, true);
    else { this.project = null; this.activationVersion += 1; this.activationSource = "explicit"; }
    this.durableProjectId = durableProjectId;
    if (!rigResult?.success) {
      // A project-only Prepare snapshot must replace the whole active document.
      // Retaining the previous editor rig here makes a disk reopen look complete
      // while Save immediately contaminates it with another project's rig.
      this.standaloneRig = null;
      this.animations = null;
      this.pendingAnimationCommands = [];
      this.activeSkinId = null;
      this.session.update({ activeProjectId: snapshot.project?.id ?? null, activeStage: snapshot.project?.stage ?? null, selectedRigId: null, selectedAnimationId: null, dirtyState: false });
      this.notifyDurableListeners();
      return true;
    }
    const installedRig = this.rigAdapter ? this.rigAdapter.replace ? this.rigAdapter.replace(rigResult.data) : this.rigAdapter.execute("Open disk project", () => rigResult.data) : rigResult.data;
    this.standaloneRig = structuredClone(installedRig);
    const installedAnimations = animationResult?.success ? this.animationAdapter ? this.animationAdapter.replace ? this.animationAdapter.replace(animationResult.data) : this.animationAdapter.execute("Open disk animations", () => animationResult.data) : animationResult.data : null;
    this.animations = installedAnimations ? structuredClone(installedAnimations) : null; this.pendingAnimationCommands = installedAnimations && !this.animationAdapter ? [{ label: "Open disk animations", library: structuredClone(installedAnimations) }] : [];
    this.activeSkinId = snapshot.selectedSkinId && installedRig.skins.some((skin) => skin.id === snapshot.selectedSkinId) ? snapshot.selectedSkinId : installedRig.defaultSkinId;
    this.session.update({ activeProjectId: snapshot.project?.id ?? `editor:${installedRig.id}`, activeStage: snapshot.project?.stage ?? "edit", selectedRigId: installedRig.id, selectedAnimationId: installedAnimations?.animations[0]?.id ?? null, dirtyState: false });
    this.emit("project.opened", actor, `Opened disk project ${snapshot.project?.name ?? installedRig.id}`, snapshot.project?.id ?? installedRig.id); this.notifyDurableListeners();
    return true;
  }

  activateProjectFromUi(project: GeneratedCharacterProject): void { this.setProject(project, true); }
  restoreProjectFromDraft(project: GeneratedCharacterProject): boolean {
    if (this.activationVersion > 0 || this.activationSource === "explicit") return false;
    this.activationSource = "draft";
    this.setProject(project, false);
    return true;
  }

  syncAnimationSelectionFromUi(animationId: string | null): void { this.session.update({ selectedAnimationId: animationId }); }
  syncBoneSelectionFromUi(boneId: string | null): void { this.session.update({ selectedBoneId: boneId }); }
  setBridgeConnected(connected: boolean): void {
    this.session.update(connected
      ? { bridgeConnected: true }
      : { bridgeConnected: false, mcpConnected: false, toolCount: 0, toolNames: [], resourcesAvailable: false });
  }
  setAgentCapabilities(toolNames: readonly string[], resourcesAvailable = false): void {
    const names = [...new Set(toolNames)].sort();
    this.session.update({
      bridgeConnected: true,
      mcpConnected: names.length > 0,
      toolCount: names.length,
      toolNames: names,
      resourcesAvailable,
      lastHandshake: now(),
      lastAgentError: null,
    });
  }
  setAgentConnectionError(message: string): void {
    this.session.update({ mcpConnected: false, toolCount: 0, toolNames: [], resourcesAvailable: false, lastAgentError: message });
  }
  recordExternalActivity(eventType: StudioEventType, actor: string, summary: string, entityId?: string): void { this.emit(eventType, actor, summary, entityId); }

  executeHumanRigMutation(label: string, transform: (rig: RigDefinition) => RigDefinition): RigDefinition {
    const next = this.mutateRig(label, transform, "Human");
    if (!next.success) throw new Error(next.errors.map((error) => error.message).join("; "));
    return this.requireRig();
  }

  executeHumanAnimationMutation(label: string, transform: (library: AnimationLibrary) => AnimationLibrary): AnimationLibrary {
    const result = this.mutateAnimations(label, transform, "Human");
    if (!result.success) throw new Error(result.errors.map((error) => error.message).join("; "));
    return this.requireAnimations();
  }

  undoRig(actor = "Human"): RigDefinition {
    if (!this.rigAdapter) throw new Error("The visual rig editor is not attached");
    const next = this.rigAdapter.undo();
    this.syncRigFromUi(next, actor);
    this.emit("rig.changed", actor, "Undid rig command", next.id);
    return next;
  }

  redoRig(actor = "Human"): RigDefinition {
    if (!this.rigAdapter) throw new Error("The visual rig editor is not attached");
    const next = this.rigAdapter.redo();
    this.syncRigFromUi(next, actor);
    this.emit("rig.changed", actor, "Redid rig command", next.id);
    return next;
  }

  async executeTool(name: StudioToolName, rawInput: unknown, actor = "Agent"): Promise<CommandResult<JsonObject>> {
    if (name === "character_import_generation") {
      const normalized = managedGenerationIngressSchema.safeParse(rawInput);
      if (normalized.success) {
        try {
          this.assertRequestedProject(normalized.data.projectId);
          return this.importManagedGeneration(normalized.data, actor);
        } catch (reason: unknown) {
          const message = reason instanceof Error ? reason.message : `${name} failed`;
          this.emit("warning.added", actor, message);
          return { success: false, warnings: [], errors: [{ code: "command_failed", message }] };
        }
      }
    }
    const parsed = parseToolInput(name, rawInput);
    if (!parsed.success) return { success: false, warnings: [], errors: parsed.errors.map((error) => ({ code: "invalid_tool_input", ...error })) };
    try {
      return await this.dispatch(name, asObject(parsed.data), actor);
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : `${name} failed`;
      this.emit("warning.added", actor, message);
      return { success: false, warnings: [], errors: [{ code: "command_failed", message }] };
    }
  }

  private async dispatch(name: StudioToolName, args: JsonObject, actor: string): Promise<CommandResult<JsonObject>> {
    this.assertRequestedProject(asOptionalString(args.projectId));
    switch (name) {
      case "studio_get_status": return this.ok(this.queries.getStudioStatus(asBoolean(args.includeActivity)));
      case "studio_get_agent_capabilities": return this.ok(this.queries.getAgentCapabilities(asBoolean(args.includeToolNames)));
      case "project_create": return this.createProject(asString(args.name), asString(args.prompt), actor);
      case "project_open": return args.snapshot ? this.openSnapshot(args.snapshot, actor) : this.openProject(args.project, actor);
      case "project_save": return this.saveProject(actor);
      case "project_export": return this.exportProject(asString(args.format), actor);
      case "project_save_as":
      case "project_export_snapshot":
      case "project_storage_status":
      case "project_list":
      case "project_import":
      case "project_reveal":
      case "project_archive": throw new Error("Durable project storage commands are handled by the trusted local storage service");
      case "character_set_prompt": return this.setCharacterPrompt(asString(args.prompt), actor);
      case "character_generate_image": return this.generateImage(asString(args.mode) as "generate" | "regenerate" | "variant", actor);
      case "character_import_generation": throw new Error("External generations must be normalized by the MCP managed-ingress service");
      case "character_get_generation": return this.getGeneration(asBoolean(args.includeHistory));
      case "character_accept_generation": return this.acceptGeneration(asString(args.generationId), actor);
      case "character_run_suitability_check": return this.runSuitability(actor);
      case "character_segment": return this.segmentCharacter(actor);
      case "character_get_parts": return this.getCharacterParts(asBoolean(args.includeFull));
      case "character_update_part": return this.updatePart(asString(args.partId), asObject(args.patch), actor);
      case "character_repair_occlusion": return this.repairOcclusion(asString(args.partId), actor);
      case "parts_get_status": return this.getPartCutterStatus(asBoolean(args.includeParts));
      case "parts_auto_cut": return this.createPartCutProposal(asString(args.instruction), actor);
      case "parts_prompt_cut": return this.promptPartCut(asString(args.instruction), asOptionalString(args.proposalId), actor);
      case "parts_install_ai_proposal": return this.installPartCutProposal(args.segmentation as CharacterSegmentationResponse, asString(args.instruction), asOptionalString(args.parentProposalId), actor);
      case "parts_get_proposal": return this.getPartCutProposal(asOptionalString(args.proposalId), asBoolean(args.includeMasks));
      case "parts_render_proposal": return this.renderPartCutProposal(asOptionalString(args.proposalId));
      case "parts_accept_proposal": return this.acceptPartCutProposal(asString(args.proposalId), args.partIds as readonly string[] | undefined, actor);
      case "parts_reject_proposal": return this.rejectPartCutProposal(asString(args.proposalId), actor);
      case "parts_update_semantic_type": return this.mutatePartCut(asString(args.partId), { semanticType: asString(args.semanticType) as PartSemanticType }, `Marked ${asString(args.partId)} as ${asString(args.semanticType)}`, actor);
      case "parts_merge": return this.mergePartCuts(args.partIds as readonly string[], asOptionalString(args.label), actor);
      case "parts_split": return this.splitPartCut(asString(args.partId), asString(args.axis) as "horizontal" | "vertical", actor);
      case "parts_set_mask": return this.setPartMask(asString(args.partId), args.mask as SegmentationMask, actor);
      case "parts_set_pivot": return this.mutatePartCut(asString(args.partId), { pivot: { x: asNumber(args.x), y: asNumber(args.y) } }, `Set ${asString(args.partId)} pivot`, actor);
      case "parts_set_z_order": return this.mutatePartCut(asString(args.partId), { zOrder: asNumber(args.zOrder), ...(args.layer ? { layer: asString(args.layer) as "front" | "body" | "back" } : {}) }, `Set ${asString(args.partId)} draw order`, actor);
      case "parts_mark_occluded": return this.mutatePartCut(asString(args.partId), { occlusionState: asString(args.state) as "complete" | "likely-incomplete" | "unknown" }, `Marked ${asString(args.partId)} ${asString(args.state)}`, actor);
      case "parts_reconstruct": return this.repairOcclusion(asString(args.partId), actor);
      case "part_install_reconstruction_proposal": return this.installReconstructionProposal(asString(args.partId), args.result as OcclusionReconstructionResult, actor);
      case "part_get_reconstruction_proposal": return this.getReconstructionProposal(asString(args.partId), asBoolean(args.includeImage));
      case "part_render_reconstruction_preview": return this.renderReconstructionPreview(asString(args.partId), asBoolean(args.recordInspection), actor);
      case "part_approve_reconstruction": return this.approveReconstructionProposal(asString(args.partId), actor);
      case "part_reject_reconstruction": return this.rejectReconstructionProposal(asString(args.partId), asString(args.reason), actor);
      case "parts_get_unassigned_regions": return this.getUnassignedPartRegions();
      case "parts_finalize": return this.finalizePartCuts(actor);
      case "part_region_get": return this.getPartRegion(asOptionalString(args.partId));
      case "part_region_relabel": return this.relabelPartRegion(asString(args.partId), asString(args.semanticType) as PartSemanticType, actor);
      case "part_region_assign_polygon": return this.assignPartRegionPolygon(asString(args.partId), args.points as readonly Point[], actor);
      case "part_region_transfer_boundary": return this.transferPartRegionBoundary(asString(args.partId), asString(args.edge) as RegionEdge, asNumber(args.coordinate), actor);
      case "part_region_split": return this.splitPartCut(asString(args.partId), asString(args.axis) as "horizontal" | "vertical", actor);
      case "part_region_merge": return this.mergePartCuts(args.partIds as readonly string[], asOptionalString(args.label), actor);
      case "part_region_mark_unresolved": return this.markPartRegionUnresolved(args.points as readonly Point[], actor);
      case "part_region_refine_edge": return this.refinePartRegionEdge(asString(args.partId), asOptionalString(args.neighborPartId), asString(args.instruction), actor);
      case "intelligence_provider_list": {
        const status = await this.intelligenceProvider.status();
        return this.ok({ providers: [status] });
      }
      case "ollama_status": return this.ok(await this.intelligenceProvider.status());
      case "ollama_models": return this.ok({ provider: this.intelligenceProvider.id, models: await this.intelligenceProvider.listModels() });
      case "ollama_select_model": this.intelligenceProvider.selectModel(asString(args.model)); return this.ok({ provider: this.intelligenceProvider.id, selectedModel: asString(args.model), persistedByClient: true });
      case "assistant_propose": return this.ok({ proposal: await this.intelligenceProvider.propose({ action: asString(args.action) as import("../../intelligence").AssistantProposal["action"], prompt: asString(args.prompt), targetPartId: asOptionalString(args.targetPartId), existingRegionNames: this.project?.partCutterState?.parts.map((part) => part.label) ?? [] }), mutated: false });
      case "region_semantic_suggest": return this.ok({ proposal: await this.intelligenceProvider.propose({ action: "suggest_semantic", prompt: asString(args.prompt), targetPartId: asOptionalString(args.partId), imageBase64: asOptionalString(args.imageBase64), existingRegionNames: this.project?.partCutterState?.parts.map((part) => part.label) ?? [] }), mutated: false });
      case "rig_create_proposal": return this.createRigProposal(actor);
      case "rig_accept_proposal": return this.acceptRigProposal(actor);
      case "rig_get_summary": return this.getRigSummary(asBoolean(args.includeHierarchy), asBoolean(args.includeFull));
      case "rig_move_bone": return this.mutateRig(`Move bone ${asString(args.boneId)}`, (rig) => updateBone(rig, asString(args.boneId), { x: asNumber(args.x), y: asNumber(args.y) }), actor, "bone.changed", asString(args.boneId));
      case "rig_rotate_bone": return this.mutateRig(`Rotate bone ${asString(args.boneId)}`, (rig) => updateBone(rig, asString(args.boneId), { rotation: asNumber(args.rotation) }), actor, "bone.changed", asString(args.boneId));
      case "rig_set_parent": return this.mutateRig(`Parent bone ${asString(args.boneId)}`, (rig) => updateBone(rig, asString(args.boneId), { parentId: asString(args.parentId) }), actor, "bone.changed", asString(args.boneId));
      case "rig_set_pivot": return this.mutateRig(`Set pivot ${asString(args.slotId)}`, (rig) => updateSlot(rig, asString(args.slotId), { pivotX: asNumber(args.pivotX), pivotY: asNumber(args.pivotY) }), actor, "slot.changed", asString(args.slotId));
      case "rig_set_slot_attachment": return this.mutateRig(`Set attachment ${asString(args.slotId)}`, (rig) => updateSlot(rig, asString(args.slotId), { attachmentId: args.attachmentId === null ? null : asString(args.attachmentId) }), actor, "slot.changed", asString(args.slotId));
      case "rig_set_slot_z_index": return this.mutateRig(`Set z-index ${asString(args.slotId)}`, (rig) => updateSlot(rig, asString(args.slotId), { zIndex: asNumber(args.zIndex) }), actor, "slot.changed", asString(args.slotId));
      case "character_apply_skin": return this.applySkin(asString(args.skinId), actor);
      case "character_set_equipment": return this.setEquipment(asString(args.slotId), args.attachmentId === null ? null : asString(args.attachmentId), actor);
      case "animation_list": return this.ok({ animations: animationListSummary(this.requireAnimations()) });
      case "animation_create": return this.createAnimation(asString(args.name), asNumber(args.duration), asBoolean(args.loop), actor);
      case "animation_generate": return this.generateAnimation(asString(args.request), asOptionalString(args.name), asNumber(args.duration), asBoolean(args.loop), actor);
      case "animation_revise": return this.reviseAnimation(asString(args.animationId), asString(args.request), actor);
      case "animation_get_summary": return this.getAnimationSummary(asString(args.animationId), asBoolean(args.includeTracks), asBoolean(args.includeFull));
      case "animation_set_keyframe": return this.setKeyframe(asString(args.animationId), asString(args.boneId), asString(args.property) as AnimatedProperty, asNumber(args.time), asNumber(args.value), asString(args.easing) as Easing, actor);
      case "animation_delete_keyframe": return this.deleteKeyframe(asString(args.animationId), asString(args.boneId), asString(args.property) as AnimatedProperty, asNumber(args.time), actor);
      case "animation_play": return this.playback("play", asOptionalString(args.animationId), undefined, actor);
      case "animation_pause": return this.playback("pause", undefined, undefined, actor);
      case "animation_seek": return this.playback("seek", asOptionalString(args.animationId), asNumber(args.time), actor);
      case "animation_delete": return this.removeAnimation(asString(args.animationId), actor);
      case "preview_render": return this.renderPreview(asString(args.animationId), asNumber(args.frameCount), asNumber(args.width), args.overlays as readonly string[], actor);
      case "preview_get_last": return this.ok({ preview: this.latestPreview });
      case "validation_get": return this.getValidation(asBoolean(args.includeDetails));
      case "project_run_smoke_test": return this.ok({ smokeTest: runRigSmokeTest(this.requireRig()) });
      case "transaction_begin": return this.beginTransaction(asString(args.label), actor);
      case "transaction_commit": return this.commitTransaction(asString(args.transactionId), actor);
      case "transaction_rollback": return this.rollbackTransaction(asString(args.transactionId), actor);
      case "character_create_from_prompt": return this.createCharacterFromPrompt(asString(args.name), asString(args.prompt), asBoolean(args.autoAcceptSafeSteps), asBoolean(args.requireNovelArtwork), actor);
      case "diagnostics_export_report":
      case "diagnostics_export_torture_test": throw new Error("Diagnostic exports are handled by the MCP fixed-directory service");
      case "image_render_candidate_sheet": return this.renderImageCandidateSheet(asString(args.proposalId), asNumber(args.width));
      case "image_analyze_candidate_suitability": return this.analyzeImageCandidateSuitability(asString(args.proposalId), asString(args.candidateId), asString(args.imageUrl), asNumber(args.width), asNumber(args.height), asString(args.prompt));
      case "image_prepare_repair_context": return this.prepareImageRepairContext(asString(args.projectId), asString(args.targetPartId));
      case "segmentation_status":
      case "character_ai_cut":
      case "part_refine_mask":
      case "part_reconstruct_hidden":
      case "background_remove":
      case "alpha_cleanup": throw new Error("Trusted character image-provider commands are handled by the MCP server-side service");
      case "image_provider_status":
      case "image_provider_list_capabilities":
      case "image_provider_list":
      case "comfy_get_status":
      case "character_generate":
      case "character_generate_variant":
      case "image_generation_get_job":
      case "image_generation_get_proposal":
      case "image_generation_render_proposal":
      case "image_generation_approve_candidate":
      case "image_generation_reject_candidate":
      case "image_generate_candidates":
      case "character_generate_with_comfy":
      case "image_get_proposal":
      case "image_get_candidates":
      case "image_get_candidate":
      case "image_review_proposal":
      case "image_approve_candidate":
      case "image_reject_candidate":
      case "image_regenerate_proposal":
      case "image_set_approval_policy":
      case "image_cancel_proposal": throw new Error("Image-production provider commands are handled by the MCP server-side service");
    }
  }

  private assertRequestedProject(projectId?: string): void {
    if (!projectId) return;
    if (this.project?.id !== projectId || this.session.snapshot.activeProjectId !== projectId) throw new Error(`Project ${projectId} is not the active Studio project`);
  }

  private ok<T extends JsonObject>(data: T, warnings: readonly string[] = []): CommandResult<JsonObject> {
    return { success: true, ...data, warnings: warningObjects(warnings) };
  }

  private emit(type: StudioEventType, actor: string, summary: string, entityId?: string, details?: StudioEvent["details"]): void {
    this.operationSequence += 1;
    this.events.emit({ id: `operation-${this.operationSequence}`, type, timestamp: now(), actor, summary, ...(entityId ? { entityId } : {}), ...(details ? { details } : {}) });
  }
  private notifyDurableListeners(): void { this.durableListeners.forEach((listener) => listener()); }

  private createProject(name: string, prompt: string, actor: string): CommandResult<JsonObject> {
    const project = createGeneratedCharacterProject(name, prompt);
    this.setProject(project, true);
    this.emit("project.created", actor, `Created project ${name}`, project.id);
    return this.ok({ project: projectSummary(project) });
  }

  private openProject(input: unknown, actor: string): CommandResult<JsonObject> {
    const parsed = parseGeneratedCharacterProject(input);
    if (!parsed.success) return { success: false, warnings: [], errors: [{ code: "invalid_project", message: parsed.message }] };
    this.setProject(parsed.data, true);
    this.emit("project.opened", actor, `Opened project ${parsed.data.name}`, parsed.data.id);
    return this.ok({ project: projectSummary(parsed.data) });
  }

  private async saveProject(actor: string): Promise<CommandResult<JsonObject>> {
    const project = this.requireProject();
    const operation = this.captureProjectOperation("browser-cache-save");
    if (typeof window !== "undefined") {
      const saved = await getGeneratedCharacterStorage().save(project);
      if (!saved.success) return { success: false, warnings: [{ code: "draft_kept_in_memory", message: "The current project remains available in memory." }], errors: [{ code: "project_storage_failed", message: `${saved.layer}: ${saved.message}` }] };
    }
    this.assertProjectOperationCurrent(operation, "generated-character-storage");
    this.session.update({ dirtyState: false });
    this.emit("project.saved", actor, `Updated browser cache for ${project.name}`, project.id);
    return this.ok({ projectId: project.id, savedAt: now(), persistence: typeof window === "undefined" ? "memory-only" : "indexeddb-working-cache", snapshot: this.getDurableSnapshot() });
  }

  private openSnapshot(input: unknown, actor: string): CommandResult<JsonObject> {
    try { this.installDurableSnapshot(input as LocalProjectSnapshot, actor); return this.ok({ projectId: this.session.snapshot.activeProjectId, openedFrom: "disk" }); }
    catch (error: unknown) { return { success: false, warnings: [], errors: [{ code: "invalid_disk_project", message: error instanceof Error ? error.message : "Disk project is invalid" }] }; }
  }

  private exportProject(format: string, actor: string): CommandResult<JsonObject> {
    const project = this.requireProject();
    this.emit("project.saved", actor, `Exported project ${project.name}`, project.id);
    return this.ok({ projectId: project.id, format, fileName: `${project.id}.character-project.json`, content: serializeGeneratedCharacterProject(project) }, format === "package" ? ["The MCP export returns validated JSON; use the Studio UI for the image-inclusive ZIP package."] : []);
  }

  private setCharacterPrompt(prompt: string, actor: string): CommandResult<JsonObject> {
    const next = updatedProject(this.requireProject(), { originalUserPrompt: prompt, stage: "describe" });
    this.setProject(next); this.emit("project.changed", actor, "Changed character prompt", next.id);
    return this.ok({ project: projectSummary(next) });
  }

  private async generateImage(mode: "generate" | "regenerate" | "variant", actor: string): Promise<CommandResult<JsonObject>> {
    const project = this.requireProject();
    const operation = this.captureProjectOperation(`character-${mode}`);
    this.emit("generation.started", actor, `Started ${mode}`, project.id);
    const built = buildCharacterGenerationPrompt({ description: project.originalUserPrompt, controls: DEFAULT_CONTROLS });
    const request = { userPrompt: project.originalUserPrompt, generationPrompt: built.prompt, negativePrompt: built.negativePrompt, controls: DEFAULT_CONTROLS, sourceGenerationId: project.sourceImage?.generationId };
    const result = mode === "generate" ? await this.characterProvider.generateCharacter(request) : mode === "regenerate" ? await this.characterProvider.regenerateCharacter(request) : await this.characterProvider.generateVariant(request);
    this.assertProjectOperationCurrent(operation, "character-provider");
    const next = updatedProject(project, {
      stage: "generate", generationPrompt: built.prompt,
      generationMetadata: { provider: result.provider, preset: built.preset, negativePrompt: built.negativePrompt, generationMode: result.generationMode, novelArtwork: result.novelArtwork, sourceArtifact: result.sourceArtifact },
      generationHistory: [...project.generationHistory, result], sourceImage: result, suitability: undefined, segmentationData: undefined,
      extractedParts: [], reconstructedParts: [], rigDefinition: undefined, skins: [], warnings: result.warnings,
    });
    this.setProject(next); this.emit("generation.completed", actor, `Generated image ${result.generationId}`, result.generationId);
    return this.ok({
      generationId: result.generationId, width: result.width, height: result.height, image: result.image, requiresReview: true,
      generationMode: result.generationMode, novelArtwork: result.novelArtwork, provider: result.provider, sourceArtifact: result.sourceArtifact,
    }, result.warnings);
  }

  private getGeneration(includeHistory: boolean): CommandResult<JsonObject> {
    const project = this.requireProject();
    return this.ok({ generation: project.sourceImage ? { ...project.sourceImage, image: project.sourceImage.image } : null, ...(includeHistory ? { generationHistory: project.generationHistory } : {}), suitability: project.suitability ?? null });
  }

  private importManagedGeneration(input: ManagedGenerationIngress, actor: string): CommandResult<JsonObject> {
    const project = this.requireProject();
    const proposalRecord = typeof input.metadata.proposalId === "string" && typeof input.metadata.candidateId === "string" && typeof input.metadata.workflowId === "string"
      ? {
          proposalId: input.metadata.proposalId, provider: typeof input.metadata.provider === "string" ? input.metadata.provider : input.provider,
          operation: input.operation, candidateId: input.metadata.candidateId, workflowId: input.metadata.workflowId,
          approvalPolicy: input.metadata.approvalPolicy === "agent_recommendation" ? "agent_recommendation" as const : "manual" as const,
          ...(input.targetPartId ? { targetPartId: input.targetPartId } : {}), acceptedAt: now(),
        }
      : null;
    const result: CharacterImageGenerationResult = {
      generationId: input.generationId, image: input.managedImage.image, width: input.managedImage.width, height: input.managedImage.height,
      generationPrompt: input.prompt || project.originalUserPrompt,
      generationSettings: { imported: input.generationMode === "imported_external", accepted: input.accepted, mimeType: input.managedImage.mimeType, ...(isJsonObject(input.metadata.generationParameters) ? input.metadata.generationParameters : {}) },
      ...(typeof input.metadata.seed === "number" || input.metadata.seed === null ? { seed: input.metadata.seed } : {}),
      providerMetadata: { provider: input.provider, imported: input.generationMode === "imported_external", ...(isJsonObject(input.metadata.providerMetadata) ? input.metadata.providerMetadata : {}) }, warnings: [],
      generationMode: input.generationMode, novelArtwork: true, provider: input.provider, sourceArtifact: input.managedImage.sourceArtifact,
    };
    if (input.operation === "OCCLUSION_RECONSTRUCTION" || input.operation === "PART_REPAIR" || input.operation === "HAND_REPAIR") {
      if (!input.targetPartId) throw new Error(`${input.operation} approval requires a target part`);
      if (!project.segmentationData?.parts.some((part) => part.id === input.targetPartId)) throw new Error(`Target part ${input.targetPartId} is not in the active project`);
      const existing = project.reconstructedParts.find((review) => review.partId === input.targetPartId);
      const repaired = existing
        ? project.reconstructedParts.map((review) => review.partId === input.targetPartId ? { ...review, decision: "reconstruct" as const, reconstructedImage: input.managedImage.image, reconstructionAccepted: true } : review)
        : [...project.reconstructedParts, { partId: input.targetPartId, likelyOccluded: input.operation === "OCCLUSION_RECONSTRUCTION", confidence: 1, reason: `Approved ${input.operation.toLowerCase()} proposal`, decision: "reconstruct" as const, reconstructedImage: input.managedImage.image, reconstructionAccepted: true }];
      const next = updatedProject(project, {
        stage: "prepare", reconstructedParts: repaired,
        imageProductionHistory: proposalRecord ? [...project.imageProductionHistory, proposalRecord] : project.imageProductionHistory,
        userCorrections: [...project.userCorrections, { stage: "prepare", description: `Approved ${input.operation} for ${input.targetPartId}`, timestamp: now() }],
      });
      this.setProject(next); this.emit("generation.completed", actor, `Approved ${input.operation} for ${input.targetPartId}`, input.generationId);
      return this.ok({ projectId: next.id, generationId: input.generationId, operation: input.operation, targetPartId: input.targetPartId, accepted: true, image: input.managedImage.image });
    }
    const next = updatedProject(project, {
      stage: input.accepted ? "prepare" : "generate", generationPrompt: result.generationPrompt,
      generationMetadata: { provider: input.provider, generationMode: result.generationMode, novelArtwork: true, sourceArtifact: result.sourceArtifact, importedMetadata: input.metadata },
      generationHistory: [...project.generationHistory, result], imageProductionHistory: proposalRecord ? [...project.imageProductionHistory, proposalRecord] : project.imageProductionHistory, sourceImage: result, suitability: undefined, segmentationData: undefined,
      extractedParts: [], reconstructedParts: [], rigDefinition: undefined, skins: [], warnings: [],
    });
    this.setProject(next);
    this.emit("generation.completed", actor, `Imported external generation ${result.generationId}`, result.generationId);
    return this.ok({
      projectId: next.id, generationId: result.generationId, width: result.width, height: result.height, image: result.image,
      accepted: input.accepted, requiresReview: !input.accepted, generationMode: result.generationMode, novelArtwork: true,
      provider: result.provider, sourceArtifact: result.sourceArtifact, operation: input.operation,
    });
  }

  private acceptGeneration(generationId: string, actor: string): CommandResult<JsonObject> {
    const project = this.requireProject();
    if (project.sourceImage?.generationId !== generationId) return { success: false, warnings: [], errors: [{ code: "generation_not_found", message: `Generation ${generationId} is not active` }] };
    const next = updatedProject(project, { stage: "prepare" }); this.setProject(next); this.emit("project.changed", actor, `Accepted generation ${generationId}`, generationId);
    return this.ok({ generationId, accepted: true, nextStep: "character_segment" });
  }

  private async runSuitability(actor: string): Promise<CommandResult<JsonObject>> {
    const project = this.requireProject(); const source = project.sourceImage;
    if (!source) throw new Error("Generate a character image first");
    const operation = this.captureProjectOperation("character-suitability");
    const review = await this.characterProvider.checkSuitability({ image: source.image, width: source.width, height: source.height, userPrompt: project.originalUserPrompt });
    this.assertProjectOperationCurrent(operation, "character-provider");
    const next = updatedProject(project, { suitability: review, warnings: [...project.warnings, ...review.issues.map((issue) => issue.message)] }); this.setProject(next);
    this.emit("validation.changed", actor, `Suitability check scored ${Math.round(review.score * 100)}%`, project.id);
    return this.ok({ suitability: review, requiresReview: review.issues.some((issue) => issue.severity !== "info") }, review.issues.map((issue) => issue.message));
  }

  private async segmentCharacter(actor: string): Promise<CommandResult<JsonObject>> {
    const project = this.requireProject(); const source = project.sourceImage;
    if (!source) throw new Error("Generate a character image first");
    const operation = this.captureProjectOperation("character-segmentation");
    const response = await this.characterProvider.segmentCharacter({ generationId: source.generationId, image: source.image, width: source.width, height: source.height, expectedEquipment: [DEFAULT_CONTROLS.mainHandEquipment ?? "", DEFAULT_CONTROLS.offHandEquipment ?? ""].filter(Boolean) });
    this.assertProjectOperationCurrent(operation, "character-provider");
    const validation = validateSegmentationResponse(response);
    if (!validation.success || !validation.data) return { success: false, warnings: warningObjects(validation.warnings), errors: validation.errors.map((message) => ({ code: "invalid_segmentation", message })) };
    const reviews = detectOcclusionReviews(validation.data.parts);
    const next = updatedProject(project, { stage: "prepare", segmentationData: validation.data, reconstructedParts: reviews, warnings: [...project.warnings, ...validation.warnings] });
    this.setProject(next); this.emit("segmentation.completed", actor, `Segmented ${validation.data.parts.length} parts`, validation.data.segmentationId);
    return this.ok({ segmentationId: validation.data.segmentationId, partCount: validation.data.parts.length, requiresReview: reviews.length > 0, reviewPartIds: reviews.map((review) => review.partId), provider: validation.data.providerMetadata, productionReady: this.characterProvider.capabilities.segmentation.available && this.characterProvider.capabilities.segmentation.imageConditioned }, validation.warnings);
  }

  private getCharacterParts(includeFull: boolean): CommandResult<JsonObject> {
    const parts = this.requireProject().segmentationData?.parts ?? [];
    return this.ok({ parts: parts.map((part) => includeFull ? part : { id: part.id, name: part.name, semanticType: part.semanticType, confidence: part.confidence, accepted: part.accepted, suggestedBoneId: part.suggestedBoneId, suggestedSlotId: part.suggestedSlotId, warnings: part.warnings }) });
  }

  private updatePart(partId: string, patch: JsonObject, actor: string): CommandResult<JsonObject> {
    const project = this.requireProject(); const segmentation = project.segmentationData;
    if (!segmentation?.parts.some((part) => part.id === partId)) throw new Error(`Part ${partId} does not exist`);
    const parts = segmentation.parts.map((part) => part.id === partId ? { ...part, ...patch, provenance: "manual" as const } : part);
    const next = updatedProject(project, { segmentationData: { ...segmentation, parts }, userCorrections: [...project.userCorrections, { stage: "prepare", description: `Agent updated ${partId}`, timestamp: now() }] });
    this.setProject(next); this.emit("project.changed", actor, `Updated part ${partId}`, partId);
    return this.ok({ part: parts.find((part) => part.id === partId)! });
  }

  private async repairOcclusion(partId: string, actor: string): Promise<CommandResult<JsonObject>> {
    const project = this.requireProject(); const source = project.sourceImage; const part = project.segmentationData?.parts.find((candidate) => candidate.id === partId);
    if (!source || !part) throw new Error("Source image or part is unavailable");
    if (!this.characterProvider.capabilities.reconstruction.available) throw new Error(`${this.characterProvider.name} does not provide production reconstruction; the part was left unchanged`);
    const operation = this.captureProjectOperation("occlusion-reconstruction");
    const result = await this.characterProvider.reconstructPart({ generationId: source.generationId, image: source.image, part, stylePrompt: project.generationPrompt });
    this.assertProjectOperationCurrent(operation, "character-provider");
    const reconstructedParts = project.reconstructedParts.map((review) => review.partId === partId ? { ...review, decision: "reconstruct" as const, reconstructedImage: result.image, reconstructionAccepted: false } : review);
    this.setProject(updatedProject(project, { reconstructedParts })); this.emit("project.changed", actor, `Reconstructed ${partId} for review`, partId);
    return this.ok({ reconstructionId: result.reconstructionId, partId, image: result.image, requiresReview: true }, result.warnings);
  }

  private requirePartCutterState(): PartCutterState {
    const project = this.requireProject(); const source = project.sourceImage;
    if (!source) throw new Error("Import or generate a character source image first");
    return project.partCutterState ?? createPartCutterState(source.generationId, source.width, source.height, project.segmentationData ? "assisted" : "manual");
  }

  private setPartCutterState(state: PartCutterState, actor: string, summary: string): GeneratedCharacterProject {
    const project = this.requireProject(); const segmentationData = partCutToSegmentation(state);
    const next = updatedProject(project, { stage: "prepare", partCutterState: state, segmentationData, userCorrections: [...project.userCorrections, { stage: "prepare", description: summary, timestamp: now() }] });
    this.setProject(next); this.emit("project.changed", actor, summary, state.activeProposalId ?? project.id); return next;
  }

  private getPartCutterStatus(includeParts: boolean): CommandResult<JsonObject> {
    const state = this.requirePartCutterState(); const active = state.proposals.find((proposal) => proposal.proposalId === state.activeProposalId);
    return this.ok({ sourceImageId: state.sourceImageId, sourceCanvasSize: state.sourceCanvasSize, mode: state.mode, partCount: state.parts.length, activeProposalId: state.activeProposalId ?? null, proposalStatus: active?.status ?? null, finalized: state.finalized, coverage: analyzeCoverage(state), anatomicalGuide: state.anatomicalGuide ? { guideVersion: state.anatomicalGuide.guideVersion, profile: state.anatomicalGuide.profile, status: state.anatomicalGuide.status, landmarkCount: state.anatomicalGuide.landmarks.length, zoneCount: state.anatomicalGuide.zones.length, strategy: "landmark-guided-hierarchical" } : null, ...(includeParts ? { parts: state.parts } : {}) });
  }

  private getPartRegion(partId?: string): CommandResult<JsonObject> {
    const state = ensureOwnershipPartition(this.requirePartCutterState(), "agent"); const ownership = state.ownership!;
    if (!partId) return this.ok({ ownershipVersion: ownership.ownershipVersion, reviewStatus: ownership.reviewStatus, exclusive: true, regionCount: state.parts.length, unresolved: analyzeCoverage(state).unassignedPixels, regions: state.parts.map((part) => ({ partId: part.partId, semanticType: part.semanticType, label: part.label, bounds: part.boundingBox, neighbors: ownership.adjacency[part.partId] ?? [] })) });
    const part = state.parts.find((candidate) => candidate.partId === partId); if (!part) throw new Error(`Region ${partId} does not exist`);
    return this.ok({ region: { partId, semanticType: part.semanticType, label: part.label, bounds: part.boundingBox, mask: part.mask, neighbors: ownership.adjacency[partId] ?? [], riggingPadding: ownership.riggingPadding[partId] ?? 0 }, exclusive: true });
  }

  private relabelPartRegion(partId: string, semanticType: PartSemanticType, actor: string): CommandResult<JsonObject> {
    const state = ensureOwnershipPartition(this.requirePartCutterState(), "agent"); const part = state.parts.find((candidate) => candidate.partId === partId); if (!part) throw new Error(`Region ${partId} does not exist`);
    const defaults = SEMANTIC_TAXONOMY[semanticType]; const parts = state.parts.map((candidate) => candidate.partId === partId ? { ...candidate, semanticType, label: defaults.label, suggestedParent: defaults.suggestedParentBone, layer: defaults.defaultLayerGroup, articulated: defaults.articulated, equipment: defaults.equipment, provenance: "manual" as const } : candidate);
    const next = recordOwnershipRelabel({ ...state, parts }, partId, `${part.label} relabeled as ${defaults.label}`, "agent"); this.setPartCutterState(next, actor, `Relabeled region ${partId} as ${semanticType}`); return this.ok({ partId, semanticType, label: defaults.label, pixelsChanged: 0 });
  }

  private assignPartRegionPolygon(partId: string, points: readonly Point[], actor: string): CommandResult<JsonObject> {
    const state = ensureOwnershipPartition(this.requirePartCutterState(), "agent"); const selection = polygonMask(points, state.sourceCanvasSize); const result = assignOwnershipSelection(state, partId, selection.bounds, selection.mask, { actor: "agent" });
    this.setPartCutterState(result.state, actor, `Assigned polygon ownership to ${partId}`); return this.ok({ partId, changedPixels: result.changedPixels, yieldedRegionIds: result.previousOwnerIds, exclusive: true, undoable: true });
  }

  private transferPartRegionBoundary(partId: string, edge: RegionEdge, coordinate: number, actor: string): CommandResult<JsonObject> {
    const result = reshapeRegionEdge(this.requirePartCutterState(), partId, edge, coordinate, "agent"); this.setPartCutterState(result.state, actor, `Transferred ${partId} ${edge} boundary`); return this.ok({ partId, edge, coordinate, changedPixels: result.changedPixels, yieldedRegionIds: result.yieldedRegionIds, exclusive: true, undoable: true });
  }

  private markPartRegionUnresolved(points: readonly Point[], actor: string): CommandResult<JsonObject> {
    const state = ensureOwnershipPartition(this.requirePartCutterState(), "agent"); const selection = polygonMask(points, state.sourceCanvasSize); const result = assignOwnershipSelection(state, null, selection.bounds, selection.mask, { actor: "agent" });
    this.setPartCutterState(result.state, actor, "Marked polygon foreground unresolved"); return this.ok({ changedPixels: result.changedPixels, previousOwnerIds: result.previousOwnerIds, exclusive: true, undoable: true });
  }

  private async refinePartRegionEdge(partId: string, neighborPartId: string | undefined, instruction: string, actor: string): Promise<CommandResult<JsonObject>> {
    const project = this.requireProject(); const source = project.sourceImage; if (!source) throw new Error("Source image is unavailable");
    if (!this.characterProvider.capabilities.maskRefinement.available || !this.characterProvider.refinePartMasks) throw new Error(`${this.characterProvider.name} cannot refine a local ownership boundary`);
    const state = ensureOwnershipPartition(this.requirePartCutterState(), "agent"); const part = state.parts.find((candidate) => candidate.partId === partId); if (!part) throw new Error(`Region ${partId} does not exist`);
    if (neighborPartId && !(state.ownership?.adjacency[partId] ?? []).includes(neighborPartId)) throw new Error(`${neighborPartId} is not adjacent to ${partId}`);
    const operation = this.captureProjectOperation("part-refinement");
    const response = await this.characterProvider.refinePartMasks({ generationId: source.generationId, image: source.image, width: source.width, height: source.height, current: partCutToSegmentation(state), instruction: `${instruction}${neighborPartId ? ` Boundary: ${partId} ↔ ${neighborPartId}.` : ""}`, targetPartId: partId });
    this.assertProjectOperationCurrent(operation, "character-provider");
    const refined = response.parts.find((candidate) => candidate.id === partId); if (!refined?.mask) throw new Error(`Refinement provider did not return a mask for ${partId}`);
    const zone = state.anatomicalGuide?.zones.find((candidate) => candidate.zoneId === partId || candidate.semanticType === part.semanticType);
    if (!zone) throw new Error(`Refinement requires a predetermined anatomical zone for ${partId}`);
    const constrained = constrainProviderMaskToZone(refined, zone, state.sourceCanvasSize.width, state.sourceCanvasSize.height);
    if (!constrained) throw new Error(`Refinement provider returned no pixels inside the predetermined zone for ${partId}`);
    const clearBounds = zone.mask ? zone.bounds : part.boundingBox; const clearMask = zone.mask ?? part.mask;
    const cleared = assignOwnershipSelection(state, null, clearBounds, clearMask, { actor: "agent", action: "refine" }).state;
    const applied = assignOwnershipSelection(cleared, partId, constrained.bounds, constrained.mask, { actor: "agent", includeBackground: true, action: "refine" });
    const provenance = `Refinement provenance: provider=${String(response.providerMetadata.provider ?? this.characterProvider.id)}; workflow=${String(response.providerMetadata.workflow ?? "unavailable")}; scope=edge; target=${partId}; proposed=${constrained.proposedPixelCount}; accepted=${constrained.acceptedPixelCount}; clipped=${constrained.clippedPixelCount}`;
    const next = { ...applied.state, parts: applied.state.parts.map((candidate) => candidate.partId === partId ? { ...candidate, notes: [...candidate.notes, provenance] } : candidate) };
    this.setPartCutterState(next, actor, `Refined local boundary for ${partId}`);
    return this.ok({ partId, neighborPartId: neighborPartId ?? null, changedPixels: applied.changedPixels, yieldedRegionIds: applied.previousOwnerIds, proposedPixels: constrained.proposedPixelCount, acceptedPixels: constrained.acceptedPixelCount, clippedPixels: constrained.clippedPixelCount, clippedPercentage: constrained.clippedPercentage, exclusive: true, requiresReview: true });
  }

  private async createPartCutProposal(instruction: string, actor: string): Promise<CommandResult<JsonObject>> {
    const project = this.requireProject(); const source = project.sourceImage; if (!source) throw new Error("Import or generate a source image first");
    const state = this.requirePartCutterState(); const guide = buildAnatomicalPartitionGuide(state, "humanoid");
    const operation = this.captureProjectOperation("part-segmentation");
    const response = await this.characterProvider.segmentCharacter({ generationId: source.generationId, image: source.image, width: source.width, height: source.height, expectedEquipment: guide.zones.filter((zone) => zone.optional && zone.semanticType.includes("Equipment")).map((zone) => zone.semanticType), semanticPrompt: anatomicalGuidePrompt(guide, instruction) });
    this.assertProjectOperationCurrent(operation, "character-provider");
    const validation = validateSegmentationResponse(response); if (!validation.success || !validation.data) throw new Error(validation.errors.join("; "));
    const proposal = guidedProposalFromSegmentation(validation.data, guide, instruction, state.activeProposalId);
    const next = { ...state, anatomicalGuide: { ...guide, status: "ai-refined" as const, updatedAt: now() }, mode: "auto" as const, proposals: [...state.proposals.map((item) => item.proposalId === state.activeProposalId ? { ...item, status: "superseded" as const } : item), proposal], activeProposalId: proposal.proposalId, updatedAt: now() };
    this.setPartCutterState(next, actor, `Created part-cut proposal ${proposal.proposalId}`);
    return this.ok({ proposalId: proposal.proposalId, partCount: proposal.parts.length, parts: proposal.parts.map(({ mask, ...part }) => ({ ...part, mask: { width: mask.width, height: mask.height } })), guide: { strategy: "landmark-guided-hierarchical", landmarkCount: guide.landmarks.length, zoneCount: guide.zones.length }, requiresReview: true, provider: proposal.providerMetadata ?? {}, productionReady: this.characterProvider.capabilities.segmentation.available && this.characterProvider.capabilities.segmentation.imageConditioned }, proposal.warnings);
  }

  private installPartCutProposal(segmentation: CharacterSegmentationResponse, instruction: string, parentProposalId: string | undefined, actor: string): CommandResult<JsonObject> {
    const validation = validateSegmentationResponse(segmentation);
    if (!validation.success || !validation.data) throw new Error(`Segmentation proposal is invalid: ${validation.errors.join("; ")}`);
    const state = this.requirePartCutterState(); const guide = buildAnatomicalPartitionGuide(state, state.anatomicalGuide?.profile ?? "humanoid");
    const proposal = guidedProposalFromSegmentation(validation.data, guide, instruction, parentProposalId ?? state.activeProposalId);
    const next = {
      ...state, anatomicalGuide: { ...guide, status: "ai-refined" as const, updatedAt: now() }, mode: "auto" as const,
      proposals: [...state.proposals.map((item) => item.proposalId === (parentProposalId ?? state.activeProposalId) ? { ...item, status: "superseded" as const } : item), proposal],
      activeProposalId: proposal.proposalId, updatedAt: now(),
    };
    this.setPartCutterState(next, actor, `Installed trusted AI cut proposal ${proposal.proposalId}`);
    return this.ok({ proposalId: proposal.proposalId, segmentationId: validation.data.segmentationId, partCount: proposal.parts.length, readyCount: proposal.parts.filter((part) => part.selected).length, reviewCount: proposal.parts.filter((part) => !part.selected).length, warnings: proposal.warnings, requiresReview: true });
  }

  private async promptPartCut(instruction: string, proposalId: string | undefined, actor: string): Promise<CommandResult<JsonObject>> {
    const state = this.requirePartCutterState(); const current = state.proposals.find((proposal) => proposal.proposalId === (proposalId ?? state.activeProposalId));
    if (!current) return this.createPartCutProposal(instruction, actor);
    const project = this.requireProject(); const source = project.sourceImage;
    if (!source) throw new Error("Import or generate a source image first");
    if (!this.characterProvider.capabilities.maskRefinement.available || !this.characterProvider.refinePartMasks) throw new Error(`${this.characterProvider.name} cannot perform image-conditioned mask refinement; the current proposal was left unchanged`);
    const guide = state.anatomicalGuide ?? buildAnatomicalPartitionGuide(state, "humanoid");
    const operation = this.captureProjectOperation("part-prompt-refinement");
    const response = await this.characterProvider.refinePartMasks({ generationId: source.generationId, image: source.image, width: source.width, height: source.height, current: proposalToSegmentation(current), instruction: anatomicalGuidePrompt(guide, instruction) });
    this.assertProjectOperationCurrent(operation, "character-provider");
    const proposal = guidedProposalFromSegmentation(response, guide, instruction, current.proposalId); const next = { ...state, anatomicalGuide: { ...guide, status: "ai-refined" as const, updatedAt: now() }, proposals: [...state.proposals.map((item) => item.proposalId === current.proposalId ? { ...item, status: "superseded" as const } : item), proposal], activeProposalId: proposal.proposalId, updatedAt: now() };
    this.setPartCutterState(next, actor, `Revised part-cut proposal ${current.proposalId}`); return this.ok({ proposalId: proposal.proposalId, parentProposalId: current.proposalId, partCount: proposal.parts.length, unaffectedPartsPreserved: true, requiresReview: true });
  }

  private getPartCutProposal(proposalId: string | undefined, includeMasks: boolean): CommandResult<JsonObject> {
    const state = this.requirePartCutterState(); const proposal = state.proposals.find((item) => item.proposalId === (proposalId ?? state.activeProposalId)); if (!proposal) throw new Error("No part-cut proposal is active");
    return this.ok({ proposal: includeMasks ? proposal : { ...proposal, parts: proposal.parts.map(({ mask, ...part }) => ({ ...part, mask: { width: mask.width, height: mask.height, omitted: true } })) } });
  }

  private renderPartCutProposal(proposalId: string | undefined): CommandResult<JsonObject> {
    const state = this.requirePartCutterState(); const proposal = state.proposals.find((item) => item.proposalId === (proposalId ?? state.activeProposalId)); if (!proposal) throw new Error("No part-cut proposal is active");
    const svg = renderProposalSvg(proposal, state.sourceCanvasSize.width, state.sourceCanvasSize.height, this.requireProject().sourceImage?.image); return this.ok({ proposalId: proposal.proposalId, mimeType: "image/svg+xml", svg, width: state.sourceCanvasSize.width, height: state.sourceCanvasSize.height, includesSourceImage: Boolean(this.requireProject().sourceImage?.image), labelsInclude: ["safety status", "detector phrase", "confidence source"] });
  }

  private acceptPartCutProposal(proposalId: string, partIds: readonly string[] | undefined, actor: string): CommandResult<JsonObject> {
    const before = this.requirePartCutterState(); const priorIds = new Set(before.parts.map((part) => part.partId));
    const next = acceptPartCutProposal(before, proposalId, partIds); const acceptedPartIds = next.parts.filter((part) => !priorIds.has(part.partId)).map((part) => part.partId);
    this.setPartCutterState(next, actor, `Accepted part-cut proposal ${proposalId}`); return this.ok({ proposalId, acceptedPartIds, remainingProposalPartCount: next.proposals.find((proposal) => proposal.proposalId === proposalId)?.parts.length ?? 0, partCount: next.parts.length, undoable: true });
  }

  private rejectPartCutProposal(proposalId: string, actor: string): CommandResult<JsonObject> { const next = rejectPartCutProposal(this.requirePartCutterState(), proposalId); this.setPartCutterState(next, actor, `Rejected part-cut proposal ${proposalId}`); return this.ok({ proposalId, rejected: true }); }

  private mutatePartCut(partId: string, patch: Readonly<Record<string, unknown>>, summary: string, actor: string): CommandResult<JsonObject> {
    const state = this.requirePartCutterState(); const part = state.parts.find((item) => item.partId === partId); if (!part) throw new Error(`Part ${partId} does not exist`);
    const semantic = patch.semanticType as PartSemanticType | undefined; const defaults = semantic ? SEMANTIC_TAXONOMY[semantic] : null;
    const parts = state.parts.map((item) => item.partId === partId ? { ...item, ...patch, ...(defaults ? { label: defaults.label, suggestedParent: defaults.suggestedParentBone, layer: defaults.defaultLayerGroup, articulated: defaults.articulated, equipment: defaults.equipment } : {}), provenance: "manual" as const } : item);
    const next = { ...state, parts, finalized: false, updatedAt: now() }; this.setPartCutterState(next, actor, summary); return this.ok({ part: parts.find((item) => item.partId === partId)! });
  }

  private mergePartCuts(partIds: readonly string[], label: string | undefined, actor: string): CommandResult<JsonObject> { const next = mergePartCuts(this.requirePartCutterState(), partIds, label); this.setPartCutterState(next, actor, `Merged ${partIds.join(", ")}`); return this.ok({ partCount: next.parts.length, mergedPart: next.parts.at(-1) }); }
  private splitPartCut(partId: string, axis: "horizontal" | "vertical", actor: string): CommandResult<JsonObject> { const next = splitPartCut(this.requirePartCutterState(), partId, axis); this.setPartCutterState(next, actor, `Split ${partId}`); return this.ok({ partIds: [`${partId}-a`, `${partId}-b`], partCount: next.parts.length }); }
  private setPartMask(partId: string, mask: SegmentationMask, actor: string): CommandResult<JsonObject> { const part = this.requirePartCutterState().parts.find((item) => item.partId === partId); if (!part) throw new Error(`Part ${partId} does not exist`); if (mask.width !== Math.round(part.boundingBox.width) || mask.height !== Math.round(part.boundingBox.height)) throw new Error("Mask dimensions must match the part bounding box"); return this.mutatePartCut(partId, { mask }, `Updated ${partId} mask`, actor); }
  private getUnassignedPartRegions(): CommandResult<JsonObject> { const coverage = analyzeCoverage(this.requirePartCutterState()); return this.ok({ ...coverage, note: "Background-aware foreground analysis is performed in the visual workspace; MCP reports accepted-mask coverage only" }); }

  private installReconstructionProposal(partId: string, result: OcclusionReconstructionResult, actor: string): CommandResult<JsonObject> {
    const state = this.requirePartCutterState(); const part = state.parts.find((candidate) => candidate.partId === partId);
    if (!part) throw new Error(`Part ${partId} does not exist`);
    if (result.partId !== partId) throw new Error(`Reconstruction result belongs to ${result.partId}, not ${partId}`);
    const consistency = validateReconstructionAsset(part, result.width, result.height);
    const rotationTests = ([-20, 0, 20] as const).map((angle) => evaluateRotationTest({ ...part, occlusionState: "reconstructed" }, angle));
    if (consistency.status === "REJECT") throw new Error(`Reconstruction rejected by the structural gate: ${consistency.warnings.join("; ")}`);
    const notes = [...part.notes, ...result.warnings, `${consistency.status} · bbox ratio ${consistency.sizeRatio.toFixed(2)} · centroid ${consistency.centroidDisplacement.toFixed(1)}px · pivot ${consistency.pivotDisplacement.toFixed(1)}px`, ...rotationTests.map((test) => `Rotation ${test.angle}° · ${test.passed ? "PASS" : `WARNING: ${test.warnings.join(", ")}`}`)];
    const nextState = { ...state, parts: state.parts.map((candidate) => candidate.partId === partId ? { ...candidate, reconstructionImage: result.image, occlusionState: "likely-incomplete" as const, notes } : candidate), finalized: false, updatedAt: now() };
    this.setPartCutterState(nextState, actor, `Created reconstruction proposal for ${partId}`);
    const project = this.requireProject(); const existing = project.reconstructedParts.find((review) => review.partId === partId);
    const review = { ...(existing ?? { partId, likelyOccluded: true, confidence: .55, reason: "Hidden-area reconstruction requested" }), decision: "unreviewed" as const, reconstructedImage: result.image, reconstructionAccepted: false, previewResourceInspected: undefined, inspectedAt: undefined, inspectedBy: undefined };
    this.setProject(updatedProject(project, { reconstructedParts: [...project.reconstructedParts.filter((candidate) => candidate.partId !== partId), review] }));
    this.emit("project.changed", actor, `Reconstruction proposal ${result.reconstructionId} awaits visual review`, partId);
    return this.ok({ reconstructionId: result.reconstructionId, partId, status: consistency.status, consistency, rotationTests, providerMetadata: result.providerMetadata, runtimeMs: result.runtimeMs ?? null, requiresVisualInspection: true, requiresApproval: true });
  }

  private async getReconstructionProposal(partId: string, includeImage: boolean): Promise<CommandResult<JsonObject>> {
    const project = this.requireProject(); const state = this.requirePartCutterState(); const part = state.parts.find((candidate) => candidate.partId === partId); const review = project.reconstructedParts.find((candidate) => candidate.partId === partId);
    if (!part?.reconstructionImage || !review) throw new Error(`Part ${partId} has no reconstruction proposal`);
    const pixels = await browserImagePixels(part.reconstructionImage); const consistency = validateReconstructionAsset(part, pixels.width, pixels.height, { alpha: pixels.alpha });
    const rotationTests = ([-20, 0, 20] as const).map((angle) => evaluateRotationTest({ ...part, mask: { width: pixels.width, height: pixels.height, alpha: pixels.alpha }, occlusionState: "reconstructed" }, angle));
    return this.ok({ partId, status: review.reconstructionAccepted ? "approved" : review.decision === "keep-visible-fragment" ? "rejected" : "awaiting_review", consistency, rotationTests, inspectedResource: review.previewResourceInspected ?? null, inspectedAt: review.inspectedAt ?? null, inspectedBy: review.inspectedBy ?? null, requiresVisualInspection: !review.previewResourceInspected, requiresApproval: !review.reconstructionAccepted, ...(includeImage ? { image: part.reconstructionImage } : {}) });
  }

  private async renderReconstructionPreview(partId: string, recordInspection: boolean, actor: string): Promise<CommandResult<JsonObject>> {
    const project = this.requireProject(); const source = project.sourceImage; const state = this.requirePartCutterState(); const part = state.parts.find((candidate) => candidate.partId === partId);
    if (!source || !part?.reconstructionImage) throw new Error(`Part ${partId} has no renderable reconstruction proposal`);
    const visible = await extractPartToDataUrl(source.image, part.boundingBox, part.mask, 0);
    const [sourceImage, visibleImage, reconstructedImage] = await Promise.all([loadBrowserImage(source.image), loadBrowserImage(visible), loadBrowserImage(part.reconstructionImage)]);
    const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 360; const context = canvas.getContext("2d"); if (!context) throw new Error("Reconstruction preview canvas is unavailable");
    context.fillStyle = "#0b1012"; context.fillRect(0, 0, canvas.width, canvas.height); context.font = "600 15px system-ui"; context.textAlign = "center"; context.textBaseline = "middle";
    const panels = [{ x: 20, width: 210, label: "Original" }, { x: 245, width: 210, label: "Visible Part" }, { x: 470, width: 210, label: "Reconstructed" }];
    panels.forEach((panel) => { context.fillStyle = "#171f22"; context.fillRect(panel.x, 20, panel.width, 320); context.fillStyle = "#dce6e8"; context.fillText(panel.label, panel.x + panel.width / 2, 40); });
    drawContained(context, sourceImage, 35, 60, 180, 260, { crop: part.boundingBox }); drawContained(context, visibleImage, 260, 60, 180, 260); drawContained(context, reconstructedImage, 485, 60, 180, 260);
    context.fillStyle = "#171f22"; context.fillRect(695, 20, 485, 320); context.fillStyle = "#dce6e8"; context.fillText("Rotation Test", 937, 40);
    const angles = [-20, 0, 20] as const; angles.forEach((angle, index) => { const centerX = 775 + index * 160; const centerY = 190; context.save(); context.translate(centerX, centerY); context.rotate(angle * Math.PI / 180); const scale = Math.min(120 / reconstructedImage.width, 220 / reconstructedImage.height); context.drawImage(reconstructedImage, -reconstructedImage.width * scale / 2, -reconstructedImage.height * scale / 2, reconstructedImage.width * scale, reconstructedImage.height * scale); context.restore(); context.fillStyle = "#8fa0a5"; context.fillText(`${angle}°`, centerX, 320); });
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Reconstruction preview could not be encoded")), "image/png"));
    const resourceId = `rigging://active-project/reconstruction/${encodeURIComponent(partId)}`; const inspectedAt = now();
    if (recordInspection) {
      const reviews = project.reconstructedParts.map((review) => review.partId === partId ? { ...review, previewResourceInspected: resourceId, inspectedAt, inspectedBy: actor } : review);
      this.setProject(updatedProject(project, { reconstructedParts: reviews }));
      this.emit("project.changed", actor, `Inspected reconstruction preview for ${partId}`, partId);
    }
    return this.ok({ partId, mimeType: "image/png", imageBase64: await blobBase64(blob), width: canvas.width, height: canvas.height, resourceId, inspectionRecorded: recordInspection, inspectedAt: recordInspection ? inspectedAt : null });
  }

  private async approveReconstructionProposal(partId: string, actor: string): Promise<CommandResult<JsonObject>> {
    const project = this.requireProject(); const state = this.requirePartCutterState(); const part = state.parts.find((candidate) => candidate.partId === partId); const review = project.reconstructedParts.find((candidate) => candidate.partId === partId);
    if (!part?.reconstructionImage || !review) throw new Error(`Part ${partId} has no reconstruction proposal`);
    if (!review.previewResourceInspected || !review.inspectedAt) throw new Error("Reconstruction approval requires visual inspection of the managed preview in the current review flow");
    const pixels = await browserImagePixels(part.reconstructionImage); const consistency = validateReconstructionAsset(part, pixels.width, pixels.height, { alpha: pixels.alpha });
    if (consistency.status === "REJECT") throw new Error(`Reconstruction cannot be approved: ${consistency.warnings.join("; ")}`);
    const nextState = { ...state, parts: state.parts.map((candidate) => candidate.partId === partId ? { ...candidate, provenance: "reconstructed" as const, occlusionState: "reconstructed" as const } : candidate), finalized: false, updatedAt: now() };
    this.setPartCutterState(nextState, actor, `Approved reconstruction for ${partId}`);
    const current = this.requireProject(); this.setProject(updatedProject(current, { reconstructedParts: current.reconstructedParts.map((candidate) => candidate.partId === partId ? { ...candidate, decision: "reconstruct" as const, reconstructionAccepted: true } : candidate) }));
    return this.ok({ partId, approved: true, consistency, inspection: { resourceId: review.previewResourceInspected, inspectedAt: review.inspectedAt, inspectedBy: review.inspectedBy } });
  }

  private rejectReconstructionProposal(partId: string, reason: string, actor: string): CommandResult<JsonObject> {
    const state = this.requirePartCutterState(); const part = state.parts.find((candidate) => candidate.partId === partId);
    if (!part?.reconstructionImage) throw new Error(`Part ${partId} has no reconstruction proposal`);
    const nextState = { ...state, parts: state.parts.map((candidate) => { if (candidate.partId !== partId) return candidate; const { reconstructionImage, ...original } = candidate; void reconstructionImage; return { ...original, provenance: "manual" as const, occlusionState: "likely-incomplete" as const, notes: [...original.notes, `Reconstruction rejected: ${reason}`] }; }), finalized: false, updatedAt: now() };
    this.setPartCutterState(nextState, actor, `Rejected reconstruction for ${partId}`);
    const current = this.requireProject(); this.setProject(updatedProject(current, { reconstructedParts: current.reconstructedParts.map((candidate) => candidate.partId === partId ? { ...candidate, decision: "keep-visible-fragment" as const, reconstructedImage: undefined, reconstructionAccepted: false, reason: `${candidate.reason}; rejected: ${reason}` } : candidate) }));
    return this.ok({ partId, rejected: true, originalPreserved: true });
  }

  private async finalizePartCuts(actor: string): Promise<CommandResult<JsonObject>> {
    const project = this.requireProject(); const source = project.sourceImage; if (!source) throw new Error("A source image is required"); const state = ensureOwnershipPartition(this.requirePartCutterState()); const segmentationData = partCutToSegmentation(state); if (!segmentationData.parts.length) throw new Error("Accept at least one part before finalizing");
    const extractedParts = await Promise.all(segmentationData.parts.map(async (part) => { const cut = state.parts.find((item) => item.partId === part.id); const extraction = deriveRiggingExtraction(state, part.id); const image = cut?.reconstructionImage ?? await extractPartToDataUrl(source.image, extraction.bounds, extraction.mask, 0); return { partId: part.id, image, width: extraction.bounds.width, height: extraction.bounds.height, padding: extraction.padding, status: cut?.provenance === "reconstructed" ? "reconstructed" as const : "accepted" as const }; }));
    const proposal = buildRigProposal({ name: project.name, parts: segmentationData.parts, imageWidth: source.width, imageHeight: source.height, resolvedImages: Object.fromEntries(extractedParts.map((part) => [part.partId, part.image])), partCutterState: state }); const validated = validateRigProposal(proposal); if (!validated.success) throw new Error(validated.message);
    const finalized = { ...state, finalized: true, updatedAt: now() }; const next = updatedProject(project, { stage: "rig", partCutterState: finalized, segmentationData, extractedParts, reconstructedParts: detectOcclusionReviews(segmentationData.parts), rigDefinition: validated.data.rig, skins: validated.data.rig.skins, warnings: [...project.warnings, ...validated.data.warnings] });
    const candidateAnimations = this.animations ? { ...this.animations, rigId: validated.data.rig.id } : null;
    const candidateProblems = blockingRigProjectProblems(validateRigProject({ storageVersion: LOCAL_PROJECT_STORAGE_VERSION, localProjectId: this.durableProjectId, project: next, rig: validated.data.rig, animations: candidateAnimations, selectedSkinId: validated.data.rig.defaultSkinId }));
    if (candidateProblems.length) throw new Error(`Auto-rig candidate rejected before commit: ${candidateProblems.map((problem) => problem.message).join("; ")}`);
    this.pendingRigProposal = validated.data; this.setProject(next); this.standaloneRig = structuredClone(validated.data.rig); this.animations = candidateAnimations; this.emit("rig.changed", actor, `Finalized ${extractedParts.length} parts into ${validated.data.rig.id}`, validated.data.rig.id); return this.ok({ finalized: true, partCount: extractedParts.length, rig: rigSummary(validated.data.rig, true), nextStep: "open rig editor" }, validated.data.warnings);
  }

  private createRigProposal(actor: string): CommandResult<JsonObject> {
    const project = this.requireProject(); const segmentation = project.segmentationData; const source = project.sourceImage;
    if (!segmentation || !source) throw new Error("Segment the character before creating a rig proposal");
    const proposal = buildRigProposal({ name: project.name, parts: segmentation.parts, imageWidth: source.width, imageHeight: source.height, partCutterState: project.partCutterState });
    const validated = validateRigProposal(proposal); if (!validated.success) throw new Error(validated.message);
    this.pendingRigProposal = proposal; this.emit("rig.changed", actor, `Created rig proposal ${proposal.rig.id}`, proposal.rig.id);
    return this.ok({ proposalId: proposal.rig.id, summary: rigSummary(proposal.rig, true), requiresReview: true }, proposal.warnings);
  }

  private acceptRigProposal(actor: string): CommandResult<JsonObject> {
    if (!this.pendingRigProposal) throw new Error("Create a rig proposal first");
    const validated = validateRigProposal(this.pendingRigProposal); if (!validated.success) throw new Error(validated.message);
    const rig = validated.data.rig;
    const nextProject = this.project ? updatedProject(this.project, { stage: "rig", rigDefinition: rig, skins: rig.skins, warnings: [...this.project.warnings, ...validated.data.warnings] }) : null;
    const nextAnimations = this.animations ? { ...this.animations, rigId: rig.id } : null;
    const candidateProblems = blockingRigProjectProblems(validateRigProject({ storageVersion: LOCAL_PROJECT_STORAGE_VERSION, localProjectId: this.durableProjectId, project: nextProject, rig, animations: nextAnimations, selectedSkinId: rig.defaultSkinId }));
    if (candidateProblems.length) throw new Error(`Auto-rig candidate rejected before commit: ${candidateProblems.map((problem) => problem.message).join("; ")}`);
    if (this.rigAdapter) this.rigAdapter.execute(`Accept agent rig proposal ${rig.id}`, () => rig);
    this.standaloneRig = structuredClone(rig); this.activeSkinId = rig.defaultSkinId;
    this.retargetAnimationsToRig(rig.id);
    if (nextProject) this.setProject(nextProject);
    this.syncRigFromUi(rig, actor); this.emit("rig.changed", actor, `Accepted rig proposal ${rig.id}`, rig.id);
    return this.ok({ rig: rigSummary(rig, true), accepted: true }, validated.data.warnings);
  }

  private getRigSummary(includeHierarchy: boolean, includeFull: boolean): CommandResult<JsonObject> {
    const rig = this.requireRig(); return this.ok({ rig: includeFull ? rig : rigSummary(rig, includeHierarchy) });
  }

  private mutateRig(label: string, transform: (rig: RigDefinition) => RigDefinition, actor: string, eventType: StudioEventType = "rig.changed", entityId?: string): CommandResult<JsonObject> {
    this.projectLifecycle.assertMutationsAllowed();
    const before = this.requireRig();
    const candidate = transform(before);
    const candidateProject = this.project ? updatedProject(this.project, { rigDefinition: candidate, skins: candidate.skins }) : null;
    const candidateAnimations = this.animationAdapter?.getLibrary() ?? this.animations;
    const candidateSnapshot: LocalProjectSnapshot = { storageVersion: LOCAL_PROJECT_STORAGE_VERSION, localProjectId: this.durableProjectId, project: candidateProject, rig: candidate, animations: candidateAnimations, selectedSkinId: this.activeSkinId && candidate.skins.some((skin) => skin.id === this.activeSkinId) ? this.activeSkinId : candidate.defaultSkinId };
    const issues = blockingRigProjectProblems(validateRigProject(candidateSnapshot));
    if (issues.length) throw new Error(`Mutation rejected: ${issues.map((problem) => problem.message).join("; ")}`);
    let next: RigDefinition;
    if (this.rigAdapter) next = this.transactionId ? this.rigAdapter.updateTransaction(() => candidate) : this.rigAdapter.execute(label, () => candidate);
    else next = candidate;
    this.standaloneRig = structuredClone(next);
    if (this.project) this.setProject(updatedProject(this.project, { rigDefinition: next, skins: next.skins }));
    this.session.update({ selectedBoneId: eventType === "bone.changed" ? entityId ?? null : this.session.snapshot.selectedBoneId, dirtyState: true, validationState: { valid: true, errorCount: 0, checkedAt: now() } });
    if (eventType === "bone.changed" && entityId) this.rigAdapter?.setSelectedBone(entityId);
    this.emit(eventType, actor, label, entityId);
    const previousBone = entityId ? before.bones.find((bone) => bone.id === entityId) : undefined;
    const currentBone = entityId ? next.bones.find((bone) => bone.id === entityId) : undefined;
    return this.ok({ id: entityId ?? next.id, previous: previousBone ?? null, current: currentBone ?? null });
  }

  private applySkin(skinId: string, actor: string): CommandResult<JsonObject> {
    const rig = this.requireRig(); if (!rig.skins.some((skin) => skin.id === skinId)) throw new Error(`Skin ${skinId} does not exist`);
    this.activeSkinId = skinId; this.emit("skin.changed", actor, `Applied skin ${skinId}`, skinId);
    return this.ok({ skinId, applied: true });
  }

  private setEquipment(slotId: string, attachmentId: string | null, actor: string): CommandResult<JsonObject> {
    const rig = this.requireRig(); const skinId = this.activeSkinId ?? rig.defaultSkinId;
    return this.mutateRig(`Set equipment ${slotId}`, (current) => assignSkinAttachment(current, skinId, slotId, attachmentId), actor, "slot.changed", slotId);
  }

  private createAnimation(name: string, duration: number, loop: boolean, actor: string): CommandResult<JsonObject> {
    let createdId = "";
    const next = this.mutateAnimations(`Create animation ${name}`, (library) => {
      const result = addAnimation(library, name); createdId = result.animationId;
      return replaceAnimation(result.library, { ...animationById(result.library, createdId)!, duration, loop });
    }, actor);
    if (!next.success) return next;
    this.selectAnimation(createdId);
    return this.ok({ animation: animationSummary(animationById(this.requireAnimations(), createdId)!, true) });
  }

  private async generateAnimation(request: string, requestedName: string | undefined, duration: number, loop: boolean, actor: string): Promise<CommandResult<JsonObject>> {
    const rig = this.requireRig(); const library = this.requireAnimations();
    const operation = this.captureProjectOperation("animation-generation");
    const context = buildAnimationGenerationContext(rig, { request, mode: "create", constraints: { duration, loop, intensity: .65, weight: .65, exaggeration: .45, rootMovementAllowance: 80, preserveTiming: false, preserveContactFrames: true, styleNotes: "Agent-authored studio animation" }, selectedBoneIds: [], leftRightMappings: [], groundPlaneY: rig.canvas.height * .92, leftFootBoneId: rig.bones.find((bone) => /left.*foot/i.test(bone.id))?.id ?? null, rightFootBoneId: rig.bones.find((bone) => /right.*foot/i.test(bone.id))?.id ?? null, contactIntervals: [], referenceAnimations: library.animations, includeSlotNames: true });
    const proposal = await this.animationProvider.generateAnimationProposal({ prompt: request, context });
    this.assertProjectOperationCurrent(operation, "animation-provider");
    const validation = validateAnimationProposal(proposal, rig); if (!validation.success) throw new Error(validation.message);
    const id = uniqueAnimationId(library, requestedName ?? validation.proposal.animation.id);
    const animation = { ...validation.proposal.animation, id, name: requestedName ?? validation.proposal.animation.name };
    this.mutateAnimations(`Generate animation ${id}`, (current) => ({ ...current, animations: [...current.animations, animation] }), actor);
    this.selectAnimation(id);
    return this.ok({ animation: animationSummary(animation, true), proposalSummary: validation.proposal.summary }, validation.warnings);
  }

  private async reviseAnimation(animationId: string, request: string, actor: string): Promise<CommandResult<JsonObject>> {
    const rig = this.requireRig(); const library = this.requireAnimations(); const current = animationById(library, animationId);
    if (!current) throw new Error(`Animation ${animationId} does not exist`);
    const context = buildAnimationGenerationContext(rig, { request, mode: "revise", currentAnimation: current, constraints: { duration: current.duration, loop: current.loop, intensity: .65, weight: .8, exaggeration: .45, rootMovementAllowance: 80, preserveTiming: true, preserveContactFrames: true, styleNotes: request }, selectedBoneIds: [], leftRightMappings: [], groundPlaneY: rig.canvas.height * .92, leftFootBoneId: rig.bones.find((bone) => /left.*foot/i.test(bone.id))?.id ?? null, rightFootBoneId: rig.bones.find((bone) => /right.*foot/i.test(bone.id))?.id ?? null, contactIntervals: [], referenceAnimations: library.animations.filter((animation) => animation.id !== animationId), includeSlotNames: true });
    const operation = this.captureProjectOperation("animation-revision");
    const proposal = await this.animationProvider.generateAnimationProposal({ prompt: request, context, refinement: request });
    this.assertProjectOperationCurrent(operation, "animation-provider");
    const validation = validateAnimationProposal(proposal, rig); if (!validation.success) throw new Error(validation.message);
    const revised = { ...validation.proposal.animation, id: animationId, name: current.name };
    this.mutateAnimations(`Revise animation ${animationId}`, (document) => replaceAnimation(document, revised), actor);
    this.selectAnimation(animationId);
    return this.ok({ animation: animationSummary(revised, true), proposalSummary: validation.proposal.summary }, validation.warnings);
  }

  private getAnimationSummary(animationId: string, includeTracks: boolean, includeFull: boolean): CommandResult<JsonObject> {
    const animation = animationById(this.requireAnimations(), animationId); if (!animation) throw new Error(`Animation ${animationId} does not exist`);
    return this.ok({ animation: includeFull ? animation : animationSummary(animation, includeTracks) });
  }

  private setKeyframe(animationId: string, boneId: string, property: AnimatedProperty, time: number, value: number, easing: Easing, actor: string): CommandResult<JsonObject> {
    const rig = this.requireRig(); if (!rig.bones.some((bone) => bone.id === boneId)) throw new Error(`Bone ${boneId} does not exist`);
    this.mutateAnimations(`Set ${boneId}.${property} keyframe`, (library) => {
      const animation = animationById(library, animationId); if (!animation) throw new Error(`Animation ${animationId} does not exist`);
      if (time > animation.duration) throw new Error(`Keyframe time ${time} exceeds animation duration ${animation.duration}`);
      const next = upsertKeyframe(animation, boneId, property, { time, value, easing });
      const validation = safeParseAnimationDefinition(next, rig); if (!validation.success) throw new Error(validation.message);
      return replaceAnimation(library, validation.data);
    }, actor);
    return this.ok({ animationId, boneId, property, time, value, easing });
  }

  private deleteKeyframe(animationId: string, boneId: string, property: AnimatedProperty, time: number, actor: string): CommandResult<JsonObject> {
    this.mutateAnimations(`Delete ${boneId}.${property} keyframe`, (library) => {
      const animation = animationById(library, animationId); if (!animation) throw new Error(`Animation ${animationId} does not exist`);
      return replaceAnimation(library, removeKeyframes(animation, [{ boneId, property, time }]));
    }, actor);
    return this.ok({ animationId, boneId, property, time, deleted: true });
  }

  private removeAnimation(animationId: string, actor: string): CommandResult<JsonObject> {
    const library = this.requireAnimations(); if (!animationById(library, animationId)) throw new Error(`Animation ${animationId} does not exist`);
    this.mutateAnimations(`Delete animation ${animationId}`, (current) => deleteAnimation(current, animationId), actor);
    const nextId = this.requireAnimations().animations[0]?.id ?? null; this.selectAnimation(nextId);
    return this.ok({ animationId, deleted: !animationById(this.requireAnimations(), animationId), selectedAnimationId: nextId });
  }

  private mutateAnimations(label: string, transform: (library: AnimationLibrary) => AnimationLibrary, actor: string): CommandResult<JsonObject> {
    this.projectLifecycle.assertMutationsAllowed();
    const attached = this.animationAdapter;
    const candidate = transform(this.requireAnimations());
    candidate.animations.forEach((animation) => { const result = safeParseAnimationDefinition(animation, this.requireRig()); if (!result.success) throw new Error(result.message); });
    const candidateSnapshot: LocalProjectSnapshot = { storageVersion: LOCAL_PROJECT_STORAGE_VERSION, localProjectId: this.durableProjectId, project: this.project, rig: this.requireRig(), animations: candidate, selectedSkinId: this.activeSkinId };
    const problems = blockingRigProjectProblems(validateRigProject(candidateSnapshot));
    if (problems.length) throw new Error(`Mutation rejected: ${problems.map((problem) => problem.message).join("; ")}`);
    const next = attached ? attached.execute(label, () => candidate) : candidate;
    this.animations = structuredClone(next);
    if (!attached) this.pendingAnimationCommands.push({ label, library: structuredClone(next) });
    this.projectLifecycle.recordMutation();
    this.session.update({ dirtyState: true }); this.emit("animation.changed", actor, label, this.session.snapshot.selectedAnimationId ?? undefined); this.notifyDurableListeners();
    return this.ok({ animationCount: next.animations.length });
  }

  private selectAnimation(animationId: string | null): void {
    if (animationId && this.animationAdapter) this.animationAdapter.setActiveAnimation(animationId);
    this.session.update({ selectedAnimationId: animationId });
  }

  private playback(action: "play" | "pause" | "seek", animationId: string | undefined, time: number | undefined, actor: string): CommandResult<JsonObject> {
    if (animationId) { if (!animationById(this.requireAnimations(), animationId)) throw new Error(`Animation ${animationId} does not exist`); this.selectAnimation(animationId); }
    this.animationAdapter?.setPlayback(action, time);
    this.emit("animation.playback.changed", actor, `${action}${time === undefined ? "" : ` at ${time.toFixed(3)}s`}`, animationId ?? this.session.snapshot.selectedAnimationId ?? undefined);
    return this.ok({ action, animationId: animationId ?? this.session.snapshot.selectedAnimationId, time: time ?? null });
  }

  private async renderPreview(animationId: string, frameCount: number, width: number, overlays: readonly string[], actor: string): Promise<CommandResult<JsonObject>> {
    const rig = this.requireRig(); const animation = animationById(this.requireAnimations(), animationId); if (!animation) throw new Error(`Animation ${animationId} does not exist`);
    const overlay = (name: string): boolean => overlays.includes(name);
    const frameWidth = Math.max(160, Math.floor(width / Math.min(frameCount, 4)));
    const plan = createDiagnosticCapturePlan(animation, { frameCount, frameWidth, maxContactSheetWidth: width, overlays: { bones: overlay("bones"), boneNames: overlay("boneNames"), jointPoints: overlay("jointPoints") || overlay("bones"), slotBounds: overlay("slotBounds"), groundLine: overlay("ground"), rootTrajectory: overlay("rootTrajectory"), footTrajectories: overlay("footTrajectories"), motionArcs: overlay("motionArcs") } });
    const renderer = new DiagnosticFrameRenderer();
    const operation = this.captureProjectOperation("preview-render");
    const captured = await renderer.capture(rig, animation, plan, { groundPlaneY: rig.canvas.height * .92, leftFootBoneId: rig.bones.find((bone) => /left.*foot/i.test(bone.id))?.id ?? null, rightFootBoneId: rig.bones.find((bone) => /right.*foot/i.test(bone.id))?.id ?? null });
    this.assertProjectOperationCurrent(operation, "preview-renderer");
    const renderId = `render-${Date.now().toString(36)}-${(++this.operationSequence).toString(36)}`;
    this.latestPreview = { renderId, animationId, mimeType: "image/png", imageBase64: await blobBase64(captured.contactSheet), width: plan.contactSheetWidth, height: plan.contactSheetHeight, frameCount: plan.frameCount, frameTimes: plan.times, warnings: [], diagnostics: [`${plan.frameCount} deterministic samples`, `${plan.contactSheetWidth}×${plan.contactSheetHeight} contact sheet`] };
    this.session.update({ lastRenderId: renderId }); this.emit("preview.rendered", actor, `Rendered ${animationId} preview`, renderId);
    return this.ok({ preview: this.latestPreview });
  }

  private async renderImageCandidateSheet(proposalId: string, requestedWidth: number): Promise<CommandResult<JsonObject>> {
    if (typeof document === "undefined") throw new Error("Candidate sheets require the running browser Studio");
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(proposalId)) throw new Error("Invalid proposal ID");
    const bridgeUrl = process.env.NEXT_PUBLIC_RIGGING_STUDIO_BRIDGE_URL ?? "http://127.0.0.1:47831";
    const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/image-production/proposals/${encodeURIComponent(proposalId)}/candidates`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load proposal candidates (${response.status})`);
    const payload = await response.json() as { readonly candidates?: readonly { readonly candidateId: string; readonly imageUrl: string; readonly width: number; readonly height: number; readonly seed: number; readonly suitabilityScore?: number }[] };
    const candidates = payload.candidates ?? [];
    if (!candidates.length) throw new Error("Proposal has no candidates to render");
    const width = Math.max(480, Math.min(2400, requestedWidth)); const columns = candidates.length === 1 ? 1 : 2;
    const gutter = 18; const outer = 24; const labelHeight = 48; const cellWidth = Math.floor((width - outer * 2 - gutter * (columns - 1)) / columns);
    const imageHeight = Math.round(cellWidth * .82); const cellHeight = labelHeight + imageHeight;
    const rows = Math.ceil(candidates.length / columns); const height = outer * 2 + rows * cellHeight + Math.max(0, rows - 1) * gutter;
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas rendering is unavailable");
    context.fillStyle = "#11151a"; context.fillRect(0, 0, width, height); context.font = "600 15px ui-monospace, SFMono-Regular, monospace"; context.textBaseline = "middle";
    const images = await Promise.all(candidates.map((candidate) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image(); image.crossOrigin = "anonymous"; image.onload = () => resolve(image); image.onerror = () => reject(new Error(`Could not load ${candidate.candidateId}`)); image.src = candidate.imageUrl;
    })));
    candidates.forEach((candidate, index) => {
      const column = index % columns; const row = Math.floor(index / columns); const x = outer + column * (cellWidth + gutter); const y = outer + row * (cellHeight + gutter);
      context.fillStyle = "#1b222a"; context.fillRect(x, y, cellWidth, cellHeight); context.fillStyle = "#dce6ed"; context.fillText(candidate.candidateId, x + 12, y + 17);
      context.fillStyle = "#8fa0ad"; context.font = "12px ui-monospace, SFMono-Regular, monospace";
      const score = candidate.suitabilityScore === undefined ? "suitability pending" : `suitability ${Math.round(candidate.suitabilityScore * 100)}%`;
      context.fillText(`seed ${candidate.seed} · ${candidate.width}×${candidate.height} · ${score}`, x + 12, y + 36); context.font = "600 15px ui-monospace, SFMono-Regular, monospace";
      const image = images[index]; const availableHeight = imageHeight - 16; const scale = Math.min((cellWidth - 16) / image.naturalWidth, availableHeight / image.naturalHeight);
      const drawWidth = Math.round(image.naturalWidth * scale); const drawHeight = Math.round(image.naturalHeight * scale); const drawX = x + Math.round((cellWidth - drawWidth) / 2); const drawY = y + labelHeight + Math.round((imageHeight - drawHeight) / 2);
      context.fillStyle = "#d2d7d9"; context.fillRect(x + 8, y + labelHeight + 8, cellWidth - 16, imageHeight - 16); context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
    });
    const dataUrl = canvas.toDataURL("image/png");
    return this.ok({ proposalId, imageBase64: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/png", width, height, candidateIds: candidates.map((candidate) => candidate.candidateId) });
  }

  private async analyzeImageCandidateSuitability(proposalId: string, candidateId: string, imageUrl: string, width: number, height: number, prompt: string): Promise<CommandResult<JsonObject>> {
    const bridgeUrl = process.env.NEXT_PUBLIC_RIGGING_STUDIO_BRIDGE_URL ?? "http://127.0.0.1:47831";
    const expectedPrefix = `${bridgeUrl.replace(/\/$/, "")}/image-production/assets/${encodeURIComponent(proposalId)}/`;
    if (!imageUrl.startsWith(expectedPrefix)) throw new Error("Suitability analysis accepts only managed image-production candidate URLs");
    const response = await fetch(imageUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Managed candidate image is unavailable (${response.status})`);
    const blob = await response.blob();
    if (blob.type !== "image/png" && blob.type !== "image/jpeg") throw new Error("Managed candidate must be a PNG or JPEG");
    const image = `data:${blob.type};base64,${await blobBase64(blob)}`;
    const suitability = await this.characterProvider.checkSuitability({ image, width, height, userPrompt: prompt });
    return this.ok({ proposalId, candidateId, suitability });
  }

  private async prepareImageRepairContext(projectId: string, targetPartId: string): Promise<CommandResult<JsonObject>> {
    const project = this.requireProject();
    if (project.id !== projectId) throw new Error(`Project ${projectId} is not active`);
    const source = project.sourceImage; const part = project.segmentationData?.parts.find((candidate) => candidate.id === targetPartId);
    if (!source || !part) throw new Error("Repair source image or selected part is unavailable");
    const response = await fetch(source.image, { cache: "no-store" }); if (!response.ok) throw new Error(`Repair source image is unavailable (${response.status})`);
    const sourceBlob = await response.blob(); if (sourceBlob.type !== "image/png" && sourceBlob.type !== "image/jpeg") throw new Error("Repair source must be a PNG or JPEG");
    const canvas = document.createElement("canvas"); canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Repair mask canvas is unavailable");
    context.fillStyle = "black"; context.fillRect(0, 0, canvas.width, canvas.height);
    const bounds = part.bounds; const mask = part.mask; const maskWidth = mask?.width ?? Math.max(1, Math.round(bounds.width)); const maskHeight = mask?.height ?? Math.max(1, Math.round(bounds.height));
    const maskCanvas = document.createElement("canvas"); maskCanvas.width = maskWidth; maskCanvas.height = maskHeight; const maskContext = maskCanvas.getContext("2d");
    if (!maskContext) throw new Error("Repair part-mask canvas is unavailable");
    const imageData = maskContext.createImageData(maskWidth, maskHeight);
    for (let index = 0; index < maskWidth * maskHeight; index += 1) {
      const visible = (mask?.alpha[index] ?? 255) > 0; const offset = index * 4;
      imageData.data[offset] = visible ? 255 : 0; imageData.data[offset + 1] = visible ? 255 : 0; imageData.data[offset + 2] = visible ? 255 : 0; imageData.data[offset + 3] = 255;
    }
    maskContext.putImageData(imageData, 0, 0); context.drawImage(maskCanvas, bounds.x, bounds.y, bounds.width, bounds.height);
    const maskBlob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Repair mask could not be encoded")), "image/png"));
    return this.ok({ projectId, targetPartId, sourceImage: { mimeType: sourceBlob.type, imageBase64: await blobBase64(sourceBlob) }, maskImage: { mimeType: "image/png", imageBase64: await blobBase64(maskBlob) } });
  }

  private getValidation(includeDetails: boolean): CommandResult<JsonObject> {
    const problems = validateRigProject({ storageVersion: LOCAL_PROJECT_STORAGE_VERSION, localProjectId: this.durableProjectId, project: this.project, rig: this.requireRig(), animations: this.requireAnimations(), selectedSkinId: this.activeSkinId }, { boneIds: this.session.snapshot.selectedBoneId ? [this.session.snapshot.selectedBoneId] : [], animationId: this.session.snapshot.selectedAnimationId });
    const blocking = blockingRigProjectProblems(problems); const valid = blocking.length === 0;
    this.session.update({ validationState: { valid, errorCount: blocking.length, checkedAt: now() } });
    return this.ok({ valid, errorCount: blocking.length, warningCount: problems.length - blocking.length, ...(includeDetails ? { problems } : {}) });
  }

  private beginTransaction(label: string, actor: string): CommandResult<JsonObject> {
    if (this.transactionId) throw new Error(`Transaction ${this.transactionId} is already active`);
    if (!this.rigAdapter) throw new Error("Transactions require the running Rig Editor");
    this.transactionId = `tx-${Date.now().toString(36)}-${(++this.operationSequence).toString(36)}`; this.rigAdapter.beginTransaction(label);
    this.emit("project.changed", actor, `Began transaction ${label}`, this.transactionId);
    return this.ok({ transactionId: this.transactionId, label });
  }

  private commitTransaction(transactionId: string, actor: string): CommandResult<JsonObject> {
    this.assertTransaction(transactionId); const next = this.rigAdapter!.commitTransaction(); this.transactionId = null; this.syncRigFromUi(next, actor);
    this.emit("rig.changed", actor, "Committed compound rig edit", next.id); return this.ok({ transactionId, committed: true });
  }

  private rollbackTransaction(transactionId: string, actor: string): CommandResult<JsonObject> {
    this.assertTransaction(transactionId); const next = this.rigAdapter!.rollbackTransaction(); this.transactionId = null; this.syncRigFromUi(next, actor);
    this.emit("rig.changed", actor, "Rolled back compound rig edit", next.id); return this.ok({ transactionId, rolledBack: true });
  }

  private assertTransaction(transactionId: string): void { if (!this.transactionId || transactionId !== this.transactionId || !this.rigAdapter) throw new Error(`Transaction ${transactionId} is not active`); }

  private async createCharacterFromPrompt(name: string, prompt: string, autoAcceptSafeSteps: boolean, requireNovelArtwork: boolean, actor: string): Promise<CommandResult<JsonObject>> {
    const created = this.createProject(name, prompt, actor); if (!created.success) return created;
    const awaiting = this.requireProject();
    if (requireNovelArtwork && this.characterProvider.id === "local-mock") {
      return this.ok({
        projectId: awaiting.id, stageReached: "awaiting_generation", requiresExternalGeneration: true,
        requiresReview: true, novelArtwork: false, provider: this.characterProvider.id,
      }, ["The configured provider is a deterministic fixture. Generate externally and call character_import_generation."]);
    }
    const generation = await this.generateImage("generate", actor); if (!generation.success) return generation;
    if (requireNovelArtwork && this.requireProject().sourceImage?.novelArtwork !== true) {
      return this.ok({
        projectId: this.requireProject().id, stageReached: "awaiting_generation", requiresExternalGeneration: true,
        requiresReview: true, novelArtwork: false, provider: this.characterProvider.id,
      }, ["The configured provider did not return novel artwork. Generate externally and call character_import_generation."]);
    }
    const suitability = await this.runSuitability(actor); if (!suitability.success) return suitability;
    const project = this.requireProject();
    if (!autoAcceptSafeSteps || !project.suitability?.usable || project.suitability.issues.some((issue) => issue.severity === "blocking")) {
      return this.ok({ projectId: project.id, stageReached: "generation_review", generationId: project.sourceImage?.generationId ?? null, requiresReview: true }, project.warnings);
    }
    const segmented = await this.segmentCharacter(actor); if (!segmented.success) return segmented;
    return this.ok({ projectId: project.id, stageReached: "segmentation_review", generationId: project.sourceImage?.generationId ?? null, requiresReview: true }, project.warnings);
  }

  private setProject(project: GeneratedCharacterProject, explicitActivation = false, preserveDurableIdentity = false): void {
    if (explicitActivation) {
      this.activationVersion += 1; this.activationSource = "explicit";
      if (!preserveDurableIdentity) {
        this.durableProjectId = null;
        this.projectLifecycle.activateInitial(project.id);
      }
    } else if (!this.projectLifecycle.snapshot.switching && this.projectLifecycle.snapshot.activeProjectId === project.id) {
      this.projectLifecycle.recordMutation(project.id);
    }
    this.project = structuredClone(project); this.projectAdapter?.replaceProject(project);
    if (project.rigDefinition) this.standaloneRig = structuredClone(project.rigDefinition);
    this.session.update({
      activeProjectId: project.id, activeStage: project.stage,
      selectedRigId: project.rigDefinition?.id ?? (explicitActivation ? null : this.session.snapshot.selectedRigId),
      ...(explicitActivation ? { selectedAnimationId: null, selectedBoneId: null } : {}),
      dirtyState: true, warnings: project.warnings,
    });
    this.notifyDurableListeners();
  }

  private retargetAnimationsToRig(rigId: string): void {
    if (this.animations && this.animations.rigId !== rigId) this.animations = { ...this.animations, rigId };
    this.pendingAnimationCommands = this.pendingAnimationCommands.map((command) => ({ ...command, library: { ...command.library, rigId } }));
  }

  private requireProject(): GeneratedCharacterProject { if (!this.project) throw new Error("No active character project"); return this.project; }
  private requireRig(): RigDefinition {
    if (this.project && !this.project.rigDefinition && this.session.snapshot.selectedRigId === null) throw new Error("No active rig");
    const rig = this.rigAdapter?.getRig() ?? this.projectAdapter?.getProject().rigDefinition ?? this.project?.rigDefinition ?? this.standaloneRig;
    if (!rig) throw new Error("No active rig");
    return rig;
  }
  private requireAnimations(): AnimationLibrary {
    const existing = this.animationAdapter?.getLibrary() ?? this.animations;
    if (existing) return existing;
    const created = createAnimationLibrary(this.requireRig().id, []); this.animations = created; return created;
  }
}

let sharedService: RiggingCommandService | null = null;
export const getRiggingCommandService = (): RiggingCommandService => sharedService ??= new RiggingCommandService();
