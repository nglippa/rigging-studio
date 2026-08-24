"use client";

import { forwardRef, memo, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { AnimatedProperty, AnimationDefinition, RigDefinition } from "@/src/rigging/schema/types";
import { ANIMATED_PROPERTIES } from "@/src/rigging/schema/types";
import { keyframeSelectionKey, type KeyframeSelection } from "@/src/tools/rig-editor/animation/types";
import type { TimelineIssueMarker } from "@/src/rigging/ai-vision/visualReviewDiff";
import { humanizeTechnicalId } from "@/app/studio-ui/humanize";

const LABEL_WIDTH = 240;
const RULER_HEIGHT = 32;
const ROW_HEIGHT = 30;
const OVERSCAN = 8;
type TimelineRow = { readonly kind: "bone" | "property"; readonly boneId: string; readonly property?: AnimatedProperty; readonly depth: number };
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type KeyDrag = { readonly startX: number; readonly previewDelta: number };

export type DopeSheetHandle = { readonly setPlayhead: (time: number) => void };
type Props = {
  readonly rig: RigDefinition;
  readonly animation: AnimationDefinition;
  readonly time: number;
  readonly pixelsPerSecond: number;
  readonly fps: number;
  readonly showFrames: boolean;
  readonly snap: boolean;
  readonly selections: readonly KeyframeSelection[];
  readonly selectedBoneIds: ReadonlySet<string>;
  readonly onTime: (time: number) => void;
  readonly onSelect: (selections: readonly KeyframeSelection[]) => void;
  readonly onMoveSelected: (delta: number) => void;
  readonly onSelectBone: (boneId: string) => void;
  readonly issueMarkers?: readonly TimelineIssueMarker[];
  readonly onIssueSelect?: (marker: TimelineIssueMarker) => void;
};

export const DopeSheet = memo(forwardRef<DopeSheetHandle, Props>(function DopeSheet(props, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<KeyDrag | null>(null);
  const boxStartRef = useRef<{ x: number; y: number } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(props.rig.bones.slice(0, 8).map((bone) => bone.id)));
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(280);
  const [box, setBox] = useState<Box | null>(null);

  const rows = useMemo<TimelineRow[]>(() => props.rig.bones.flatMap((bone) => [
    { kind: "bone" as const, boneId: bone.id, depth: bone.parentId ? 1 : 0 },
    ...(expanded.has(bone.id) ? ANIMATED_PROPERTIES.filter((property) => props.animation.tracks.some((track) => track.boneId === bone.id && track.property === property)).map((property) => ({ kind: "property" as const, boneId: bone.id, property, depth: bone.parentId ? 2 : 1 })) : []),
  ]), [expanded, props.animation.tracks, props.rig.bones]);
  const selectedKeys = useMemo(() => new Set(props.selections.map(keyframeSelectionKey)), [props.selections]);
  const totalWidth = Math.max(640, props.animation.duration * props.pixelsPerSecond + 96);
  const totalHeight = rows.length * ROW_HEIGHT;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visibleRows = rows.slice(first, last);

  useImperativeHandle(ref, () => ({ setPlayhead(time) {
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${LABEL_WIDTH + time * props.pixelsPerSecond}px)`;
  } }), [props.pixelsPerSecond]);

  const timeAt = (clientX: number): number => {
    const scroll = scrollRef.current;
    if (!scroll) return 0;
    const bounds = scroll.getBoundingClientRect();
    const x = clientX - bounds.left + scroll.scrollLeft - LABEL_WIDTH;
    const raw = Math.max(0, Math.min(props.animation.duration, x / props.pixelsPerSecond));
    return props.snap ? Math.round(raw * props.fps) / props.fps : raw;
  };

  const scrub = (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    props.onTime(timeAt(event.clientX));
    const move = (moveEvent: Event): void => { if (moveEvent instanceof PointerEvent) props.onTime(timeAt(moveEvent.clientX)); };
    const up = (): void => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", up, { once: true });
  };

  const keyDown = (event: React.PointerEvent, selection: KeyframeSelection): void => {
    event.stopPropagation();
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const exists = selectedKeys.has(keyframeSelectionKey(selection));
    props.onSelect(additive ? (exists ? props.selections.filter((candidate) => keyframeSelectionKey(candidate) !== keyframeSelectionKey(selection)) : [...props.selections, selection]) : exists ? props.selections : [selection]);
    dragRef.current = { startX: event.clientX, previewDelta: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const keyMove = (event: React.PointerEvent): void => {
    if (!dragRef.current) return;
    let delta = (event.clientX - dragRef.current.startX) / props.pixelsPerSecond;
    if (props.snap) delta = Math.round(delta * props.fps) / props.fps;
    dragRef.current = { ...dragRef.current, previewDelta: delta };
    document.documentElement.style.setProperty("--key-drag-preview", `${delta * props.pixelsPerSecond}px`);
  };
  const keyUp = (event: React.PointerEvent): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const drag = dragRef.current; dragRef.current = null;
    document.documentElement.style.removeProperty("--key-drag-preview");
    if (drag && Math.abs(drag.previewDelta) > 0.00001) props.onMoveSelected(drag.previewDelta);
  };

  const boxDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.clientX - event.currentTarget.getBoundingClientRect().left < LABEL_WIDTH) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left + event.currentTarget.scrollLeft;
    const y = event.clientY - bounds.top + event.currentTarget.scrollTop - RULER_HEIGHT;
    boxStartRef.current = { x, y }; setBox({ x, y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const boxMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = boxStartRef.current;
    if (!start) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left + event.currentTarget.scrollLeft;
    const y = event.clientY - bounds.top + event.currentTarget.scrollTop - RULER_HEIGHT;
    setBox({ x: Math.min(x, start.x), y: Math.min(y, start.y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) });
  };
  const boxUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (box && box.width > 3 && box.height > 3) {
      const hits: KeyframeSelection[] = [];
      rows.forEach((row, rowIndex) => {
        if (row.kind !== "property" || !row.property) return;
        const track = props.animation.tracks.find((candidate) => candidate.boneId === row.boneId && candidate.property === row.property);
        track?.keyframes.forEach((frame) => {
          const x = LABEL_WIDTH + frame.time * props.pixelsPerSecond;
          const y = rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
          if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) hits.push({ boneId: row.boneId, property: row.property!, time: frame.time });
        });
      });
      props.onSelect(hits);
    }
    boxStartRef.current = null; setBox(null);
  };

  const majorStep = props.pixelsPerSecond >= 180 ? .25 : props.pixelsPerSecond >= 90 ? .5 : 1;
  const ticks = Array.from({ length: Math.floor(props.animation.duration / majorStep) + 1 }, (_, index) => index * majorStep);

  return <section className="dope-sheet" aria-label="Animation timeline">
    <div className="timeline-corner">BONES / TRACKS</div>
    <div className="timeline-scroll" ref={scrollRef} onScroll={(event) => { setScrollTop(event.currentTarget.scrollTop); setViewportHeight(event.currentTarget.clientHeight); }} onPointerDown={boxDown} onPointerMove={boxMove} onPointerUp={boxUp}>
      <div className="timeline-content" style={{ width: LABEL_WIDTH + totalWidth, height: RULER_HEIGHT + totalHeight }}>
        <div className="time-ruler" style={{ left: LABEL_WIDTH, width: totalWidth }} onPointerDown={scrub}>
          {ticks.map((time) => <span key={time} style={{ left: time * props.pixelsPerSecond }}><i />{props.showFrames ? Math.round(time * props.fps) : `${time.toFixed(time % 1 ? 2 : 0)}s`}</span>)}
        </div>
        <div className="timeline-labels" style={{ top: RULER_HEIGHT, height: totalHeight }}>
          {visibleRows.map((row, offset) => {
            const index = first + offset;
            return <button type="button" key={`${row.boneId}:${row.property ?? "bone"}`} className={`timeline-label ${row.kind} ${props.selectedBoneIds.has(row.boneId) ? "selected-bone" : ""}`} style={{ top: index * ROW_HEIGHT, paddingLeft: 8 + row.depth * 13 }} onClick={() => row.kind === "bone" ? (setExpanded((current) => { const next = new Set(current); if (next.has(row.boneId)) next.delete(row.boneId); else next.add(row.boneId); return next; }), props.onSelectBone(row.boneId)) : props.onSelectBone(row.boneId)}>
              {row.kind === "bone" ? <span className="disclosure">{expanded.has(row.boneId) ? "▾" : "▸"}</span> : <span className="track-dot" />}{row.property ? humanizeTechnicalId(row.property.replace(/^x$/, "positionX").replace(/^y$/, "positionY")) : humanizeTechnicalId(row.boneId)}
            </button>;
          })}
        </div>
        <div className="timeline-rows" style={{ left: LABEL_WIDTH, top: RULER_HEIGHT, width: totalWidth, height: totalHeight }}>
          {visibleRows.map((row, offset) => {
            const index = first + offset;
            const track = row.property ? props.animation.tracks.find((candidate) => candidate.boneId === row.boneId && candidate.property === row.property) : null;
            const aggregate = row.kind === "bone" ? props.animation.tracks.filter((candidate) => candidate.boneId === row.boneId).flatMap((candidate) => candidate.keyframes) : [];
            return <div key={`${row.boneId}:${row.property ?? "bone"}:lane`} className={`timeline-lane ${row.kind}`} style={{ top: index * ROW_HEIGHT }}>
              {(track?.keyframes ?? aggregate).map((frame, frameIndex) => {
                const selection = row.property ? { boneId: row.boneId, property: row.property, time: frame.time } : null;
                return <button type="button" aria-label={selection ? `${row.boneId} ${row.property} key at ${frame.time.toFixed(3)} seconds` : `Key summary at ${frame.time.toFixed(3)} seconds`} key={`${frame.time}:${frameIndex}`} className={`key-diamond ${selection && selectedKeys.has(keyframeSelectionKey(selection)) ? "selected" : ""} ${row.kind === "bone" ? "summary" : ""}`} style={{ left: frame.time * props.pixelsPerSecond }} onPointerDown={selection ? (event) => keyDown(event, selection) : undefined} onPointerMove={selection ? keyMove : undefined} onPointerUp={selection ? keyUp : undefined} onFocus={selection ? () => { if (!selectedKeys.has(keyframeSelectionKey(selection))) props.onSelect([selection]); } : undefined} onClick={selection ? (event) => { event.stopPropagation(); if (!selectedKeys.has(keyframeSelectionKey(selection))) props.onSelect([selection]); } : undefined} onDoubleClick={() => props.onTime(frame.time)} />;
              })}
            </div>;
          })}
        </div>
        <div className="timeline-issue-markers" style={{ left: LABEL_WIDTH, top: RULER_HEIGHT, width: totalWidth, height: totalHeight }}>
          {props.issueMarkers?.map((marker) => <button type="button" key={marker.id} className={`timeline-issue-marker severity-${marker.severity}`} style={{ left: marker.start * props.pixelsPerSecond, width: Math.max(7, (marker.end - marker.start) * props.pixelsPerSecond) }} title={`${marker.label}: ${marker.start.toFixed(3)}–${marker.end.toFixed(3)}s`} onClick={(event) => { event.stopPropagation(); props.onIssueSelect?.(marker); }}>{marker.label}</button>)}
        </div>
        <div ref={playheadRef} className="timeline-playhead" style={{ transform: `translateX(${LABEL_WIDTH + props.time * props.pixelsPerSecond}px)`, height: RULER_HEIGHT + totalHeight }}><span /></div>
        {box && <div className="timeline-box" style={{ left: box.x, top: RULER_HEIGHT + box.y, width: box.width, height: box.height }} />}
      </div>
    </div>
  </section>;
}));
DopeSheet.displayName = "DopeSheet";
