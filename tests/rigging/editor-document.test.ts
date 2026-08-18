import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addBone,
  assignSkinAttachment,
  BoneDeletionBlockedError,
  canReparentBone,
  createSkin,
  deleteBone,
  updateBone,
} from "../../src/tools/rig-editor/document";
import { validRig } from "./fixtures";
import { RigCommandHistory } from "../../src/tools/rig-editor/history";

describe("rig editor document safeguards", () => {
  it("prevents parent changes that create a cycle", () => {
    const withGrandchild = addBone(validRig(), "child").rig;
    expect(canReparentBone(withGrandchild, "child", "bone")).toBe(false);
    expect(() => updateBone(withGrandchild, "child", { parentId: "bone" })).toThrow(/cannot be parented/);
  });

  it("blocks bone deletion until dependent slots receive a valid repair", () => {
    const rig = validRig();
    expect(() => deleteBone(rig, "child")).toThrow(BoneDeletionBlockedError);
    const repaired = deleteBone(rig, "child", { reparentChildrenTo: "root", moveSlotsTo: "root" });
    expect(repaired.bones.some((bone) => bone.id === "child")).toBe(false);
    expect(repaired.slots[0].boneId).toBe("root");
    expect(() => deleteBone(rig, "root")).toThrow(/root bone/);
  });

  it("uses an undoable in-app repair path without native prompt APIs", () => {
    const rig = validRig(); const history = new RigCommandHistory(rig);
    history.execute("Delete bone with repair", (current) => deleteBone(current, "child", { reparentChildrenTo: "root", moveSlotsTo: "root" }));
    expect(history.present.bones.some((bone) => bone.id === "child")).toBe(false); expect(history.undo()).toEqual(rig);
    const source = readFileSync(new URL("../../app/rig-editor/RigEditor.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/window\.(prompt|confirm|alert)/);
  });

  it("assigns an attachment per slot without mutating the source skin", () => {
    const rig = validRig();
    const created = createSkin(rig);
    const assigned = assignSkinAttachment(created.rig, created.id, "body", null);
    expect(assigned.skins.find((skin) => skin.id === created.id)?.slotAttachments.body).toBeNull();
    expect(rig.skins[0].slotAttachments.body).toBe("body-image");
  });
});
