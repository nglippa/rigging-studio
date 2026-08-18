import type { RigDefinition } from "../schema/types";

export type AttachmentAsset = { readonly attachmentId: string; readonly url: string };
export const resolveAssetUrl = (imagePath: string, baseUrl = "/"): string => /^(?:blob:|data:|https?:\/\/)/i.test(imagePath)
  ? imagePath
  : `${baseUrl.replace(/\/?$/, "/")}${imagePath.replace(/^\/+/, "")}`;
export const collectAttachmentAssets = (rig: RigDefinition, baseUrl = "/"): AttachmentAsset[] => rig.attachments.map((attachment) => ({
  attachmentId: attachment.id, url: resolveAssetUrl(attachment.imagePath, baseUrl),
}));
