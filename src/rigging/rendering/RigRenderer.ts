import { Container, Graphics, Matrix, Sprite, Texture } from "pixi.js";
import { matrixFromTransform, multiplyMatrices, transformPoint, type Matrix2D } from "../math/matrix";
import { degreesToRadians } from "../math/rotation";
import { RigRuntime } from "../runtime/RigRuntime";
import type { AttachmentDefinition } from "../schema/types";
import { RigAssetLoader, type TextureLoadResult } from "../assets/RigAssetLoader";

export type RigRendererOptions = {
  readonly baseUrl?: string;
  readonly onWarning?: (message: string) => void;
  readonly assetLoader?: RigAssetLoader;
  readonly hideMissingAttachments?: boolean;
};

export type SlotRenderOverride = {
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly rotation?: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
  readonly pivotX?: number;
  readonly pivotY?: number;
  readonly tint?: number;
};

type VisibleSlotBounds = {
  readonly matrix: Matrix2D;
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly anchorX: number;
  readonly anchorY: number;
};

export class RigRenderer {
  readonly container = new Container();
  readonly boneContainers = new Map<string, Container>();
  readonly attachmentSprites = new Map<string, Sprite>();
  private readonly slotLayer = new Container();
  private readonly boneHandles = new Graphics();
  private readonly slotBounds = new Graphics();
  private readonly assetLoader: RigAssetLoader;
  private readonly textureResults: Readonly<Record<string, TextureLoadResult>>;
  private readonly warnedAttachments = new Set<string>();
  private readonly slotRenderOverrides = new Map<string, SlotRenderOverride>();
  private showBones = false;
  private showBounds = false;
  private destroyed = false;

  private constructor(
    private readonly runtime: RigRuntime,
    assetLoader: RigAssetLoader,
    textureResults: Readonly<Record<string, TextureLoadResult>>,
    private readonly onWarning?: (message: string) => void,
    private readonly ownsAssetLoader = true,
    private readonly hideMissingAttachments = false,
  ) {
    this.assetLoader = assetLoader;
    this.textureResults = textureResults;
    this.container.sortableChildren = true;
    this.slotLayer.sortableChildren = true;
    this.slotLayer.zIndex = 0;
    this.slotBounds.zIndex = 10_000;
    this.boneHandles.zIndex = 10_001;
    this.container.addChild(this.slotLayer, this.slotBounds, this.boneHandles);

    runtime.definition.bones.forEach((bone) => {
      const container = new Container();
      container.label = `bone:${bone.id}`;
      this.boneContainers.set(bone.id, container);
      this.container.addChild(container);
    });
    runtime.definition.slots.forEach((slot) => {
      const sprite = new Sprite(Texture.WHITE);
      sprite.label = `slot:${slot.id}`;
      sprite.zIndex = slot.zIndex;
      this.attachmentSprites.set(slot.id, sprite);
      this.slotLayer.addChild(sprite);
    });
  }

  static async create(runtime: RigRuntime, options: RigRendererOptions = {}): Promise<RigRenderer> {
    const loader = options.assetLoader ?? new RigAssetLoader(options.baseUrl);
    const textures = await loader.loadRig(runtime.definition);
    return new RigRenderer(runtime, loader, textures, options.onWarning, !options.assetLoader, options.hideMissingAttachments ?? false);
  }

  setBoneHandlesVisible(visible: boolean): void {
    this.showBones = visible;
    this.boneHandles.visible = visible;
  }

  setSlotBoundsVisible(visible: boolean): void {
    this.showBounds = visible;
    this.slotBounds.visible = visible;
  }

  setSlotRenderOverride(slotId: string, override: SlotRenderOverride | null): void {
    if (!this.runtime.slots.has(slotId)) throw new Error(`Slot "${slotId}" does not exist`);
    if (override) this.slotRenderOverrides.set(slotId, { ...override });
    else this.slotRenderOverrides.delete(slotId);
  }

  update(): void {
    if (this.destroyed) return;
    const world = this.runtime.getWorldTransforms();
    this.boneContainers.forEach((container, boneId) => {
      const transform = world[boneId];
      if (transform) container.setFromMatrix(new Matrix(
        transform.matrix.a, transform.matrix.b, transform.matrix.c,
        transform.matrix.d, transform.matrix.tx, transform.matrix.ty,
      ));
    });

    const visibleBounds: VisibleSlotBounds[] = [];
    this.runtime.getResolvedSlots().forEach(({ slot, attachment }) => {
      const sprite = this.attachmentSprites.get(slot.id);
      const bone = world[slot.boneId];
      if (!sprite) return;
      sprite.visible = Boolean(slot.visible && attachment && bone);
      if (!sprite.visible || !attachment || !bone) return;

      const result = this.textureResults[attachment.id];
      const missing = !result?.success;
      if (missing && this.hideMissingAttachments) { this.warnMissingAttachment(attachment, result); sprite.visible = false; return; }
      const texture = result?.success ? result.texture : Texture.WHITE;
      if (missing) this.warnMissingAttachment(attachment, result);
      const override = this.slotRenderOverrides.get(slot.id);
      sprite.texture = texture;
      const pivotX = override?.pivotX ?? slot.pivotX; const pivotY = override?.pivotY ?? slot.pivotY;
      sprite.anchor.set(pivotX / attachment.width, pivotY / attachment.height);
      sprite.tint = missing ? 0xff3d81 : override?.tint ?? slot.tint;
      sprite.alpha = missing ? 0.84 : 1;
      sprite.blendMode = slot.blendMode;
      sprite.zIndex = slot.zIndex;

      const attachmentMatrix = matrixFromTransform({
        x: override?.offsetX ?? attachment.offsetX,
        y: override?.offsetY ?? attachment.offsetY,
        rotation: degreesToRadians(override?.rotation ?? attachment.rotation),
        scaleX: (override?.scaleX ?? attachment.scaleX) * attachment.width / Math.max(1, texture.width),
        scaleY: (override?.scaleY ?? attachment.scaleY) * attachment.height / Math.max(1, texture.height),
      });
      const matrix = multiplyMatrices(bone.matrix, attachmentMatrix);
      sprite.setFromMatrix(new Matrix(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty));
      visibleBounds.push({
        matrix,
        textureWidth: Math.max(1, texture.width),
        textureHeight: Math.max(1, texture.height),
        anchorX: sprite.anchor.x,
        anchorY: sprite.anchor.y,
      });
    });

    if (this.showBounds) this.drawSlotBounds(visibleBounds);
    else this.slotBounds.clear();
    if (this.showBones) this.drawBoneHandles();
    else this.boneHandles.clear();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.attachmentSprites.clear();
    this.boneContainers.clear();
    this.slotRenderOverrides.clear();
    this.container.destroy({ children: true });
    if (this.ownsAssetLoader) void this.assetLoader.destroy();
  }

  private warnMissingAttachment(attachment: AttachmentDefinition, result: TextureLoadResult | undefined): void {
    if (this.warnedAttachments.has(attachment.id)) return;
    this.warnedAttachments.add(attachment.id);
    const reason = result && !result.success ? result.error.message : "No texture result was produced";
    const message = `Attachment "${attachment.id}" could not load from "${attachment.imagePath}": ${reason}`;
    this.onWarning?.(message);
    if (process.env.NODE_ENV !== "production") console.warn(`[RigRenderer] ${message}`);
  }

  private drawBoneHandles(): void {
    this.boneHandles.clear();
    const world = this.runtime.getWorldTransforms();
    this.runtime.definition.bones.forEach((bone) => {
      const transform = world[bone.id];
      if (!transform) return;
      const end = transformPoint(transform.matrix, { x: bone.length, y: 0 });
      this.boneHandles
        .moveTo(transform.x, transform.y)
        .lineTo(end.x, end.y)
        .stroke({ color: 0xc6ff55, width: 2, alpha: 0.88 })
        .circle(transform.x, transform.y, 4)
        .fill({ color: 0xc6ff55, alpha: 0.95 });
    });
  }

  private drawSlotBounds(bounds: readonly VisibleSlotBounds[]): void {
    this.slotBounds.clear();
    bounds.forEach(({ matrix, textureWidth, textureHeight, anchorX, anchorY }) => {
      const left = -anchorX * textureWidth;
      const top = -anchorY * textureHeight;
      const corners = [
        transformPoint(matrix, { x: left, y: top }),
        transformPoint(matrix, { x: left + textureWidth, y: top }),
        transformPoint(matrix, { x: left + textureWidth, y: top + textureHeight }),
        transformPoint(matrix, { x: left, y: top + textureHeight }),
      ];
      this.slotBounds
        .poly(corners.flatMap((point) => [point.x, point.y]), true)
        .stroke({ color: 0x61d8ff, width: 1, alpha: 0.82 });
    });
  }
}
