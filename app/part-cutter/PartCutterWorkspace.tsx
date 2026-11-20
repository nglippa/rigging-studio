"use client";
/* eslint-disable @next/next/no-img-element -- local imports and provider images are user-controlled */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { getRiggingCommandService } from "@/src/agent-control";
import { useAgentBridge } from "@/src/agent-control/protocol/useAgentBridge";
import { createGeneratedCharacterProject, type GeneratedCharacterProject } from "@/src/character-generation/project/generatedCharacterProject";
import { getGeneratedCharacterStorage } from "@/src/character-generation/project/generatedCharacterStorage";
import { writeRigEditorHandoffPointer } from "@/src/character-generation/project/rigEditorHandoff";
import { HttpCharacterPipelineProvider } from "@/src/character-generation/providers/httpCharacterPipelineProvider";
import type { CharacterImageGenerationResult, CharacterPipelineCapabilities, CharacterPipelineProvider } from "@/src/character-generation/providers/characterPipelineProvider";
import { buildCharacterConsistencyContext } from "@/src/character-generation/context/characterConsistencyContext";
// The shared reader sets crossOrigin. Source images come from the local bridge, a different origin, and a local copy
// without it tainted the canvas, so foreground analysis always failed and Use Guide stayed disabled.
import { estimateForeground, extractPartToDataUrl, pixelImageToDataUrl, readImagePixels } from "@/src/character-generation/segmentation/partImageProcessor";
import { detectPose } from "@/src/character-generation/pose/poseDetector";
import { forgetActiveDiskProject } from "@/app/studio-ui/ProjectStorageMenu";
import { takeStageNotice } from "@/app/studio-ui/stageNotice";
import { estimateView, poseToLandmarks, type ViewEstimate } from "@/src/character-generation/pose/poseLandmarks";
import { prepareRiggedPartArt, type HiddenAreaRepaint } from "@/src/character-generation/rigging/riggedPartArt";
import { REBUILD_REQUEST_KEY, parseRebuildRequest } from "@/app/rig-editor/RigNotices";
import type { Rect, SegmentationMask } from "@/src/character-generation/segmentation/segmentationSchema";
import { buildRigProposal, sourcePixelScale } from "@/src/character-generation/rigging/rigProposalBuilder";
import { validateRigProposal } from "@/src/character-generation/rigging/rigProposalValidator";
import { detectOcclusionReviews } from "@/src/character-generation/occlusion/occlusionRepair";
import {
  PART_SEMANTIC_TYPES, SEMANTIC_TAXONOMY, SnapshotCommandHistory, acceptProposal, analyzeCoverage, assignOwnershipSelection, changedOwnershipPixels,
  anatomicalGuidePrompt, buildAdaptiveAnatomicalPartitionGuide, buildAnatomicalPartitionGuide, createPartCutterState, cutterStateFor, ensureOwnershipPartition, evaluateRotationTest, guidedProposalFromSegmentation, mergeParts, moveAdaptiveLandmark, ownerAt, partCutToSegmentation, recordOwnershipRelabel, rejectProposal,
  removeOwnershipRegion, reshapeRegionEdge, riggingPaddingFor, setRiggingPadding, simplifiedRegionContour, unresolvedMask,
  semanticLabel, semanticShortcut, splitPart, createManualRegionFromSelection, intersectSelectionWithForeground, derivePrepareWorkflowState,
  GUIDED_BODY_ORDER, GUIDED_EQUIPMENT_ORDER, GUIDED_BENCHMARK_COHORT, GUIDED_BENCHMARK_STORAGE_KEY, backGuidedSemantic, commitGuidedSelection, createGuidedBenchmarkRun,
  applyPoseLandmarks, changedZoneSemantics, recutFromGuide, type GuideProportions, finishGuidedBenchmarkCharacter, finishGuidedBody, finishGuidedEquipment, guideAllBodyParts, guideSelectionForCurrent, guidedBenchmarkCounts, initializeGuidedManual,
  nextGuidedBenchmarkCharacter, parseGuidedBenchmarkRun, recordGuidedBenchmarkEvent, serializeGuidedBenchmarkRun, setGuidedIntent, skipGuidedSemantic,
  startGuidedBenchmarkCharacter, unresolvedComponents,
  type AnatomicalLandmarkId, type PartCutMode, type PartCutRecord, type PartCutterState, type PartSemanticType, type ManualSelectionMode, type PrepareWorkflowState,
  type GuidedBenchmarkAction, type GuidedBenchmarkRun, type GuidedSelection,
  chooseHeldObjects, mergeHeldPieces, foldLegsIntoSkirt, SKIRT_WORDS, commitHeldObjects, heldObjectHand, armItself, heldObjectSeeds, hiddenGuideSemantics, selectionFromCanvasMask, validatePrepare, validateReassembly, validateReconstructionAsset, viewportPointToSource, PART_CUTTER_IMPORT_KEY, type AnatomyProfile, type PartCutterImportPayload, type PrepareIssue,
} from "@/src/part-cutter";
import { StudioCommandPalette, type StudioCommand } from "@/app/studio-ui/StudioCommandPalette";
import { humanizeTechnicalId } from "@/app/studio-ui/humanize";
import { presentAgentStatus } from "@/app/studio-ui/agentStatus";
import { StepShell } from "@/app/studio-ui/StepShell";
import type { StepState } from "@/app/studio-ui/steps";
import { StudioDialog } from "@/app/studio-ui/StudioDialog";
import { OptionalServiceRetryBackoff } from "@/src/local-services/retryBackoff";
import { DEFAULT_OLLAMA_SETTINGS, OllamaProvider, loadOllamaSettings, saveOllamaSettings, type AssistantProposal, type IntelligenceProviderStatus, type OllamaSettings } from "@/src/intelligence";
import { LOCAL_PROJECT_STORAGE_VERSION } from "@/src/project-storage/types";
import { blockingRigProjectProblems, validateRigProject } from "@/src/rigging/validation/project";
import { publishIntegrityEvidence } from "@/src/diagnostics/integrityEvidence";
import { useProjectHydrationIdentity } from "@/app/studio-ui/ProjectHydrationBoundary";
import { useProviderHealth } from "@/app/studio-ui/useProviderHealth";
import { characterPipelineCapabilitiesFromHealth, type ProviderHealthSnapshot } from "@/src/local-services/providerHealth";

type Selection = { readonly bounds: Rect; readonly mask: SegmentationMask };
type Tool = "select" | "reshape" | "lasso" | "polygon" | "brush" | "pan" | "click";
type BoundaryDrag = { readonly base: PartCutterState; readonly partId: string; readonly edge: "top" | "right" | "bottom" | "left" };
type LandmarkDrag = { readonly base: PartCutterState; readonly landmarkId: AnatomicalLandmarkId };
type VisionReviewProviderStatus = { readonly providerId: string; readonly label: string; readonly state: string; readonly available: boolean; readonly multimodal: boolean; readonly transport: string; readonly failureReason: string | null };
type VisionReviewStatus = { readonly policy: { readonly policy: string; readonly maxAttempts: number }; readonly providers: readonly VisionReviewProviderStatus[] };

const now = (): string => new Date().toISOString();
const projectPatch = (project: GeneratedCharacterProject, patch: Partial<GeneratedCharacterProject>): GeneratedCharacterProject => ({ ...project, ...patch, updatedAt: now() });
const pointInSource = (event: ReactPointerEvent<SVGSVGElement>, width: number, height: number) => viewportPointToSource(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), width, height);
const boundsForPoints = (points: readonly { x: number; y: number }[], width: number, height: number): Rect | null => { if (points.length < 2) return null; const x = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x)))); const y = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y)))); const right = Math.min(width, Math.ceil(Math.max(...points.map((point) => point.x)))); const bottom = Math.min(height, Math.ceil(Math.max(...points.map((point) => point.y)))); return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null; };

async function imageDimensions(source: string): Promise<{ width: number; height: number }> { const image = new Image(); image.src = source; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; }
function polygonSelection(points: readonly { x: number; y: number }[], sourceWidth: number, sourceHeight: number): Selection | null { const bounds = boundsForPoints(points, sourceWidth, sourceHeight); if (!bounds) return null; const canvas = document.createElement("canvas"); canvas.width = bounds.width; canvas.height = bounds.height; const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) return null; context.fillStyle = "#fff"; context.beginPath(); points.forEach((point, index) => index ? context.lineTo(point.x - bounds.x, point.y - bounds.y) : context.moveTo(point.x - bounds.x, point.y - bounds.y)); context.closePath(); context.fill(); const data = context.getImageData(0, 0, bounds.width, bounds.height).data; return { bounds, mask: { width: bounds.width, height: bounds.height, alpha: Array.from({ length: bounds.width * bounds.height }, (_, index) => data[index * 4 + 3]) } };
}
function circleSelection(point: { readonly x: number; readonly y: number }, radius: number, sourceWidth: number, sourceHeight: number): Selection {
  const x = Math.max(0, Math.floor(point.x - radius)); const y = Math.max(0, Math.floor(point.y - radius)); const right = Math.min(sourceWidth, Math.ceil(point.x + radius + 1)); const bottom = Math.min(sourceHeight, Math.ceil(point.y + radius + 1)); const width = Math.max(1, right - x); const height = Math.max(1, bottom - y);
  return { bounds: { x, y, width, height }, mask: { width, height, alpha: Array.from({ length: width * height }, (_, index) => Math.hypot(index % width + x - point.x, Math.floor(index / width) + y - point.y) <= radius ? 255 : 0) } };
}
function maskSvgPath(mask: SegmentationMask, bounds: Rect): string {
  const path: string[] = []; const left = Math.round(bounds.x); const top = Math.round(bounds.y);
  for (let y = 0; y < mask.height; y += 1) { let x = 0; while (x < mask.width) { while (x < mask.width && (mask.alpha[y * mask.width + x] ?? 0) === 0) x += 1; const start = x; while (x < mask.width && (mask.alpha[y * mask.width + x] ?? 0) > 0) x += 1; if (x > start) path.push(`M${left + start} ${top + y}h${x - start}v1h-${x - start}z`); } }
  return path.join("");
}
type PartStatus = "ready" | "missing" | "review" | "hidden";
// "hidden": the guide found this part behind its twin (the far leg of a side view); the rig draws it from the near one.
const PART_STATUS: Readonly<Record<PartStatus, { readonly glyph: string; readonly word: string }>> = { ready: { glyph: "✓", word: "Ready" }, missing: { glyph: "○", word: "Missing" }, review: { glyph: "!", word: "Needs review" }, hidden: { glyph: "◌", word: "Hidden" } };
const BODY_CHECKLIST: readonly { readonly heading?: string; readonly rows: readonly (readonly [PartSemanticType, string])[] }[] = [
  { rows: [["head", "Head"], ["torso", "Torso"]] },
  { heading: "Left arm", rows: [["leftUpperArm", "Upper arm"], ["leftForearm", "Forearm"], ["leftHand", "Hand"]] },
  { heading: "Right arm", rows: [["rightUpperArm", "Upper arm"], ["rightForearm", "Forearm"], ["rightHand", "Hand"]] },
  { heading: "Left leg", rows: [["leftThigh", "Thigh"], ["leftLowerLeg", "Lower leg"], ["leftFoot", "Foot"]] },
  { heading: "Right leg", rows: [["rightThigh", "Thigh"], ["rightLowerLeg", "Lower leg"], ["rightFoot", "Foot"]] },
];
const isBodySemantic = (semanticType: PartSemanticType): boolean => (GUIDED_BODY_ORDER as readonly PartSemanticType[]).includes(semanticType);

export function PartCutterWorkspace() {
  const router = useRouter(); const commandService = useMemo(() => getRiggingCommandService(), []); const agent = useAgentBridge(commandService);
  const hydrationIdentity = useProjectHydrationIdentity();
  const { health: providerHealth, retry: retryProvider, reportFailure: reportProviderFailure } = useProviderHealth();
  const characterStorage = useMemo(() => getGeneratedCharacterStorage(), []);
  const provider = useMemo<CharacterPipelineProvider>(() => new HttpCharacterPipelineProvider(process.env.NEXT_PUBLIC_CHARACTER_PIPELINE_ENDPOINT ?? "http://127.0.0.1:47831/character-pipeline"), []);
  const providerCapabilities = useMemo(() => characterPipelineCapabilitiesFromHealth(providerHealth), [providerHealth]);
  const [project, setProject] = useState<GeneratedCharacterProject>(() => createGeneratedCharacterProject("Imported Character", "")); const [state, setState] = useState<PartCutterState | null>(null); const historyRef = useRef<SnapshotCommandHistory<PartCutterState> | null>(null); const projectRef = useRef(project);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null); const [hoveredPartId, setHoveredPartId] = useState<string | null>(null); const [isolatedPartId, setIsolatedPartId] = useState<string | null>(null); const [selectedProposalIds, setSelectedProposalIds] = useState<Set<string>>(new Set()); const [mode, setMode] = useState<PartCutMode>("manual"); const [tool, setTool] = useState<Tool>("select"); const [semantic, setSemantic] = useState<PartSemanticType>("head"); const [selection, setSelection] = useState<Selection | null>(null); const [path, setPath] = useState<readonly { x: number; y: number }[]>([]); const [drawing, setDrawing] = useState(false); const [brushSize, setBrushSize] = useState(12); const [prompt, setPrompt] = useState("Refine the seeded anatomical zones around the character silhouette. Flag any occluded limbs."); const [busy, setBusy] = useState<string | null>(null); const [message, setMessage] = useState("Press Cut all parts, or draw a loop around each part in turn"); const [error, setError] = useState<string | null>(null); const [showCoverage, setShowCoverage] = useState(true); const [showParts, setShowParts] = useState(true); const [showNames, setShowNames] = useState(false); const [showGuide, setShowGuide] = useState(true); const [commandPaletteOpen, setCommandPaletteOpen] = useState(false); const [partPreview, setPartPreview] = useState<string | null>(null); const [zoom, setZoom] = useState(1);
  const [foreground, setForeground] = useState<readonly number[] | undefined>();
  /** The source picture's colours (RGBA), kept for steps that need more than its silhouette. */
  const sourceColoursRef = useRef<Uint8ClampedArray | null>(null);
  const [foregroundStatus, setForegroundStatus] = useState("Import a source to analyze its foreground");
  const [foregroundRevision, setForegroundRevision] = useState(0);
  const [anatomyProfile, setAnatomyProfile] = useState<AnatomyProfile>("humanoid");
  const [, setSelectedLandmarkId] = useState<AnatomicalLandmarkId | null>(null);
  const [confirmGuideRegeneration, setConfirmGuideRegeneration] = useState(false);
  const [pendingPartDeletion, setPendingPartDeletion] = useState<{ readonly label: string; readonly partId: string; readonly transform: (current: PartCutterState) => PartCutterState } | null>(null);
  const confirmedPartDeletionRef = useRef(false);
  const [prepareIssues, setPrepareIssues] = useState<readonly PrepareIssue[]>([]);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  const [storedProjectBytes, setStoredProjectBytes] = useState<number | null>(null);
  const [historyUi, setHistoryUi] = useState({ canUndo: false, canRedo: false, undoLabel: null as string | null });
  const [manualIntent, setManualIntent] = useState<ManualSelectionMode>("new");
  const [customLabel, setCustomLabel] = useState("");
  const [preparePhase, setPreparePhase] = useState<PrepareWorkflowState>("SOURCE_READY");
  const [toastVisible, setToastVisible] = useState(true);
  const [ollamaSettings, setOllamaSettings] = useState<OllamaSettings>(() => typeof window === "undefined" ? DEFAULT_OLLAMA_SETTINGS : loadOllamaSettings(window.localStorage));
  const [ollamaStatus, setOllamaStatus] = useState<IntelligenceProviderStatus | null>(null);
  const [ollamaSettingsOpen, setOllamaSettingsOpen] = useState(false);
  const [visionReviewStatus, setVisionReviewStatus] = useState<VisionReviewStatus | null>(null);
  const [visionReviewStatusError, setVisionReviewStatusError] = useState<string | null>(null);
  const [visionReviewStatusLoading, setVisionReviewStatusLoading] = useState(false);
  const [assistantPrompt, setAssistantPrompt] = useState("Which regions still need attention?");
  const [assistantProposal, setAssistantProposal] = useState<AssistantProposal | null>(null);
  const benchmarkMode = useSyncExternalStore(() => () => undefined, () => new URLSearchParams(window.location.search).get("benchmark") === "guided-manual", () => false);
  const [benchmarkRun, setBenchmarkRun] = useState<GuidedBenchmarkRun>(() => typeof window === "undefined" ? createGuidedBenchmarkRun() : parseGuidedBenchmarkRun(window.localStorage.getItem(GUIDED_BENCHMARK_STORAGE_KEY)));
  const benchmarkEventRef = useRef(0);
  const importRef = useRef<HTMLInputElement>(null); const brushBaseRef = useRef<PartCutterState | null>(null); const brushDraftRef = useRef<PartCutterState | null>(null); const brushFrameRef = useRef<number | null>(null); const pivotDragRef = useRef(false); const boundaryDragRef = useRef<BoundaryDrag | null>(null); const boundaryDraftRef = useRef<PartCutterState | null>(null); const landmarkDragRef = useRef<LandmarkDrag | null>(null); const landmarkDraftRef = useRef<PartCutterState | null>(null);
  const ollamaRetryRef = useRef(new OptionalServiceRetryBackoff());
  // Part names are drawn in source pixels, so they scale with the image: a fixed size was unreadable on large sprites.
  const labelSize = Math.max(2, Math.max(project.sourceImage?.width ?? 0, project.sourceImage?.height ?? 0) * .022);
  const source = project.sourceImage; const selectedPart = state?.parts.find((part) => part.partId === selectedPartId) ?? null; const activeProposal = state?.proposals.find((proposal) => proposal.proposalId === state.activeProposalId) ?? null;
  const integrityProblems = useMemo(() => validateRigProject({ storageVersion: LOCAL_PROJECT_STORAGE_VERSION, project, rig: project.rigDefinition ?? null, animations: null, selectedSkinId: project.rigDefinition?.defaultSkinId ?? null }, { partIds: selectedPartId ? [selectedPartId] : [] }), [project, selectedPartId]);
  const segmentationAvailable = providerCapabilities.segmentation.available && providerCapabilities.segmentation.imageConditioned;
  // Click to select: SAM2 on the Studio's ComfyUI returns the whole object under a click (a sword, a pouch, a glove).
  const clickSelectAvailable = Boolean(providerCapabilities.pointSegmentation?.available && provider.segmentAtPoints);
  const [clickBusy, setClickBusy] = useState(false);
  // An unassigned piece the user is pointing at in the side panel, outlined on the canvas.
  const [previewPiece, setPreviewPiece] = useState<{ readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }; readonly mask: SegmentationMask } | null>(null);
  /** "Piece near the left hand": the part whose middle is closest to the piece's middle. */
  const pieceName = (piece: { readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }): string => {
    const cx = piece.bounds.x + piece.bounds.width / 2; const cy = piece.bounds.y + piece.bounds.height / 2;
    const nearest = state?.parts.reduce<{ label: string; distance: number } | null>((best, part) => {
      const distance = Math.hypot(part.boundingBox.x + part.boundingBox.width / 2 - cx, part.boundingBox.y + part.boundingBox.height / 2 - cy);
      return !best || distance < best.distance ? { label: SEMANTIC_TAXONOMY[part.semanticType].label.toLowerCase(), distance } : best;
    }, null);
    return nearest ? `Piece near the ${nearest.label}` : "Unassigned piece";
  };
  // Body proportions for the outline guide: chibi sprites, or adult figures (the goblin), whose joints sit much higher.
  const [proportions, setProportions] = useState<GuideProportions>("auto");
  // Body parts that came from the guide and have not been edited by hand since. Moving a joint re-cuts these, so one drag
  // fixes a wrong joint; a part the user has edited is never re-cut over.
  const fromGuideRef = useRef(new Set<PartSemanticType>());
  useEffect(() => { fromGuideRef.current = new Set(); }, [source?.generationId]);
  // On opening a character: a note left by another stage (Rig sends the user here when there is no rig yet), or else
  // the next step for where this character is, instead of a fixed instruction.
  const bodyDone = Boolean(state?.guidedManual && GUIDED_BODY_ORDER.every((semantic) => state.guidedManual!.completedSemantics.includes(semantic)));
  useEffect(() => {
    if (!state) return;
    // A character's art can load in two passes (browser, then disk); the store hands the note to both.
    const notice = takeStageNotice();
    setMessage(notice ?? (bodyDone ? "Body parts are done. Click or loop any equipment, or press Build rig." : "Press Cut all parts, or draw a loop around each part in turn"));
    // Only when a character opens, not on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.generationId, Boolean(state)]);
  const ollama = useMemo(() => new OllamaProvider(ollamaSettings), [ollamaSettings]);
  useEffect(() => { commandService.setIntelligenceProvider(ollama); }, [commandService, ollama]);
  useEffect(() => {
    publishIntegrityEvidence({
      stage: "prepare",
      state: {
        projectId: project.id, sourceId: source?.generationId ?? null, phase: preparePhase, selectedPartId,
        parts: state?.parts.map((part) => `${part.partId}:${part.accepted}:${part.mask.width}x${part.mask.height}:${part.mask.alpha.filter((alpha) => alpha > 0).length}`) ?? [],
        extractedParts: project.extractedParts.map((part) => part.partId), activeProposalId: state?.activeProposalId ?? null,
      },
      problems: integrityProblems,
    });
  }, [integrityProblems, preparePhase, project.extractedParts, project.id, selectedPartId, source?.generationId, state]);
  useEffect(() => {
    const digest = {
      activeProjectId: hydrationIdentity.activeProjectId, stage: "prepare", selectedRegion: selectedPartId,
      selectedPart: selectedPartId, selectedBone: null, selectedAnimation: null, selectedKeyframe: null,
      renderedSourceProjectId: source ? project.id : null, renderedRigProjectId: project.rigDefinition ? project.id : null,
    };
    (window as Window & { __RIG_STUDIO_UI_IDENTITY__?: typeof digest }).__RIG_STUDIO_UI_IDENTITY__ = digest;
  }, [hydrationIdentity.activeProjectId, project.id, project.rigDefinition, selectedPartId, source]);

  const install = useCallback((nextProject: GeneratedCharacterProject, nextState: PartCutterState, activate = true) => {
    const ownership = ensureOwnershipPartition(nextState);
    const awaitingProposal = ownership.proposals.some((proposal) => proposal.status === "pending" && proposal.parts.length > 0);
    const guided = ownership.mode === "manual" || (!ownership.parts.length && !awaitingProposal) ? initializeGuidedManual(ownership) : ownership;
    const canonical = guided.guidedManual && !guided.anatomicalGuide ? { ...guided, anatomicalGuide: buildAnatomicalPartitionGuide(guided, "humanoid") } : guided;
    const syncedProject = { ...nextProject, partCutterState: canonical, segmentationData: partCutToSegmentation(canonical) };
    projectRef.current = syncedProject; setProject(syncedProject); setState(canonical); setPreparePhase(derivePrepareWorkflowState(canonical));
    const history = new SnapshotCommandHistory(canonical); historyRef.current = history; setHistoryUi({ canUndo: history.canUndo, canRedo: history.canRedo, undoLabel: history.getUndoLabel() });
    setMode(canonical.mode); setAnatomyProfile(canonical.anatomicalGuide?.profile ?? "humanoid"); setTool(canonical.guidedManual ? "lasso" : "select"); setShowGuide(Boolean(canonical.anatomicalGuide)); setSelectedPartId(canonical.parts[0]?.partId ?? null);
    const active = canonical.proposals.find((proposal) => proposal.proposalId === canonical.activeProposalId); setSelectedProposalIds(new Set(active?.parts.filter((part) => part.selected).map((part) => part.proposedPartId) ?? []));
    setSelection(null); setPath([]); setHoveredPartId(null); setIsolatedPartId(null); setDrawing(false); setPendingPartDeletion(null); setAssistantProposal(null); setPartPreview(null);
    brushBaseRef.current = null; brushDraftRef.current = null; boundaryDragRef.current = null; boundaryDraftRef.current = null; landmarkDragRef.current = null; landmarkDraftRef.current = null; pivotDragRef.current = false;
    if (brushFrameRef.current !== null) { window.cancelAnimationFrame(brushFrameRef.current); brushFrameRef.current = null; }
    if (activate) commandService.activateProjectFromUi(syncedProject);
  }, [commandService]);
  useEffect(() => { if (benchmarkMode) window.localStorage.setItem(GUIDED_BENCHMARK_STORAGE_KEY, serializeGuidedBenchmarkRun(benchmarkRun)); }, [benchmarkMode, benchmarkRun]);
  const refreshOllama = useCallback(async () => { const status = await ollama.status(); setOllamaStatus(status); if (status.selectedModel !== ollamaSettings.selectedModel) { const next = { ...ollamaSettings, selectedModel: status.selectedModel }; setOllamaSettings(next); saveOllamaSettings(window.localStorage, next); } return status; }, [ollama, ollamaSettings]);
  const refreshVisionReview = useCallback(async () => {
    setVisionReviewStatusLoading(true); setVisionReviewStatusError(null);
    try {
      const response = await fetch("http://127.0.0.1:47831/vision-review/status", { cache: "no-store" });
      if (!response.ok) throw new Error(`Local bridge returned ${response.status}`);
      const payload = await response.json() as VisionReviewStatus;
      if (!payload.policy || !Array.isArray(payload.providers)) throw new Error("Local bridge returned an invalid capability report");
      setVisionReviewStatus(payload);
    } catch (statusError: unknown) {
      setVisionReviewStatus(null); setVisionReviewStatusError(statusError instanceof Error ? statusError.message : "Local bridge is unavailable");
    } finally { setVisionReviewStatusLoading(false); }
  }, []);
  useEffect(() => { let cancelled = false; let timer = 0; const probe = async (): Promise<void> => { const status = await refreshOllama(); if (!cancelled) timer = window.setTimeout(() => void probe(), ollamaRetryRef.current.nextDelay(status.reachable)); }; timer = window.setTimeout(() => void probe(), 0); return () => { cancelled = true; window.clearTimeout(timer); }; }, [refreshOllama]);
  useEffect(() => { const showTimer = window.setTimeout(() => setToastVisible(true), 0); const hideTimer = error ? null : window.setTimeout(() => setToastVisible(false), 3200); return () => { window.clearTimeout(showTimer); if (hideTimer !== null) window.clearTimeout(hideTimer); }; }, [error, message]);
  useEffect(() => () => provider.cancelPending?.(), [provider]);
  useEffect(() => { let cancelled = false; const timer = window.setTimeout(() => { void (async () => { const payload = window.sessionStorage.getItem(PART_CUTTER_IMPORT_KEY); if (payload) { window.sessionStorage.removeItem(PART_CUTTER_IMPORT_KEY); try { const parsed = JSON.parse(payload) as PartCutterImportPayload; const generation: CharacterImageGenerationResult = { generationId: `import-${Date.now().toString(36)}`, image: parsed.image, width: parsed.width, height: parsed.height, generationPrompt: "Imported sprite", generationSettings: { imported: true }, providerMetadata: { provider: "local-import" }, warnings: [], generationMode: "imported_external", novelArtwork: true, provider: "local-import", sourceArtifact: parsed.name }; const next = projectPatch(createGeneratedCharacterProject(parsed.name.replace(/\.[^.]+$/, ""), ""), { stage: "prepare", sourceImage: generation, generationHistory: [generation] }); if (!cancelled) install(next, createPartCutterState(generation.generationId, generation.width, generation.height)); return; } catch { if (!cancelled) setError("The pending sprite import could not be read"); } }
      try {
        const durable = commandService.getDurableSnapshot();
        if (durable.localProjectId && durable.project?.sourceImage) {
          const nextState = cutterStateFor(durable.project.partCutterState, durable.project.sourceImage) ?? createPartCutterState(durable.project.sourceImage.generationId, durable.project.sourceImage.width, durable.project.sourceImage.height, durable.project.segmentationData ? "assisted" : "manual");
          if (!cancelled) install(durable.project, nextState, false);
          return;
        }
      } catch { /* no durable project is active; browser draft remains the fallback */ }
      const restored = await characterStorage.load(); if (cancelled) return; if (restored?.success && restored.data.sourceImage) { const nextState = cutterStateFor(restored.data.partCutterState, restored.data.sourceImage) ?? createPartCutterState(restored.data.sourceImage.generationId, restored.data.sourceImage.width, restored.data.sourceImage.height, restored.data.segmentationData ? "assisted" : "manual"); install(restored.data, nextState); } else if (restored && !restored.success) setPersistenceWarning(restored.message);
    })(); }, 0); return () => { cancelled = true; window.clearTimeout(timer); }; }, [characterStorage, commandService, install]);
  useEffect(() => { projectRef.current = project; commandService.syncProjectFromUi(project, "mutation"); }, [commandService, project]);
  useEffect(() => commandService.attachCharacterProject({
    getProject: () => projectRef.current,
    replaceProject: (next) => {
      const nextState = (next.sourceImage ? cutterStateFor(next.partCutterState, next.sourceImage) : null) ?? (next.sourceImage ? createPartCutterState(next.sourceImage.generationId, next.sourceImage.width, next.sourceImage.height, next.segmentationData ? "assisted" : "manual") : null);
      if (nextState) install(next, nextState, false);
      else { projectRef.current = next; setProject(next); setState(null); historyRef.current = null; setSelectedPartId(null); setSelection(null); setPath([]); }
    },
  }), [commandService, install]);
  useEffect(() => { if (!state) return; const synced = projectPatch(projectRef.current, { stage: "prepare", partCutterState: state, segmentationData: partCutToSegmentation(state), generationMetadata: { ...projectRef.current.generationMetadata, anatomyProfile } }); projectRef.current = synced; setProject(synced); let cancelled = false; const timer = window.setTimeout(() => { void characterStorage.save(synced).then((result) => { if (cancelled) return; setStoredProjectBytes(result.approximateBytes); setPersistenceWarning(result.success ? null : `Draft kept in memory. ${result.layer} failed: ${result.message}. Retry by making another edit.`); }); }, 250); return () => { cancelled = true; window.clearTimeout(timer); }; }, [anatomyProfile, characterStorage, state]);
  useEffect(() => { if (!selectedPart || !source) return; let cancelled = false; void extractPartToDataUrl(source.image, selectedPart.boundingBox, selectedPart.mask).then((image) => { if (!cancelled) setPartPreview(image); }).catch(() => setPartPreview(null)); return () => { cancelled = true; }; }, [selectedPart, source]);
  // Which pixels are the character. Everything that cuts from outlines (Use Guide, Cut all parts) needs this, so a
  // failed read is retried: while a project is still opening, the image can fail to load once, and that used to leave
  // those buttons disabled until a reload.
  useEffect(() => {
    if (!source) return; let cancelled = false; let timer = 0;
    const attempt = (tries: number) => void readImagePixels(source.image).then((pixels) => {
      if (cancelled) return;
      sourceColoursRef.current = pixels.data;
      const { mask, transparent } = estimateForeground(pixels);
      setForeground(mask);
      setForegroundStatus(transparent ? "Transparent background detected; alpha defines the foreground." : "Opaque background estimated from corner colors; review coverage and mark corrections manually.");
    }).catch(() => {
      if (cancelled) return;
      if (tries > 0) { timer = window.setTimeout(() => attempt(tries - 1), 800); return; }
      setForeground(undefined); setForegroundStatus("Automatic background analysis failed; use Lasso or Polygon to mark parts manually.");
    });
    attempt(4);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [foregroundRevision, source]);
  useEffect(() => { state?.anatomicalGuide?.landmarks.forEach((landmark) => { const node = document.querySelector<SVGGElement>(`.cutter-canvas [data-landmark-id="${landmark.landmarkId}"]`); if (node) { node.dataset.landmarkState = landmark.visibility ?? "legacy"; node.setAttribute("role", "group"); node.setAttribute("aria-label", `${landmark.landmarkId} · ${landmark.visibility ?? "legacy"} · ${landmark.method ?? "fixed guide"}`); } }); }, [state?.anatomicalGuide]);
  useEffect(() => { if (!drawing && !boundaryDraftRef.current) boundaryDragRef.current = null; }, [drawing]);

  const execute = useCallback((label: string, transform: (current: PartCutterState) => PartCutterState): PartCutterState | null => {
    if (!commandService.isCurrentHydration(hydrationIdentity.activeProjectId, hydrationIdentity.projectSessionToken, hydrationIdentity.hydrationToken)) return null;
    const history = historyRef.current; if (!history) return null;
    if (label.startsWith("Deleted ") && !confirmedPartDeletionRef.current) {
      setPendingPartDeletion({ label, partId: selectedPartId ?? "", transform });
      return history.present;
    }
    const next = history.execute(label, transform); setState(next); setHistoryUi({ canUndo: history.canUndo, canRedo: history.canRedo, undoLabel: history.getUndoLabel() }); setMessage(label); setError(null); return next;
  }, [commandService, hydrationIdentity.activeProjectId, hydrationIdentity.hydrationToken, hydrationIdentity.projectSessionToken, selectedPartId]);
  const run = useCallback(async (label: string, action: () => Promise<void>) => { setBusy(label); setError(null); try { await action(); setMessage(label); } catch (reason: unknown) { if (/partition|refin|repair/i.test(label)) reportProviderFailure(reason); setError(reason instanceof Error ? reason.message : `${label} failed`); } finally { setBusy(null); } }, [reportProviderFailure]);
  const recordBenchmark = useCallback((action: GuidedBenchmarkAction, detail: { readonly semantic?: string; readonly changedPixels?: number } = {}) => {
    if (!benchmarkMode) return;
    const at = Date.now(); const eventId = `${benchmarkRun.activeSourceId ?? "source"}-${at}-${benchmarkEventRef.current++}`;
    setBenchmarkRun((current) => recordGuidedBenchmarkEvent(current, { eventId, action, at, ...detail }));
  }, [benchmarkMode, benchmarkRun.activeSourceId]);
  const startBenchmarkCharacter = () => {
    const entry = GUIDED_BENCHMARK_COHORT[benchmarkRun.currentIndex]; if (!entry) return;
    const nextRun = startGuidedBenchmarkCharacter(benchmarkRun, entry.sourceId);
    window.localStorage.setItem(GUIDED_BENCHMARK_STORAGE_KEY, serializeGuidedBenchmarkRun(nextRun)); setBenchmarkRun(nextRun);
    const generation: CharacterImageGenerationResult = { generationId: `guided-benchmark-${entry.sourceId}`, image: entry.image, width: entry.width, height: entry.height, generationPrompt: "Frozen WOS benchmark source", generationSettings: { benchmark: true }, providerMetadata: { provider: "guided-manual-benchmark" }, warnings: [], generationMode: "imported_external", novelArtwork: false, provider: "guided-manual-benchmark", sourceArtifact: entry.sourceId };
    const nextProject = projectPatch(createGeneratedCharacterProject(entry.name, ""), { stage: "prepare", sourceImage: generation, generationHistory: [generation] });
    const base = createPartCutterState(generation.generationId, entry.width, entry.height, "manual");
    install(nextProject, initializeGuidedManual({ ...base, anatomicalGuide: buildAnatomicalPartitionGuide(base, "humanoid") }));
    setMessage("Character ready · timing begins with your first workflow action");
  };
  const commitGuided = (guidedSelection: GuidedSelection, sourceAction: "lasso" | "use-guide" | "use-component") => {
    if (!state?.guidedManual) return false;
    if (!foreground) { setMessage("Foreground analysis is still finishing. Try the gesture again in a moment."); return false; }
    const semanticType = state.guidedManual.currentSemantic; const intent = state.guidedManual.intent;
    const result = commitGuidedSelection(state, guidedSelection, foreground);
    if (!result.ok) { setError(null); window.setTimeout(() => setError(result.message), 0); setSelection(null); setPath([]); setTool("lasso"); return false; }
    if (sourceAction === "use-guide") fromGuideRef.current.add(semanticType); else fromGuideRef.current.delete(semanticType);
    execute(result.message, () => result.state); setSelectedPartId(null); setPreparePhase("CUTTING"); setSelection(null); setPath([]); setTool("lasso"); setMessage(result.message);
    if (sourceAction !== "lasso") recordBenchmark(sourceAction, { semantic: semanticType, changedPixels: result.changedPixels });
    recordBenchmark(intent, { semantic: semanticType, changedPixels: result.changedPixels });
    if (SEMANTIC_TAXONOMY[semanticType].equipment) recordBenchmark("equipment", { semantic: semanticType, changedPixels: result.changedPixels });
    return true;
  };
  /** The pose model's confident joints and view of the character, or null. Never throws: the silhouette guide is the fallback. */
  const findPose = async (): Promise<{ joints: ReturnType<typeof poseToLandmarks>; view: ViewEstimate | null } | null> => {
    if (!source) return null;
    try { const pose = await detectPose(source.image); return pose ? { joints: poseToLandmarks(pose), view: estimateView(pose) } : null; }
    catch { return null; }
  };
  /**
   * Cuts every body part that is not done yet, as one undoable step. Each joint comes from the pose model when it is
   * confident about that joint, and from the silhouette otherwise; each part is then cut along its limb between them.
   */
  const cutAllParts = async () => {
    if (!state || !foreground) { setMessage("Foreground analysis is still finishing. Try again in a moment."); return; }
    setMessage("Finding the character's joints…");
    const pose = await findPose();
    const posed = pose && Object.keys(pose.joints).length ? pose : null;
    let outcome: ReturnType<typeof guideAllBodyParts> | null = null; let robed = false;
    execute("Cut all parts", (current) => {
      // A guide with joints placed by hand is kept; otherwise it is rebuilt, so the chosen proportions apply.
      const handPlaced = current.anatomicalGuide?.adaptiveMetadata && current.anatomicalGuide.landmarks.some((landmark) => landmark.source === "manual");
      const guide = handPlaced ? current.anatomicalGuide! : createAdaptiveGuide(current);
      const anatomicalGuide = posed ? applyPoseLandmarks(guide, posed.joints, foreground) : guide;
      outcome = guideAllBodyParts({ ...current, anatomicalGuide }, foreground);
      // A character described in a long robe or dress keeps the cloth over its legs in one piece (see foldLegsIntoSkirt).
      if (SKIRT_WORDS.test(project.originalUserPrompt ?? "")) {
        const folded = foldLegsIntoSkirt(outcome.state, foreground, sourceColoursRef.current ?? undefined);
        if (folded.folded.length) { robed = true; outcome = { ...outcome, state: folded.state }; }
      }
      return outcome.state;
    });
    const result = outcome as ReturnType<typeof guideAllBodyParts> | null;
    if (!result) return;
    for (const semantic of result.cut) fromGuideRef.current.add(semantic);
    setSelection(null); setPath([]); setShowParts(true); setPreparePhase("CUTTING");
    const missed = result.missed.map((semantic) => SEMANTIC_TAXONOMY[semantic].label.toLowerCase());
    const laidOut = (result.state.anatomicalGuide?.adaptiveMetadata?.proportions ?? "chibi") === "adult" ? "adult" : "chibi";
    const fromModel = posed ? Object.keys(posed.joints).length : 0;
    const how = fromModel ? `${fromModel} joints from the pose model, the rest from the outline with ${laidOut} proportions${posed?.view ? ` · ${posed.view.view} view` : ""}` : `Joints from the outline with ${laidOut} proportions (the pose model was not sure of any)`;
    const summary = !result.cut.length ? "Nothing to cut: every part is already done or has no outline." : `Cut ${result.cut.length} ${result.cut.length === 1 ? "part" : "parts"}. ${how}.${missed.length ? ` Draw these yourself: ${missed.join(", ")}.` : ""}${result.hidden.length ? " One leg is hidden behind the other, so it was not cut; the rig draws it from the near leg." : ""}`;
    setMessage(`${summary}${robed ? " The robe is kept in one piece with the body; the feet show the steps." : ""} Check each one and fix any that are wrong with Add or Remove.`);
    // Also when the body was already cut: what the character holds may still be missing (it returns at once when not).
    await cutHeldObjects(result.state, summary);
  };
  /**
   * After the body is cut, finds what the character holds (a sword, a shield) from the silhouette and has click-to-select
   * cut each one, attached to the hand holding it. Needs the Studio's segmentation model; without it nothing changes and
   * the user can still click items in the equipment step.
   */
  const cutHeldObjects = async (afterBody: PartCutterState, summary: string) => {
    const guide = afterBody.anatomicalGuide;
    if (!clickSelectAvailable || !provider.segmentAtPoints || !source || !foreground || !guide) return;
    const owned = new Set(afterBody.parts.filter((part) => !isBodySemantic(part.semanticType)).map((part) => part.semanticType));
    if (owned.has("mainHandEquipment") && owned.has("offHandEquipment")) return;
    const seeds = heldObjectSeeds(guide, foreground);
    if (!seeds.length) return;
    setClickBusy(true); setMessage(`${summary} Looking for held items (the Studio may take a minute to wake)…`);
    const found: (GuidedSelection & { readonly hand: "left" | "right" })[] = [];
    try {
      // First every distinct object the seeds point at, then each one's hand, judged knowing all the others (an arm zone
      // drawn across the shield must not pull the sword into the shield hand).
      const objects: (GuidedSelection & { readonly fromHand?: boolean })[] = []; const loose: GuidedSelection[] = [];
      for (const seed of seeds) {
        const result = await provider.segmentAtPoints({ image: source.image, width: source.width, height: source.height, positive: seed.points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })), generationId: source.generationId });
        const selection = selectionFromCanvasMask(result.alpha, result.width, result.height, seed.point);
        const hand = selection ? heldObjectHand(guide, selection.mask, selection.bounds, foreground, objects) : null;
        if (process.env.NODE_ENV !== "production") { const log = ((window as unknown as { __RIG_STUDIO_HELD_DEBUG__?: unknown[] }).__RIG_STUDIO_HELD_DEBUG__ ??= []); log.push({ seed: seed.points, fromHand: seed.fromHand, bounds: selection?.bounds ?? null, maskPixels: result.alpha.filter((value) => value > 0).length, hand, armItself: selection && hand ? armItself(guide, selection.mask, selection.bounds, hand) : null }); }
        // A model prompted at a hand can return the sleeve and fist; that is the arm, not something held.
        if (selection && hand !== null && !armItself(guide, selection.mask, selection.bounds, hand)) objects.push({ ...selection, fromHand: seed.fromHand });
        else if (selection && hand === null) loose.push(selection);
      }
      const classified = objects.flatMap((object) => { const hand = heldObjectHand(guide, object.mask, object.bounds, foreground, objects.filter((other) => other !== object)); return hand ? [{ ...object, hand }] : []; });
      // Pieces of a held object the model returned on their own (a staff's crystal apart from its shaft) join the object
      // they touch, though alone they reach no hand.
      for (const piece of loose) {
        const owner = classified.find((object) => mergeHeldPieces([object, { ...piece, hand: object.hand }], 12).length === 1);
        if (owner) classified.push({ ...piece, hand: owner.hand, fromHand: owner.fromHand });
      }
      for (const item of chooseHeldObjects(classified)) if (!owned.has(item.hand === "right" ? "mainHandEquipment" : "offHandEquipment")) found.push(item);
    } catch (reason: unknown) {
      setMessage(`${summary} Held items were not cut (${reason instanceof Error ? reason.message : String(reason)}); click them in the equipment step instead.`);
      return;
    } finally { setClickBusy(false); }
    if (!found.length) { setMessage(`${summary} No held items found. Check each part and fix any that are wrong with Add or Remove.`); return; }
    let cut: readonly PartSemanticType[] = []; let hiddenArm: readonly PartSemanticType[] = [];
    execute("Cut held items", (current) => { const outcome = commitHeldObjects(current, found, foreground, undefined, sourceColoursRef.current ?? undefined); cut = outcome.cut; hiddenArm = outcome.hidden; return outcome.state; });
    const names = cut.map((semantic) => SEMANTIC_TAXONOMY[semantic].label.toLowerCase());
    const behind = hiddenArm.length ? ` The arm behind the ${hiddenArm.some((semantic) => semantic.startsWith("right")) ? names[cut.indexOf("mainHandEquipment")] ?? "item" : names[cut.indexOf("offHandEquipment")] ?? "item"} is hidden, so it is drawn from the other arm.` : "";
    setMessage(`${summary}${names.length ? ` Cut what the character holds as ${names.join(" and ")}, so it moves with the hand.` : ""}${behind} Check each one and fix any that are wrong with Add or Remove.`);
  };
  /**
   * Click to select: asks SAM2 for the object under the click and applies it to the current part with the chosen
   * Replace / Add / Remove, exactly as a lasso would. The tool stays on, so items can be clicked one after another.
   */
  const clickSelect = async (point: { readonly x: number; readonly y: number }) => {
    if (!source || !state?.guidedManual || clickBusy) return;
    if (!provider.segmentAtPoints) { setError("Click to select is not available from this provider."); return; }
    setClickBusy(true); setMessage("Selecting what you clicked…");
    try {
      const result = await provider.segmentAtPoints({ image: source.image, width: source.width, height: source.height, positive: [{ x: Math.round(point.x), y: Math.round(point.y) }], generationId: source.generationId });
      let minX = result.width, minY = result.height, maxX = -1, maxY = -1;
      for (let y = 0; y < result.height; y += 1) for (let x = 0; x < result.width; x += 1) if (result.alpha[y * result.width + x]) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      if (maxX < 0) { setMessage("Nothing was found under that click. Try clicking nearer the middle of the item."); return; }
      const width = maxX - minX + 1; const height = maxY - minY + 1; const alpha = new Array<number>(width * height);
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) alpha[y * width + x] = result.alpha[(minY + y) * result.width + minX + x];
      if (commitGuided({ bounds: { x: minX, y: minY, width, height }, mask: { width, height, alpha } }, "use-component")) setTool("click");
    } catch (reason: unknown) {
      setError(`Click to select failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally { setClickBusy(false); }
  };
  const importSprite = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; if (!/image\/(png|jpeg|webp)/.test(file.type)) { setError("Choose a PNG, JPG, or WebP image"); return; } const image = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Could not read image")); reader.readAsDataURL(file); }); const size = await imageDimensions(image); if (size.width > 2048 || size.height > 2048) setMessage("Large source imported. Editing remains available, but 2048 px or smaller is recommended"); const generation: CharacterImageGenerationResult = { generationId: `import-${Date.now().toString(36)}`, image, width: size.width, height: size.height, generationPrompt: "Imported sprite", generationSettings: { imported: true }, providerMetadata: { provider: "local-import" }, warnings: [], generationMode: "imported_external", novelArtwork: true, provider: "local-import", sourceArtifact: file.name }; const nextProject = projectPatch(createGeneratedCharacterProject(file.name.replace(/\.[^.]+$/, ""), ""), { stage: "prepare", sourceImage: generation, generationHistory: [generation] });
    // Activating a project remounts this workspace, which restores from browser storage. Store the import first so the remount restores it, not the previous character,
    // and stop the project menu reopening the previous disk project over it.
    forgetActiveDiskProject();
    const stored = await characterStorage.save(nextProject); if (!stored.success) setPersistenceWarning(`Draft kept in memory. ${stored.layer} failed: ${stored.message}.`);
    install(nextProject, createPartCutterState(generation.generationId, size.width, size.height, mode)); setMessage("Character imported. Press Cut all parts, or draw a loop around each part in turn"); };
  const createAdaptiveGuide = (current: PartCutterState) => foreground ? buildAdaptiveAnatomicalPartitionGuide(current, foreground, anatomyProfile, now(), proportions) : buildAnatomicalPartitionGuide(current, anatomyProfile);
  const applyGuideRegeneration = () => { if (!state || !foreground) { setError("Foreground analysis must finish before regenerating the adaptive guide"); return; } execute("Regenerated adaptive guide from source", (current) => ({ ...current, anatomicalGuide: buildAdaptiveAnatomicalPartitionGuide(current, foreground, anatomyProfile), mode: "auto", finalized: false, updatedAt: now() })); setPreparePhase("GUIDE_READY"); setMode("auto"); setShowGuide(true); setSelectedLandmarkId(null); setConfirmGuideRegeneration(false); };
  const regenerateGuide = () => { const guide = state?.anatomicalGuide; const hasManualOwnership = Boolean(state?.parts.some((part) => part.provenance === "manual")); const hasManualEditsOrLegacyState = Boolean(guide && (!guide.adaptiveMetadata || guide.landmarks.some((landmark) => landmark.source === "manual" || landmark.visibility === "manual"))); if (hasManualOwnership || hasManualEditsOrLegacyState) setConfirmGuideRegeneration(true); else applyGuideRegeneration(); };
  /** Clears every part of this picture so it can be cut again from scratch. One step, so Undo restores it. */
  const startOver = () => {
    setSelection(null); setPath([]); fromGuideRef.current = new Set();
    execute("Started over", (current) => initializeGuidedManual(createPartCutterState(current.sourceImageId, current.sourceCanvasSize.width, current.sourceCanvasSize.height, current.mode)));
    setMessage("Cleared. Press Cut all parts, or draw a loop around each part in turn");
  };
  const setCutMode = (nextMode: PartCutMode) => { setMode(nextMode); setSelection(null); setPath([]); if (state) execute(nextMode === "auto" ? "Switched to Free edit" : nextMode === "manual" ? "Switched to Guided" : "Opened AI assist", (current) => { const next = { ...current, ...(nextMode === "auto" && !current.anatomicalGuide ? { anatomicalGuide: createAdaptiveGuide(current) } : {}), mode: nextMode, updatedAt: now() }; return nextMode === "manual" ? initializeGuidedManual({ ...next, anatomicalGuide: next.anatomicalGuide ?? createAdaptiveGuide(next) }) : next; }); if (nextMode === "auto") { setShowGuide(true); if (!state?.parts.length) setPreparePhase("GUIDE_READY"); } else if (nextMode === "manual") { setShowGuide(true); setTool("lasso"); if (!state?.parts.length) setPreparePhase("CUTTING"); } else setTool("select"); };
  const requestCut = (instruction: string) => run("Automatic cut: partition ready for review", async () => { if (!source || !state) throw new Error("Import or generate a source image first"); if (!segmentationAvailable) throw new Error(providerCapabilities.segmentation.reason ?? "Image-conditioned segmentation is unavailable"); const guide = state.anatomicalGuide ?? createAdaptiveGuide(state); const response = await provider.segmentCharacter({ generationId: source.generationId, image: source.image, width: source.width, height: source.height, expectedEquipment: guide.zones.filter((zone) => zone.optional && zone.semanticType.includes("Equipment")).map((zone) => zone.semanticType), semanticPrompt: anatomicalGuidePrompt(guide, instruction), consistencyContext: buildCharacterConsistencyContext(project) }); const proposal = guidedProposalFromSegmentation(response, guide, instruction, state.activeProposalId); const ids = proposal.parts.map((part) => part.proposedPartId); if (!ids.length) throw new Error("The provider did not return any masks inside the predetermined anatomical zones"); const next = execute("Refined landmark-guided anatomical partition", (current) => acceptProposal({ ...current, anatomicalGuide: { ...guide, status: "ai-refined", updatedAt: now() }, mode: "auto", proposals: [...current.proposals.map((item) => item.proposalId === current.activeProposalId ? { ...item, status: "superseded" as const } : item), proposal], activeProposalId: proposal.proposalId, updatedAt: now() }, proposal.proposalId, ids)); setSelectedPartId(next?.parts[0]?.partId ?? null); setTool("select"); setShowGuide(true); setMessage(`${ids.length} predetermined zones refined · provider-invented regions were ignored`); });
  const acceptSelected = (safeOnly = false) => { if (!state || !activeProposal) return; const ids = safeOnly ? activeProposal.parts.filter((part) => part.confidence !== null && part.confidence >= .8).map((part) => part.proposedPartId) : [...selectedProposalIds]; const remaining = activeProposal.parts.length - ids.length; const next = execute(safeOnly ? "Accepted safe AI parts" : "Accepted selected AI parts", (current) => acceptProposal(current, activeProposal.proposalId, ids)); setSelectedPartId(next?.parts.at(-1)?.partId ?? null); setMessage(remaining ? `${ids.length} accepted · ${remaining} need review. No proposal was discarded.` : `${ids.length} parts accepted · review complete`); };
  const cutSelection = () => { if (!state || !selection) return; const holder: { value?: ReturnType<typeof createManualRegionFromSelection> } = {}; const label = semantic === "custom" ? customLabel.trim() || "Custom" : undefined; execute(`Cut ${label ?? semanticLabel(semantic)}`, (current) => { const result = createManualRegionFromSelection(current, semantic, selection.bounds, selection.mask, label); holder.value = result; return result.state; }); const result = holder.value; if (!result) return; setSelectedPartId(result.partId); setPreparePhase("CUTTING"); setSelection(null); setPath([]); setCustomLabel(""); setTool("lasso"); setMessage(`${result.changedPixels.toLocaleString()} foreground pixels assigned · previous owners yielded · one undo step`); };
  const patchPart = (partId: string, patch: Partial<PartCutRecord>, label: string) => {
    const next = execute(label, (current) => { const patched = { ...current, parts: current.parts.map((part) => part.partId === partId ? { ...part, ...patch, provenance: patch.provenance ?? "manual" } : part), finalized: false, updatedAt: now() }; return patch.semanticType ? recordOwnershipRelabel(patched, partId, label) : patched; });
    if (patch.provenance === "reconstructed" || patch.occlusionState === "reconstructed") {
      const inspectedAt = now(); const updated = projectPatch(projectRef.current, { reconstructedParts: projectRef.current.reconstructedParts.map((review) => review.partId === partId ? { ...review, decision: "reconstruct", reconstructionAccepted: true, previewResourceInspected: `ui://part-cutter/reconstruction/${partId}`, inspectedAt, inspectedBy: "Human" } : review) });
      projectRef.current = updated; setProject(updated);
    }
    return next;
  };
  const onLandmarkPointerDown = (event: ReactPointerEvent<HTMLElement>) => { const target = event.target as Element; const node = target.closest<SVGGElement>("[data-landmark-id]"); if (!node || !state?.anatomicalGuide?.adaptiveMetadata || !foreground || !source) return; const landmarkId = node.dataset.landmarkId as AnatomicalLandmarkId; const circle = target.closest<SVGCircleElement>("circle"); if (!circle) return; event.stopPropagation(); circle.setPointerCapture(event.pointerId); landmarkDragRef.current = { base: state, landmarkId }; setSelectedLandmarkId(landmarkId); setDrawing(true); const landmark = state.anatomicalGuide.landmarks.find((item) => item.landmarkId === landmarkId); setMessage(`${landmarkId} · ${landmark?.method ?? "adaptive landmark"}`); };
  const onCanvasDown = (event: ReactPointerEvent<SVGSVGElement>) => { if (!source || !state) return; const point = pointInSource(event, source.width, source.height); if (pivotDragRef.current || boundaryDragRef.current) return; if (tool === "click") { void clickSelect(point); return; } if (tool === "brush" && selectedPart) { event.currentTarget.setPointerCapture(event.pointerId); brushBaseRef.current = state; const stroke = circleSelection(point, brushSize, source.width, source.height); const clipped = foreground ? intersectSelectionWithForeground(stroke.bounds, stroke.mask, foreground, state.sourceCanvasSize) : stroke.mask; const draft = assignOwnershipSelection(state, manualIntent === "remove" || event.altKey ? null : selectedPart.partId, stroke.bounds, clipped, { includeBackground: true }).state; brushDraftRef.current = draft; setState(draft); setDrawing(true); return; } if (tool === "select" || tool === "reshape") { const hit = ownerAt(state, point.x, point.y); setSelectedPartId(hit && hit !== "unresolved" ? hit : null); setMessage(hit === "unresolved" ? "Unresolved foreground · assign it with Brush, Lasso, or Polygon" : hit ? `${state.parts.find((part) => part.partId === hit)?.label ?? hit} selected` : "Background selected"); return; } if (tool === "lasso") { if (state.guidedManual) recordBenchmark("lasso", { semantic: state.guidedManual.currentSemantic }); event.currentTarget.setPointerCapture(event.pointerId); setPath([point]); setDrawing(true); } else if (tool === "polygon") setPath((current) => [...current, point]); };
  const onCanvasMove = (event: ReactPointerEvent<SVGSVGElement>) => { if (!source || !state) return; const point = pointInSource(event, source.width, source.height); if (landmarkDragRef.current && foreground) { const drag = landmarkDragRef.current; if (!drag.base.anatomicalGuide) return; const guide = moveAdaptiveLandmark(drag.base.anatomicalGuide, drag.landmarkId, point, foreground); const draft = { ...drag.base, anatomicalGuide: guide, finalized: false, updatedAt: now() }; landmarkDraftRef.current = draft; setState(draft); return; } if (boundaryDragRef.current) { const drag = boundaryDragRef.current; const coordinate = drag.edge === "top" || drag.edge === "bottom" ? point.y : point.x; const draft = reshapeRegionEdge(drag.base, drag.partId, drag.edge, coordinate).state; boundaryDraftRef.current = draft; setState(draft); return; } if (!drawing) return; if (tool === "brush" && selectedPart && brushDraftRef.current) { const stroke = circleSelection(point, brushSize, source.width, source.height); const clipped = foreground ? intersectSelectionWithForeground(stroke.bounds, stroke.mask, foreground, state.sourceCanvasSize) : stroke.mask; brushDraftRef.current = assignOwnershipSelection(brushDraftRef.current, manualIntent === "remove" || event.altKey ? null : selectedPart.partId, stroke.bounds, clipped, { includeBackground: true }).state; if (brushFrameRef.current === null) brushFrameRef.current = window.requestAnimationFrame(() => { brushFrameRef.current = null; if (brushDraftRef.current) setState(brushDraftRef.current); }); } else if (tool === "lasso") setPath((current) => [...current, point]); };
  const onCanvasUp = (event: ReactPointerEvent<SVGSVGElement>) => { if (!source || !state) return; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); if (landmarkDragRef.current && landmarkDraftRef.current) { const drag = landmarkDragRef.current; const moved = landmarkDraftRef.current;
      // Parts that came from the guide follow the moved joint: their zones changed, so they are re-cut in the same undo step.
      const affected = foreground ? changedZoneSemantics(drag.base.anatomicalGuide, moved.anatomicalGuide).filter((semantic) => fromGuideRef.current.has(semantic) && moved.parts.some((part) => part.semanticType === semantic)) : [];
      const recut = affected.length && foreground ? recutFromGuide(moved, affected, foreground) : null;
      const final = recut?.state ?? moved;
      const history = historyRef.current; const next = history?.execute(`Moved ${drag.landmarkId} landmark`, () => final); if (next && history) { setState(next); setHistoryUi({ canUndo: history.canUndo, canRedo: history.canRedo, undoLabel: history.getUndoLabel() }); setMessage(recut?.recut.length ? `${drag.landmarkId} moved · re-cut ${recut.recut.map((semantic) => SEMANTIC_TAXONOMY[semantic].label.toLowerCase()).join(", ")} · one undo step` : `${drag.landmarkId} corrected · affected zones rebuilt · one undo step`); } landmarkDragRef.current = null; landmarkDraftRef.current = null; setDrawing(false); return; } if (boundaryDragRef.current && boundaryDraftRef.current) { const drag = boundaryDragRef.current; const final = boundaryDraftRef.current; const reshaped = final.parts.find((part) => part.partId === drag.partId); if (reshaped) fromGuideRef.current.delete(reshaped.semanticType); const delta = drag.base.ownership && final.ownership ? changedOwnershipPixels(drag.base.ownership, final.ownership) : 0; const history = historyRef.current; const next = history?.execute(`Reshaped ${drag.partId} boundary`, () => final); if (next && history) { setState(next); setHistoryUi({ canUndo: history.canUndo, canRedo: history.canRedo, undoLabel: history.getUndoLabel() }); setPreparePhase("CUTTING"); setMessage(`${delta.toLocaleString()} pixels transferred · one undo step`); } boundaryDragRef.current = null; boundaryDraftRef.current = null; setDrawing(false); return; } if (tool === "brush" && brushBaseRef.current && brushDraftRef.current) { if (brushFrameRef.current !== null) { window.cancelAnimationFrame(brushFrameRef.current); brushFrameRef.current = null; } const final = brushDraftRef.current; if (selectedPart) fromGuideRef.current.delete(selectedPart.semanticType); const history = historyRef.current; const delta = brushBaseRef.current.ownership && final.ownership ? changedOwnershipPixels(brushBaseRef.current.ownership, final.ownership) : 0; const next = history?.execute(`${manualIntent === "remove" ? "Removed" : "Assigned"} ${selectedPart?.label ?? "region"} ownership`, () => final); if (next && history) { setState(next); setPreparePhase("CUTTING"); setHistoryUi({ canUndo: history.canUndo, canRedo: history.canRedo, undoLabel: history.getUndoLabel() }); setMessage(delta ? `Transferred ${delta.toLocaleString()} pixels · one undo step` : "No pixels changed."); } brushBaseRef.current = null; brushDraftRef.current = null; } else if (tool === "lasso") { const point = pointInSource(event, source.width, source.height); const selected = polygonSelection([...path, point], source.width, source.height); if (selected) { const clipped = foreground ? { ...selected, mask: intersectSelectionWithForeground(selected.bounds, selected.mask, foreground, state.sourceCanvasSize) } : selected; if (state.guidedManual) commitGuided(clipped, "lasso"); else { const pixels = clipped.mask.alpha.filter(Boolean).length; setSelection(clipped); setMessage(pixels ? `Lasso selected ${pixels.toLocaleString()} foreground pixels` : "The lasso contained only transparent pixels."); } } else setMessage("No pixels changed. Draw a larger closed lasso."); setPath([]); } setDrawing(false); };
  const completePolygon = () => { if (!source || !state) return; const selected = polygonSelection(path, source.width, source.height); if (selected) { const clipped = foreground ? { ...selected, mask: intersectSelectionWithForeground(selected.bounds, selected.mask, foreground, state.sourceCanvasSize) } : selected; const pixels = clipped.mask.alpha.filter(Boolean).length; setSelection(clipped); setMessage(pixels ? `Polygon selected ${pixels.toLocaleString()} foreground pixels` : "The polygon contained only transparent pixels."); } else setMessage("No pixels changed. Add at least three polygon points."); setPath([]); };
  const applySelection = (target: "selected" | "unresolved") => { if (!selection || !state || (target === "selected" && !selectedPart)) return; const result = assignOwnershipSelection(state, target === "selected" ? selectedPart!.partId : null, selection.bounds, selection.mask, { includeBackground: true }); if (!result.changedPixels) { setMessage("No foreground ownership changed."); return; } execute(`${target === "selected" ? `Assigned to ${selectedPart!.label}` : "Marked unresolved"} · ${result.changedPixels} pixels`, () => result.state); setPreparePhase("CUTTING"); setMessage(`${result.changedPixels.toLocaleString()} pixels transferred · one undo step`); setSelection(null); setPath([]); };
  const undo = () => { const history = historyRef.current; const next = history?.undo(); if (next && history) { setState(next); setHistoryUi({ canUndo: history.canUndo, canRedo: history.canRedo, undoLabel: history.getUndoLabel() }); setMessage("Undid part change"); recordBenchmark("undo"); } }; const redo = () => { const history = historyRef.current; const next = history?.redo(); if (next && history) { setState(next); setHistoryUi({ canUndo: history.canUndo, canRedo: history.canRedo, undoLabel: history.getUndoLabel() }); setMessage("Redid part change"); recordBenchmark("redo"); } };
  // Repaints one part's hidden area through the reconstruction provider (ComfyUI inpainting on the Mac Studio).
  const repaintHiddenArea = useCallback<HiddenAreaRepaint>(async ({ part, bounds, mask, context }) => {
    if (!source) return null;
    // The provider keeps the part's own pixels and paints only the mask, both placed within the art's bounds.
    const visible = new Array<number>(bounds.width * bounds.height).fill(0);
    if (part.mask) for (let y = 0; y < part.mask.height; y += 1) for (let x = 0; x < part.mask.width; x += 1) {
      if (!part.mask.alpha[y * part.mask.width + x]) continue;
      const tx = Math.round(part.bounds.x) + x - bounds.x; const ty = Math.round(part.bounds.y) + y - bounds.y;
      if (tx >= 0 && ty >= 0 && tx < bounds.width && ty < bounds.height) visible[ty * bounds.width + tx] = 255;
    }
    const result = await provider.reconstructPart({
      // The model sees the part with nothing in front of it, so it continues the part and not whatever covered it.
      generationId: source.generationId, image: pixelImageToDataUrl(context), part: { ...part, bounds, mask: { width: bounds.width, height: bounds.height, alpha: visible } },
      stylePrompt: projectRef.current.generationPrompt, reconstructionMask: mask, reconstructionMaskBounds: bounds,
      expectedPivot: part.pivotHint, consistencyContext: buildCharacterConsistencyContext(projectRef.current),
    });
    return readImagePixels(result.image);
  }, [provider, source]);

  const buildRig = (allowIncomplete = false, confirmed = false, repaint = false) => run(repaint ? "Rig rebuilt with repainted hidden areas" : "Rig built, saved, and opened for review", async () => {
    if (projectRef.current.rigDefinition && !confirmed && !window.confirm("Rebuild from Prepare? This replaces the current rig. Choose Cancel to keep the current rig.")) { setMessage("Kept current rig"); return; }
    if (!state || !source) throw new Error("Prepare at least one source part");
    // Slivers of artwork left between hand-drawn loops join the nearest part, and each part's art is extended so the
    // character stays whole when its parts move. Shared with the agent build path.
    let prepared = await prepareRiggedPartArt(source.image, { width: source.width, height: source.height }, state, { foreground });
    const canonical = prepared.state;
    const prepareValidation = validatePrepare(canonical, { foreground, profile: anatomyProfile, allowIncomplete });
    setPrepareIssues(prepareValidation.issues);
    // Repainting takes minutes, so it only starts once the parts are known to build.
    if (repaint && prepareValidation.canBuild) {
      prepared = await prepareRiggedPartArt(source.image, { width: source.width, height: source.height }, state, {
        foreground, repaint: repaintHiddenArea,
        onRepaintProgress: (done, total) => setMessage(done < total ? `Repainting hidden areas on the Mac Studio · part ${done + 1} of ${total}` : "Repaint finished · building the rig"),
      });
    }
    if (!prepareValidation.canBuild) throw new Error(prepareValidation.canOverride ? "Some parts have not been drawn. Draw them, or choose “Build without the missing parts” in the panel on the right." : "Prepare contains invalid masks or geometry that cannot be overridden.");
    const segmentation = prepared.segmentation;
    if (!segmentation.parts.length) throw new Error("Accept or cut at least one part");
    const extracted = prepared.parts; const artBounds = prepared.artBounds;
    const proposal = buildRigProposal({ pixelScale: sourcePixelScale(project.sourceImage), name: project.name, parts: segmentation.parts, imageWidth: source.width, imageHeight: source.height, resolvedImages: Object.fromEntries(extracted.map((part) => [part.partId, part.image])), artBounds, partCutterState: canonical, topology: anatomyProfile });
    const validated = validateRigProposal(proposal);
    if (!validated.success) throw new Error(validated.message);
    const finalized = { ...canonical, finalized: true, updatedAt: now() };
    const reviews = detectOcclusionReviews(segmentation.parts);
    // A facing someone already chose survives a rebuild; it describes the art, which has not changed.
    const keptFacing = projectRef.current.rigDefinition?.metadata.facing;
    // With no facing chosen yet, the pose model's reading of the art sets it, so animations face the right way without asking.
    const poseView = typeof keptFacing === "string" ? null : (await findPose())?.view ?? null;
    // Which parts have invented hidden areas, and whether a model repainted them, so Rig can offer (or stop offering) a repaint.
    const hiddenAreaRepaint = prepared.repaint.length ? { model: "comfyui-inpainting", parts: prepared.repaint.map((outcome) => ({ partId: outcome.partId, status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) })) } : null;
    const rig = { ...validated.data.rig, metadata: { ...validated.data.rig.metadata, anatomyProfile, prepareOverrideAccepted: allowIncomplete, exclusiveSourceOwnership: true, filledParts: [...prepared.filledParts], ...(hiddenAreaRepaint ? { hiddenAreaRepaint } : {}), ...(typeof keptFacing === "string" ? { facing: keptFacing } : poseView ? { facing: poseView.facing, characterView: poseView.view, facingSource: "pose-model" } : {}) } };
    const next = projectPatch(projectRef.current, { stage: "rig", partCutterState: finalized, segmentationData: segmentation, extractedParts: extracted, reconstructedParts: reviews, rigDefinition: rig, skins: rig.skins, warnings: [...projectRef.current.warnings, ...validated.data.warnings, ...(allowIncomplete ? prepareValidation.issues.filter((issue) => issue.severity === "error").map((issue) => `Prepare override: ${issue.message}`) : [])] });
    const contractProblems = blockingRigProjectProblems(validateRigProject({ storageVersion: LOCAL_PROJECT_STORAGE_VERSION, project: next, rig, animations: null, selectedSkinId: rig.defaultSkinId }));
    if (contractProblems.length) throw new Error(`Prepare → Setup contract failed: ${contractProblems.map((problem) => problem.message).join("; ")}`);
    const saved = await characterStorage.save(next);
    setStoredProjectBytes(saved.approximateBytes);
    if (!saved.success) {
      projectRef.current = next; setProject(next);
      setPersistenceWarning(`Rig is built in memory, but ${saved.layer} failed: ${saved.message}. Setup was not opened. Retry save, then build again.`);
      throw new Error(`Rig was not opened because persistence failed in ${saved.layer}: ${saved.message}`);
    }
    setPersistenceWarning(null);
    writeRigEditorHandoffPointer(window.localStorage, next);
    commandService.activateProjectFromUi(next);
    router.push("/?mode=setup");
  });
  const reconstruct = () => run("Hidden-area repair ready for approval", async () => { if (!selectedPart || !source || !state) throw new Error("Select a part first"); if (!selection) throw new Error("Lasso or polygon the genuinely missing/occluded area before requesting reconstruction"); if (!providerCapabilities.reconstruction.available) throw new Error(`${provider.name} does not provide production reconstruction. The source part was left unchanged.`); const legacy = partCutToSegmentation(state).parts.find((part) => part.id === selectedPart.partId); if (!legacy) throw new Error("Selected part is unavailable"); const result = await provider.reconstructPart({ generationId: source.generationId, image: source.image, part: legacy, stylePrompt: project.generationPrompt, visiblePartImage: partPreview ?? undefined, reconstructionMask: selection.mask, reconstructionMaskBounds: selection.bounds, expectedPivot: selectedPart.pivot, consistencyContext: buildCharacterConsistencyContext(project) }); const candidatePixels = await readImagePixels(result.image); const candidateAlpha = Array.from({ length: candidatePixels.width * candidatePixels.height }, (_, index) => candidatePixels.data[index * 4 + 3]); const consistency = validateReconstructionAsset(selectedPart, candidatePixels.width, candidatePixels.height, { alpha: candidateAlpha }); const rotationPart = { ...selectedPart, mask: { width: candidatePixels.width, height: candidatePixels.height, alpha: candidateAlpha }, occlusionState: "reconstructed" as const }; const rotationTests = ([-20, 0, 20] as const).map((angle) => evaluateRotationTest(rotationPart, angle)); if (!consistency.passed) { patchPart(selectedPart.partId, { notes: [...selectedPart.notes, ...result.warnings, ...consistency.warnings] }, `Rejected structurally incompatible repair for ${selectedPart.label}`); throw new Error(`Reconstruction rejected: ${consistency.warnings.join("; ")}`); } patchPart(selectedPart.partId, { reconstructionImage: result.image, notes: [...selectedPart.notes, ...result.warnings, `${consistency.status} · bbox ratio ${consistency.sizeRatio.toFixed(2)} · pivot ${consistency.pivotDisplacement.toFixed(1)}px`, ...rotationTests.map((test) => `Rotation ${test.angle}° · ${test.passed ? "PASS" : `WARNING: ${test.warnings.join(", ")}`}`)] }, `Prepared validated hidden-area repair for ${selectedPart.label}`); setProject((current) => projectPatch(current, { reconstructedParts: [...current.reconstructedParts.filter((review) => review.partId !== selectedPart.partId), { partId: selectedPart.partId, likelyOccluded: true, confidence: .7, reason: "User requested hidden-area repair", decision: "unreviewed", reconstructedImage: result.image, reconstructionAccepted: false }] })); setSelection(null); });

  // "Rebuild" from Rig or Animate leaves a request for this project: the user already asked for it, so build straight away
  // with the same choice about missing parts that the existing rig was built with.
  const rebuildRequested = useRef(false);
  useEffect(() => {
    if (rebuildRequested.current || !state || !source || typeof window === "undefined") return;
    let requested: string | null = null; try { requested = window.sessionStorage.getItem(REBUILD_REQUEST_KEY); } catch { requested = null; }
    const request = parseRebuildRequest(requested);
    if (!request || request.projectId !== (hydrationIdentity.activeProjectId ?? "")) return;
    rebuildRequested.current = true; try { window.sessionStorage.removeItem(REBUILD_REQUEST_KEY); } catch { /* already consumed */ }
    // Not cancelled on re-render: the request is consumed above, so this is the only chance to run it.
    window.setTimeout(() => { void buildRig(projectRef.current.rigDefinition?.metadata.prepareOverrideAccepted === true, true, request.repaint); }, 0);
  });
  const updateOllamaSettings = (patch: Partial<OllamaSettings>) => { const next = { ...ollamaSettings, ...patch }; setOllamaSettings(next); saveOllamaSettings(window.localStorage, next); };
  const askAssistant = () => run("Local assistant proposal ready", async () => { const status = await refreshOllama(); if (!status.reachable || !status.enabled) throw new Error("Local AI unavailable"); setAssistantProposal(await ollama.propose({ action: selectedPart ? "explain_region" : "check_partition", prompt: assistantPrompt, existingRegionNames: state?.parts.map((part) => part.label), targetPartId: selectedPart?.partId })); });
  const semanticSuggestion = () => run("Local semantic suggestion ready", async () => { if (!selection || !source) throw new Error("Lasso a foreground region first"); const status = await refreshOllama(); const model = status.models.find((item) => item.name === status.selectedModel); if (!status.enabled || !model?.capabilities.includes("VISION")) throw new Error("A verified VISION model is required to inspect this selection"); const proposal = await ollama.propose({ action: "suggest_semantic", prompt: "Suggest the canonical semantic label for this selected character region.", imageBase64: source.image, existingRegionNames: state?.parts.map((part) => part.label) }); setAssistantProposal(proposal); if (proposal.semanticType) setSemantic(proposal.semanticType); });

  useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || commandPaletteOpen) return; const modifier = event.metaKey || event.ctrlKey; if (modifier && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; } if (state?.guidedManual && mode === "manual" && event.key.toLowerCase() === "s") { event.preventDefault(); execute(`Skipped ${semanticLabel(state.guidedManual.currentSemantic)}`, skipGuidedSemantic); recordBenchmark("skip", { semantic: state.guidedManual.currentSemantic }); return; } if (state?.guidedManual && mode === "manual" && event.key.toLowerCase() === "b") { event.preventDefault(); execute("Back one Guided Manual target", backGuidedSemantic); recordBenchmark("back"); return; } if (state?.guidedManual && mode === "manual" && event.key.toLowerCase() === "r") { event.preventDefault(); execute("Replace mode", (current) => setGuidedIntent(current, "replace")); return; } if (event.key === "Enter" && tool === "polygon" && path.length >= 3) { event.preventDefault(); completePolygon(); return; } if ((event.key === "[" || event.key === "]") && state?.parts.length) { event.preventDefault(); const currentIndex = Math.max(0, state.parts.findIndex((part) => part.partId === selectedPartId)); const offset = event.key === "]" ? 1 : -1; setSelectedPartId(state.parts[(currentIndex + offset + state.parts.length) % state.parts.length].partId); return; } if (selectedPart && state && source && ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)) { event.preventDefault(); const edge = event.key === "ArrowUp" ? "top" : event.key === "ArrowRight" ? "right" : event.key === "ArrowDown" ? "bottom" : "left"; const current = edge === "top" ? selectedPart.boundingBox.y : edge === "bottom" ? selectedPart.boundingBox.y + selectedPart.boundingBox.height : edge === "left" ? selectedPart.boundingBox.x : selectedPart.boundingBox.x + selectedPart.boundingBox.width; const direction = edge === "top" || edge === "left" ? -1 : 1; const step = Math.max(1, Math.round((edge === "left" || edge === "right" ? source.width : source.height) / 128)); execute(`Nudged ${selectedPart.label} ${edge} boundary`, (value) => reshapeRegionEdge(value, selectedPart.partId, edge, current + direction * step).state); return; } if (event.key === "1") { event.preventDefault(); setMessage("Parts stage active"); return; } if (event.key === "2") { event.preventDefault(); router.push("/?mode=setup"); return; } if (event.key === "3") { event.preventDefault(); router.push("/?mode=test"); return; } if (event.key === "4") { event.preventDefault(); router.push("/?mode=animate"); return; } if (event.key.toLowerCase() === "l" && !modifier && mode === "manual") { event.preventDefault(); setTool("lasso"); return; } if (event.key.toLowerCase() === "f") { event.preventDefault(); setZoom(1); return; } if (event.key === "Escape") { setSelection(null); setPath([]); return; } const shortcut = semanticShortcut[event.key.toLowerCase()]; if (shortcut) { setSemantic(shortcut); setMessage(`${semanticLabel(shortcut)} selected`); } }; window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener); });
  const coverage = useMemo(() => state ? analyzeCoverage(state, foreground) : null, [foreground, state]);
  const landmarkById = useMemo(() => new Map(state?.anatomicalGuide?.landmarks.map((landmark) => [landmark.landmarkId, landmark]) ?? []), [state?.anatomicalGuide]);
  const selectedContour = useMemo(() => state && selectedPartId ? simplifiedRegionContour(state, selectedPartId) : [], [selectedPartId, state]);
  const unresolvedOverlay = useMemo(() => state?.ownership?.runs.some((value, index) => index % 2 === 0 && value === 0) ? unresolvedMask(state) : null, [state]);
  const guidedProgress = state?.guidedManual && mode === "manual" ? state.guidedManual : undefined;
  const guidedComponents = useMemo(() => state?.guidedManual && foreground ? unresolvedComponents(state, foreground).filter((component) => component.bounds.width * component.bounds.height >= 16).slice(0, 8) : [], [foreground, state]);
  const prepareValidation = useMemo(() => state ? validatePrepare(state, { foreground, profile: anatomyProfile }) : null, [anatomyProfile, foreground, state]);
  const reviewObjectIds = useMemo(() => new Set(prepareValidation?.issues.map((issue) => issue.objectId) ?? []), [prepareValidation]);
  const partStatus = (part: PartCutRecord | undefined): PartStatus => !part ? "missing" : reviewObjectIds.has(part.partId) || !part.accepted || (part.provenance === "ai" && state?.ownership?.reviewStatus !== "accepted" && (part.confidence === null || part.confidence < .8)) ? "review" : "ready";
  const hiddenSemantics = useMemo(() => new Set(state ? hiddenGuideSemantics(state) : []), [state]);
  const bodyStatuses = GUIDED_BODY_ORDER.map((semanticType) => { const part = state?.parts.find((candidate) => candidate.semanticType === semanticType); return { semanticType, status: !part && hiddenSemantics.has(semanticType) ? "hidden" as const : partStatus(part) }; });
  const bodyReady = bodyStatuses.filter((item) => item.status === "ready" || item.status === "hidden").length; const bodyTotal = bodyStatuses.length;
  const equipmentParts = state?.parts.filter((part) => !isBodySemantic(part.semanticType)) ?? [];
  const needsReview = bodyStatuses.some((item) => item.status === "review") || equipmentParts.some((part) => partStatus(part) === "review");
  const skippedTargets = state?.guidedManual?.skippedSemantics ?? [];
  const pendingBody = bodyStatuses.filter((item) => item.status !== "ready" && !skippedTargets.includes(item.semanticType)).map((item) => item.semanticType);
  const currentTarget: PartSemanticType | null = guidedProgress ? guidedProgress.currentSemantic : selectedPart?.semanticType ?? null;
  const currentBodyIndex = currentTarget ? (GUIDED_BODY_ORDER as readonly PartSemanticType[]).indexOf(currentTarget) : -1;
  const nextTarget = [...GUIDED_BODY_ORDER.slice(currentBodyIndex + 1), ...GUIDED_BODY_ORDER.slice(0, Math.max(0, currentBodyIndex + 1))].find((semanticType) => semanticType !== currentTarget && pendingBody.includes(semanticType)) ?? null;
  const targetOrder: readonly PartSemanticType[] = guidedProgress?.phase === "equipment" ? GUIDED_EQUIPMENT_ORDER : GUIDED_BODY_ORDER;
  const targetPosition = guidedProgress && guidedProgress.phase !== "review" ? `${Math.max(0, targetOrder.indexOf(guidedProgress.currentSemantic)) + 1} / ${targetOrder.length}` : null;
  const currentStatus = partStatus(guidedProgress ? state?.parts.find((part) => part.semanticType === guidedProgress.currentSemantic) : selectedPart ?? undefined);
  const assistAvailable = Boolean(ollamaStatus?.reachable && ollamaStatus.enabled);
  const findMissingParts = () => { const region = coverage?.unassignedRegions[0]; if (!region) { setMessage("No unresolved foreground region was found"); return; } setSelection({ bounds: region, mask: { width: region.width, height: region.height, alpha: Array(region.width * region.height).fill(255) } }); setTool("lasso"); setShowParts(true); setShowCoverage(true); setMessage(`Selected unresolved foreground at ${region.x}, ${region.y}. Assign it to the intended semantic region.`); };
  const jumpToTarget = (semanticType: PartSemanticType, partId?: string) => {
    if (!state) return;
    const part = (partId ? state.parts.find((candidate) => candidate.partId === partId) : undefined) ?? state.parts.find((candidate) => candidate.semanticType === semanticType);
    if (part) setSelectedPartId(part.partId);
    setSelection(null); setPath([]);
    if (!guidedProgress && !part) setCutMode("manual");
    if (guidedProgress || !part) execute(`Target ${semanticLabel(semanticType)}`, (current) => { const base = initializeGuidedManual(current); return { ...base, guidedManual: { ...base.guidedManual!, phase: isBodySemantic(semanticType) ? "body" : "equipment", currentSemantic: semanticType, intent: "replace", updatedAt: now() }, updatedAt: now() }; });
    else setTool("select");
  };
  const partRow = (semanticType: PartSemanticType, label: string, part: PartCutRecord | undefined, key: string) => {
    const status: PartStatus = !part && hiddenSemantics.has(semanticType) ? "hidden" : partStatus(part);
    // What hides it, in words: a side view's far leg is behind the near one; an arm is behind the item it holds.
    const hiddenBy = status === "hidden" ? (/Arm|Forearm|Hand/.test(semanticType) ? "behind what it holds, drawn from the other arm" : state?.parts.some((candidate) => /Thigh|LowerLeg/.test(candidate.semanticType)) ? "behind the near leg, drawn from it" : "under the robe; the feet show the steps") : null; const current = guidedProgress ? guidedProgress.currentSemantic === semanticType : Boolean(part && part.partId === selectedPartId);
    return <button key={key} type="button" className="part-row" title={hiddenBy ? `Hidden ${hiddenBy}` : undefined} data-status={status} data-semantic={semanticType} aria-current={current ? "true" : undefined} aria-label={`${part && !isBodySemantic(semanticType) ? label : semanticLabel(semanticType)}, ${PART_STATUS[status].word}${hiddenBy ? ` ${hiddenBy}` : ""}`} onClick={() => jumpToTarget(semanticType, part?.partId)}><i aria-hidden="true">{PART_STATUS[status].glyph}</i><span>{label}</span></button>;
  };
  const reassembleSource = () => { if (!state) return; const result = validateReassembly(state, foreground); setShowParts(true); setShowCoverage(true); setSelection(null); setPath([]); setZoom(1); setMessage(result.passed ? "Reassembly matches the source with no gaps, duplicates, or coordinate drift" : `Reassembly check: ${result.diagnostics.join("; ")}`); };
  const restoreSourceView = () => { setSelection(null); setPath([]); setShowParts(false); setShowCoverage(false); setZoom(1); setMessage("Restored the untouched source view. Existing parts remain available."); };
  const selectStudioMode = (studioMode: "setup" | "test" | "animate" | "prepare"): void => { if (studioMode === "setup") router.push("/?mode=setup"); else if (studioMode === "test") router.push("/?mode=test"); else if (studioMode === "animate") router.push("/?mode=animate"); };
  const selectionLabel = selectedPart ? humanizeTechnicalId(selectedPart.label) : selection ? "New mask selection" : "Character source";
  const agentStatus = presentAgentStatus(agent);
  const commands: StudioCommand[] = [
    { id: "prepare", label: "Parts", description: "Define the pieces of your character that can move", group: "Mode", shortcut: "1", run: () => setMessage("Parts stage active") },
    { id: "setup", label: "Rig", description: "Connect the parts with bones and pivots", group: "Mode", shortcut: "2", run: () => selectStudioMode("setup") },
    { id: "test", label: "Test", description: "Pose the character and confirm the rig behaves", group: "Mode", shortcut: "3", run: () => selectStudioMode("test") },
    { id: "animate", label: "Animate", description: "Create and edit motion", group: "Mode", shortcut: "4", run: () => selectStudioMode("animate") },
    { id: "ai-cut", label: segmentationAvailable ? "Refine Anatomical Zones" : "AI Refinement · Unavailable", description: segmentationAvailable ? `Landmark-guided boundary refinement through ${provider.name}` : "No image-conditioned segmentation provider is configured", group: "AI", keywords: "automatic skeleton landmark anatomy zone mask", disabled: !segmentationAvailable, run: () => void requestCut(prompt) },
    { id: "manual-cut", label: "Manual Cut", description: "Switch to direct selection and mask editing", group: "Cut", keywords: "cut part", run: () => setCutMode("manual") },
    { id: "smart-select", label: "Select Region", description: "Click a semantic region directly on the character", group: "Tool", keywords: "detect foreground region", run: () => setTool("select") },
    { id: "lasso", label: "Lasso selection", description: "Draw a freeform region for a new part", group: "Tool", keywords: "cut polygon freeform", run: () => setTool("lasso") },
    { id: "polygon", label: "Polygon Lasso", description: "Click polygon points and double-click to close", group: "Tool", keywords: "cut polygon", run: () => setTool("polygon") },
    { id: "brush-add", label: "Brush Assign", description: "Transfer pixels to the selected semantic region", group: "Tool", run: () => setTool("brush") },
    { id: "brush-remove", label: "Mark Unresolved", description: "Hold Alt while brushing to mark foreground unresolved", group: "Tool", run: () => setTool("brush") },
    { id: "missing", label: "Find Missing Parts", description: "Select the first unassigned foreground region", group: "Review", run: findMissingParts },
    { id: "review-unresolved", label: "Review Unresolved Parts", description: activeProposal ? `${activeProposal.parts.length} proposed parts still need a decision` : "No unresolved AI parts", group: "Review", keywords: "accept safe missing anatomy", disabled: !activeProposal, run: () => setShowParts(true) },
    { id: "repair-hidden", label: "Repair Hidden Area", description: selectedPart ? `Request a reviewed reconstruction for ${selectedPart.label}` : "Select a part first", group: "Review", keywords: "repair reconstruct occlusion", disabled: !selectedPart || !providerCapabilities.reconstruction.available, run: () => void reconstruct() },
    { id: "reassemble", label: "Reassemble Source", description: "Check gaps, overlap, and source-coordinate drift", group: "Review", keywords: "preview quality gate", run: reassembleSource },
    { id: "coverage", label: showCoverage ? "Hide coverage" : "Show coverage", description: "Toggle assigned, missing, and overlapping pixel totals", group: "View", run: () => setShowCoverage((value) => !value) },
    { id: "guide", label: showGuide ? "Hide landmark guide" : "Show landmark guide", description: "Toggle the project-owned skeleton and anatomical zone envelopes", group: "View", run: () => setShowGuide((value) => !value) },
    { id: "names", label: showNames ? "Hide part names" : "Show part names", description: "Toggle labels over every part; the selected part stays labeled", group: "View", run: () => setShowNames((value) => !value) },
    { id: "fit", label: "Fit character", description: "Reset the source view to its working scale", group: "View", shortcut: "F", run: () => setZoom(1) },
    { id: "restore", label: "Clean source preview", description: "Hide all overlays without deleting part work", group: "View", run: restoreSourceView },
    { id: "undo", label: "Undo", description: historyUi.undoLabel ?? "No part change to undo", group: "Edit", shortcut: "⌘Z", disabled: !historyUi.canUndo, run: undo },
    { id: "redo", label: "Redo", description: "Restore the last undone part change", group: "Edit", shortcut: "⇧⌘Z", disabled: !historyUi.canRedo, run: redo },
    { id: "build-rig", label: "Build Rig", description: "Extract accepted parts and open the existing rig pipeline", group: "Complete", keywords: "rig build skeleton validate", disabled: !state?.parts.length || Boolean(busy), run: () => void buildRig() },
  ];

  const stepState: StepState = { hasArt: Boolean(source), partsCut: Boolean(state?.parts.length), hasRig: Boolean(project.rigDefinition), rigValid: Boolean(project.rigDefinition) };
  if (!source || !state) return <main className="part-cutter-shell"><input ref={importRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void importSprite(event)} /><StepShell step="parts" state={stepState} projectName={benchmarkMode ? "Guided Manual TTR" : "Untitled character"} saved="not-saved"
      stage={benchmarkMode ? <section className="guided-benchmark-start"><div><span>Internal benchmark · {Math.min(benchmarkRun.currentIndex + 1, 10)}/10</span><h1>Guided Manual human timing</h1><p>{benchmarkRun.currentIndex < GUIDED_BENCHMARK_COHORT.length ? GUIDED_BENCHMARK_COHORT[benchmarkRun.currentIndex].name : "All ten character sessions are recorded."}</p><button type="button" className="primary" disabled={benchmarkRun.currentIndex >= GUIDED_BENCHMARK_COHORT.length} onClick={startBenchmarkCharacter}>Start Character</button><small>Timing begins on your first workflow action. Source-backed truth remains hidden until completion.</small></div></section> : <section className="part-cutter-empty"><div><span>Parts</span><h1>Start with your character’s art.</h1><p>Import a drawing or generate one, then mark the pieces that should move.</p><div className="prepare-empty-actions"><button type="button" className="primary" onClick={() => importRef.current?.click()}>New from image…</button><Link href="/create-character">Generate with AI…</Link></div></div></section>} panel={<><p className="panel-label">Parts</p><p className="panel-note">Parts are cut from the character&apos;s art. Choose or upload art first.</p></>}
      instruction="Start with your character's art." primary={{ label: "Choose art →", onClick: () => window.location.assign("/create-character") }} /><StudioCommandPalette commands={commands} mode="prepare" selection="Character source" open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} /></main>;

  const prepareProblemCount = activeProposal?.parts.length ?? prepareIssues.filter((issue) => issue.severity === "error").length;
  const completeGuidedReview = () => {
    if (!state) return;
    const validation = validatePrepare(ensureOwnershipPartition(state), { foreground, profile: anatomyProfile, allowIncomplete: false });
    setPrepareIssues(validation.issues);
    if (!validation.canBuild) { recordBenchmark("validation"); setMessage("Not production-ready yet · choose an issue to return to its semantic"); return; }
    if (!benchmarkMode) { void buildRig(); return; }
    const completedAt = Date.now();
    setBenchmarkRun((current) => finishGuidedBenchmarkCharacter(recordGuidedBenchmarkEvent(current, { eventId: `${current.activeSourceId}-validation-${completedAt}`, action: "validation", at: completedAt }), completedAt, true, ensureOwnershipPartition(state)));
    setMessage("Production-ready validation passed · timing stopped");
  };
  const advanceBenchmark = () => {
    setBenchmarkRun((current) => nextGuidedBenchmarkCharacter(current));
    setState(null); setProject(createGeneratedCharacterProject("Imported Character", "")); historyRef.current = null;
    setHistoryUi({ canUndo: false, canRedo: false, undoLabel: null }); setForeground(undefined); setMessage("Ready for the next frozen character");
  };
  const downloadBenchmarkResults = () => {
    const blob = new Blob([serializeGuidedBenchmarkRun(benchmarkRun)], { type: "application/json" }); const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = "guided-manual-human-timing.json"; link.click(); URL.revokeObjectURL(url);
  };

  return <main className={`part-cutter-shell ${guidedProgress ? "guided-manual-active" : ""}`} onPointerDownCapture={onLandmarkPointerDown}>
    <input ref={importRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void importSprite(event)} />
    {benchmarkMode && <section className="guided-benchmark-banner" aria-label="Human timing status"><strong>HUMAN TTR · {benchmarkRun.currentIndex + 1}/10</strong><span>{benchmarkRun.activeEvents.length ? "Timing active" : "Ready · timer starts on first action"}</span><small>Truth hidden</small></section>}
    <StepShell step="parts" state={stepState} projectName={project.name || "New character"} saved={storedProjectBytes === null ? "unsaved" : "saved"}
      onUndo={undo} onRedo={redo} canUndo={historyUi.canUndo} canRedo={historyUi.canRedo}
      stage={<div className="part-cutter-body">
      <aside className="cutter-left" aria-label="Character parts"><div className="cutter-panel-title"><span>Character parts</span><small>{bodyReady} / {bodyTotal} ready</small></div><div className="semantic-tree parts-checklist">
        <section aria-label="Body"><h3>Body</h3>{BODY_CHECKLIST.map((group) => <div className="part-group" key={group.heading ?? "core"}>{group.heading && <h4>{group.heading}</h4>}{group.rows.map(([semanticType, label]) => partRow(semanticType, label, state.parts.find((part) => part.semanticType === semanticType), semanticType))}</div>)}</section>
        <section aria-label="Equipment"><h3>Equipment</h3>{equipmentParts.map((part) => partRow(part.semanticType, humanizeTechnicalId(part.label), part, part.partId))}<details className="part-add"><summary>Add equipment</summary>{GUIDED_EQUIPMENT_ORDER.filter((semanticType) => semanticType === "custom" || !equipmentParts.some((part) => part.semanticType === semanticType)).map((semanticType) => <button key={semanticType} type="button" className="part-row part-add-target" onClick={() => jumpToTarget(semanticType)}><i aria-hidden="true">+</i><span>{semanticLabel(semanticType)}</span></button>)}</details></section>
      </div></aside>
      <section className="cutter-center"><div className="cutter-toolbar">
        <div className="cut-mode-tabs" role="tablist" aria-label="Editing mode">{([["manual", "Guided", "Draw each part in turn"], ["auto", "Free edit", "Select and reshape existing parts"]] as const).map(([item, label, hint]) => <button key={item} type="button" role="tab" aria-selected={mode === item} className={mode === item ? "active" : ""} title={hint} onClick={() => setCutMode(item)}>{label}</button>)}</div>
        <button type="button" className={`ai-assist-toggle ${mode === "assisted" ? "active" : ""}`} aria-pressed={mode === "assisted"} disabled={!assistAvailable && mode !== "assisted"} title={assistAvailable ? "AI assist: ask the local model about this character" : "AI assist unavailable: the local model is not running or is switched off"} onClick={() => setCutMode(mode === "assisted" ? "manual" : "assisted")}>AI assist</button>
        {segmentationAvailable && !state.parts.length && <button type="button" className="auto-cut-action" aria-busy={Boolean(busy)} disabled={Boolean(busy)} title="Cut the character into parts automatically, then review each one" onClick={() => { if (mode !== "auto") setCutMode("auto"); void requestCut(prompt); }}>Automatic cut</button>}
        <i className="toolbar-divider" />
        <div className="tool-group primary-region-tools">
          <button type="button" className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}>Select</button>
          {mode === "auto" && <><button type="button" className={tool === "reshape" ? "active" : ""} disabled={!selectedPart} onClick={() => setTool("reshape")}>Reshape</button><button type="button" disabled={!selectedPart} onClick={() => selectedPart && setMessage(`Split ${selectedPart.label} from the inspector`)}>Split</button><button type="button" disabled={!selectedPart} onClick={() => selectedPart && setMessage(`Merge ${selectedPart.label} with an adjacent region from the inspector`)}>Merge</button></>}
          {mode === "manual" && guidedProgress && <><button type="button" className={tool === "click" ? "" : "active"} title="Lasso (L)" onClick={() => setTool("lasso")}>Lasso</button><button type="button" className={tool === "click" ? "active" : ""} disabled={!clickSelectAvailable || clickBusy} title={clickSelectAvailable ? "Click to select: click an item and SAM2 outlines the whole of it" : "Click to select needs ComfyUI with SAM2 on the Studio"} onClick={() => setTool("click")}>{clickBusy ? "Selecting…" : "Click"}</button><button type="button" title="Undo (⌘Z)" disabled={!historyUi.canUndo} onClick={undo}>Undo</button><button type="button" title="Redo (⇧⌘Z)" disabled={!historyUi.canRedo} onClick={redo}>Redo</button></>}
          {mode === "manual" && !guidedProgress && <><button type="button" className={tool === "lasso" ? "active" : ""} onClick={() => setTool("lasso")}>Lasso Cut</button><button type="button" className={tool === "polygon" ? "active" : ""} onClick={() => setTool("polygon")}>Polygon Cut</button><button type="button" className={tool === "brush" ? "active" : ""} disabled={!selectedPart && manualIntent !== "new"} onClick={() => setTool("brush")}>Brush</button><button type="button" disabled={!selectedPart} onClick={() => selectedPart && execute(`Split ${selectedPart.label}`, (current) => splitPart(current, selectedPart.partId))}>Split</button><button type="button" disabled={!selectedPart} onClick={() => { const neighbor = selectedPart && state.ownership?.adjacency[selectedPart.partId]?.[0]; if (selectedPart && neighbor) execute(`Merged ${selectedPart.label}`, (current) => mergeParts(current, [selectedPart.partId, neighbor])); }}>Merge</button></>}
          {mode === "assisted" && <><button type="button" disabled={!ollamaStatus?.reachable || !ollamaStatus.enabled} title={ollamaStatus?.reachable && ollamaStatus.enabled ? "Ask the selected local model" : "Local AI unavailable"} onClick={() => void askAssistant()}>Ask</button><button type="button" disabled={!ollamaStatus?.reachable || !ollamaStatus.enabled} title={ollamaStatus?.reachable && ollamaStatus.enabled ? "Suggest a semantic label" : "Local AI unavailable"} onClick={() => void semanticSuggestion()}>Suggest</button><button type="button" disabled={!selectedPart || !ollamaStatus?.reachable || !ollamaStatus.enabled} title={!ollamaStatus?.reachable || !ollamaStatus.enabled ? "Local AI unavailable" : "Propose a local edge refinement"}>Refine Edge</button></>}
        </div>
        {mode === "manual" && !guidedProgress && <div className="manual-intent" aria-label="Lasso mode">{(["new", "add", "remove"] as const).map((intent) => <button key={intent} type="button" className={manualIntent === intent ? "active" : ""} disabled={intent !== "new" && !selectedPart} onClick={() => setManualIntent(intent)}>{intent === "new" ? "New Part" : intent}</button>)}</div>}
        {tool === "brush" && <label className="brush-control">Size <input type="range" min={1} max={128} value={brushSize} onChange={(event) => setBrushSize(event.target.valueAsNumber)} /><b>{brushSize}px</b></label>}
        <span className="cutter-toolbar-spacer" /><button type="button" className="reassemble-action" onClick={reassembleSource}>Check</button><details className="cutter-view-popover" data-dismissible-menu><summary>View⌄</summary><div><button type="button" onClick={() => setShowNames((value) => !value)} className={showNames ? "active" : ""}>Region names</button><button type="button" onClick={() => setShowCoverage((value) => !value)} className={showCoverage ? "active" : ""}>Unresolved pixels</button>{state.anatomicalGuide && <button type="button" onClick={() => setShowGuide((value) => !value)} className={showGuide ? "active" : ""}>Anatomical guide</button>}<button type="button" onClick={() => setIsolatedPartId(null)}>Show all</button><button type="button" title="Fit character (F)" onClick={() => setZoom(1)}>Fit character</button><button type="button" onClick={restoreSourceView}>Clean source preview</button></div></details>
      </div>
        <div className="cutter-canvas-wrap" role="region" aria-label="Character cutting canvas" tabIndex={0}><div className={`cutter-canvas ${isolatedPartId ? "is-isolating" : ""}`} style={{ aspectRatio: `${source.width}/${source.height}`, transform: `scale(${zoom})`, "--source-ratio": source.width / source.height } as CSSProperties}><img src={source.image} alt="Character source for part cutting" /><svg viewBox={`0 0 ${source.width} ${source.height}`} data-tool={tool} onPointerDown={onCanvasDown} onPointerMove={onCanvasMove} onPointerUp={onCanvasUp} onPointerLeave={onCanvasUp} onDoubleClick={completePolygon}>{showGuide && state.anatomicalGuide && <g className="anatomical-guide" data-guide-status={state.anatomicalGuide.status}>{state.anatomicalGuide.zones.map((zone) => <rect key={zone.zoneId} data-zone-id={zone.zoneId} data-current={guidedProgress?.currentSemantic === zone.semanticType || undefined} x={zone.bounds.x} y={zone.bounds.y} width={zone.bounds.width} height={zone.bounds.height} rx={Math.max(2, source.width / 180)} />)}{state.anatomicalGuide.landmarks.map((landmark) => { const parent = landmark.parentLandmarkId ? landmarkById.get(landmark.parentLandmarkId) : null; return <g key={landmark.landmarkId} data-landmark-id={landmark.landmarkId}>{parent && <line x1={parent.point.x} y1={parent.point.y} x2={landmark.point.x} y2={landmark.point.y} />}<circle className="guide-landmark-hit" cx={landmark.point.x} cy={landmark.point.y} r={Math.max(2.5, source.width / 220)} /><circle className="guide-landmark-point" cx={landmark.point.x} cy={landmark.point.y} r={Math.max(0.35, source.width / 400)} /></g>; })}</g>}{unresolvedOverlay && showCoverage && <path className="unresolved-region" d={maskSvgPath(unresolvedOverlay, { x: 0, y: 0, width: source.width, height: source.height })} />}{showParts && state.parts.map((part, index) => <g key={part.partId} data-region-id={part.partId} data-guided-state={guidedProgress?.currentSemantic === part.semanticType ? "current" : guidedProgress?.completedSemantics.includes(part.semanticType) ? "complete" : undefined} className={[part.partId === selectedPartId ? "selected" : "", part.partId === hoveredPartId ? "hovered" : "", isolatedPartId && isolatedPartId !== part.partId ? "dimmed" : ""].filter(Boolean).join(" ")} onPointerEnter={() => setHoveredPartId(part.partId)} onPointerLeave={() => setHoveredPartId((current) => current === part.partId ? null : current)} onDoubleClick={(event) => { event.stopPropagation(); setSelectedPartId(part.partId); setIsolatedPartId((current) => current === part.partId ? null : part.partId); }} onPointerDown={(event) => { if (tool !== "select" && tool !== "reshape") return; event.stopPropagation(); setSelectedPartId(part.partId); setMessage(`${part.label} selected · drag a cyan edge handle to reshape`); }}><path d={maskSvgPath(part.mask, part.boundingBox)} style={{ "--part-color": `var(--overlay-${index % 6})` } as React.CSSProperties} />{(showNames || part.partId === selectedPartId || part.partId === hoveredPartId) && <text x={part.boundingBox.x + 3} y={Math.max(labelSize, part.boundingBox.y + labelSize)} style={{ fontSize: labelSize }}>{humanizeTechnicalId(part.label)}</text>}</g>)}{selectedPart && (tool === "select" || tool === "reshape") && <g className="region-controls" data-testid="region-controls"><polyline className="simplified-contour" points={selectedContour.map((point) => `${point.x},${point.y}`).join(" ")} /><rect className="region-bounds" x={selectedPart.boundingBox.x} y={selectedPart.boundingBox.y} width={selectedPart.boundingBox.width} height={selectedPart.boundingBox.height} /><circle data-edge="top" cx={selectedPart.boundingBox.x + selectedPart.boundingBox.width / 2} cy={selectedPart.boundingBox.y} r={Math.max(3, source.width / 180)} onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); boundaryDragRef.current = { base: state, partId: selectedPart.partId, edge: "top" }; setDrawing(true); }} /><circle data-edge="right" cx={selectedPart.boundingBox.x + selectedPart.boundingBox.width} cy={selectedPart.boundingBox.y + selectedPart.boundingBox.height / 2} r={Math.max(3, source.width / 180)} onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); boundaryDragRef.current = { base: state, partId: selectedPart.partId, edge: "right" }; setDrawing(true); }} /><circle data-edge="bottom" cx={selectedPart.boundingBox.x + selectedPart.boundingBox.width / 2} cy={selectedPart.boundingBox.y + selectedPart.boundingBox.height} r={Math.max(3, source.width / 180)} onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); boundaryDragRef.current = { base: state, partId: selectedPart.partId, edge: "bottom" }; setDrawing(true); }} /><circle data-edge="left" cx={selectedPart.boundingBox.x} cy={selectedPart.boundingBox.y + selectedPart.boundingBox.height / 2} r={Math.max(3, source.width / 180)} onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); boundaryDragRef.current = { base: state, partId: selectedPart.partId, edge: "left" }; setDrawing(true); }} /></g>}{previewPiece && <path className="piece-preview" d={maskSvgPath(previewPiece.mask, previewPiece.bounds)} />}{selection && <rect className="selection" x={selection.bounds.x} y={selection.bounds.y} width={selection.bounds.width} height={selection.bounds.height} />}{path.length > 1 && <polyline className="assignment-path" points={path.map((point) => `${point.x},${point.y}`).join(" ")} />}</svg><div className="coverage-legend"><span>{bodyReady} / {bodyTotal} parts ready</span>{coverage?.unassignedPixels ? <button type="button" className="unassigned-toggle" aria-pressed={showCoverage} onClick={() => setShowCoverage((value) => !value)}>Show unassigned artwork</button> : null}{state && state.parts.length > 0 ? <button type="button" className="unassigned-toggle" onClick={startOver} title="Clear every part and cut this picture again (Undo brings it back)">Start over</button> : null}</div><div className="canvas-region-readout">{guidedProgress ? `${semanticLabel(guidedProgress.currentSemantic)}${targetPosition ? `  ${targetPosition}` : ""} · ${guidedProgress.intent}` : hoveredPartId ? state.parts.find((part) => part.partId === hoveredPartId)?.label : (selectedPart ? humanizeTechnicalId(selectedPart.label) : "Click a part")}</div></div></div>
        {selection && !guidedProgress && <div className="semantic-chooser" role="dialog" aria-label="Assign manual selection"><header><strong>{manualIntent === "new" ? "Name new part" : manualIntent === "add" ? "Add to region" : "Remove from region"}</strong><span>{selection.mask.alpha.filter(Boolean).length.toLocaleString()} foreground px</span></header>{manualIntent === "new" ? <><select autoFocus value={semantic} onChange={(event) => setSemantic(event.target.value as PartSemanticType)}>{PART_SEMANTIC_TYPES.filter((type) => type !== "root").map((type) => <option key={type} value={type}>{semanticLabel(type)}</option>)}</select>{semantic === "custom" && <input value={customLabel} onChange={(event) => setCustomLabel(event.target.value)} placeholder="Custom part name" />}<div><button type="button" onClick={() => void semanticSuggestion()} disabled={!ollamaStatus?.models.find((item) => item.name === ollamaStatus.selectedModel)?.capabilities.includes("VISION")}>Suggest</button><button type="button" className="primary" onClick={cutSelection}>Create Part</button></div></> : <><p>{selectedPart ? humanizeTechnicalId(selectedPart.label) : "Select a target region first"}</p><div><button type="button" onClick={() => { setSelection(null); setPath([]); }}>Cancel</button><button type="button" className="primary" disabled={!selectedPart} onClick={() => applySelection(manualIntent === "remove" ? "unresolved" : "selected")}>{manualIntent === "remove" ? "Remove" : "Add"}</button></div></>}<button type="button" className="chooser-close" aria-label="Cancel selection" onClick={() => { setSelection(null); setPath([]); }}>×</button></div>}
      </section>
      </div>}
      panel={<div className="cutter-right">
        {guidedProgress && <section className="guided-manual-panel" aria-label="Guided Manual workflow">
          <header><span><small>{guidedProgress.phase === "body" ? `Body · ${targetPosition}` : guidedProgress.phase === "equipment" ? `Equipment · ${targetPosition}` : "Final review"}</small><strong>{semanticLabel(guidedProgress.currentSemantic)}</strong></span><b className="part-status" data-status={currentStatus} aria-label={`Status: ${PART_STATUS[currentStatus].word}`}><i aria-hidden="true">{PART_STATUS[currentStatus].glyph}</i>{PART_STATUS[currentStatus].word}</b></header>
          {guidedProgress.phase !== "review" && <><p>{guidedProgress.phase === "equipment" ? `${clickSelectAvailable ? "Click the item with the Click tool, or draw a loop around it." : "Draw a loop around the item."} Skip anything this character does not carry.` : "Draw one loop around this part. A valid loop saves it and moves on to the next part."}</p>{guidedProgress.phase === "body" && guidedProgress.completedSemantics.length < GUIDED_BODY_ORDER.length && <div className="guided-cut-all"><div className="guided-proportions" role="radiogroup" aria-label="Body proportions">{(["auto", "chibi", "adult"] as const).map((value) => <button type="button" key={value} role="radio" aria-checked={proportions === value} className={proportions === value ? "active" : ""} onClick={() => setProportions(value)} title={value === "auto" ? "Decide from the drawing: squat figures are chibi, slender ones adult" : value === "chibi" ? "Big head, short body: most game sprites" : "Realistic or near-realistic figures: small head, long legs"}>{value === "auto" ? "Auto" : value === "chibi" ? "Chibi" : "Adult"}</button>)}</div><button type="button" className="guided-cut-all-button" disabled={!foreground} onClick={() => void cutAllParts()}>Cut all parts</button><small>{guidedProgress.completedSemantics.length ? "Cuts the parts that are left from the suggested outlines. Your parts stay as they are." : "Cuts every part from the suggested outlines at once. Then fix any that are wrong."}</small></div>}<div className="guided-intents" aria-label="Ownership intent">{(["replace", "add", "remove"] as const).map((intent) => <button type="button" key={intent} className={guidedProgress.intent === intent ? "active" : ""} onClick={() => execute(`${intent} mode`, (current) => setGuidedIntent(current, intent))}>{intent}</button>)}</div><div className="guided-nav"><button type="button" title="Back one part (B)" onClick={() => { execute("Back one Guided Manual target", backGuidedSemantic); recordBenchmark("back", { semantic: guidedProgress.currentSemantic }); }}>← Back <kbd>B</kbd></button><button type="button" title="Skip this part (S)" onClick={() => { execute(`Skipped ${semanticLabel(guidedProgress.currentSemantic)}`, skipGuidedSemantic); recordBenchmark("skip", { semantic: guidedProgress.currentSemantic }); }}>Skip <kbd>S</kbd></button></div>{state.anatomicalGuide?.zones.some((zone) => zone.semanticType === guidedProgress.currentSemantic) && <div className="guided-assists"><button type="button" disabled={!foreground || !state.anatomicalGuide?.zones.some((zone) => zone.semanticType === guidedProgress.currentSemantic)} onClick={() => { if (!foreground) return; const selected = guideSelectionForCurrent(state, foreground); if (selected) commitGuided(selected, "use-guide"); else setMessage("No foreground exists inside this semantic guide."); }}>Use Guide</button><small>Fills this part from the suggested outline, using only the character artwork. Pixels you already drew keep their owner.</small></div>}{guidedComponents.length > 0 && <div className="guided-components"><strong>Unassigned pieces</strong>{guidedComponents.map((component, index, all) => <button type="button" key={`${component.bounds.x}-${component.bounds.y}-${index}`} title={`Give this piece to ${SEMANTIC_TAXONOMY[guidedProgress.currentSemantic].label.toLowerCase()}`} onMouseEnter={() => setPreviewPiece(component)} onMouseLeave={() => setPreviewPiece(null)} onFocus={() => setPreviewPiece(component)} onBlur={() => setPreviewPiece(null)} onClick={() => { setPreviewPiece(null); commitGuided(component, "use-component"); }}><span>{pieceName(component)}{all.filter((other) => pieceName(other) === pieceName(component)).length > 1 ? ` (${all.slice(0, index + 1).filter((other) => pieceName(other) === pieceName(component)).length})` : ""}</span><small>{component.mask.alpha.filter(Boolean).length.toLocaleString()} px</small></button>)}</div>}</>}
          {guidedProgress.phase === "review" && <div className="guided-review"><p>{guidedProgress.skippedSemantics.length ? `${guidedProgress.skippedSemantics.length} skipped targets need a decision.` : "Body and equipment passes complete. Run production validation when the ownership looks trustworthy."}</p>{guidedProgress.skippedSemantics.map((item) => <button type="button" key={item} onClick={() => execute(`Review ${semanticLabel(item)}`, (current) => ({ ...current, guidedManual: { ...current.guidedManual!, phase: GUIDED_BODY_ORDER.includes(item as typeof GUIDED_BODY_ORDER[number]) ? "body" : "equipment", currentSemantic: item, intent: "replace", updatedAt: now() }, updatedAt: now() }))}><span>{semanticLabel(item)}</span><small>Skipped · jump back</small></button>)}{prepareIssues.map((issue) => <button type="button" key={issue.id} onClick={() => { const part = state.parts.find((candidate) => candidate.partId === issue.objectId); if (part) execute(`Review ${part.label}`, (current) => ({ ...current, guidedManual: { ...current.guidedManual!, phase: GUIDED_BODY_ORDER.includes(part.semanticType as typeof GUIDED_BODY_ORDER[number]) ? "body" : "equipment", currentSemantic: part.semanticType, intent: "replace", updatedAt: now() }, updatedAt: now() })); setMessage(issue.suggestedAction); }}><span>{issue.message}</span><small>{issue.suggestedAction}</small></button>)}</div>}
        </section>}
        {benchmarkMode && benchmarkRun.truthVisible && benchmarkRun.results.length > 0 && <section className="guided-benchmark-result"><strong>Character {benchmarkRun.results.length}/10 recorded</strong><span>Production-ready · {(benchmarkRun.results.at(-1)!.activeInteractionMs / 1000).toFixed(1)}s hands-on · {(benchmarkRun.results.at(-1)!.rawElapsedMs / 1000).toFixed(1)}s raw</span><small>{guidedBenchmarkCounts(benchmarkRun.results.at(-1)!.events).lasso} lassos · source-backed evaluation now unlocked for the offline report</small><div>{benchmarkRun.currentIndex + 1 < GUIDED_BENCHMARK_COHORT.length && <button type="button" className="primary" onClick={advanceBenchmark}>Next Character</button>}<button type="button" onClick={downloadBenchmarkResults}>Export Results</button></div></section>}
        {!guidedProgress && (selectedPart ? <PartInspector part={selectedPart} padding={riggingPaddingFor(state, selectedPart.partId)} isolated={isolatedPartId === selectedPart.partId} refineAvailable={providerCapabilities.maskRefinement.available} onPatch={(patch, label) => patchPart(selectedPart.partId, patch, label)} onPadding={(padding) => execute(`Set ${selectedPart.label} rig padding`, (current) => setRiggingPadding(current, selectedPart.partId, padding))} onIsolate={() => setIsolatedPartId((current) => current === selectedPart.partId ? null : selectedPart.partId)} onRefine={() => providerCapabilities.maskRefinement.available ? setMessage(`Refine Edge prepared for ${selectedPart.label}; local provider refinement will preserve the ownership boundary`) : setMessage("Local edge refinement is unavailable; direct reshape remains authoritative")} onDelete={() => { execute(`Deleted ${selectedPart.label}`, (current) => removeOwnershipRegion(current, selectedPart.partId)); setSelectedPartId(null); }} onSplit={() => { const next = execute(`Split ${selectedPart.label}`, (current) => splitPart(current, selectedPart.partId)); setSelectedPartId(next?.parts.find((part) => part.partId === `${selectedPart.partId}-a`)?.partId ?? null); }} onMerge={() => { const neighborId = state.ownership?.adjacency[selectedPart.partId]?.[0]; if (neighborId) { const next = execute(`Merged ${selectedPart.label}`, (current) => mergeParts(current, [selectedPart.partId, neighborId])); setSelectedPartId(next?.parts.at(-1)?.partId ?? null); } else setMessage("This region has no adjacent region to merge"); }} /> : <div className="cutter-empty-panel">Click a part on the character to edit it.</div>)}
        {!guidedProgress && activeProposal && <p className="parts-note">{activeProposal.parts.length} suggested parts are waiting. Open Advanced to accept or reject them.</p>}
        {prepareIssues.length > 0 && <section className="prepare-validation" role="alert"><strong>Before building</strong>{prepareIssues.slice(0, 12).map((issue) => <button type="button" key={issue.id} className={issue.severity} onClick={() => { const part = state.parts.find((candidate) => candidate.partId === issue.objectId); if (part) setSelectedPartId(part.partId); setMessage(issue.suggestedAction); }}><span>{issue.message}</span><small>{issue.suggestedAction}</small></button>)}{prepareIssues.filter((issue) => issue.severity === "error").every((issue) => issue.overrideable) && <button type="button" className="continue-anyway" onClick={() => void buildRig(true)}>Build without the missing parts</button>}</section>}
        {mode === "assisted" && <section className="assist-panel"><header><strong>Local Assistant</strong><span>{ollamaStatus?.reachable && ollamaStatus.enabled ? `LOCAL · ${ollamaStatus.selectedModel ?? "select model"}` : "Local AI unavailable"}</span></header><textarea aria-label="Local assistant prompt" rows={4} value={assistantPrompt} onChange={(event) => setAssistantPrompt(event.target.value)} /><button type="button" className="primary" data-ux-role="secondary-action" disabled={!ollamaStatus?.reachable || !ollamaStatus.enabled || Boolean(busy)} onClick={() => void askAssistant()}>Ask Ollama</button>{assistantProposal && <article><strong>Proposal · requires acceptance</strong><p>{assistantProposal.summary}</p><small>{assistantProposal.rationale}</small>{assistantProposal.semanticType && <button type="button" onClick={() => { setSemantic(assistantProposal.semanticType!); setAssistantProposal(null); }}>Use {semanticLabel(assistantProposal.semanticType)}</button>}</article>}</section>}
        <details className="parts-advanced"><summary>Advanced</summary><div className="parts-advanced-body">
          {guidedProgress && guidedProgress.phase !== "review" && <div className="parts-advanced-row"><small>Move on to equipment and details</small>{guidedProgress.phase === "body" ? <button type="button" className="guided-phase-action" onClick={() => execute("Finished body pass", finishGuidedBody)}>Finish Body →</button> : <button type="button" className="guided-phase-action" onClick={() => execute("Opened final review", finishGuidedEquipment)}>Review Character →</button>}</div>}
          {activeProposal && <><div className="cutter-panel-title"><span>Suggested parts review</span><small>{activeProposal.parts.length}</small></div><div className="proposal-actions"><button type="button" className="primary" onClick={() => acceptSelected(false)}>Accept selected</button><button type="button" onClick={() => acceptSelected(true)}>Accept safe</button><button type="button" onClick={() => execute("Rejected unresolved AI parts", (current) => rejectProposal(current, activeProposal.proposalId))}>Reject</button></div></>}
                  {preparePhase === "REVIEWING" && <section className="partition-review"><strong>Partition review</strong><span>{state.parts.length} zones · {prepareProblemCount || coverage?.unassignedRegions.length || 0} need review</span></section>}
                  {mode === "auto" && state.anatomicalGuide?.adaptiveMetadata && <section className="adaptive-guide-review"><header><span><strong>Adaptive Guide</strong><small>{state.anatomicalGuide.adaptiveMetadata.proportionDescriptor.archetype.replaceAll("_", " ")} · {state.anatomicalGuide.adaptiveMetadata.runtimeMs.toFixed(1)} ms</small></span><button type="button" onClick={regenerateGuide}>Regenerate</button></header><p>{state.anatomicalGuide.adaptiveMetadata.needsReviewLandmarkIds.length ? `${state.anatomicalGuide.adaptiveMetadata.needsReviewLandmarkIds.length} landmarks need review` : "✓ Structural checks passed"}</p></section>}
                  {!guidedProgress && state.anatomicalGuide && !state.anatomicalGuide.adaptiveMetadata && <section className="adaptive-guide-review legacy"><header><span><strong>Legacy fixed guide</strong><small>Preserved without migration</small></span><button type="button" onClick={regenerateGuide}>Regenerate Guide</button></header><p>Regenerate explicitly to analyze the source alpha and create adaptive landmarks.</p></section>}
                  {mode === "auto" && <label className="anatomy-profile"><span>Anatomy profile</span><select value={anatomyProfile} onChange={(event) => { setAnatomyProfile(event.target.value as AnatomyProfile); setPrepareIssues([]); }}><option value="humanoid">Humanoid</option><option value="digitigrade">Digitigrade</option><option value="custom">Custom</option></select></label>}
                  <section className="background-controls" aria-label="Background handling"><strong>Foreground</strong><span>{coverage ? `${Math.round(coverage.percentAssigned * 100)}% assigned · ${Math.round((1 - coverage.percentAssigned) * 100)}% unresolved` : foregroundStatus}</span><div className="part-actions"><button type="button" onClick={() => setShowCoverage((value) => !value)}>Show Unresolved</button><button type="button" onClick={() => setForegroundRevision((value) => value + 1)}>Recheck</button></div></section>
                  {mode === "auto" && <div className={`ai-command ${segmentationAvailable ? "" : "unavailable"}`}><span>{segmentationAvailable ? `Boundary refinement · ${provider.name}` : "Boundary refinement"}</span>{segmentationAvailable ? <><label className="sr-only" htmlFor="boundary-refinement-prompt">Boundary refinement instructions</label><textarea id="boundary-refinement-prompt" aria-label="Boundary refinement instructions" rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} /><button type="button" className="primary" data-ux-role="secondary-action" aria-busy={Boolean(busy)} disabled={Boolean(busy)} onClick={() => void requestCut(prompt)}>{busy ? "Refining zones…" : "Refine Anatomical Zones"}</button></> : <small className="provider-unavailable">Optional image provider unavailable · manual tools remain ready</small>}</div>}
          {mode === "auto" && !segmentationAvailable && <div className="parts-provider-note" role="status" data-provider-state={providerHealth.state}><small>{providerHealth.state === "CHECKING" ? "Checking the AI-assisted cut…" : "AI-assisted cut is unavailable on the Studio. Cut all parts and the hand tools work as usual."}</small><div><button type="button" onClick={() => void retryProvider()}>Retry</button><button type="button" onClick={() => document.querySelector<HTMLDetailsElement>("details.connection-cluster")?.setAttribute("open", "")}>Open provider settings</button></div></div>}
        </div></details>
</div>}
      instruction={persistenceWarning ? `Draft storage needs attention: ${persistenceWarning}` : error ?? busy ?? message}
      tone={persistenceWarning || error ? "error" : "info"}
      secondary={persistenceWarning ? <button type="button" onClick={() => { void characterStorage.save(projectRef.current).then((result) => { setStoredProjectBytes(result.approximateBytes); setPersistenceWarning(result.success ? null : `Retry failed in ${result.layer}: ${result.message}`); }); }}>Retry save</button> : error ? <button type="button" onClick={() => setError(null)}>Dismiss</button> : null}
      primary={{ label: pendingBody.length > 0 ? "Next part" : benchmarkMode ? "Validate character" : "Build rig →", onClick: () => nextTarget ? jumpToTarget(nextTarget) : completeGuidedReview(), busy: Boolean(busy),
        disabled: (benchmarkMode && benchmarkRun.truthVisible) || (pendingBody.length > 0 && !nextTarget), disabledReason: pendingBody.length > 0 && !nextTarget ? "Draw this part to continue" : "Timing is finished for this character" }} />
    {ollamaSettingsOpen && <div className="ollama-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOllamaSettingsOpen(false); }}><section className="ollama-settings" role="dialog" aria-modal="true" aria-label="Local AI settings"><header><span><small>Settings · Intelligence · Local AI</small><strong>OLLAMA</strong></span><button type="button" onClick={() => setOllamaSettingsOpen(false)}>×</button></header><div className="ollama-status" data-online={ollamaStatus?.reachable}><i /><span><strong>{ollamaStatus?.reachable ? "Connected" : "Offline"}</strong><small>{ollamaStatus?.message ?? "Checking local endpoint"}</small></span><b>LOCAL</b></div><label>Endpoint<input value={ollamaSettings.endpoint} onChange={(event) => updateOllamaSettings({ endpoint: event.target.value })} /></label><label>Local Assistant Model<select value={ollamaStatus?.selectedModel ?? ""} disabled={!ollamaStatus?.models.length} onChange={(event) => updateOllamaSettings({ selectedModel: event.target.value || null })}><option value="">No model selected</option>{ollamaStatus?.models.map((model) => <option key={model.name} value={model.name}>{model.name} · {model.capabilities.join("/")}</option>)}</select></label><label className="ollama-enable"><input type="checkbox" checked={ollamaSettings.enabled} onChange={(event) => updateOllamaSettings({ enabled: event.target.checked })} /><span>Use Ollama</span></label><div className="ollama-settings-actions"><button type="button" onClick={() => void refreshOllama()}>Refresh Models</button><button type="button" className="primary" onClick={() => void refreshOllama().then((status) => setMessage(status.reachable ? "Ollama connection passed" : "Ollama is not running"))}>Test Connection</button></div><p>Requests stay on this localhost Ollama endpoint. Other configured providers may still use their own connections. Rig Studio works without Ollama.</p><section className="vision-review-status" aria-label="Vision review providers"><header><span><strong>VISION REVIEW</strong><small>{visionReviewStatus ? `${visionReviewStatus.policy.policy} · max ${visionReviewStatus.policy.maxAttempts} attempts` : "Provider-neutral review queue"}</small></span><button type="button" disabled={visionReviewStatusLoading} onClick={() => void refreshVisionReview()}>{visionReviewStatusLoading ? "Checking…" : "Refresh"}</button></header>{visionReviewStatusError && <p role="status">Bridge unavailable · {visionReviewStatusError}</p>}{visionReviewStatus?.providers.map((reviewProvider) => <div key={reviewProvider.providerId} data-ready={reviewProvider.available && reviewProvider.multimodal}><i /><span><strong>{reviewProvider.label}</strong><small>{reviewProvider.available && reviewProvider.multimodal ? reviewProvider.transport : reviewProvider.failureReason ?? reviewProvider.state}</small></span><b>{reviewProvider.available && reviewProvider.multimodal ? "READY" : "UNAVAILABLE"}</b></div>)}</section></section></div>}
    <StudioDialog open={confirmGuideRegeneration} title="Regenerate adaptive guide?" description="This project may contain legacy or manual landmark corrections. Regenerating from the source will replace those corrections with a new alpha-silhouette analysis." confirmLabel="Regenerate from Source" cancelLabel="Keep Current" onCancel={() => setConfirmGuideRegeneration(false)} onConfirm={applyGuideRegeneration} />
    <StudioDialog open={Boolean(pendingPartDeletion)} title="Delete prepared region?" description={pendingPartDeletion ? `${pendingPartDeletion.label.replace(/^Deleted /, "")} and its exclusive pixel ownership will be removed. The pixels become unresolved and the action remains undoable.` : ""} confirmLabel="Delete Region" cancelLabel="Keep Region" danger onCancel={() => { if (pendingPartDeletion?.partId) setSelectedPartId(pendingPartDeletion.partId); setPendingPartDeletion(null); }} onConfirm={() => { const pending = pendingPartDeletion; if (!pending) return; confirmedPartDeletionRef.current = true; execute(pending.label, pending.transform); confirmedPartDeletionRef.current = false; setPendingPartDeletion(null); setSelectedPartId(null); }} />
    <StudioCommandPalette commands={commands} mode="prepare" selection={selectionLabel} open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
  </main>;
}

function PartInspector({ part, padding, isolated, refineAvailable, onPatch, onPadding, onIsolate, onRefine, onDelete, onSplit, onMerge }: { readonly part: PartCutRecord; readonly padding: number; readonly isolated: boolean; readonly refineAvailable: boolean; readonly onPatch: (patch: Partial<PartCutRecord>, label: string) => void; readonly onPadding: (padding: number) => void; readonly onIsolate: () => void; readonly onRefine: () => void; readonly onDelete: () => void; readonly onSplit: () => void; readonly onMerge: () => void }) {
  const updateSemantic = (semanticType: PartSemanticType) => { const defaults = SEMANTIC_TAXONOMY[semanticType]; onPatch({ semanticType, label: defaults.label, suggestedParent: defaults.suggestedParentBone, layer: defaults.defaultLayerGroup, articulated: defaults.articulated, equipment: defaults.equipment }, `Relabeled ${part.label} as ${defaults.label}`); };
  return <section className="region-inspector"><div className="cutter-panel-title"><span>{part.label.toUpperCase()}</span><small>● editing</small></div><div className="region-status"><span>Status</span><strong>Review</strong></div><label className="region-semantic"><span>Semantic</span><select aria-label="Semantic region" value={part.semanticType} onChange={(event) => updateSemantic(event.target.value as PartSemanticType)}>{PART_SEMANTIC_TYPES.map((type) => <option key={type} value={type}>{semanticLabel(type)}</option>)}</select></label><div className="region-boundary-summary"><span>Boundary</span><strong>{part.mask.alpha.filter(Boolean).length.toLocaleString()} px</strong><small>Drag cyan handles on canvas</small></div><div className="region-primary-actions"><button type="button" disabled={!refineAvailable} title={refineAvailable ? "Refine only this local semantic edge" : "No local refinement provider is available"} onClick={onRefine}>Refine Edge</button><button type="button" className={isolated ? "active" : ""} onClick={onIsolate}>{isolated ? "Show All" : "Isolate"}</button></div><details className="region-more"><summary>More⌄</summary><div><button type="button" onClick={onSplit}>Split vertically</button><button type="button" onClick={onMerge}>Merge neighbor</button><label>Rig padding <input type="number" min={0} max={64} value={padding} onChange={(event) => onPadding(event.target.valueAsNumber)} /></label><small>Padding affects extracted rig assets only; source ownership stays exclusive.</small><button type="button" className="danger" onClick={onDelete}>Delete region</button></div></details></section>;
}

function ProviderDiagnostics({ capabilities, health, onRetry }: { readonly capabilities: CharacterPipelineCapabilities; readonly health: ProviderHealthSnapshot; readonly onRetry: () => void }) {
  const entries = [
    ["Segmentation", capabilities.segmentation], ["Mask Refinement", capabilities.maskRefinement], ["Reconstruction", capabilities.reconstruction],
    ["Background Removal", capabilities.backgroundRemoval], ["Alpha Cleanup", capabilities.alphaCleanup],
  ] as const;
  return <section className="provider-diagnostics" aria-label="AI provider diagnostics"><header><strong>ComfyUI · {health.state}</strong><small>{health.endpoint ?? "Configured localhost endpoint"} · last success {health.lastSuccessfulCheckAt ? new Date(health.lastSuccessfulCheckAt).toLocaleTimeString() : "never"}</small>{health.lastError && <small>{health.lastError}</small>}<button type="button" onClick={onRetry}>Retry</button></header>{entries.map(([label, capability]) => <div key={label} data-ready={capability.available}><strong>{label}</strong><span>{capability.available ? "Ready" : "Unavailable"}</span><small>{capability.available ? [capability.provider, capability.workflow, capability.modelFamily].filter(Boolean).join(" · ") : capability.reason}</small></div>)}</section>;
}
