"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AnimationDefinition, RigDefinition } from "@/src/rigging/schema/types";
import { BRIDGE_URL, SheetPlayer } from "./SheetPlayer";

export type ExportLook = "rigged" | "redrawn";
export type RedrawMethod = "redraw" | "polish";
export type ClipRedraw =
  | { readonly state: "ready"; readonly sheet: string; readonly json: string }
  | { readonly state: "missing" }
  | { readonly state: "running"; readonly jobId: string; readonly done: number; readonly total: number }
  | { readonly state: "lost"; readonly jobId: string }
  | { readonly state: "failed"; readonly error: string };

/** Studio time per drawing, measured on the Mac Studio: redrawn in its pose about 30 s, polished about 13 s. */
const SECONDS_PER_DRAWING: Readonly<Record<RedrawMethod, number>> = { redraw: 30, polish: 13 };
export const drawingsIn = (clip: AnimationDefinition): number => clip.drawings?.length ?? Math.max(1, Math.round(clip.duration * 12));
export const minutesFor = (clip: AnimationDefinition, method: RedrawMethod): number => Math.max(1, Math.round(drawingsIn(clip) * SECONDS_PER_DRAWING[method] / 60));

/** The look a project exports with, kept on the rig (saved with the project; not part of any redraw's fingerprint). */
export const lookOf = (rig: RigDefinition | null): ExportLook => rig?.metadata.exportLook === "redrawn" ? "redrawn" : "rigged";
/** Clips left out of the export, by id; every clip is in unless listed. */
export const excludedOf = (rig: RigDefinition | null): ReadonlySet<string> => new Set(Array.isArray(rig?.metadata.exportExcluded) ? rig.metadata.exportExcluded.filter((id): id is string => typeof id === "string") : []);

/**
 * Each clip's redraw, from the bridge: what the redraw store already holds for this rig and clip, plus the jobs started
 * here (one per clip), polled until done. A job the bridge no longer knows (it restarted) is "lost", with a retry.
 */
export function useRedraws({ projectId, rig, clips, method, enabled }: { readonly projectId: string | null; readonly rig: RigDefinition | null; readonly clips: readonly AnimationDefinition[]; readonly method: RedrawMethod; readonly enabled: boolean }) {
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Readonly<Record<string, ClipRedraw>>>({});
  const clipsRef = useRef(clips);
  const rigRef = useRef(rig);
  // Kept current for the callbacks and the lookup below (declared first, so it runs before them).
  useEffect(() => { clipsRef.current = clips; rigRef.current = rig; }, [clips, rig]);
  const timers = useRef(new Map<string, number>());
  const clipsKey = clips.map((clip) => `${clip.id}:${clip.duration}:${clip.tracks.length}:${drawingsIn(clip)}`).join("|");

  // What the store holds for the rig and clips as they are now.
  useEffect(() => {
    if (!enabled || !rig || !clipsRef.current.length) return;
    let live = true;
    void (async () => {
      try {
        const ping = await fetch(`${BRIDGE_URL}/studio/queue`, { cache: "no-store" });
        if (!live) return; setReachable(ping.ok);
        if (!ping.ok || !projectId) return;
        const response = await fetch(`${BRIDGE_URL}/bake/redraws/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, rig, animations: clipsRef.current, mode: method }) });
        const found = response.ok ? (await response.json() as { readonly clips?: readonly { readonly id: string; readonly status: string; readonly sheet?: string; readonly json?: string }[] }).clips ?? [] : [];
        if (!live) return;
        setStatus((current) => Object.fromEntries(clipsRef.current.map((clip) => {
          const mine = current[clip.id]; if (mine?.state === "running") return [clip.id, mine];
          const hit = found.find((entry) => entry.id === clip.id);
          return [clip.id, hit?.status === "ready" && hit.sheet && hit.json ? { state: "ready", sheet: hit.sheet, json: hit.json } : { state: "missing" }];
        })));
      } catch { if (live) setReachable(false); }
    })();
    return () => { live = false; };
  }, [enabled, projectId, rig, method, clipsKey]);

  useEffect(() => () => { timers.current.forEach((timer) => window.clearTimeout(timer)); timers.current.clear(); }, []);

  const poll = useCallback((clipId: string, jobId: string): void => {
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(`${BRIDGE_URL}/bake/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        if (response.status === 404) { setStatus((current) => ({ ...current, [clipId]: { state: "lost", jobId } })); return; }
        const job = await response.json() as { readonly status: string; readonly progress?: { readonly done: number; readonly total: number }; readonly error?: string; readonly result?: { readonly sheet: string; readonly json: string } };
        if (job.status === "completed" && job.result) { setStatus((current) => ({ ...current, [clipId]: { state: "ready", sheet: job.result!.sheet, json: job.result!.json } })); return; }
        if (job.status === "failed") { setStatus((current) => ({ ...current, [clipId]: { state: "failed", error: job.error ?? "The redraw failed" } })); return; }
        setStatus((current) => ({ ...current, [clipId]: { state: "running", jobId, done: job.progress?.done ?? 0, total: job.progress?.total ?? 0 } }));
      } catch { setReachable(false); }
      timers.current.set(clipId, window.setTimeout(() => void tick(), 1500));
    };
    void tick();
  }, []);

  /** Starts one redraw job per clip (the ones not already ready or running). */
  const start = useCallback(async (clipIds: readonly string[]): Promise<void> => {
    const source = rigRef.current; if (!source) return;
    for (const id of clipIds) {
      const clip = clipsRef.current.find((candidate) => candidate.id === id); if (!clip) continue;
      try {
        const response = await fetch(`${BRIDGE_URL}/bake/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rig: source, animations: [clip], mode: method, ...(projectId ? { projectId } : {}) }) });
        const job = await response.json() as { readonly jobId?: string; readonly error?: string };
        if (!response.ok || !job.jobId) { setStatus((current) => ({ ...current, [id]: { state: "failed", error: job.error ?? "The redraw could not start" } })); continue; }
        setStatus((current) => ({ ...current, [id]: { state: "running", jobId: job.jobId!, done: 0, total: drawingsIn(clip) } }));
        poll(id, job.jobId);
      } catch { setReachable(false); setStatus((current) => ({ ...current, [id]: { state: "failed", error: "The Mac Studio isn't reachable" } })); }
    }
  }, [method, poll, projectId]);

  return { reachable, status, start };
}
export type Redraws = ReturnType<typeof useRedraws>;

const statusLine = (redraw: ClipRedraw | undefined, clip: AnimationDefinition, method: RedrawMethod): { readonly text: string; readonly tone: "ok" | "busy" | "warn" | "muted" } => {
  if (!redraw || redraw.state === "missing") return { text: `Not yet · ${minutesFor(clip, method)} min`, tone: "muted" };
  if (redraw.state === "ready") return { text: "Redrawn ✓", tone: "ok" };
  if (redraw.state === "running") return { text: `Redrawing ${redraw.done}/${redraw.total || drawingsIn(clip)}…`, tone: "busy" };
  if (redraw.state === "lost") return { text: "Lost: Rigging Studio restarted", tone: "warn" };
  return { text: redraw.error, tone: "warn" };
};

/** Animate's guided panel: the export look, then every animation with its tick box, its redraw status, and a preview click. */
export function AnimateGuidedPanel(props: {
  readonly clips: readonly AnimationDefinition[];
  readonly activeId: string;
  readonly onPreview: (id: string) => void;
  readonly look: ExportLook;
  readonly onLook: (look: ExportLook) => void;
  readonly excluded: ReadonlySet<string>;
  readonly onIncluded: (id: string, included: boolean) => void;
  readonly redraws: Redraws;
  readonly method: RedrawMethod;
  readonly onMethod: (method: RedrawMethod) => void;
  readonly onExpand: () => void;
  readonly facing?: ReactNode;
}) {
  const unreachable = props.redraws.reachable === false;
  return <>
    <p className="panel-label">Look</p>
    <div className="seg" role="group" aria-label="Export look">
      <button type="button" aria-pressed={props.look === "rigged"} onClick={() => props.onLook("rigged")}>Rigged</button>
      <button type="button" aria-pressed={props.look === "redrawn"} disabled={unreachable && props.look !== "redrawn"} title={unreachable ? "The Mac Studio isn't reachable" : "Each drawing redrawn by Comfy on the Mac Studio, in the rig's pose"} onClick={() => props.onLook("redrawn")}>Redrawn</button>
    </div>
    <p className="panel-note">{props.look === "rigged" ? "The rig's own drawings: instant, and every export matches the rig exactly." : unreachable ? "The Mac Studio isn't reachable, so nothing new can be redrawn." : "Comfy redraws each drawing in the rig's pose. Redraws are kept, so each animation is drawn once."}</p>
    {props.facing}
    <p className="panel-label">Animations · click to preview</p>
    {props.clips.map((clip) => {
      const line = statusLine(props.redraws.status[clip.id], clip, props.method);
      const included = !props.excluded.has(clip.id);
      const redraw = props.redraws.status[clip.id];
      return <div key={clip.id} className={`clip-pick ${clip.id === props.activeId ? "is-active" : ""}`}>
        <input type="checkbox" checked={included} aria-label={`Include ${clip.name} in the export`} onChange={(event) => props.onIncluded(clip.id, event.target.checked)} />
        <button type="button" className="clip-pick-name" aria-pressed={clip.id === props.activeId} onClick={() => props.onPreview(clip.id)}>{clip.name}</button>
        {props.look === "redrawn" && <small className={`clip-pick-status tone-${line.tone}`}>{line.text}{redraw && (redraw.state === "lost" || redraw.state === "failed") && <button type="button" className="panel-link" onClick={() => void props.redraws.start([clip.id])}>Retry</button>}</small>}
      </div>;
    })}
    {props.look === "redrawn" && <label className="panel-field"><span>Redraw method</span><select aria-label="Redraw method" value={props.method} onChange={(event) => props.onMethod(event.target.value as RedrawMethod)}><option value="redraw">Pose redraw</option><option value="polish">Polish only</option></select></label>}
    <button type="button" className="panel-link" onClick={props.onExpand}>Edit keyframes manually →</button>
  </>;
}

/** Redrawn look: the rig's clip and its redraw side by side, so the difference shows before anything is exported. */
export function LookCompare({ rigged, clip, redraw }: { readonly rigged: ReactNode; readonly clip: AnimationDefinition; readonly redraw: ClipRedraw | undefined }) {
  return <div className="look-compare">
    <figure><figcaption>Rigged · ▶ {clip.name}</figcaption><div className="look-compare-stage">{rigged}</div></figure>
    <figure><figcaption>Redrawn · ▶ {clip.name}</figcaption><div className="look-compare-stage">{redraw?.state === "ready"
      ? <SheetPlayer sheetUrl={`${BRIDGE_URL}${redraw.sheet}`} jsonUrl={`${BRIDGE_URL}${redraw.json}`} clipId={clip.id} />
      : <p className="look-compare-empty">{redraw?.state === "running" ? `Redrawing ${redraw.done}/${redraw.total}…` : redraw?.state === "lost" ? "Lost: Rigging Studio restarted. Retry from the list." : "Not redrawn yet"}</p>}</div></figure>
  </div>;
}
