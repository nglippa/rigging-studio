import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RedrawStore, fingerprint } from "../../src/image-production/bake/redrawStore";
import type { AnimationDefinition, RigDefinition } from "../../src/rigging/schema/types";

const rig: RigDefinition = {
  schemaVersion: 1, id: "rig", canvas: { width: 64, height: 64 }, rootBoneId: "root",
  bones: [{ id: "root", parentId: null, x: 32, y: 60, rotation: 0, scaleX: 1, scaleY: 1, length: 10, inheritRotation: true, inheritScale: true }],
  slots: [{ id: "body-slot", boneId: "root", attachmentId: "body", zIndex: 0, visible: true, blendMode: "normal", tint: 0xffffff, pivotX: 0, pivotY: 0 }],
  attachments: [{ id: "body", imagePath: "data:image/png;base64,AAAA", width: 8, height: 8, offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1, category: "body", tags: [] }],
  skins: [{ id: "base", name: "Base", slotAttachments: {} }], defaultSkinId: "base", metadata: { name: "Test" },
};
const clip: AnimationDefinition = { schemaVersion: 1, id: "idle", name: "Idle", duration: 1, loop: true, drawings: [0, .5], tracks: [{ boneId: "root", property: "rotation", keyframes: [{ time: 0, value: 0, easing: "linear" }, { time: 1, value: 10, easing: "linear" }] }] };

describe("redraw fingerprint", () => {
  it("is stable for equal input", () => {
    expect(fingerprint(rig, clip, "redraw")).toBe(fingerprint(structuredClone(rig), structuredClone(clip), "redraw"));
  });
  it("changes with the rig, the art, the clip and the mode", () => {
    const base = fingerprint(rig, clip, "redraw");
    expect(fingerprint({ ...rig, bones: [{ ...rig.bones[0], x: 33 }] }, clip, "redraw")).not.toBe(base);
    expect(fingerprint({ ...rig, attachments: [{ ...rig.attachments[0], imagePath: "data:image/png;base64,BBBB" }] }, clip, "redraw")).not.toBe(base);
    expect(fingerprint(rig, { ...clip, tracks: [{ ...clip.tracks[0], keyframes: [clip.tracks[0].keyframes[0], { ...clip.tracks[0].keyframes[1], value: 12 }] }] }, "redraw")).not.toBe(base);
    expect(fingerprint(rig, clip, "polish")).not.toBe(base);
  });
  it("ignores the rig's name and other metadata", () => {
    expect(fingerprint({ ...rig, metadata: { name: "Renamed" } }, clip, "redraw")).toBe(fingerprint(rig, clip, "redraw"));
  });
});

describe("RedrawStore", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("finds a recorded clip by its fingerprint, and only by it", async () => {
    root = await mkdtemp(path.join(tmpdir(), "redraws-"));
    const store = new RedrawStore(root);
    await store.record("project-a", "idle", "f1", "bake-1");
    expect(await store.lookup("project-a", "idle", "f1")).toEqual({ jobId: "bake-1" });
    expect(await store.lookup("project-a", "idle", "f2")).toBeNull();
    expect(await store.lookup("project-b", "idle", "f1")).toBeNull();
  });

  it("survives a new instance on the same folder, and keeps parallel records", async () => {
    root = await mkdtemp(path.join(tmpdir(), "redraws-"));
    const store = new RedrawStore(root);
    await Promise.all([store.record("p", "idle", "f1", "bake-1"), store.record("p", "walk", "f2", "bake-2")]);
    const again = new RedrawStore(root);
    expect(await again.lookup("p", "idle", "f1")).toEqual({ jobId: "bake-1" });
    expect(await again.lookup("p", "walk", "f2")).toEqual({ jobId: "bake-2" });
  });
});
