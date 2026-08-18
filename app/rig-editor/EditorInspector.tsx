"use client";

import Image from "next/image";
import type { AttachmentDefinition, BoneDefinition, RigDefinition, SlotDefinition } from "@/src/rigging/schema/types";
import type { AttachmentPatch, BonePatch, SlotPatch } from "@/src/tools/rig-editor/document";
import { canReparentBone } from "@/src/tools/rig-editor/document";
import type { EditorSelection } from "@/src/tools/rig-editor/types";
import { humanizeTechnicalId } from "@/app/studio-ui/humanize";

type Props = {
  readonly rig: RigDefinition;
  readonly selection: EditorSelection | null;
  readonly previewMode: boolean;
  readonly locked: boolean;
  readonly onBonePatch: (id: string, patch: BonePatch, label: string) => void;
  readonly onSlotPatch: (id: string, patch: SlotPatch, label: string) => void;
  readonly onAttachmentPatch: (id: string, patch: AttachmentPatch, label: string) => void;
  readonly onRenameSkin: (id: string, name: string) => void;
  readonly onAssignSkin: (skinId: string, slotId: string, attachmentId: string | null) => void;
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

function BoneInspector({ rig, bone, disabled, onPatch }: { readonly rig: RigDefinition; readonly bone: BoneDefinition; readonly disabled: boolean; readonly onPatch: Props["onBonePatch"] }) {
  const number = (label: string, key: "x" | "y" | "rotation" | "scaleX" | "scaleY" | "length", step = 1): React.ReactNode => <NumberField key={key} label={label} value={bone[key]} step={step} disabled={disabled} onCommit={(value) => onPatch(bone.id, { [key]: value }, `Change bone ${key}`)} />;
  return <>
    <InspectorHeading type="Bone" id={bone.id} />
    <fieldset disabled={disabled}>
      <label className="inspector-field"><span>Connected To</span><select value={bone.parentId ?? ""} disabled={disabled || bone.parentId === null} onChange={(event) => onPatch(bone.id, { parentId: event.target.value }, "Reparent bone")}>
        {bone.parentId === null && <option value="">Root</option>}
        {rig.bones.filter((candidate) => candidate.id !== bone.id && canReparentBone(rig, bone.id, candidate.id)).map((candidate) => <option key={candidate.id} value={candidate.id}>{humanizeTechnicalId(candidate.id)}</option>)}
      </select></label>
      <div className="inspector-grid">{number("X", "x")}{number("Y", "y")}{number("Rotation", "rotation", 0.5)}{number("Length", "length")}{number("Scale X", "scaleX", 0.05)}{number("Scale Y", "scaleY", 0.05)}</div>
      <label className="inspector-check"><input type="checkbox" checked={bone.inheritRotation} onChange={(event) => onPatch(bone.id, { inheritRotation: event.target.checked }, "Toggle inherited rotation")} /><span>Inherit rotation</span></label>
      <label className="inspector-check"><input type="checkbox" checked={bone.inheritScale} onChange={(event) => onPatch(bone.id, { inheritScale: event.target.checked }, "Toggle inherited scale")} /><span>Inherit scale</span></label>
    </fieldset>
  </>;
}

function SlotInspector({ rig, slot, disabled, onPatch, onAttachmentPatch }: { readonly rig: RigDefinition; readonly slot: SlotDefinition; readonly disabled: boolean; readonly onPatch: Props["onSlotPatch"]; readonly onAttachmentPatch: Props["onAttachmentPatch"] }) {
  const attachment = rig.attachments.find((candidate) => candidate.id === slot.attachmentId);
  return <>
    <InspectorHeading type="Slot" id={slot.id} />
    <fieldset disabled={disabled}>
      <label className="inspector-field"><span>Connected To</span><select value={slot.boneId} onChange={(event) => onPatch(slot.id, { boneId: event.target.value }, "Assign slot bone")}>{rig.bones.map((bone) => <option key={bone.id} value={bone.id}>{humanizeTechnicalId(bone.id)}</option>)}</select></label>
      <label className="inspector-field"><span>Displayed Part</span><select value={slot.attachmentId ?? ""} onChange={(event) => onPatch(slot.id, { attachmentId: event.target.value || null }, "Assign slot attachment")}><option value="">None</option>{rig.attachments.map((item) => <option key={item.id} value={item.id}>{humanizeTechnicalId(item.id)}</option>)}</select></label>
      <div className="inspector-grid">
        <NumberField label="Layer Order" value={slot.zIndex} disabled={disabled} onCommit={(value) => onPatch(slot.id, { zIndex: Math.round(value) }, "Change slot order")} />
        <NumberField label="Pivot X" value={slot.pivotX} disabled={disabled} onCommit={(value) => onPatch(slot.id, { pivotX: value }, "Change slot pivot")} />
        <NumberField label="Pivot Y" value={slot.pivotY} disabled={disabled} onCommit={(value) => onPatch(slot.id, { pivotY: value }, "Change slot pivot")} />
      </div>
      <label className="inspector-field"><span>Blend mode</span><select value={slot.blendMode} onChange={(event) => onPatch(slot.id, { blendMode: event.target.value as SlotDefinition["blendMode"] }, "Change blend mode")}><option>normal</option><option>add</option><option>multiply</option><option>screen</option></select></label>
      <label className="inspector-check"><input type="checkbox" checked={slot.visible} onChange={(event) => onPatch(slot.id, { visible: event.target.checked }, "Toggle slot visibility")} /><span>Visible</span></label>
      {attachment && <div className="inspector-subsection"><h3>Attachment transform</h3><div className="inspector-grid">
        <NumberField label="Position X" value={attachment.offsetX} disabled={disabled} onCommit={(value) => onAttachmentPatch(attachment.id, { offsetX: value }, "Change attachment offset")} />
        <NumberField label="Position Y" value={attachment.offsetY} disabled={disabled} onCommit={(value) => onAttachmentPatch(attachment.id, { offsetY: value }, "Change attachment offset")} />
        <NumberField label="Rotation" value={attachment.rotation} step={0.5} disabled={disabled} onCommit={(value) => onAttachmentPatch(attachment.id, { rotation: value }, "Rotate attachment")} />
        <NumberField label="Scale X" value={attachment.scaleX} step={0.05} disabled={disabled} onCommit={(value) => onAttachmentPatch(attachment.id, { scaleX: value }, "Scale attachment")} />
        <NumberField label="Scale Y" value={attachment.scaleY} step={0.05} disabled={disabled} onCommit={(value) => onAttachmentPatch(attachment.id, { scaleY: value }, "Scale attachment")} />
      </div></div>}
    </fieldset>
  </>;
}

function AttachmentInspector({ rig, attachment, disabled, onPatch, onSlotPatch }: { readonly rig: RigDefinition; readonly attachment: AttachmentDefinition; readonly disabled: boolean; readonly onPatch: Props["onAttachmentPatch"]; readonly onSlotPatch: Props["onSlotPatch"] }) {
  const textCommit = (patch: AttachmentPatch, label: string): void => onPatch(attachment.id, patch, label);
  return <>
    <InspectorHeading type="Attachment" id={attachment.id} />
    <div className="attachment-preview"><Image src={attachment.imagePath} alt={`${attachment.id} attachment`} width={220} height={110} unoptimized /></div>
    <fieldset disabled={disabled}>
      <label className="inspector-field"><span>Connect to Slot</span><select value="" onChange={(event) => { if (event.target.value) onSlotPatch(event.target.value, { attachmentId: attachment.id }, "Assign attachment to slot"); }}><option value="">Choose slot</option>{rig.slots.map((slot) => <option key={slot.id} value={slot.id}>{humanizeTechnicalId(slot.id.replace(/-slot$/, ""))}</option>)}</select></label>
      <div className="inspector-grid">
        <NumberField label="Width" value={attachment.width} disabled={disabled} onCommit={(value) => textCommit({ width: Math.max(1, value) }, "Change attachment width")} />
        <NumberField label="Height" value={attachment.height} disabled={disabled} onCommit={(value) => textCommit({ height: Math.max(1, value) }, "Change attachment height")} />
        <NumberField label="Position X" value={attachment.offsetX} disabled={disabled} onCommit={(value) => textCommit({ offsetX: value }, "Change attachment offset")} />
        <NumberField label="Position Y" value={attachment.offsetY} disabled={disabled} onCommit={(value) => textCommit({ offsetY: value }, "Change attachment offset")} />
        <NumberField label="Rotation" value={attachment.rotation} step={0.5} disabled={disabled} onCommit={(value) => textCommit({ rotation: value }, "Rotate attachment")} />
        <NumberField label="Scale X" value={attachment.scaleX} step={0.05} disabled={disabled} onCommit={(value) => textCommit({ scaleX: value }, "Scale attachment")} />
        <NumberField label="Scale Y" value={attachment.scaleY} step={0.05} disabled={disabled} onCommit={(value) => textCommit({ scaleY: value }, "Scale attachment")} />
      </div><details className="inspector-advanced"><summary>Advanced details</summary><TextField label="Image source" value={attachment.imagePath} disabled={disabled} onCommit={(value) => textCommit({ imagePath: value }, "Change image path")} /><TextField label="Category" value={attachment.category} disabled={disabled} onCommit={(value) => textCommit({ category: value }, "Change attachment category")} /><TextField label="Tags" value={attachment.tags.join(", ")} disabled={disabled} onCommit={(value) => textCommit({ tags: value.split(",").map((tag) => tag.trim()).filter(Boolean) }, "Change attachment tags")} /></details>
    </fieldset>
  </>;
}

function TextField({ label, value, disabled, onCommit }: { readonly label: string; readonly value: string; readonly disabled: boolean; readonly onCommit: (value: string) => void }) {
  return <label className="inspector-field"><span>{label}</span><input key={`${label}:${value}`} defaultValue={value} disabled={disabled} onBlur={(event) => { const next = event.currentTarget.value.trim(); if (next && next !== value) onCommit(next); else event.currentTarget.value = value; }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

function InspectorHeading({ type, id }: { readonly type: string; readonly id: string }) {
  return <header className="inspector-heading"><span>{type}</span><strong>{humanizeTechnicalId(id)}</strong><small title={id}>{id}</small></header>;
}

export function EditorInspector(props: Props) {
  const disabled = props.previewMode || props.locked;
  const selection = props.selection;
  if (!selection) return <div className="inspector-empty"><strong>Nothing selected</strong><p>Select a bone, slot, attachment, or skin to edit its properties.</p></div>;
  const smartActions = <div className="inspector-smart-actions"><div><i data-state={disabled ? "locked" : "ready"} /><span>{disabled ? props.previewMode ? "Preview locked" : "Locked" : "Ready to edit"}</span></div><button type="button" onClick={props.onFrame}>Frame</button><button type="button" onClick={props.onIsolate}>Isolate</button></div>;
  if (selection.type === "bone") {
    const bone = props.rig.bones.find((candidate) => candidate.id === selection.id);
    return bone ? <>{smartActions}<BoneInspector rig={props.rig} bone={bone} disabled={disabled} onPatch={props.onBonePatch} /></> : null;
  }
  if (selection.type === "slot") {
    const slot = props.rig.slots.find((candidate) => candidate.id === selection.id);
    return slot ? <>{smartActions}<SlotInspector rig={props.rig} slot={slot} disabled={disabled} onPatch={props.onSlotPatch} onAttachmentPatch={props.onAttachmentPatch} /></> : null;
  }
  if (selection.type === "attachment") {
    const attachment = props.rig.attachments.find((candidate) => candidate.id === selection.id);
    return attachment ? <>{smartActions}<AttachmentInspector rig={props.rig} attachment={attachment} disabled={disabled} onPatch={props.onAttachmentPatch} onSlotPatch={props.onSlotPatch} /></> : null;
  }
  const skin = props.rig.skins.find((candidate) => candidate.id === selection.id);
  if (!skin) return null;
  return <>{smartActions}
    <InspectorHeading type="Skin" id={skin.id} />
    <fieldset disabled={disabled}>
      <TextField label="Name" value={skin.name} disabled={disabled} onCommit={(value) => props.onRenameSkin(skin.id, value)} />
      <div className="inspector-subsection"><h3>Slot assignments</h3>{props.rig.slots.map((slot) => <label key={slot.id} className="inspector-field"><span>{slot.id}</span><select value={skin.slotAttachments[slot.id] ?? ""} onChange={(event) => props.onAssignSkin(skin.id, slot.id, event.target.value || null)}><option value="">None</option>{props.rig.attachments.map((attachment) => <option key={attachment.id}>{attachment.id}</option>)}</select></label>)}</div>
    </fieldset>
  </>;
}
