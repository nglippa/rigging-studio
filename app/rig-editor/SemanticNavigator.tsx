"use client";

import { useEffect, useMemo, useState } from "react";
import type { BoneDefinition, RigDefinition } from "@/src/rigging/schema/types";
import type { EditorSelection } from "@/src/tools/rig-editor/types";
import { humanizeTechnicalId } from "@/app/studio-ui/humanize";
import { EditorHierarchy } from "./EditorHierarchy";
import { semanticBodyPath, type BodyMajor } from "./semanticBody";

export type SemanticSection = "character" | "body" | "equipment" | "layers" | "advanced";

type Props = {
  readonly section: SemanticSection;
  readonly onSection: (section: SemanticSection) => void;
  readonly rig: RigDefinition;
  readonly search: string;
  readonly selections: readonly EditorSelection[];
  readonly hiddenBoneIds: ReadonlySet<string>;
  readonly lockedIds: ReadonlySet<string>;
  readonly onSelect: (selection: EditorSelection | null, additive: boolean) => void;
  readonly onToggleBoneVisibility: (id: string) => void;
  readonly onToggleSlotVisibility: (id: string) => void;
  readonly onToggleLock: (key: string) => void;
  readonly onAdd: (type: EditorSelection["type"]) => void;
  readonly onDuplicate: (type: EditorSelection["type"]) => void;
  readonly onDelete: (type: EditorSelection["type"]) => void;
  readonly onMoveSlot: (id: string, direction: -1 | 1) => void;
  readonly disabled: boolean;
};

const equipmentPattern = /weapon|equipment|shield|sword|staff|bow|helmet|armor|cape|tail|quiver/i;
const OPEN_GROUPS_KEY = "rigging-studio-semantic-groups-v1";
const majorLabels: Readonly<Record<BodyMajor, string>> = { head: "Head", torso: "Torso", arms: "Arms", legs: "Legs", other: "Other" };

export function SemanticNavigator(props: Props) {
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set(["head", "torso"]));
  const selected = (type: EditorSelection["type"], id: string) => props.selections.some((item) => item.type === type && item.id === id);
  const matches = (value: string) => !props.search.trim() || value.toLowerCase().includes(props.search.trim().toLowerCase());
  const equipmentSlots = props.rig.slots.filter((slot) => equipmentPattern.test(`${slot.id} ${slot.attachmentId ?? ""}`));
  const equipmentAttachments = props.rig.attachments.filter((attachment) => equipmentPattern.test(`${attachment.id} ${attachment.category} ${attachment.tags.join(" ")}`));
  const groupedBones = useMemo(() => {
    const groups = new Map<BodyMajor, BoneDefinition[]>();
    props.rig.bones.forEach((bone) => {
      if (!matches(bone.id)) return;
      const major = semanticBodyPath(bone.id).major;
      groups.set(major, [...(groups.get(major) ?? []), bone]);
    });
    return (["head", "torso", "arms", "legs", "other"] as const).map((id) => ({ id, label: majorLabels[id], bones: groups.get(id) ?? [] })).filter((group) => group.bones.length);
    // Search is represented by the normalized string to avoid recalculating on unrelated selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.rig.bones, props.search]);
  const orderedSlots = [...props.rig.slots].sort((a, b) => b.zIndex - a.zIndex).filter((slot) => matches(slot.id));
  const frontLine = Math.ceil(orderedSlots.length / 3);
  const layers = [{ label: "Front", slots: orderedSlots.slice(0, frontLine) }, { label: "Body", slots: orderedSlots.slice(frontLine, -frontLine || undefined) }, { label: "Back", slots: orderedSlots.slice(-frontLine) }].filter((group) => group.slots.length);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = JSON.parse(window.localStorage.getItem(OPEN_GROUPS_KEY) ?? "[]") as string[];
        if (stored.length) setOpenGroups(new Set(stored));
      } catch { /* Keep compact defaults when saved navigation state is invalid. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...openGroups]));
  }, [openGroups]);

  const selectedBoneId = props.selections.find((selection) => selection.type === "bone")?.id;
  useEffect(() => {
    if (!selectedBoneId) return;
    const path = semanticBodyPath(selectedBoneId);
    const keys = [path.major, path.side ? `${path.major}-${path.side}` : null].filter((key): key is string => Boolean(key));
    const timer = window.setTimeout(() => setOpenGroups((current) => new Set([...current, ...keys])), 0);
    return () => window.clearTimeout(timer);
  }, [selectedBoneId]);

  const toggleGroup = (id: string): void => setOpenGroups((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const selectedBone = selectedBoneId ? props.rig.bones.find((bone) => bone.id === selectedBoneId) : null;
  const relationIds = new Set([selectedBone?.parentId, ...props.rig.bones.filter((bone) => bone.parentId === selectedBoneId).map((bone) => bone.id)].filter((id): id is string => Boolean(id)));
  const row = (type: EditorSelection["type"], id: string, detail?: string) => <button key={`${type}-${id}`} type="button" className={`semantic-object ${selected(type, id) ? "is-selected" : ""} ${type === "bone" && relationIds.has(id) ? "is-related" : ""}`} onClick={(event) => props.onSelect({ type, id }, event.shiftKey)}><i /> <span>{humanizeTechnicalId(id.replace(/-slot$/, ""))}</span>{detail && <small>{detail}</small>}<b aria-hidden="true">›</b></button>;

  const bodyGroup = (group: { readonly id: BodyMajor; readonly label: string; readonly bones: readonly BoneDefinition[] }) => {
    const open = openGroups.has(group.id) || Boolean(props.search.trim());
    const sideGroup = (side: "left" | "right") => {
      const bones = group.bones.filter((bone) => semanticBodyPath(bone.id).side === side);
      if (!bones.length) return null;
      const id = `${group.id}-${side}`;
      const sideOpen = openGroups.has(id) || Boolean(props.search.trim());
      return <div className="semantic-side-group" key={id}><button type="button" className="semantic-group-trigger is-nested" aria-expanded={sideOpen} onClick={() => toggleGroup(id)}><span>{side === "left" ? "Left" : "Right"}</span><small>{bones.length}</small><i>⌄</i></button>{sideOpen && <div className="semantic-group-rows">{bones.map((bone) => row("bone", bone.id, bone.id === props.rig.rootBoneId ? "Root" : "Pivot"))}</div>}</div>;
    };
    return <section className="semantic-body-group" key={group.id}><button type="button" className="semantic-group-trigger" aria-expanded={open} onClick={() => toggleGroup(group.id)}><span>{group.label}</span><small>{group.bones.length}</small><i>⌄</i></button>{open && <div className="semantic-group-body">{group.id === "arms" || group.id === "legs" ? <>{sideGroup("left")}{sideGroup("right")}</> : group.bones.map((bone) => row("bone", bone.id, bone.id === props.rig.rootBoneId ? "Root" : "Pivot"))}</div>}</section>;
  };

  return <div className="semantic-navigator">
    <nav className="semantic-section-nav" aria-label="Setup sections">{(["character", "body", "equipment", "layers"] as const).map((section) => <button key={section} type="button" className={props.section === section ? "is-active" : ""} aria-current={props.section === section ? "page" : undefined} onClick={() => props.onSection(section)}><i />{section}</button>)}</nav>
    <div className="semantic-section-content">
      {props.section === "character" && <><div className="semantic-summary"><span>Character</span><strong>{typeof props.rig.metadata.name === "string" ? props.rig.metadata.name : humanizeTechnicalId(props.rig.id)}</strong><p>{props.rig.bones.length} joints · {props.rig.slots.length} parts · {props.rig.skins.length} {props.rig.skins.length === 1 ? "skin" : "skins"}</p></div><div className="semantic-status-list"><button type="button" onClick={() => props.onSelect({ type: "bone", id: props.rig.rootBoneId }, false)}><i data-state="valid" />Root connection<span>Ready</span></button><button type="button" onClick={() => props.onSelect({ type: "skin", id: props.rig.defaultSkinId }, false)}><i data-state="valid" />Active look<span>{humanizeTechnicalId(props.rig.defaultSkinId)}</span></button></div></>}
      {props.section === "body" && <div className="semantic-groups semantic-body-tree" role="tree" aria-label="Character body regions">{groupedBones.map(bodyGroup)}</div>}
      {props.section === "equipment" && <div className="semantic-groups"><header className="semantic-list-heading"><span>Equipment</span><button type="button" onClick={() => props.onAdd("slot")} disabled={props.disabled}>+ Add</button></header>{equipmentSlots.length || equipmentAttachments.length ? <><details open><summary>Mounted items<small>{equipmentSlots.length}</small></summary>{equipmentSlots.map((slot) => row("slot", slot.id, slot.attachmentId ? humanizeTechnicalId(slot.attachmentId) : "Empty"))}</details><details open><summary>Art<small>{equipmentAttachments.length}</small></summary>{equipmentAttachments.map((attachment) => row("attachment", attachment.id, humanizeTechnicalId(attachment.category)))}</details></> : <div className="semantic-empty"><span>No equipment</span><button type="button" onClick={() => props.onAdd("slot")}>+ Add equipment</button></div>}</div>}
      {props.section === "layers" && <div className="semantic-groups layer-groups">{layers.map((group) => <section key={group.label}><h3>{group.label}<small>{group.slots.length}</small></h3>{group.slots.map((slot) => <div key={slot.id} className={`semantic-layer-row ${selected("slot", slot.id) ? "is-selected" : ""}`}><button type="button" onClick={() => props.onSelect({ type: "slot", id: slot.id }, false)}><i />{humanizeTechnicalId(slot.id.replace(/-slot$/, ""))}</button><span><button type="button" aria-label={`Move ${slot.id} backward`} onClick={() => props.onMoveSlot(slot.id, -1)}>↓</button><button type="button" aria-label={`Move ${slot.id} forward`} onClick={() => props.onMoveSlot(slot.id, 1)}>↑</button></span></div>)}</section>)}</div>}
      {props.section === "advanced" && <EditorHierarchy {...props} />}
    </div>
    <button type="button" className={`advanced-tree-toggle ${props.section === "advanced" ? "is-active" : ""}`} onClick={() => props.onSection(props.section === "advanced" ? "body" : "advanced")}><span>⌘</span>{props.section === "advanced" ? "Back to semantic view" : "Advanced structure"}<b>›</b></button>
  </div>;
}
