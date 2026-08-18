import type { AttachmentDefinition, RigDefinition, SlotDefinition } from "../schema/types";

export type SlotAttachmentOverrides = Readonly<Record<string, string | null>>;
export type ResolvedSlot = { readonly slot: SlotDefinition; readonly attachment: AttachmentDefinition | null };

export function resolveSlots(rig: RigDefinition, skinId = rig.defaultSkinId, overrides: SlotAttachmentOverrides = {}): ResolvedSlot[] {
  const skin = rig.skins.find((candidate) => candidate.id === skinId);
  if (!skin) throw new Error(`Skin "${skinId}" does not exist`);
  const attachments = new Map(rig.attachments.map((attachment) => [attachment.id, attachment]));
  return [...rig.slots].sort((left, right) => left.zIndex - right.zIndex).map((slot) => {
    const override = Object.prototype.hasOwnProperty.call(overrides, slot.id) ? overrides[slot.id] : undefined;
    const skinAttachment = Object.prototype.hasOwnProperty.call(skin.slotAttachments, slot.id) ? skin.slotAttachments[slot.id] : undefined;
    const attachmentId = override !== undefined ? override : skinAttachment !== undefined ? skinAttachment : slot.attachmentId;
    return { slot, attachment: attachmentId === null ? null : attachments.get(attachmentId) ?? null };
  });
}
