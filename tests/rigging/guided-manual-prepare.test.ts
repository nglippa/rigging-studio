import { describe, expect, it } from "vitest";
import {
  GUIDED_BODY_ORDER, SnapshotCommandHistory, backGuidedSemantic, buildAnatomicalPartitionGuide, commitGuidedSelection,
  createPartCutterState, finishGuidedBody, finishGuidedEquipment, guideSelectionForCurrent,
  adoptStrayArtwork, initializeGuidedManual, setGuidedIntent, skipGuidedSemantic, unresolvedComponents,
} from "../../src/part-cutter";

const foreground = new Array<number>(20 * 20).fill(255);
const select = (x = 1, y = 1, width = 4, height = 4) => ({ bounds: { x, y, width, height }, mask: { width, height, alpha: new Array<number>(width * height).fill(255) } });
const state = () => initializeGuidedManual(createPartCutterState("guided-source", 20, 20, "manual", "2026-08-25T12:00:00.000Z"), "2026-08-25T12:00:00.000Z");

describe("Guided Manual Prepare", () => {
  it("commits one lasso to the current semantic and auto-advances", () => {
    const result = commitGuidedSelection(state(), select(), foreground, "2026-08-25T12:00:01.000Z");
    expect(result.ok).toBe(true); expect(result.state.parts[0].semanticType).toBe("head");
    expect(result.state.guidedManual?.currentSemantic).toBe("torso"); expect(result.state.guidedManual?.completedSemantics).toContain("head");
  });

  it("keeps the same target after a failed gesture", () => {
    const result = commitGuidedSelection(state(), select(), new Array(400).fill(0));
    expect(result.ok).toBe(false); expect(result.state.guidedManual?.currentSemantic).toBe("head"); expect(result.state.parts).toHaveLength(0);
  });

  it("queues Skip and supports Back", () => {
    const skipped = skipGuidedSemantic(state(), "2026-08-25T12:00:01.000Z");
    expect(skipped.guidedManual?.skippedSemantics).toEqual(["head"]); expect(skipped.guidedManual?.currentSemantic).toBe("torso");
    expect(backGuidedSemantic(skipped).guidedManual?.currentSemantic).toBe("head");
  });

  it("Replace is transactional and does not steal a neighbour's pixels at a seam", () => {
    const first = commitGuidedSelection(state(), select(1, 1, 4, 4), foreground).state;
    const withTorso = commitGuidedSelection(first, select(5, 2, 4, 4), foreground).state;
    const headAgain = { ...withTorso, guidedManual: { ...withTorso.guidedManual!, currentSemantic: "head" as const, intent: "replace" as const } };
    const replaced = commitGuidedSelection(headAgain, select(2, 2, 5, 5), foreground);
    expect(replaced.ok).toBe(true); expect(replaced.state.parts.filter((part) => part.semanticType === "head")).toHaveLength(1);
    expect(replaced.state.parts.find((part) => part.semanticType === "torso")?.mask.alpha.filter(Boolean)).toHaveLength(16);
    const before = replaced.state;
    const attempt = { ...before, guidedManual: { ...before.guidedManual!, currentSemantic: "leftUpperArm" as const } };
    // A loop that would swallow the whole head is refused and changes nothing.
    const swallow = commitGuidedSelection(attempt, select(1, 1, 7, 7), foreground);
    expect(swallow.ok).toBe(false); expect(swallow.state).toBe(attempt);
  });

  it("Add and Remove edit the current owner without auto-advancing", () => {
    const assigned = commitGuidedSelection(state(), select(), foreground).state;
    const head = { ...assigned, guidedManual: { ...assigned.guidedManual!, currentSemantic: "head" as const } };
    const added = commitGuidedSelection(setGuidedIntent(head, "add"), select(6, 1, 2, 2), foreground);
    expect(added.ok).toBe(true); expect(added.state.guidedManual?.currentSemantic).toBe("head");
    const removed = commitGuidedSelection(setGuidedIntent(added.state, "remove"), select(1, 1, 1, 1), foreground);
    expect(removed.ok).toBe(true); expect(removed.state.guidedManual?.currentSemantic).toBe("head");
  });

  it("undo and redo restore ownership and auto-advance progression exactly", () => {
    const initial = state(); const history = new SnapshotCommandHistory(initial);
    const committed = history.execute("head", (current) => commitGuidedSelection(current, select(), foreground).state);
    const undone = history.undo(); expect(undone.guidedManual?.currentSemantic).toBe("head"); expect(undone.parts).toHaveLength(0);
    const redone = history.redo(); expect(redone.guidedManual).toEqual(committed.guidedManual); expect(redone.ownership?.runs).toEqual(committed.ownership?.runs);
  });

  it("moves from body to equipment and then review", () => {
    const equipment = finishGuidedBody(state()); expect(equipment.guidedManual?.phase).toBe("equipment"); expect(equipment.guidedManual?.currentSemantic).toBe("mainHandEquipment");
    expect(finishGuidedEquipment(equipment).guidedManual?.phase).toBe("review"); expect(GUIDED_BODY_ORDER).toHaveLength(14);
  });

  it("Use Guide is foreground-clipped and Use Component selects disconnected unresolved pixels", () => {
    const base = state(); const guide = buildAnatomicalPartitionGuide(base, "humanoid", "2026-08-25T12:00:00.000Z");
    const guided = guideSelectionForCurrent({ ...base, anatomicalGuide: guide }, foreground);
    expect(guided?.mask.alpha.some(Boolean)).toBe(true);
    const sparse = new Array<number>(400).fill(0); sparse[21] = 255; sparse[22] = 255; sparse[300] = 255;
    const components = unresolvedComponents(base, sparse); expect(components).toHaveLength(2); expect(components[0].mask.alpha.filter(Boolean)).toHaveLength(2);
  });

  it("finds one unresolved component covering a whole large sprite without overflowing the stack", () => {
    const width = 700; const height = 700;
    const large = initializeGuidedManual(createPartCutterState("large-source", width, height, "manual", "2026-08-25T12:00:00.000Z"), "2026-08-25T12:00:00.000Z");
    const components = unresolvedComponents(large, new Array<number>(width * height).fill(255));
    expect(components).toHaveLength(1); expect(components[0].bounds).toEqual({ x: 0, y: 0, width, height });
  });

  it("carves a part out of the one it lies on, but never nibbles a neighbour at a seam", () => {
    const head = commitGuidedSelection(state(), select(0, 0, 20, 4), foreground, "2026-08-25T12:00:01.000Z").state;
    const torso = commitGuidedSelection(head, select(0, 4, 20, 12), foreground, "2026-08-25T12:00:02.000Z").state;
    const owned = (current: typeof torso, semantic: string) => current.parts.find((part) => part.semanticType === semantic)!.mask.alpha.filter(Boolean).length;
    expect(owned(torso, "torso")).toBe(240);
    // An arm drawn entirely on top of the torso is cut out of it.
    const arm = commitGuidedSelection(torso, select(2, 6, 4, 6), foreground, "2026-08-25T12:00:03.000Z");
    expect(arm.ok).toBe(true); expect(owned(arm.state, "leftUpperArm")).toBe(24); expect(owned(arm.state, "torso")).toBe(216);
    // The next loop mostly covers free pixels and only brushes the torso's edge: it takes the free pixels and leaves the torso alone.
    const forearm = commitGuidedSelection(arm.state, select(0, 15, 8, 4), foreground, "2026-08-25T12:00:04.000Z");
    expect(forearm.ok).toBe(true); expect(owned(forearm.state, "leftForearm")).toBe(24); expect(owned(forearm.state, "torso")).toBe(216);
    // A loop that would swallow another part whole is refused.
    const swallow = commitGuidedSelection(forearm.state, select(0, 0, 20, 5), foreground, "2026-08-25T12:00:05.000Z");
    expect(swallow.ok).toBe(false); expect(swallow.message).toContain("erase another part");
  });

  it("joins uncut slivers to the nearest part at build time, but leaves artwork far from any part alone", () => {
    const head = commitGuidedSelection(state(), select(0, 0, 20, 4), foreground).state;
    // Rows 4-5 were missed between the two loops; rows 12 and below were never cut at all.
    const torso = commitGuidedSelection(head, select(0, 6, 20, 4), foreground).state;
    const owned = (current: typeof torso, semantic: string) => current.parts.find((part) => part.semanticType === semantic)!.mask.alpha.filter(Boolean).length;
    const result = adoptStrayArtwork(torso, foreground, 2);
    // The missed strip is shared between its two neighbours; the torso also takes the two rows below it and no more.
    expect(owned(result.state, "head")).toBe(100); expect(owned(result.state, "torso")).toBe(140);
    expect(result.adopted).toBe(80);
    expect(adoptStrayArtwork(torso, undefined, 2).adopted).toBe(0);
  });

  it("persists mid-flow progression and isolates separate projects", () => {
    const afterSeven = GUIDED_BODY_ORDER.slice(0, 7).reduce((current, _semantic, index) => commitGuidedSelection(current, select(1 + index * 2, 1, 2, 2), foreground).state, state());
    const reopened = JSON.parse(JSON.stringify(afterSeven)); expect(reopened.guidedManual.currentSemantic).toBe("rightHand"); expect(reopened.guidedManual.completedSemantics).toHaveLength(7);
    const other = state(); expect(other.guidedManual?.currentSemantic).toBe("head"); expect(other.parts).toHaveLength(0);
  });

  it("rejects stale state by preserving the supplied snapshot when the gesture is invalid", () => {
    const base = state(); const stale = { ...base, guidedManual: { ...base.guidedManual!, currentSemantic: "head" as const } };
    const newer = commitGuidedSelection(base, select(), foreground).state;
    const rejected = commitGuidedSelection(stale, select(), new Array(400).fill(0));
    expect(rejected.ok).toBe(false); expect(newer.guidedManual?.currentSemantic).toBe("torso"); expect(rejected.state.guidedManual?.currentSemantic).toBe("head");
  });
});
