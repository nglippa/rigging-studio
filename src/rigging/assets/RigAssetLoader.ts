import { Assets, type Texture } from "pixi.js";
import { resolveAssetUrl } from "./attachmentAssets";
import type { AttachmentDefinition, RigDefinition } from "../schema/types";

export type TextureLoadResult =
  | { readonly success: true; readonly url: string; readonly texture: Texture }
  | { readonly success: false; readonly url: string; readonly error: Error };

/**
 * How many loaders hold each URL. Pixi's Assets cache is global, so one loader unloading a URL destroys the texture for
 * every other loader too: leaving a step while the next step's viewport picks up the same art left that viewport
 * drawing a destroyed texture ("Cannot read properties of null (reading 'alphaMode')"). A URL is unloaded only when the
 * last loader holding it lets go.
 */
const holders = new Map<string, number>();
/**
 * Unloads still in flight, by URL. A viewport that mounts as another unmounts can ask for a texture the other has just
 * started unloading; Pixi would hand back the cached texture that is about to be destroyed. It waits for the unload and
 * loads the texture afresh instead.
 */
const unloading = new Map<string, Promise<unknown>>();

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
    holders.set(url, (holders.get(url) ?? 0) + 1);
    const load = (unloading.get(url) ?? Promise.resolve()).then(() => Assets.load<Texture>(url))
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
    const released = urls.filter((url) => { const left = (holders.get(url) ?? 1) - 1; if (left > 0) { holders.set(url, left); return false; } holders.delete(url); return true; });
    await Promise.allSettled(released.map((url) => {
      const done: Promise<unknown> = Assets.unload(url).finally(() => { if (unloading.get(url) === done) unloading.delete(url); });
      unloading.set(url, done);
      return done;
    }));
  }
}
