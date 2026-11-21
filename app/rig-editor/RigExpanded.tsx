"use client";

import type { ReactNode } from "react";
import { ExpandedView } from "@/app/studio-ui/ExpandedView";
import { humanizeTechnicalId } from "@/app/studio-ui/humanize";
import type { Landmark } from "@/src/rigging/editing/snapToLandmark";
import type { BendLimits } from "@/src/rigging/motion/bendLimits";
import type { BoneDefinition, RigDefinition } from "@/src/rigging/schema/types";
import { POSE_TESTS, type PoseTestId } from "@/src/tools/rig-editor/poseTests";
import { attachmentIdForSlot, isEquipmentId, partsForBone, type ChainReview } from "@/src/tools/rig-editor/rigReview";
import { partName } from "./SkeletonTree";

export type RigTool = "move" | "rotate" | "pan";
const POSE_WORDS: Readonly<Record<PoseTestId, string>> = { arm: "Swing arms", leg: "Swing legs", full: "Every joint", equipment: "Equipment" };

type Props = {
  readonly rig: RigDefinition;
  readonly skinId: string;
  readonly review: readonly ChainReview[];
  readonly bone: BoneDefinition | null;
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly onSelectBone: (id: string) => void;
  readonly viewport: ReactNode;
  readonly tool: RigTool;
  readonly onTool: (tool: RigTool) => void;
  readonly toggles: readonly { readonly label: string; readonly on: boolean; readonly onToggle: () => void }[];
  readonly zoom: number;
  readonly onFit: () => void;
  readonly onZoomBy: (factor: number) => void;
  readonly landmark: Landmark | null;
  readonly atLandmark: boolean;
  readonly onSnap: () => void;
  readonly onPivot: (x: number, y: number) => void;
  readonly limits: BendLimits | null;
  /** The range "Set a bend range" starts from (the role default, or ±90°). */
  readonly suggestedLimits: BendLimits;
  readonly onLimits: (limits: BendLimits | null) => void;
  readonly testAngle: number | null;
  readonly onTestAngle: (angle: number | null) => void;
  readonly drawOrder: readonly string[];
  readonly onForward: (slotId: string) => void;
  readonly onBack: (slotId: string) => void;
  readonly onSwapArt: (slotId: string) => void;
  readonly onRecut: (partId: string) => void;
  readonly poses: { readonly available: Readonly<Record<PoseTestId, boolean>>; readonly active: PoseTestId | null; readonly posed: boolean; readonly onTest: (id: PoseTestId | null) => void; readonly onRest: () => void };
  readonly disabled: boolean;
  /** Opens the raw editor: every bone, slot, attachment and skin, with their numbers. */
  readonly advanced: () => void;
  readonly fileActions: ReactNode;
};

const number = (value: number): string => (Math.round(value * 10) / 10).toString();

/** A number field that commits on Enter or when it loses focus, with − and + nudges either side. */
function Nudge({ label, value, step, disabled, onCommit }: { readonly label: string; readonly value: number; readonly step: number; readonly disabled: boolean; readonly onCommit: (value: number) => void }) {
  return <label className="panel-field rig-nudge"><span>{label}</span><span className="rig-nudge-row">
    <button type="button" className="panel-button" disabled={disabled} aria-label={`${label} down ${step}`} onClick={() => onCommit(value - step)}>−</button>
    <input key={value} type="number" className="num" defaultValue={number(value)} disabled={disabled} aria-label={label}
      onBlur={(event) => { const next = event.currentTarget.valueAsNumber; if (Number.isFinite(next) && next !== value) onCommit(next); }}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    <button type="button" className="panel-button" disabled={disabled} aria-label={`${label} up ${step}`} onClick={() => onCommit(value + step)}>+</button>
  </span></label>;
}

/**
 * The Rig step's expanded view: the skeleton grouped like a body on the left, the character with Move joint, Rotate to
 * test and Pan in the centre, and the selected bone alone on the right (its joint, how far it bends, the art it carries,
 * and quick poses).
 */
export function RigExpanded(props: Props) {
  const query = props.search.trim().toLowerCase();
  const art = (boneId: string) => partsForBone(props.rig, boneId).flatMap((slot) => { const attachmentId = attachmentIdForSlot(props.rig, slot, props.skinId); return attachmentId ? [{ slot, attachmentId }] : []; });
  const flagged = new Map(props.review.flatMap((chain) => chain.joints).filter((joint) => joint.problem).map((joint) => [joint.boneId, joint.reason ?? "Needs a look"]));
  const boneCount = props.rig.bones.length;
  const bone = props.bone;
  const carried = bone ? art(bone.id) : [];
  const limits = props.limits;
  return <ExpandedView
    left={<>
      <div className="ex-head"><strong>Skeleton</strong><small>{boneCount} bones</small></div>
      <input className="ex-search" type="search" placeholder="Find a bone…" aria-label="Find a bone" value={props.search} onChange={(event) => props.onSearch(event.target.value)} />
      {props.review.filter((chain) => chain.joints.length).map((chain) => {
        const rows = chain.joints.filter((joint) => !query || humanizeTechnicalId(joint.boneId).toLowerCase().includes(query));
        if (!rows.length) return null;
        const count = chain.joints.filter((joint) => joint.problem).length;
        return <section key={chain.id} className="rig-group" aria-label={chain.label}>
          <h5>{chain.label}<span className={count ? "is-warn" : "is-ok"}>{count ? `${count} to check` : "OK"}</span></h5>
          {rows.map((joint) => {
            const items = art(joint.boneId).filter(({ attachmentId }) => isEquipmentId(attachmentId)).map(({ slot }) => partName(slot.id).toLowerCase());
            return <button key={joint.boneId} type="button" className="ex-item" aria-pressed={bone?.id === joint.boneId} title={flagged.get(joint.boneId)} onClick={() => props.onSelectBone(joint.boneId)}>
              <span>{joint.joint ?? humanizeTechnicalId(joint.boneId)}</span>
              <small className={joint.problem ? "is-warn" : undefined}>{joint.problem ? "check" : items.length ? `+ ${items.join(", ")}` : ""}</small>
            </button>;
          })}
        </section>;
      })}
    </>}
    center={props.viewport}
    tools={<>
      {([["move", "Move joint", "V", "Drag a joint to move where its bone turns"], ["rotate", "Rotate to test", "R", "Drag a bone to see how it bends; the rig is not changed"], ["pan", "Pan", "Space", "Drag to move the view"]] as const).map(([id, label, key, hint]) =>
        <button key={id} type="button" aria-pressed={props.tool === id} title={`${hint} (${key})`} onClick={() => props.onTool(id)}>{label}<kbd>{key}</kbd></button>)}
    </>}
    viewToggles={<>{props.toggles.map((toggle) => <button key={toggle.label} type="button" aria-pressed={toggle.on} onClick={toggle.onToggle}>{toggle.label}</button>)}</>}
    zoom={<>
      <button type="button" title="Fit character (F)" onClick={props.onFit}>Fit</button>
      <button type="button" aria-label="Zoom out" onClick={() => props.onZoomBy(1 / 1.25)}>−</button>
      <span className="num rig-zoom">{Math.round(props.zoom * 100)}%</span>
      <button type="button" aria-label="Zoom in" onClick={() => props.onZoomBy(1.25)}>+</button>
    </>}
    right={bone ? <div className="rig-bone-panel">
      <section className="ex-section"><h5>{humanizeTechnicalId(bone.id)}<span className={flagged.has(bone.id) ? "is-warn" : "is-ok"}>{flagged.has(bone.id) ? "Needs a look" : "OK"}</span></h5>
        {flagged.has(bone.id) && <small className="panel-note">{flagged.get(bone.id)}</small>}
      </section>
      <section className="ex-section"><h5>Joint<span>where it turns</span></h5>
        <Nudge label="X" value={bone.x} step={1} disabled={props.disabled} onCommit={(x) => props.onPivot(x, bone.y)} />
        <Nudge label="Y" value={bone.y} step={1} disabled={props.disabled} onCommit={(y) => props.onPivot(bone.x, y)} />
        <button type="button" className="panel-button" disabled={props.disabled || !props.landmark || props.atLandmark}
          title={!props.landmark ? "No landmark for this bone" : props.atLandmark ? `Already on the ${props.landmark.label}` : `Move the joint back onto the ${props.landmark.label} Build rig found`}
          onClick={props.onSnap}>{props.landmark ? `Snap to ${props.landmark.label}` : "No landmark for this bone"}</button>
      </section>
      <section className="ex-section"><h5>Bends between<span>{limits ? `${number(limits.min)}° and ${number(limits.max)}°` : "any angle"}</span></h5>
        {limits ? <>
          <>
            <Nudge label="Min" value={limits.min} step={5} disabled={props.disabled} onCommit={(min) => props.onLimits({ min: Math.min(min, limits.max), max: limits.max })} />
            <Nudge label="Max" value={limits.max} step={5} disabled={props.disabled} onCommit={(max) => props.onLimits({ min: limits.min, max: Math.max(max, limits.min) })} />
          </>
          <label className="panel-field"><span>Test</span><input type="range" aria-label="Test the bend" min={limits.min} max={limits.max} step={1} value={props.testAngle ?? 0} disabled={props.disabled && props.testAngle === null}
            onChange={(event) => props.onTestAngle(event.target.valueAsNumber)} /></label>
          <div className="ex-buttons">
            <button type="button" className="panel-button" disabled={props.testAngle === null} title={props.testAngle === null ? "Not testing" : "Back to rest"} onClick={() => props.onTestAngle(null)}>Stop test</button>
            <button type="button" className="panel-button" disabled={props.disabled} title="Let this joint turn freely" onClick={() => props.onLimits(null)}>No limit</button>
          </div>
        </> : <button type="button" className="panel-button" disabled={props.disabled} title="Give this joint a range it cannot bend past" onClick={() => props.onLimits(props.suggestedLimits)}>Set a bend range</button>}
      </section>
      <section className="ex-section"><h5>Art on this bone<span>{carried.length || "none"}</span></h5>
        {carried.map(({ slot, attachmentId }) => {
          const place = props.drawOrder.indexOf(slot.id); const total = props.drawOrder.length;
          return <div key={slot.id} className="rig-art">
            <div className="rig-art-head"><strong>{partName(slot.id)}</strong><small>{place === 0 ? "drawn in front of everything" : place === total - 1 ? "drawn behind everything" : `in front of ${partName(props.drawOrder[place + 1])}`}</small></div>
            <div className="ex-buttons">
              <button type="button" className="panel-button" disabled={props.disabled || place <= 0} title={place <= 0 ? "Already in front" : "Draw this part in front of the one above it"} onClick={() => props.onForward(slot.id)}>Bring forward</button>
              <button type="button" className="panel-button" disabled={props.disabled || place >= total - 1} title={place >= total - 1 ? "Already at the back" : "Draw this part behind the one below it"} onClick={() => props.onBack(slot.id)}>Send back</button>
            </div>
            <div className="ex-buttons">
              <button type="button" className="panel-button" disabled={props.disabled} title="Replace this part's image with a file" onClick={() => props.onSwapArt(slot.id)}>Swap art…</button>
              <button type="button" className="panel-button" title="Open this part in the Parts cutter" onClick={() => props.onRecut(attachmentId)}>Recut in Parts</button>
            </div>
          </div>;
        })}
      </section>
      <section className="ex-section"><h5>Try a pose</h5>
        <div className="pose-grid">
          {POSE_TESTS.map((test) => <button key={test.id} type="button" className="panel-button" aria-pressed={props.poses.active === test.id} disabled={!props.poses.available[test.id]} title={props.poses.available[test.id] ? `${test.hint}. The rig is not changed.` : "Nothing to swing for this test"} onClick={() => props.poses.onTest(props.poses.active === test.id ? null : test.id)}>{POSE_WORDS[test.id]}</button>)}
          <button type="button" className="panel-button" disabled={!props.poses.active && !props.poses.posed} title={props.poses.active || props.poses.posed ? "Back to the rest pose" : "Already at rest"} onClick={props.poses.onRest}>Rest</button>
        </div>
      </section>
      <section className="ex-section"><button type="button" className="panel-link" onClick={props.advanced}>Advanced: bones, slots and skins →</button>{props.fileActions}</section>
    </div> : <><p className="panel-note ex-empty">Pick a bone in the skeleton or on the character.</p><section className="ex-section"><button type="button" className="panel-link" onClick={props.advanced}>Advanced: bones, slots and skins →</button>{props.fileActions}</section></>}
  />;
}
