import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { fillPartArt } from "../../src/character-generation/rigging/jointFill";
import { buildAdaptiveAnatomicalPartitionGuide, chooseHeldObjects, commitHeldObjects, createPartCutterState, guideAllBodyParts, heldObjectHand, heldObjectSeeds, initializeGuidedManual, mergeHeldPieces, partCutToSegmentation, selectionFromCanvasMask } from "../../src/part-cutter";

const AT = "2026-11-17T12:00:00.000Z";
const goblin = (() => {
  const png = PNG.sync.read(readFileSync(new URL("../../public/rig-test/goblin/goblin-source.png", import.meta.url)));
  const foreground = Array.from({ length: png.width * png.height }, (_, index) => png.data[index * 4 + 3] > 16 ? 255 : 0);
  const base = createPartCutterState("held", png.width, png.height, "manual", AT);
  const guide = buildAdaptiveAnatomicalPartitionGuide(base, foreground, "humanoid", AT);
  return { png, foreground, base, guide };
})();
// Where the held items are on the goblin (source pixels): the blade below the hip, and the round shield.
const BLADE = { x: 600, y: 960, width: 360, height: 220 };
const SHIELD = { x: 590, y: 520, width: 280, height: 420 };
const inside = (point: { x: number; y: number }, box: typeof BLADE) => point.x >= box.x && point.y >= box.y && point.x < box.x + box.width && point.y < box.y + box.height;
/** The sword as a click-to-select model would return it: the foreground along the blade, from pommel to tip. */
const swordMask = () => {
  const { png, foreground } = goblin; const alpha = new Array<number>(png.width * png.height).fill(0);
  const a = { x: 110, y: 955 }; const b = { x: 950, y: 1125 }; const dx = b.x - a.x; const dy = b.y - a.y; const length = dx * dx + dy * dy;
  for (let y = 880; y < 1200; y += 1) for (let x = 80; x < 980; x += 1) { const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length)); if (Math.hypot(x - a.x - t * dx, y - a.y - t * dy) <= 38) alpha[y * png.width + x] = foreground[y * png.width + x]; }
  return alpha;
};
/** The foreground inside a box, as a click-to-select model might return for an item there. */
const itemMask = (box: typeof BLADE) => {
  const { png, foreground } = goblin; const alpha = new Array<number>(png.width * png.height).fill(0);
  for (let y = box.y; y < box.y + box.height; y += 1) for (let x = box.x; x < box.x + box.width; x += 1) alpha[y * png.width + x] = foreground[y * png.width + x];
  return alpha;
};

describe("held objects", () => {
  it("finds points on the sword and the shield from the silhouette, and none on a sprite's body", () => {
    const seeds = heldObjectSeeds(goblin.guide, goblin.foreground);
    expect(seeds.some((seed) => inside(seed.point, BLADE))).toBe(true);
    expect(seeds.some((seed) => inside(seed.point, SHIELD))).toBe(true);
    for (const seed of seeds) expect(goblin.foreground[seed.point.y * goblin.png.width + seed.point.x]).toBeGreaterThan(0);
  });

  it("keeps only the piece under the seed from a model's mask", () => {
    const alpha = new Array<number>(20 * 10).fill(0);
    for (let y = 2; y < 6; y += 1) for (let x = 2; x < 8; x += 1) alpha[y * 20 + x] = 255;      // the object
    for (let y = 1; y < 9; y += 1) for (let x = 12; x < 19; x += 1) alpha[y * 20 + x] = 255;    // a bigger stray piece
    const selection = selectionFromCanvasMask(alpha, 20, 10, { x: 4, y: 3 })!;
    expect(selection.bounds).toEqual({ x: 2, y: 2, width: 6, height: 4 });
    expect(selectionFromCanvasMask(new Array(200).fill(0), 20, 10)).toBeNull();
  });

  it("names the hand holding an item, and refuses masks that are the body, far from a hand, or a repeat", () => {
    const { guide, foreground, png } = goblin;
    const select = (box: typeof BLADE) => selectionFromCanvasMask(itemMask(box), png.width, png.height)!;
    const blade = selectionFromCanvasMask(swordMask(), png.width, png.height)!;
    const shield = select(SHIELD);
    const wrist = (hand: "left" | "right") => guide.landmarks.find((landmark) => landmark.landmarkId === `${hand}Wrist`)!.point;
    const nearest = (selection: ReturnType<typeof select>) => { let best = { hand: "left" as "left" | "right", d: Infinity }; for (const hand of ["left", "right"] as const) for (let y = 0; y < selection.mask.height; y += 1) for (let x = 0; x < selection.mask.width; x += 1) if (selection.mask.alpha[y * selection.mask.width + x]) { const d = Math.hypot(selection.bounds.x + x - wrist(hand).x, selection.bounds.y + y - wrist(hand).y); if (d < best.d) best = { hand, d }; } return best.hand; };
    expect(heldObjectHand(guide, blade.mask, blade.bounds, foreground)).toBe(nearest(blade));
    expect(heldObjectHand(guide, shield.mask, shield.bounds, foreground)).toBe(nearest(shield));
    // The same item again is a repeat.
    expect(heldObjectHand(guide, shield.mask, shield.bounds, foreground, [shield])).toBeNull();
    // The head is body, not something held.
    const head = guide.zones.find((zone) => zone.semanticType === "head")!;
    expect(heldObjectHand(guide, head.mask!, head.bounds, foreground)).toBeNull();
  });

  it("cuts held items out of the parts that had swallowed them, as the holding hand's equipment", () => {
    const { foreground, base, guide, png } = goblin;
    const body = guideAllBodyParts(initializeGuidedManual({ ...base, anatomicalGuide: guide }, AT), foreground, AT).state;
    const blade = selectionFromCanvasMask(swordMask(), png.width, png.height)!;
    const area = (state: typeof body, semantic: string) => state.parts.find((part) => part.semanticType === semantic)?.mask.alpha.filter(Boolean).length ?? 0;
    const before = body.parts.reduce((sum, part) => sum + part.mask.alpha.filter(Boolean).length, 0);
    const result = commitHeldObjects(body, [{ ...blade, hand: "left" }, { ...blade, hand: "left" }], foreground, AT);
    expect(result.cut).toEqual(["offHandEquipment"]);
    expect(area(result.state, "offHandEquipment")).toBeGreaterThan(blade.mask.alpha.filter(Boolean).length * .9);
    // Carved out of the parts that had it (the near thigh), never owned twice.
    expect(area(result.state, "leftThigh")).toBeLessThan(area(body, "leftThigh"));
    expect(result.state.parts.reduce((sum, part) => sum + part.mask.alpha.filter(Boolean).length, 0)).toBeLessThanOrEqual(Math.max(before, foreground.filter(Boolean).length));
    // The guided step the user was on does not move.
    expect(result.state.guidedManual!.currentSemantic).toBe(body.guidedManual!.currentSemantic);
  });

  it("with the masks SAM2 really returns for the goblin, cuts sword and shield into the right hands and leaves the arms as arms", () => {
    // Masks recorded from the Studio's SAM2 (point prompts at the blade and the shield), so this checks the real shapes.
    const { foreground, base, guide, png } = goblin;
    const recorded = (name: string) => { const mask = PNG.sync.read(readFileSync(new URL(`../fixtures/rigging/goblin-sam-${name}.png`, import.meta.url))); return selectionFromCanvasMask(Array.from({ length: mask.width * mask.height }, (_, index) => mask.data[index * 4]), mask.width, mask.height)!; };
    const shield = recorded("shield"); const blade = recorded("blade");
    const shieldHand = heldObjectHand(guide, shield.mask, shield.bounds, foreground);
    const bladeHand = heldObjectHand(guide, blade.mask, blade.bounds, foreground, [shield]);
    expect(shieldHand).toBe("right");
    expect(bladeHand).toBe("left");
    const body = guideAllBodyParts(initializeGuidedManual({ ...base, anatomicalGuide: guide }, AT), foreground, AT).state;
    const result = commitHeldObjects(body, [{ ...shield, hand: shieldHand! }, { ...blade, hand: bladeHand! }], foreground, AT).state;
    const inShield = (x: number, y: number) => { const lx = x - shield.bounds.x; const ly = y - shield.bounds.y; return lx >= 0 && ly >= 0 && lx < shield.mask.width && ly < shield.mask.height && shield.mask.alpha[ly * shield.mask.width + lx] > 0; };
    const part = (semantic: string) => result.parts.find((candidate) => candidate.semanticType === semantic)!;
    const share = (semantic: string) => { const p = part(semantic); let total = 0; let inside = 0; for (let y = 0; y < p.mask.height; y += 1) for (let x = 0; x < p.mask.width; x += 1) if (p.mask.alpha[y * p.mask.width + x]) { total += 1; if (inShield(p.boundingBox.x + x, p.boundingBox.y + y)) inside += 1; } return { total, inside: inside / Math.max(1, total) }; };
    // The near arm's upper arm is a real part of the body, not a strip of shield rim.
    const upper = share("rightUpperArm");
    expect(upper.total / foreground.filter(Boolean).length).toBeGreaterThan(.02);
    expect(upper.inside).toBe(0);
    expect(part("mainHandEquipment").mask.alpha.filter(Boolean).length).toBeGreaterThan(shield.mask.alpha.filter(Boolean).length * .9);
    expect(part("offHandEquipment").mask.alpha.filter(Boolean).length).toBeGreaterThan(blade.mask.alpha.filter(Boolean).length * .9);
    // The shoulder sits on the body (hand-marked at 460, 480), not out on the shield.
    const shoulder = guide.landmarks.find((landmark) => landmark.landmarkId === "rightShoulder")!.point;
    expect(Math.hypot(shoulder.x - 460, shoulder.y - 480)).toBeLessThan(60);
    void png;
  });

  it("names the hands holding a 48 px pixel sprite's sword and shield, from the masks SAM2 really returns", () => {
    // Recorded from the Studio's SAM2 with the sprite enlarged by Scale2× first (as the service does for small images).
    const png = PNG.sync.read(readFileSync(new URL("../../public/benchmark/guided-manual/warrior.png", import.meta.url)));
    const foreground = Array.from({ length: png.width * png.height }, (_, index) => png.data[index * 4 + 3] > 16 ? 255 : 0);
    const guide = buildAdaptiveAnatomicalPartitionGuide(createPartCutterState("warrior", png.width, png.height, "manual", AT), foreground, "humanoid", AT);
    const recorded = (name: string) => { const mask = PNG.sync.read(readFileSync(new URL(`../fixtures/rigging/warrior-sam-${name}.png`, import.meta.url))); return selectionFromCanvasMask(Array.from({ length: mask.width * mask.height }, (_, index) => mask.data[index * 4]), mask.width, mask.height)!; };
    const sword = recorded("sword"); const shield = recorded("shield");
    expect(heldObjectHand(guide, sword.mask, sword.bounds, foreground, [shield])).toBe("left");
    expect(heldObjectHand(guide, shield.mask, shield.bounds, foreground, [sword])).toBe("right");
  });

  it("refuses a mask that is only the hand (a click on the fingers), since a held item reaches past the hand", () => {
    const { guide, foreground } = goblin;
    const hand = guide.zones.find((zone) => zone.semanticType === "leftHand")!;
    expect(heldObjectHand(guide, hand.mask!, hand.bounds, foreground)).toBeNull();
  });

  it("joins touching pieces in one hand, keeps hand-grown masks only as a fallback, and keeps one object per hand", () => {
    const box = (x: number, y: number, width: number, height: number) => ({ bounds: { x, y, width, height }, mask: { width, height, alpha: new Array(width * height).fill(255) } });
    // Rope and claw of one hook, touching: one object.
    const joined = mergeHeldPieces([{ ...box(0, 0, 4, 10), hand: "left" as const }, { ...box(4, 8, 6, 6), hand: "left" as const }]);
    expect(joined).toHaveLength(1);
    expect(joined[0].bounds).toEqual({ x: 0, y: 0, width: 10, height: 14 });
    // Apart, or in different hands: separate.
    expect(mergeHeldPieces([{ ...box(0, 0, 4, 4), hand: "left" as const }, { ...box(20, 20, 4, 4), hand: "left" as const }])).toHaveLength(2);
    expect(mergeHeldPieces([{ ...box(0, 0, 4, 4), hand: "left" as const }, { ...box(4, 0, 4, 4), hand: "right" as const }])).toHaveLength(2);
    // A hand-grown mask (which may be the arm) is dropped when the silhouette found something for that hand; kept otherwise.
    const chosen = chooseHeldObjects([
      { ...box(0, 0, 4, 10), hand: "left" }, { ...box(30, 0, 20, 20), hand: "left", fromHand: true },
      { ...box(60, 0, 5, 5), hand: "right", fromHand: true },
    ]);
    expect(chosen.find((item) => item.hand === "left")!.bounds.x).toBe(0);
    expect(chosen.find((item) => item.hand === "right")!.bounds.x).toBe(60);
    expect(chosen).toHaveLength(2);
  });

  it("cuts a held item with its outline, so no body part invents art in the item's shape when it moves", () => {
    // On the 48 px warrior the head's box spans the raised sword. Before, the sword's dark outline stayed with the head and
    // the head's hidden-area fill painted the whole blade, which showed as a dark ghost sword once the real one moved.
    const png = PNG.sync.read(readFileSync(new URL("../../public/benchmark/guided-manual/warrior.png", import.meta.url)));
    const foreground = Array.from({ length: png.width * png.height }, (_, index) => png.data[index * 4 + 3] > 16 ? 255 : 0);
    const base = createPartCutterState("warrior", png.width, png.height, "manual", AT);
    const guide = buildAdaptiveAnatomicalPartitionGuide(base, foreground, "humanoid", AT);
    const body = guideAllBodyParts(initializeGuidedManual({ ...base, anatomicalGuide: guide }, AT), foreground, AT).state;
    const recorded = (name: string) => { const mask = PNG.sync.read(readFileSync(new URL(`../fixtures/rigging/warrior-sam-${name}.png`, import.meta.url))); return selectionFromCanvasMask(Array.from({ length: mask.width * mask.height }, (_, index) => mask.data[index * 4]), mask.width, mask.height)!; };
    const sword = recorded("sword");
    const committed = commitHeldObjects(body, [{ ...sword, hand: "left" }, { ...recorded("shield"), hand: "right" }], foreground, AT);
    // Both items are cut, even where an item (with its outline) covers a whole tiny part such as the shield hand.
    expect([...committed.cut].sort()).toEqual(["mainHandEquipment", "offHandEquipment"]);
    expect(committed.state.parts.some((part) => part.semanticType === "rightHand")).toBe(true);
    const state = committed.state;
    const segmentation = partCutToSegmentation(state);
    const filled = fillPartArt({ width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) }, segmentation.parts);
    const inSword = (x: number, y: number) => { const lx = x - sword.bounds.x; const ly = y - sword.bounds.y; return lx >= 0 && ly >= 0 && lx < sword.mask.width && ly < sword.mask.height && sword.mask.alpha[ly * sword.mask.width + lx] > 0; };
    let invented = 0;
    for (const art of filled) {
      const semantic = segmentation.parts.find((part) => part.id === art.partId)!.semanticType; if (semantic === "leftHand") continue; // the grip under the hilt is real hidden hand
      for (let y = 0; y < art.bounds.height; y += 1) for (let x = 0; x < art.bounds.width; x += 1) if (art.filledMask[y * art.bounds.width + x] && inSword(art.bounds.x + x, art.bounds.y + y)) invented += 1;
    }
    expect(invented).toBe(0);
  });
});
