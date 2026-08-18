import type { Container } from "pixi.js";
import { CharacterAssetCache } from "./CharacterAssetCache";
import { LegacySpriteVisual } from "./LegacySpriteVisual";
import { ModularRigVisual } from "./ModularRigVisual";
import { PlaceholderVisual } from "./PlaceholderVisual";
import type { AnimationCompleteListener, CharacterAppearanceDefinition, CharacterAppearanceSave, CharacterBounds, CharacterFacing, CharacterVisualBackend, CharacterVisualBackendKind, CharacterVisualWarning, EquipmentSlot } from "./types";

export type CharacterBackendFactory = (kind: CharacterVisualBackendKind | "placeholder", appearance: CharacterAppearanceDefinition, cache: CharacterAssetCache, warn: (message: string) => void) => CharacterVisualBackend;
export type CharacterVisualControllerOptions = { readonly cache?: CharacterAssetCache; readonly backendFactory?: CharacterBackendFactory; readonly onWarning?: (warning: CharacterVisualWarning) => void };

const defaultFactory: CharacterBackendFactory = (kind, appearance, cache, warn) => kind === "modularRig" ? new ModularRigVisual(appearance, cache, warn) : kind === "legacySprite" ? new LegacySpriteVisual(appearance, cache, warn) : new PlaceholderVisual();

export class CharacterVisualController {
  private readonly cache: CharacterAssetCache;
  private readonly ownsCache: boolean;
  private readonly factory: CharacterBackendFactory;
  private readonly listeners = new Set<AnimationCompleteListener>();
  private readonly warningMessages: string[] = [];
  private backend: CharacterVisualBackend | null = null;
  private unsubscribeBackend: (() => void) | null = null;
  private loaded = false;
  private destroyed = false;
  private position = { x: 0, y: 0 };
  private facing: CharacterFacing;
  private action: string;
  private speed = 1;
  private visible = true;
  private tint: number;
  private layer = 0;
  private skinId: string | null;
  private expression: string | null = null;
  private equipment: Partial<Record<EquipmentSlot, string | null>>;

  constructor(readonly appearance: CharacterAppearanceDefinition, private readonly options: CharacterVisualControllerOptions = {}) {
    this.cache = options.cache ?? new CharacterAssetCache(); this.ownsCache = !options.cache; this.factory = options.backendFactory ?? defaultFactory;
    this.facing = appearance.directionalBehavior.authoredFacing; this.action = appearance.fallbackAnimation; this.tint = appearance.palette.baseTint; this.skinId = appearance.skinId; this.equipment = { ...appearance.equipmentSlots };
  }

  get container(): Container { if (!this.backend) throw new Error("CharacterVisualController must load before its container is used"); return this.backend.container; }
  get currentBackend(): CharacterVisualBackendKind | "placeholder" | "unloaded" { return this.backend?.kind ?? "unloaded"; }
  get warnings(): readonly string[] { return [...this.warningMessages]; }

  async load(): Promise<void> {
    if (this.destroyed) throw new Error("Cannot load a destroyed CharacterVisualController");
    if (this.loaded) return;
    const preferred = this.appearance.visualBackend;
    try { await this.installBackend(preferred); }
    catch (reason: unknown) {
      this.warn(preferred, `${preferred} failed: ${reason instanceof Error ? reason.message : "unknown load error"}`);
      if (preferred === "modularRig") {
        try { await this.installBackend("legacySprite"); this.warn("legacySprite", "Using configured legacy fallback"); }
        catch (legacyReason: unknown) { this.warn("legacySprite", `Legacy fallback failed: ${legacyReason instanceof Error ? legacyReason.message : "unknown load error"}`); await this.installBackend("placeholder"); }
      } else await this.installBackend("placeholder");
    }
    this.loaded = true; this.applyState();
  }

  update(deltaSeconds: number): void { if (!this.destroyed) this.backend?.update(deltaSeconds); }
  setPosition(x: number, y: number): void { this.position = { x, y }; this.backend?.setPosition(x, y); }
  setFacing(facing: CharacterFacing): void { this.facing = facing; this.backend?.setFacing(facing); }
  playAnimation(action: string, restart = true): void { this.action = action; this.backend?.playAnimation(action, restart); }
  stopAnimation(): void { this.backend?.stopAnimation(); }
  setPlaybackSpeed(speed: number): void { if (!Number.isFinite(speed) || speed <= 0) throw new Error("Playback speed must be positive"); this.speed = speed; this.backend?.setPlaybackSpeed(speed); }
  setVisible(visible: boolean): void { this.visible = visible; this.backend?.setVisible(visible); }
  setTint(tint: number): void { this.tint = Math.max(0, Math.min(0xffffff, Math.round(tint))); this.backend?.setTint(this.tint); }
  setEquipment(slot: EquipmentSlot, itemId: string | null): void { this.equipment = { ...this.equipment, [slot]: this.validEquipment(slot, itemId) }; this.backend?.setEquipment(slot, this.equipment[slot] ?? null); }
  setSkin(skinId: string | null): void { this.skinId = skinId; this.backend?.setSkin(skinId); }
  setExpression(expression: string | null): void { this.expression = expression; this.backend?.setExpression(expression); }
  setLayer(layer: number): void { this.layer = layer; this.backend?.setLayer(layer); }
  getBounds(): CharacterBounds { return this.backend?.getBounds() ?? { x: this.position.x, y: this.position.y, width: 0, height: 0 }; }
  onAnimationComplete(listener: AnimationCompleteListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setDebugDisplay(showBones: boolean, showBounds: boolean): void { this.backend?.setDebugDisplay(showBones, showBounds); }
  getLoadedAssets(): readonly string[] { return this.backend?.getLoadedAssets() ?? []; }
  getAppearanceSave(): CharacterAppearanceSave { return { saveVersion: 1, characterId: this.appearance.characterId, skinId: this.skinId, equipment: { ...this.equipment }, tint: this.tint, expression: this.expression }; }
  restoreAppearance(state: CharacterAppearanceSave): void {
    if (state.characterId !== this.appearance.characterId) { this.warn(this.currentBackend === "unloaded" ? this.appearance.visualBackend : this.currentBackend, `Ignored appearance save for "${state.characterId}"`); return; }
    this.setSkin(state.skinId); (Object.keys(state.equipment) as EquipmentSlot[]).forEach((slot) => this.setEquipment(slot, state.equipment[slot] ?? null)); this.setTint(state.tint); this.setExpression(state.expression);
  }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.unsubscribeBackend?.(); this.listeners.clear(); this.backend?.destroy(); this.backend = null; if (this.ownsCache) void this.cache.destroy(); }

  private async installBackend(kind: CharacterVisualBackendKind | "placeholder"): Promise<void> {
    this.unsubscribeBackend?.(); this.backend?.destroy();
    const backend = this.factory(kind, this.appearance, this.cache, (message) => this.warn(kind, message)); this.backend = backend;
    try { await backend.load(); this.unsubscribeBackend = backend.onAnimationComplete((event) => this.listeners.forEach((listener) => listener(event))); }
    catch (reason: unknown) { backend.destroy(); if (this.backend === backend) this.backend = null; throw reason; }
  }
  private applyState(): void {
    this.setPosition(this.position.x, this.position.y); this.setFacing(this.facing); this.setPlaybackSpeed(this.speed); this.setVisible(this.visible); this.setTint(this.tint); this.setLayer(this.layer); this.setSkin(this.skinId); this.setExpression(this.expression);
    (Object.keys(this.equipment) as EquipmentSlot[]).forEach((slot) => this.backend?.setEquipment(slot, this.equipment[slot] ?? null)); this.playAnimation(this.action);
  }
  private validEquipment(slot: EquipmentSlot, itemId: string | null): string | null {
    if (itemId === null) return null; const item = this.appearance.equipmentCatalog[itemId]; if (item?.slot === slot) return itemId;
    const fallback = this.appearance.equipmentSlots[slot] ?? null; this.warn(this.currentBackend === "unloaded" ? this.appearance.visualBackend : this.currentBackend, `Invalid ${slot} item "${itemId}"; using ${fallback ?? "empty"}`); return fallback;
  }
  private warn(backend: CharacterVisualBackendKind | "placeholder", message: string): void {
    if (!this.warningMessages.includes(message)) this.warningMessages.push(message);
    this.options.onWarning?.({ characterId: this.appearance.characterId, backend, message });
    if (process.env.NODE_ENV !== "production") console.warn(`[CharacterVisualController:${this.appearance.characterId}] ${message}`);
  }
}
