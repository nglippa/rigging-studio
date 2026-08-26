import { describe, expect, it } from "vitest";
import {
  GUIDED_BODY_ORDER, SnapshotCommandHistory, backGuidedSemantic, buildAnatomicalPartitionGuide, commitGuidedSelection,
  createPartCutterState, finishGuidedBody, finishGuidedEquipment, guideSelectionForCurrent,
  initializeGuidedManual, setGuidedIntent, skipGuidedSemantic, unresolvedComponents,
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

  it("Replace is transactional and does not steal another manual region", () => {
    const first = commitGuidedSelection(state(), select(1, 1, 4, 4), foreground).state;
    const withTorso = commitGuidedSelection(first, select(5, 2, 4, 4), foreground).state;
    const headAgain = { ...withTorso, guidedManual: { ...withTorso.guidedManual!, currentSemantic: "head" as const, intent: "replace" as const } };
    const replaced = commitGuidedSelection(headAgain, select(2, 2, 5, 5), foreground);
    expect(replaced.ok).toBe(true); expect(replaced.state.parts.filter((part) => part.semanticType === "head")).toHaveLength(1);
    expect(replaced.state.parts.find((part) => part.semanticType === "torso")?.mask.alpha.filter(Boolean)).toHaveLength(16);
    const before = replaced.state;
    const attempt = { ...before, guidedManual: { ...before.guidedManual!, currentSemantic: "leftUpperArm" as const } };
    const protectedOnly = commitGuidedSelection(attempt, select(2, 2, 3, 3), foreground);
    expect(protectedOnly.ok).toBe(false); expect(protectedOnly.state).toBe(attempt);
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
