"use client";

import { useEffect, useMemo, useState } from "react";
import { needsArtRebuild } from "@/src/character-generation/rigging/rigProposalBuilder";
import { analyzeRigAnatomy, type RigFacing } from "@/src/rigging/motion/rigMotion";
import type { RigDefinition } from "@/src/rigging/schema/types";

const declaredFacing = (rig: RigDefinition): RigFacing | null => rig.metadata.facing === "left" || rig.metadata.facing === "right" || rig.metadata.facing === "front" ? rig.metadata.facing : null;

/** What the art alone says about facing, ignoring any choice already made. */
export function useDetectedFacing(rig: RigDefinition): { readonly facing: RigFacing; readonly unsure: boolean } {
  return useMemo(() => {
    try { const rest = { ...rig.metadata }; delete rest.facing; const anatomy = analyzeRigAnatomy({ ...rig, metadata: rest }); return { facing: anatomy.facing, unsure: anatomy.facingCertainty === "unsure" }; }
    catch { return { facing: "front" as RigFacing, unsure: true }; }
  }, [rig]);
}

export { needsArtRebuild };

/** Asks once which way the character faces, when the art cannot settle it and nobody has chosen. */
export function FacingQuestion({ rig, onFacing }: { readonly rig: RigDefinition; readonly onFacing: (facing: RigFacing) => void }) {
  const detected = useDetectedFacing(rig);
  if (declaredFacing(rig) || !detected.unsure) return null;
  return <div className="facing-ask" role="group" aria-label="Which way does this character face?">
    <p>Which way does this character face? Walk, run and the other clips move toward it.</p>
    <div>{(["left", "front", "right"] as const).map((option) => <button key={option} type="button" className={option === detected.facing ? "is-suggested" : undefined} onClick={() => onFacing(option)}>{option === "left" ? "← Left" : option === "right" ? "Right →" : "Front"}</button>)}</div>
  </div>;
}

/** One line offering to rebuild a rig whose part art predates gap filling. Nothing changes unless it is clicked. */
export function RebuildNotice({ rig, onRebuild }: { readonly rig: RigDefinition; readonly onRebuild: () => void }) {
  if (!needsArtRebuild(rig)) return null;
  return <div className="rebuild-notice" role="status">
    <span>This rig was built before gap filling, so joints can open and hidden areas show through when parts move.</span>
    <button type="button" onClick={onRebuild}>Rebuild</button>
  </div>;
}

/** Asks Parts to rebuild this character's rig when it next opens. Session-scoped and tied to the project, so it cannot fire for another character. */
export const REBUILD_REQUEST_KEY = "rigging-studio-rebuild-request";
/** Rig's "Recut in Parts": the part to open in the expanded cutter when Parts next loads. */
export const RECUT_PART_KEY = "rigging-studio-recut-part";
export type RebuildRequest = { readonly projectId: string; readonly repaint: boolean };
export const writeRebuildRequest = (request: RebuildRequest): void => {
  try { window.sessionStorage.setItem(REBUILD_REQUEST_KEY, JSON.stringify(request)); } catch { /* storage unavailable: Parts opens without rebuilding */ }
};
export function parseRebuildRequest(raw: string | null): RebuildRequest | null {
  if (raw === null) return null;
  try { const value = JSON.parse(raw) as Partial<RebuildRequest>; if (typeof value.projectId === "string") return { projectId: value.projectId, repaint: value.repaint === true }; } catch { /* an older plain project id */ }
  return { projectId: raw, repaint: false };
}

const BRIDGE = (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_RIGGING_STUDIO_BRIDGE_URL : undefined) ?? "http://127.0.0.1:47831";
/** Whether the bridge reports a working inpainting workflow. Checked once per mount; false while unknown. */
function useRepaintAvailable(enabled: boolean): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    type Status = { readonly capabilities?: readonly { readonly capability?: string; readonly capabilityAvailable?: boolean }[] };
    void fetch(`${BRIDGE}/image-production/status`).then((response) => response.ok ? response.json() as Promise<Status> : null).then((status) => {
      if (!cancelled) setAvailable(Boolean(status?.capabilities?.some((item) => item.capability === "OCCLUSION_RECONSTRUCTION" && item.capabilityAvailable)));
    }).catch(() => { if (!cancelled) setAvailable(false); });
    return () => { cancelled = true; };
  }, [enabled]);
  return available;
}

type RepaintRecord = { readonly parts?: readonly { readonly partId: string; readonly status: string; readonly reason?: string }[] };
const SECONDS_PER_REPAINT = 45;

/**
 * Offers to repaint the hidden areas the build filled in from surrounding art, using the inpainting model on the
 * Mac Studio. Shown only when there is something to repaint, the image is large enough for the model, the model is
 * reachable, and it has not been done (or it failed and can be retried).
 */
export function RepaintNotice({ rig, onRepaint }: { readonly rig: RigDefinition; readonly onRepaint: () => void }) {
  const filled = Array.isArray(rig.metadata.filledParts) ? rig.metadata.filledParts.filter((value): value is string => typeof value === "string") : [];
  const record = rig.metadata.hiddenAreaRepaint as RepaintRecord | undefined;
  const failed = record?.parts?.filter((part) => part.status === "failed") ?? [];
  const done = Boolean(record) && failed.length === 0;
  const largeEnough = Math.min(rig.canvas.width, rig.canvas.height) >= 256;
  const wanted = filled.length > 0 && !done && largeEnough && !needsArtRebuild(rig);
  const available = useRepaintAvailable(wanted);
  if (!wanted || !available) return null;
  const count = failed.length || filled.length;
  const minutes = Math.max(1, Math.round(count * SECONDS_PER_REPAINT / 60));
  return <div className="rebuild-notice repaint-notice" role="status">
    <span>{failed.length
      ? `The repaint failed for ${failed.length === 1 ? "one part" : `${failed.length} parts`} (${failed[0].reason ?? "no reason given"}); the built-in fill is shown.`
      : `${count === 1 ? "One part has" : `${count} parts have`} hidden areas filled in from the surrounding art. Repaint them with the inpainting model on the Mac Studio (about ${minutes} min)?`}</span>
    <button type="button" onClick={onRepaint}>{failed.length ? "Try again" : "Repaint"}</button>
  </div>;
}
