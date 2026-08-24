"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { sampleTrack } from "@/src/rigging/animation/evaluate";
import { applyAnimationProposal } from "@/src/rigging/ai/animationProposalApplier";
import type { AnimationGenerationMode, LeftRightMapping } from "@/src/rigging/ai/animationContextBuilder";
import type { AnimationProposal } from "@/src/rigging/ai/animationProposalSchema";
import { issueSeekTime, visualReviewToTimelineMarkers, type TimelineIssueMarker } from "@/src/rigging/ai-vision/visualReviewDiff";
import type { VisualReview } from "@/src/rigging/ai-vision/visualReviewSchema";
import type { AnimatedProperty, AnimationDefinition, Keyframe, RigDefinition } from "@/src/rigging/schema/types";
import { ANIMATED_PROPERTIES } from "@/src/rigging/schema/types";
import type { Point } from "@/src/rigging/math/matrix";
import { applyViewportEdit } from "@/src/tools/rig-editor/animation/autokey";
import { discardAnimationDraft, loadAnimationDraft, saveAnimationDraft } from "@/src/tools/rig-editor/animation/draft";
import { AnimationCommandHistory } from "@/src/tools/rig-editor/animation/history";
import { addAnimation, animationById, createAnimationLibrary, deleteAnimation, duplicateAnimation, parseAnimationLibraryJson, replaceAnimation, serializeAnimationLibrary, uniqueAnimationId } from "@/src/tools/rig-editor/animation/library";
import {
  adjacentKeyTimes, applyBonePatch, copyKeyframes, matchFirstPoseAtEnd, mirrorPose, moveKeyframes, pasteKeyframes,
  removeKeyframes, removeRedundantKeys, reverseAnimation, scaleAnimationTiming, setAnimationDuration, updateKeyframe,
} from "@/src/tools/rig-editor/animation/operations";
import type { AnimationBonePatch, AnimationLibrary, DurationPolicy, KeyframeClipboard, KeyframeSelection } from "@/src/tools/rig-editor/animation/types";
import { SAMPLE_ANIMATION_PATHS } from "@/src/tools/rig-editor/animation/samplePaths";
import type { BoneAuthoringPatch, EditorSelection } from "@/src/tools/rig-editor/types";
import { AnimationInspector } from "./AnimationInspector";
import { AIAnimationPanel } from "./AIAnimationPanel";
import { DopeSheet, type DopeSheetHandle } from "./DopeSheet";
import { EditorViewport, type EditorViewportHandle } from "./EditorViewport";
import { VisualReviewPanel } from "./VisualReviewPanel";
import { humanizeTechnicalId, semanticGroup } from "@/app/studio-ui/humanize";
import { getRiggingCommandService } from "@/src/agent-control";
import { StudioDialog } from "@/app/studio-ui/StudioDialog";

const editableTarget = (target: EventTarget | null): boolean => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
type AnimationHistoryUi = { readonly canUndo: boolean; readonly canRedo: boolean; readonly undoLabel: string | null; readonly redoLabel: string | null };
const timelineBounds = (): { min: number; max: number; compact: boolean } => {
  const compact = typeof window !== "undefined" && window.innerWidth <= 900;
  const min = compact ? 120 : 160;
  const viewportMax = typeof window === "undefined" ? 440 : Math.floor(window.innerHeight * .44);
  return { min, max: Math.max(min, Math.min(440, viewportMax)), compact };
};
const clampTimelineHeight = (height: number): number => { const { min, max } = timelineBounds(); return Math.max(min, Math.min(max, height)); };
const readAnimationHistoryUi = (history: AnimationCommandHistory): AnimationHistoryUi => ({ canUndo: history.canUndo, canRedo: history.canRedo, undoLabel: history.getUndoLabel(), redoLabel: history.getRedoLabel() });
const animationValue = (animation: AnimationDefinition, rig: RigDefinition, boneId: string, property: AnimatedProperty, time: number): number => {
  const track = animation.tracks.find((candidate) => candidate.boneId === boneId && candidate.property === property);
  const bone = rig.bones.find((candidate) => candidate.id === boneId);
  return track ? sampleTrack(track, time) : bone?.[property] ?? (property.startsWith("scale") ? 1 : 0);
};

type Props = {
  readonly rig: RigDefinition;
  readonly activeSkinId: string;
  readonly showGrid: boolean;
  readonly showBones: boolean;
  readonly showBounds: boolean;
  readonly viewportRef: React.RefObject<EditorViewportHandle | null>;
  readonly onCursor: (point: Point) => void;
  readonly onZoom: (zoom: number) => void;
  readonly onMessage: (message: string) => void;
  readonly onError: (message: string | null) => void;
};

export function AnimateWorkspace({ rig, activeSkinId, showGrid, showBones, showBounds, viewportRef, onCursor, onZoom, onMessage, onError }: Props) {
  const commandService = useMemo(() => getRiggingCommandService(), []);
  const [library, setLibrary] = useState<AnimationLibrary>(() => createAnimationLibrary(rig.id, [{ schemaVersion: 1, id: "loading", name: "Loading", duration: 1, loop: true, tracks: [] }]));
  const [activeId, setActiveId] = useState("loading");
  const [selectedBones, setSelectedBones] = useState<string[]>([rig.rootBoneId]);
  const [selectedKeys, setSelectedKeys] = useState<KeyframeSelection[]>([]);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [fps, setFps] = useState(24);
  const [showFrames, setShowFrames] = useState(false);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(120);
  const [snap, setSnap] = useState(true);
  const [durationPolicy, setDurationPolicy] = useState<DurationPolicy>("clamp");
  const [autoKey, setAutoKey] = useState(true);
  const [onionPrevious, setOnionPrevious] = useState(false);
  const [onionNext, setOnionNext] = useState(false);
  const [pendingEdit, setPendingEdit] = useState<{ boneId: string; patch: AnimationBonePatch } | null>(null);
  const [search, setSearch] = useState("");
  const [dirty, setDirty] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"key" | "ai" | "vision">("key");
  const [aiPreview, setAiPreview] = useState<AnimationDefinition | null>(null);
  const [visualIssueMarkers, setVisualIssueMarkers] = useState<readonly TimelineIssueMarker[]>([]);
  const [mirrorPairs, setMirrorPairs] = useState<readonly (readonly [string, string])[]>(() => rig.bones
    .flatMap((bone) => bone.id.includes("left") ? [[bone.id, bone.id.replace("left", "right")] as const] : [])
    .filter(([, right]) => rig.bones.some((bone) => bone.id === right)));
  const [mirrorEditorOpen, setMirrorEditorOpen] = useState(false);
  const [mirrorSource, setMirrorSource] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteAnimationId, setDeleteAnimationId] = useState<string | null>(null);
  const [timingOpen, setTimingOpen] = useState(false);
  const [timingFactor, setTimingFactor] = useState("1.25");
  const [timelineHeight, setTimelineHeight] = useState(220);
  const [compactBonesOpen, setCompactBonesOpen] = useState(false);
  const [historyUi, setHistoryUi] = useState<AnimationHistoryUi>({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
  const historyRef = useRef<AnimationCommandHistory | null>(null);
  const timelineRef = useRef<DopeSheetHandle>(null);
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const clipboardRef = useRef<KeyframeClipboard | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const timeOutputRef = useRef<HTMLOutputElement>(null);
  const timelineInitializedRef = useRef(false);

  useEffect(() => { const timer = window.setTimeout(() => { const compact = window.innerWidth <= 900; const key = compact ? "rigging-studio-timeline-height-compact" : "rigging-studio-timeline-height"; const stored = Number(window.localStorage.getItem(key)); timelineInitializedRef.current = true; setTimelineHeight(clampTimelineHeight(Number.isFinite(stored) && stored >= 120 ? stored : compact ? 132 : 220)); }, 0); const resize = (): void => setTimelineHeight((current) => clampTimelineHeight(current)); window.addEventListener("resize", resize); return () => { window.clearTimeout(timer); window.removeEventListener("resize", resize); }; }, []);
  useEffect(() => { if (!timelineInitializedRef.current) return; const key = window.innerWidth <= 900 ? "rigging-studio-timeline-height-compact" : "rigging-studio-timeline-height"; window.localStorage.setItem(key, String(timelineHeight)); }, [timelineHeight]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const responses = await Promise.all(SAMPLE_ANIMATION_PATHS.map((path) => fetch(path)));
        const inputs = await Promise.all(responses.map((response) => response.json() as Promise<unknown>));
        const valid = inputs.flatMap((input) => {
          const result = parseAnimationLibraryJson(JSON.stringify(input), rig);
          return result.success ? [...result.data.animations] : [];
        });
        if (!valid.length) throw new Error("No sample animations passed validation");
        let initial = createAnimationLibrary(rig.id, valid);
        let restoredFromDisk = false;
        try {
          const durable = commandService.getDurableSnapshot();
          if (durable.localProjectId && durable.rig?.id === rig.id && durable.animations) { initial = durable.animations; restoredFromDisk = true; }
        } catch { /* no disk-backed project is active */ }
        const draft = restoredFromDisk ? null : loadAnimationDraft(window.localStorage, rig);
        if (draft?.success) initial = draft.data;
        if (cancelled) return;
        historyRef.current = new AnimationCommandHistory(initial);
        setLibrary(historyRef.current.present); setActiveId(initial.animations[0].id); setTime(0); timeRef.current = 0;
        setHistoryUi(readAnimationHistoryUi(historyRef.current));
        onMessage(restoredFromDisk ? "Disk animations restored" : draft?.success ? "Animation draft restored" : "Animation workspace ready");
      } catch (reason: unknown) { onError(reason instanceof Error ? reason.message : "Animations could not be loaded"); }
    })();
    return () => { cancelled = true; };
  }, [commandService, onError, onMessage, rig]);

  useEffect(() => {
    if (library.animations[0]?.id === "loading") return;
    const timer = window.setTimeout(() => saveAnimationDraft(window.localStorage, library), 400);
    return () => window.clearTimeout(timer);
  }, [library]);

  const animation = animationById(library, activeId) ?? library.animations[0];
  const viewportAnimation = aiPreview ?? animation;

  useEffect(() => {
    commandService.syncBoneSelectionFromUi(selectedBones.at(-1) ?? null);
  }, [commandService, selectedBones]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const boneIds = new Set(rig.bones.map((bone) => bone.id));
      setSelectedBones((current) => {
        const valid = current.filter((id) => boneIds.has(id));
        return valid.length ? valid : [rig.rootBoneId];
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [rig]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const existing = new Set(library.animations.map((candidate) => candidate.id));
      if (!existing.has(activeId)) {
        const fallback = library.animations[0]?.id ?? "";
        setActiveId(fallback); commandService.syncAnimationSelectionFromUi(fallback || null); setSelectedKeys([]);
        return;
      }
      const active = animationById(library, activeId);
      setSelectedKeys((current) => current.filter((selection) => active?.tracks.some((track) => track.boneId === selection.boneId && track.property === selection.property && track.keyframes.some((frame) => frame.time === selection.time))));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeId, commandService, library]);
  const selectionSet = useMemo(() => new Set(selectedBones), [selectedBones]);
  const setCurrentTime = useCallback((next: number): void => {
    const value = Math.max(0, Math.min(animation.duration, next));
    timeRef.current = value; setTime(value); timelineRef.current?.setPlayhead(value); viewportRef.current?.seekAnimation(value);
    if (timeOutputRef.current) timeOutputRef.current.value = `${value.toFixed(3)}s`;
  }, [animation.duration, viewportRef]);

  const sync = useCallback((next: AnimationLibrary, message: string): void => {
    setLibrary(next); setDirty(true); setVisualIssueMarkers([]); if (historyRef.current) setHistoryUi(readAnimationHistoryUi(historyRef.current)); onError(null); onMessage(message);
  }, [onError, onMessage]);
  const run = useCallback((label: string, transform: (current: AnimationLibrary) => AnimationLibrary): void => {
    const history = historyRef.current; if (!history) return;
    try { commandService.executeHumanAnimationMutation(label, transform); }
    catch (reason: unknown) { onError(reason instanceof Error ? reason.message : `${label} failed`); }
  }, [commandService, onError]);
  const updateActive = useCallback((label: string, transform: (current: AnimationDefinition) => AnimationDefinition): void =>
    run(label, (current) => { const active = animationById(current, activeId); return active ? replaceAnimation(current, transform(active)) : current; }), [activeId, run]);

  const chooseAnimation = useCallback((id: string): void => { setPlaying(false); playingRef.current = false; setAiPreview(null); setVisualIssueMarkers([]); setActiveId(id); commandService.syncAnimationSelectionFromUi(id); setSelectedKeys([]); setCurrentTime(0); }, [commandService, setCurrentTime]);
  const play = useCallback((): void => { setPlaying(true); playingRef.current = true; viewportRef.current?.playAnimation(); }, [viewportRef]);
  const pause = useCallback((): void => { setPlaying(false); playingRef.current = false; viewportRef.current?.pauseAnimation(); }, [viewportRef]);
  const stop = useCallback((): void => { pause(); setCurrentTime(0); }, [pause, setCurrentTime]);
  const onRuntimeTime = useCallback((current: number, isPlaying: boolean): void => {
    timeRef.current = current; timelineRef.current?.setPlayhead(current);
    if (timeOutputRef.current) timeOutputRef.current.value = `${current.toFixed(3)}s`;
    if (playingRef.current && !isPlaying) { playingRef.current = false; setPlaying(false); setTime(current); }
  }, []);

  useEffect(() => {
    if (!historyRef.current || animation.id === "loading") return;
    return commandService.attachAnimationEditor({
      getLibrary: () => historyRef.current?.present ?? library,
      getActiveAnimationId: () => activeId,
      replace: (next) => {
        const history = new AnimationCommandHistory(next); historyRef.current = history; setLibrary(next); setDirty(false); setVisualIssueMarkers([]); setSelectedKeys([]); setActiveId(next.animations[0]?.id ?? ""); setHistoryUi(readAnimationHistoryUi(history)); onError(null); onMessage("Opened disk animations"); return next;
      },
      execute: (label, transform) => {
        const history = historyRef.current; if (!history) throw new Error("Animation history is unavailable");
        const next = history.execute(label, transform); sync(next, label); return next;
      },
      setActiveAnimation: chooseAnimation,
      setPlayback: (action, seekTime) => {
        if (action === "play") play(); else if (action === "pause") pause(); else if (action === "stop") stop(); else setCurrentTime(seekTime ?? 0);
      },
    });
  }, [activeId, animation.id, chooseAnimation, commandService, library, onError, onMessage, pause, play, setCurrentTime, stop, sync]);

  const addKeys = useCallback((): void => {
    if (!selectedBones.length) return;
    updateActive("Add keyframe", (current) => selectedBones.reduce((next, boneId) => applyBonePatch(next, boneId, timeRef.current, Object.fromEntries(ANIMATED_PROPERTIES.map((property) => [property, animationValue(current, rig, boneId, property, timeRef.current)]))), current));
  }, [rig, selectedBones, updateActive]);
  const deleteKeys = useCallback((): void => { if (selectedKeys.length) { updateActive("Delete keyframes", (current) => removeKeyframes(current, selectedKeys)); setSelectedKeys([]); } }, [selectedKeys, updateActive]);
  const moveSelected = (delta: number): void => updateActive("Move keyframes", (current) => {
    const result = moveKeyframes(current, selectedKeys, delta, durationPolicy, snap ? 1 / fps : undefined); setSelectedKeys([...result.selections]); return result.animation;
  });
  const previousNext = (direction: "previous" | "next"): void => { const adjacent = adjacentKeyTimes(animation, timeRef.current); setCurrentTime(adjacent[direction] ?? (direction === "previous" ? 0 : animation.duration)); };
  const copy = useCallback((): void => { clipboardRef.current = copyKeyframes(animation, selectedKeys); onMessage(`Copied ${clipboardRef.current.keyframes.length} keyframe(s)`); }, [animation, onMessage, selectedKeys]);
  const paste = useCallback((): void => {
    const clipboard = clipboardRef.current; if (!clipboard?.keyframes.length) return;
    updateActive("Paste keyframes", (current) => { const result = pasteKeyframes(current, clipboard, timeRef.current, durationPolicy); setSelectedKeys([...result.selections]); return result.animation; });
  }, [durationPolicy, updateActive]);
  const duplicate = useCallback((): void => { copy(); const step = 1 / fps; const clipboard = clipboardRef.current; if (!clipboard) return; updateActive("Duplicate keyframes", (current) => { const result = pasteKeyframes(current, clipboard, Math.min(current.duration, timeRef.current + step), durationPolicy); setSelectedKeys([...result.selections]); return result.animation; }); }, [copy, durationPolicy, fps, updateActive]);

  const commitViewportEdit = (boneId: string, patch: BoneAuthoringPatch): void => {
    const result = applyViewportEdit(animation, boneId, timeRef.current, patch, autoKey);
    if (!result.created) { setPendingEdit({ boneId, patch }); onMessage("Pose changed in preview. Create a keyframe to keep it"); return; }
    updateActive("Auto-key viewport transform", () => result.animation); setPendingEdit(null);
  };
  const commitPending = (): void => { if (!pendingEdit) return; updateActive("Create viewport keyframe", (current) => applyBonePatch(current, pendingEdit.boneId, timeRef.current, pendingEdit.patch)); setPendingEdit(null); };

  const changeKey = (selection: KeyframeSelection, patch: Partial<Keyframe>): void => {
    updateActive("Edit keyframe", (current) => updateKeyframe(current, selection, patch));
    if (patch.time !== undefined) setSelectedKeys([{ ...selection, time: Math.max(0, Math.min(animation.duration, patch.time)) }]);
  };

  const importAnimations = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    const parsed = parseAnimationLibraryJson(await file.text(), rig);
    if (!parsed.success) { onError(parsed.message); return; }
    const history = historyRef.current; if (!history) return;
    const next = history.reset(parsed.data); setLibrary(next); setHistoryUi(readAnimationHistoryUi(history)); setActiveId(next.animations[0].id); setDirty(false); setSelectedKeys([]); setCurrentTime(0); onMessage(`Loaded ${file.name}`);
  };
  const exportAnimations = useCallback((): void => {
    const blob = new Blob([`${serializeAnimationLibrary(library)}\n`], { type: "application/json" }); const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${rig.id}.animations.json`; anchor.click(); URL.revokeObjectURL(url); setDirty(false); onMessage("Animation library downloaded");
  }, [library, onMessage, rig.id]);
  useEffect(() => {
    const listener = (event: Event): void => { const action = (event as CustomEvent<string>).detail; if (action === "play") play(); else if (action === "pause") pause(); else if (action === "restart") { setCurrentTime(0); play(); } else if (action === "save") exportAnimations(); else if (action === "ai") setInspectorTab("ai"); else if (action === "review") setInspectorTab("vision"); };
    window.addEventListener("rig-studio:animation-command", listener); return () => window.removeEventListener("rig-studio:animation-command", listener);
  }, [exportAnimations, pause, play, setCurrentTime]);
  const undo = useCallback((): void => { const history = historyRef.current; if (!history?.canUndo) return; sync(history.undo(), "Undid animation change"); }, [sync]);
  const redo = useCallback((): void => { const history = historyRef.current; if (!history?.canRedo) return; sync(history.redo(), "Redid animation change"); }, [sync]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent): void => {
      if (editableTarget(event.target)) return;
      const modifier = event.metaKey || event.ctrlKey; const key = event.key.toLowerCase();
      if (modifier && key === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if (modifier && key === "s") { event.preventDefault(); exportAnimations(); return; }
      if (modifier && key === "o") { event.preventDefault(); importRef.current?.click(); return; }
      if (modifier && key === "c") { event.preventDefault(); copy(); return; }
      if (modifier && key === "v") { event.preventDefault(); paste(); return; }
      if (modifier && key === "d") { event.preventDefault(); duplicate(); return; }
      if (event.code === "Space") { event.preventDefault(); if (playingRef.current) pause(); else play(); return; }
      if (key === "k") { event.preventDefault(); addKeys(); return; }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedKeys.length) { event.preventDefault(); deleteKeys(); return; }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setCurrentTime(timeRef.current + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1) / fps); return; }
      if (event.key === "Home") { event.preventDefault(); setCurrentTime(0); }
      if (event.key === "End") { event.preventDefault(); setCurrentTime(animation.duration); }
    };
    window.addEventListener("keydown", keyDown); return () => window.removeEventListener("keydown", keyDown);
    // The transport callbacks intentionally read current refs; re-registering on every render is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addKeys, animation.duration, copy, deleteKeys, duplicate, fps, paste, redo, setCurrentTime, selectedKeys.length, undo]);

  const filteredBones = rig.bones.filter((bone) => bone.id.toLowerCase().includes(search.toLowerCase()));
  const applyMirrorPairs = (): void => {
    const source = mirrorSource;
    const next = source.split(/\n|,/).map((line) => line.trim()).filter(Boolean).map((line) => line.split(":").map((id) => id.trim())).filter((pair): pair is [string, string] => pair.length === 2 && pair.every((id) => rig.bones.some((bone) => bone.id === id)));
    if (!next.length) { onError("Mirror mapping needs at least one valid left:right bone pair"); return; }
    setMirrorPairs(next); setMirrorEditorOpen(false); onMessage(`Configured ${next.length} mirror pair(s)`);
  };
  const confirmRename = (): void => { const name = renameValue.trim(); if (!name) return; updateActive("Rename animation", (current) => ({ ...current, name })); setRenameOpen(false); };
  const confirmDeleteAnimation = (): void => {
    if (!deleteAnimationId || library.animations.length <= 1) return;
    const nextId = library.animations.find((item) => item.id !== deleteAnimationId)?.id;
    run("Delete animation", (current) => deleteAnimation(current, deleteAnimationId));
    if (nextId) setActiveId(nextId); setDeleteAnimationId(null);
  };
  const confirmTimingScale = (): void => { const factor = Number(timingFactor); if (!Number.isFinite(factor) || factor <= 0) { onError("Timing scale must be a positive number"); return; } updateActive("Scale animation timing", (current) => scaleAnimationTiming(current, factor)); setTimingOpen(false); };
  const aiMappings: readonly LeftRightMapping[] = mirrorPairs.map(([left, right]) => ({ left, right }));
  const acceptAiProposal = (proposal: AnimationProposal, mode: AnimationGenerationMode, selectedTrackKeys?: readonly string[]): void => {
    pause();
    let acceptedId = activeId;
    run("Accept AI animation proposal", (current) => {
      const result = applyAnimationProposal(current, proposal, {
        mode,
        currentAnimationId: activeId,
        selectedBoneIds: selectedBones,
        selectedTrackKeys,
        uniqueId: (desired) => uniqueAnimationId(current, desired),
      });
      acceptedId = result.animationId;
      return result.document;
    });
    setActiveId(acceptedId); setAiPreview(null); setSelectedKeys([]); setCurrentTime(0); onMessage("AI proposal accepted as one undoable command");
  };
  const beginTimelineResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault(); const startY = event.clientY; const startHeight = timelineHeight;
    const move = (pointerEvent: PointerEvent): void => setTimelineHeight(clampTimelineHeight(startHeight + startY - pointerEvent.clientY));
    const stop = (): void => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop, { once: true });
  };
  const toggleTimelineHeight = (): void => setTimelineHeight((current) => { const bounds = timelineBounds(); return bounds.compact ? current <= 150 ? Math.min(bounds.max, 300) : 132 : current <= 220 ? Math.min(bounds.max, 360) : 220; });

  return <><div className="animate-workspace">
    <input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(event) => void importAnimations(event)} />
    <div className="animation-toolbar"><div className="animation-command-row">
        <label className="animation-picker">Animation<select value={animation.id} onChange={(event) => chooseAnimation(event.target.value)}>{library.animations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button type="button" className="new-animation-action" data-ux-role="secondary-action" onClick={() => { const result = addAnimation(library); run("New animation", () => result.library); setActiveId(result.animationId); }}>+ New</button>
        <details className="animation-manage" data-dismissible-menu><summary>Manage⌄</summary><div><button type="button" onClick={() => { const result = duplicateAnimation(library, animation.id); run("Duplicate animation", () => result.library); setActiveId(result.animationId); }}>Duplicate</button><button type="button" onClick={() => { setRenameValue(animation.name); setRenameOpen(true); }}>Rename</button><button type="button" disabled={library.animations.length <= 1} onClick={() => setDeleteAnimationId(animation.id)}>Delete</button><label>Duration<input type="number" min={.01} step={.1} value={animation.duration} onChange={(event) => { const duration = Math.max(.01, Number(event.target.value)); updateActive("Change duration", (current) => setAnimationDuration(current, duration)); }} /></label><label><input type="checkbox" checked={animation.loop} onChange={(event) => updateActive("Toggle loop", (current) => ({ ...current, loop: event.target.checked }))} /> Loop</label><button type="button" onClick={() => importRef.current?.click()}>Load library</button><button type="button" onClick={exportAnimations}>Save library</button></div></details>
        <span className="toolbar-spacer" />
        <button type="button" className={`compact-track-toggle ${compactBonesOpen ? "is-active" : ""}`} data-ux-role="navigation" aria-expanded={compactBonesOpen} aria-controls="animate-track-browser" onClick={() => setCompactBonesOpen((value) => !value)}>Tracks</button>
        <button type="button" className="transport-icon" onClick={undo} disabled={!historyUi.canUndo} title={historyUi.undoLabel ?? "Nothing to undo"} aria-label="Undo animation change">↶</button><button type="button" className="transport-icon" onClick={redo} disabled={!historyUi.canRedo} title={historyUi.redoLabel ?? "Nothing to redo"} aria-label="Redo animation change">↷</button>
        <button type="button" className="play-action" data-ux-role="tool" onClick={playing ? pause : play}>{playing ? "Ⅱ Pause" : "▶ Play"}</button>
        <button type="button" className="add-key-action" data-ux-role="secondary-action" onClick={addKeys}>◆ Key</button>
        <output ref={timeOutputRef} className="transport-time">{time.toFixed(3)}s</output>
        <Toggle label="Auto" active={autoKey} onClick={() => setAutoKey((value) => !value)} />
        {pendingEdit && <button type="button" className="create-key-action" onClick={commitPending}>Create keyframe</button>}
        <label className="speed-control" title="Playback speed"><select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>{[.25,.5,1,1.5,2].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
        <details className="animation-ghosts" data-dismissible-menu><summary data-ux-role="tool">More⌄</summary><div><button type="button" onClick={stop}>Stop</button><button type="button" onClick={() => { setCurrentTime(0); play(); }}>Restart</button><button type="button" onClick={() => previousNext("previous")}>Previous keyframe</button><button type="button" onClick={() => previousNext("next")}>Next keyframe</button><Toggle label="Previous ghost" active={onionPrevious} onClick={() => setOnionPrevious((value) => !value)} /><Toggle label="Next ghost" active={onionNext} onClick={() => setOnionNext((value) => !value)} /><button type="button" onClick={deleteKeys} disabled={!selectedKeys.length}>Delete selected keys</button></div></details>
      </div></div>
    <div className={`animate-main ${inspectorTab !== "key" ? "has-ai-panel" : ""} ${inspectorTab === "key" && selectedKeys.length === 0 ? "animate-context-idle" : ""}`}>
      <aside id="animate-track-browser" className={`animate-bones ${compactBonesOpen ? "is-compact-open" : ""}`}>
        <header className="animation-library-heading"><span>Animations</span><button type="button" onClick={() => { const result = addAnimation(library); run("New animation", () => result.library); setActiveId(result.animationId); }} aria-label="New animation">+</button></header>
        <div className="animation-library-list">{library.animations.map((item) => <button type="button" key={item.id} className={item.id === animation.id ? "is-active" : ""} onClick={() => chooseAnimation(item.id)}><i /><span>{item.name}</span><small>{item.duration.toFixed(1)}s</small></button>)}</div>
        <details className="animation-tracks" open><summary>Animated body <small>{selectedBones.length}</small></summary><div className="outliner-search"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find body part" /><button type="button" onClick={() => setSearch("")}>×</button></div><div className="animate-bone-list">{filteredBones.map((bone) => <button type="button" key={bone.id} data-group={semanticGroup(bone.id)} title={bone.id} className={selectionSet.has(bone.id) ? "selected" : ""} style={{ paddingLeft: bone.parentId ? 24 : 10 }} onClick={(event) => setSelectedBones((current) => event.shiftKey ? current.includes(bone.id) ? current.filter((id) => id !== bone.id) : [...current, bone.id] : [bone.id])}><span className="tree-joint" />{humanizeTechnicalId(bone.id)}</button>)}</div></details>
        <details className="timeline-settings"><summary>Timeline settings</summary><div><label>FPS<input type="number" min={1} max={120} value={fps} onChange={(event) => setFps(Math.max(1, Number(event.target.value)))} /></label><Toggle label="Frames" active={showFrames} onClick={() => setShowFrames((value) => !value)} /><Toggle label="Snap" active={snap} onClick={() => setSnap((value) => !value)} /><label>Overflow<select value={durationPolicy} onChange={(event) => setDurationPolicy(event.target.value as DurationPolicy)}><option value="clamp">Clamp</option><option value="expand">Expand duration</option></select></label><label>Timeline zoom<input type="range" min={45} max={360} value={pixelsPerSecond} onChange={(event) => setPixelsPerSecond(Number(event.target.value))} /></label></div></details>
        <details className="utility-stack"><summary>Advanced utilities</summary><div>
          <button type="button" onClick={() => updateActive("Match first pose at end", matchFirstPoseAtEnd)}>Match first pose at end</button>
          <button type="button" onClick={() => updateActive("Remove redundant keys", (current) => removeRedundantKeys(current))}>Remove redundant keys</button>
          <button type="button" onClick={() => updateActive("Mirror pose", (current) => mirrorPose(current, rig, timeRef.current, mirrorPairs))}>Mirror pose L/R</button>
          <button type="button" onClick={() => { setMirrorSource(mirrorPairs.map(([left, right]) => `${left}:${right}`).join("\n")); setMirrorEditorOpen(true); }}>Configure mirror pairs…</button>
          <button type="button" onClick={() => updateActive("Reverse animation", reverseAnimation)}>Reverse animation</button>
          <button type="button" onClick={() => { setTimingFactor("1.25"); setTimingOpen(true); }}>Scale timing…</button>
          <button type="button" onClick={() => { discardAnimationDraft(window.localStorage, rig.id); onMessage("Local animation draft discarded"); }}>Discard animation draft</button>
        </div></details>
      </aside>
      <section className="animate-center" style={{ "--timeline-height": `${timelineHeight}px` } as CSSProperties}>
        <div className="animate-viewport-wrap">
          <EditorViewport ref={viewportRef} rig={rig} animation={viewportAnimation} previewMode={false} authoringMode animationTime={time} animationPlaying={playing} playbackSpeed={speed} showPreviousGhost={onionPrevious} showNextGhost={onionNext} activeSkinId={activeSkinId} selections={selectedBones.map((id) => ({ type: "bone", id }) as EditorSelection)} hiddenBoneIds={new Set()} lockedBoneIds={aiPreview ? new Set(rig.bones.map((bone) => bone.id)) : new Set()} showGrid={showGrid} showBones={showBones} showBounds={showBounds} snapToGrid={false} wholePixelSnap rotationSnap onSelect={(selection, additive) => { if (selection?.type !== "bone") return; setSelectedBones((current) => additive ? current.includes(selection.id) ? current.filter((id) => id !== selection.id) : [...current, selection.id] : [selection.id]); }} onCursor={onCursor} onZoom={onZoom} onBoneDragStart={() => setPendingEdit(null)} onBoneDragPreview={() => undefined} onBoneDragCommit={commitViewportEdit} onAnimationTime={onRuntimeTime} onWarning={(message) => onError(message)} />
          {aiPreview && <div className="ai-preview-notice">AI PROPOSAL PREVIEW · source document unchanged</div>}
          <div className="onion-indicator">{onionPrevious ? "PREV GHOST " : ""}{onionNext ? "NEXT GHOST" : ""}</div>
        </div>
        <div className="timeline-toolbar"><button type="button" className="timeline-resize-handle" onPointerDown={beginTimelineResize} onDoubleClick={toggleTimelineHeight} aria-label="Resize timeline" title="Drag to resize · double-click to toggle compact timeline" /><strong>Timeline</strong><span>{animation.tracks.length} tracks</span><span>{animation.tracks.reduce((count, track) => count + track.keyframes.length, 0)} keys</span><span>{dirty ? "Draft modified" : "Browser cache current"}</span></div>
        <DopeSheet ref={timelineRef} rig={rig} animation={animation} time={time} pixelsPerSecond={pixelsPerSecond} fps={fps} showFrames={showFrames} snap={snap} selections={selectedKeys} selectedBoneIds={selectionSet} issueMarkers={visualIssueMarkers} onIssueSelect={(marker) => { pause(); setCurrentTime((marker.start + marker.end) / 2); if (marker.affectedBones.length) setSelectedBones([...marker.affectedBones]); setInspectorTab("vision"); }} onTime={(value) => { pause(); setCurrentTime(value); }} onSelect={(items) => { setSelectedKeys([...items]); const boneId = items.at(-1)?.boneId; if (boneId) setSelectedBones([boneId]); }} onMoveSelected={moveSelected} onSelectBone={(boneId) => setSelectedBones([boneId])} />
      </section>
      <aside className={`editor-right-panel animate-inspector ${inspectorTab === "key" && selectedKeys.length === 0 ? "is-context-idle" : ""}`}>
        <div className="inspector-mode-tabs"><button type="button" className={inspectorTab === "key" ? "is-active" : ""} data-tab="key" onClick={() => setInspectorTab("key")}>Key</button><button type="button" className={inspectorTab === "ai" ? "is-active" : ""} data-tab="ai" onClick={() => setInspectorTab("ai")}>AI Animate</button><button type="button" className={inspectorTab === "vision" ? "is-active" : ""} data-tab="vision" onClick={() => setInspectorTab("vision")}>Visual Review</button></div>
        <div className="inspector-tab-content" hidden={inspectorTab !== "key"}><AnimationInspector animation={animation} selections={selectedKeys} onChange={changeKey} /></div>
        <div className="inspector-tab-content" hidden={inspectorTab !== "ai"}><AIAnimationPanel key={`ai-${animation.id}`} rig={rig} currentAnimation={animation} referenceAnimations={library.animations} selectedBoneIds={selectedBones} leftRightMappings={aiMappings} onPreview={(next) => { pause(); setAiPreview(next); setCurrentTime(0); }} onAccept={acceptAiProposal} onMessage={onMessage} /></div>
        <div className="inspector-tab-content" hidden={inspectorTab !== "vision"}><VisualReviewPanel key={`review-${animation.id}`} rig={rig} currentAnimation={animation} onPreview={(next) => { pause(); setAiPreview(next); }} onAccept={(proposal) => acceptAiProposal(proposal, "revise")} onIssues={(review: VisualReview | null) => setVisualIssueMarkers(review ? visualReviewToTimelineMarkers(review) : [])} onIssueSelect={(issue) => { pause(); setCurrentTime(issueSeekTime(issue)); if (issue.affectedBones.length) setSelectedBones([...issue.affectedBones]); }} onMessage={onMessage} /></div>
      </aside>
    </div>
  </div>
    <StudioDialog open={renameOpen} title="Rename animation" description="The animation ID stays stable; only its visible name changes." confirmLabel="Rename" confirmDisabled={!renameValue.trim()} onCancel={() => setRenameOpen(false)} onConfirm={confirmRename}><label>Animation name<input value={renameValue} autoFocus onChange={(event) => setRenameValue(event.target.value)} /></label></StudioDialog>
    <StudioDialog open={deleteAnimationId !== null} title={`Delete ${library.animations.find((item) => item.id === deleteAnimationId)?.name ?? "animation"}?`} description="This removes the animation as one undoable library command." confirmLabel="Delete animation" danger onCancel={() => setDeleteAnimationId(null)} onConfirm={confirmDeleteAnimation} />
    <StudioDialog open={mirrorEditorOpen} title="Configure mirror pairs" description="Enter one valid left:right bone pair per line. Invalid or missing bone IDs are rejected." confirmLabel="Save pairs" confirmDisabled={!mirrorSource.trim()} onCancel={() => setMirrorEditorOpen(false)} onConfirm={applyMirrorPairs}><label>Bone mappings<textarea rows={7} value={mirrorSource} onChange={(event) => setMirrorSource(event.target.value)} /></label></StudioDialog>
    <StudioDialog open={timingOpen} title="Scale animation timing" description="Values above 1 make the animation longer; values below 1 make it shorter." confirmLabel="Scale timing" confirmDisabled={!Number.isFinite(Number(timingFactor)) || Number(timingFactor) <= 0} onCancel={() => setTimingOpen(false)} onConfirm={confirmTimingScale}><label>Scale factor<input type="number" min="0.01" step="0.05" value={timingFactor} onChange={(event) => setTimingFactor(event.target.value)} /></label></StudioDialog>
  </>;
}

function Toggle({ label, active, onClick }: { readonly label: string; readonly active: boolean; readonly onClick: () => void }) {
  return <button type="button" className={active ? "is-active" : ""} aria-pressed={active} onClick={onClick}>{label}</button>;
}
