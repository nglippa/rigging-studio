import { describe, expect, it } from "vitest";
import {
  SnapshotCommandHistory, analyzeCoverage, assignOwnershipSelection, createManualRegionFromSelection, createPartCutterState,
  derivePrepareWorkflowState, ensureOwnershipPartition, intersectSelectionWithForeground, primaryActionForPrepare,
} from "../../src/part-cutter";

const selection = { bounds: { x: 1, y: 1, width: 4, height: 4 }, mask: { width: 4, height: 4, alpha: Array(16).fill(255) } };

describe("Prepare state-driven action rail", () => {
  it("renders exactly one canonical action for every state", () => {
    expect(["SOURCE_READY", "GUIDE_READY", "CUTTING", "REVIEWING", "CUT_ACCEPTED"].map((state) => primaryActionForPrepare(state as never))).toEqual(["continue-to-cut", "continue-to-cut", "review-cut", "accept-cut", "continue-to-setup"]);
  });
  it("derives accepted from the canonical ownership review status", () => {
    const empty = createPartCutterState("source", 8, 8, "manual", "2026-08-22T00:00:00.000Z");
    expect(derivePrepareWorkflowState(empty)).toBe("SOURCE_READY");
  });
});

describe("manual foreground partition", () => {
  it("intersects lasso pixels with source alpha", () => {
    const foreground = Array(36).fill(0); foreground[2 * 6 + 2] = 255; foreground[3 * 6 + 3] = 255;
    const clipped = intersectSelectionWithForeground(selection.bounds, selection.mask, foreground, { width: 6, height: 6 });
    expect(clipped.alpha.filter(Boolean)).toHaveLength(2);
  });
  it("creates a new region and transfers overlapping pixels exclusively", () => {
    const empty = createPartCutterState("source", 8, 8, "manual", "2026-08-22T00:00:00.000Z");
    const head = createManualRegionFromSelection(empty, "head", selection.bounds, selection.mask);
    const overlap = { bounds: { x: 3, y: 3, width: 3, height: 3 }, mask: { width: 3, height: 3, alpha: Array(9).fill(255) } };
    const hair = createManualRegionFromSelection(head.state, "hair", overlap.bounds, overlap.mask);
    expect(hair.previousOwnerIds).toContain(head.partId);
    expect(hair.state.parts.map((part) => part.mask.alpha.filter(Boolean).length).reduce((a, b) => a + b, 0)).toBe(21);
    expect(hair.state.ownership?.regionIds).toEqual([head.partId, hair.partId]);
  });
  it("ADD and REMOVE use the same ownership map", () => {
    const base = createManualRegionFromSelection(createPartCutterState("source", 8, 8), "torso", selection.bounds, selection.mask);
    const add = assignOwnershipSelection(base.state, base.partId, { x: 5, y: 1, width: 2, height: 2 }, { width: 2, height: 2, alpha: Array(4).fill(255) }, { includeBackground: true });
    const remove = assignOwnershipSelection(add.state, null, { x: 1, y: 1, width: 1, height: 1 }, { width: 1, height: 1, alpha: [255] }, { includeBackground: true });
    expect(add.changedPixels).toBe(4); expect(remove.changedPixels).toBe(1);
    expect(remove.state.ownership?.reviewStatus).toBe("review");
  });
  it("restores exact prior ownership in one undo", () => {
    const first = createManualRegionFromSelection(createPartCutterState("source", 8, 8), "head", selection.bounds, selection.mask).state;
    const history = new SnapshotCommandHistory(first);
    const before = first.ownership?.runs;
    history.execute("Lasso Hair", (state) => createManualRegionFromSelection(state, "hair", { x: 2, y: 2, width: 3, height: 3 }, { width: 3, height: 3, alpha: Array(9).fill(255) }).state);
    expect(history.undo().ownership?.runs).toEqual(before);
  });
  it("preserves canonical work while switching Guided and Manual", () => {
    const manual = createManualRegionFromSelection(createPartCutterState("source", 8, 8), "custom", selection.bounds, selection.mask, "Wooden Club").state;
    const guided = ensureOwnershipPartition({ ...manual, mode: "auto" });
    const back = ensureOwnershipPartition({ ...guided, mode: "manual" });
    expect(back.parts[0].label).toBe("Wooden Club"); expect(back.ownership?.runs).toEqual(manual.ownership?.runs);
  });
  it("measures legitimate unresolved foreground", () => {
    const foreground = Array(64).fill(255);
    const manual = createManualRegionFromSelection(createPartCutterState("source", 8, 8), "head", selection.bounds, selection.mask).state;
    expect(analyzeCoverage(manual, foreground).percentAssigned).toBe(.25);
  });
});
