import { beforeAll, describe, expect, it } from "vitest";
import { MockCharacterPipelineProvider } from "../../src/character-generation/providers/mockCharacterPipelineProvider";
import type { CharacterSegmentationResponse, ProposedCharacterPart } from "../../src/character-generation/segmentation/segmentationSchema";
import { PART_RIGGING_SPECS, partTypeToBoneId } from "../../src/character-generation/segmentation/partTaxonomy";
import { buildRigProposal } from "../../src/character-generation/rigging/rigProposalBuilder";
import { buildProposedHierarchy } from "../../src/character-generation/rigging/hierarchyBuilder";
import { resolvePartPivot } from "../../src/character-generation/rigging/pivotResolver";
import { runRotationContinuitySmoke } from "../../src/character-generation/testing/rigSmokeTest";
import { createGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { validateAutoRigCandidate } from "../../src/character-generation/rigging/rigProposalValidator";
import { createManualPart, partCutToSegmentation } from "../../src/part-cutter/operations";
import { createPartCutterState } from "../../src/part-cutter/schema";
import { ensureOwnershipPartition } from "../../src/part-cutter/ownership";
import { validateRigDefinition } from "../../src/rigging/validation/rig";
import { updateBone, updateSlot } from "../../src/tools/rig-editor/document";

let segmentation: CharacterSegmentationResponse;
beforeAll(async () => {
  const provider = new MockCharacterPipelineProvider();
  const image = await provider.generateCharacter({ userPrompt: "knight", generationPrompt: "knight", negativePrompt: "", controls: { style: "chibi-pixel-art" } });
  segmentation = await provider.segmentCharacter({ generationId: image.generationId, image: image.image, width: image.width, height: image.height, expectedEquipment: ["sword", "shield"] });
});

const build = (name = "Standard swordsman", parts = segmentation.parts) => buildRigProposal({ name, parts, imageWidth: segmentation.imageWidth, imageHeight: segmentation.imageHeight }).rig;

describe("deterministic auto-rig reliability", () => {
  it("uses one canonical semantic mapping for body, details, and equipment", () => {
    expect(partTypeToBoneId("leftUpperArm")).toBe("left-upper-arm");
    expect(partTypeToBoneId("leftForearm")).toBe("left-lower-arm");
    expect(partTypeToBoneId("mainHandEquipment")).toBe("right-hand");
    expect(PART_RIGGING_SPECS.cape).toMatchObject({ boneId: "torso", layer: "back" });
    expect(PART_RIGGING_SPECS.hair.boneId).toBe("head");
  });

  it("builds the canonical humanoid topology with deterministic parents", () => {
    const rig = build();
    const parents = Object.fromEntries(rig.bones.map((bone) => [bone.id, bone.parentId]));
    expect(parents).toMatchObject({ pelvis: "root", torso: "pelvis", neck: "torso", head: "neck", "left-lower-arm": "left-upper-arm", "left-hand": "left-lower-arm", "right-lower-leg": "right-upper-leg", "right-foot": "right-lower-leg" });
    expect(new Set(rig.bones.map((bone) => bone.id)).size).toBe(rig.bones.length);
  });

  it("selects a first-class digitigrade chain and keeps hocks articulated", () => {
    const rig = build("Digitigrade beastman");
    expect(rig.metadata.anatomyProfile).toBe("digitigrade");
    expect(rig.bones.find((bone) => bone.id === "left-hock")).toMatchObject({ parentId: "left-lower-leg" });
    expect(rig.bones.find((bone) => bone.id === "left-foot")).toMatchObject({ parentId: "left-hock" });
    expect(rig.bones.find((bone) => bone.id === "right-hock")?.length).toBeGreaterThan(0);
  });

  it("prefers adaptive landmarks over ownership geometry", () => {
    const part = segmentation.parts.find((candidate) => candidate.semanticType === "leftUpperArm")!;
    const prepared = createManualPart(createPartCutterState("source", segmentation.imageWidth, segmentation.imageHeight), "leftUpperArm", part.bounds, part.mask, part.name);
    const state = { ...createPartCutterState("source", segmentation.imageWidth, segmentation.imageHeight), parts: [{ ...prepared, partId: part.id, provenance: "ai" as const }], anatomicalGuide: { guideVersion: 1 as const, profile: "humanoid" as const, sourceCanvasSize: { width: segmentation.imageWidth, height: segmentation.imageHeight }, landmarks: [{ landmarkId: "leftShoulder" as const, point: { x: 44, y: 55 }, parentLandmarkId: "chest" as const, source: "silhouette" as const }], zones: [], status: "seeded" as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } };
    expect(resolvePartPivot(part, [part], state)).toMatchObject({ point: { x: 44, y: 55 }, source: "landmark" });
  });

  it("uses the shared ownership boundary before local geometry", () => {
    const initial = createPartCutterState("source", 8, 4);
    const torso = { ...createManualPart(initial, "torso", { x: 0, y: 0, width: 4, height: 4 }), provenance: "ai" as const };
    const arm = { ...createManualPart(initial, "leftUpperArm", { x: 4, y: 0, width: 4, height: 4 }), provenance: "ai" as const };
    const state = ensureOwnershipPartition({ ...initial, parts: [torso, arm] });
    const parts = partCutToSegmentation(state).parts;
    expect(resolvePartPivot(parts.find((part) => part.semanticType === "leftUpperArm")!, parts, state)).toMatchObject({ source: "boundary", point: { x: 3.5, y: 1.5 } });
  });

  it("keeps extreme-chibi and broad-dwarf bones finite and source-relative", () => {
    for (const name of ["Extreme chibi fighter", "Broad dwarf"]) {
      const hierarchy = buildProposedHierarchy(segmentation.parts.map((part) => ({ ...part, bounds: { ...part.bounds, height: Math.max(1, part.bounds.height * .18) } })), segmentation.imageWidth, segmentation.imageHeight, { name });
      expect(hierarchy.bones.every((bone) => Number.isFinite(bone.length) && bone.length > 0)).toBe(true);
    }
  });

  it("binds armor anatomically without pulling the shoulder joint", () => {
    const upper = segmentation.parts.find((part) => part.semanticType === "leftUpperArm")!;
    const armor: ProposedCharacterPart = { ...upper, id: "left-pauldron", name: "Left pauldron", semanticType: "shoulderLeft", suggestedBoneId: "root", suggestedSlotId: "wrong", suggestedZIndex: 999 };
    const base = build(); const armored = build("Bulky marine", [...segmentation.parts, armor]);
    expect(armored.slots.find((slot) => slot.attachmentId === armor.id)?.boneId).toBe("left-upper-arm");
    expect(armored.attachments.find((attachment) => attachment.id === armor.id)?.category).toBe("equipment");
    expect(armored.bones.find((bone) => bone.id === "left-upper-arm")).toEqual(base.bones.find((bone) => bone.id === "left-upper-arm"));
  });

  it("keeps a coherent hidden leg skeleton under a robe", () => {
    const rig = build("Robed mage", segmentation.parts.filter((part) => part.semanticType !== "rightFoot"));
    expect(rig.bones.some((bone) => bone.id === "right-foot")).toBe(true);
    expect(rig.slots.find((slot) => slot.id === "right-foot-hidden-slot")).toMatchObject({ attachmentId: null, visible: false });
    expect(rig.metadata.hiddenAnatomy).toContain("right-foot");
    expect(validateRigDefinition(rig)).toEqual([]);
  });

  it("binds equipment at its grip pivot and derives semantic z-order", () => {
    const weapon = segmentation.parts.find((part) => part.semanticType === "mainHandEquipment")!;
    const rig = build(); const slot = rig.slots.find((candidate) => candidate.attachmentId === weapon.id)!;
    expect(slot.boneId).toBe("right-hand");
    expect(slot.pivotX).toBeGreaterThanOrEqual(0); expect(slot.pivotX).toBeLessThanOrEqual(weapon.bounds.width);
    expect(slot.pivotY).toBeGreaterThanOrEqual(0); expect(slot.pivotY).toBeLessThanOrEqual(weapon.bounds.height);
    expect([slot.pivotX, slot.pivotY]).not.toEqual([weapon.bounds.width / 2, weapon.bounds.height / 2]);
    expect(rig.slots.find((candidate) => candidate.attachmentId === segmentation.parts.find((part) => part.semanticType === "cape")?.id)?.zIndex ?? -15).toBeLessThan(rig.slots.find((candidate) => candidate.attachmentId === weapon.id)!.zIndex);
  });

  it("is idempotent and records auto provenance", () => {
    const first = build(); const second = build();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.metadata.pivotSources).toBeTruthy();
    expect(first.metadata.bindingSources).toBeTruthy();
  });

  it("rejects a corrupt full-project candidate before commit", () => {
    const rig = build(); const project = { ...createGeneratedCharacterProject("Candidate", "test", "2026-01-01T00:00:00.000Z"), rigDefinition: rig, skins: rig.skins };
    const broken = { ...rig, slots: rig.slots.map((slot, index) => index ? slot : { ...slot, boneId: "foreign-bone" }) };
    expect(validateAutoRigCandidate(project, broken).some((problem) => problem.code === "missing_slot_bone")).toBe(true);
  });

  it("records compatible manual overrides and preserves them through later edits", () => {
    const rig = build();
    const moved = updateBone(rig, "left-upper-arm", { x: rig.bones.find((bone) => bone.id === "left-upper-arm")!.x + 2 });
    const rebound = updateSlot(moved, moved.slots[0].id, { zIndex: moved.slots[0].zIndex + 1 });
    expect(rebound.metadata.manualOverrides).toMatchObject({ bones: { "left-upper-arm": ["x"] }, slots: { [moved.slots[0].id]: ["zIndex"] } });
  });

  it("maintains child and equipment continuity through rotation torture", () => {
    expect(runRotationContinuitySmoke(build())).toMatchObject({ passed: true });
  });
});
