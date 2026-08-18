import { describe, expect, it } from "vitest";
import { safeParseAnimationDefinition, safeParseRigDefinition } from "../../src/rigging/schema/parsing";
import { validAnimation, validRig } from "./fixtures";
import { validateRigDefinition } from "../../src/rigging/validation/rig";

const issueCodes = (input: unknown): string[] => {
  const result = safeParseRigDefinition(input);
  return result.success ? [] : result.issues.map((issue) => issue.code);
};

describe("semantic rig validation", () => {
  it("rejects duplicate bone IDs", () => {
    const rig = validRig();
    expect(issueCodes({ ...rig, bones: [...rig.bones, { ...rig.bones[1] }] })).toContain("duplicate_bone_id");
  });

  it("rejects missing parents and multiple roots", () => {
    const rig = validRig();
    expect(issueCodes({ ...rig, bones: [rig.bones[0], { ...rig.bones[1], parentId: "missing" }] })).toContain("missing_parent");
    expect(issueCodes({ ...rig, bones: rig.bones.map((bone) => ({ ...bone, parentId: null })) })).toContain("invalid_root_count");
  });

  it("rejects cycles with a readable cycle path", () => {
    const rig = validRig();
    const result = safeParseRigDefinition({ ...rig, bones: [
      { ...rig.bones[0], parentId: "child" }, { ...rig.bones[1], parentId: "root" },
    ] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.message).toContain("root -> child -> root");
  });

  it("reports zero-length articulated bones and invalid slot targets with actionable context", () => {
    const rig = validRig();
    const issues = validateRigDefinition({
      ...rig,
      metadata: { ...rig.metadata, anatomyProfile: "humanoid" },
      bones: rig.bones.map((bone) => bone.id === "child" ? { ...bone, id: "head", length: 0 } : bone),
      slots: rig.slots.map((slot) => ({ ...slot, boneId: "missing-bone" })),
    });
    const length = issues.find((issue) => issue.code === "zero_length_articulated_bone");
    expect(length).toMatchObject({ severity: "error", objectId: "head", mode: "setup" }); expect(length?.suggestedAction).toMatch(/positive length/i);
    const slot = issues.find((issue) => issue.code === "missing_slot_bone"); expect(slot).toMatchObject({ objectId: rig.slots[0].id, mode: "setup" });
    expect(issues.some((issue) => issue.code === "missing_required_semantic_slot" && issue.mode === "prepare")).toBe(true);
  });

  it("rejects missing animation bones, out-of-range times, and unsorted frames", () => {
    const animation = validAnimation();
    const result = safeParseAnimationDefinition({ ...animation, tracks: [{
      boneId: "ghost", property: "x", keyframes: [
        { time: 0.75, value: 1, easing: "linear" }, { time: 0.5, value: 2, easing: "linear" }, { time: 2, value: 3, easing: "linear" },
      ],
    }] }, validRig());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "missing_animation_bone", "unsorted_keyframes", "keyframe_after_duration",
    ]));
  });
});
