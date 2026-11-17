"use client";

import { useMemo } from "react";
import type { RigDefinition } from "@/src/rigging/schema/types";
import { attachmentIdForSlot, isEquipmentId, partsForBone, skeletonRows, type ChainReview } from "@/src/tools/rig-editor/rigReview";
import type { EditorSelection } from "@/src/tools/rig-editor/types";
import { humanizeTechnicalId } from "@/app/studio-ui/humanize";

export type StructureView = "skeleton" | "parts";
export const partName = (slotId: string): string => humanizeTechnicalId(slotId.replace(/-slot$/, ""));

type Props = {
  readonly view: StructureView;
  readonly onView: (view: StructureView) => void;
  readonly rig: RigDefinition;
  readonly activeSkinId: string;
  readonly search: string;
  readonly selections: readonly EditorSelection[];
  readonly review: readonly ChainReview[];
  /** Test and Animate show the skeleton only; parts are edited in Rig. */
  readonly skeletonOnly?: boolean;
  readonly onSelect: (selection: EditorSelection, additive: boolean) => void;
};

/**
 * "What exists" for a rig: the skeleton as a real parent/child tree, or the parts that ride on it.
 * Rows mirror the canvas selection and always show the other half of the part ↔ bone link.
 */
export function SkeletonTree(props: Props) {
  const query = props.search.trim().toLowerCase();
  const rows = useMemo(() => skeletonRows(props.rig), [props.rig]);
  const problems = useMemo(() => new Map(props.review.flatMap((chain) => chain.joints).filter((joint) => joint.problem).map((joint) => [joint.boneId, joint.reason ?? "Needs attention"])), [props.review]);
  const selectedBoneId = props.selections.find((selection) => selection.type === "bone")?.id ?? null;
  const selectedSlot = props.rig.slots.find((slot) => props.selections.some((selection) => selection.type === "slot" && selection.id === slot.id)) ?? null;
  const view = props.skeletonOnly ? "skeleton" : props.view;
  const slots = [...props.rig.slots].sort((a, b) => b.zIndex - a.zIndex).filter((slot) => !query || partName(slot.id).toLowerCase().includes(query));
  const hasArt = (slotId: string): boolean => { const slot = props.rig.slots.find((candidate) => candidate.id === slotId); return Boolean(slot && attachmentIdForSlot(props.rig, slot, props.activeSkinId)); };
  const partRow = (slotId: string, boneId: string) => {
    const boneExists = props.rig.bones.some((bone) => bone.id === boneId);
    const broken = !boneExists || !hasArt(slotId);
    return <button key={slotId} type="button" role="treeitem" aria-selected={selectedSlot?.id === slotId} className={`structure-row is-part ${selectedSlot?.id === slotId ? "is-selected" : ""} ${selectedBoneId === boneId ? "is-linked" : ""} ${broken ? "is-broken" : ""}`} onClick={(event) => props.onSelect({ type: "slot", id: slotId }, event.shiftKey)}>
      <i className="structure-glyph" aria-hidden="true">◆</i><span>{partName(slotId)}</span>
      <small title={broken ? "This part is not linked to both a bone and art" : `Controlled by ${humanizeTechnicalId(boneId)}`}>{!boneExists ? "no bone" : !hasArt(slotId) ? "no art" : humanizeTechnicalId(boneId)}</small>
    </button>;
  };

  return <div className="structure-tree">
    {!props.skeletonOnly && <div className="structure-view-toggle" role="tablist" aria-label="Structure view">
      {(["skeleton", "parts"] as const).map((id) => <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? "is-active" : ""} onClick={() => props.onView(id)}>{id === "skeleton" ? "Skeleton" : "Parts"}<small>{id === "skeleton" ? props.rig.bones.length : props.rig.slots.length}</small></button>)}
    </div>}
    {view === "skeleton" ? <div className="structure-rows" role="tree" aria-label="Skeleton">
      {rows.filter(({ bone }) => !query || humanizeTechnicalId(bone.id).toLowerCase().includes(query)).map(({ bone, depth }) => {
        const parts = partsForBone(props.rig, bone.id).filter((slot) => hasArt(slot.id));
        const problem = problems.get(bone.id);
        const selected = selectedBoneId === bone.id;
        return <button key={bone.id} type="button" role="treeitem" aria-level={depth + 1} aria-selected={selected} className={`structure-row is-bone ${selected ? "is-selected" : ""} ${selectedSlot?.boneId === bone.id ? "is-linked" : ""} ${problem ? "has-problem" : ""}`} style={{ paddingLeft: 10 + (query ? 0 : depth * 14) }} title={problem ?? (parts.length ? `Controls ${parts.map((slot) => partName(slot.id)).join(", ")}` : "No art rides on this bone")} onClick={(event) => props.onSelect({ type: "bone", id: bone.id }, event.shiftKey)}>
          <i className="structure-glyph" aria-hidden="true">{depth === 0 ? "◎" : "○"}</i><span>{humanizeTechnicalId(bone.id)}</span>
          {problem ? <b className="structure-flag" aria-label="Needs attention">!</b> : parts.length ? <small aria-label={`${parts.length} attached ${parts.length === 1 ? "part" : "parts"}`}>◆{parts.length > 1 ? ` ${parts.length}` : ""}</small> : null}
        </button>;
      })}
    </div> : <div className="structure-rows" role="tree" aria-label="Parts">
      {(["Body", "Equipment"] as const).map((group) => {
        const members = slots.filter((slot) => isEquipmentId(`${slot.id} ${slot.attachmentId ?? ""}`) === (group === "Equipment"));
        return members.length ? <div key={group} role="group" aria-label={group}><h3 className="structure-group">{group}<small>{members.length}</small></h3>{members.map((slot) => partRow(slot.id, slot.boneId))}</div> : null;
      })}
      {!slots.length && <p className="structure-empty">{query ? "No part matches" : "No parts yet. Create them in Parts."}</p>}
    </div>}
  </div>;
}
