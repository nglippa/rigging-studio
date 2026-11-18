import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { GUIDED_BODY_ORDER, buildAdaptiveAnatomicalPartitionGuide, commitGuidedSelection, createPartCutterState, decodeOwnership, ensureOwnershipPartition, guideAllBodyParts, initializeGuidedManual } from "../../src/part-cutter";

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
});
