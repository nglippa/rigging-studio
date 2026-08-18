import { Assets, type Texture } from "pixi.js";
import { collectAttachmentAssets } from "../assets/attachmentAssets";
import type { RigDefinition } from "../schema/types";
import type { PixiTextureMap } from "./PixiRigRenderer";

export async function loadPixiTextures(rig: RigDefinition, baseUrl = "/"): Promise<PixiTextureMap> {
  const entries = await Promise.all(collectAttachmentAssets(rig, baseUrl).map(async ({ attachmentId, url }) => {
    const texture = await Assets.load<Texture>(url);
    return [attachmentId, texture] as const;
  }));
  return Object.fromEntries(entries);
}
