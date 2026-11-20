"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { safeParseAnimationJson, safeParseRigJson } from "@/src/rigging/schema/parsing";
import type { AnimationDefinition, AttachmentDefinition, RigDefinition } from "@/src/rigging/schema/types";
import { blockingRigProjectProblems, validateRigProject } from "@/src/rigging/validation/project";
import type { ValidationIssue } from "@/src/rigging/validation/issues";
import { LOCAL_PROJECT_STORAGE_VERSION } from "@/src/project-storage/types";
import {
  addAttachment,
  addBone,
  addSlot,
  analyzeBoneDeletion,
  assignSkinAttachment,
  createSkin,
  deleteAttachment,
  deleteBone,
  deleteSkin,
  deleteSlot,
  duplicateBone,
  duplicateSkin,
  duplicateSlot,
  moveBonePivot,
  moveSlot,
  renameSkin,
  updateAttachment,
  updateBone,
  updateRigIdentity,
  updateSlot,
} from "@/src/tools/rig-editor/document";
import { parseDraft, RIG_EDITOR_DRAFT_KEY, serializeDraft } from "@/src/tools/rig-editor/draft";
import { RigCommandHistory } from "@/src/tools/rig-editor/history";
import type { BoneAuthoringPatch, EditorItemType, EditorSelection } from "@/src/tools/rig-editor/types";
import { EditorInspector } from "./EditorInspector";
import { EditorViewport, type EditorViewportHandle } from "./EditorViewport";
import { AnimateWorkspace } from "./AnimateWorkspace";
import { RIG_EDITOR_HANDOFF_KEY, type RigEditorHandoff } from "@/src/character-generation/project/rigEditorHandoff";
import { getGeneratedCharacterStorage } from "@/src/character-generation/project/generatedCharacterStorage";
import type { GeneratedCharacterProject } from "@/src/character-generation/project/generatedCharacterProject";
import { getRiggingCommandService } from "@/src/agent-control";
import { useAgentBridge } from "@/src/agent-control/protocol/useAgentBridge";
import { loadAnimationDraft } from "@/src/tools/rig-editor/animation/draft";
import { createAnimationLibrary } from "@/src/tools/rig-editor/animation/library";
import { SAMPLE_ANIMATION_PATHS } from "@/src/tools/rig-editor/animation/samplePaths";
import { useRouter } from "next/navigation";
import { FacingQuestion, RebuildNotice, RepaintNotice, writeRebuildRequest } from "./RigNotices";
import { buildStandardClips, type RigFacing } from "@/src/rigging/motion/rigMotion";
import { ExportForGame } from "./ExportForGame";
import { ImageProductionStatus } from "./ImageProductionStatus";
import { PART_CUTTER_IMPORT_KEY, type PartCutterImportPayload } from "@/src/part-cutter/importBridge";
import { StudioCommandPalette, type StudioCommand } from "@/app/studio-ui/StudioCommandPalette";
import type { StudioMode } from "@/app/studio-ui/StudioModeNav";
import { StudioUtilityDrawer, type StudioProblem } from "@/app/studio-ui/StudioUtilityDrawer";
import { humanizeTechnicalId } from "@/app/studio-ui/humanize";
import { StudioDialog } from "@/app/studio-ui/StudioDialog";
import { presentAgentStatus } from "@/app/studio-ui/agentStatus";
import { TopCommandRail, type StudioConnection } from "@/app/studio-ui/TopCommandRail";
import { forgetActiveDiskProject } from "@/app/studio-ui/ProjectStorageMenu";
import { STAGE_NOTICE_KEY } from "@/app/studio-ui/stageNotice";
import { CanvasControls } from "./CanvasControls";
import { SkeletonTree, partName, type StructureView } from "./SkeletonTree";
import { EditorHierarchy } from "./EditorHierarchy";
import { RigReviewStrip } from "./RigReviewStrip";
import { TestPoseStrip } from "./TestPoseStrip";
import { CanvasContextMenu, type ContextMenuItem } from "./CanvasContextMenu";
import { reviewRig, type RigChainId } from "@/src/tools/rig-editor/rigReview";
import { buildPoseTest, buildRotationSweep, poseTestBoneIds, POSE_TESTS, type PoseTestId } from "@/src/tools/rig-editor/poseTests";
import type { StageStatuses } from "@/app/studio-ui/StudioModeNav";
import { publishIntegrityEvidence } from "@/src/diagnostics/integrityEvidence";
import { useProjectHydrationIdentity } from "@/app/studio-ui/ProjectHydrationBoundary";
import { useProviderHealth } from "@/app/studio-ui/useProviderHealth";

const rigName = (rig: RigDefinition): string => typeof rig.metadata.name === "string" ? rig.metadata.name : rig.id;
const editableTarget = (target: EventTarget | null): boolean => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
type HistoryUi = { readonly canUndo: boolean; readonly canRedo: boolean; readonly undoLabel: string | null; readonly redoLabel: string | null };
type PendingDelete = {
  readonly type: EditorItemType;
  readonly id: string;
  readonly childIds: readonly string[];
  readonly slotIds: readonly string[];
  readonly replacementChoices: readonly string[];
};
type EditorMode = "setup" | "test" | "animate";
/** A throwaway rotation sweep playing in the viewport: a review chain, a quick test, or one bone. */
type Sweep = { readonly kind: "chain"; readonly id: RigChainId } | { readonly kind: "test"; readonly id: PoseTestId } | { readonly kind: "bone"; readonly id: string };
type AnimationHistoryBridge = { readonly canUndo: boolean; readonly canRedo: boolean; readonly undoLabel: string | null; readonly redoLabel: string | null };
const TESTED_KEY = "rigging-studio-tested-v1";
const ANIMATED_KEY = "rigging-studio-animated-v1";
const readStageMark = (key: string, projectId: string): boolean => { try { return Boolean((JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, boolean>)[projectId]); } catch { return false; } };
const writeStageMark = (key: string, projectId: string): void => { try { window.localStorage.setItem(key, JSON.stringify({ ...(JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, boolean>), [projectId]: true })); } catch { /* a stage mark is a convenience; losing it is harmless */ } };
const readTested = (projectId: string): boolean => readStageMark(TESTED_KEY, projectId);
const readHistoryUi = (history: RigCommandHistory): HistoryUi => ({ canUndo: history.canUndo, canRedo: history.canRedo, undoLabel: history.getUndoLabel(), redoLabel: history.getRedoLabel() });

export function RigEditor() {
  const router = useRouter();
  const commandService = useMemo(() => getRiggingCommandService(), []);
  const hydrationIdentity = useProjectHydrationIdentity();
  const { health: providerHealth } = useProviderHealth();
  const characterStorage = useMemo(() => getGeneratedCharacterStorage(), []);
  const agentSession = useAgentBridge(commandService);
  const [rig, setRig] = useState<RigDefinition | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [defaultRig, setDefaultRig] = useState<RigDefinition | null>(null);
  const [animation, setAnimation] = useState<AnimationDefinition | null>(null);
  const [selections, setSelections] = useState<EditorSelection[]>([]);
  const [search, setSearch] = useState("");
  const [hiddenBoneIds, setHiddenBoneIds] = useState<Set<string>>(new Set());
  const [lockedIds, setLockedIds] = useState<Set<string>>(new Set());
  const [showGrid, setShowGrid] = useState(true);
  const [showBones, setShowBones] = useState(true);
  const [showBounds, setShowBounds] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [wholePixelSnap, setWholePixelSnap] = useState(true);
  const [rotationSnap, setRotationSnap] = useState(true);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [posed, setPosed] = useState(false);
  const [tested, setTested] = useState(false);
  const [hasMotion, setHasMotion] = useState(false);
  const [reviewChainId, setReviewChainId] = useState<RigChainId | null>(null);
  const [contextMenu, setContextMenu] = useState<{ readonly selection: EditorSelection; readonly x: number; readonly y: number; readonly items: readonly ContextMenuItem[] } | null>(null);
  const [animationHistory, setAnimationHistory] = useState<AnimationHistoryBridge>({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
  const [editorMode, setEditorMode] = useState<EditorMode>("setup");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [utilityTab, setUtilityTab] = useState<"problems" | "activity">("problems");
  const [focusMode, setFocusMode] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [structureView, setStructureView] = useState<StructureView>("skeleton");
  const [advancedStructure, setAdvancedStructure] = useState(false);
  const [canvasTool, setCanvasTool] = useState<"select" | "pan">("select");
  const [renamingRig, setRenamingRig] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(264);
  const [rightPanelWidth, setRightPanelWidth] = useState(320);
  const [demoInvalid, setDemoInvalid] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [activeSkinId, setActiveSkinId] = useState("");
  const [zoom, setZoom] = useState(1);
  const [, setCursor] = useState({ x: 0, y: 0 });
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("Loading rig document");
  const [centerOnLoad, setCenterOnLoad] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteReplacementId, setDeleteReplacementId] = useState("");
  const [historyUi, setHistoryUi] = useState<HistoryUi>({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
  const [, setProjectSessionToken] = useState(() => commandService.getProjectLifecycleSnapshot().projectSessionToken);
  const [generatedProjectState, setGeneratedProjectState] = useState<GeneratedCharacterProject | null>(null);
  const historyRef = useRef<RigCommandHistory | null>(null);
  const viewportRef = useRef<EditorViewportHandle>(null);
  const loadInputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const prepareInputRef = useRef<HTMLInputElement>(null);
  const uploadedUrlsRef = useRef<Set<string>>(new Set());
  const rigStateRef = useRef<RigDefinition | null>(null);
  const generatedProjectRef = useRef<GeneratedCharacterProject | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => { const params = new URLSearchParams(window.location.search); const mode = params.get("mode"); if (mode === "animate" || mode === "test") setEditorMode(mode); setDemoInvalid(params.get("demo") === "invalid"); try { const stored = JSON.parse(window.localStorage.getItem("rigging-studio-workspace-v1") ?? "{}") as { leftCollapsed?: boolean; rightCollapsed?: boolean; showGrid?: boolean; showBones?: boolean; showBounds?: boolean; focusMode?: boolean; structureView?: StructureView; leftPanelWidth?: number; rightPanelWidth?: number }; setLeftCollapsed(Boolean(stored.leftCollapsed)); setRightCollapsed(Boolean(stored.rightCollapsed)); setFocusMode(Boolean(stored.focusMode)); if (stored.structureView === "skeleton" || stored.structureView === "parts") setStructureView(stored.structureView); if (Number.isFinite(stored.leftPanelWidth)) setLeftPanelWidth(Math.max(208, Math.min(360, stored.leftPanelWidth!))); if (Number.isFinite(stored.rightPanelWidth)) setRightPanelWidth(Math.max(268, Math.min(420, stored.rightPanelWidth!))); if (stored.showGrid !== undefined) setShowGrid(stored.showGrid); if (stored.showBones !== undefined) setShowBones(stored.showBones); if (stored.showBounds !== undefined) setShowBounds(stored.showBounds); } catch { /* invalid workspace preferences fall back to the disciplined default layout */ } setPreferencesReady(true); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onDurableOpen = (event: Event): void => {
      const detail = (event as CustomEvent<{ readonly mode?: string; readonly projectSessionToken?: string }>).detail;
      const mode = detail?.mode;
      try {
        const snapshot = commandService.getDurableSnapshot();
        generatedProjectRef.current = snapshot.project;
        setGeneratedProjectState(snapshot.project);
        setDefaultRig(snapshot.rig);
        setAnimation(null);
        setActiveSkinId(snapshot.selectedSkinId ?? snapshot.rig?.defaultSkinId ?? "");
      } catch { generatedProjectRef.current = null; setGeneratedProjectState(null); }
      setSelections([]); setHiddenBoneIds(new Set()); setLockedIds(new Set()); setSearch(""); setPendingDelete(null); setDeleteReplacementId("");
      setRenamingRig(false); setCommandPaletteOpen(false); setUtilityOpen(false); setSweep(null); setPosed(false); setReviewChainId(null); setContextMenu(null); setCanvasTool("select");
      setProjectSessionToken(detail?.projectSessionToken ?? commandService.getProjectLifecycleSnapshot().projectSessionToken);
      if (mode === "setup" || mode === "test" || mode === "animate") setEditorMode(mode);
    };
    window.addEventListener("rig-studio:durable-project-opened", onDurableOpen);
    return () => window.removeEventListener("rig-studio:durable-project-opened", onDurableOpen);
  }, [commandService]);

  useEffect(() => { if (preferencesReady) window.localStorage.setItem("rigging-studio-workspace-v1", JSON.stringify({ leftCollapsed, rightCollapsed, showGrid, showBones, showBounds, focusMode, structureView, leftPanelWidth, rightPanelWidth })); }, [focusMode, leftCollapsed, leftPanelWidth, preferencesReady, rightCollapsed, rightPanelWidth, structureView, showBones, showBounds, showGrid]);

  useEffect(() => { if (!focusMode || !rig) return; const timer = window.setTimeout(() => viewportRef.current?.resetView(), 210); return () => window.clearTimeout(timer); }, [focusMode, rig]);

  useEffect(() => {
    if (!preferencesReady) return;
    const urlMode = new URLSearchParams(window.location.search).get("mode");
    const currentMode = urlMode === "animate" || urlMode === "test" ? urlMode : "setup";
    if (currentMode !== editorMode) router.replace(`/?mode=${editorMode}`, { scroll: false });
  }, [editorMode, preferencesReady, router]);

  useEffect(() => {
    if (agentSession.activeStage === "describe" && agentSession.activeProjectId?.startsWith("character-")) router.push("/create-character");
  }, [agentSession.activeProjectId, agentSession.activeStage, router]);

  useEffect(() => {
    let cancelled = false;
    const uploadedUrls = uploadedUrlsRef.current;
    const operation = commandService.captureProjectOperation("rig-editor-hydration");
    void (async () => {
      try {
        const [rigResponse, animationResponse, ...sampleResponses] = await Promise.all([fetch("/rig-test/minimal-rig.json"), fetch("/rig-test/idle-animation.json"), ...SAMPLE_ANIMATION_PATHS.map((path) => fetch(path))]);
        const [rigSource, animationSource, ...sampleSources] = await Promise.all([rigResponse.text(), animationResponse.text(), ...sampleResponses.map((response) => response.text())]);
        const parsedRig = safeParseRigJson(rigSource);
        if (!parsedRig.success) throw new Error(parsedRig.message);
        let initialRig = parsedRig.data;
        let restored = false;
        let restoredFromDurable = false;
        let durableAnimations = null as ReturnType<typeof createAnimationLibrary> | null;
        const localDraft = window.localStorage.getItem(RIG_EDITOR_DRAFT_KEY);
        const rawHandoff = window.localStorage.getItem(RIG_EDITOR_HANDOFF_KEY);
        let handoff: RigEditorHandoff | null = null;
        if (rawHandoff) {
          try { handoff = JSON.parse(rawHandoff) as RigEditorHandoff; } catch { handoff = null; }
          window.localStorage.removeItem(RIG_EDITOR_HANDOFF_KEY);
        }
        let generatedProject: GeneratedCharacterProject | null = null;
        try {
          const durable = commandService.getDurableSnapshot();
          const durableIdentity = durable.localProjectId ?? durable.project?.id ?? null;
          if (durable.rig && hydrationIdentity.activeProjectId && (durableIdentity === hydrationIdentity.activeProjectId || durable.project?.id === hydrationIdentity.activeProjectId)) {
            initialRig = durable.rig; generatedProject = durable.project; durableAnimations = durable.animations; restored = true; restoredFromDurable = true;
          }
        } catch { /* no committed disk project; browser draft lookup remains available */ }
        const storedProject = restoredFromDurable ? null : await characterStorage.load();
        if (!generatedProject && storedProject?.success && storedProject.data.rigDefinition && (!handoff || storedProject.data.id === handoff.projectId)) generatedProject = storedProject.data;
        if (generatedProject) {
          initialRig = generatedProject.rigDefinition!;
          generatedProjectRef.current = generatedProject;
          setGeneratedProjectState(generatedProject);
          if (!restoredFromDurable) commandService.activateProjectFromUi(generatedProject);
          restored = true;
        }
        // The character being worked on has no rig yet: never show a different one (an old draft or the sample knight).
        // Send the user to Parts with a note instead.
        if (!generatedProject && !restoredFromDurable && !handoff && storedProject?.success && storedProject.data.sourceImage && !storedProject.data.rigDefinition) {
          if (cancelled) return;
          try { window.sessionStorage.setItem(STAGE_NOTICE_KEY, `${storedProject.data.name || "This character"} has no rig yet: cut its parts, then press Build rig.`); } catch { /* the redirect still happens */ }
          router.replace("/part-cutter");
          return;
        }
        if (localDraft && !generatedProject && !restoredFromDurable) {
          const draft = parseDraft(localDraft);
          if (draft.success) { initialRig = draft.data.rig; restored = true; }
        }
        // Nothing to edit yet: start where a character starts instead of showing the bundled sample knight.
        if (!restored && !handoff) {
          if (cancelled) return;
          try { window.sessionStorage.setItem(STAGE_NOTICE_KEY, "There is no character to rig yet. Describe one and generate its art, or import an image."); } catch { /* the redirect still happens */ }
          router.replace("/create-character");
          return;
        }
        const parsedAnimation = safeParseAnimationJson(animationSource, initialRig);
        const validAnimations = sampleSources.flatMap((source) => {
          const parsed = safeParseAnimationJson(source, initialRig);
          return parsed.success ? [parsed.data] : [];
        });
        let initialAnimations = durableAnimations ?? createAnimationLibrary(initialRig.id, validAnimations);
        const animationDraft = restoredFromDurable ? null : loadAnimationDraft(window.localStorage, initialRig);
        if (animationDraft?.success) initialAnimations = animationDraft.data;
        if (cancelled || !commandService.isCurrentHydration(operation.projectId, operation.projectSessionToken, operation.hydrationToken)) return;
        if (!restoredFromDurable) commandService.syncAnimationsFromUi(initialAnimations, initialAnimations.animations[0]?.id ?? null);
        historyRef.current = new RigCommandHistory(initialRig);
        setDefaultRig(parsedRig.data);
        setRig(historyRef.current.present);
        rigStateRef.current = historyRef.current.present;
        setActiveSkinId(initialRig.defaultSkinId);
        setAnimation(parsedAnimation.success ? parsedAnimation.data : null);
        setHasMotion(durableAnimations !== null || readStageMark(ANIMATED_KEY, hydrationIdentity.activeProjectId ?? "browser-draft"));
        setTested(readTested(hydrationIdentity.activeProjectId ?? "browser-draft"));
        // A rig that has just been built from Parts opens straight into review, one chain at a time.
        if (handoff) setReviewChainId(reviewRig(initialRig)[0]?.id ?? null);
        if (handoff?.showBones) setShowBones(true);
        if (handoff?.centerView) setCenterOnLoad(true);
        setHistoryUi(readHistoryUi(historyRef.current));
        setMessage(handoff?.validationMessage ?? (restored
          ? restoredFromDurable ? "Disk project hydrated" : initialRig.attachments.some((attachment) => attachment.imagePath.startsWith("blob:"))
            ? "Draft restored. Local uploads must be added again"
            : "Local draft restored"
          : "Rig document ready"));
      } catch (reason: unknown) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "The editor could not load the rig");
      }
    })();
    return () => {
      cancelled = true;
      uploadedUrls.forEach((url) => URL.revokeObjectURL(url));
      uploadedUrls.clear();
    };
  }, [characterStorage, commandService, hydrationIdentity.activeProjectId]);

  useEffect(() => {
    const digest = {
      activeProjectId: hydrationIdentity.activeProjectId, stage: editorMode,
      selectedRegion: null, selectedPart: null,
      selectedBone: selections.find((selection) => selection.type === "bone")?.id ?? agentSession.selectedBoneId,
      selectedAnimation: agentSession.selectedAnimationId, selectedKeyframe: null,
      renderedSourceProjectId: generatedProjectState?.id ?? hydrationIdentity.activeProjectId,
      renderedRigProjectId: rig ? hydrationIdentity.activeProjectId : null,
    };
    (window as Window & { __RIG_STUDIO_UI_IDENTITY__?: typeof digest }).__RIG_STUDIO_UI_IDENTITY__ = digest;
    // The rig as built, for the hand-drawn bench (scripts/handdrawn-bench): it saves this and re-renders it in Node.
    if (process.env.NODE_ENV !== "production") (window as Window & { __RIG_STUDIO_RIG_SNAPSHOT__?: () => RigDefinition | null }).__RIG_STUDIO_RIG_SNAPSHOT__ = () => rig;
  }, [agentSession.selectedAnimationId, agentSession.selectedBoneId, editorMode, generatedProjectState?.id, hydrationIdentity.activeProjectId, rig, selections]);

  useEffect(() => {
    if (!rig || !centerOnLoad) return;
    const frame = window.requestAnimationFrame(() => { viewportRef.current?.resetView(); setCenterOnLoad(false); });
    return () => window.cancelAnimationFrame(frame);
  }, [centerOnLoad, rig]);

  useEffect(() => {
    if (!rig) return;
    const timer = window.setTimeout(() => {
      const generated = generatedProjectRef.current;
      if (generated) {
        const next = { ...generated, stage: "edit" as const, rigDefinition: rig, skins: rig.skins, updatedAt: new Date().toISOString() };
        generatedProjectRef.current = next;
        setGeneratedProjectState(next);
        void characterStorage.save(next).then((result) => {
          if (result.success) setMessage("Changes kept in this browser");
          else setError(`Rig remains in memory. ${result.layer} failed: ${result.message}`);
        });
      } else {
        try { window.localStorage.setItem(RIG_EDITOR_DRAFT_KEY, serializeDraft(rig)); setMessage("Changes kept in this browser"); }
        catch (reason: unknown) { setError(`Rig remains in memory. Local draft failed: ${reason instanceof Error ? reason.message : "storage unavailable"}`); }
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [characterStorage, rig]);

  const previewAnimation = useMemo(() => {
    if (!rig || !sweep) return null;
    if (sweep.kind === "test") return buildPoseTest(rig, sweep.id);
    if (sweep.kind === "bone") return buildRotationSweep(rig, [sweep.id], { id: "pose-test-bone" });
    return buildRotationSweep(rig, rig.bones.filter((bone) => reviewRig(rig).find((chain) => chain.id === sweep.id)?.joints.some((joint) => joint.boneId === bone.id)).map((bone) => bone.id), { id: `rig-review-${sweep.id}` });
  }, [rig, sweep]);
  // While a sweep plays the viewport is showing a pose, not the rig, so rig edits are held off.
  const previewMode = previewAnimation !== null;

  const primarySelection = selections.at(-1) ?? null;
  const selectedLocked = primarySelection ? lockedIds.has(`${primarySelection.type}:${primarySelection.id}`) : false;
  const validationIssues = useMemo(() => {
    if (!rig) return [];
    const inspectedRig = demoInvalid && rig.slots[0] ? { ...rig, slots: rig.slots.map((slot, index) => index === 0 ? { ...slot, boneId: "missing-demo-bone" } : slot) } : rig;
    return validateRigProject({ storageVersion: LOCAL_PROJECT_STORAGE_VERSION, project: generatedProjectState, rig: inspectedRig, animations: animation ? createAnimationLibrary(inspectedRig.id, [animation]) : null, selectedSkinId: activeSkinId }, {
      boneIds: selections.filter((selection) => selection.type === "bone").map((selection) => selection.id),
      slotIds: selections.filter((selection) => selection.type === "slot").map((selection) => selection.id),
      attachmentIds: selections.filter((selection) => selection.type === "attachment").map((selection) => selection.id),
      skinIds: selections.filter((selection) => selection.type === "skin").map((selection) => selection.id),
    });
  }, [activeSkinId, animation, demoInvalid, generatedProjectState, rig, selections]);
  const blockingValidationIssues = useMemo(() => blockingRigProjectProblems(validationIssues), [validationIssues]);
  useEffect(() => {
    if (editorMode !== "animate" || !blockingValidationIssues.length) return;
    const timer = window.setTimeout(() => {
      setEditorMode("setup"); setUtilityTab("problems"); setUtilityOpen(true);
      setError("Animate was not opened because the durable project failed integrity validation");
      router.replace("/?mode=setup", { scroll: false });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [blockingValidationIssues.length, editorMode, router]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!rig) { setSelections([]); return; }
      const ids = {
        bone: new Set(rig.bones.map((bone) => bone.id)),
        slot: new Set(rig.slots.map((slot) => slot.id)),
        attachment: new Set(rig.attachments.map((attachment) => attachment.id)),
        skin: new Set(rig.skins.map((skin) => skin.id)),
      };
      setSelections((current) => current.filter((selection) => ids[selection.type].has(selection.id)));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [rig]);
  useEffect(() => {
    if (!rig) return;
    publishIntegrityEvidence({
      stage: editorMode,
      state: {
        rigId: rig.id, bones: rig.bones.map((bone) => bone.id), slots: rig.slots.map((slot) => `${slot.id}:${slot.boneId}:${slot.attachmentId ?? ""}`),
        attachments: rig.attachments.map((attachment) => attachment.id), skins: rig.skins.map((skin) => skin.id), selected: selections.map((selection) => `${selection.type}:${selection.id}`),
        animation: animation ? { id: animation.id, tracks: animation.tracks.map((track) => `${track.boneId}:${track.property}:${track.keyframes.length}`) } : null,
      },
      problems: validationIssues,
    });
  }, [animation, editorMode, rig, selections, validationIssues]);

  const syncHistory = useCallback((next: RigDefinition, changed = true): void => {
    rigStateRef.current = next;
    setRig(next);
    const commandHistory = historyRef.current;
    if (commandHistory) setHistoryUi(readHistoryUi(commandHistory));
    if (changed) setDirty(true);
    setError(null);
  }, []);

  const run = useCallback((label: string, transform: (current: RigDefinition) => RigDefinition): RigDefinition | null => {
    const commandHistory = historyRef.current;
    if (!commandHistory || previewMode) return null;
    try {
      return commandService.executeHumanRigMutation(label, transform);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : `${label} failed`);
      return null;
    }
  }, [commandService, previewMode]);
  // Which way the character faces decides the direction of every standard clip; stored with the rig.
  const setFacing = (facing: RigFacing | null): void => { run(facing ? `Face ${facing}` : "Detect facing automatically", (current) => { const metadata = { ...current.metadata }; if (facing) metadata.facing = facing; else delete metadata.facing; return { ...current, metadata }; }); };
  // Rebuilding happens in Parts, where the cut and the source image live.
  const rebuildFromParts = (): void => { writeRebuildRequest({ projectId: hydrationIdentity.activeProjectId ?? "", repaint: false }); router.push("/part-cutter"); };
  const repaintFromParts = (): void => { writeRebuildRequest({ projectId: hydrationIdentity.activeProjectId ?? "", repaint: true }); router.push("/part-cutter"); };

  const select = useCallback((selection: EditorSelection | null, additive: boolean): void => {
    if (!selection) { setSelections([]); return; }
    setSelections((current) => {
      if (!additive) return [selection];
      const exists = current.some((item) => item.type === selection.type && item.id === selection.id);
      return exists ? current.filter((item) => item.type !== selection.type || item.id !== selection.id) : [...current, selection];
    });
    if (selection.type === "skin") setActiveSkinId(selection.id);
    setRightCollapsed(false);
  }, []);

  useEffect(() => {
    if (!rig || !historyRef.current) return;
    return commandService.attachRigEditor({
      getRig: () => historyRef.current?.present ?? rigStateRef.current ?? rig,
      replace: (next) => {
        const history = new RigCommandHistory(next); historyRef.current = history; rigStateRef.current = next; setRig(next); setActiveSkinId(next.defaultSkinId); setHistoryUi(readHistoryUi(history)); setDirty(false); setError(null); setMessage("Opened disk project"); return next;
      },
      execute: (label, transform) => {
        const history = historyRef.current; if (!history) throw new Error("Rig history is unavailable");
        const next = history.execute(label, transform); syncHistory(next); setMessage(label); return next;
      },
      beginTransaction: (label) => { const history = historyRef.current; if (!history) throw new Error("Rig history is unavailable"); history.beginTransaction(label); },
      updateTransaction: (transform) => {
        const history = historyRef.current; if (!history) throw new Error("Rig history is unavailable");
        const next = history.updateTransaction(transform(history.present)); syncHistory(next); return next;
      },
      commitTransaction: () => { const history = historyRef.current; if (!history) throw new Error("Rig history is unavailable"); const next = history.commitTransaction(); syncHistory(next); return next; },
      rollbackTransaction: () => { const history = historyRef.current; if (!history) throw new Error("Rig history is unavailable"); const next = history.cancelTransaction(); syncHistory(next, false); return next; },
      undo: () => { const history = historyRef.current; if (!history) throw new Error("Rig history is unavailable"); const next = history.undo(); syncHistory(next); return next; },
      redo: () => { const history = historyRef.current; if (!history) throw new Error("Rig history is unavailable"); const next = history.redo(); syncHistory(next); return next; },
      setSelectedBone: (boneId) => select(boneId ? { type: "bone", id: boneId } : null, false),
    });
  }, [commandService, rig, select, syncHistory]);

  useEffect(() => {
    commandService.syncBoneSelectionFromUi(primarySelection?.type === "bone" ? primarySelection.id : null);
  }, [commandService, primarySelection]);

  const undo = useCallback((): void => {
    const commandHistory = historyRef.current;
    if (!commandHistory || previewMode || !commandHistory.canUndo) return;
    const label = commandHistory.getUndoLabel();
    commandService.undoRig();
    setMessage(`Undid ${label ?? "change"}`);
  }, [commandService, previewMode]);

  const redo = useCallback((): void => {
    const commandHistory = historyRef.current;
    if (!commandHistory || previewMode || !commandHistory.canRedo) return;
    const label = commandHistory.getRedoLabel();
    commandService.redoRig();
    setMessage(`Redid ${label ?? "change"}`);
  }, [commandService, previewMode]);

  /** The clips to export: the saved library (with the user's edits), or the standard set built for this rig. */
  const exportAnimations = (): readonly AnimationDefinition[] => {
    try { const animations = commandService.getDurableSnapshot().animations?.animations; if (animations?.length) return animations; } catch { /* nothing saved yet */ }
    return rig ? buildStandardClips(rig) : [];
  };
  const downloadJson = useCallback((): void => {
    if (!rig) return;
    const blob = new Blob([`${JSON.stringify(rig, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${rig.id}.rig.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setDirty(false);
    setMessage("Rig JSON downloaded");
  }, [rig]);

  const loadJson = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const parsed = safeParseRigJson(await file.text());
    if (!parsed.success) { setError(parsed.message); setMessage("Import rejected"); return; }
    const commandHistory = historyRef.current;
    if (!commandHistory) return;
    const next = commandHistory.reset(parsed.data);
    setRig(next);
    setSelections([]);
    setActiveSkinId(next.defaultSkinId);
    setSweep(null);
    setDirty(false);
    setHistoryUi(readHistoryUi(commandHistory));
    setError(null);
    setMessage(`Loaded ${file.name}`);
  };

  const importSpriteForCutting = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    if (!/image\/(png|jpeg|webp)/.test(file.type)) { setError("Choose a PNG, JPG, or WebP sprite"); return; }
    forgetActiveDiskProject();
    const image = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Could not read sprite")); reader.readAsDataURL(file); });
    const decoded = new Image(); decoded.src = image; await decoded.decode();
    const payload: PartCutterImportPayload = { name: file.name, image, width: decoded.naturalWidth, height: decoded.naturalHeight };
    window.sessionStorage.setItem(PART_CUTTER_IMPORT_KEY, JSON.stringify(payload)); router.push("/part-cutter");
  };

  const discardDraft = (): void => {
    if (!defaultRig) return;
    setConfirmDiscard(true);
  };

  const confirmDiscardDraft = (): void => {
    if (!defaultRig) return;
    window.localStorage.removeItem(RIG_EDITOR_DRAFT_KEY);
    const commandHistory = historyRef.current;
    if (!commandHistory) return;
    const next = commandHistory.reset(defaultRig);
    setRig(next);
    setSelections([]);
    setActiveSkinId(next.defaultSkinId);
    setSweep(null);
    setDirty(false);
    setHistoryUi(readHistoryUi(commandHistory));
    setMessage("Local draft discarded");
    setConfirmDiscard(false);
  };

  const addItem = (type: EditorItemType): void => {
    if (!rig || previewMode) return;
    if (type === "attachment") { uploadInputRef.current?.click(); return; }
    if (type === "bone") {
      const parent = primarySelection?.type === "bone" ? primarySelection.id : rig.rootBoneId;
      let createdId = "";
      const next = run("Add bone", (current) => { const result = addBone(current, parent); createdId = result.id; return result.rig; });
      if (next) select({ type: "bone", id: createdId }, false);
    } else if (type === "slot") {
      const boneId = primarySelection?.type === "bone" ? primarySelection.id : rig.rootBoneId;
      let createdId = "";
      const next = run("Add slot", (current) => { const result = addSlot(current, boneId); createdId = result.id; return result.rig; });
      if (next) select({ type: "slot", id: createdId }, false);
    } else {
      let createdId = "";
      const next = run("Create skin", (current) => { const result = createSkin(current); createdId = result.id; return result.rig; });
      if (next) select({ type: "skin", id: createdId }, false);
    }
  };

  const duplicateItem = (type: EditorItemType): void => {
    const selected = [...selections].reverse().find((item) => item.type === type);
    if (!selected || previewMode) return;
    let createdId = "";
    const next = run(`Duplicate ${type}`, (current) => {
      const result = type === "bone" ? duplicateBone(current, selected.id) : type === "slot" ? duplicateSlot(current, selected.id) : duplicateSkin(current, selected.id);
      createdId = result.id;
      return result.rig;
    });
    if (next) select({ type, id: createdId }, false);
  };

  const deleteItem = useCallback((type: EditorItemType): void => {
    if (!rig || previewMode) return;
    const selected = [...selections].reverse().find((item) => item.type === type);
    if (!selected) return;
    if (type === "bone") {
      const dependencies = analyzeBoneDeletion(rig, selected.id);
      if (selected.id === rig.rootBoneId) { setError("The root bone cannot be deleted"); return; }
      const descendants = new Set<string>();
      let changed = true;
      while (changed) {
        changed = false;
        rig.bones.forEach((bone) => {
          if (bone.parentId === selected.id || (bone.parentId && descendants.has(bone.parentId))) {
            if (!descendants.has(bone.id)) { descendants.add(bone.id); changed = true; }
          }
        });
      }
      const choices = rig.bones.map((bone) => bone.id).filter((id) => id !== selected.id && !descendants.has(id));
      const current = rig.bones.find((bone) => bone.id === selected.id);
      setDeleteReplacementId(current?.parentId && choices.includes(current.parentId) ? current.parentId : choices[0] ?? "");
      setPendingDelete({ type, id: selected.id, childIds: dependencies.childIds, slotIds: dependencies.slotIds, replacementChoices: choices });
      return;
    }
    setDeleteReplacementId("");
    setPendingDelete({ type, id: selected.id, childIds: [], slotIds: [], replacementChoices: [] });
  }, [previewMode, rig, selections]);

  const confirmDeleteItem = (): void => {
    if (!pendingDelete) return;
    const { type, id, childIds, slotIds } = pendingDelete;
    const hasDependents = type === "bone" && (childIds.length > 0 || slotIds.length > 0);
    if (hasDependents && !pendingDelete.replacementChoices.includes(deleteReplacementId)) {
      setError("Choose a valid replacement bone before deleting");
      return;
    }
    const next = run(hasDependents ? "Delete bone with repair" : `Delete ${type}`, (document) => type === "bone"
      ? deleteBone(document, id, hasDependents ? { reparentChildrenTo: deleteReplacementId, moveSlotsTo: deleteReplacementId } : undefined)
      : type === "slot" ? deleteSlot(document, id)
        : type === "attachment" ? deleteAttachment(document, id)
          : deleteSkin(document, id));
    if (next) setSelections([]);
    setPendingDelete(null);
  };

  const uploadAttachment = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !rig || previewMode) return;
    if (!file.type.startsWith("image/")) { setError("Attachment upload must be an image file"); return; }
    const url = URL.createObjectURL(file);
    uploadedUrlsRef.current.add(url);
    try {
      const bitmap = await createImageBitmap(file);
      const existing = new Set(rig.attachments.map((attachment) => attachment.id));
      const base = file.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "attachment";
      let id = base;
      let suffix = 2;
      while (existing.has(id)) { id = `${base}-${suffix}`; suffix += 1; }
      const attachment: AttachmentDefinition = { id, imagePath: url, width: bitmap.width, height: bitmap.height, offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1, category: "uploaded", tags: ["local"] };
      bitmap.close();
      const next = run("Upload attachment", (current) => addAttachment(current, attachment));
      if (next) select({ type: "attachment", id }, false);
    } catch (reason: unknown) {
      URL.revokeObjectURL(url);
      uploadedUrlsRef.current.delete(url);
      setError(reason instanceof Error ? reason.message : "The image could not be decoded");
    }
  };

  const beginBoneDrag = (boneId: string): void => {
    const commandHistory = historyRef.current;
    if (!commandHistory || commandHistory.activeTransaction) return;
    commandHistory.beginTransaction(`Transform bone ${boneId}`);
  };
  const commitBoneDrag = (boneId: string, patch: BoneAuthoringPatch): void => {
    const commandHistory = historyRef.current;
    if (!commandHistory?.activeTransaction) return;
    try {
      commandHistory.updateTransaction(updateBone(commandHistory.present, boneId, patch));
      syncHistory(commandHistory.commitTransaction());
      setMessage(`Transformed ${boneId}`);
    } catch (reason: unknown) {
      syncHistory(commandHistory.cancelTransaction(), false);
      setError(reason instanceof Error ? reason.message : "Bone transform failed");
    }
  };

  useEffect(() => {
    const keyDown = (event: KeyboardEvent): void => {
      if (editorMode === "animate") return;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "z") { event.preventDefault(); if (editorMode === "test") return; if (event.shiftKey) redo(); else undo(); return; }
      if (modifier && event.key.toLowerCase() === "s") { event.preventDefault(); downloadJson(); return; }
      if (modifier && event.key.toLowerCase() === "o") { event.preventDefault(); if (!previewMode) loadInputRef.current?.click(); return; }
      if (editableTarget(event.target)) return;
      if (event.key === "Escape") { if (sweep) setSweep(null); else setSelections([]); return; }
      if (editorMode === "test") { if (event.key === "0") { event.preventDefault(); setSweep(null); viewportRef.current?.resetPose(); setPosed(false); setMessage("Pose reset"); } return; }
      if ((event.key === "Delete" || event.key === "Backspace") && primarySelection) { event.preventDefault(); deleteItem(primarySelection.type); return; }
      if (!previewMode && primarySelection?.type === "bone" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        const amount = event.shiftKey ? 10 : 1;
        const bone = rig?.bones.find((candidate) => candidate.id === primarySelection.id);
        if (!bone) return;
        const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
        const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
        run("Nudge bone", (current) => updateBone(current, bone.id, { x: bone.x + dx, y: bone.y + dy }));
      }
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [deleteItem, downloadJson, editorMode, previewMode, primarySelection, redo, rig, run, sweep, undo]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent): void => {
      if (editableTarget(event.target) || commandPaletteOpen) return;
      if (event.key === "1") { event.preventDefault(); router.push("/part-cutter"); return; }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "2" || event.key === "3") { event.preventDefault(); const next = event.key === "2" ? "setup" : "test"; router.replace(`/?mode=${next}`, { scroll: false }); setEditorMode(next); setSweep(null); setFocusMode(false); return; }
      if (event.key === "4") { event.preventDefault(); if (blockingValidationIssues.length) { setEditorMode("setup"); setUtilityTab("problems"); setUtilityOpen(true); setError("Fix the rig problems before animating"); } else { router.replace("/?mode=animate", { scroll: false }); setEditorMode("animate"); setSweep(null); setFocusMode(false); } return; }
      if (event.key.toLowerCase() === "v") { setCanvasTool("select"); return; }
      if (event.key.toLowerCase() === "f") { event.preventDefault(); viewportRef.current?.resetView(); return; }
      if (event.key === "Escape" && focusMode) { event.preventDefault(); setFocusMode(false); }
    };
    window.addEventListener("keydown", keyDown); return () => window.removeEventListener("keydown", keyDown);
  }, [blockingValidationIssues.length, commandPaletteOpen, focusMode, router]);

  if (!rig) return <main className="rig-editor-shell is-loading"><div className="editor-loading">{error ?? "Loading rig editor"}</div></main>;

  const commitRigName = (value: string): void => { if (value.trim() && value !== rigName(rig)) run("Rename rig", (current) => updateRigIdentity(current, current.id, value)); };
  const toggleSetValue = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, value: string): void => setter((current) => { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; });
  const effectiveSkinId = rig.skins.some((skin) => skin.id === activeSkinId) ? activeSkinId : rig.defaultSkinId;
  const agentActivity = agentSession.activity.filter((event) => event.actor !== "Human");
  const selectedBoneId = selections.find((selection) => selection.type === "bone")?.id ?? null;
  const selectionLabel = primarySelection ? primarySelection.type === "slot" ? partName(primarySelection.id) : humanizeTechnicalId(primarySelection.id) : "Nothing selected";
  const agentStatus = presentAgentStatus(agentSession);
  const projectKey = hydrationIdentity.activeProjectId ?? "browser-draft";
  const review = reviewRig(rig, validationIssues, effectiveSkinId);
  const reviewFlags = review.reduce((count, chain) => count + chain.joints.filter((joint) => joint.problem).length, 0);
  const jointReview = selectedBoneId ? review.flatMap((chain) => chain.joints).find((joint) => joint.boneId === selectedBoneId) ?? null : null;
  const stageStatuses: StageStatuses = {
    prepare: rig.slots.some((slot) => slot.attachmentId) ? "done" : "todo",
    setup: blockingValidationIssues.length || reviewFlags ? "attention" : rig.bones.length > 1 ? "done" : "todo",
    test: tested ? "done" : "todo",
    animate: hasMotion ? "done" : "todo",
  };
  const markTested = (): void => {
    if (tested) return;
    setTested(true);
    writeStageMark(TESTED_KEY, projectKey);
  };
  const enterMode = (mode: EditorMode): void => { router.replace(`/?mode=${mode}`, { scroll: false }); setEditorMode(mode); setSweep(null); setPosed(false); setContextMenu(null); setFocusMode(false); };
  const showProblems = (): void => { setUtilityTab("problems"); setUtilityOpen(true); };
  const modeSelect = (mode: StudioMode): void => {
    if (mode === "prepare") router.push("/part-cutter");
    else if (mode === "animate" && blockingValidationIssues.length) { enterMode("setup"); showProblems(); setError("Fix the rig problems before animating"); }
    else enterMode(mode);
  };
  const selectIssueSource = (issue: ValidationIssue): (() => void) | undefined => {
    if (issue.mode === "prepare") return () => router.push("/part-cutter");
    const collection = issue.path[0]; const index = typeof issue.path[1] === "number" ? issue.path[1] : -1;
    const reveal = (selection: EditorSelection) => () => { enterMode("setup"); select(selection, false); setUtilityOpen(false); };
    if (collection === "bones" && rig.bones[index]) return reveal({ type: "bone", id: rig.bones[index].id });
    if (collection === "slots" && rig.slots[index]) return reveal({ type: "slot", id: rig.slots[index].id });
    if (collection === "attachments" && rig.attachments[index]) return reveal({ type: "attachment", id: rig.attachments[index].id });
    if (collection === "skins" && rig.skins[index]) return reveal({ type: "skin", id: rig.skins[index].id });
    return undefined;
  };
  const problems: StudioProblem[] = validationIssues.map((issue, index) => ({ id: `${issue.code}-${index}`, severity: issue.severity ?? "error", title: humanizeTechnicalId(issue.code), detail: issue.suggestedAction ? `${issue.message} ${issue.suggestedAction}` : issue.message, context: issue.objectId ? humanizeTechnicalId(issue.objectId) : issue.path.join(" › ") || "Rig", onSelect: selectIssueSource(issue) }));
  const toggleFocusMode = (): void => { const entering = !focusMode; setFocusMode(entering); if (entering) { window.requestAnimationFrame(() => viewportRef.current?.resetView()); window.setTimeout(() => viewportRef.current?.resetView(), 190); } };
  const resetWorkspace = (): void => { setLeftCollapsed(false); setRightCollapsed(false); setShowGrid(true); setShowBones(true); setShowBounds(false); setFocusMode(false); viewportRef.current?.resetView(); setMessage("Workspace layout reset"); };
  const animationCommand = (action: "play" | "pause" | "restart" | "ai" | "review" | "save" | "undo" | "redo"): void => { window.dispatchEvent(new CustomEvent("rig-studio:animation-command", { detail: action })); };

  // Selection is one thing everywhere. In Test only bones can be posed, so clicking art selects the bone that moves it.
  const selectInStage = (selection: EditorSelection | null, additive: boolean): void => {
    if (editorMode === "test" && selection?.type === "slot") { const boneId = rig.slots.find((slot) => slot.id === selection.id)?.boneId; select(boneId ? { type: "bone", id: boneId } : null, false); return; }
    select(selection, additive);
  };
  const resetPose = (): void => { setSweep(null); viewportRef.current?.resetPose(); setPosed(false); setMessage("Pose reset"); };
  const runSweep = (next: Sweep | null): void => { setPosed(false); setSweep(next); if (next) { setShowBones(true); if (editorMode === "test") markTested(); } };
  const testRotation = (boneId: string): void => { enterMode("test"); select({ type: "bone", id: boneId }, false); setShowBones(true); setSweep({ kind: "bone", id: boneId }); markTested(); setMessage(`Swinging ${humanizeTechnicalId(boneId)}. Press Esc to stop`); };
  const movePivot = (boneId: string, x: number, y: number): void => { if (run("Move pivot", (current) => moveBonePivot(current, boneId, x, y))) setMessage(`Moved ${humanizeTechnicalId(boneId)} pivot. The art stayed in place`); };
  const selectChain = (id: RigChainId | null): void => {
    setReviewChainId(id); setSweep(null);
    const first = review.find((chain) => chain.id === id)?.joints[0];
    if (first) { setShowBones(true); select({ type: "bone", id: (review.find((chain) => chain.id === id)?.joints.find((joint) => joint.problem) ?? first).boneId }, false); }
  };
  const poseTestAvailability = Object.fromEntries(POSE_TESTS.map((test) => [test.id, poseTestBoneIds(rig, test.id).length > 0])) as Record<PoseTestId, boolean>;

  const contextItems = (selection: EditorSelection): readonly ContextMenuItem[] => {
    if (selection.type === "bone") {
      const bone = rig.bones.find((candidate) => candidate.id === selection.id);
      const child = rig.bones.find((candidate) => candidate.parentId === selection.id);
      return [
        { label: "Select parent", disabled: !bone?.parentId, onSelect: () => { if (bone?.parentId) select({ type: "bone", id: bone.parentId }, false); } },
        { label: "Select child", disabled: !child, onSelect: () => { if (child) select({ type: "bone", id: child.id }, false); } },
        { label: "Edit pivot", disabled: editorMode === "setup", onSelect: () => { enterMode("setup"); select(selection, false); setMessage("Drag the joint to move its pivot"); } },
        { label: "Test rotation", onSelect: () => testRotation(selection.id) },
        { label: "Reset pose", shortcut: "0", disabled: editorMode !== "test", onSelect: resetPose },
      ];
    }
    const slot = rig.slots.find((candidate) => candidate.id === selection.id);
    return [
      { label: "Select its bone", disabled: !slot, onSelect: () => { if (slot) select({ type: "bone", id: slot.boneId }, false); } },
      { label: "Edit region in Parts", shortcut: "1", onSelect: () => router.push("/part-cutter") },
      { label: slot?.visible === false ? "Show" : "Hide", disabled: !slot || editorMode !== "setup", onSelect: () => { if (slot) run("Toggle part visibility", (current) => updateSlot(current, slot.id, { visible: !slot.visible })); } },
      { label: lockedIds.has(`slot:${selection.id}`) ? "Unlock" : "Lock", onSelect: () => toggleSetValue(setLockedIds, `slot:${selection.id}`) },
    ];
  };

  const commands: StudioCommand[] = [
    { id: "prepare", label: "Parts", description: "Define the pieces of your character that can move", group: "Stage", shortcut: "1", keywords: "prepare cut masks regions", run: () => modeSelect("prepare") },
    { id: "setup", label: "Rig", description: "Connect the parts with bones and pivots", group: "Stage", shortcut: "2", keywords: "setup bones pivots skeleton", run: () => modeSelect("setup") },
    { id: "test", label: "Test", description: "Pose the character and confirm the rig behaves", group: "Stage", shortcut: "3", keywords: "pose rotate check", run: () => modeSelect("test") },
    { id: "animate", label: "Animate", description: "Create and edit motion", group: "Stage", shortcut: "4", keywords: "timeline clips keyframes", run: () => modeSelect("animate") },
    { id: "fit", label: "Fit character", description: "Fit the character in the viewport", group: "View", shortcut: "F", keywords: "frame zoom", run: () => viewportRef.current?.resetView() },
    { id: "focus", label: focusMode ? "Exit focus mode" : "Enter focus mode", description: "Hide panels for a clean look at the character", group: "View", shortcut: "Esc", run: toggleFocusMode },
    { id: "bones", label: showBones ? "Hide bones" : "Show bones", description: "Toggle bones, joints and pivots on the canvas", group: "View", keywords: "skeleton joints overlay", run: () => setShowBones((value) => !value) },
    { id: "bounds", label: showBounds ? "Hide part bounds" : "Show part bounds", description: "Toggle the box around each part's art", group: "View", run: () => setShowBounds((value) => !value) },
    { id: "show-all", label: "Show all bones", description: "Clear isolation and hidden bones", group: "View", disabled: editorMode === "animate", run: () => setHiddenBoneIds(new Set()) },
    { id: "test-joint", label: "Test selected bone", description: "Swing the selected bone in Test", group: "Test", disabled: !selectedBoneId, keywords: "rotate pivot joint", run: () => { if (selectedBoneId) testRotation(selectedBoneId); } },
    { id: "reset-pose", label: "Reset pose", description: "Return every bone to its rest pose", group: "Test", shortcut: "0", disabled: editorMode !== "test", run: resetPose },
    { id: "validate-rig", label: "Show rig problems", description: `${problems.length} current ${problems.length === 1 ? "problem" : "problems"}`, group: "Rig", keywords: "validate check issues", run: showProblems },
    { id: "save", label: editorMode === "animate" ? "Save animations" : "Save rig", description: "Export the current document", group: "File", shortcut: "⌘S", keywords: "export download", run: () => editorMode === "animate" ? animationCommand("save") : downloadJson() },
    { id: "undo", label: "Undo", description: (editorMode === "animate" ? animationHistory.undoLabel : historyUi.undoLabel) ?? "Nothing to undo", group: "Edit", shortcut: "⌘Z", disabled: editorMode === "test" || !(editorMode === "animate" ? animationHistory.canUndo : historyUi.canUndo), run: () => editorMode === "animate" ? animationCommand("undo") : undo() },
    { id: "redo", label: "Redo", description: (editorMode === "animate" ? animationHistory.redoLabel : historyUi.redoLabel) ?? "Nothing to redo", group: "Edit", shortcut: "⇧⌘Z", disabled: editorMode === "test" || !(editorMode === "animate" ? animationHistory.canRedo : historyUi.canRedo), run: () => editorMode === "animate" ? animationCommand("redo") : redo() },
    { id: "play", label: "Play animation", description: "Start playback of the current clip", group: "Animate", shortcut: "Space", disabled: editorMode !== "animate", run: () => animationCommand("play") },
    { id: "pause", label: "Pause animation", description: "Pause at the current time", group: "Animate", disabled: editorMode !== "animate", run: () => animationCommand("pause") },
    { id: "ai-animation", label: "Generate motion", description: "Generate or refine a clip for this character", group: "Animate", disabled: editorMode !== "animate", keywords: "ai walk run idle attack", run: () => animationCommand("ai") },
    { id: "visual-review", label: "Review motion", description: "Check the current clip for motion problems", group: "Animate", disabled: editorMode !== "animate", keywords: "preview render diagnose", run: () => animationCommand("review") },
    { id: "activity", label: "Agent status", description: agentStatus.label, group: "System", keywords: "mcp tools bridge connection", run: () => { setUtilityTab("activity"); setUtilityOpen(true); } },
    { id: "reset-workspace", label: "Reset workspace", description: "Restore panels, overlays and the view", group: "System", run: resetWorkspace },
  ];
  const connections: readonly StudioConnection[] = [
    { id: "rig", label: "Rig", state: validationIssues.length ? "degraded" : "ready", title: validationIssues.length ? `${validationIssues.length} issues` : "Document ready" },
    { id: "agent", label: "Agent", state: agentStatus.ready ? "ready" : agentStatus.state === "bridge" || agentStatus.state === "no-tools" ? "degraded" : "offline", title: agentStatus.label },
    { id: "comfyui", label: "ComfyUI", state: providerHealth.state === "READY" ? "ready" : providerHealth.state === "OFFLINE" ? "offline" : providerHealth.state === "DISABLED" ? "disabled" : "degraded", title: `${providerHealth.state} · ${providerHealth.endpoint ?? "configured localhost endpoint"}${providerHealth.lastError ? ` · ${providerHealth.lastError}` : ""}` },
  ];
  const beginPanelResize = (side: "left" | "right", event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    const startX = event.clientX; const startWidth = side === "left" ? leftPanelWidth : rightPanelWidth;
    const move = (pointerEvent: PointerEvent): void => { const delta = (pointerEvent.clientX - startX) * (side === "left" ? 1 : -1); const next = Math.max(side === "left" ? 208 : 268, Math.min(side === "left" ? 360 : 420, startWidth + delta)); if (side === "left") setLeftPanelWidth(next); else setRightPanelWidth(next); };
    const stop = (): void => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop, { once: true });
  };
  const workspaceStyle = { "--navigator-width": `${leftPanelWidth}px`, "--inspector-width": `${rightPanelWidth}px` } as CSSProperties;
  const testing = editorMode === "test";
  const inAnimate = editorMode === "animate";
  const railUndo = inAnimate ? animationHistory : historyUi;
  const hierarchyDisabled = previewMode || testing;
  return <main className={`rig-editor-shell workflow-v2 mode-${editorMode} ${focusMode ? "is-focus-mode" : ""}`} style={workspaceStyle} data-project-id={hydrationIdentity.activeProjectId ?? "browser-draft"} data-project-session-token={hydrationIdentity.projectSessionToken} data-hydration-token={hydrationIdentity.hydrationToken}>
    <input ref={loadInputRef} hidden type="file" accept="application/json,.json" onChange={(event) => void loadJson(event)} />
    <input ref={uploadInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadAttachment(event)} />
    <input ref={prepareInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void importSpriteForCutting(event)} />
    <TopCommandRail active={editorMode} stageStatuses={stageStatuses} projectName={rigName(rig)} dirty={dirty} editingName={renamingRig} onEditingName={setRenamingRig} onCommitName={commitRigName} onSelect={modeSelect} onCommand={() => setCommandPaletteOpen(true)} onUndo={() => inAnimate ? animationCommand("undo") : undo()} onRedo={() => inAnimate ? animationCommand("redo") : redo()} canUndo={!testing && !previewMode && railUndo.canUndo} canRedo={!testing && !previewMode && railUndo.canRedo} undoTitle={testing ? "Posing in Test is not recorded. Use Reset pose" : `${railUndo.undoLabel ?? "Nothing to undo"}  (⌘Z)`} redoTitle={`${railUndo.redoLabel ?? "Nothing to redo"}  (⇧⌘Z)`} onExport={() => setExportOpen(true)} validity={{ count: validationIssues.length, onOpen: showProblems }} connections={connections} onConnections={() => { setUtilityTab("activity"); setUtilityOpen(true); }} focus={{ active: focusMode, onToggle: toggleFocusMode }} projectActions={<><button type="button" onClick={() => prepareInputRef.current?.click()} disabled={previewMode || inAnimate}>New from image…</button><Link href="/create-character">Generate with AI…</Link><button type="button" onClick={() => loadInputRef.current?.click()} disabled={previewMode || inAnimate}>Load rig file…</button></>} workspaceActions={<><button type="button" onClick={discardDraft} disabled={previewMode || inAnimate}>Discard local draft</button><button type="button" onClick={resetWorkspace}>Reset workspace</button></>}><ImageProductionStatus projectId={agentSession.activeProjectId?.startsWith("character-") ? agentSession.activeProjectId : null} /></TopCommandRail>
    <ExportForGame open={exportOpen} rig={rig} animations={exportOpen ? exportAnimations() : []} onClose={() => setExportOpen(false)} />

      {inAnimate ? <AnimateWorkspace key={hydrationIdentity.projectSessionToken} projectId={hydrationIdentity.activeProjectId} rig={rig} activeSkinId={effectiveSkinId} showGrid={showGrid} showBones={showBones} showBounds={showBounds} viewportRef={viewportRef} initialBoneId={selectedBoneId} onSelectedBone={(boneId) => setSelections((current) => current.length === 1 && current[0].type === "bone" && current[0].id === boneId ? current : [{ type: "bone", id: boneId }])} onHistory={setAnimationHistory} onMotion={(edited) => { if (edited && !hasMotion) { setHasMotion(true); writeStageMark(ANIMATED_KEY, projectKey); } }} onFacing={setFacing} onRebuild={rebuildFromParts} onCursor={setCursor} onZoom={setZoom} onMessage={setMessage} onError={setError} /> : <div key={hydrationIdentity.projectSessionToken} className={`editor-body ${leftCollapsed ? "left-collapsed" : ""} ${rightCollapsed ? "right-collapsed" : ""} ${!primarySelection ? "context-idle" : ""}`} data-canvas-project-id={hydrationIdentity.activeProjectId ?? "browser-draft"} data-inspector-project-id={hydrationIdentity.activeProjectId ?? "browser-draft"}>
      <aside className="editor-left-panel" aria-label="Structure">
        <header className="panel-identity"><span>{testing ? "Skeleton" : advancedStructure ? "Advanced structure" : "Structure"}</span><button type="button" onClick={() => setLeftCollapsed(true)} aria-label="Collapse structure panel">‹</button></header>
        <div className="outliner-search"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={structureView === "parts" && !testing ? "Find a part" : "Find a bone"} aria-label="Search structure" /><button type="button" onClick={() => setSearch("")} disabled={!search} aria-label="Clear search">×</button></div>
        {advancedStructure && !testing
          ? <div className="structure-advanced"><EditorHierarchy rig={rig} search={search} selections={selections} hiddenBoneIds={hiddenBoneIds} lockedIds={lockedIds} onSelect={select} onToggleBoneVisibility={(id) => toggleSetValue(setHiddenBoneIds, id)} onToggleSlotVisibility={(id) => run("Toggle slot visibility", (current) => { const slot = current.slots.find((item) => item.id === id); return slot ? updateSlot(current, id, { visible: !slot.visible }) : current; })} onToggleLock={(key) => toggleSetValue(setLockedIds, key)} onAdd={addItem} onDuplicate={duplicateItem} onDelete={deleteItem} onMoveSlot={(id, direction) => run("Reorder slot", (current) => moveSlot(current, id, direction))} disabled={hierarchyDisabled} /></div>
          : <SkeletonTree view={structureView} onView={setStructureView} rig={rig} activeSkinId={effectiveSkinId} search={search} selections={selections} review={review} skeletonOnly={testing} onSelect={selectInStage} />}
        {!testing && <button type="button" className={`advanced-tree-toggle ${advancedStructure ? "is-active" : ""}`} aria-pressed={advancedStructure} title="Raw bones, slots, attachments and skins" onClick={() => setAdvancedStructure((value) => !value)}><span>⌘</span>{advancedStructure ? "Back to skeleton" : "Advanced structure"}<b>›</b></button>}
        <button type="button" className="panel-resize-handle resize-left" onPointerDown={(event) => beginPanelResize("left", event)} aria-label="Resize structure panel" />
      </aside>

      <section className="editor-center">
        {leftCollapsed && <button type="button" className="restore-panel restore-left" onClick={() => setLeftCollapsed(false)}>{testing ? "Skeleton" : "Structure"} ›</button>}
        {rightCollapsed && <button type="button" className="restore-panel restore-right" onClick={() => setRightCollapsed(false)}>‹ Inspector</button>}
        {!testing && <div className="rig-notices"><RebuildNotice rig={rig} onRebuild={rebuildFromParts} /><RepaintNotice rig={rig} onRepaint={repaintFromParts} /><FacingQuestion rig={rig} onFacing={setFacing} /></div>}
        <div className="viewport-context-row"><div className="selection-breadcrumb"><span>{testing ? "Test" : "Rig"}</span><i>›</i><strong>{primarySelection ? `${primarySelection.type === "bone" ? "Bone" : primarySelection.type === "slot" ? "Part" : humanizeTechnicalId(primarySelection.type)} · ${selectionLabel}` : testing ? "Drag a bone to pose" : "Click a bone or a part"}</strong></div><CanvasControls tool={canvasTool} onTool={setCanvasTool} showBones={showBones} showGrid={showGrid} showBounds={showBounds} snapToGrid={snapToGrid} wholePixelSnap={wholePixelSnap} rotationSnap={rotationSnap} onShowBones={() => setShowBones((value) => !value)} onShowGrid={() => setShowGrid((value) => !value)} onShowBounds={() => setShowBounds((value) => !value)} onSnapToGrid={() => setSnapToGrid((value) => !value)} onWholePixelSnap={() => setWholePixelSnap((value) => !value)} onRotationSnap={() => setRotationSnap((value) => !value)} onFit={() => viewportRef.current?.resetView()} /></div>
        <EditorViewport ref={viewportRef} rig={rig} animation={previewAnimation} previewMode={previewMode} poseMode={testing} pivotEdit={!testing} activeSkinId={effectiveSkinId} selections={selections} hiddenBoneIds={hiddenBoneIds} lockedBoneIds={new Set([...lockedIds].filter((key) => key.startsWith("bone:")).map((key) => key.slice(5)))} showGrid={showGrid} showBones={showBones} showBounds={showBounds} snapToGrid={snapToGrid} wholePixelSnap={wholePixelSnap} rotationSnap={testing ? false : rotationSnap} canvasTool={canvasTool} interactionMode={testing ? "test" : "rig"} onSelect={selectInStage} onCursor={(point) => setCursor(point)} onZoom={setZoom} onBoneDragStart={testing ? () => undefined : beginBoneDrag} onBoneDragPreview={() => undefined} onBoneDragCommit={testing ? () => { setPosed(true); markTested(); } : commitBoneDrag} onPivotCommit={movePivot} onContextMenu={(selection, x, y) => setContextMenu({ selection, x, y, items: contextItems(selection) })} onWarning={setError} />
        {previewMode && <div className="preview-notice" role="status">{testing ? "Quick test playing" : "Rotate test playing"} · the rig is not changed · Esc to stop</div>}
        {testing
          ? <TestPoseStrip available={poseTestAvailability} activeTest={sweep?.kind === "test" ? sweep.id : null} posed={posed || sweep !== null} onTest={(id) => runSweep(id ? { kind: "test", id } : null)} onReset={resetPose} onFix={() => enterMode("setup")} onNext={() => { markTested(); modeSelect("animate"); }} />
          : <RigReviewStrip chains={review} activeChainId={reviewChainId} selectedBoneId={selectedBoneId} testing={sweep?.kind === "chain"} blockingCount={blockingValidationIssues.length} onChain={selectChain} onJoint={(boneId) => { setSweep(null); select({ type: "bone", id: boneId }, false); }} onRotateTest={() => runSweep(sweep?.kind === "chain" || !reviewChainId ? null : { kind: "chain", id: reviewChainId })} onShowProblems={showProblems} onNext={() => modeSelect("test")} />}
      </section>

      <aside className={`editor-right-panel ${!primarySelection ? "is-context-idle" : ""}`} aria-label="Inspector">
        <button type="button" className="panel-resize-handle resize-right" onPointerDown={(event) => beginPanelResize("right", event)} aria-label="Resize inspector" />
        <header className="panel-identity"><span>{primarySelection ? "Inspector" : "Context"}</span><button type="button" onClick={() => setRightCollapsed(true)} aria-label="Collapse inspector">›</button></header>
        {primarySelection ? <EditorInspector rig={rig} selection={primarySelection} activeSkinId={effectiveSkinId} jointReview={jointReview} previewMode={previewMode || testing} locked={selectedLocked} onSelect={(selection) => select(selection, false)} onFrame={() => viewportRef.current?.resetView()} onIsolate={() => { if (primarySelection?.type === "bone") setHiddenBoneIds(new Set(rig.bones.filter((bone) => bone.id !== primarySelection.id).map((bone) => bone.id))); }} onBonePatch={(id, patch, label) => run(label, (current) => updateBone(current, id, patch))} onPivot={movePivot} onSlotPatch={(id, patch, label) => run(label, (current) => updateSlot(current, id, patch))} onAttachmentPatch={(id, patch, label) => run(label, (current) => updateAttachment(current, id, patch))} onRenameSkin={(id, name) => run("Rename skin", (current) => renameSkin(current, id, name))} onAssignSkin={(skinId, slotId, attachmentId) => run("Assign skin attachment", (current) => assignSkinAttachment(current, skinId, slotId, attachmentId))} onTestRotation={testRotation} onEditRegion={() => router.push("/part-cutter")} /> : <div className="context-rail-empty"><span>⌁</span><p>Click a bone or a part</p></div>}
      </aside>
    </div>}
    {focusMode && inAnimate && <div className="focus-playback-controls" aria-label="Focus playback controls"><button type="button" onClick={() => animationCommand("play")}>▶ Play</button><button type="button" onClick={() => animationCommand("pause")}>Ⅱ Pause</button><button type="button" onClick={() => animationCommand("restart")}>↺ Restart</button><button type="button" onClick={() => setFocusMode(false)}>Exit Focus</button></div>}

    {contextMenu && <CanvasContextMenu title={contextMenu.selection.type === "bone" ? `Bone · ${humanizeTechnicalId(contextMenu.selection.id)}` : `Part · ${partName(contextMenu.selection.id)}`} x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
    {(error || message) && <output key={error ?? message} className={`studio-toast ${error ? "is-error" : ""}`}><span>{error ? "!" : "●"}</span>{agentSession.lastOperation ? `${agentSession.lastOperation} · ` : ""}{error ?? message}</output>}
    <StudioUtilityDrawer open={utilityOpen} tab={utilityTab} problems={problems} activity={agentActivity} onTab={setUtilityTab} onClose={() => setUtilityOpen(false)} />
    <StudioCommandPalette commands={commands} mode={editorMode} selection={selectionLabel} open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
    <StudioDialog open={confirmDiscard} title="Discard local rig draft?" description="The bundled test rig will replace the current local setup document. This action intentionally clears the local draft." confirmLabel="Discard draft" danger onCancel={() => setConfirmDiscard(false)} onConfirm={confirmDiscardDraft} />
    <StudioDialog open={pendingDelete !== null} title={pendingDelete ? `Delete ${humanizeTechnicalId(pendingDelete.id)}?` : "Delete object?"} description={pendingDelete?.type === "bone" ? `This bone affects ${pendingDelete.childIds.length} child bone(s) and ${pendingDelete.slotIds.length} slot(s). The repair and deletion will be one undoable command.` : `This ${pendingDelete?.type ?? "object"} will be removed in one undoable command.`} confirmLabel="Delete" danger confirmDisabled={Boolean(pendingDelete?.type === "bone" && (pendingDelete.childIds.length || pendingDelete.slotIds.length) && !deleteReplacementId)} onCancel={() => setPendingDelete(null)} onConfirm={confirmDeleteItem}>
      {pendingDelete?.type === "bone" && (pendingDelete.childIds.length > 0 || pendingDelete.slotIds.length > 0) && <><ul>{pendingDelete.childIds.map((id) => <li key={`bone-${id}`}>Child: {humanizeTechnicalId(id)}</li>)}{pendingDelete.slotIds.map((id) => <li key={`slot-${id}`}>Slot: {humanizeTechnicalId(id)}</li>)}</ul><label>Move dependents to<select value={deleteReplacementId} onChange={(event) => setDeleteReplacementId(event.target.value)}>{pendingDelete.replacementChoices.map((id) => <option key={id} value={id}>{humanizeTechnicalId(id)}</option>)}</select></label></>}
    </StudioDialog>
  </main>;
}
