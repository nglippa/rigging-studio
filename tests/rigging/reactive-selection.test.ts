import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chainForBone } from "../../src/tools/rig-editor/rigReview";
import { selectionChainForBone } from "../../app/rig-editor/viewportSelection";
import type { RigDefinition } from "../../src/rigging/schema/types";

const rig = JSON.parse(readFileSync(new URL("../../public/rig-test/minimal-rig.json", import.meta.url), "utf8")) as RigDefinition;

describe("reactive semantic selection", () => {
  it("maps limb bones onto the chains Rig review walks", () => {
    expect(chainForBone("left-lower-arm")).toBe("left-arm");
    expect(chainForBone("right-foot")).toBe("right-leg");
    expect(chainForBone("torso")).toBe("torso");
  });

  it("returns the direct parent and child context for a selected joint", () => {
    const chain = selectionChainForBone(rig, "left-lower-arm");
    expect(chain.parentId).toBe("left-upper-arm");
    expect(chain.childIds).toEqual(["left-hand"]);
    expect([...chain.relatedIds]).toEqual(["left-lower-arm", "left-upper-arm", "left-hand"]);
  });
});
