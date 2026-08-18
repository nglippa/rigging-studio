"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { safeParseAnimationDefinition, safeParseAnimationJson, safeParseRigJson } from "@/src/rigging/schema/parsing";
import type { AnimationDefinition, AttachmentDefinition, RigDefinition } from "@/src/rigging/schema/types";
import { validateRigDefinition } from "@/src/rigging/validation/rig";
import type { ValidationIssue } from "@/src/rigging/validation/issues";
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
import { EditorHierarchy } from "./EditorHierarchy";
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
import { ImageProductionStatus } from "./ImageProductionStatus";
import { PART_CUTTER_IMPORT_KEY, type PartCutterImportPayload } from "@/src/part-cutter/importBridge";
import { StudioCommandPalette, type StudioCommand } from "@/app/studio-ui/StudioCommandPalette";
import { StudioModeNav, type StudioMode } from "@/app/studio-ui/StudioModeNav";
import { StudioUtilityDrawer, type StudioProblem } from "@/app/studio-ui/StudioUtilityDrawer";
import { humanizeTechnicalId } from "@/app/studio-ui/humanize";
import { StudioDialog } from "@/app/studio-ui/StudioDialog";
import { presentAgentStatus } from "@/app/studio-ui/agentStatus";

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
const readHistoryUi = (history: RigCommandHistory): HistoryUi => ({ canUndo: history.canUndo, canRedo: history.canRedo, undoLabel: history.getUndoLabel(), redoLabel: history.getRedoLabel() });

export function RigEditor() {
  const router = useRouter();
  const commandService = useMemo(() => getRiggingCommandService(), []);
  const characterStorage = useMemo(() => getGeneratedCharacterStorage(), []);
  const agentSession = useAgentBridge(commandService);
  const [rig, setRig] = useState<RigDefinition | null>(null);
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
  const [previewMode, setPreviewMode] = useState(false);
  const [editorMode, setEditorMode] = useState<"setup" | "animate">("setup");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [utilityTab, setUtilityTab] = useState<"problems" | "activity">("problems");
  const [focusMode, setFocusMode] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [activeSkinId, setActiveSkinId] = useState("");
  const [zoom, setZoom] = useState(1);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("Loading rig document");
  const [centerOnLoad, setCenterOnLoad] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteReplacementId, setDeleteReplacementId] = useState("");
  const [historyUi, setHistoryUi] = useState<HistoryUi>({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
  const historyRef = useRef<RigCommandHistory | null>(null);
  const viewportRef = useRef<EditorViewportHandle>(null);
  const loadInputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const prepareInputRef = useRef<HTMLInputElement>(null);
  const uploadedUrlsRef = useRef<Set<string>>(new Set());
  const rigStateRef = useRef<RigDefinition | null>(null);
  const generatedProjectRef = useRef<GeneratedCharacterProject | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => { const mode = new URLSearchParams(window.location.search).get("mode"); if (mode === "animate") setEditorMode("animate"); try { const stored = JSON.parse(window.localStorage.getItem("rigging-studio-workspace-v1") ?? "{}") as { leftCollapsed?: boolean; rightCollapsed?: boolean; showGrid?: boolean; showBones?: boolean; showBounds?: boolean }; setLeftCollapsed(Boolean(stored.leftCollapsed)); setRightCollapsed(Boolean(stored.rightCollapsed)); if (stored.showGrid !== undefined) setShowGrid(stored.showGrid); if (stored.showBones !== undefined) setShowBones(stored.showBones); if (stored.showBounds !== undefined) setShowBounds(stored.showBounds); } catch { /* invalid workspace preferences fall back to the disciplined default layout */ } setPreferencesReady(true); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => { if (preferencesReady) window.localStorage.setItem("rigging-studio-workspace-v1", JSON.stringify({ leftCollapsed, rightCollapsed, showGrid, showBones, showBounds })); }, [leftCollapsed, preferencesReady, rightCollapsed, showBones, showBounds, showGrid]);

  useEffect(() => {
    if (!preferencesReady) return;
    const currentMode = new URLSearchParams(window.location.search).get("mode") === "animate" ? "animate" : "setup";
    if (currentMode !== editorMode) router.replace(`/?mode=${editorMode}`, { scroll: false });
  }, [editorMode, preferencesReady, router]);

  useEffect(() => {
    if (agentSession.activeStage === "describe" && agentSession.activeProjectId?.startsWith("character-")) router.push("/create-character");
  }, [agentSession.activeProjectId, agentSession.activeStage, router]);

  useEffect(() => {
    let cancelled = false;
    const uploadedUrls = uploadedUrlsRef.current;
    void (async () => {
      try {
        const [rigResponse, animationResponse, ...sampleResponses] = await Promise.all([fetch("/rig-test/minimal-rig.json"), fetch("/rig-test/idle-animation.json"), ...SAMPLE_ANIMATION_PATHS.map((path) => fetch(path))]);
        const [rigSource, animationSource, ...sampleSources] = await Promise.all([rigResponse.text(), animationResponse.text(), ...sampleResponses.map((response) => response.text())]);
        const parsedRig = safeParseRigJson(rigSource);
        if (!parsedRig.success) throw new Error(parsedRig.message);
        let initialRig = parsedRig.data;
        let restored = false;
        const localDraft = window.localStorage.getItem(RIG_EDITOR_DRAFT_KEY);
        const rawHandoff = window.localStorage.getItem(RIG_EDITOR_HANDOFF_KEY);
        let handoff: RigEditorHandoff | null = null;
        if (rawHandoff) {
          try { handoff = JSON.parse(rawHandoff) as RigEditorHandoff; } catch { handoff = null; }
          window.localStorage.removeItem(RIG_EDITOR_HANDOFF_KEY);
        }
        const storedProject = await characterStorage.load();
        const generatedProject = storedProject?.success && storedProject.data.rigDefinition && (!handoff || storedProject.data.id === handoff.projectId)
          ? storedProject.data
          : null;
        if (generatedProject) {
          initialRig = generatedProject.rigDefinition!;
          generatedProjectRef.current = generatedProject;
          commandService.activateProjectFromUi(generatedProject);
          restored = true;
        }
        if (localDraft && !generatedProject) {
          const draft = parseDraft(localDraft);
          if (draft.success) { initialRig = draft.data.rig; restored = true; }
        }
        const parsedAnimation = safeParseAnimationJson(animationSource, initialRig);
        const validAnimations = sampleSources.flatMap((source) => {
          const parsed = safeParseAnimationJson(source, initialRig);
          return parsed.success ? [parsed.data] : [];
        });
        let initialAnimations = createAnimationLibrary(initialRig.id, validAnimations);
        const animationDraft = loadAnimationDraft(window.localStorage, initialRig);
        if (animationDraft?.success) initialAnimations = animationDraft.data;
        if (cancelled) return;
        commandService.syncAnimationsFromUi(initialAnimations, initialAnimations.animations[0]?.id ?? null);
        historyRef.current = new RigCommandHistory(initialRig);
        setDefaultRig(parsedRig.data);
        setRig(historyRef.current.present);
        rigStateRef.current = historyRef.current.present;
        setActiveSkinId(initialRig.defaultSkinId);
        setAnimation(parsedAnimation.success ? parsedAnimation.data : null);
        if (handoff?.showBones) setShowBones(true);
        if (handoff?.centerView) setCenterOnLoad(true);
        setHistoryUi(readHistoryUi(historyRef.current));
        setMessage(handoff?.validationMessage ?? (restored
          ? initialRig.attachments.some((attachment) => attachment.imagePath.startsWith("blob:"))
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
  }, [characterStorage, commandService]);

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
        void characterStorage.save(next).then((result) => {
          if (result.success) setMessage(`Generated rig autosaved · ${(result.approximateBytes / 1_048_576).toFixed(1)} MB in IndexedDB`);
          else setError(`Rig remains in memory. ${result.layer} failed: ${result.message}`);
        });
      } else {
        try { window.localStorage.setItem(RIG_EDITOR_DRAFT_KEY, serializeDraft(rig)); setMessage("Local draft autosaved"); }
        catch (reason: unknown) { setError(`Rig remains in memory. Local draft failed: ${reason instanceof Error ? reason.message : "storage unavailable"}`); }
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [characterStorage, rig]);

  const previewAnimation = useMemo(() => {
    if (!rig || !animation) return null;
    const result = safeParseAnimationDefinition(animation, rig);
    return result.success ? result.data : null;
  }, [animation, rig]);

  const primarySelection = selections.at(-1) ?? null;
  const selectedLocked = primarySelection ? lockedIds.has(`${primarySelection.type}:${primarySelection.id}`) : false;
  const validationIssues = rig ? validateRigDefinition(rig) : [];

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

  const select = useCallback((selection: EditorSelection | null, additive: boolean): void => {
    if (!selection) { setSelections([]); return; }
    setSelections((current) => {
      if (!additive) return [selection];
      const exists = current.some((item) => item.type === selection.type && item.id === selection.id);
      return exists ? current.filter((item) => item.type !== selection.type || item.id !== selection.id) : [...current, selection];
    });
    if (selection.type === "skin") setActiveSkinId(selection.id);
  }, []);

  useEffect(() => {
    if (!rig || !historyRef.current) return;
    return commandService.attachRigEditor({
      getRig: () => historyRef.current?.present ?? rigStateRef.current ?? rig,
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
    setPreviewMode(false);
    setDirty(false);
    setHistoryUi(readHistoryUi(commandHistory));
    setError(null);
    setMessage(`Loaded ${file.name}`);
  };

  const importSpriteForCutting = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    if (!/image\/(png|jpeg|webp)/.test(file.type)) { setError("Choose a PNG, JPG, or WebP sprite"); return; }
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
    setPreviewMode(false);
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
      if (modifier && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if (modifier && event.key.toLowerCase() === "s") { event.preventDefault(); downloadJson(); return; }
      if (modifier && event.key.toLowerCase() === "o") { event.preventDefault(); if (!previewMode) loadInputRef.current?.click(); return; }
      if (editableTarget(event.target)) return;
      if (event.key === "Escape") { setSelections([]); return; }
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
  }, [deleteItem, downloadJson, editorMode, previewMode, primarySelection, redo, rig, run, undo]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent): void => {
      if (editableTarget(event.target) || commandPaletteOpen) return;
      if (event.key === "1") { event.preventDefault(); router.push("/part-cutter"); return; }
      if (event.key === "2") { event.preventDefault(); router.replace("/?mode=setup", { scroll: false }); setEditorMode("setup"); setPreviewMode(false); setFocusMode(false); return; }
      if (event.key === "3") { event.preventDefault(); router.replace("/?mode=animate", { scroll: false }); setEditorMode("animate"); setPreviewMode(false); setFocusMode(false); return; }
      if (event.key.toLowerCase() === "f") { event.preventDefault(); viewportRef.current?.resetView(); return; }
      if (event.key === "Escape" && focusMode) { event.preventDefault(); setFocusMode(false); }
    };
    window.addEventListener("keydown", keyDown); return () => window.removeEventListener("keydown", keyDown);
  }, [commandPaletteOpen, focusMode, router]);

  if (!rig) return <main className="rig-editor-shell is-loading"><div className="editor-loading">{error ?? "Loading rig editor"}</div></main>;

  const commitRigName = (value: string): void => { if (value.trim() && value !== rigName(rig)) run("Rename rig", (current) => updateRigIdentity(current, current.id, value)); };
  const toggleSetValue = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, value: string): void => setter((current) => { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; });
  const effectiveSkinId = rig.skins.some((skin) => skin.id === activeSkinId) ? activeSkinId : rig.defaultSkinId;
  const agentActivity = agentSession.activity.filter((event) => event.actor !== "Human");
  const selectionLabel = editorMode === "animate" && agentSession.selectedBoneId
    ? humanizeTechnicalId(agentSession.selectedBoneId)
    : primarySelection ? humanizeTechnicalId(primarySelection.id) : "Nothing selected";
  const agentStatus = presentAgentStatus(agentSession);
  const selectIssueSource = (issue: ValidationIssue): (() => void) | undefined => {
    if (issue.mode === "prepare") return () => router.push("/part-cutter");
    const path = issue.path;
    const collection = path[0]; const index = typeof path[1] === "number" ? path[1] : -1;
    if (collection === "bones" && rig.bones[index]) return () => { router.replace("/?mode=setup", { scroll: false }); setEditorMode("setup"); select({ type: "bone", id: rig.bones[index].id }, false); setUtilityOpen(false); };
    if (collection === "slots" && rig.slots[index]) return () => { router.replace("/?mode=setup", { scroll: false }); setEditorMode("setup"); select({ type: "slot", id: rig.slots[index].id }, false); setUtilityOpen(false); };
    if (collection === "attachments" && rig.attachments[index]) return () => { router.replace("/?mode=setup", { scroll: false }); setEditorMode("setup"); select({ type: "attachment", id: rig.attachments[index].id }, false); setUtilityOpen(false); };
    if (collection === "skins" && rig.skins[index]) return () => { router.replace("/?mode=setup", { scroll: false }); setEditorMode("setup"); select({ type: "skin", id: rig.skins[index].id }, false); setUtilityOpen(false); };
    return undefined;
  };
  const problems: StudioProblem[] = validationIssues.map((issue, index) => ({ id: `${issue.code}-${index}`, severity: issue.severity ?? "error", title: humanizeTechnicalId(issue.code), detail: issue.suggestedAction ? `${issue.message} ${issue.suggestedAction}` : issue.message, context: issue.objectId ? humanizeTechnicalId(issue.objectId) : issue.path.join(" › ") || "Rig", onSelect: selectIssueSource(issue) }));
  const modeSelect = (mode: StudioMode): void => { if (mode === "prepare") router.push("/part-cutter"); else { router.replace(`/?mode=${mode}`, { scroll: false }); setEditorMode(mode); setPreviewMode(false); setFocusMode(false); } };
  const toggleFocusMode = (): void => { const entering = !focusMode; setFocusMode(entering); if (entering) window.requestAnimationFrame(() => viewportRef.current?.resetView()); };
  const resetWorkspace = (): void => { setLeftCollapsed(false); setRightCollapsed(false); setShowGrid(true); setShowBones(true); setShowBounds(false); setFocusMode(false); viewportRef.current?.resetView(); setMessage("Workspace layout reset"); };
  const animationCommand = (action: "play" | "pause" | "restart" | "ai" | "review"): void => { window.dispatchEvent(new CustomEvent("rig-studio:animation-command", { detail: action })); };
  const commands: StudioCommand[] = [
    { id: "prepare", label: "Prepare character parts", description: "Open source cutting, masks, semantics, and reconstruction", group: "Mode", shortcut: "1", keywords: "ai cut manual cut masks", run: () => modeSelect("prepare") },
    { id: "setup", label: "Setup rig", description: "Edit bones, pivots, slots, equipment, and skins", group: "Mode", shortcut: "2", run: () => modeSelect("setup") },
    { id: "animate", label: "Animate character", description: "Open animations, playback, timeline, and visual review", group: "Mode", shortcut: "3", run: () => modeSelect("animate") },
    { id: "fit", label: "Frame selection", description: "Fit or frame the selected character object in the viewport", group: "View", shortcut: "F", keywords: "fit character frame selected", run: () => viewportRef.current?.resetView() },
    { id: "focus", label: focusMode ? "Exit focus mode" : "Enter focus mode", description: "Hide panels and overlays for a clean character review", group: "View", shortcut: "Esc", run: toggleFocusMode },
    { id: "bones", label: showBones ? "Hide bone overlay" : "Show bone overlay", description: "Toggle joint and bone controls", group: "View", keywords: "show bones hide bones skeleton joints", run: () => setShowBones((value) => !value) },
    { id: "bounds", label: showBounds ? "Hide part bounds" : "Show part bounds", description: "Toggle attachment bounding boxes", group: "View", run: () => setShowBounds((value) => !value) },
    { id: "show-all", label: "Show all bones", description: "Clear hidden-bone isolation and visibility overrides", group: "Visibility", disabled: editorMode === "animate", run: () => setHiddenBoneIds(new Set()) },
    { id: "isolate", label: "Isolate selected bone", description: "Hide every bone except the current selection", group: "Selection", disabled: editorMode === "animate" || primarySelection?.type !== "bone", run: () => { if (primarySelection?.type === "bone") setHiddenBoneIds(new Set(rig.bones.filter((bone) => bone.id !== primarySelection.id).map((bone) => bone.id))); } },
    { id: "save", label: editorMode === "animate" ? "Save animations" : "Save rig", description: "Export the current authored document", group: "File", shortcut: "⌘S", keywords: "export character download project", run: () => editorMode === "animate" ? window.dispatchEvent(new CustomEvent("rig-studio:animation-command", { detail: "save" })) : downloadJson() },
    { id: "equipment", label: "Equipment and attachments", description: "Open Setup and find equipment, slots, and attachments", group: "Setup", keywords: "shield sword attachment slot skin", run: () => { modeSelect("setup"); setSearch("attachment"); } },
    { id: "test-joint", label: "Test selected joint", description: "Check the selected bone's editable length and open its inspector", group: "Setup", disabled: editorMode !== "setup" || primarySelection?.type !== "bone", keywords: "rotate bone test pivot", run: () => { const bone = primarySelection?.type === "bone" ? rig.bones.find((candidate) => candidate.id === primarySelection.id) : null; setMessage(bone && bone.length > .001 ? `${humanizeTechnicalId(bone.id)} is ready for rotation testing in the inspector` : "Selected joint needs a meaningful nonzero length"); } },
    { id: "validate-rig", label: "Validate rig", description: "Run structural checks and open actionable Problems", group: "Review", keywords: "check skeleton missing slot", run: () => { setUtilityTab("problems"); setUtilityOpen(true); setMessage(problems.length ? `Validation found ${problems.length} problem(s)` : "Rig validation passed"); } },
    { id: "undo", label: "Undo", description: historyUi.undoLabel ?? "No setup change to undo", group: "Edit", shortcut: "⌘Z", disabled: editorMode === "animate" || !historyUi.canUndo, run: undo },
    { id: "redo", label: "Redo", description: historyUi.redoLabel ?? "No setup change to redo", group: "Edit", shortcut: "⇧⌘Z", disabled: editorMode === "animate" || !historyUi.canRedo, run: redo },
    { id: "play", label: "Play animation", description: "Start playback in the current animation", group: "Animate", shortcut: "Space", disabled: editorMode !== "animate", run: () => animationCommand("play") },
    { id: "pause", label: "Pause animation", description: "Pause playback at the current time", group: "Animate", disabled: editorMode !== "animate", run: () => animationCommand("pause") },
    { id: "ai-animation", label: "AI Animate · Generate Walk", description: "Generate or refine a walk for the selected animation", group: "AI", disabled: editorMode !== "animate", keywords: "generate walk ai animation motion", run: () => animationCommand("ai") },
    { id: "visual-review", label: "Visual Review · Render Preview", description: "Render a contact sheet and inspect motion diagnostics", group: "Review", disabled: editorMode !== "animate", keywords: "preview render contact sheet diagnose", run: () => animationCommand("review") },
    { id: "problems", label: "Show problems", description: `${problems.length} current workspace ${problems.length === 1 ? "problem" : "problems"}`, group: "Review", run: () => { setUtilityTab("problems"); setUtilityOpen(true); } },
    { id: "activity", label: "Agent status", description: agentStatus.label, group: "Review", keywords: "mcp tools bridge connection", run: () => { setUtilityTab("activity"); setUtilityOpen(true); } },
    { id: "comfy-status", label: "Comfy status", description: "Inspect the image-production provider status in the top bar", group: "Review", keywords: "image provider comfyui workflow", run: () => setMessage("Comfy provider status is shown in the top bar") },
    { id: "reset-workspace", label: "Reset workspace", description: "Restore panels, overlays, and viewport defaults", group: "Workspace", run: resetWorkspace },
  ];
  const nextAction = validationIssues.length ? "Next: review Problems" : editorMode === "setup" ? "Next: test joints or animate" : "Next: preview motion or run visual review";

  return <main className={`rig-editor-shell mode-${editorMode} ${focusMode ? "is-focus-mode" : ""}`}>
    <input ref={loadInputRef} hidden type="file" accept="application/json,.json" onChange={(event) => void loadJson(event)} />
    <input ref={uploadInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadAttachment(event)} />
    <input ref={prepareInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void importSpriteForCutting(event)} />
    <header className="editor-topbar">
      <Link href="/" className="editor-mark" aria-label="Rig editor">RS</Link>
      <label className="rig-name"><span className={dirty ? "is-dirty" : ""}>Project</span><input key={rigName(rig)} defaultValue={rigName(rig)} disabled={previewMode} onBlur={(event) => commitRigName(event.target.value)} /></label>
      <StudioModeNav active={editorMode} onSelect={modeSelect} />
      <button type="button" className="command-trigger" onClick={() => setCommandPaletteOpen(true)}><span>Search commands</span><kbd>⌘K</kbd></button>
      <details className="studio-file-menu"><summary>File</summary><div><Link href="/create-character">Create character</Link><button type="button" onClick={() => prepareInputRef.current?.click()} disabled={previewMode || editorMode === "animate"}>Import sprite</button><button type="button" onClick={() => loadInputRef.current?.click()} disabled={previewMode || editorMode === "animate"}>Load rig</button><button type="button" onClick={downloadJson} disabled={editorMode === "animate"}>Export rig</button><button type="button" onClick={resetWorkspace}>Reset workspace</button></div></details>
      <div className="topbar-group global-edit-tools"><button type="button" onClick={undo} disabled={editorMode === "animate" || previewMode || !historyUi.canUndo} title={historyUi.undoLabel ?? "Nothing to undo"}>Undo</button><button type="button" onClick={redo} disabled={editorMode === "animate" || previewMode || !historyUi.canRedo} title={historyUi.redoLabel ?? "Nothing to redo"}>Redo</button><button type="button" className="save-action" onClick={downloadJson} disabled={editorMode === "animate"}>Save</button></div>
      <div className="topbar-group view-tools"><button type="button" onClick={() => viewportRef.current?.resetView()} title="Fit character (F)">Fit</button><Toggle label="Bones" active={showBones} onClick={() => setShowBones((value) => !value)} /><button type="button" className={focusMode ? "is-active" : ""} onClick={toggleFocusMode}>{focusMode ? "Exit focus" : "Focus"}</button></div>
      <button type="button" className={`problem-trigger ${validationIssues.length ? "has-errors" : "is-valid"}`} onClick={() => { setUtilityTab("problems"); setUtilityOpen(true); }}><i />{validationIssues.length ? `${validationIssues.length} issues` : "Rig valid"}</button>
      <button type="button" className={`connection-status is-${agentStatus.state}`} title={agentStatus.label} onClick={() => { setUtilityTab("activity"); setUtilityOpen(true); }}><i />{agentStatus.label}</button>
      <ImageProductionStatus projectId={agentSession.activeProjectId?.startsWith("character-") ? agentSession.activeProjectId : null} />
    </header>

    {editorMode === "animate" ? <AnimateWorkspace rig={rig} activeSkinId={effectiveSkinId} showGrid={showGrid} showBones={showBones} showBounds={showBounds} viewportRef={viewportRef} onCursor={setCursor} onZoom={setZoom} onMessage={setMessage} onError={setError} /> : <div className={`editor-body ${leftCollapsed ? "left-collapsed" : ""} ${rightCollapsed ? "right-collapsed" : ""}`}>
      <aside className="editor-left-panel">
        <header className="panel-identity"><span>Setup navigator</span><button type="button" onClick={() => setLeftCollapsed(true)} aria-label="Collapse navigator">‹</button></header>
        <div className="outliner-search"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search bones, slots, equipment" aria-label="Search setup objects" /><button type="button" onClick={() => setSearch("")} disabled={!search}>×</button></div>
        <EditorHierarchy rig={rig} search={search} selections={selections} hiddenBoneIds={hiddenBoneIds} lockedIds={lockedIds} onSelect={select} onToggleBoneVisibility={(id) => toggleSetValue(setHiddenBoneIds, id)} onToggleSlotVisibility={(id) => run("Toggle slot visibility", (current) => { const slot = current.slots.find((item) => item.id === id); return slot ? updateSlot(current, id, { visible: !slot.visible }) : current; })} onToggleLock={(key) => toggleSetValue(setLockedIds, key)} onAdd={addItem} onDuplicate={duplicateItem} onDelete={deleteItem} onMoveSlot={(id, direction) => run("Reorder slot", (current) => moveSlot(current, id, direction))} disabled={previewMode} />
        <button type="button" className="discard-draft" onClick={discardDraft} disabled={previewMode}>Discard local draft</button>
      </aside>

      <section className="editor-center">
        {leftCollapsed && <button type="button" className="restore-panel restore-left" onClick={() => setLeftCollapsed(false)}>Navigator ›</button>}
        {rightCollapsed && <button type="button" className="restore-panel restore-right" onClick={() => setRightCollapsed(false)}>‹ Inspector</button>}
        <div className="viewport-context-row"><div className="selection-breadcrumb"><span>{rigName(rig)}</span><i>›</i><b>{primarySelection ? humanizeTechnicalId(primarySelection.type) : "Character"}</b>{primarySelection && <><i>›</i><strong>{selectionLabel}</strong></>}</div><div className="viewport-toolbar" aria-label="Setup viewport tools"><button type="button" className="is-active">Select</button><button type="button" onClick={() => viewportRef.current?.resetView()}>Fit</button><Toggle label="Grid" active={showGrid} onClick={() => setShowGrid((value) => !value)} /><Toggle label="Grid snap" active={snapToGrid} onClick={() => setSnapToGrid((value) => !value)} /><Toggle label="Pixel" active={wholePixelSnap} onClick={() => setWholePixelSnap((value) => !value)} /><Toggle label="15°" active={rotationSnap} onClick={() => setRotationSnap((value) => !value)} /><Toggle label="Bounds" active={showBounds} onClick={() => setShowBounds((value) => !value)} /></div></div>
        <EditorViewport ref={viewportRef} rig={rig} animation={previewAnimation} previewMode={previewMode} activeSkinId={effectiveSkinId} selections={selections} hiddenBoneIds={hiddenBoneIds} lockedBoneIds={new Set([...lockedIds].filter((key) => key.startsWith("bone:")).map((key) => key.slice(5)))} showGrid={showGrid} showBones={showBones} showBounds={showBounds} snapToGrid={snapToGrid} wholePixelSnap={wholePixelSnap} rotationSnap={rotationSnap} onSelect={select} onCursor={(point) => setCursor(point)} onZoom={setZoom} onBoneDragStart={beginBoneDrag} onBoneDragPreview={() => undefined} onBoneDragCommit={commitBoneDrag} onWarning={setError} />
        {previewMode && <div className="preview-notice">Preview mode. Setup-pose editing is locked.</div>}
      </section>

      <aside className="editor-right-panel">
        <header className="panel-identity"><span>Inspector</span><button type="button" onClick={() => setRightCollapsed(true)} aria-label="Collapse inspector">›</button></header>
        <EditorInspector rig={rig} selection={primarySelection} previewMode={previewMode} locked={selectedLocked} onFrame={() => viewportRef.current?.resetView()} onIsolate={() => { if (primarySelection?.type === "bone") setHiddenBoneIds(new Set(rig.bones.filter((bone) => bone.id !== primarySelection.id).map((bone) => bone.id))); }} onBonePatch={(id, patch, label) => run(label, (current) => updateBone(current, id, patch))} onSlotPatch={(id, patch, label) => run(label, (current) => updateSlot(current, id, patch))} onAttachmentPatch={(id, patch, label) => run(label, (current) => updateAttachment(current, id, patch))} onRenameSkin={(id, name) => run("Rename skin", (current) => renameSkin(current, id, name))} onAssignSkin={(skinId, slotId, attachmentId) => run("Assign skin attachment", (current) => assignSkinAttachment(current, skinId, slotId, attachmentId))} />
      </aside>
    </div>}
    {focusMode && editorMode === "animate" && <div className="focus-playback-controls" aria-label="Focus playback controls"><button type="button" onClick={() => animationCommand("play")}>▶ Play</button><button type="button" onClick={() => animationCommand("pause")}>Ⅱ Pause</button><button type="button" onClick={() => animationCommand("restart")}>↺ Restart</button><button type="button" onClick={() => setFocusMode(false)}>Exit Focus</button></div>}

    <footer className="editor-statusbar">
      <span className="mode-status">{editorMode}</span><span>Zoom {(zoom * 100).toFixed(0)}%</span><span>X {cursor.x.toFixed(1)} Y {cursor.y.toFixed(1)}</span><span>{selectionLabel}</span><button type="button" className={problems.length ? "status-error" : "status-valid"} onClick={() => { setUtilityTab("problems"); setUtilityOpen((value) => !value); }}>{problems.length ? `${problems.length} problems` : "No problems"}</button><button type="button" onClick={() => { setUtilityTab("activity"); setUtilityOpen((value) => !value); }}>Activity {agentActivity.length}</button><span>{dirty ? "Unsaved changes" : "Saved"}</span><span className="next-action">{nextAction}</span><span className="status-message">{agentSession.lastOperation ? `${agentSession.lastOperation} · ` : ""}{error ?? message}</span>
    </footer>
    <StudioUtilityDrawer open={utilityOpen} tab={utilityTab} problems={problems} activity={agentActivity} onTab={setUtilityTab} onClose={() => setUtilityOpen(false)} />
    <StudioCommandPalette commands={commands} mode={editorMode} selection={selectionLabel} open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
    <StudioDialog open={confirmDiscard} title="Discard local rig draft?" description="The bundled test rig will replace the current local setup document. This action intentionally clears the local draft." confirmLabel="Discard draft" danger onCancel={() => setConfirmDiscard(false)} onConfirm={confirmDiscardDraft} />
    <StudioDialog open={pendingDelete !== null} title={pendingDelete ? `Delete ${humanizeTechnicalId(pendingDelete.id)}?` : "Delete object?"} description={pendingDelete?.type === "bone" ? `This bone affects ${pendingDelete.childIds.length} child bone(s) and ${pendingDelete.slotIds.length} slot(s). The repair and deletion will be one undoable command.` : `This ${pendingDelete?.type ?? "object"} will be removed in one undoable command.`} confirmLabel="Delete" danger confirmDisabled={Boolean(pendingDelete?.type === "bone" && (pendingDelete.childIds.length || pendingDelete.slotIds.length) && !deleteReplacementId)} onCancel={() => setPendingDelete(null)} onConfirm={confirmDeleteItem}>
      {pendingDelete?.type === "bone" && (pendingDelete.childIds.length > 0 || pendingDelete.slotIds.length > 0) && <><ul>{pendingDelete.childIds.map((id) => <li key={`bone-${id}`}>Child: {humanizeTechnicalId(id)}</li>)}{pendingDelete.slotIds.map((id) => <li key={`slot-${id}`}>Slot: {humanizeTechnicalId(id)}</li>)}</ul><label>Move dependents to<select value={deleteReplacementId} onChange={(event) => setDeleteReplacementId(event.target.value)}>{pendingDelete.replacementChoices.map((id) => <option key={id} value={id}>{humanizeTechnicalId(id)}</option>)}</select></label></>}
    </StudioDialog>
  </main>;
}

function Toggle({ label, active, onClick }: { readonly label: string; readonly active: boolean; readonly onClick: () => void }) {
  return <button type="button" className={active ? "is-active" : ""} aria-pressed={active} onClick={onClick}>{label}</button>;
}
