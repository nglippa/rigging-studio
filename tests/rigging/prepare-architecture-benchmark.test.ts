import { describe, expect, it } from "vitest";
import { buildAdaptiveAnatomicalPartitionGuide, createManualRegionFromSelection, createPartCutterState, decodeOwnership, ensureOwnershipPartition, intersectSelectionWithForeground } from "../../src/part-cutter";

describe("Prepare architecture benchmark invariants", () => {
  it("keeps the current deterministic automatic bootstrap guide-only", () => {
    const foreground = new Array<number>(48 * 48).fill(0); for (let y = 1; y < 48; y += 1) for (let x = 10; x < 38; x += 1) foreground[y * 48 + x] = 255;
    const state = createPartCutterState("benchmark-source", 48, 48, "auto", "2026-08-25T10:22:41.000Z"); const guide = buildAdaptiveAnatomicalPartitionGuide(state, foreground, "humanoid", "2026-08-25T10:22:41.000Z");
    expect(guide.zones.length).toBe(15); expect(state.parts).toHaveLength(0); expect(state.ownership).toBeUndefined();
  });

  it("uses the same foreground-clipped lasso creation primitive as Prepare", () => {
    const foreground = new Array<number>(8 * 8).fill(0); for (let y = 1; y < 7; y += 1) for (let x = 1; x < 7; x += 1) foreground[y * 8 + x] = 255;
    const bounds = { x: 0, y: 0, width: 5, height: 5 }; const raw = { width: 5, height: 5, alpha: new Array<number>(25).fill(255) }; const clipped = intersectSelectionWithForeground(bounds, raw, foreground, { width: 8, height: 8 });
    const result = createManualRegionFromSelection(createPartCutterState("benchmark-source", 8, 8), "head", bounds, clipped); const canonical = ensureOwnershipPartition(result.state); const labels = decodeOwnership(canonical.ownership!);
    expect(result.changedPixels).toBe(16); expect(canonical.parts).toHaveLength(1); expect(labels.filter((label) => label === 1)).toHaveLength(16); expect(canonical.ownership?.regionIds).toEqual([result.partId]);
  });
});
