import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { GUIDED_BODY_ORDER, buildAdaptiveAnatomicalPartitionGuide, changedZoneSemantics, commitGuidedSelection, createPartCutterState, decodeOwnership, ensureOwnershipPartition, guideAllBodyParts, initializeGuidedManual, moveAdaptiveLandmark, recutFromGuide } from "../../src/part-cutter";

const AT = "2026-11-17T12:00:00.000Z";
const sprite = (path: string) => {
  const png = PNG.sync.read(readFileSync(new URL(path, import.meta.url)));
  const foreground = Array.from({ length: png.width * png.height }, (_, index) => png.data[index * 4 + 3] > 16 ? 255 : 0);
  const base = createPartCutterState("guide-all", png.width, png.height, "manual", AT);
  const state = initializeGuidedManual({ ...base, anatomicalGuide: buildAdaptiveAnatomicalPartitionGuide(base, foreground, "humanoid") }, AT);
  return { state, foreground };
};

describe("Cut all parts", () => {
  it("cuts every body part of a front-facing sprite in one step and leaves almost nothing unassigned", () => {
    const { state, foreground } = sprite("../../public/benchmark/guided-manual/warrior.png");
    const result = guideAllBodyParts(state, foreground, AT);
    expect(result.missed).toEqual([]);
    expect(result.cut).toEqual([...GUIDED_BODY_ORDER]);
    const labels = decodeOwnership(ensureOwnershipPartition(result.state).ownership!);
    const visible = foreground.filter(Boolean).length;
    const covered = foreground.filter((alpha, index) => alpha && labels[index] > 0).length;
    expect(covered / visible).toBeGreaterThan(.9);
  });

  it("keeps parts the user already cut and only fills in the rest", () => {
    const { state, foreground } = sprite("../../public/benchmark/guided-manual/warrior.png");
    const width = state.sourceCanvasSize.width;
    const head = commitGuidedSelection(state, { bounds: { x: 0, y: 0, width, height: 6 }, mask: { width, height: 6, alpha: new Array(width * 6).fill(255) } }, foreground, AT);
    expect(head.ok).toBe(true);
    const headMask = head.state.parts.find((part) => part.semanticType === "head")!.mask;
    const result = guideAllBodyParts(head.state, foreground, AT);
    expect(result.cut).not.toContain("head");
    expect(result.state.parts.find((part) => part.semanticType === "head")!.mask).toEqual(headMask);
  });

  it("re-cuts only the parts around a moved joint, and never a part the caller leaves out", () => {
    const { state, foreground } = sprite("../../public/benchmark/guided-manual/warrior.png");
    const cut = guideAllBodyParts(state, foreground, AT).state;
    const elbow = cut.anatomicalGuide!.landmarks.find((landmark) => landmark.landmarkId === "leftElbow")!.point;
    const moved = { ...cut, anatomicalGuide: moveAdaptiveLandmark(cut.anatomicalGuide!, "leftElbow", { x: elbow.x - 3, y: elbow.y - 3 }, foreground, AT) };
    const changed = changedZoneSemantics(cut.anatomicalGuide, moved.anatomicalGuide);
    expect(changed).toEqual(expect.arrayContaining(["leftUpperArm", "leftForearm"]));
    expect(changed).not.toContain("rightThigh");
    const mask = (current: typeof cut, semantic: string) => current.parts.find((part) => part.semanticType === semantic)!.mask;
    // The upper arm stands in for a part edited by hand: it is left out, so it must not change.
    const result = recutFromGuide(moved, changed.filter((semantic) => semantic !== "leftUpperArm"), foreground, AT);
    expect(result.recut).toContain("leftForearm");
    expect(mask(result.state, "leftUpperArm")).toEqual(mask(cut, "leftUpperArm"));
    expect(mask(result.state, "rightThigh")).toEqual(mask(cut, "rightThigh"));
    // Re-cutting does not move the guided steps along.
    expect(result.state.guidedManual!.currentSemantic).toBe(cut.guidedManual!.currentSemantic);
  });

  it("hides the far leg of a side view instead of cutting it as a scrap, and does not take a held sword for a leg", () => {
    // The goblin stands in profile with one leg behind the other and a sword held low across them. The sword tip used to
    // be read as the second leg; that leg's zone then held almost nothing (a 1 px lower leg) while its thigh took the
    // skirt and the blade.
    const { state, foreground } = sprite("../../public/rig-test/goblin/goblin-source.png");
    const result = guideAllBodyParts(state, foreground, AT);
    expect(result.missed).toEqual([]);
    expect(result.hidden).toEqual(["rightThigh", "rightLowerLeg", "rightFoot"]);
    const visible = foreground.filter(Boolean).length;
    for (const part of result.state.parts) expect(part.mask.alpha.filter(Boolean).length / visible, part.semanticType).toBeGreaterThan(.01);
    // The near leg is one column from hip to boot: knee and ankle stacked under the hip, not out under the blade.
    const at = (id: string) => result.state.anatomicalGuide!.landmarks.find((landmark) => landmark.landmarkId === id)!.point;
    expect(Math.abs(at("leftKnee").x - at("leftAnkle").x)).toBeLessThan(120);
    expect(at("rightKnee")).toEqual(at("leftKnee"));
  });

  it("still cuts both legs of a front-facing sprite", () => {
    const { state, foreground } = sprite("../../public/benchmark/guided-manual/rogue.png");
    expect(guideAllBodyParts(state, foreground, AT).hidden).toEqual([]);
  });
});

describe("characters in a long robe", () => {
  const figure = (gapBetweenLegs: boolean) => {
    const width = 60; const height = 120; const foreground: number[] = new Array(width * height).fill(0);
    for (let y = 4; y < 116; y += 1) for (let x = 0; x < width; x += 1) {
      const head = y < 40 && Math.hypot(x - 30, y - 22) < 18;
      const body = y >= 40 && y < 70 && x >= 16 && x < 44;
      const lower = y >= 70 && y < 108 && x >= 14 && x < 46 && !(gapBetweenLegs && x >= 28 && x < 32 && y >= 74);
      const feet = y >= 108 && ((x >= 14 && x < 27) || (x >= 33 && x < 46));
      if (head || body || lower || feet) foreground[y * width + x] = 255;
    }
    const base = createPartCutterState("robe", width, height, "manual", AT);
    const state = initializeGuidedManual({ ...base, anatomicalGuide: buildAdaptiveAnatomicalPartitionGuide(base, foreground, "humanoid", undefined, "chibi") }, AT);
    return { state: guideAllBodyParts(state, foreground, AT).state, foreground };
  };

  it("folds the legs into the torso when the cloth hangs in one piece, keeping the feet", async () => {
    const { foldLegsIntoSkirt } = await import("../../src/part-cutter");
    const { state, foreground } = figure(false);
    const result = foldLegsIntoSkirt(state, foreground);
    expect(result.folded.length).toBeGreaterThanOrEqual(2);
    expect(result.state.parts.some((part) => /Thigh|LowerLeg/.test(part.semanticType))).toBe(false);
    expect(result.state.parts.some((part) => /Foot/.test(part.semanticType))).toBe(true);
  });

  it("leaves legs that show a gap between them alone", async () => {
    const { foldLegsIntoSkirt } = await import("../../src/part-cutter");
    const { state, foreground } = figure(true);
    expect(foldLegsIntoSkirt(state, foreground).folded).toEqual([]);
  });
});
