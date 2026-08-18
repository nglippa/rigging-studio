"use client";

import type { RigDefinition } from "@/src/rigging/schema/types";
import type { EditorSelection } from "@/src/tools/rig-editor/types";
import { humanizeTechnicalId, semanticGroup } from "@/app/studio-ui/humanize";

type Props = {
  readonly rig: RigDefinition;
  readonly search: string;
  readonly selections: readonly EditorSelection[];
  readonly hiddenBoneIds: ReadonlySet<string>;
  readonly lockedIds: ReadonlySet<string>;
  readonly onSelect: (selection: EditorSelection, additive: boolean) => void;
  readonly onToggleBoneVisibility: (boneId: string) => void;
  readonly onToggleSlotVisibility: (slotId: string) => void;
  readonly onToggleLock: (key: string) => void;
  readonly onAdd: (type: EditorSelection["type"]) => void;
  readonly onDuplicate: (type: EditorSelection["type"]) => void;
  readonly onDelete: (type: EditorSelection["type"]) => void;
  readonly onMoveSlot: (slotId: string, direction: -1 | 1) => void;
  readonly disabled: boolean;
};

const matches = (value: string, search: string): boolean => !search || value.toLowerCase().includes(search.toLowerCase());

export function EditorHierarchy(props: Props) {
  const selected = (type: EditorSelection["type"], id: string): boolean => props.selections.some((selection) => selection.type === type && selection.id === id);
  const children = new Map<string | null, string[]>();
  props.rig.bones.forEach((bone) => children.set(bone.parentId, [...(children.get(bone.parentId) ?? []), bone.id]));

  const boneMatches = new Set<string>();
  const markBone = (boneId: string): boolean => {
    const bone = props.rig.bones.find((candidate) => candidate.id === boneId);
    if (!bone) return false;
    const self = matches(bone.id, props.search);
    let descendant = false;
    (children.get(boneId) ?? []).forEach((childId) => { if (markBone(childId)) descendant = true; });
    if (self || descendant) boneMatches.add(boneId);
    return self || descendant;
  };
  markBone(props.rig.rootBoneId);

  const renderBone = (boneId: string, depth: number): React.ReactNode => {
    if (!boneMatches.has(boneId)) return null;
    const visible = !props.hiddenBoneIds.has(boneId);
    const lockKey = `bone:${boneId}`;
    return (
      <div key={boneId}>
        <div className={`editor-tree-row ${selected("bone", boneId) ? "is-selected" : ""}`} data-group={semanticGroup(boneId)} style={{ paddingLeft: `${8 + depth * 14}px` }} title={boneId} onClick={(event) => props.onSelect({ type: "bone", id: boneId }, event.shiftKey)}>
          <span className="tree-joint" />
          <span className="tree-name">{humanizeTechnicalId(boneId)}</span>
          <button type="button" className="row-tool visibility-tool" aria-label={`${visible ? "Hide" : "Show"} bone ${boneId}`} title={visible ? "Hide" : "Show"} onClick={(event) => { event.stopPropagation(); props.onToggleBoneVisibility(boneId); }}>{visible ? "◉" : "○"}</button>
          <button type="button" className={`row-tool lock-tool ${props.lockedIds.has(lockKey) ? "is-active" : ""}`} aria-label={`${props.lockedIds.has(lockKey) ? "Unlock" : "Lock"} bone ${boneId}`} title="Lock" onClick={(event) => { event.stopPropagation(); props.onToggleLock(lockKey); }}>{props.lockedIds.has(lockKey) ? "◆" : "◇"}</button>
        </div>
        {(children.get(boneId) ?? []).map((childId) => renderBone(childId, depth + 1))}
      </div>
    );
  };

  const sectionActions = (type: EditorSelection["type"], duplicate = true): React.ReactNode => (
    <span className="tree-actions">
      <button type="button" onClick={() => props.onAdd(type)} disabled={props.disabled}>+</button>
      {duplicate && <button type="button" onClick={() => props.onDuplicate(type)} disabled={props.disabled}>D</button>}
      <button type="button" onClick={() => props.onDelete(type)} disabled={props.disabled}>-</button>
    </span>
  );

  const equipmentSlots = props.rig.slots.filter((slot) => /weapon|equipment|shield|sword|staff|bow|helmet|armor|cape|tail|quiver/i.test(`${slot.id} ${slot.attachmentId ?? ""}`));
  const bodySlots = props.rig.slots.filter((slot) => !equipmentSlots.includes(slot));
  const renderSlots = (slots: typeof props.rig.slots): React.ReactNode => slots.filter((slot) => matches(slot.id, props.search)).map((slot) => {
    const index = props.rig.slots.findIndex((candidate) => candidate.id === slot.id);
    const lockKey = `slot:${slot.id}`;
    return <div key={slot.id} className={`editor-tree-row ${selected("slot", slot.id) ? "is-selected" : ""}`} data-group={semanticGroup(slot.id)} title={slot.id} onClick={(event) => props.onSelect({ type: "slot", id: slot.id }, event.shiftKey)}>
      <span className="slot-layer">{slot.zIndex}</span><span className="tree-name">{humanizeTechnicalId(slot.id.replace(/-slot$/, ""))}</span>
      <button type="button" className="row-tool visibility-tool" title={slot.visible ? "Hide" : "Show"} aria-label={`${slot.visible ? "Hide" : "Show"} slot ${slot.id}`} disabled={props.disabled} onClick={(event) => { event.stopPropagation(); props.onToggleSlotVisibility(slot.id); }}>{slot.visible ? "◉" : "○"}</button>
      <button type="button" className="row-tool" title="Move down" aria-label={`Move ${slot.id} down`} disabled={props.disabled || index === 0} onClick={(event) => { event.stopPropagation(); props.onMoveSlot(slot.id, -1); }}>↓</button>
      <button type="button" className="row-tool" title="Move up" aria-label={`Move ${slot.id} up`} disabled={props.disabled || index === props.rig.slots.length - 1} onClick={(event) => { event.stopPropagation(); props.onMoveSlot(slot.id, 1); }}>↑</button>
      <button type="button" className={`row-tool lock-tool ${props.lockedIds.has(lockKey) ? "is-active" : ""}`} aria-label={`${props.lockedIds.has(lockKey) ? "Unlock" : "Lock"} slot ${slot.id}`} onClick={(event) => { event.stopPropagation(); props.onToggleLock(lockKey); }}>{props.lockedIds.has(lockKey) ? "◆" : "◇"}</button>
    </div>;
  });

  return (
    <div className="editor-outliner">
      <details open>
        <summary><span>Bones <small>{props.rig.bones.length}</small></span>{sectionActions("bone")}</summary>
        <div className="tree-list">{renderBone(props.rig.rootBoneId, 0)}</div>
      </details>
      <details open>
        <summary><span>Parts <small>{bodySlots.length}</small></span>{sectionActions("slot")}</summary>
        <div className="tree-list">{renderSlots(bodySlots)}</div>
      </details>
      <details open>
        <summary><span>Equipment <small>{equipmentSlots.length}</small></span></summary>
        <div className="tree-list">{equipmentSlots.length ? renderSlots(equipmentSlots) : <div className="tree-empty">No equipment slots</div>}</div>
      </details>
      <details>
        <summary><span>Attachments <small>{props.rig.attachments.length}</small></span>{sectionActions("attachment", false)}</summary>
        <div className="tree-list">
          {props.rig.attachments.filter((attachment) => matches(`${attachment.id} ${attachment.category}`, props.search)).map((attachment) => {
            const lockKey = `attachment:${attachment.id}`;
            return <div key={attachment.id} className={`editor-tree-row ${selected("attachment", attachment.id) ? "is-selected" : ""}`} data-group={semanticGroup(`${attachment.id} ${attachment.category}`)} title={attachment.id} onClick={(event) => props.onSelect({ type: "attachment", id: attachment.id }, event.shiftKey)}>
              <span className="attachment-chip" style={{ backgroundImage: `url(${attachment.imagePath})` }} /><span className="tree-name">{humanizeTechnicalId(attachment.id)}</span><small>{humanizeTechnicalId(attachment.category)}</small>
              <button type="button" className={`row-tool lock-tool ${props.lockedIds.has(lockKey) ? "is-active" : ""}`} aria-label={`${props.lockedIds.has(lockKey) ? "Unlock" : "Lock"} attachment ${attachment.id}`} onClick={(event) => { event.stopPropagation(); props.onToggleLock(lockKey); }}>{props.lockedIds.has(lockKey) ? "◆" : "◇"}</button>
            </div>;
          })}
        </div>
      </details>
      <details>
        <summary><span>Skins <small>{props.rig.skins.length}</small></span>{sectionActions("skin")}</summary>
        <div className="tree-list">
          {props.rig.skins.filter((skin) => matches(`${skin.id} ${skin.name}`, props.search)).map((skin) => <div key={skin.id} className={`editor-tree-row ${selected("skin", skin.id) ? "is-selected" : ""}`} onClick={(event) => props.onSelect({ type: "skin", id: skin.id }, event.shiftKey)}>
            <span className="skin-swatch" /><span className="tree-name">{skin.name}</span><small>{skin.id}</small>
          </div>)}
        </div>
      </details>
    </div>
  );
}
