import { Container, Graphics } from "pixi.js";
import type { CharacterBounds, CharacterVisualBackend } from "./types";

export class PlaceholderVisual implements CharacterVisualBackend {
  readonly kind = "placeholder" as const;
  readonly container = new Container();
  private destroyed = false;
  constructor() { this.container.addChild(new Graphics().rect(-14, -42, 28, 42).fill({ color: 0xff3d81, alpha: .78 }).stroke({ color: 0xffffff, width: 2, alpha: .9 }).moveTo(-10, -38).lineTo(10, -8).moveTo(10, -38).lineTo(-10, -8).stroke({ color: 0xffffff, width: 2, alpha: .8 })); }
  async load(): Promise<void> { return undefined; }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.container.destroy({ children: true }); }
  update(): void {}
  setPosition(x: number, y: number): void { this.container.position.set(Math.round(x), Math.round(y)); }
  setFacing(): void {}
  playAnimation(): void {}
  stopAnimation(): void {}
  setPlaybackSpeed(): void {}
  setVisible(visible: boolean): void { this.container.visible = visible; }
  setTint(tint: number): void { this.container.tint = tint; }
  setEquipment(): void {}
  setSkin(): void {}
  setExpression(): void {}
  setLayer(layer: number): void { this.container.zIndex = layer; }
  getBounds(): CharacterBounds { const bounds = this.container.getBounds(); return { x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY }; }
  onAnimationComplete(): () => void { return () => undefined; }
  setDebugDisplay(): void {}
  getLoadedAssets(): readonly string[] { return []; }
}
