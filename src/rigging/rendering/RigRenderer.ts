import { Container, Graphics, Matrix, Sprite, Texture } from "pixi.js";
import { matrixFromTransform, multiplyMatrices, transformPoint, type Matrix2D } from "../math/matrix";
import { degreesToRadians } from "../math/rotation";
import { RigRuntime } from "../runtime/RigRuntime";
import type { AttachmentDefinition } from "../schema/types";
import { RigAssetLoader, type TextureLoadResult } from "../assets/RigAssetLoader";
import { rotsprite, snapAngle, type RgbaImage } from "./rotsprite";

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
  /**
   * Pixel art (a canvas of 256 px or less, or metadata.pixelArt): textures are sampled nearest-neighbour, parts sit on
   * whole pixels, and rotated parts are drawn with RotSprite instead of a resampled texture (skill ch09).
   */
  private readonly pixelArt: boolean;
  private readonly sourcePixels = new Map<string, RgbaImage | null>();
  private readonly rotated = new Map<string, { readonly texture: Texture; readonly anchorX: number; readonly anchorY: number; readonly size: number }>();

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
    const canvas = runtime.definition.canvas;
    this.pixelArt = runtime.definition.metadata?.pixelArt === true || Math.max(canvas?.width ?? Infinity, canvas?.height ?? Infinity) <= 256;
    if (this.pixelArt) Object.values(textureResults).forEach((result) => { if (result?.success) result.texture.source.scaleMode = "nearest"; });
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
      const pixel = this.pixelArt && !missing ? this.pixelArtSprite(attachment.id, texture, matrix, pivotX / attachment.width * texture.width, pivotY / attachment.height * texture.height) : null;
      if (pixel) {
        sprite.texture = pixel.texture; sprite.anchor.set(pixel.anchorX, pixel.anchorY);
        sprite.setFromMatrix(new Matrix(1, 0, 0, 1, Math.round(matrix.tx), Math.round(matrix.ty)));
      } else {
        // Pixel art sits on whole pixels even when it cannot be pre-rotated (a limb shortened for a front-view stride).
        sprite.setFromMatrix(new Matrix(matrix.a, matrix.b, matrix.c, matrix.d, this.pixelArt ? Math.round(matrix.tx) : matrix.tx, this.pixelArt ? Math.round(matrix.ty) : matrix.ty));
      }
      visibleBounds.push({
        matrix,
        textureWidth: Math.max(1, texture.width),
        textureHeight: Math.max(1, texture.height),
        anchorX: (pivotX / attachment.width),
        anchorY: (pivotY / attachment.height),
      });
    });

    if (this.showBounds) this.drawSlotBounds(visibleBounds);
    else this.slotBounds.clear();
    if (this.showBones) this.drawBoneHandles();
    else this.boneHandles.clear();
  }

  /**
   * A part that is only rotated (not stretched or mirrored), drawn as a RotSprite copy at the nearest 5° step about its
   * pivot, cached per part and angle. Null when it should be drawn as an ordinary transformed texture.
   */
  private pixelArtSprite(attachmentId: string, texture: Texture, matrix: { readonly a: number; readonly b: number; readonly c: number; readonly d: number }, pivotX: number, pivotY: number) {
    const scaleX = Math.hypot(matrix.a, matrix.b); const scaleY = Math.hypot(matrix.c, matrix.d);
    if (Math.abs(scaleX - 1) > .03 || Math.abs(scaleY - 1) > .03 || matrix.a * matrix.d - matrix.b * matrix.c <= 0) return null;
    const angle = snapAngle(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI);
    const key = `${attachmentId}:${angle}:${pivotX.toFixed(1)},${pivotY.toFixed(1)}`;
    const cached = this.rotated.get(key); if (cached) return cached;
    const pixels = this.readPixels(attachmentId, texture); if (!pixels || typeof document === "undefined") return null;
    const result = rotsprite(pixels, angle, { x: pivotX, y: pivotY });
    const canvas = document.createElement("canvas"); canvas.width = result.image.width; canvas.height = result.image.height;
    const context = canvas.getContext("2d"); if (!context) return null;
    context.putImageData(new ImageData(new Uint8ClampedArray(result.image.data), result.image.width, result.image.height), 0, 0);
    const rotatedTexture = Texture.from(canvas); rotatedTexture.source.scaleMode = "nearest";
    const entry = { texture: rotatedTexture, anchorX: result.pivot.x / result.image.width, anchorY: result.pivot.y / result.image.height, size: result.image.width };
    this.rotated.set(key, entry);
    return entry;
  }

  /** The part's pixels, read once from its texture. Null when the texture cannot be read (no DOM, or a tainted image). */
  private readPixels(attachmentId: string, texture: Texture): RgbaImage | null {
    if (this.sourcePixels.has(attachmentId)) return this.sourcePixels.get(attachmentId) ?? null;
    let pixels: RgbaImage | null = null;
    try {
      const resource = texture.source.resource as CanvasImageSource | undefined;
      if (resource && typeof document !== "undefined") {
        const canvas = document.createElement("canvas"); canvas.width = texture.width; canvas.height = texture.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (context) { context.drawImage(resource, 0, 0, texture.width, texture.height); pixels = { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data }; }
      }
    } catch { pixels = null; }
    this.sourcePixels.set(attachmentId, pixels);
    return pixels;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rotated.forEach((entry) => entry.texture.destroy(true));
    this.rotated.clear();
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
