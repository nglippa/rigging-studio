import { describe, expect, it } from "vitest";
import { updateBone } from "../../src/tools/rig-editor/document";
import { RigCommandHistory } from "../../src/tools/rig-editor/history";
import { validRig } from "./fixtures";

describe("rig editor command history", () => {
  it("undoes and redoes immutable authoring commands", () => {
    const source = validRig();
    const history = new RigCommandHistory(source);
    history.execute("Move child", (rig) => updateBone(rig, "child", { x: 24 }));
    expect(history.present.bones.find((bone) => bone.id === "child")?.x).toBe(24);
    expect(Object.isFrozen(history.present)).toBe(true);
    expect(source.bones.find((bone) => bone.id === "child")?.x).toBe(10);
    history.undo();
    expect(history.present.bones.find((bone) => bone.id === "child")?.x).toBe(10);
    history.redo();
    expect(history.present.bones.find((bone) => bone.id === "child")?.x).toBe(24);
  });

  it("records an entire drag transaction as one undo entry", () => {
    const history = new RigCommandHistory(validRig());
    history.beginTransaction("Drag child");
    history.updateTransaction(updateBone(history.present, "child", { x: 14 }));
    history.updateTransaction(updateBone(history.present, "child", { x: 21 }));
    history.updateTransaction(updateBone(history.present, "child", { x: 32 }));
    history.commitTransaction();
    expect(history.undoCount).toBe(1);
    history.undo();
    expect(history.present.bones.find((bone) => bone.id === "child")?.x).toBe(10);
  });
});
