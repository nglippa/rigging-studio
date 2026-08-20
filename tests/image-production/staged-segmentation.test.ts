import { describe, expect, it } from "vitest";
import type { PartType } from "../../src/character-generation/segmentation/partTaxonomy";
import {
  DETECTOR_PHRASE_REGISTRY,
  detectorCrop,
  detectorPhrases,
  detectionStage,
  overlapDecision,
  reclassifySemantic,
  remapCropMask,
  resolveCharacterScreenSides,
  resolveConflictingOverlaps,
  scoreMaskCandidate,
  stagedTargets,
  summarizeMask,
  type SegmentationAnchors,
  type TrustedSemanticRegion,
} from "../../src/image-production/service/stagedSegmentation";

const region = (semanticType: PartType, x: number, y: number, width = 10, height = 10): TrustedSemanticRegion => ({
  semanticType,
  mask: new Uint8Array(100),
  qualityScore: .9,
  summary: {
    bounds: { x, y, width, height }, area: width * height, bboxArea: width * height, fillRatio: 1,
    centroid: { x: x + width / 2, y: y + height / 2 }, areaRatio: width * height / 10_000,
  },
});

const rectangularMask = (canvasWidth: number, canvasHeight: number, x: number, y: number, width: number, height: number): Uint8Array => {
  const alpha = new Uint8Array(canvasWidth * canvasHeight);
  for (let row = y; row < y + height; row += 1) for (let column = x; column < x + width; column += 1) alpha[row * canvasWidth + column] = 255;
  return alpha;
};

describe("staged character segmentation", () => {
  it("orders equipment and stable anchors before side-dependent limb chains", () => {
    const plan = stagedTargets(["rightHand", "torso", "leftFoot", "head", "offHandEquipment", "mainHandEquipment"]);
    expect(plan).toEqual(["mainHandEquipment", "offHandEquipment", "head", "torso", "rightHand", "leftFoot"]);
    expect(plan.map(detectionStage)).toEqual(["equipment", "equipment", "stable", "stable", "right-arm", "left-leg"]);
  });

  it("uses configurable detector phrases and retains multiple candidates for difficult targets", () => {
    expect(DETECTOR_PHRASE_REGISTRY.torso).toContain("chest armor");
    expect(detectorPhrases("torso", 4)).toHaveLength(4);
    expect(detectorPhrases("mainHandEquipment", 3)).toEqual(["sword", "longsword", "blade"]);
    expect(detectorPhrases("leftForearm", 2)).toEqual(["forearm", "lower arm"]);
  });

  it("resolves anatomical left/right from sword and shield anchors instead of prompt wording", () => {
    const anchors: SegmentationAnchors = {
      torso: region("torso", 40, 20, 20, 50),
      mainHandEquipment: region("mainHandEquipment", 5, 40, 10, 45),
      offHandEquipment: region("offHandEquipment", 78, 35, 18, 40),
    };
    expect(resolveCharacterScreenSides(100, anchors)).toMatchObject({ characterRight: "screen-left", characterLeft: "screen-right" });
    expect(detectorCrop("leftHand", 100, 100, anchors).x).toBeGreaterThanOrEqual(50);
    expect(detectorCrop("rightHand", 100, 100, anchors).x).toBeLessThan(50);
  });

  it("remaps a contextual crop mask into exact source coordinates", () => {
    const mapped = remapCropMask(Uint8Array.from([255, 0, 0, 255, 255, 0]), 3, 2, { x: 4, y: 5, width: 3, height: 2 }, 10, 10);
    expect(mapped[5 * 10 + 4]).toBe(255);
    expect(mapped[5 * 10 + 5]).toBe(0);
    expect(mapped[6 * 10 + 4]).toBe(255);
    expect(mapped[6 * 10 + 5]).toBe(255);
    expect(mapped.filter(Boolean)).toHaveLength(3);
  });

  it("reclassifies a rigid side-aligned tail query as sword while keeping a sword semantic distinct from tail", () => {
    const mask = rectangularMask(100, 100, 5, 45, 8, 45);
    const summary = summarizeMask(mask, 100, 100)!;
    expect(reclassifySemantic("tail", summary, {}, 100, 100)).toMatchObject({ semanticType: "mainHandEquipment", ambiguous: false });
    expect(reclassifySemantic("mainHandEquipment", summary, {}, 100, 100)).toMatchObject({ semanticType: "mainHandEquipment", ambiguous: false });
  });

  it("rejects broad masks and passes a compact source-plausible head through the safety gate", () => {
    const broad = summarizeMask(rectangularMask(100, 100, 0, 0, 100, 35), 100, 100)!;
    const compact = summarizeMask(rectangularMask(100, 100, 44, 4, 12, 12), 100, 100)!;
    const crop = { x: 0, y: 0, width: 100, height: 100 };
    expect(scoreMaskCandidate("head", broad, crop, 100, 100, {})).toMatchObject({ broad: true, safe: false });
    expect(scoreMaskCandidate("head", compact, crop, 100, 100, {})).toMatchObject({ broad: false, safe: true });
  });

  it("distinguishes expected attachment overlap from catastrophic unrelated overlap", () => {
    const hand = Uint8Array.from([255, 255, 255, 255, 255, 0, 0, 0, 0, 0]);
    const sword = Uint8Array.from([0, 0, 0, 0, 255, 255, 255, 255, 255, 0]);
    const duplicate = Uint8Array.from(hand);
    expect(overlapDecision("rightHand", hand, "mainHandEquipment", sword)).toMatchObject({ expected: true, conflicting: false, intersection: 1 });
    expect(overlapDecision("leftHand", hand, "rightFoot", duplicate)).toMatchObject({ expected: false, conflicting: true });
  });

  it("subtracts catastrophic overlap only from the meaningfully lower-scored candidate", () => {
    const high = Uint8Array.from([255, 255, 255, 0, 0, 0]);
    const low = Uint8Array.from([255, 255, 255, 255, 255, 0]);
    const resolved = resolveConflictingOverlaps([
      { semanticType: "head", mask: high, qualityScore: .92 },
      { semanticType: "rightFoot", mask: low, qualityScore: .55 },
    ]);
    expect([...resolved.parts[0].mask]).toEqual([...high]);
    expect([...resolved.parts[1].mask]).toEqual([0, 0, 0, 255, 255, 0]);
    expect(resolved.decisions[0]).toMatchObject({ conflicting: true, subtractedFrom: "rightFoot" });
  });
});
