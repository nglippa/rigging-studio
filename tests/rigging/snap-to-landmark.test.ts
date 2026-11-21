import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { landmarkFor, snapPivotToLandmark } from "../../src/rigging/editing/snapToLandmark";
import { createRestPose } from "../../src/rigging/runtime/pose";
import { computeWorldTransforms } from "../../src/rigging/runtime/worldTransforms";
import { safeParseRigJson } from "../../src/rigging/schema/parsing";
import type { RigDefinition } from "../../src/rigging/schema/types";

const goblin = ((): RigDefinition => {
  const parsed = safeParseRigJson(readFileSync("tests/fixtures/bench-rigs/goblin-warrior-pixel.rig.json", "utf8"));
  if (!parsed.success) throw new Error("goblin rig did not parse");
  return parsed.data;
})();
const world = (rig: RigDefinition) => computeWorldTransforms(rig, createRestPose(rig));
const descendants = (rig: RigDefinition, id: string): string[] => rig.bones.filter((bone) => bone.parentId === id).flatMap((bone) => [bone.id, ...descendants(rig, bone.id)]);

describe("snap a joint to its landmark", () => {
  const moved: RigDefinition = { ...goblin, bones: goblin.bones.map((bone) => bone.id === "left-upper-arm" ? { ...bone, x: bone.x + 40 } : bone) };

  it("names the joint the landmark stands for", () => {
    expect(landmarkFor(goblin, "left-upper-arm")?.label).toBe("shoulder");
    expect(landmarkFor(goblin, "left-lower-arm")?.label).toBe("elbow");
    expect(landmarkFor(goblin, "right-upper-leg")?.label).toBe("hip");
    expect(landmarkFor(goblin, "right-lower-leg")?.label).toBe("knee");
    expect(landmarkFor(goblin, "head")?.label).toBe("neck");
    expect(landmarkFor(goblin, "torso")?.label).toBe("landmark");
  });

  it("has no landmark for a bone without a pivot source", () => {
    const sources = { ...(goblin.metadata.pivotSources as Record<string, unknown>) }; delete sources["left-upper-arm"];
    expect(landmarkFor({ ...goblin, metadata: { ...goblin.metadata, pivotSources: sources } } as RigDefinition, "left-upper-arm")).toBeNull();
    expect(landmarkFor(goblin, "no-such-bone")).toBeNull();
  });

  it("moves the joint back onto the landmark", () => {
    const landmark = landmarkFor(goblin, "left-upper-arm")!;
    expect(Math.hypot(world(moved)["left-upper-arm"].x - landmark.x, world(moved)["left-upper-arm"].y - landmark.y)).toBeGreaterThan(30);
    const snapped = world(snapPivotToLandmark(moved, "left-upper-arm"))["left-upper-arm"];
    expect(snapped.x).toBeCloseTo(landmark.x, 0); expect(Math.abs(snapped.x - landmark.x)).toBeLessThan(.5);
    expect(Math.abs(snapped.y - landmark.y)).toBeLessThan(.5);
  });

  it("keeps the bones below it and its art where they were", () => {
    const before = world(moved); const after = world(snapPivotToLandmark(moved, "left-upper-arm"));
    const children = descendants(moved, "left-upper-arm"); expect(children.length).toBeGreaterThan(0);
    for (const id of children) { expect(Math.abs(after[id].x - before[id].x), id).toBeLessThan(.5); expect(Math.abs(after[id].y - before[id].y), id).toBeLessThan(.5); }
    // Art drawn on the arm stays put on screen: its offset moves opposite to the joint.
    const snapped = snapPivotToLandmark(moved, "left-upper-arm");
    const slot = moved.slots.find((candidate) => candidate.boneId === "left-upper-arm" && candidate.attachmentId);
    if (slot) {
      const art = (rig: RigDefinition) => { const attachment = rig.attachments.find((candidate) => candidate.id === slot.attachmentId)!; const bone = world(rig)["left-upper-arm"].matrix; return { x: bone.a * attachment.offsetX + bone.c * attachment.offsetY + bone.tx, y: bone.b * attachment.offsetX + bone.d * attachment.offsetY + bone.ty }; };
      expect(Math.abs(art(snapped).x - art(moved).x)).toBeLessThan(.5); expect(Math.abs(art(snapped).y - art(moved).y)).toBeLessThan(.5);
    }
  });

  it("leaves a bone without a landmark unchanged", () => {
    expect(snapPivotToLandmark(moved, "no-such-bone")).toBe(moved);
  });
});
