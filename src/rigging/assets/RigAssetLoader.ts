import { Assets, type Texture } from "pixi.js";
import { resolveAssetUrl } from "./attachmentAssets";
import type { AttachmentDefinition, RigDefinition } from "../schema/types";

export type TextureLoadResult =
  | { readonly success: true; readonly url: string; readonly texture: Texture }
  | { readonly success: false; readonly url: string; readonly error: Error };

export class RigAssetLoader {
  private readonly loads = new Map<string, Promise<TextureLoadResult>>();
  private destroyed = false;

  constructor(private readonly baseUrl = "/", private readonly scaleMode?: "nearest" | "linear") {}

  loadPath(imagePath: string): Promise<TextureLoadResult> {
    if (this.destroyed) return Promise.resolve({
      success: false,
      url: resolveAssetUrl(imagePath, this.baseUrl),
      error: new Error("RigAssetLoader has been destroyed"),
    });
    const url = resolveAssetUrl(imagePath, this.baseUrl);
    const existing = this.loads.get(url);
    if (existing) return existing;
    const load = Assets.load<Texture>(url)
      .then((texture): TextureLoadResult => { if (this.scaleMode) texture.source.scaleMode = this.scaleMode; return { success: true, url, texture }; })
      .catch((error: unknown): TextureLoadResult => ({
        success: false,
        url,
        error: error instanceof Error ? error : new Error(`Failed to load texture "${url}"`),
      }));
    this.loads.set(url, load);
    return load;
  }

  loadAttachment(attachment: AttachmentDefinition): Promise<TextureLoadResult> {
    return this.loadPath(attachment.imagePath);
  }

  async loadRig(rig: RigDefinition): Promise<Readonly<Record<string, TextureLoadResult>>> {
    const entries = await Promise.all(rig.attachments.map(async (attachment) => [
      attachment.id,
      await this.loadAttachment(attachment),
    ] as const));
    return Object.fromEntries(entries);
  }

  get cachedPathCount(): number {
    return this.loads.size;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const urls = [...this.loads.keys()];
    this.loads.clear();
    await Promise.allSettled(urls.map((url) => Assets.unload(url)));
  }
}
