import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { safeParseAnimationDefinition, safeParseRigJson } from "../../src/rigging/schema/parsing";
import { createRestPose } from "../../src/rigging/runtime/pose";
import { computeWorldTransforms } from "../../src/rigging/runtime/worldTransforms";
import { transformPoint } from "../../src/rigging/math/matrix";
import type { RigDefinition } from "../../src/rigging/schema/types";
import { validateRigDefinition } from "../../src/rigging/validation/rig";
import { moveBonePivot } from "../../src/tools/rig-editor/document";
import { buildPoseTest, buildRotationSweep, poseTestBoneIds } from "../../src/tools/rig-editor/poseTests";
import { boneDisplayEnd, chainForBone, jointName, partsForBone, primaryChildId, reviewRig, skeletonRows } from "../../src/tools/rig-editor/rigReview";
import { commitGuidedSelection, createPartCutterState, initializeGuidedManual, partCutToSegmentation, skipGuidedSemantic } from "../../src/part-cutter";
import { resolvePartPivot } from "../../src/character-generation/rigging/pivotResolver";
import { buildRigProposal, needsArtRebuild } from "../../src/character-generation/rigging/rigProposalBuilder";
import { artlessLimbBones } from "../../src/rigging/motion/rigMotion";

const load = (path: string): RigDefinition => {
  const parsed = safeParseRigJson(readFileSync(new URL(path, import.meta.url), "utf8"));
  if (!parsed.success) throw new Error(parsed.message);
  return parsed.data;
};
const knight = load("../../public/rig-test/minimal-rig.json");
const voidRanger = load("../fixtures/golden/void-ranger/rig.json");

const worldAnchors = (rig: RigDefinition): Record<string, { x: number; y: number }> => {
  const world = computeWorldTransforms(rig, createRestPose(rig));
  return Object.fromEntries([
    ...rig.bones.map((bone) => [`bone:${bone.id}`, { x: world[bone.id].x, y: world[bone.id].y }] as const),
    ...rig.slots.flatMap((slot) => {
      const attachment = rig.attachments.find((candidate) => candidate.id === slot.attachmentId);
      return attachment ? [[`art:${slot.id}`, transformPoint(world[slot.boneId].matrix, { x: attachment.offsetX, y: attachment.offsetY })] as const] : [];
    }),
  ]);
};

describe("rig review", () => {
  it("sorts bones into the chains a person would name", () => {
    expect(chainForBone("left-lower-arm")).toBe("left-arm");
    expect(chainForBone("right-hand")).toBe("right-arm");
    expect(chainForBone("left-foot")).toBe("left-leg");
    expect(chainForBone("pelvis")).toBe("torso");
    expect(chainForBone("cape")).toBe("equipment");
    expect(jointName("left-lower-arm")).toBe("Elbow");
    expect(jointName("right-upper-leg")).toBe("Hip");
  });

  it.each([["bundled knight", knight], ["Void Ranger golden", voidRanger]])("passes the known-good %s rig without flags", (_name, rig) => {
    const chains = reviewRig(rig);
    expect(chains.length).toBeGreaterThanOrEqual(3);
    expect(chains.flatMap((chain) => chain.joints).filter((joint) => joint.problem)).toEqual([]);
    expect(chains.flatMap((chain) => chain.joints).map((joint) => joint.boneId).sort()).toEqual(rig.bones.map((bone) => bone.id).sort());
  });

  it("flags a pivot dragged off its art but not a bone that simply carries no art", () => {
    const arm = voidRanger.bones.find((bone) => chainForBone(bone.id) === "left-arm" && partsForBone(voidRanger, bone.id).length > 0)!;
    const displaced = { ...voidRanger, attachments: voidRanger.attachments.map((attachment) => partsForBone(voidRanger, arm.id).some((slot) => slot.attachmentId === attachment.id) ? { ...attachment, offsetX: attachment.offsetX + 900 } : attachment) };
    expect(reviewRig(displaced).flatMap((chain) => chain.joints).find((joint) => joint.boneId === arm.id)?.problem).toBe("pivot-off-art");
    const orphaned = { ...voidRanger, bones: [...voidRanger.bones, { ...arm, id: "left-arm-spare", parentId: arm.id }] };
    expect(reviewRig(orphaned).flatMap((chain) => chain.joints).find((joint) => joint.boneId === "left-arm-spare")?.problem).toBeNull();
  });

  it("surfaces validator errors on the joint they name", () => {
    const bone = voidRanger.bones[3];
    const chains = reviewRig(voidRanger, [{ code: "x", path: ["bones", 3], message: "Bone is broken" }]);
    expect(chains.flatMap((chain) => chain.joints).find((joint) => joint.boneId === bone.id)).toMatchObject({ problem: "invalid", reason: "Bone is broken" });
  });

  it("lists the skeleton parent-first with real depth", () => {
    const rows = skeletonRows(voidRanger);
    expect(rows).toHaveLength(voidRanger.bones.length);
    expect(rows[0]).toMatchObject({ depth: 0, bone: { id: voidRanger.rootBoneId } });
    const depth = new Map(rows.map((row) => [row.bone.id, row.depth]));
    rows.forEach(({ bone }) => { if (bone.parentId) expect(depth.get(bone.id)).toBe(depth.get(bone.parentId)! + 1); });
    rows.forEach(({ bone }, index) => { if (bone.parentId) expect(rows.findIndex((row) => row.bone.id === bone.parentId)).toBeLessThan(index); });
  });
});

describe("pose tests", () => {
  it.each(["arm", "leg", "full"] as const)("builds a valid %s sweep that returns to rest and never touches the rig", (test) => {
    const before = JSON.stringify(voidRanger);
    const animation = buildPoseTest(voidRanger, test)!;
    expect(animation).not.toBeNull();
    const parsed = safeParseAnimationDefinition(animation, voidRanger);
    expect(parsed.success, parsed.success ? "" : parsed.message).toBe(true);
    animation.tracks.forEach((track) => {
      const rest = voidRanger.bones.find((bone) => bone.id === track.boneId)!.rotation;
      expect(track.keyframes[0].value).toBe(rest);
      expect(track.keyframes.at(-1)!.value).toBe(rest);
      expect(track.keyframes.at(-1)!.time).toBeLessThanOrEqual(animation.duration);
      track.keyframes.forEach((frame, index) => { if (index) expect(frame.time).toBeGreaterThan(track.keyframes[index - 1].time); });
    });
    expect(JSON.stringify(voidRanger)).toBe(before);
  });

  it("keeps the root still and reports when a rig has nothing to test", () => {
    expect(poseTestBoneIds(voidRanger, "full")).not.toContain(voidRanger.rootBoneId);
    expect(poseTestBoneIds(voidRanger, "arm").every((id) => /arm|hand/.test(id))).toBe(true);
    expect(buildRotationSweep(voidRanger, [])).toBeNull();
    expect(buildRotationSweep(voidRanger, ["does-not-exist"])).toBeNull();
  });
});

describe("moveBonePivot", () => {
  it.each([["bundled knight", knight], ["Void Ranger golden", voidRanger]])("moves only the pivot on the %s rig", (_name, rig) => {
    const bone = rig.bones.find((candidate) => candidate.parentId && rig.bones.some((child) => child.parentId === candidate.id) && partsForBone(rig, candidate.id).length > 0)!;
    const before = worldAnchors(rig);
    const next = moveBonePivot(rig, bone.id, bone.x + 7, bone.y - 4);
    const after = worldAnchors(next);
    expect(next.bones.find((candidate) => candidate.id === bone.id)).toMatchObject({ x: bone.x + 7, y: bone.y - 4 });
    expect(Math.hypot(after[`bone:${bone.id}`].x - before[`bone:${bone.id}`].x, after[`bone:${bone.id}`].y - before[`bone:${bone.id}`].y)).toBeGreaterThan(1);
    Object.keys(before).filter((key) => key !== `bone:${bone.id}`).forEach((key) => {
      expect(after[key].x, key).toBeCloseTo(before[key].x, 6);
      expect(after[key].y, key).toBeCloseTo(before[key].y, 6);
    });
  });

  it("is a no-op for an unchanged position and rejects unknown bones", () => {
    const bone = voidRanger.bones[2];
    expect(moveBonePivot(voidRanger, bone.id, bone.x, bone.y)).toBe(voidRanger);
    expect(() => moveBonePivot(voidRanger, "nope", 0, 0)).toThrow(/does not exist/);
  });
});

describe("generated rigs: joints, bone drawing and honest review", () => {
  const foreground = new Array<number>(40 * 60).fill(255);
  const loop = (x: number, y: number, width: number, height: number) => ({ bounds: { x, y, width, height }, mask: { width, height, alpha: new Array<number>(width * height).fill(255) } });
  const cutHeadAndTorso = () => {
    const start = initializeGuidedManual(createPartCutterState("joint-source", 40, 60, "manual", "2026-11-16T00:00:00.000Z"), "2026-11-16T00:00:00.000Z");
    const head = commitGuidedSelection(start, loop(10, 0, 20, 20), foreground, "2026-11-16T00:00:01.000Z");
    const torso = commitGuidedSelection(head.state, loop(5, 20, 30, 30), foreground, "2026-11-16T00:00:02.000Z");
    expect(head.ok && torso.ok).toBe(true);
    return torso.state;
  };

  it("puts a hand-cut part's joint on the seam with its parent until the user moves the pivot", () => {
    const state = cutHeadAndTorso();
    const parts = partCutToSegmentation(state).parts;
    const head = parts.find((part) => part.semanticType === "head")!;
    const seam = resolvePartPivot(head, parts, state);
    expect(seam.source).toBe("boundary");
    expect(Math.abs(seam.point.y - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(seam.point.x - 20)).toBeLessThanOrEqual(1);
    // A pivot that only drifted because the outline changed (carving, joining stray artwork) is still a guess.
    const drifted = { ...state, parts: state.parts.map((part) => part.semanticType === "head" ? { ...part, pivot: { x: 14, y: 12 } } : part) };
    expect(resolvePartPivot(head, parts, drifted).source).toBe("boundary");
    const moved = { ...state, parts: state.parts.map((part) => part.semanticType === "head" ? { ...part, pivot: { x: 14, y: 12 }, pivotSetByUser: true } : part) };
    expect(resolvePartPivot(head, parts, moved)).toMatchObject({ source: "manual", point: { x: 14, y: 12 } });
  });

  it("finds a joint across a gap and through a part that was not cut", () => {
    // Head and torso drawn with four empty rows between them: the joint is the head's edge nearest the torso.
    const start = initializeGuidedManual(createPartCutterState("gap-source", 40, 60, "manual", "2026-11-16T00:00:00.000Z"), "2026-11-16T00:00:00.000Z");
    const head = commitGuidedSelection(start, loop(10, 0, 20, 16), foreground, "2026-11-16T00:00:01.000Z").state;
    const torso = commitGuidedSelection(head, loop(5, 20, 30, 30), foreground, "2026-11-16T00:00:02.000Z").state;
    const parts = partCutToSegmentation(torso).parts;
    const across = resolvePartPivot(parts.find((part) => part.semanticType === "head")!, parts, torso);
    expect(across.source).toBe("boundary"); expect(across.confidence).toBeGreaterThan(.5);
    expect(across.point.y).toBeCloseTo(15.5, 0); expect(across.point.x).toBeCloseTo(20, 0);
    // A forearm whose upper arm is hidden hangs from the torso, where the two meet.
    const body = cutHeadAndTorso();
    const skipped = skipGuidedSemantic({ ...body, guidedManual: { ...body.guidedManual!, currentSemantic: "leftUpperArm" } }, "2026-11-16T00:00:03.000Z");
    const forearm = commitGuidedSelection({ ...skipped, guidedManual: { ...skipped.guidedManual!, currentSemantic: "leftForearm", intent: "replace" } }, loop(35, 24, 5, 20), foreground, "2026-11-16T00:00:04.000Z");
    expect(forearm.ok).toBe(true);
    const armParts = partCutToSegmentation(forearm.state).parts;
    const elbow = resolvePartPivot(armParts.find((part) => part.semanticType === "leftForearm")!, armParts, forearm.state);
    expect(elbow).toMatchObject({ source: "boundary" }); expect(Math.abs(elbow.point.x - 35)).toBeLessThanOrEqual(1);
  });

  it("builds a rig whose every part, equipment included, rests exactly where it was drawn", () => {
    const body = cutHeadAndTorso();
    const withBow = commitGuidedSelection({ ...body, guidedManual: { ...body.guidedManual!, phase: "equipment", currentSemantic: "offHandEquipment", intent: "replace" } }, loop(32, 2, 6, 14), foreground, "2026-11-16T00:00:03.000Z");
    expect(withBow.ok).toBe(true);
    const parts = partCutToSegmentation(withBow.state).parts;
    const rig = buildRigProposal({ name: "Seam Test", parts, imageWidth: 40, imageHeight: 60, partCutterState: withBow.state, topology: "humanoid" }).rig;
    const world = computeWorldTransforms(rig, createRestPose(rig));
    expect(parts.some((part) => part.semanticType === "offHandEquipment")).toBe(true);
    parts.forEach((part) => {
      const slot = rig.slots.find((candidate) => candidate.attachmentId === part.id)!;
      const attachment = rig.attachments.find((candidate) => candidate.id === part.id)!;
      const anchor = transformPoint(world[slot.boneId].matrix, { x: attachment.offsetX, y: attachment.offsetY });
      expect(anchor.x - slot.pivotX).toBeCloseTo(part.bounds.x, 3);
      expect(anchor.y - slot.pivotY).toBeCloseTo(part.bounds.y, 3);
    });
    // The fixed body template knows nothing about a hand-cut character, so the neck comes from the head/torso seam.
    expect(Math.abs(world.neck.y - 20)).toBeLessThanOrEqual(1);
  });

  it("draws a zero-rotation bone toward its child joint instead of along its own axis", () => {
    const flat: RigDefinition = { ...knight, bones: knight.bones.map((bone) => ({ ...bone, rotation: 0 })) };
    const world = computeWorldTransforms(flat, createRestPose(flat));
    const upper = flat.bones.find((bone) => bone.id === "left-upper-arm")!;
    expect(primaryChildId(flat, "left-upper-arm")).toBe("left-lower-arm");
    expect(primaryChildId(flat, "torso")).toBe("head");
    const end = boneDisplayEnd(flat, world, upper);
    expect(end.x).toBeCloseTo(world["left-lower-arm"].x, 5);
    expect(end.y).toBeCloseTo(world["left-lower-arm"].y, 5);
    const hand = flat.bones.find((bone) => bone.id === "left-hand")!;
    const tip = boneDisplayEnd(flat, world, hand);
    expect(Math.hypot(tip.x - world["left-hand"].x, tip.y - world["left-hand"].y)).toBeGreaterThan(1);
  });

  it("flags a joint that is on its own art but away from the part it hangs from, and a joint that was only estimated", () => {
    expect(reviewRig(knight).every((chain) => chain.ok)).toBe(true);
    // Slide the forearm's art and pivot far from the upper arm: still on its own art, no longer at the elbow.
    const detached: RigDefinition = { ...knight, bones: knight.bones.map((bone) => bone.id === "left-lower-arm" ? { ...bone, x: bone.x + 400 } : bone) };
    const elbow = reviewRig(detached).flatMap((chain) => chain.joints).find((joint) => joint.boneId === "left-lower-arm")!;
    expect(elbow.problem).toBe("pivot-off-parent");
    const guessed: RigDefinition = { ...knight, metadata: { ...knight.metadata, pivotSources: { "left-lower-arm": { source: "fallback", confidence: .38, detail: "prior", point: { x: 0, y: 0 } } } } };
    const estimated = reviewRig(guessed).flatMap((chain) => chain.joints).find((joint) => joint.boneId === "left-lower-arm")!;
    expect(estimated.problem).toBe("guessed");
    const corrected = moveBonePivot(guessed, "left-lower-arm", guessed.bones.find((bone) => bone.id === "left-lower-arm")!.x + 1, guessed.bones.find((bone) => bone.id === "left-lower-arm")!.y);
    expect(reviewRig(corrected).flatMap((chain) => chain.joints).find((joint) => joint.boneId === "left-lower-arm")!.problem).toBeNull();
  });
});

describe("rigs built before the current art preparation", () => {
  it("are recognised so they can be offered a rebuild, and new builds are not", () => {
    const parts = [{ id: "torso", name: "torso", semanticType: "torso", confidence: 1, confidenceSource: "heuristic", bounds: { x: 10, y: 10, width: 20, height: 30 }, sourceImageRegion: { x: 10, y: 10, width: 20, height: 30 }, suggestedBoneId: "", suggestedSlotId: "", suggestedZIndex: 0, pivotHint: { x: 20, y: 25 }, warnings: [], accepted: true, provenance: "manual" }] as never;
    const old = buildRigProposal({ name: "Old", imageWidth: 40, imageHeight: 60, parts }).rig;
    const current = buildRigProposal({ name: "New", imageWidth: 40, imageHeight: 60, parts, artBounds: { torso: { x: 10, y: 10, width: 20, height: 30 } } }).rig;
    expect(needsArtRebuild(old)).toBe(true);
    expect(needsArtRebuild(current)).toBe(false);
    expect(needsArtRebuild(knight)).toBe(false);
  });
});

describe("bones for parts that were not cut", () => {
  const partAt = (id: string, semanticType: string, x: number, y: number, width: number, height: number) => ({ id, name: id, semanticType, confidence: 1, confidenceSource: "heuristic", bounds: { x, y, width, height }, sourceImageRegion: { x, y, width, height }, suggestedBoneId: "", suggestedSlotId: "", suggestedZIndex: 0, pivotHint: { x: x + width / 2, y: y + height / 2 }, warnings: [], accepted: true, provenance: "manual" }) as never;
  it("puts a hidden far leg where its visible twin is and an unseen hand at the equipment it carries, never at a template guess", () => {
    const { rig } = buildRigProposal({ name: "Profile", imageWidth: 400, imageHeight: 600, parts: [
      partAt("head", "head", 160, 40, 80, 80), partAt("torso", "torso", 150, 120, 100, 200),
      partAt("right-thigh", "rightThigh", 160, 320, 70, 110), partAt("right-lower-leg", "rightLowerLeg", 165, 430, 60, 100), partAt("right-foot", "rightFoot", 160, 530, 90, 40),
      partAt("shield", "offHandEquipment", 240, 200, 90, 120),
    ] });
    const world = worldAnchors(rig);
    for (const bone of ["upper-leg", "lower-leg", "foot"]) expect(world[`bone:left-${bone}`]).toEqual(world[`bone:right-${bone}`]);
    const hand = world["bone:left-hand"];
    expect(hand.x).toBeGreaterThanOrEqual(240); expect(hand.x).toBeLessThanOrEqual(330); expect(hand.y).toBeGreaterThanOrEqual(200); expect(hand.y).toBeLessThanOrEqual(320);
    // Every bone stays within the character's own extent.
    for (const bone of rig.bones) { const at = world[`bone:${bone.id}`]; expect(at.x).toBeGreaterThanOrEqual(150); expect(at.x).toBeLessThanOrEqual(330); }
    expect(reviewRig(rig).flatMap((chain) => chain.joints).filter((joint) => joint.problem === "pivot-off-art")).toEqual([]);
    // The hidden far leg is drawn as a darker copy of the near leg, behind everything else, and is animated like a leg.
    const far = rig.slots.filter((slot) => slot.id.endsWith("-far-slot"));
    expect(far.map((slot) => [slot.boneId, slot.attachmentId])).toEqual([["left-upper-leg", "right-thigh"], ["left-lower-leg", "right-lower-leg"], ["left-foot", "right-foot"]]);
    expect(far.every((slot) => slot.visible && slot.tint < 0xffffff)).toBe(true);
    expect(Math.max(...far.map((slot) => slot.zIndex))).toBeLessThan(Math.min(...rig.slots.filter((slot) => !slot.id.endsWith("-far-slot") && slot.visible).map((slot) => slot.zIndex)));
    expect(rig.metadata.hiddenAnatomy).toContain("left-upper-leg"); expect(rig.metadata.farLegFrom).toBe("right");
    expect(validateRigDefinition(rig).filter((issue) => issue.code === "missing_required_semantic_attachment")).toEqual([]);
    expect([...artlessLimbBones(rig)]).not.toContain("left-upper-leg");
  });
});
