"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ExpandedView } from "@/app/studio-ui/ExpandedView";
import type { AnimationDefinition, RigDefinition } from "@/src/rigging/schema/types";
import { drawingsIn, type ExportLook, type Redraws } from "./AnimateGuided";
import { BRIDGE_URL, SheetPlayer } from "./SheetPlayer";

export type ExportFormat = "sheet" | "live";
type Sheet = { readonly jobId: string; readonly sheet: string; readonly json: string };
type BakeJob = { readonly jobId: string; readonly status: string; readonly error?: string; readonly result?: { readonly sheet: string; readonly json: string } };

const fileName = (rig: RigDefinition): string => String(rig.metadata?.name ?? rig.id).replace(/[^\w-]+/g, "-");
const saveText = (name: string, text: string): void => { const url = URL.createObjectURL(new Blob([text], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); };
/** The bridge sends bake files as attachments, so following the link saves them. */
const saveFrom = (url: string): void => { const link = document.createElement("a"); link.href = url; link.rel = "noopener"; link.click(); };
const jobOf = (sheetUrl: string): string | null => /\/bake\/assets\/([^/]+)\/sheet\.png$/.exec(sheetUrl)?.[1] ?? null;

async function waitForJob(jobId: string, live: () => boolean): Promise<BakeJob> {
  for (;;) {
    const response = await fetch(`${BRIDGE_URL}/bake/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
    if (response.status === 404) throw new Error("The bake was lost when Rigging Studio restarted. Try again.");
    const job = await response.json() as BakeJob;
    if (job.status === "completed" || job.status === "failed" || !live()) return job;
    await new Promise((resolve) => window.setTimeout(resolve, 600));
  }
}

/**
 * The Export step: what will be saved, previewed as it will play, and one button that saves it. A sprite sheet follows
 * the look chosen in Animate: the rig's own drawings (baked on the spot), or the stored redraws combined into one sheet,
 * which waits until every included animation is redrawn. The live rig saves the rig and its animations as JSON.
 */
export function useExportStep({ rig, clips, look, redraws, active }: { readonly rig: RigDefinition | null; readonly clips: readonly AnimationDefinition[]; readonly look: ExportLook; readonly redraws: Redraws; readonly active: boolean }) {
  const [format, setFormat] = useState<ExportFormat>("sheet");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [polish, setPolish] = useState<{ readonly state: "idle" | "running" | "done" | "failed"; readonly sheet?: Sheet; readonly error?: string }>({ state: "idle" });
  const clipsRef = useRef(clips); const rigRef = useRef(rig);
  useEffect(() => { clipsRef.current = clips; rigRef.current = rig; }, [clips, rig]);
  const key = `${look}|${clips.map((clip) => `${clip.id}:${drawingsIn(clip)}:${clip.tracks.length}`).join(",")}`;
  const ready = clips.map((clip) => redraws.status[clip.id]).filter((status) => status?.state === "ready");
  const missing = look === "redrawn" ? clips.filter((clip) => redraws.status[clip.id]?.state !== "ready") : [];
  const redrawJobs = look === "redrawn" && !missing.length ? clips.map((clip) => { const status = redraws.status[clip.id]; return status?.state === "ready" ? jobOf(status.sheet) : null; }) : [];
  const redrawKey = redrawJobs.join(",");

  // Make the sheet the button will save, so it can be previewed first: the rig's drawings, or the redraws combined.
  useEffect(() => {
    if (!active || format !== "sheet" || !rigRef.current || !clipsRef.current.length || redraws.reachable === false) return;
    if (look === "redrawn" && (!redrawKey || redrawKey.split(",").some((id) => !id))) return;
    let live = true;
    void (async () => {
      setBusy(true); setError(null); setSheet(null);
      try {
        const response = look === "redrawn"
          ? await fetch(`${BRIDGE_URL}/bake/combine`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobIds: [...new Set(redrawKey.split(","))], clipIds: clipsRef.current.map((clip) => clip.id) }) })
          : await fetch(`${BRIDGE_URL}/bake/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rig: rigRef.current, animations: clipsRef.current, mode: "rig" }) });
        const started = await response.json() as BakeJob;
        if (!response.ok || !started.jobId) throw new Error(started.error ?? "The sprite sheet could not be made");
        const job = started.status === "completed" ? started : await waitForJob(started.jobId, () => live);
        if (!live) return;
        if (job.status !== "completed" || !job.result) throw new Error(job.error ?? "The sprite sheet could not be made");
        setSheet({ jobId: job.jobId, sheet: job.result.sheet, json: job.result.json });
      } catch (reason: unknown) { if (live) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { if (live) setBusy(false); }
    })();
    return () => { live = false; };
  }, [active, format, look, key, redrawKey, redraws.reachable]);

  const save = useCallback((): void => {
    const source = rigRef.current; if (!source) return;
    if (format === "live") { saveText(`${fileName(source)}.rig.json`, JSON.stringify(source, null, 2)); saveText(`${fileName(source)}.animations.json`, JSON.stringify({ rigId: source.id, animations: clipsRef.current }, null, 2)); return; }
    if (!sheet) return;
    saveFrom(`${BRIDGE_URL}${sheet.sheet}`); window.setTimeout(() => saveFrom(`${BRIDGE_URL}${sheet.json}`), 300);
  }, [format, sheet]);

  const startPolish = useCallback(async (): Promise<void> => {
    const source = rigRef.current; if (!source) return;
    setPolish({ state: "running" });
    try {
      const response = await fetch(`${BRIDGE_URL}/bake/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rig: source, animations: clipsRef.current, mode: "polish" }) });
      const started = await response.json() as BakeJob; if (!response.ok || !started.jobId) throw new Error(started.error ?? "The polish could not start");
      const job = await waitForJob(started.jobId, () => true);
      if (job.status !== "completed" || !job.result) throw new Error(job.error ?? "The polish failed");
      setPolish({ state: "done", sheet: { jobId: job.jobId, sheet: job.result.sheet, json: job.result.json } });
    } catch (reason: unknown) { setPolish({ state: "failed", error: reason instanceof Error ? reason.message : String(reason) }); }
  }, []);

  const drawings = clips.reduce((sum, clip) => sum + drawingsIn(clip), 0);
  const unreachable = redraws.reachable === false;
  const primary = format === "live"
    ? { label: "Download live rig", onClick: save, disabled: !clips.length, disabledReason: "Tick at least one animation in Animate" }
    : { label: "Download sprite sheet", onClick: save, busy: busy && !sheet,
      disabled: !clips.length || unreachable || missing.length > 0 || !sheet,
      disabledReason: !clips.length ? "Tick at least one animation in Animate" : unreachable ? "The Mac Studio bridge isn't reachable; the live rig still downloads" : missing.length ? `${missing.length} ${missing.length === 1 ? "animation isn't" : "animations aren't"} redrawn yet; finish them in Animate` : error ?? "Making the sheet…" };
  const instruction = error ?? (format === "live" ? `The rig and ${clips.length} animations as JSON, for an engine that plays skeletal animation.`
    : unreachable ? "The Mac Studio bridge isn't reachable, so no sprite sheet can be made. The live rig still downloads."
    : missing.length ? `${missing.length} of ${clips.length} animations aren't redrawn yet. Finish them in Animate, or export the Rigged look.`
    : sheet ? `${clips.length} animations, ${drawings} drawings, ${look === "redrawn" ? "redrawn" : "as rigged"}. Download when it looks right.` : "Making the sprite sheet…");

  const preview: ReactNode = format === "live"
    ? <p className="export-stage-note">The live rig has no sheet to preview: your engine plays the bones. Animate shows how it moves.</p>
    : sheet ? <SheetPlayer key={sheet.jobId} sheetUrl={`${BRIDGE_URL}${sheet.sheet}`} jsonUrl={`${BRIDGE_URL}${sheet.json}`} />
    : <p className="export-stage-note">{unreachable ? "The Mac Studio bridge isn't reachable." : missing.length ? `Waiting on ${missing.map((clip) => clip.name).join(", ")}.` : error ?? "Making the sprite sheet…"}</p>;

  const panel = (onExpand: () => void): ReactNode => <>
    <p className="panel-label">Format</p>
    <div className="seg" role="group" aria-label="Export format">
      <button type="button" aria-pressed={format === "sheet"} onClick={() => setFormat("sheet")}>Sprite sheet</button>
      <button type="button" aria-pressed={format === "live"} onClick={() => setFormat("live")}>Live rig</button>
    </div>
    <p className="panel-note">{format === "sheet" ? `A PNG of every drawing and a JSON of timings, ${look === "redrawn" ? "in the redrawn look" : "as the rig draws them"} (the look is chosen in Animate).` : "The bones, parts and animations as JSON. Gear stays swappable; nothing is baked."}</p>
    <p className="panel-label">Included<span className="panel-label-aside">{drawings} drawings</span></p>
    {clips.map((clip) => { const status = look === "redrawn" && format === "sheet" ? redraws.status[clip.id] : undefined; return <div key={clip.id} className="panel-row"><span>{clip.name}</span><span className={status && status.state !== "ready" ? "is-warn" : "is-muted"}>{status ? (status.state === "ready" ? "redrawn" : "not redrawn") : `${drawingsIn(clip)} drawings`}</span></div>; })}
    {!clips.length && <p className="panel-note">Nothing is ticked in Animate.</p>}
    <button type="button" className="panel-link" onClick={onExpand}>Sheet layout · Polish-only option →</button>
  </>;

  const expanded = (): ReactNode => <ExpandedView
    left={<><div className="ex-head"><strong>Included</strong><small>{clips.length}</small></div>{clips.map((clip) => <div key={clip.id} className="ex-item"><span>{clip.name}</span><small>{drawingsIn(clip)}</small></div>)}</>}
    center={<div className="export-stage">{preview}</div>}
    tools={<span className="export-tools-label">{format === "live" ? "Live rig" : `Sprite sheet · ${look === "redrawn" ? "redrawn" : "as rigged"}`}</span>}
    right={<>
      <section className="ex-section"><h5>Sheet layout</h5><p className="panel-note">One row per animation and one cell per drawing, every cell the same size and trimmed to the area the drawings use, so the pivot holds still. The JSON gives each cell, its timing and the pivot to place at the character&rsquo;s position.</p></section>
      <section className="ex-section"><h5>Polish only<span>about {Math.max(1, Math.round(drawings * 13 / 60))} min</span></h5>
        <p className="panel-note">Keeps the rig&rsquo;s drawings and only cleans seams and broken lines on the Mac Studio. Lighter than a redraw; the pose never changes.</p>
        <button type="button" className="panel-button" disabled={unreachable || polish.state === "running" || !clips.length} title={unreachable ? "The Mac Studio isn't reachable" : undefined} onClick={() => void startPolish()}>{polish.state === "running" ? "Polishing…" : "Make a polished sheet"}</button>
        {polish.state === "failed" && <small className="panel-note is-warn">{polish.error}</small>}
        {polish.state === "done" && polish.sheet && <><SheetPlayer sheetUrl={`${BRIDGE_URL}${polish.sheet.sheet}`} jsonUrl={`${BRIDGE_URL}${polish.sheet.json}`} /><div className="ex-buttons"><button type="button" className="panel-button" onClick={() => { saveFrom(`${BRIDGE_URL}${polish.sheet!.sheet}`); window.setTimeout(() => saveFrom(`${BRIDGE_URL}${polish.sheet!.json}`), 300); }}>Download polished sheet</button></div></>}
      </section>
    </>}
  />;

  return { format, preview, panel, expanded, primary, instruction, ready: ready.length };
}
