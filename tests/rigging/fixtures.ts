import type { AnimationDefinition, RigDefinition } from "../../src/rigging/schema/types";

export const validRig = (): RigDefinition => ({
  schemaVersion: 1,
  id: "unit-rig",
  canvas: { width: 100, height: 100 },
  rootBoneId: "root",
  bones: [
    { id: "root", parentId: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 10, inheritRotation: true, inheritScale: true },
    { id: "child", parentId: "root", x: 10, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 8, inheritRotation: true, inheritScale: true },
  ],
  slots: [{ id: "body", boneId: "child", attachmentId: "body-image", zIndex: 0, visible: true, blendMode: "normal", tint: 0xffffff, pivotX: 0, pivotY: 0 }],
  attachments: [{ id: "body-image", imagePath: "parts/body.png", width: 20, height: 30, offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1, category: "body", tags: [] }],
  skins: [{ id: "base", name: "Base", slotAttachments: { body: "body-image" } }],
  defaultSkinId: "base",
  metadata: {},
});

export const validAnimation = (): AnimationDefinition => ({
  schemaVersion: 1, id: "idle", name: "Idle", duration: 1, loop: true,
  tracks: [{ boneId: "child", property: "rotation", keyframes: [
    { time: 0, value: 0, easing: "linear" }, { time: 1, value: 0.1, easing: "linear" },
  ] }],
});
