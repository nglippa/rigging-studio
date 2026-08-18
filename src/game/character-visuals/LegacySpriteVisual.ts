import { Container, Graphics, Sprite, Texture } from "pixi.js";
import type { CharacterAssetCache } from "./CharacterAssetCache";
import type { AnimationCompleteEvent, AnimationCompleteListener, CharacterAppearanceDefinition, CharacterBounds, CharacterFacing, CharacterVisualBackend } from "./types";
import { resolveMappedAnimation } from "./animationResolution";

type LoadedLegacyClip = { readonly id: string; readonly textures: readonly Texture[]; readonly fps: number; readonly loop: boolean };

export class LegacySpriteVisual implements CharacterVisualBackend {
  readonly kind = "legacySprite" as const;
  readonly container = new Container();
  private readonly visualRoot = new Container();
  private readonly sprite = new Sprite(Texture.WHITE);
  private readonly listeners = new Set<AnimationCompleteListener>();
  private readonly clips = new Map<string, LoadedLegacyClip>();
  private loadedAssets: string[] = [];
  private currentAction = "";
  private currentClip: LoadedLegacyClip | null = null;
  private time = 0;
  private speed = 1;
  private playing = false;
  private completionSent = false;
  private destroyed = false;

  constructor(private readonly appearance: CharacterAppearanceDefinition, private readonly cache: CharacterAssetCache, private readonly warn: (message: string) => void) {
    if (appearance.shadow.enabled) {
      const shadow = new Graphics().ellipse(appearance.shadow.offsetX, appearance.shadow.offsetY, appearance.shadow.radiusX, appearance.shadow.radiusY).fill({ color: appearance.shadow.color, alpha: appearance.shadow.alpha });
      this.container.addChild(shadow);
    }
    this.sprite.anchor.set(appearance.legacy.anchorX, appearance.legacy.anchorY);
    this.visualRoot.addChild(this.sprite); this.container.addChild(this.visualRoot);
  }

  async load(): Promise<void> {
    const base = await this.cache.textureLoader.loadPath(this.appearance.legacy.imagePath);
    if (!base.success) throw new Error(`Legacy fallback could not load: ${base.error.message}`);
    base.texture.source.scaleMode = "nearest"; this.sprite.texture = base.texture; this.loadedAssets.push(base.url);
    for (const clip of Object.values(this.appearance.animations)) {
      const paths = clip.legacyFramePaths.length ? clip.legacyFramePaths : [this.appearance.legacy.imagePath];
      const results = await Promise.all(paths.map((path) => this.cache.textureLoader.loadPath(path)));
      const successful = results.flatMap((result) => result.success ? [result] : []);
      successful.forEach((result) => { result.texture.source.scaleMode = "nearest"; this.loadedAssets.push(result.url); });
      if (!successful.length) { this.warn(`Legacy animation "${clip.id}" has no loadable frames`); continue; }
      this.clips.set(clip.id, { id: clip.id, textures: successful.map((result) => result.texture), fps: clip.legacyFps, loop: clip.loop ?? true });
    }
    this.setFacing(this.appearance.directionalBehavior.authoredFacing); this.setTint(this.appearance.palette.baseTint);
  }

  update(deltaSeconds: number): void {
    const clip = this.currentClip; if (!clip || !this.playing || deltaSeconds <= 0) return;
    this.time += deltaSeconds * this.speed; const duration = clip.textures.length / clip.fps;
    if (!clip.loop && this.time >= duration) { this.time = duration; this.playing = false; if (!this.completionSent) { this.completionSent = true; this.emit({ action: this.currentAction, clipId: clip.id }); } }
    const rawIndex = Math.floor(this.time * clip.fps); const index = clip.loop ? rawIndex % clip.textures.length : Math.min(clip.textures.length - 1, rawIndex);
    this.sprite.texture = clip.textures[index] ?? this.sprite.texture;
  }

  setPosition(x: number, y: number): void { this.container.position.set(this.appearance.snapToPixels ? Math.round(x) : x, this.appearance.snapToPixels ? Math.round(y) : y); }
  setFacing(facing: CharacterFacing): void { const authored = this.appearance.directionalBehavior.authoredFacing; this.visualRoot.scale.set((facing === authored ? 1 : -1) * this.appearance.scale, this.appearance.scale); }
  playAnimation(action: string, restart = true): void {
    const resolution = resolveMappedAnimation(action, this.appearance, new Set(this.clips.keys())); const clip = resolution ? this.clips.get(resolution.clipId) : undefined;
    if (!clip) { this.warn(`Legacy animation "${action}" is unavailable`); return; }
    if (resolution?.fellBack) this.warn(`Legacy animation "${action}" fell back to "${clip.id}"`);
    if (restart || this.currentClip !== clip) this.time = 0;
    this.currentAction = action; this.currentClip = clip; this.playing = true; this.completionSent = false; this.sprite.texture = clip.textures[0] ?? this.sprite.texture;
  }
  stopAnimation(): void { this.playing = false; this.time = 0; this.currentClip = null; }
  setPlaybackSpeed(speed: number): void { if (!Number.isFinite(speed) || speed <= 0) throw new Error("Playback speed must be positive"); this.speed = speed; }
  setVisible(visible: boolean): void { this.container.visible = visible; }
  setTint(tint: number): void { this.sprite.tint = tint; }
  setEquipment(): void { /* Legacy art already bakes its equipment into frames. */ }
  setSkin(): void { /* Legacy fallback has no modular skin state. */ }
  setExpression(): void { /* Legacy expression frames can be added as mapped clips later. */ }
  setLayer(layer: number): void { this.container.zIndex = layer; }
  getBounds(): CharacterBounds { const bounds = this.container.getBounds(); return { x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY }; }
  onAnimationComplete(listener: AnimationCompleteListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setDebugDisplay(): void { /* Static sprite has no debug skeleton. */ }
  getLoadedAssets(): readonly string[] { return [...new Set(this.loadedAssets)]; }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.listeners.clear(); this.clips.clear(); this.container.destroy({ children: true }); }
  private emit(event: AnimationCompleteEvent): void { this.listeners.forEach((listener) => listener(event)); }
}
