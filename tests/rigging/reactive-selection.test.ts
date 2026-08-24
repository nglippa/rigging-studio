import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { semanticBodyPath } from "../../app/rig-editor/semanticBody";
import { selectionChainForBone } from "../../app/rig-editor/viewportSelection";
import type { RigDefinition } from "../../src/rigging/schema/types";

const rig = JSON.parse(readFileSync(new URL("../../public/rig-test/minimal-rig.json", import.meta.url), "utf8")) as RigDefinition;

describe("reactive semantic selection", () => {
  it("maps limb parts into compressed major and side groups", () => {
    expect(semanticBodyPath("left-lower-arm")).toEqual({ major: "arms", side: "left" });
    expect(semanticBodyPath("right-foot")).toEqual({ major: "legs", side: "right" });
    expect(semanticBodyPath("torso")).toEqual({ major: "torso" });
  });

  it("returns the direct parent and child context for a selected joint", () => {
    const chain = selectionChainForBone(rig, "left-lower-arm");
    expect(chain.parentId).toBe("left-upper-arm");
    expect(chain.childIds).toEqual(["left-hand"]);
    expect([...chain.relatedIds]).toEqual(["left-lower-arm", "left-upper-arm", "left-hand"]);
  });
});
