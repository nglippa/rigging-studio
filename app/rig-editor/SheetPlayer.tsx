"use client";

import { useEffect, useRef, useState } from "react";

export const BRIDGE_URL = process.env.NEXT_PUBLIC_RIGGING_STUDIO_BRIDGE_URL ?? "http://127.0.0.1:47831";

type SheetFrame = { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly durationMs: number };
type SheetJson = { readonly cell: { readonly width: number; readonly height: number }; readonly clips: readonly { readonly id: string; readonly name?: string; readonly loop?: boolean; readonly frames: readonly SheetFrame[] }[] };

/**
 * The baked sheet played back at its own timing, one clip at a time, so the motion can be judged before downloading (a
 * still sheet shows the drawings but not the holds and smears that make it read as drawn).
 */
export function SheetPlayer({ sheetUrl, jsonUrl, clipId }: { readonly sheetUrl: string; readonly jsonUrl: string; /** Play only this clip (no clip tabs). */ readonly clipId?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [sheet, setSheet] = useState<{ readonly json: SheetJson; readonly image: HTMLImageElement } | null>(null);
  const [chosenIndex, setClipIndex] = useState(0);
  const pinned = clipId ? sheet?.json.clips.findIndex((clip) => clip.id === clipId) ?? -1 : -1;
  const clipIndex = pinned >= 0 ? pinned : chosenIndex;
  useEffect(() => {
    let live = true; const image = new Image();
    void fetch(jsonUrl, { cache: "no-store" }).then((response) => response.json() as Promise<SheetJson>).then((json) => { image.onload = () => { if (live) setSheet({ json, image }); }; image.src = sheetUrl; }).catch(() => undefined);
    return () => { live = false; };
  }, [sheetUrl, jsonUrl]);
  useEffect(() => {
    const clip = sheet?.json.clips[clipIndex]; const target = canvas.current; if (!sheet || !clip || !target) return;
    const width = Math.max(...clip.frames.map((frame) => frame.w)); const height = Math.max(...clip.frames.map((frame) => frame.h));
    target.width = width; target.height = height; const context = target.getContext("2d"); if (!context) return;
    context.imageSmoothingEnabled = false;
    let index = 0; let timer = 0;
    const draw = () => {
      const frame = clip.frames[index]; context.clearRect(0, 0, width, height);
      // Frames are trimmed to a shared area, so each is drawn bottom-centred as it sits on the ground.
      context.drawImage(sheet.image, frame.x, frame.y, frame.w, frame.h, Math.round((width - frame.w) / 2), height - frame.h, frame.w, frame.h);
      const last = index === clip.frames.length - 1;
      // A one-shot (attack, hurt, death) rests on its last drawing for a moment before playing again.
      timer = window.setTimeout(() => { index = (index + 1) % clip.frames.length; draw(); }, frame.durationMs + (last && clip.loop === false ? 600 : 0));
    };
    draw();
    return () => window.clearTimeout(timer);
  }, [sheet, clipIndex]);
  if (!sheet) return null;
  return <div className="export-player">
    <canvas ref={canvas} aria-label="Animation preview" />
    {sheet.json.clips.length > 1 && !clipId && <div className="export-player-clips" role="tablist" aria-label="Preview animation">
      {sheet.json.clips.map((clip, index) => <button key={clip.id} type="button" role="tab" aria-selected={index === clipIndex} onClick={() => setClipIndex(index)}>{clip.name ?? clip.id}</button>)}
    </div>}
  </div>;
}
