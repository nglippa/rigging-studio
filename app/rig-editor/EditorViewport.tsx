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

export type EditorViewportHandle = {
  readonly resetView: () => void;
  readonly seekAnimation: (time: number) => void;
  readonly playAnimation: () => void;
  readonly pauseAnimation: () => void;
  readonly stopAnimation: () => void;
};

type Props = {
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
  const [pixiReady, setPixiReady] = useState(false);
  propsRef.current = props;

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
    state.grid.rect(0, 0, width, height).fill({ color: 0x111719, alpha: 1 });
    for (let x = 0; x <= width; x += 16) state.grid.moveTo(x, 0).lineTo(x, height);
    for (let y = 0; y <= height; y += 16) state.grid.moveTo(0, y).lineTo(width, y);
    state.grid.stroke({ color: 0x536268, width: 1, alpha: 0.12 });
    for (let x = 0; x <= width; x += 64) state.grid.moveTo(x, 0).lineTo(x, height);
    for (let y = 0; y <= height; y += 64) state.grid.moveTo(0, y).lineTo(width, y);
    state.grid.stroke({ color: 0x718188, width: 1, alpha: 0.18 });
    state.grid.rect(0, 0, width, height).stroke({ color: 0x718188, width: 1, alpha: 0.34 });
  };

  const selectedBone = (): string | null => propsRef.current.selections.find((selection) => selection.type === "bone")?.id ?? null;

  const drawOverlay = (state: PixiState): void => {
    state.overlay.clear();
    const runtime = state.runtime;
    if (!runtime) return;
    const world = runtime.getWorldTransforms();
    const zoom = Math.max(0.1, state.view.scale.x);
    const currentProps = propsRef.current;
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
    if (propsRef.current.showBones) {
      runtime.definition.bones.forEach((bone) => {
        if (propsRef.current.hiddenBoneIds.has(bone.id)) return;
        const transform = world[bone.id];
        if (!transform) return;
        const end = transformPoint(transform.matrix, { x: bone.length, y: 0 });
        const selected = propsRef.current.selections.some((selection) => selection.type === "bone" && selection.id === bone.id);
        const color = selected ? 0x57d9f0 : 0x9eb1b4;
        state.overlay.moveTo(transform.x, transform.y).lineTo(end.x, end.y).stroke({ color, width: (selected ? 3 : 1.5) / zoom, alpha: selected ? 1 : 0.72 });
        state.overlay.circle(transform.x, transform.y, (selected ? 5 : 3.5) / zoom).fill({ color, alpha: 0.95 });
      });
    }
    const boneId = selectedBone();
    if (boneId) {
      const bone = runtime.definition.bones.find((candidate) => candidate.id === boneId);
      const transform = world[boneId];
      if (bone && transform && (!propsRef.current.previewMode || (propsRef.current.authoringMode && !propsRef.current.animationPlaying))) {
        const radius = Math.max(34, Math.min(70, bone.length * 0.72));
        const handle = transformPoint(matrixFromTransform({ x: transform.x, y: transform.y, rotation: transform.rotation, scaleX: 1, scaleY: 1 }), { x: radius, y: 0 });
        state.overlay.circle(transform.x, transform.y, radius).stroke({ color: 0x57d9f0, width: 1 / zoom, alpha: 0.34 });
        state.overlay.moveTo(transform.x, transform.y).lineTo(handle.x, handle.y).stroke({ color: 0x57d9f0, width: 1 / zoom, alpha: 0.55 });
        state.overlay.circle(handle.x, handle.y, 6 / zoom).fill({ color: 0x57d9f0, alpha: 1 });
      }
    }
    const selectedSlotId = propsRef.current.selections.find((selection) => selection.type === "slot")?.id;
    if (selectedSlotId) drawSelectedSlot(state, selectedSlotId, zoom);
  };

  const drawSelectedSlot = (state: PixiState, slotId: string, zoom: number): void => {
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
    state.overlay.poly(corners.flatMap((point) => [point.x, point.y]), true).stroke({ color: 0x57d9f0, width: 2 / zoom, alpha: 1 });
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
      await app.init({ resizeTo: mount, backgroundColor: 0x0c1012, antialias: true, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1) });
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
          current.runtime.definition.slots.forEach((slot) => {
            const sprite = current.renderer?.attachmentSprites.get(slot.id);
            if (sprite && propsRef.current.hiddenBoneIds.has(slot.boneId)) sprite.visible = false;
          });
        }
        drawOverlay(current);
      };
      app.ticker.add(tick);
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
    if (event.button === 1 || (event.button === 0 && spacePressedRef.current)) {
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

  return <div ref={mountRef} className="editor-viewport" tabIndex={0} aria-label="Rig editor viewport" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onWheel={wheel} onContextMenu={(event) => event.preventDefault()} />;
});
