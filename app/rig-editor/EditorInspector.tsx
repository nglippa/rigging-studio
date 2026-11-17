"use client";

import Image from "next/image";
import type { AttachmentDefinition, BoneDefinition, RigDefinition, SlotDefinition } from "@/src/rigging/schema/types";
import type { AttachmentPatch, BonePatch, SlotPatch } from "@/src/tools/rig-editor/document";
import { canReparentBone } from "@/src/tools/rig-editor/document";
import { attachmentIdForSlot, partsForBone, type JointReview } from "@/src/tools/rig-editor/rigReview";
import type { EditorSelection } from "@/src/tools/rig-editor/types";
import { humanizeTechnicalId } from "@/app/studio-ui/humanize";
import { partName } from "./SkeletonTree";

type Props = {
  readonly rig: RigDefinition;
  readonly selection: EditorSelection | null;
  readonly activeSkinId: string;
  readonly jointReview: JointReview | null;
  readonly previewMode: boolean;
  readonly locked: boolean;
  readonly onSelect: (selection: EditorSelection) => void;
  readonly onBonePatch: (id: string, patch: BonePatch, label: string) => void;
  readonly onPivot: (id: string, x: number, y: number) => void;
  readonly onSlotPatch: (id: string, patch: SlotPatch, label: string) => void;
  readonly onAttachmentPatch: (id: string, patch: AttachmentPatch, label: string) => void;
  readonly onRenameSkin: (id: string, name: string) => void;
  readonly onAssignSkin: (skinId: string, slotId: string, attachmentId: string | null) => void;
  readonly onTestRotation: (boneId: string) => void;
  readonly onEditRegion: () => void;
  readonly onFrame: () => void;
  readonly onIsolate: () => void;
};

type NumberFieldProps = { readonly label: string; readonly value: number; readonly step?: number; readonly disabled: boolean; readonly onCommit: (value: number) => void };

function NumberField({ label, value, step = 1, disabled, onCommit }: NumberFieldProps) {
  const commit = (input: HTMLInputElement): void => {
    const number = Number(input.value);
    if (Number.isFinite(number) && number !== value) onCommit(number);
    else input.value = String(value);
  };
  return <label className="inspector-field"><span>{label}</span><input key={`${label}:${value}`} type="number" defaultValue={value} step={step} disabled={disabled} onBlur={(event) => commit(event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

function TextField({ label, value, disabled, onCommit }: { readonly label: string; readonly value: string; readonly disabled: boolean; readonly onCommit: (value: string) => void }) {
  return <label className="inspector-field"><span>{label}</span><input key={`${label}:${value}`} defaultValue={value} disabled={disabled} onBlur={(event) => { const next = event.currentTarget.value.trim(); if (next && next !== value) onCommit(next); else event.currentTarget.value = value; }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

function InspectorHeading({ type, id, name }: { readonly type: string; readonly id: string; readonly name?: string }) {
  return <header className="inspector-heading" title={id}><span>{type}</span><strong>{name ?? humanizeTechnicalId(id)}</strong></header>;
}

/** A named relationship row: the other half of the part ↔ bone link, one click away. */
function LinkRow({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return <div className="inspector-link-row"><span>{label}</span><div>{children}</div></div>;
}

function BoneInspector({ rig, bone, disabled, props }: { readonly rig: RigDefinition; readonly bone: BoneDefinition; readonly disabled: boolean; readonly props: Props }) {
  const parts = partsForBone(rig, bone.id).filter((slot) => attachmentIdForSlot(rig, slot, props.activeSkinId));
  const children = rig.bones.filter((candidate) => candidate.parentId === bone.id);
  const review = props.jointReview;
  const number = (label: string, key: "rotation" | "length" | "scaleX" | "scaleY", step = 1): React.ReactNode => <NumberField key={key} label={label} value={bone[key]} step={step} disabled={disabled} onCommit={(value) => props.onBonePatch(bone.id, { [key]: value }, `Change bone ${key}`)} />;
  return <>
    <InspectorHeading type="Bone" id={bone.id} />
    <p className={`inspector-status ${review?.problem ? "has-problem" : "is-ok"}`} role="status"><i aria-hidden="true">{review?.problem ? "!" : "✓"}</i>{review?.problem ? review.reason : "Valid"}</p>
    <fieldset disabled={disabled}>
      <label className="inspector-field"><span>Parent</span><select value={bone.parentId ?? ""} disabled={disabled || bone.parentId === null} onChange={(event) => props.onBonePatch(bone.id, { parentId: event.target.value }, "Reparent bone")}>
        {bone.parentId === null && <option value="">None (root)</option>}
        {rig.bones.filter((candidate) => candidate.id !== bone.id && canReparentBone(rig, bone.id, candidate.id)).map((candidate) => <option key={candidate.id} value={candidate.id}>{humanizeTechnicalId(candidate.id)}</option>)}
      </select></label>
      <div className="inspector-subsection"><h3>Pivot</h3><div className="inspector-grid">
        <NumberField label="X" value={bone.x} disabled={disabled} onCommit={(value) => props.onPivot(bone.id, value, bone.y)} />
        <NumberField label="Y" value={bone.y} disabled={disabled} onCommit={(value) => props.onPivot(bone.id, bone.x, value)} />
      </div><p className="inspector-hint">Moving the pivot leaves the art where it is. Drag the joint on the canvas to do the same.</p></div>
      <div className="inspector-grid">{number("Rotation", "rotation", 0.5)}{number("Length", "length")}</div>
    </fieldset>
    <LinkRow label={parts.length === 1 ? "Attached part" : "Attached parts"}>
      {parts.length ? parts.map((slot) => <button key={slot.id} type="button" className="inspector-link" title="Select this part" onClick={() => props.onSelect({ type: "slot", id: slot.id })}><i aria-hidden="true">◆</i>{partName(slot.id)}</button>) : <span className={`inspector-link-missing ${children.length ? "" : "is-broken"}`}>{children.length ? "None — this bone only carries its children" : "No art is attached to this bone"}</span>}
    </LinkRow>
    <div className="inspector-actions"><button type="button" onClick={() => props.onTestRotation(bone.id)} title="Open Test with this bone selected and swing it">Test rotation</button></div>
    <details className="inspector-advanced"><summary>Advanced</summary><fieldset disabled={disabled}>
      <div className="inspector-grid">{number("Scale X", "scaleX", 0.05)}{number("Scale Y", "scaleY", 0.05)}</div>
      <label className="inspector-check"><input type="checkbox" checked={bone.inheritRotation} onChange={(event) => props.onBonePatch(bone.id, { inheritRotation: event.target.checked }, "Toggle inherited rotation")} /><span>Inherit rotation</span></label>
      <label className="inspector-check"><input type="checkbox" checked={bone.inheritScale} onChange={(event) => props.onBonePatch(bone.id, { inheritScale: event.target.checked }, "Toggle inherited scale")} /><span>Inherit scale</span></label>
    </fieldset><div className="inspector-actions"><button type="button" onClick={props.onFrame}>Frame</button><button type="button" onClick={props.onIsolate}>Isolate</button></div><p className="inspector-id">{bone.id}</p></details>
  </>;
}

function PartInspector({ rig, slot, disabled, props }: { readonly rig: RigDefinition; readonly slot: SlotDefinition; readonly disabled: boolean; readonly props: Props }) {
  const attachment = rig.attachments.find((candidate) => candidate.id === attachmentIdForSlot(rig, slot, props.activeSkinId));
  const bone = rig.bones.find((candidate) => candidate.id === slot.boneId);
  const broken = !bone ? "This part has no bone, so nothing can move it" : !attachment ? "This part has no art to show" : null;
  return <>
    <InspectorHeading type="Part" id={slot.id} name={partName(slot.id)} />
    <p className={`inspector-status ${broken ? "has-problem" : "is-ok"}`} role="status"><i aria-hidden="true">{broken ? "!" : "✓"}</i>{broken ?? "Linked to a bone"}</p>
    <LinkRow label="Controlled by">
      {bone ? <button type="button" className="inspector-link" title="Select this bone" onClick={() => props.onSelect({ type: "bone", id: bone.id })}><i aria-hidden="true">○</i>{humanizeTechnicalId(bone.id)}</button> : <span className="inspector-link-missing is-broken">No bone</span>}
    </LinkRow>
    <fieldset disabled={disabled}>
      <label className="inspector-field"><span>Change bone</span><select value={slot.boneId} onChange={(event) => props.onSlotPatch(slot.id, { boneId: event.target.value }, "Assign part to bone")}>{rig.bones.map((candidate) => <option key={candidate.id} value={candidate.id}>{humanizeTechnicalId(candidate.id)}</option>)}</select></label>
      <label className="inspector-field"><span>Art</span><select value={slot.attachmentId ?? ""} onChange={(event) => props.onSlotPatch(slot.id, { attachmentId: event.target.value || null }, "Assign part art")}><option value="">None</option>{rig.attachments.map((item) => <option key={item.id} value={item.id}>{humanizeTechnicalId(item.id)}</option>)}</select></label>
      <NumberField label="Layer" value={slot.zIndex} disabled={disabled} onCommit={(value) => props.onSlotPatch(slot.id, { zIndex: Math.round(value) }, "Change part layer")} />
      <label className="inspector-check"><input type="checkbox" checked={slot.visible} onChange={(event) => props.onSlotPatch(slot.id, { visible: event.target.checked }, "Toggle part visibility")} /><span>Visible</span></label>
    </fieldset>
    <div className="inspector-actions"><button type="button" onClick={props.onEditRegion} title="Open Parts to redraw this part's region  (1)">Edit region in Parts</button></div>
    <details className="inspector-advanced"><summary>Advanced</summary><fieldset disabled={disabled}>
      <div className="inspector-grid">
        <NumberField label="Pivot X" value={slot.pivotX} disabled={disabled} onCommit={(value) => props.onSlotPatch(slot.id, { pivotX: value }, "Change part pivot")} />
        <NumberField label="Pivot Y" value={slot.pivotY} disabled={disabled} onCommit={(value) => props.onSlotPatch(slot.id, { pivotY: value }, "Change part pivot")} />
      </div>
      <label className="inspector-field"><span>Blend mode</span><select value={slot.blendMode} onChange={(event) => props.onSlotPatch(slot.id, { blendMode: event.target.value as SlotDefinition["blendMode"] }, "Change blend mode")}><option>normal</option><option>add</option><option>multiply</option><option>screen</option></select></label>
      {attachment && <div className="inspector-subsection"><h3>Art transform</h3><div className="inspector-grid">
        <NumberField label="Position X" value={attachment.offsetX} disabled={disabled} onCommit={(value) => props.onAttachmentPatch(attachment.id, { offsetX: value }, "Change art offset")} />
        <NumberField label="Position Y" value={attachment.offsetY} disabled={disabled} onCommit={(value) => props.onAttachmentPatch(attachment.id, { offsetY: value }, "Change art offset")} />
        <NumberField label="Rotation" value={attachment.rotation} step={0.5} disabled={disabled} onCommit={(value) => props.onAttachmentPatch(attachment.id, { rotation: value }, "Rotate art")} />
        <NumberField label="Scale X" value={attachment.scaleX} step={0.05} disabled={disabled} onCommit={(value) => props.onAttachmentPatch(attachment.id, { scaleX: value }, "Scale art")} />
        <NumberField label="Scale Y" value={attachment.scaleY} step={0.05} disabled={disabled} onCommit={(value) => props.onAttachmentPatch(attachment.id, { scaleY: value }, "Scale art")} />
      </div></div>}
    </fieldset><p className="inspector-id">{slot.id}</p></details>
  </>;
}

function AttachmentInspector({ rig, attachment, disabled, onPatch, onSlotPatch }: { readonly rig: RigDefinition; readonly attachment: AttachmentDefinition; readonly disabled: boolean; readonly onPatch: Props["onAttachmentPatch"]; readonly onSlotPatch: Props["onSlotPatch"] }) {
  const textCommit = (patch: AttachmentPatch, label: string): void => onPatch(attachment.id, patch, label);
  return <>
    <InspectorHeading type="Art" id={attachment.id} />
    <div className="attachment-preview"><Image src={attachment.imagePath} alt={`${attachment.id} art`} width={220} height={110} unoptimized /></div>
    <fieldset disabled={disabled}>
      <label className="inspector-field"><span>Use on part</span><select value="" onChange={(event) => { if (event.target.value) onSlotPatch(event.target.value, { attachmentId: attachment.id }, "Assign art to part"); }}><option value="">Choose part</option>{rig.slots.map((slot) => <option key={slot.id} value={slot.id}>{partName(slot.id)}</option>)}</select></label>
      <div className="inspector-grid">
        <NumberField label="Width" value={attachment.width} disabled={disabled} onCommit={(value) => textCommit({ width: Math.max(1, value) }, "Change art width")} />
        <NumberField label="Height" value={attachment.height} disabled={disabled} onCommit={(value) => textCommit({ height: Math.max(1, value) }, "Change art height")} />
        <NumberField label="Position X" value={attachment.offsetX} disabled={disabled} onCommit={(value) => textCommit({ offsetX: value }, "Change art offset")} />
        <NumberField label="Position Y" value={attachment.offsetY} disabled={disabled} onCommit={(value) => textCommit({ offsetY: value }, "Change art offset")} />
        <NumberField label="Rotation" value={attachment.rotation} step={0.5} disabled={disabled} onCommit={(value) => textCommit({ rotation: value }, "Rotate art")} />
        <NumberField label="Scale X" value={attachment.scaleX} step={0.05} disabled={disabled} onCommit={(value) => textCommit({ scaleX: value }, "Scale art")} />
        <NumberField label="Scale Y" value={attachment.scaleY} step={0.05} disabled={disabled} onCommit={(value) => textCommit({ scaleY: value }, "Scale art")} />
      </div><details className="inspector-advanced"><summary>Advanced</summary><TextField label="Image source" value={attachment.imagePath} disabled={disabled} onCommit={(value) => textCommit({ imagePath: value }, "Change image path")} /><TextField label="Category" value={attachment.category} disabled={disabled} onCommit={(value) => textCommit({ category: value }, "Change art category")} /><TextField label="Tags" value={attachment.tags.join(", ")} disabled={disabled} onCommit={(value) => textCommit({ tags: value.split(",").map((tag) => tag.trim()).filter(Boolean) }, "Change art tags")} /></details>
    </fieldset>
  </>;
}

/** Answers "what can I do to what I just clicked?" and nothing more; everything else is under Advanced. */
export function EditorInspector(props: Props) {
  const disabled = props.previewMode || props.locked;
  const selection = props.selection;
  if (!selection) return <div className="inspector-empty"><strong>Nothing selected</strong><p>Click a bone or a part on the character.</p></div>;
  if (selection.type === "bone") {
    const bone = props.rig.bones.find((candidate) => candidate.id === selection.id);
    return bone ? <BoneInspector rig={props.rig} bone={bone} disabled={disabled} props={props} /> : null;
  }
  if (selection.type === "slot") {
    const slot = props.rig.slots.find((candidate) => candidate.id === selection.id);
    return slot ? <PartInspector rig={props.rig} slot={slot} disabled={disabled} props={props} /> : null;
  }
  if (selection.type === "attachment") {
    const attachment = props.rig.attachments.find((candidate) => candidate.id === selection.id);
    return attachment ? <AttachmentInspector rig={props.rig} attachment={attachment} disabled={disabled} onPatch={props.onAttachmentPatch} onSlotPatch={props.onSlotPatch} /> : null;
  }
  const skin = props.rig.skins.find((candidate) => candidate.id === selection.id);
  if (!skin) return null;
  return <>
    <InspectorHeading type="Look" id={skin.id} name={skin.name} />
    <fieldset disabled={disabled}>
      <TextField label="Name" value={skin.name} disabled={disabled} onCommit={(value) => props.onRenameSkin(skin.id, value)} />
      <div className="inspector-subsection"><h3>Art per part</h3>{props.rig.slots.map((slot) => <label key={slot.id} className="inspector-field"><span>{partName(slot.id)}</span><select value={skin.slotAttachments[slot.id] ?? ""} onChange={(event) => props.onAssignSkin(skin.id, slot.id, event.target.value || null)}><option value="">None</option>{props.rig.attachments.map((attachment) => <option key={attachment.id} value={attachment.id}>{humanizeTechnicalId(attachment.id)}</option>)}</select></label>)}</div>
    </fieldset>
  </>;
}
