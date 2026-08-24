import { describe, expect, it } from "vitest";
import { AnimationGenerationGuard } from "../../src/rigging/ai/animationGenerationGuard";
import { buildAnimationGenerationContext, type AnimationGenerationContext, type LocomotionArchetype } from "../../src/rigging/ai/animationContextBuilder";
import { diagnoseNormalizedFootSliding } from "../../src/rigging/ai/footSlideDiagnostic";
import { buildLocomotionAnimation, type GaitKind } from "../../src/rigging/ai/locomotionEngine";
import { MockAnimationGenerationProvider } from "../../src/rigging/ai/mockAnimationGenerationProvider";
import { validateAnimationProposal } from "../../src/rigging/ai/animationProposalValidator";
import type { AnimationDefinition, BoneDefinition, RigDefinition } from "../../src/rigging/schema/types";

const b = (id: string, parentId: string | null, x: number, y: number, length = 20): BoneDefinition => ({ id, parentId, x, y, rotation: 0, scaleX: 1, scaleY: 1, length, inheritRotation: true, inheritScale: true });
const humanoidRig = (name = "Standard Test"): RigDefinition => ({
  schemaVersion: 1, id: `rig-${name.toLowerCase().replace(/\W+/g, "-")}`, canvas: { width: 240, height: 260 }, rootBoneId: "root",
  bones: [
    b("root", null, 120, 105), b("pelvis", "root", 0, 0), b("torso", "pelvis", 0, -34, 42), b("neck", "torso", 0, -38), b("head", "neck", 0, -16),
    b("left-upper-arm", "torso", -22, -30), b("left-lower-arm", "left-upper-arm", -17, 25), b("left-hand", "left-lower-arm", -13, 22),
    b("right-upper-arm", "torso", 22, -30), b("right-lower-arm", "right-upper-arm", 17, 25), b("right-hand", "right-lower-arm", 13, 22),
    b("left-upper-leg", "pelvis", -11, 3), b("left-lower-leg", "left-upper-leg", -6, 43), b("left-foot", "left-lower-leg", 7, 38),
    b("right-upper-leg", "pelvis", 11, 3), b("right-lower-leg", "right-upper-leg", 6, 43), b("right-foot", "right-lower-leg", -7, 38),
  ],
  slots: [], attachments: [], skins: [{ id: "base", name: "Base", slotAttachments: {} }], defaultSkinId: "base", metadata: { name, anatomyProfile: "humanoid" },
});

const withRightHandEquipment = (rig: RigDefinition): RigDefinition => ({
  ...rig,
  slots: [{ id: "weapon-slot", boneId: "right-hand", attachmentId: "weapon", zIndex: 1, visible: true, blendMode: "normal", tint: 0xffffff, pivotX: 0, pivotY: 0 }],
  attachments: [{ id: "weapon", imagePath: "parts/weapon.png", width: 8, height: 20, offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1, category: "equipment", tags: ["mainHandEquipment", "weapon"] }],
  skins: [{ id: "base", name: "Base", slotAttachments: { "weapon-slot": "weapon" } }],
});

const digitigradeRig = (): RigDefinition => {
  const rig = humanoidRig("Digitigrade Beastman");
  const bones = rig.bones.flatMap((bone) => {
    if (bone.id === "left-foot") return [b("left-hock", "left-lower-leg", 5, 24), { ...bone, parentId: "left-hock", x: 5, y: 18 }];
    if (bone.id === "right-foot") return [b("right-hock", "right-lower-leg", -5, 24), { ...bone, parentId: "right-hock", x: -5, y: 18 }];
    return [bone];
  });
  return { ...rig, bones, metadata: { ...rig.metadata, anatomyProfile: "digitigrade" } };
};

const context = (rig: RigDefinition, gait: GaitKind, archetype?: LocomotionArchetype): AnimationGenerationContext => {
  const built = buildAnimationGenerationContext(rig, {
    request: `Create a ${gait}`, mode: "create", selectedBoneIds: [], leftRightMappings: [], groundPlaneY: 190,
    leftFootBoneId: "left-foot", rightFootBoneId: "right-foot", contactIntervals: [],
    constraints: { duration: gait === "walk" ? .96 : .64, loop: true, intensity: .65, weight: .6, exaggeration: .45, rootMovementAllowance: 40, preserveTiming: false, preserveContactFrames: true, styleNotes: "unit" },
  });
  return archetype ? { ...built, locomotionProfile: { ...built.locomotionProfile, archetype } } : built;
};

const valueRange = (animation: AnimationDefinition, id: string): number => {
  const values = animation.tracks.find((track) => track.boneId === id && track.property === "rotation")?.keyframes.map((key) => key.value) ?? [];
  return Math.max(...values) - Math.min(...values);
};

describe("deterministic topology-aware locomotion", () => {
  it("coordinates contralateral arm opposition with the contact foot", () => {
    const result = buildLocomotionAnimation(context(humanoidRig(), "walk"), "walk")!;
    const left = result.animation.tracks.find((track) => track.boneId === "left-upper-arm")!;
    const right = result.animation.tracks.find((track) => track.boneId === "right-upper-arm")!;
    expect(left.keyframes[0].value).toBeLessThan(0); expect(right.keyframes[0].value).toBeGreaterThan(0);
    expect(result.plan.phases[0]).toMatchObject({ left: "contact", right: "up" });
  });

  it("makes Run materially distinct from Walk in cadence, flight, stride, lift, and pose values", () => {
    const rig = humanoidRig(); const walk = buildLocomotionAnimation(context(rig, "walk"), "walk")!; const run = buildLocomotionAnimation(context(rig, "run"), "run")!;
    expect(run.animation.duration).toBeLessThan(walk.animation.duration); expect(run.plan.stride).toBeGreaterThan(walk.plan.stride);
    expect(run.plan.pelvisBob).toBeGreaterThan(walk.plan.pelvisBob); expect(run.plan.phases.some((phase) => phase.left === "flight" || phase.right === "flight")).toBe(true);
    expect(JSON.stringify(run.animation.tracks)).not.toBe(JSON.stringify(walk.animation.tracks));
  });

  it("keeps stance-foot drift within normalized height and leg-length thresholds", () => {
    const rig = humanoidRig(); const result = buildLocomotionAnimation(context(rig, "walk"), "walk")!;
    const diagnostics = diagnoseNormalizedFootSliding(rig, result.animation, { leftFootBoneId: "left-foot", rightFootBoneId: "right-foot" }, result.plan.contacts);
    expect(diagnostics).toHaveLength(2); expect(diagnostics.every((item) => !item.likelySliding)).toBe(true);
    expect(Math.max(...diagnostics.map((item) => item.normalizedToHeight!))).toBeLessThan(.02);
  });

  it("clamps unreachable foot targets deterministically without non-finite keys", () => {
    const rig = humanoidRig(); const built = context(rig, "run");
    const extreme = { ...built, bones: built.bones.map((bone) => bone.id === "pelvis" ? { ...bone, setup: { ...bone.setup, y: bone.setup.y - 70 } } : bone) };
    const result = buildLocomotionAnimation(extreme, "run")!;
    expect(result.plan.targetClampCount).toBeGreaterThan(0);
    expect(result.animation.tracks.every((track) => track.keyframes.every((key) => Number.isFinite(key.value)))).toBe(true);
  });

  it("copies every first key to the loop endpoint exactly", () => {
    for (const gait of ["walk", "run"] as const) {
      const animation = buildLocomotionAnimation(context(humanoidRig(), gait), gait)!.animation;
      expect(animation.tracks.every((track) => track.keyframes[0].value === track.keyframes.at(-1)!.value && track.keyframes.at(-1)!.time === animation.duration)).toBe(true);
    }
  });

  it("adapts stride for chibi and broad/dwarf proportions", () => {
    const standard = buildLocomotionAnimation(context(humanoidRig(), "walk", "standard"), "walk")!.plan;
    const chibi = buildLocomotionAnimation(context(humanoidRig("Extreme Chibi"), "walk", "chibi"), "walk")!.plan;
    const broad = buildLocomotionAnimation(context(humanoidRig("Broad Dwarf"), "walk", "broad"), "walk")!.plan;
    expect(chibi.stride).toBeLessThan(broad.stride); expect(broad.stride).toBeLessThan(standard.stride);
  });

  it("adapts cadence so heavy rigs are slower and agile rigs are faster", () => {
    const heavy = buildLocomotionAnimation(context(humanoidRig("Bulky Marine"), "walk", "heavy"), "walk")!;
    const standard = buildLocomotionAnimation(context(humanoidRig(), "walk", "standard"), "walk")!;
    const agile = buildLocomotionAnimation(context(humanoidRig("Thin Rogue"), "walk", "agile"), "walk")!;
    expect(heavy.animation.duration).toBeGreaterThan(standard.animation.duration); expect(agile.animation.duration).toBeLessThan(standard.animation.duration);
    expect(heavy.plan.cadenceHz).toBeLessThan(agile.plan.cadenceHz);
  });

  it("restrains a weapon hand while preserving the free-arm swing", () => {
    const free = buildLocomotionAnimation(context(humanoidRig(), "walk"), "walk")!;
    const equipped = buildLocomotionAnimation(context(withRightHandEquipment(humanoidRig()), "walk"), "walk")!;
    expect(valueRange(equipped.animation, "right-upper-arm")).toBeLessThan(valueRange(free.animation, "right-upper-arm") * .5);
    expect(valueRange(equipped.animation, "left-upper-arm")).toBeCloseTo(valueRange(free.animation, "left-upper-arm"), 5);
    expect(equipped.plan.equipmentConstraints).toContain("right-upper-arm: hand equipment swing restrained to 38%");
  });

  it("treats digitigrade hocks as first-class animated targets", () => {
    const result = buildLocomotionAnimation(context(digitigradeRig(), "run"), "run")!;
    expect(result.plan.topology).toBe("digitigrade"); expect(result.plan.hockTracks).toEqual(["left-hock:rotation", "right-hock:rotation"]);
    expect(valueRange(result.animation, "left-hock")).toBeGreaterThan(20);
  });

  it("returns the exact same animation digest inputs for the same request", async () => {
    const input = context(humanoidRig(), "walk"); const provider = new MockAnimationGenerationProvider();
    const first = await provider.generateAnimationProposal({ prompt: "walk", context: input }); const second = await provider.generateAnimationProposal({ prompt: "walk", context: input });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first)); expect(validateAnimationProposal(first, humanoidRig()).success).toBe(true);
  });

  it("rejects stale generation tokens after a newer request or source switch", () => {
    const guard = new AnimationGenerationGuard(); const first = guard.begin("project-a:walk"); const second = guard.begin("project-a:walk");
    expect(guard.isCurrent(first, "project-a:walk")).toBe(false); expect(guard.isCurrent(second, "project-a:walk")).toBe(true);
    guard.setSource("project-b:walk"); expect(guard.isCurrent(second, "project-b:walk")).toBe(false);
  });
});
