"use client";

import { useMemo } from "react";
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
