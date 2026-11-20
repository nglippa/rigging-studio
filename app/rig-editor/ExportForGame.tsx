"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AnimationDefinition, RigDefinition } from "@/src/rigging/schema/types";

const BRIDGE_URL = process.env.NEXT_PUBLIC_RIGGING_STUDIO_BRIDGE_URL ?? "http://127.0.0.1:47831";
/** Studio time per polished drawing, measured on the Mac Studio (Klein 4B, 4 steps): about 13 s. */
const SECONDS_PER_POLISHED_DRAWING = 13;
/** Studio time per drawing redrawn in its pose (Klein 4B, 4 steps, pose LoRA, two references), measured on the Studio. */
const SECONDS_PER_REDRAWN_DRAWING = 30;

type Path = "live" | "rig" | "polish" | "redraw";
type BakeJob = {
  readonly jobId: string; readonly status: "queued" | "running" | "completed" | "failed"; readonly progress: { readonly done: number; readonly total: number; readonly clip: string | null };
  readonly waiting?: string; readonly error?: string;
  readonly result?: { readonly sheet: string; readonly json: string; readonly drawings: number; readonly polished: number; readonly keptFromRig: number };
};

type SheetFrame = { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly durationMs: number };
type SheetJson = { readonly cell: { readonly width: number; readonly height: number }; readonly clips: readonly { readonly id: string; readonly name?: string; readonly loop?: boolean; readonly frames: readonly SheetFrame[] }[] };

/**
 * The baked sheet played back at its own timing, one clip at a time, so the motion can be judged before downloading (a
 * still sheet shows the drawings but not the holds and smears that make it read as drawn).
 */
function SheetPlayer({ sheetUrl, jsonUrl }: { readonly sheetUrl: string; readonly jsonUrl: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [sheet, setSheet] = useState<{ readonly json: SheetJson; readonly image: HTMLImageElement } | null>(null);
  const [clipIndex, setClipIndex] = useState(0);
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
    {sheet.json.clips.length > 1 && <div className="export-player-clips" role="tablist" aria-label="Preview animation">
      {sheet.json.clips.map((clip, index) => <button key={clip.id} type="button" role="tab" aria-selected={index === clipIndex} onClick={() => setClipIndex(index)}>{clip.name ?? clip.id}</button>)}
    </div>}
  </div>;
}

const drawingCount = (clip: AnimationDefinition) => clip.drawings?.length ?? Math.max(1, Math.round(clip.duration * 12));

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Export for a game, three ways. The live rig (bones and parts, for an engine that plays skeletal animation and swaps gear),
 * or a sprite sheet of the drawings: as the rig draws them (instant), or each drawing redrawn on the Mac Studio so it reads
 * as hand-drawn pixel animation (slower; the rig's drawing is kept wherever a redraw strays).
 */
export function ExportForGame({ open, rig, animations, onClose }: { readonly open: boolean; readonly rig: RigDefinition | null; readonly animations: readonly AnimationDefinition[]; readonly onClose: () => void }) {
  const [path, setPath] = useState<Path>("redraw");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [job, setJob] = useState<BakeJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const polling = useRef(0);
  useEffect(() => () => window.clearTimeout(polling.current), []);
  // A finished bake's preview lands below the choices; bring it into view rather than leave it under the fold.
  const result = useRef<HTMLDivElement>(null);
  const finished = job?.status === "completed";
  useEffect(() => { if (finished) result.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [finished]);
  const selected = useMemo(() => animations.filter((clip) => chosen.size === 0 || chosen.has(clip.id)), [animations, chosen]);
  const drawings = selected.reduce((sum, clip) => sum + drawingCount(clip), 0);
  if (!open) return null;
  const busy = job?.status === "queued" || job?.status === "running";

  const poll = (jobId: string) => {
    polling.current = window.setTimeout(async () => {
      try {
        const response = await fetch(`${BRIDGE_URL}/bake/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        // Jobs live in the bridge's memory: after a restart the job is gone, and its error body is not a job.
        if (response.status === 404) { setJob(null); setError("The bake was lost when Rigging Studio's bridge restarted. Start it again."); return; }
        const next = await response.json() as BakeJob;
        setJob(next); if (next.status === "queued" || next.status === "running") poll(jobId); else if (next.error) setError(next.error);
      } catch { poll(jobId); }
    }, 1500);
  };
  const start = async () => {
    setError(null);
    if (!rig) { setError("Build the rig first"); return; }
    if (path === "live") {
      const name = String(rig.metadata?.name ?? rig.id).replace(/[^\w-]+/g, "-");
      download(`${name}.rig.json`, JSON.stringify(rig, null, 2));
      download(`${name}.animations.json`, JSON.stringify({ rigId: rig.id, animations: selected }, null, 2));
      return;
    }
    try {
      const response = await fetch(`${BRIDGE_URL}/bake/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rig, animations: selected, mode: path }) });
      const started = await response.json() as BakeJob & { readonly error?: string };
      if (!response.ok || !started.jobId) throw new Error(started.error ?? "The bake could not start");
      setJob(started); poll(started.jobId);
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const toggle = (id: string) => setChosen((current) => { const next = new Set(current.size ? current : animations.map((clip) => clip.id)); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const minutes = Math.max(1, Math.round(drawings * SECONDS_PER_POLISHED_DRAWING / 60));
  const redrawMinutes = Math.max(1, Math.round(drawings * SECONDS_PER_REDRAWN_DRAWING / 60));

  return <div className="studio-dialog-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="studio-dialog export-for-game" role="dialog" aria-modal="true" aria-labelledby="export-for-game-title">
      <header><span>Export</span><button type="button" aria-label="Close" onClick={onClose}>×</button></header>
      <div className="studio-dialog-body">
        <h2 id="export-for-game-title">Export for a game</h2>
        <fieldset className="export-paths" disabled={busy}>
          <legend className="sr-only">How to export</legend>
          <label><input type="radio" name="export-path" checked={path === "redraw"} onChange={() => setPath("redraw")} /><span><strong>Sprite sheet, redrawn in each pose</strong><small>The Mac Studio draws the character afresh in every pose from the rig's skeleton, as an artist redraws each frame. Slowest: about {redrawMinutes} min for {drawings} drawings.</small></span></label>
          <label><input type="radio" name="export-path" checked={path === "polish"} onChange={() => setPath("polish")} /><span><strong>Sprite sheet, polished</strong><small>Each rig drawing is cleaned up on the Mac Studio: seams and broken lines redrawn, pose unchanged. About {minutes} min for {drawings} drawings.</small></span></label>
          <label><input type="radio" name="export-path" checked={path === "rig"} onChange={() => setPath("rig")} /><span><strong>Sprite sheet, as rigged</strong><small>The drawings exactly as the rig plays them. Instant.</small></span></label>
          <label><input type="radio" name="export-path" checked={path === "live"} onChange={() => setPath("live")} /><span><strong>Live rig</strong><small>Bones and parts, for an engine that plays skeletal animation. Keeps gear swappable; nothing is baked.</small></span></label>
        </fieldset>
        <fieldset className="export-clips" disabled={busy}>
          <legend>Animations</legend>
          {animations.map((clip) => <label key={clip.id}><input type="checkbox" checked={chosen.size === 0 || chosen.has(clip.id)} onChange={() => toggle(clip.id)} /><span>{clip.name}</span><small>{drawingCount(clip)} drawings</small></label>)}
        </fieldset>
        {job && <div className="export-progress" role="status" ref={result}>
          {job.status === "completed" && job.result
            ? <><p>Done: {job.result.drawings} drawings{path === "polish" || path === "redraw" ? `, ${job.result.polished} redrawn${job.result.keptFromRig ? `, ${job.result.keptFromRig} kept from the rig where the redraw strayed` : ""}` : ""}.</p>
              <SheetPlayer sheetUrl={`${BRIDGE_URL}${job.result.sheet}`} jsonUrl={`${BRIDGE_URL}${job.result.json}`} />
              <img className="export-preview" src={`${BRIDGE_URL}${job.result.sheet}`} alt="Baked sprite sheet" />
              <p className="export-downloads"><a href={`${BRIDGE_URL}${job.result.sheet}`} download>Download sheet (PNG)</a><a href={`${BRIDGE_URL}${job.result.json}`} download>Download frames (JSON)</a></p></>
            : <><progress max={Math.max(1, job.progress.total)} value={job.progress.done} /><p>{job.waiting ? `Waiting for the Mac Studio: ${job.waiting}` : `${job.progress.done} of ${job.progress.total} drawings${job.progress.clip ? ` · ${job.progress.clip}` : ""}`}</p></>}
        </div>}
        {error && <p className="export-error" role="alert">{error}</p>}
      </div>
      <footer><button type="button" onClick={onClose} disabled={busy}>Close</button><button type="button" className="primary" disabled={busy || !selected.length} onClick={() => void start()}>{path === "live" ? "Download rig" : busy ? "Baking…" : "Bake sprite sheet"}</button></footer>
    </section>
  </div>;
}
