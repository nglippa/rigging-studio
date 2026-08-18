import type {
  AttachmentDefinition,
  BoneDefinition,
  RigDefinition,
  SkinDefinition,
  SlotDefinition,
} from "../../rigging/schema/types";
import { validateRigDefinition } from "../../rigging/validation/rig";

export type BonePatch = Partial<Omit<BoneDefinition, "id">>;
export type SlotPatch = Partial<Omit<SlotDefinition, "id">>;
export type AttachmentPatch = Partial<Omit<AttachmentDefinition, "id">>;

export class BoneDeletionBlockedError extends Error {
  constructor(
    readonly boneId: string,
    readonly childIds: readonly string[],
    readonly slotIds: readonly string[],
    message = `Bone "${boneId}" cannot be deleted without repairing dependent children or slots`,
  ) {
    super(message);
    this.name = "BoneDeletionBlockedError";
  }
}

export type BoneDeletionRepair = { readonly reparentChildrenTo: string; readonly moveSlotsTo: string };

const nextId = (base: string, ids: ReadonlySet<string>): string => {
  if (!ids.has(base)) return base;
  let index = 2;
  while (ids.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
};

function assertValid(rig: RigDefinition): RigDefinition {
  const issues = validateRigDefinition(rig);
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join("; "));
  return rig;
}

export function updateRigIdentity(rig: RigDefinition, id: string, name: string): RigDefinition {
  if (!id.trim()) throw new Error("Rig ID cannot be empty");
  return { ...rig, id: id.trim(), metadata: { ...rig.metadata, name: name.trim() || id.trim() } };
}

export function canReparentBone(rig: RigDefinition, boneId: string, parentId: string): boolean {
  if (boneId === rig.rootBoneId || boneId === parentId) return false;
  const bones = new Map(rig.bones.map((bone) => [bone.id, bone]));
  if (!bones.has(boneId) || !bones.has(parentId)) return false;
  let cursor: string | null = parentId;
  while (cursor !== null) {
    if (cursor === boneId) return false;
    cursor = bones.get(cursor)?.parentId ?? null;
  }
  return true;
}

export function updateBone(rig: RigDefinition, boneId: string, patch: BonePatch): RigDefinition {
  const bone = rig.bones.find((candidate) => candidate.id === boneId);
  if (!bone) throw new Error(`Bone "${boneId}" does not exist`);
  if (patch.parentId !== undefined && patch.parentId !== bone.parentId) {
    if (patch.parentId === null || !canReparentBone(rig, boneId, patch.parentId)) {
      throw new Error(`Bone "${boneId}" cannot be parented to "${String(patch.parentId)}"`);
    }
  }
  return assertValid({ ...rig, bones: rig.bones.map((candidate) => candidate.id === boneId ? { ...candidate, ...patch } : candidate) });
}

export function addBone(rig: RigDefinition, parentId = rig.rootBoneId): { readonly rig: RigDefinition; readonly id: string } {
  const parent = rig.bones.find((bone) => bone.id === parentId);
  if (!parent) throw new Error(`Parent bone "${parentId}" does not exist`);
  const id = nextId("bone", new Set(rig.bones.map((bone) => bone.id)));
  const bone: BoneDefinition = {
    id, parentId, x: parent.length, y: 0, rotation: 0, scaleX: 1, scaleY: 1,
    length: 48, inheritRotation: true, inheritScale: true,
  };
  return { rig: assertValid({ ...rig, bones: [...rig.bones, bone] }), id };
}

export function duplicateBone(rig: RigDefinition, boneId: string): { readonly rig: RigDefinition; readonly id: string } {
  const source = rig.bones.find((bone) => bone.id === boneId);
  if (!source) throw new Error(`Bone "${boneId}" does not exist`);
  if (source.parentId === null) throw new Error("The root bone cannot be duplicated");
  const id = nextId(`${source.id}-copy`, new Set(rig.bones.map((bone) => bone.id)));
  return { rig: assertValid({ ...rig, bones: [...rig.bones, { ...source, id, x: source.x + 12, y: source.y + 12 }] }), id };
}

export function analyzeBoneDeletion(rig: RigDefinition, boneId: string): { readonly childIds: string[]; readonly slotIds: string[] } {
  return {
    childIds: rig.bones.filter((bone) => bone.parentId === boneId).map((bone) => bone.id),
    slotIds: rig.slots.filter((slot) => slot.boneId === boneId).map((slot) => slot.id),
  };
}

export function deleteBone(rig: RigDefinition, boneId: string, repair?: BoneDeletionRepair): RigDefinition {
  const bone = rig.bones.find((candidate) => candidate.id === boneId);
  if (!bone) throw new Error(`Bone "${boneId}" does not exist`);
  if (boneId === rig.rootBoneId) throw new Error("The root bone cannot be deleted");
  const dependencies = analyzeBoneDeletion(rig, boneId);
  if ((dependencies.childIds.length || dependencies.slotIds.length) && !repair) {
    throw new BoneDeletionBlockedError(boneId, dependencies.childIds, dependencies.slotIds);
  }
  if (repair) {
    if (repair.reparentChildrenTo === boneId || repair.moveSlotsTo === boneId) throw new Error("Repair targets cannot reference the deleted bone");
    if (!rig.bones.some((candidate) => candidate.id === repair.reparentChildrenTo) || !rig.bones.some((candidate) => candidate.id === repair.moveSlotsTo)) {
      throw new Error("Bone deletion repair targets must exist");
    }
    if (dependencies.childIds.some((childId) => !canReparentBone(rig, childId, repair.reparentChildrenTo))) {
      throw new Error("The selected child repair target would create a hierarchy cycle");
    }
  }
  const bones = rig.bones
    .filter((candidate) => candidate.id !== boneId)
    .map((candidate) => candidate.parentId === boneId ? { ...candidate, parentId: repair?.reparentChildrenTo ?? candidate.parentId } : candidate);
  const slots = rig.slots.map((slot) => slot.boneId === boneId ? { ...slot, boneId: repair?.moveSlotsTo ?? slot.boneId } : slot);
  return assertValid({ ...rig, bones, slots });
}

export function updateSlot(rig: RigDefinition, slotId: string, patch: SlotPatch): RigDefinition {
  if (!rig.slots.some((slot) => slot.id === slotId)) throw new Error(`Slot "${slotId}" does not exist`);
  return assertValid({ ...rig, slots: rig.slots.map((slot) => slot.id === slotId ? { ...slot, ...patch } : slot) });
}

export function addSlot(rig: RigDefinition, boneId = rig.rootBoneId): { readonly rig: RigDefinition; readonly id: string } {
  if (!rig.bones.some((bone) => bone.id === boneId)) throw new Error(`Bone "${boneId}" does not exist`);
  const id = nextId("slot", new Set(rig.slots.map((slot) => slot.id)));
  const zIndex = Math.max(-1, ...rig.slots.map((slot) => slot.zIndex)) + 1;
  const slot: SlotDefinition = { id, boneId, attachmentId: null, zIndex, visible: true, blendMode: "normal", tint: 0xffffff, pivotX: 0, pivotY: 0 };
  const skins = rig.skins.map((skin) => ({ ...skin, slotAttachments: { ...skin.slotAttachments, [id]: null } }));
  return { rig: assertValid({ ...rig, slots: [...rig.slots, slot], skins }), id };
}

export function duplicateSlot(rig: RigDefinition, slotId: string): { readonly rig: RigDefinition; readonly id: string } {
  const source = rig.slots.find((slot) => slot.id === slotId);
  if (!source) throw new Error(`Slot "${slotId}" does not exist`);
  const id = nextId(`${source.id}-copy`, new Set(rig.slots.map((slot) => slot.id)));
  const zIndex = Math.max(-1, ...rig.slots.map((slot) => slot.zIndex)) + 1;
  const skins = rig.skins.map((skin) => ({ ...skin, slotAttachments: { ...skin.slotAttachments, [id]: skin.slotAttachments[source.id] ?? source.attachmentId } }));
  return { rig: assertValid({ ...rig, slots: [...rig.slots, { ...source, id, zIndex }], skins }), id };
}

export function deleteSlot(rig: RigDefinition, slotId: string): RigDefinition {
  if (!rig.slots.some((slot) => slot.id === slotId)) throw new Error(`Slot "${slotId}" does not exist`);
  const skins = rig.skins.map((skin) => {
    const mappings = { ...skin.slotAttachments };
    delete mappings[slotId];
    return { ...skin, slotAttachments: mappings };
  });
  return assertValid({ ...rig, slots: rig.slots.filter((slot) => slot.id !== slotId), skins });
}

export function moveSlot(rig: RigDefinition, slotId: string, direction: -1 | 1): RigDefinition {
  const index = rig.slots.findIndex((slot) => slot.id === slotId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= rig.slots.length) return rig;
  const slots = [...rig.slots];
  const current = slots[index];
  const other = slots[target];
  slots[index] = { ...other, zIndex: current.zIndex };
  slots[target] = { ...current, zIndex: other.zIndex };
  return assertValid({ ...rig, slots });
}

export function addAttachment(rig: RigDefinition, attachment: AttachmentDefinition): RigDefinition {
  if (rig.attachments.some((candidate) => candidate.id === attachment.id)) throw new Error(`Attachment "${attachment.id}" already exists`);
  return assertValid({ ...rig, attachments: [...rig.attachments, attachment] });
}

export function updateAttachment(rig: RigDefinition, attachmentId: string, patch: AttachmentPatch): RigDefinition {
  if (!rig.attachments.some((attachment) => attachment.id === attachmentId)) throw new Error(`Attachment "${attachmentId}" does not exist`);
  return assertValid({ ...rig, attachments: rig.attachments.map((attachment) => attachment.id === attachmentId ? { ...attachment, ...patch } : attachment) });
}

export function deleteAttachment(rig: RigDefinition, attachmentId: string): RigDefinition {
  if (!rig.attachments.some((attachment) => attachment.id === attachmentId)) throw new Error(`Attachment "${attachmentId}" does not exist`);
  const slots = rig.slots.map((slot) => slot.attachmentId === attachmentId ? { ...slot, attachmentId: null } : slot);
  const skins = rig.skins.map((skin) => ({
    ...skin,
    slotAttachments: Object.fromEntries(Object.entries(skin.slotAttachments).map(([slotId, value]) => [slotId, value === attachmentId ? null : value])),
  }));
  return assertValid({ ...rig, attachments: rig.attachments.filter((attachment) => attachment.id !== attachmentId), slots, skins });
}

export function createSkin(rig: RigDefinition): { readonly rig: RigDefinition; readonly id: string } {
  const id = nextId("skin", new Set(rig.skins.map((skin) => skin.id)));
  const skin: SkinDefinition = { id, name: "New Skin", slotAttachments: Object.fromEntries(rig.slots.map((slot) => [slot.id, slot.attachmentId])) };
  return { rig: assertValid({ ...rig, skins: [...rig.skins, skin] }), id };
}

export function duplicateSkin(rig: RigDefinition, skinId: string): { readonly rig: RigDefinition; readonly id: string } {
  const source = rig.skins.find((skin) => skin.id === skinId);
  if (!source) throw new Error(`Skin "${skinId}" does not exist`);
  const id = nextId(`${source.id}-copy`, new Set(rig.skins.map((skin) => skin.id)));
  const skin: SkinDefinition = { ...source, id, name: `${source.name} Copy`, slotAttachments: { ...source.slotAttachments } };
  return { rig: assertValid({ ...rig, skins: [...rig.skins, skin] }), id };
}

export function deleteSkin(rig: RigDefinition, skinId: string): RigDefinition {
  if (!rig.skins.some((skin) => skin.id === skinId)) throw new Error(`Skin "${skinId}" does not exist`);
  if (rig.skins.length === 1) throw new Error("A rig must keep at least one skin");
  const skins = rig.skins.filter((skin) => skin.id !== skinId);
  const defaultSkinId = rig.defaultSkinId === skinId ? skins[0].id : rig.defaultSkinId;
  return assertValid({ ...rig, skins, defaultSkinId });
}

export function renameSkin(rig: RigDefinition, skinId: string, name: string): RigDefinition {
  if (!name.trim()) throw new Error("Skin name cannot be empty");
  if (!rig.skins.some((skin) => skin.id === skinId)) throw new Error(`Skin "${skinId}" does not exist`);
  return { ...rig, skins: rig.skins.map((skin) => skin.id === skinId ? { ...skin, name: name.trim() } : skin) };
}

export function assignSkinAttachment(rig: RigDefinition, skinId: string, slotId: string, attachmentId: string | null): RigDefinition {
  if (!rig.slots.some((slot) => slot.id === slotId)) throw new Error(`Slot "${slotId}" does not exist`);
  if (attachmentId !== null && !rig.attachments.some((attachment) => attachment.id === attachmentId)) throw new Error(`Attachment "${attachmentId}" does not exist`);
  if (!rig.skins.some((skin) => skin.id === skinId)) throw new Error(`Skin "${skinId}" does not exist`);
  return assertValid({
    ...rig,
    skins: rig.skins.map((skin) => skin.id === skinId ? { ...skin, slotAttachments: { ...skin.slotAttachments, [slotId]: attachmentId } } : skin),
  });
}
