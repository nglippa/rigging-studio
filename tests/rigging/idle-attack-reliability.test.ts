import { describe, expect, it } from "vitest";
import { AnimationGenerationGuard } from "../../src/rigging/ai/animationGenerationGuard";
import { buildAnimationGenerationContext, type AnimationGenerationContext } from "../../src/rigging/ai/animationContextBuilder";
import { diagnoseNormalizedFootSliding } from "../../src/rigging/ai/footSlideDiagnostic";
import { buildAttackAnimation, buildIdleAnimation } from "../../src/rigging/ai/idleAttackEngine";
import { MockAnimationGenerationProvider } from "../../src/rigging/ai/mockAnimationGenerationProvider";
import { validateAnimationProposal } from "../../src/rigging/ai/animationProposalValidator";
import type { AnimationDefinition, BoneDefinition, RigDefinition } from "../../src/rigging/schema/types";

const b = (id: string, parentId: string | null, x: number, y: number, length = 20): BoneDefinition => ({ id, parentId, x, y, rotation: 0, scaleX: 1, scaleY: 1, length, inheritRotation: true, inheritScale: true });
const humanoidRig = (name = "Standard Fighter"): RigDefinition => ({
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

const withEquipment = (rig: RigDefinition, id: string, hand: "left" | "right" = "right"): RigDefinition => ({
  ...rig,
  slots: [{ id: `${id}-slot`, boneId: `${hand}-hand`, attachmentId: id, zIndex: 1, visible: true, blendMode: "normal", tint: 0xffffff, pivotX: 0, pivotY: 0 }],
  attachments: [{ id, imagePath: `parts/${id}.png`, width: 12, height: 30, offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1, category: "equipment", tags: ["mainHandEquipment", "equipment", id] }],
  skins: [{ id: "base", name: "Base", slotAttachments: { [`${id}-slot`]: id } }],
});

const digitigradeRig = (): RigDefinition => {
  const rig = humanoidRig("Digitigrade Beastman");
  return { ...rig, bones: rig.bones.flatMap((bone) => {
    if (bone.id === "left-foot") return [b("left-hock", "left-lower-leg", 5, 24), { ...bone, parentId: "left-hock", x: 5, y: 18 }];
    if (bone.id === "right-foot") return [b("right-hock", "right-lower-leg", -5, 24), { ...bone, parentId: "right-hock", x: -5, y: 18 }];
    return [bone];
  }), metadata: { ...rig.metadata, anatomyProfile: "digitigrade" } };
};

const context = (rig: RigDefinition, kind: "idle" | "attack"): AnimationGenerationContext => buildAnimationGenerationContext(rig, {
  request: kind === "idle" ? "Create a subtle breathing idle" : "Create an equipment-aware attack",
  mode: "create", selectedBoneIds: [], leftRightMappings: [], groundPlaneY: 190, leftFootBoneId: "left-foot", rightFootBoneId: "right-foot", contactIntervals: [],
  constraints: { duration: kind === "idle" ? 2 : .85, loop: kind === "idle", intensity: .65, weight: .6, exaggeration: .45, rootMovementAllowance: 40, preserveTiming: false, preserveContactFrames: true, styleNotes: "unit" },
});

const range = (animation: AnimationDefinition, id: string, property = "rotation"): number => {
  const values = animation.tracks.find((track) => track.boneId === id && track.property === property)?.keyframes.map((key) => key.value) ?? [];
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
};

describe("deterministic Idle and Attack reliability", () => {
  it("builds a coordinated, minimal, exact-loop Idle with negligible foot drift", () => {
    const rig = humanoidRig(); const result = buildIdleAnimation(context(rig, "idle"))!;
    expect(result.animation.loop).toBe(true); expect(result.animation.tracks.length).toBeGreaterThanOrEqual(6); expect(result.animation.tracks.length).toBeLessThanOrEqual(10);
    expect(result.animation.tracks.every((track) => track.keyframes[0].value === track.keyframes.at(-1)!.value && track.keyframes.at(-1)!.time === result.animation.duration)).toBe(true);
    const drift = diagnoseNormalizedFootSliding(rig, result.animation, { leftFootBoneId: "left-foot", rightFootBoneId: "right-foot" }, [{ foot: "leftFoot", start: 0, end: result.animation.duration }, { foot: "rightFoot", start: 0, end: result.animation.duration }]);
    expect(Math.max(...drift.map((item) => item.normalizedToHeight!))).toBeLessThan(.015);
  });

  it("uses slower heavy Idles and quicker rogue Idles", () => {
    const heavy = buildIdleAnimation(context(humanoidRig("Bulky Marine"), "idle"))!; const agile = buildIdleAnimation(context(humanoidRig("Thin Rogue"), "idle"))!;
    expect(heavy.animation.duration).toBeGreaterThan(agile.animation.duration); expect(heavy.plan.archetype).toBe("heavy"); expect(agile.plan.archetype).toBe("agile");
  });

  it("suppresses occupied-hand Idle motion while preserving free-arm life", () => {
    const free = buildIdleAnimation(context(humanoidRig(), "idle"))!; const equipped = buildIdleAnimation(context(withEquipment(humanoidRig(), "training-sword"), "idle"))!;
    expect(range(equipped.animation, "right-upper-arm")).toBeLessThan(range(free.animation, "right-upper-arm") * .4);
    expect(range(equipped.animation, "left-upper-arm")).toBeCloseTo(range(free.animation, "left-upper-arm"), 5);
  });

  it("uses topology-safe hock compression and paw counter-rotation for digitigrade Idle", () => {
    const result = buildIdleAnimation(context(digitigradeRig(), "idle"))!;
    expect(result.plan.hockTracks).toEqual(["left-hock:rotation", "right-hock:rotation"]); expect(range(result.animation, "left-hock")).toBeGreaterThan(1);
    expect(range(result.animation, "left-foot")).toBeCloseTo(range(result.animation, "left-hock"), 5);
  });

  it("orders anticipation, action, follow-through, and recovery and does not loop", () => {
    const result = buildAttackAnimation(context(withEquipment(humanoidRig(), "steel-sword"), "attack"))!;
    expect(result.plan.phases.map((phase) => phase.name)).toEqual(["neutral", "anticipation", "action", "follow-through", "recovery"]);
    expect(result.plan.phases.map((phase) => phase.phase)).toEqual([...result.plan.phases.map((phase) => phase.phase)].sort((left, right) => left - right));
    expect(result.animation.loop).toBe(false); expect(result.animation.tracks.every((track) => track.keyframes.at(-1)!.value === track.keyframes[0].value)).toBe(true);
  });

  it("derives sword, staff, firearm, dagger, heavy, and unarmed profiles from semantics", () => {
    const cases = [["steel-sword", "slash"], ["oak-staff", "staff-sweep"], ["pulse-rifle", "firearm-recoil"], ["left-dagger", "dagger-strike"], ["war-hammer", "heavy-swing"]] as const;
    for (const [id, expected] of cases) expect(buildAttackAnimation(context(withEquipment(humanoidRig(), id), "attack"))!.plan.type).toBe(expected);
    expect(buildAttackAnimation(context(humanoidRig(), "attack"))!.plan.type).toBe("unarmed-strike");
  });

  it("keeps two-handed firearm support coordinated and shield support restrained", () => {
    const firearm = buildAttackAnimation(context(withEquipment(humanoidRig("Bulky Marine"), "pulse-rifle"), "attack"))!;
    expect(firearm.plan.supportArmMode).toBe("two-handed-lock"); expect(range(firearm.animation, "left-upper-arm")).toBe(0); expect(range(firearm.animation, "left-hand")).toBeGreaterThan(0);
    const sword = withEquipment(humanoidRig(), "steel-sword"); const shield = withEquipment(sword, "round-shield", "left");
    const guarded = buildAttackAnimation(context({ ...shield, slots: [...sword.slots, ...shield.slots], attachments: [...sword.attachments, ...shield.attachments] }, "attack"))!;
    expect(guarded.plan.supportArmMode).toBe("shield-stable"); expect(range(guarded.animation, "left-upper-arm")).toBeLessThan(range(guarded.animation, "right-upper-arm") * .15);
  });

  it("makes the dwarf heavy swing materially slower and broader than the rogue dagger", () => {
    const dwarf = buildAttackAnimation(context(withEquipment(humanoidRig("Broad Dwarf"), "war-hammer"), "attack"))!;
    const rogue = buildAttackAnimation(context(withEquipment(humanoidRig("Thin Rogue"), "steel-dagger"), "attack"))!;
    expect(dwarf.animation.duration).toBeGreaterThan(rogue.animation.duration * 1.8); expect(dwarf.plan.leadArmAmplitude).toBeGreaterThan(rogue.plan.leadArmAmplitude);
    expect(dwarf.plan.torsoTurn).toBeGreaterThan(rogue.plan.torsoTurn);
  });

  it("scales a chibi heavy attack below the normal-limb arc", () => {
    const normal = buildAttackAnimation(context(withEquipment(humanoidRig(), "wooden-club"), "attack"))!;
    const chibi = buildAttackAnimation(context(withEquipment(humanoidRig("Extreme Chibi Fighter"), "wooden-club"), "attack"))!;
    expect(chibi.plan.leadArmAmplitude).toBeLessThan(normal.plan.leadArmAmplitude * .75); expect(chibi.animation.duration).toBeLessThan(normal.animation.duration);
  });

  it("keeps digitigrade support feet coherent during body contribution", () => {
    const rig = digitigradeRig(); const result = buildAttackAnimation(context(rig, "attack"))!;
    const drift = diagnoseNormalizedFootSliding(rig, result.animation, { leftFootBoneId: "left-foot", rightFootBoneId: "right-foot" }, [{ foot: "leftFoot", start: 0, end: result.animation.duration }, { foot: "rightFoot", start: 0, end: result.animation.duration }]);
    expect(result.plan.topology).toBe("digitigrade"); expect(Math.min(...drift.map((item) => item.normalizedToHeight!))).toBeLessThan(.025);
  });

  it("passes schema, finite-value, unique-channel, and recovery validation", async () => {
    const rig = withEquipment(humanoidRig(), "steel-sword"); const provider = new MockAnimationGenerationProvider(); const input = context(rig, "attack");
    const proposal = await provider.generateAnimationProposal({ prompt: input.motionDescription, context: input });
    expect(validateAnimationProposal(proposal, rig).success).toBe(true);
    expect(new Set(proposal.animation.tracks.map((track) => `${track.boneId}:${track.property}`)).size).toBe(proposal.animation.tracks.length);
    expect(proposal.animation.tracks.every((track) => track.keyframes.every((key) => Number.isFinite(key.time) && Number.isFinite(key.value)))).toBe(true);
  });

  it("is byte-deterministic for identical Idle and Attack requests", async () => {
    const provider = new MockAnimationGenerationProvider();
    for (const kind of ["idle", "attack"] as const) { const input = context(withEquipment(humanoidRig(), "steel-sword"), kind); const first = await provider.generateAnimationProposal({ prompt: kind, context: input }); const second = await provider.generateAnimationProposal({ prompt: kind, context: input }); expect(JSON.stringify(second)).toBe(JSON.stringify(first)); }
  });

  it("rejects delayed Idle and Attack after a project/session/revision switch", () => {
    const guard = new AnimationGenerationGuard();
    for (const kind of ["idle", "attack"] as const) { const delayed = guard.begin(`project-a:session-1:revision-4:${kind}`); guard.setSource(`project-b:session-2:revision-1:${kind}`); expect(guard.isCurrent(delayed, `project-b:session-2:revision-1:${kind}`)).toBe(false); }
  });

  it("does not change deterministic Walk/Run proposals while generating Idle and Attack", async () => {
    const rig = withEquipment(humanoidRig(), "steel-sword"); const provider = new MockAnimationGenerationProvider();
    const gaitContext = (gait: "walk" | "run") => ({ ...context(rig, "idle"), motionDescription: gait, requestedDuration: gait === "walk" ? .96 : .64 });
    for (const gait of ["walk", "run"] as const) { const before = await provider.generateAnimationProposal({ prompt: gait, context: gaitContext(gait) }); await provider.generateAnimationProposal({ prompt: "idle", context: context(rig, "idle") }); await provider.generateAnimationProposal({ prompt: "attack", context: context(rig, "attack") }); const after = await provider.generateAnimationProposal({ prompt: gait, context: gaitContext(gait) }); expect(after.animation).toEqual(before.animation); }
  });
});
