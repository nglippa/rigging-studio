"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Application, Container, Graphics } from "pixi.js";
import { AnimationPlayer } from "@/src/rigging/animation/AnimationPlayer";
import { evaluateAnimationAtTime } from "@/src/rigging/animation/evaluate";
import { degreesToRadians, radiansToDegrees } from "@/src/rigging/math/rotation";
import { invertMatrix, matrixFromTransform, multiplyMatrices, transformPoint, type Point } from "@/src/rigging/math/matrix";
import { RigRuntime } from "@/src/rigging/runtime/RigRuntime";
import { createRestPose } from "@/src/rigging/runtime/pose";
import { computeWorldTransforms } from "@/src/rigging/runtime/worldTransforms";
import type { AnimationDefinition, RigDefinition } from "@/src/rigging/schema/types";
import type { RigRenderer } from "@/src/rigging/rendering/RigRenderer";
import { RigAssetLoader } from "@/src/rigging/assets/RigAssetLoader";
import type { BoneAuthoringPatch, EditorSelection } from "@/src/tools/rig-editor/types";
import { selectionChainForBone } from "./viewportSelection";

export type EditorViewportHandle = {
  readonly resetView: () => void;
  readonly seekAnimation: (time: number) => void;
  readonly playAnimation: () => void;
  readonly pauseAnimation: () => void;
  readonly stopAnimation: () => void;
};

type Props = {
  readonly projectId?: string | null;
  readonly rig: RigDefinition;
  readonly animation: AnimationDefinition | null;
  readonly previewMode: boolean;
  readonly authoringMode?: boolean;
  readonly animationTime?: number;
  readonly animationPlaying?: boolean;
  readonly playbackSpeed?: number;
  readonly showPreviousGhost?: boolean;
  readonly showNextGhost?: boolean;
  readonly activeSkinId: string;
  readonly selections: readonly EditorSelection[];
  readonly hiddenBoneIds: ReadonlySet<string>;
  readonly lockedBoneIds: ReadonlySet<string>;
  readonly showGrid: boolean;
  readonly showBones: boolean;
  readonly showBounds: boolean;
  readonly snapToGrid: boolean;
  readonly wholePixelSnap: boolean;
  readonly rotationSnap: boolean;
  readonly canvasTool?: "select" | "pan";
  readonly interactionMode?: "body" | "pivots" | "equipment" | "validate" | "animate";
  readonly onSelect: (selection: EditorSelection | null, additive: boolean) => void;
  readonly onCursor: (point: Point) => void;
  readonly onZoom: (zoom: number) => void;
  readonly onBoneDragStart: (boneId: string) => void;
  readonly onBoneDragPreview: (boneId: string, patch: BoneAuthoringPatch) => void;
  readonly onBoneDragCommit: (boneId: string, patch: BoneAuthoringPatch) => void;
  readonly onAnimationTime?: (time: number, playing: boolean) => void;
  readonly onWarning: (message: string) => void;
};

type PixiState = {
  readonly app: Application;
  readonly view: Container;
  readonly grid: Graphics;
  readonly overlay: Graphics;
  readonly assetLoader: RigAssetLoader;
  runtime: RigRuntime | null;
  renderer: RigRenderer | null;
  player: AnimationPlayer | null;
  hasFit: boolean;
};

type PanDrag = { readonly mode: "pan"; readonly x: number; readonly y: number; readonly viewX: number; readonly viewY: number };
type BoneDrag = {
  readonly mode: "position" | "rotation";
  readonly boneId: string;
  readonly startBoneX: number;
  readonly startBoneY: number;
  readonly localOffsetX: number;
  readonly localOffsetY: number;
};
type DragState = PanDrag | BoneDrag;

const distanceToSegment = (point: Point, start: Point, end: Point): number => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
};

export const EditorViewport = forwardRef<EditorViewportHandle, Props>(function EditorViewport(props, ref) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<PixiState | null>(null);
  const propsRef = useRef(props);
  const dragRef = useRef<DragState | null>(null);
  const spacePressedRef = useRef(false);
  const reduceMotionRef = useRef(false);
  const hoveredSelectionRef = useRef<EditorSelection | null>(null);
  const [pixiReady, setPixiReady] = useState(false);
  const [hoveredSelection, setHoveredSelection] = useState<EditorSelection | null>(null);
  propsRef.current = props;
  hoveredSelectionRef.current = hoveredSelection;

  const screenToWorld = (clientX: number, clientY: number): Point => {
    const state = stateRef.current;
    const mount = mountRef.current;
    if (!state || !mount) return { x: 0, y: 0 };
    const bounds = mount.getBoundingClientRect();
    return {
      x: (clientX - bounds.left - state.view.x) / state.view.scale.x,
      y: (clientY - bounds.top - state.view.y) / state.view.scale.y,
    };
  };

  const fitView = (): void => {
    const state = stateRef.current;
    const mount = mountRef.current;
    if (!state || !mount) return;
    const { width, height } = mount.getBoundingClientRect();
    state.app.renderer.resize(Math.max(1, width), Math.max(1, height));
    const scale = Math.max(0.15, Math.min(2.5, Math.min(width / propsRef.current.rig.canvas.width, height / propsRef.current.rig.canvas.height) * 0.88));
    state.view.scale.set(scale);
    state.view.position.set(
      (width - propsRef.current.rig.canvas.width * scale) / 2,
      (height - propsRef.current.rig.canvas.height * scale) / 2,
    );
    propsRef.current.onZoom(scale);
  };

  useImperativeHandle(ref, () => ({
    resetView: fitView,
    seekAnimation: (time) => { stateRef.current?.player?.seek(time); stateRef.current?.renderer?.update(); },
    playAnimation: () => {
      const state = stateRef.current;
      if (!state?.player || !propsRef.current.animation) return;
      state.player.play(propsRef.current.animation, false);
    },
    pauseAnimation: () => stateRef.current?.player?.pause(),
    stopAnimation: () => { stateRef.current?.player?.stop(); stateRef.current?.renderer?.update(); },
  }), []);

  const drawGrid = (state: PixiState): void => {
    state.grid.clear();
    state.grid.visible = propsRef.current.showGrid;
    if (!state.grid.visible) return;
    const { width, height } = propsRef.current.rig.canvas;
    const left = -width; const right = width * 2; const top = -height; const bottom = height * 2;
    for (let x = left; x <= right; x += 16) state.grid.moveTo(x, top).lineTo(x, bottom);
    for (let y = top; y <= bottom; y += 16) state.grid.moveTo(left, y).lineTo(right, y);
    state.grid.stroke({ color: 0x7667c9, width: 1, alpha: 0.07 });
    for (let x = left; x <= right; x += 64) state.grid.moveTo(x, top).lineTo(x, bottom);
    for (let y = top; y <= bottom; y += 64) state.grid.moveTo(left, y).lineTo(right, y);
    state.grid.stroke({ color: 0x8f82e8, width: 1, alpha: 0.13 });
  };

  const selectedBone = (): string | null => propsRef.current.selections.find((selection) => selection.type === "bone")?.id ?? null;

  const drawOverlay = (state: PixiState): void => {
    state.overlay.clear();
    const runtime = state.runtime;
    if (!runtime) return;
    const world = runtime.getWorldTransforms();
    const zoom = Math.max(0.1, state.view.scale.x);
    const currentProps = propsRef.current;
    const primaryBoneId = selectedBone();
    const chain = primaryBoneId ? selectionChainForBone(runtime.definition, primaryBoneId) : null;
    const pulse = reduceMotionRef.current ? 1 : 0.86 + Math.sin(performance.now() / 260) * 0.14;
    if (currentProps.authoringMode && currentProps.animation && (currentProps.showPreviousGhost || currentProps.showNextGhost)) {
      const currentTime = state.player?.currentTime ?? currentProps.animationTime ?? 0;
      const times = [...new Set(currentProps.animation.tracks.flatMap((track) => track.keyframes.map((frame) => frame.time)))].sort((a, b) => a - b);
      const previous = times.filter((time) => time < currentTime - .0001).at(-1);
      const next = times.find((time) => time > currentTime + .0001);
      const drawGhost = (ghostTime: number, color: number): void => {
        const pose = evaluateAnimationAtTime(currentProps.animation!, createRestPose(currentProps.rig), ghostTime);
        const transforms = computeWorldTransforms(currentProps.rig, pose);
        currentProps.rig.bones.forEach((bone) => {
          const transform = transforms[bone.id]; if (!transform) return;
          const end = transformPoint(transform.matrix, { x: bone.length, y: 0 });
          state.overlay.moveTo(transform.x, transform.y).lineTo(end.x, end.y).stroke({ color, width: 2 / zoom, alpha: .22 });
          state.overlay.circle(transform.x, transform.y, 3 / zoom).fill({ color, alpha: .2 });
        });
      };
      if (currentProps.showPreviousGhost && previous !== undefined) drawGhost(previous, 0x87b8ff);
      if (currentProps.showNextGhost && next !== undefined) drawGhost(next, 0xff9a78);
    }
    if (currentProps.showBones || currentProps.interactionMode === "pivots") {
      runtime.definition.bones.forEach((bone) => {
        if (currentProps.hiddenBoneIds.has(bone.id)) return;
        const transform = world[bone.id];
        if (!transform) return;
        const end = transformPoint(transform.matrix, { x: bone.length, y: 0 });
        const selected = bone.id === primaryBoneId;
        const related = bone.id === chain?.parentId || (chain?.childIds.includes(bone.id) ?? false);
        const hovered = hoveredSelectionRef.current?.type === "bone" && hoveredSelectionRef.current.id === bone.id;
        const color = selected ? 0x5de4ff : related || hovered ? 0x56cde9 : 0x8b86ae;
        const alpha = selected ? 1 : related ? 0.58 : hovered ? 0.88 : primaryBoneId ? 0.2 : 0.48;
        if (selected || hovered) state.overlay.moveTo(transform.x, transform.y).lineTo(end.x, end.y).stroke({ color, width: (selected ? 8 : 5) / zoom, alpha: selected ? 0.16 : 0.1 });
        state.overlay.moveTo(transform.x, transform.y).lineTo(end.x, end.y).stroke({ color, width: (selected ? 3 : related ? 2 : 1.25) / zoom, alpha });
        if (selected) {
          state.overlay.circle(transform.x, transform.y, 9 / zoom).fill({ color: 0xa77bff, alpha: 0.12 * pulse });
          state.overlay.circle(transform.x, transform.y, 5.5 / zoom).fill({ color: 0xa77bff, alpha: pulse });
        } else state.overlay.circle(transform.x, transform.y, (related || hovered ? 4 : 3) / zoom).fill({ color, alpha: Math.min(0.9, alpha + 0.2) });
      });
    }
    const boneId = primaryBoneId;
    if (boneId) {
      const bone = runtime.definition.bones.find((candidate) => candidate.id === boneId);
      const transform = world[boneId];
      if (bone && transform && (!propsRef.current.previewMode || (propsRef.current.authoringMode && !propsRef.current.animationPlaying))) {
        const radius = Math.max(34, Math.min(70, bone.length * 0.72));
        const handle = transformPoint(matrixFromTransform({ x: transform.x, y: transform.y, rotation: transform.rotation, scaleX: 1, scaleY: 1 }), { x: radius, y: 0 });
        state.overlay.circle(transform.x, transform.y, radius).stroke({ color: 0xa77bff, width: 1 / zoom, alpha: 0.3 });
        state.overlay.moveTo(transform.x, transform.y).lineTo(handle.x, handle.y).stroke({ color: 0xa77bff, width: 1 / zoom, alpha: 0.7 });
        state.overlay.circle(handle.x, handle.y, 7 / zoom).fill({ color: 0xa77bff, alpha: pulse });
        if (currentProps.interactionMode === "pivots") {
          const guide = 26 / zoom;
          state.overlay.moveTo(transform.x - guide, transform.y).lineTo(transform.x + guide, transform.y).stroke({ color: 0xa77bff, width: 1 / zoom, alpha: 0.26 });
          state.overlay.moveTo(transform.x, transform.y - guide).lineTo(transform.x, transform.y + guide).stroke({ color: 0xa77bff, width: 1 / zoom, alpha: 0.26 });
        }
      }
    }
    const attachmentBoneIds = chain?.relatedIds ?? new Set<string>();
    runtime.getResolvedSlots().forEach(({ slot, attachment }) => {
      const equipment = /weapon|shield|sword|staff|bow|helmet|armor|cape|tail|quiver/i.test(`${slot.id} ${attachment?.id ?? ""}`);
      if (!attachment || (!attachmentBoneIds.has(slot.boneId) && !(currentProps.interactionMode === "equipment" && equipment))) return;
      const bone = world[slot.boneId];
      if (!bone) return;
      const anchor = transformPoint(bone.matrix, { x: attachment.offsetX, y: attachment.offsetY });
      const color = equipment ? 0x5dffc0 : 0x54e8ff;
      state.overlay.circle(anchor.x, anchor.y, 3.5 / zoom).fill({ color, alpha: 0.78 });
      state.overlay.circle(anchor.x, anchor.y, 7 / zoom).stroke({ color, width: 1 / zoom, alpha: 0.24 });
    });
    const selectedSlotId = propsRef.current.selections.find((selection) => selection.type === "slot")?.id;
    if (selectedSlotId) drawSelectedSlot(state, selectedSlotId, zoom);
    if (hoveredSelectionRef.current?.type === "slot" && hoveredSelectionRef.current.id !== selectedSlotId) drawSelectedSlot(state, hoveredSelectionRef.current.id, zoom, true);
  };

  const drawSelectedSlot = (state: PixiState, slotId: string, zoom: number, hovered = false): void => {
    const runtime = state.runtime;
    if (!runtime) return;
    const resolved = runtime.getResolvedSlots().find(({ slot }) => slot.id === slotId);
    if (!resolved?.attachment) return;
    const bone = runtime.getWorldTransforms()[resolved.slot.boneId];
    if (!bone) return;
    const attachment = resolved.attachment;
    const matrix = multiplyMatrices(bone.matrix, matrixFromTransform({
      x: attachment.offsetX, y: attachment.offsetY, rotation: degreesToRadians(attachment.rotation),
      scaleX: attachment.scaleX, scaleY: attachment.scaleY,
    }));
    const left = -resolved.slot.pivotX;
    const top = -resolved.slot.pivotY;
    const corners = [
      transformPoint(matrix, { x: left, y: top }),
      transformPoint(matrix, { x: left + attachment.width, y: top }),
      transformPoint(matrix, { x: left + attachment.width, y: top + attachment.height }),
      transformPoint(matrix, { x: left, y: top + attachment.height }),
    ];
    if (!hovered) state.overlay.poly(corners.flatMap((point) => [point.x, point.y]), true).stroke({ color: 0x5de4ff, width: 8 / zoom, alpha: 0.12 });
    state.overlay.poly(corners.flatMap((point) => [point.x, point.y]), true).stroke({ color: 0x5de4ff, width: (hovered ? 1.25 : 2) / zoom, alpha: hovered ? 0.75 : 1 });
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let cancelled = false;
    let state: PixiState | null = null;
    let tick: ((ticker: { readonly deltaMS: number }) => void) | null = null;
    void (async () => {
      const { Application, Container, Graphics } = await import("pixi.js");
      if (cancelled) return;
      const app = new Application();
      await app.init({ resizeTo: mount, backgroundColor: 0x080718, antialias: true, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1) });
      if (cancelled) { app.destroy(true); return; }
      mount.appendChild(app.canvas);
      const view = new Container();
      const grid = new Graphics();
      const overlay = new Graphics();
      view.sortableChildren = true;
      grid.zIndex = -10;
      overlay.zIndex = 100_000;
      view.addChild(grid, overlay);
      app.stage.addChild(view);
      state = { app, view, grid, overlay, assetLoader: new RigAssetLoader(), runtime: null, renderer: null, player: null, hasFit: false };
      stateRef.current = state;
      drawGrid(state);
      tick = (ticker): void => {
        const current = stateRef.current;
        if (!current) return;
        if (propsRef.current.previewMode || propsRef.current.authoringMode) {
          current.player?.update(ticker.deltaMS / 1000);
          if (propsRef.current.authoringMode && current.player) propsRef.current.onAnimationTime?.(current.player.currentTime, current.player.isPlaying);
        }
        current.renderer?.update();
        if (current.renderer && current.runtime) {
          const primary = propsRef.current.selections[0];
          const chain = primary?.type === "bone" ? selectionChainForBone(current.runtime.definition, primary.id) : null;
          const selectedSlot = primary?.type === "slot" ? current.runtime.definition.slots.find((slot) => slot.id === primary.id) : null;
          current.runtime.definition.slots.forEach((slot) => {
            const sprite = current.renderer?.attachmentSprites.get(slot.id);
            if (!sprite) return;
            if (propsRef.current.hiddenBoneIds.has(slot.boneId)) { sprite.visible = false; return; }
            const attachment = current.runtime?.definition.attachments.find((item) => item.id === slot.attachmentId);
            const equipment = /weapon|shield|sword|staff|bow|helmet|armor|cape|tail|quiver/i.test(`${slot.id} ${attachment?.id ?? ""}`);
            if (primary?.type === "bone") sprite.alpha = slot.boneId === primary.id ? 1 : chain?.relatedIds.has(slot.boneId) ? 0.7 : 0.28;
            else if (selectedSlot) sprite.alpha = slot.id === selectedSlot.id ? 1 : slot.boneId === selectedSlot.boneId ? 0.62 : 0.28;
            else if (propsRef.current.interactionMode === "equipment") sprite.alpha = equipment ? 1 : 0.28;
            else sprite.alpha = 1;
          });
        }
        drawOverlay(current);
      };
      app.ticker.add(tick);
      reduceMotionRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      fitView();
      state.hasFit = true;
      setPixiReady(true);
    })();
    const keyDown = (event: KeyboardEvent): void => { if (event.code === "Space" && !event.repeat) spacePressedRef.current = true; };
    const keyUp = (event: KeyboardEvent): void => { if (event.code === "Space") spacePressedRef.current = false; };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      if (state && tick) state.app.ticker.remove(tick);
      state?.renderer?.destroy();
      if (state) void state.assetLoader.destroy();
      state?.app.destroy(true);
      stateRef.current = null;
    };
    // Pixi owns this mount lifecycle; current editor props are read through propsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!pixiReady || !stateRef.current) return;
    const state = stateRef.current;
    const currentProps = propsRef.current;
    let cancelled = false;
    const previous = state.renderer;
    state.renderer = null;
    state.runtime = null;
    state.player = null;
    previous?.destroy();
    drawGrid(state);
    void (async () => {
      try {
        const [{ RigRenderer: Renderer }] = await Promise.all([import("@/src/rigging/rendering/RigRenderer")]);
        const runtime = new RigRuntime(currentProps.rig);
        runtime.applySkin(currentProps.rig.skins.some((skin) => skin.id === currentProps.activeSkinId) ? currentProps.activeSkinId : currentProps.rig.defaultSkinId);
        const renderer = await Renderer.create(runtime, { onWarning: currentProps.onWarning, assetLoader: state.assetLoader });
        if (cancelled || !stateRef.current) { renderer.destroy(); return; }
        renderer.setBoneHandlesVisible(false);
        renderer.setSlotBoundsVisible(currentProps.showBounds);
        state.view.addChildAt(renderer.container, Math.min(1, state.view.children.length));
        state.runtime = runtime;
        state.renderer = renderer;
        if ((currentProps.previewMode || currentProps.authoringMode) && currentProps.animation) {
          const player = new AnimationPlayer(runtime);
          player.play(currentProps.animation);
          player.setPlaybackSpeed(currentProps.playbackSpeed ?? 1);
          player.seek(currentProps.animationTime ?? 0);
          if (currentProps.authoringMode && !currentProps.animationPlaying) player.pause();
          state.player = player;
        }
        renderer.update();
        if (!state.hasFit) { fitView(); state.hasFit = true; }
      } catch (reason: unknown) {
        currentProps.onWarning(reason instanceof Error ? reason.message : "Viewport could not render the rig");
      }
    })();
    return () => { cancelled = true; };
  }, [pixiReady, props.rig]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state?.runtime || !state.renderer) return;
    if (state.runtime.definition.skins.some((skin) => skin.id === props.activeSkinId)) state.runtime.applySkin(props.activeSkinId);
    state.renderer.setSlotBoundsVisible(props.showBounds);
    state.renderer.update();
  }, [props.activeSkinId, props.showBounds]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state?.runtime) return;
    if ((props.previewMode || props.authoringMode) && props.animation) {
      const player = new AnimationPlayer(state.runtime);
      player.play(props.animation);
      player.setPlaybackSpeed(props.playbackSpeed ?? 1);
      player.seek(props.animationTime ?? 0);
      if (props.authoringMode && !props.animationPlaying) player.pause();
      state.player = player;
    } else {
      state.player?.stop();
      state.player = null;
      state.runtime.resetToSetupPose();
      state.renderer?.update();
    }
    // Playback time, speed, and play state are synchronized by focused effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.previewMode, props.authoringMode, props.animation]);

  useEffect(() => {
    const player = stateRef.current?.player;
    if (!player || !props.authoringMode) return;
    player.setPlaybackSpeed(props.playbackSpeed ?? 1);
    if (props.animationPlaying) player.play(props.animation!, false); else player.pause();
  }, [props.animationPlaying, props.authoringMode, props.playbackSpeed, props.animation]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state?.player || !props.authoringMode || props.animationPlaying) return;
    state.player.seek(props.animationTime ?? 0);
    state.renderer?.update();
  }, [props.animationTime, props.animationPlaying, props.authoringMode]);

  useEffect(() => { if (stateRef.current) drawGrid(stateRef.current); }, [props.showGrid]);

  const findBone = (point: Point): string | null => {
    const state = stateRef.current;
    if (!state?.runtime) return null;
    const world = state.runtime.getWorldTransforms();
    const tolerance = 9 / Math.max(0.1, state.view.scale.x);
    const candidates = [...state.runtime.definition.bones].reverse();
    return candidates.find((bone) => {
      if (propsRef.current.hiddenBoneIds.has(bone.id)) return false;
      const transform = world[bone.id];
      if (!transform) return false;
      const end = transformPoint(transform.matrix, { x: bone.length, y: 0 });
      return distanceToSegment(point, { x: transform.x, y: transform.y }, end) <= tolerance;
    })?.id ?? null;
  };

  const findSlot = (point: Point): string | null => {
    const state = stateRef.current;
    if (!state?.runtime) return null;
    const world = state.runtime.getWorldTransforms();
    const slots = [...state.runtime.getResolvedSlots()].sort((a, b) => b.slot.zIndex - a.slot.zIndex);
    for (const { slot, attachment } of slots) {
      if (!slot.visible || !attachment || propsRef.current.hiddenBoneIds.has(slot.boneId)) continue;
      const bone = world[slot.boneId];
      if (!bone) continue;
      const matrix = multiplyMatrices(bone.matrix, matrixFromTransform({ x: attachment.offsetX, y: attachment.offsetY, rotation: degreesToRadians(attachment.rotation), scaleX: attachment.scaleX, scaleY: attachment.scaleY }));
      const inverse = invertMatrix(matrix);
      if (!inverse) continue;
      const local = transformPoint(inverse, point);
      if (local.x >= -slot.pivotX && local.x <= attachment.width - slot.pivotX && local.y >= -slot.pivotY && local.y <= attachment.height - slot.pivotY) return slot.id;
    }
    return null;
  };

  const rotationHandleHit = (point: Point, boneId: string): boolean => {
    const state = stateRef.current;
    if (!state?.runtime) return false;
    const bone = state.runtime.definition.bones.find((candidate) => candidate.id === boneId);
    const transform = state.runtime.getWorldTransforms()[boneId];
    if (!bone || !transform) return false;
    const radius = Math.max(34, Math.min(70, bone.length * 0.72));
    const handle = transformPoint(matrixFromTransform({ x: transform.x, y: transform.y, rotation: transform.rotation, scaleX: 1, scaleY: 1 }), { x: radius, y: 0 });
    return Math.hypot(point.x - handle.x, point.y - handle.y) <= 11 / Math.max(0.1, state.view.scale.x);
  };

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = stateRef.current;
    if (!state) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.button === 1 || (event.button === 0 && (spacePressedRef.current || props.canvasTool === "pan"))) {
      dragRef.current = { mode: "pan", x: event.clientX, y: event.clientY, viewX: state.view.x, viewY: state.view.y };
      return;
    }
    if (event.button !== 0) return;
    const point = screenToWorld(event.clientX, event.clientY);
    const currentBone = selectedBone();
    const canEditPose = !props.previewMode || (props.authoringMode && !props.animationPlaying);
    if (currentBone && canEditPose && !props.lockedBoneIds.has(currentBone) && rotationHandleHit(point, currentBone)) {
      const bone = props.rig.bones.find((candidate) => candidate.id === currentBone);
      if (!bone) return;
      const pose = state.runtime?.bones.get(currentBone)?.readPose();
      props.onBoneDragStart(currentBone);
      dragRef.current = { mode: "rotation", boneId: currentBone, startBoneX: pose?.x ?? bone.x, startBoneY: pose?.y ?? bone.y, localOffsetX: 0, localOffsetY: 0 };
      return;
    }
    const boneId = props.showBones ? findBone(point) : null;
    const slotId = boneId ? null : findSlot(point);
    if (boneId) {
      props.onSelect({ type: "bone", id: boneId }, event.shiftKey);
      const bone = props.rig.bones.find((candidate) => candidate.id === boneId);
      if (canEditPose && bone && !props.lockedBoneIds.has(boneId)) {
        const world = state.runtime?.getWorldTransforms();
        const parentMatrix = bone.parentId ? world?.[bone.parentId]?.matrix : null;
        const inverse = parentMatrix ? invertMatrix(parentMatrix) : null;
        const local = inverse ? transformPoint(inverse, point) : point;
        const pose = state.runtime?.bones.get(boneId)?.readPose();
        const poseX = pose?.x ?? bone.x; const poseY = pose?.y ?? bone.y;
        props.onBoneDragStart(boneId);
        dragRef.current = { mode: "position", boneId, startBoneX: poseX, startBoneY: poseY, localOffsetX: local.x - poseX, localOffsetY: local.y - poseY };
      }
    } else if (slotId) props.onSelect({ type: "slot", id: slotId }, event.shiftKey);
    else props.onSelect(null, false);
  };

  const pointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = stateRef.current;
    if (!state) return;
    const point = screenToWorld(event.clientX, event.clientY);
    props.onCursor(point);
    const drag = dragRef.current;
    if (!drag && props.canvasTool !== "pan") {
      const boneId = props.showBones ? findBone(point) : null;
      const slotId = boneId ? null : findSlot(point);
      const next = boneId ? { type: "bone" as const, id: boneId } : slotId ? { type: "slot" as const, id: slotId } : null;
      setHoveredSelection((current) => current?.type === next?.type && current?.id === next?.id ? current : next);
    }
    if (!drag) return;
    if (drag.mode === "pan") {
      state.view.position.set(drag.viewX + event.clientX - drag.x, drag.viewY + event.clientY - drag.y);
      return;
    }
    const bone = props.rig.bones.find((candidate) => candidate.id === drag.boneId);
    const runtime = state.runtime;
    if (!bone || !runtime) return;
    let patch: BoneAuthoringPatch;
    if (drag.mode === "position") {
      const world = runtime.getWorldTransforms();
      const parentMatrix = bone.parentId ? world[bone.parentId]?.matrix : null;
      const inverse = parentMatrix ? invertMatrix(parentMatrix) : null;
      const local = inverse ? transformPoint(inverse, point) : point;
      let x = local.x - drag.localOffsetX;
      let y = local.y - drag.localOffsetY;
      if (props.snapToGrid) { x = Math.round(x / 8) * 8; y = Math.round(y / 8) * 8; }
      if (props.wholePixelSnap) { x = Math.round(x); y = Math.round(y); }
      patch = { x, y };
      runtime.updateBonePose(bone.id, { x, y });
    } else {
      const transform = runtime.getWorldTransforms()[bone.id];
      const parentRotation = bone.parentId && bone.inheritRotation ? runtime.getWorldTransforms()[bone.parentId]?.rotation ?? 0 : 0;
      let rotation = radiansToDegrees(Math.atan2(point.y - transform.y, point.x - transform.x) - parentRotation);
      if (props.rotationSnap) rotation = Math.round(rotation / 15) * 15;
      patch = { rotation };
      runtime.updateBonePose(bone.id, { rotation: degreesToRadians(rotation) });
    }
    props.onBoneDragPreview(bone.id, patch);
    state.renderer?.update();
  };

  const pointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.mode === "pan") return;
    const pose = stateRef.current?.runtime?.bones.get(drag.boneId)?.readPose();
    if (!pose) return;
    props.onBoneDragCommit(drag.boneId, drag.mode === "position" ? { x: pose.x, y: pose.y } : { rotation: radiansToDegrees(pose.rotation) });
  };

  const wheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const state = stateRef.current;
    const mount = mountRef.current;
    if (!state || !mount) return;
    event.preventDefault();
    const bounds = mount.getBoundingClientRect();
    const screen = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const world = { x: (screen.x - state.view.x) / state.view.scale.x, y: (screen.y - state.view.y) / state.view.scale.y };
    const scale = Math.max(0.1, Math.min(4, state.view.scale.x * Math.exp(-event.deltaY * 0.0012)));
    state.view.scale.set(scale);
    state.view.position.set(screen.x - world.x * scale, screen.y - world.y * scale);
    props.onZoom(scale);
  };

  return <div ref={mountRef} className={`editor-viewport ${props.canvasTool === "pan" ? "is-pan-tool" : "is-select-tool"}`} data-interaction-mode={props.interactionMode ?? "body"} data-canvas-project-id={props.projectId ?? "browser-draft"} tabIndex={0} aria-label="Rig editor viewport" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onPointerLeave={() => setHoveredSelection(null)} onWheel={wheel} onContextMenu={(event) => event.preventDefault()}>{hoveredSelection && props.canvasTool !== "pan" && <span className="viewport-semantic-hint">{hoveredSelection.type === "bone" ? "Joint" : "Part"} · {hoveredSelection.id.replaceAll("-", " ")}</span>}</div>;
});
