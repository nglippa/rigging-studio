import { Container, Graphics } from "pixi.js";
import { AnimationPlayer } from "../../rigging/animation/AnimationPlayer";
import { RigRenderer, type SlotRenderOverride } from "../../rigging/rendering/RigRenderer";
import { RigRuntime } from "../../rigging/runtime/RigRuntime";
import type { AnimationDefinition, RigDefinition } from "../../rigging/schema/types";
import type { CharacterAssetCache } from "./CharacterAssetCache";
import type { AnimationCompleteEvent, AnimationCompleteListener, CharacterAppearanceDefinition, CharacterBounds, CharacterFacing, CharacterVisualBackend, EquipmentAttachmentTransform, EquipmentSlot } from "./types";
import { resolveMappedAnimation } from "./animationResolution";

const mergeTransform = (base: EquipmentAttachmentTransform, override: EquipmentAttachmentTransform | undefined): SlotRenderOverride => ({ ...base, ...override });

export class ModularRigVisual implements CharacterVisualBackend {
  readonly kind = "modularRig" as const;
  readonly container = new Container();
  private readonly visualRoot = new Container();
  private readonly listeners = new Set<AnimationCompleteListener>();
  private readonly animations = new Map<string, AnimationDefinition>();
  private readonly equipment: Partial<Record<EquipmentSlot, string | null>>;
  private runtime: RigRuntime | null = null;
  private renderer: RigRenderer | null = null;
  private player: AnimationPlayer | null = null;
  private rig: RigDefinition | null = null;
  private currentAction = "";
  private currentClipId = "";
  private completionSent = false;
  private destroyed = false;

  constructor(private readonly appearance: CharacterAppearanceDefinition, private readonly cache: CharacterAssetCache, private readonly warn: (message: string) => void) {
    this.equipment = { ...appearance.equipmentSlots };
    if (appearance.shadow.enabled) {
      const shadow = new Graphics().ellipse(appearance.shadow.offsetX, appearance.shadow.offsetY, appearance.shadow.radiusX, appearance.shadow.radiusY).fill({ color: appearance.shadow.color, alpha: appearance.shadow.alpha });
      this.container.addChild(shadow);
    }
    this.container.addChild(this.visualRoot);
  }

  async load(): Promise<void> {
    if (!this.appearance.rigPath || !this.appearance.rigId) throw new Error("Modular appearance is missing rigId or rigPath");
    const rig = await this.cache.getRig(this.appearance.rigPath);
    if (rig.id !== this.appearance.rigId) throw new Error(`Appearance expected rig "${this.appearance.rigId}" but loaded "${rig.id}"`);
    this.rig = rig; this.runtime = new RigRuntime(rig);
    for (const asset of Object.values(this.appearance.animations)) {
      if (!asset.path) continue;
      try { this.animations.set(asset.id, await this.cache.getAnimation(asset.path, rig)); }
      catch (reason: unknown) { this.warn(`Animation "${asset.id}" failed to load: ${reason instanceof Error ? reason.message : "unknown error"}`); }
    }
    this.renderer = await RigRenderer.create(this.runtime, { assetLoader: this.cache.textureLoader, hideMissingAttachments: true, onWarning: this.warn });
    this.player = new AnimationPlayer(this.runtime); this.visualRoot.addChild(this.renderer.container);
    this.renderer.container.position.set(this.appearance.worldOffset.x, this.appearance.worldOffset.y);
    this.setFacing(this.appearance.directionalBehavior.authoredFacing); this.setTint(this.appearance.palette.baseTint); this.setSkin(this.appearance.skinId);
    (Object.keys(this.equipment) as EquipmentSlot[]).forEach((slot) => this.applyEquipment(slot));
    this.renderer.update();
  }

  update(deltaSeconds: number): void {
    const player = this.player; if (!player) return;
    player.update(deltaSeconds); this.renderer?.update();
    if (player.completed && !this.completionSent) { this.completionSent = true; this.emit({ action: this.currentAction, clipId: this.currentClipId }); }
  }

  setPosition(x: number, y: number): void { this.container.position.set(this.appearance.snapToPixels ? Math.round(x) : x, this.appearance.snapToPixels ? Math.round(y) : y); }
  setFacing(facing: CharacterFacing): void { const sign = facing === this.appearance.directionalBehavior.authoredFacing ? 1 : -1; this.visualRoot.scale.set(sign * this.appearance.scale, this.appearance.scale); }
  playAnimation(action: string, restart = true): void {
    const resolved = this.resolveAnimation(action); if (!resolved || !this.player) return;
    this.currentAction = action; this.currentClipId = resolved.id; this.completionSent = false; this.player.play(resolved, restart);
    (Object.keys(this.equipment) as EquipmentSlot[]).forEach((slot) => this.applyEquipment(slot));
  }
  stopAnimation(): void { this.player?.stop(); this.completionSent = false; this.renderer?.update(); }
  setPlaybackSpeed(speed: number): void { this.player?.setPlaybackSpeed(speed); }
  setVisible(visible: boolean): void { this.container.visible = visible; }
  setTint(tint: number): void { if (this.renderer) this.renderer.container.tint = tint; }
  setEquipment(slot: EquipmentSlot, itemId: string | null): void { this.equipment[slot] = this.validEquipment(slot, itemId); this.applyEquipment(slot); this.renderer?.update(); }
  setSkin(skinId: string | null): void {
    if (!this.runtime || !this.rig) return;
    const requested = skinId ?? this.rig.defaultSkinId; const valid = this.rig.skins.some((skin) => skin.id === requested) ? requested : this.rig.defaultSkinId;
    if (valid !== requested) this.warn(`Skin "${requested}" is invalid; using "${valid}"`);
    this.runtime.applySkin(valid); this.renderer?.update();
  }
  setExpression(expression: string | null): void {
    if (!this.runtime || !this.appearance.expressionSlotId) return;
    const attachment = expression ? this.appearance.expressionMapping[expression] : null;
    try { this.runtime.replaceSlotAttachment(this.appearance.expressionSlotId, attachment ?? null); this.renderer?.update(); }
    catch (reason: unknown) { this.warn(`Expression "${expression ?? "default"}" was ignored: ${reason instanceof Error ? reason.message : "invalid definition"}`); }
  }
  setLayer(layer: number): void { this.container.zIndex = layer; }
  getBounds(): CharacterBounds { const bounds = this.container.getBounds(); return { x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY }; }
  onAnimationComplete(listener: AnimationCompleteListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setDebugDisplay(showBones: boolean, showBounds: boolean): void { this.renderer?.setBoneHandlesVisible(showBones); this.renderer?.setSlotBoundsVisible(showBounds); this.renderer?.update(); }
  getLoadedAssets(): readonly string[] { return [...new Set([...(this.appearance.rigPath ? [this.appearance.rigPath] : []), ...Object.values(this.appearance.animations).flatMap((asset) => asset.path ? [asset.path] : []), ...(this.rig?.attachments.map((attachment) => attachment.imagePath) ?? [])])]; }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.listeners.clear(); this.animations.clear(); this.player?.stop(); this.renderer?.destroy(); this.runtime = null; this.renderer = null; this.player = null; this.rig = null; this.container.destroy({ children: true }); }

  getRuntimeForDiagnostics(): RigRuntime | null { return this.runtime; }

  private validEquipment(slot: EquipmentSlot, itemId: string | null): string | null {
    if (itemId === null) return null;
    const item = this.appearance.equipmentCatalog[itemId];
    if (item?.slot === slot) return itemId;
    const fallback = this.appearance.equipmentSlots[slot] ?? null;
    this.warn(`Equipment "${itemId}" is invalid for ${slot}; using ${fallback ?? "empty"}`); return fallback;
  }
  private applyEquipment(slot: EquipmentSlot): void {
    const runtime = this.runtime; const renderer = this.renderer; const rig = this.rig; const rigSlotId = this.appearance.equipmentRigSlots[slot];
    if (!runtime || !renderer || !rig || !rigSlotId) return;
    const itemId = this.equipment[slot] ?? null; const item = itemId ? this.appearance.equipmentCatalog[itemId] : null;
    if (item && item.slot !== slot) { this.equipment[slot] = this.validEquipment(slot, item.id); this.applyEquipment(slot); return; }
    if (item?.attachmentId && !rig.attachments.some((attachment) => attachment.id === item.attachmentId)) {
      this.warn(`Equipment "${item.id}" references missing attachment "${item.attachmentId}"; hiding ${slot}`);
      runtime.replaceSlotAttachment(rigSlotId, null); renderer.setSlotRenderOverride(rigSlotId, null); return;
    }
    try {
      runtime.replaceSlotAttachment(rigSlotId, item?.attachmentId ?? null);
      renderer.setSlotRenderOverride(rigSlotId, item ? mergeTransform(item.transform, item.animationOverrides[this.currentClipId] ?? item.animationOverrides[this.currentAction]) : null);
    } catch (reason: unknown) { this.warn(`Equipment slot ${slot} was hidden: ${reason instanceof Error ? reason.message : "invalid slot"}`); }
  }
  private resolveAnimation(action: string): AnimationDefinition | null {
    const resolution = resolveMappedAnimation(action, this.appearance, new Set(this.animations.keys())); const animation = resolution ? this.animations.get(resolution.clipId) : undefined;
    if (resolution?.fellBack && animation) this.warn(`Animation "${action}" is unavailable; using "${animation.id}"`);
    else if (!animation) this.warn(`Animation "${action}" is unavailable and no fallback loaded`);
    return animation ?? null;
  }
  private emit(event: AnimationCompleteEvent): void { this.listeners.forEach((listener) => listener(event)); }
}
