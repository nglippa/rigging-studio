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
});
