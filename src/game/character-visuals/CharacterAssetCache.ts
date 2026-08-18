import { RigAssetLoader } from "../../rigging/assets/RigAssetLoader";
import { loadAnimationDefinition, loadRigDefinition, type TextFetcher } from "../../rigging/assets/loadDefinitions";
import type { AnimationDefinition, RigDefinition } from "../../rigging/schema/types";

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Readonly<Record<string, unknown>>).forEach((child) => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
};

export class CharacterAssetCache {
  readonly textureLoader: RigAssetLoader;
  private readonly rigs = new Map<string, Promise<RigDefinition>>();
  private readonly animations = new Map<string, Promise<AnimationDefinition>>();
  private destroyed = false;

  constructor(private readonly fetcher?: TextFetcher, baseUrl = "/") { this.textureLoader = new RigAssetLoader(baseUrl, "nearest"); }

  getRig(path: string): Promise<RigDefinition> {
    if (this.destroyed) return Promise.reject(new Error("CharacterAssetCache has been destroyed"));
    const existing = this.rigs.get(path); if (existing) return existing;
    const load = loadRigDefinition(path, this.fetcher).then((result) => {
      if (!result.success) throw new Error(result.message);
      return deepFreeze(result.data);
    });
    this.rigs.set(path, load); return load;
  }

  getAnimation(path: string, rig: RigDefinition): Promise<AnimationDefinition> {
    if (this.destroyed) return Promise.reject(new Error("CharacterAssetCache has been destroyed"));
    const key = `${rig.id}\u0000${path}`; const existing = this.animations.get(key); if (existing) return existing;
    const load = loadAnimationDefinition(path, rig, this.fetcher).then((result) => {
      if (!result.success) throw new Error(result.message);
      return deepFreeze(result.data);
    });
    this.animations.set(key, load); return load;
  }

  primeRig(path: string, rig: RigDefinition): void { this.rigs.set(path, Promise.resolve(deepFreeze(rig))); }
  primeAnimation(path: string, rig: RigDefinition, animation: AnimationDefinition): void { this.animations.set(`${rig.id}\u0000${path}`, Promise.resolve(deepFreeze(animation))); }
  getStats(): { readonly rigDefinitions: number; readonly animationDefinitions: number; readonly texturePaths: number } { return { rigDefinitions: this.rigs.size, animationDefinitions: this.animations.size, texturePaths: this.textureLoader.cachedPathCount }; }
  async destroy(): Promise<void> { if (this.destroyed) return; this.destroyed = true; this.rigs.clear(); this.animations.clear(); await this.textureLoader.destroy(); }
}
