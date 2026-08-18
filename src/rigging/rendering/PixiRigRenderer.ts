import { Container, Matrix, Sprite, type Texture } from "pixi.js";
import { matrixFromTransform, multiplyMatrices } from "../math/matrix";
import { degreesToRadians } from "../math/rotation";
import { resolveSlots, type SlotAttachmentOverrides } from "../runtime/slots";
import { computeWorldTransforms } from "../runtime/worldTransforms";
import type { RigPose } from "../runtime/types";
import type { RigDefinition } from "../schema/types";

export type PixiTextureMap = Readonly<Record<string, Texture>>;

export class PixiRigRenderer {
  readonly container = new Container();
  private readonly sprites = new Map<string, Sprite>();

  constructor(private readonly rig: RigDefinition, private readonly textures: PixiTextureMap) {
    this.container.sortableChildren = true;
    rig.slots.forEach((slot) => {
      const sprite = new Sprite();
      sprite.label = slot.id;
      sprite.zIndex = slot.zIndex;
      this.sprites.set(slot.id, sprite);
      this.container.addChild(sprite);
    });
  }

  update(pose: RigPose, skinId = this.rig.defaultSkinId, overrides: SlotAttachmentOverrides = {}): void {
    const world = computeWorldTransforms(this.rig, pose);
    resolveSlots(this.rig, skinId, overrides).forEach(({ slot, attachment }) => {
      const sprite = this.sprites.get(slot.id);
      if (!sprite) return;
      const texture = attachment ? this.textures[attachment.id] : undefined;
      const bone = world[slot.boneId];
      sprite.visible = Boolean(slot.visible && attachment && texture && bone);
      if (!sprite.visible || !attachment || !texture || !bone) return;
      sprite.texture = texture;
      sprite.anchor.set(slot.pivotX / attachment.width, slot.pivotY / attachment.height);
      sprite.tint = slot.tint;
      sprite.blendMode = slot.blendMode;
      const local = matrixFromTransform({
        x: attachment.offsetX,
        y: attachment.offsetY,
        rotation: degreesToRadians(attachment.rotation),
        scaleX: attachment.scaleX * attachment.width / Math.max(1, texture.width),
        scaleY: attachment.scaleY * attachment.height / Math.max(1, texture.height),
      });
      const transform = multiplyMatrices(bone.matrix, local);
      sprite.setFromMatrix(new Matrix(transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty));
    });
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.sprites.clear();
  }
}
