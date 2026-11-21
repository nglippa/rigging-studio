import { describe, expect, it } from "vitest";
import { commitGuidedSelection, createPartCutterState, decodeOwnership, ensureOwnershipPartition, initializeGuidedManual } from "../../src/part-cutter";
import { snapBoundariesToOutlines } from "../../src/part-cutter/ownership";

const AT = "2026-11-21T12:00:00.000Z";
const WIDTH = 40; const HEIGHT = 12; const LINE = 22;

/** Red on the left, blue on the right, a dark drawn line between them at x = LINE. */
const picture = (line: boolean): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
    const at = (y * WIDTH + x) * 4; const colour = line && x === LINE ? [20, 20, 24] : line ? (x < LINE ? [200, 60, 60] : [60, 80, 200]) : [150, 150, 150];
    data.set([...colour, 255], at);
  }
  return data;
};

/** Two parts cut by a straight line at x = 18: the head left of it, the torso right of it (4 px short of the drawn line). */
const twoParts = () => {
  const foreground = new Array<number>(WIDTH * HEIGHT).fill(255);
  const column = (from: number, to: number) => ({ bounds: { x: from, y: 0, width: to - from, height: HEIGHT }, mask: { width: to - from, height: HEIGHT, alpha: new Array((to - from) * HEIGHT).fill(255) } });
  let state = initializeGuidedManual(createPartCutterState("snap", WIDTH, HEIGHT, "manual", AT), AT);
  const head = commitGuidedSelection(state, column(0, 18), foreground, AT); expect(head.ok).toBe(true); state = head.state;
  const torso = commitGuidedSelection(state, column(18, WIDTH), foreground, AT); expect(torso.ok).toBe(true);
  return torso.state;
};

const ownerColumns = (state: ReturnType<typeof twoParts>): number[] => {
  const labels = decodeOwnership(ensureOwnershipPartition(state).ownership!);
  return Array.from({ length: WIDTH }, (_, x) => labels[5 * WIDTH + x]);
};

describe("boundaries snap to the drawn outlines", () => {
  it("moves a straight cut onto the dark line the artist drew next to it", () => {
    const state = twoParts(); const before = ownerColumns(state);
    const { state: snapped, moved } = snapBoundariesToOutlines(state, picture(true), 6);
    const after = ownerColumns(snapped);
    expect(moved).toBeGreaterThan(0);
    // Everything left of the line now belongs to the left part, everything right of it to the right part.
    for (let x = 0; x < LINE; x += 1) expect(after[x]).toBe(before[0]);
    for (let x = LINE + 1; x < WIDTH; x += 1) expect(after[x]).toBe(before[WIDTH - 1]);
  });

  it("leaves a cut alone where the art draws no line near it", () => {
    const state = twoParts(); const before = ownerColumns(state);
    const { state: snapped, moved } = snapBoundariesToOutlines(state, picture(false), 6);
    expect(moved).toBe(0);
    expect(ownerColumns(snapped)).toEqual(before);
  });

  it("changes nothing without the picture's colours", () => {
    expect(snapBoundariesToOutlines(twoParts(), undefined, 6).moved).toBe(0);
  });
});
