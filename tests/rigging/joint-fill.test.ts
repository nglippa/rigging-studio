import { describe, expect, it } from "vitest";
import { fillPartArt } from "../../src/character-generation/rigging/jointFill";
import { compositeBehind, mergeRepaint, repaintWorthwhile } from "../../src/character-generation/rigging/riggedPartArt";
import { estimateZIndex } from "../../src/character-generation/rigging/zOrderEstimator";
import type { PartType } from "../../src/character-generation/segmentation/partTaxonomy";
import type { ProposedCharacterPart } from "../../src/character-generation/segmentation/segmentationSchema";

const W = 40; const H = 40;
/** A source where every pixel has its own colour, so a copied or invented pixel can be told apart. */
const source = (covered: (x: number, y: number) => boolean) => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (covered(x, y)) data.set([x * 6, y * 6, 90, 255], (y * W + x) * 4);
  return { width: W, height: H, data };
};
const part = (id: string, semanticType: PartType, x: number, y: number, width: number, height: number, hole?: (x: number, y: number) => boolean): ProposedCharacterPart => ({
  id, name: id, semanticType, confidence: 1, confidenceSource: "heuristic", bounds: { x, y, width, height },
  mask: { width, height, alpha: Array.from({ length: width * height }, (_, index) => hole?.(x + index % width, y + Math.floor(index / width)) ? 0 : 255) },
  sourceImageRegion: { x, y, width, height }, suggestedBoneId: "", suggestedSlotId: "", suggestedZIndex: 0, pivotHint: { x: 0, y: 0 }, warnings: [], accepted: true, provenance: "manual",
});
/** Draws the filled parts back in rig order and returns the canvas. */
const composite = (parts: readonly ProposedCharacterPart[], filled: ReturnType<typeof fillPartArt>): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(W * H * 4);
  const order = parts.map((item, index) => ({ item, index })).sort((a, b) => estimateZIndex(a.item) - estimateZIndex(b.item) || a.index - b.index);
  for (const { item } of order) {
    const art = filled.find((candidate) => candidate.partId === item.id)!;
    for (let y = 0; y < art.image.height; y += 1) for (let x = 0; x < art.image.width; x += 1) {
      const from = (y * art.image.width + x) * 4; if (art.image.data[from + 3] === 0) continue;
      out.set(art.image.data.subarray(from, from + 4), ((art.bounds.y + y) * W + art.bounds.x + x) * 4);
    }
  }
  return out;
};

describe("gap filling for moving parts", () => {
  // An arm hanging down the left, a torso beside it, and a shield drawn in front of the torso.
  const inShield = (x: number, y: number): boolean => x >= 22 && x < 30 && y >= 12 && y < 22;
  const parts = [
    part("torso", "torso", 16, 4, 16, 24, inShield),
    part("upper", "leftUpperArm", 8, 4, 8, 12),
    part("fore", "leftForearm", 8, 16, 8, 12),
    part("shield", "offHandEquipment", 22, 12, 8, 10),
  ];
  const image = source((x, y) => (x >= 8 && x < 32 && y >= 4 && y < 28));
  const filled = fillPartArt(image, parts);
  const art = (id: string) => filled.find((candidate) => candidate.partId === id)!;

  it("leaves the character pixel-identical at rest", () => {
    expect(Array.from(composite(parts, filled))).toEqual(Array.from(image.data));
  });

  it("gives each jointed part a round cap of its neighbour's real pixels, centred on the seam", () => {
    const fore = art("fore"); const upper = art("upper");
    expect(fore.capPixels).toBeGreaterThan(10); expect(upper.capPixels).toBeGreaterThan(10);
    // The forearm's art now reaches up into the upper arm, and those pixels are the upper arm's own colours.
    expect(fore.bounds.y).toBeLessThan(16);
    const sample = (target: typeof fore, x: number, y: number): number[] => Array.from(target.image.data.subarray(((y - target.bounds.y) * target.image.width + (x - target.bounds.x)) * 4, ((y - target.bounds.y) * target.image.width + (x - target.bounds.x)) * 4 + 4));
    expect(sample(fore, 11, 14)).toEqual([66, 84, 90, 255]);
    // The cap is a disc, not a strip: its corners are left out so it cannot poke out when the joint turns.
    const seamY = 15.5; const seamX = 11.5; const radius = 4.5;
    for (let y = fore.bounds.y; y < 16; y += 1) for (let x = fore.bounds.x; x < fore.bounds.x + fore.bounds.width; x += 1) {
      if (sample(fore, x, y)[3] === 0) continue;
      expect(Math.hypot(x - seamX, y - seamY)).toBeLessThanOrEqual(radius + 1);
    }
  });

  it("paints the area of a part that is hidden under something drawn in front of it", () => {
    const torso = art("torso");
    expect(torso.filledPixels).toBe(80);
    // The fill completes the torso inside its own extent; it does not grow it past the shield.
    expect(torso.bounds.x + torso.bounds.width).toBe(32); expect(torso.bounds.y).toBe(4); expect(torso.bounds.height).toBe(24);
    const at = ((16 - torso.bounds.y) * torso.image.width + (25 - torso.bounds.x)) * 4;
    const pixel = Array.from(torso.image.data.subarray(at, at + 4));
    expect(pixel[3]).toBe(255);
    // The colour comes from the torso itself, not from the shield that covers it.
    expect(pixel.slice(0, 3)).not.toEqual([25 * 6, 16 * 6, 90]);
    // The shield, drawn in front, gets nothing from the torso behind it.
    expect(art("shield").filledPixels).toBe(0);
  });

  it("continues the part's own texture under the cover instead of smearing its edge into stripes", () => {
    const torso = art("torso");
    // The source shades left to right. Copying the edge pixel would give one colour across each covered row.
    const row = 16; const reds = new Set<number>();
    for (let x = 22; x < 30; x += 1) { const at = ((row - torso.bounds.y) * torso.image.width + (x - torso.bounds.x)) * 4; reds.add(torso.image.data[at]); }
    expect(reds.size).toBeGreaterThanOrEqual(4);
  });

  it("marks exactly the invented pixels, and a repaint replaces only those", () => {
    const torso = art("torso");
    expect(torso.filledMask.reduce((sum, value) => sum + (value ? 1 : 0), 0)).toBe(torso.filledPixels);
    // A repaint that returns solid magenta changes the hidden pixels and nothing the artist drew.
    const magenta = { width: torso.image.width, height: torso.image.height, data: new Uint8ClampedArray(torso.image.data.length).fill(255).map((value, index) => index % 4 === 1 ? 0 : value) };
    const merged = mergeRepaint(torso, magenta);
    for (let index = 0; index < torso.filledMask.length; index += 1) {
      const at = index * 4; const pixel = Array.from(merged.data.subarray(at, at + 4)); const original = Array.from(torso.image.data.subarray(at, at + 4));
      expect(pixel, `pixel ${index}`).toEqual(torso.filledMask[index] ? [255, 0, 255, 255] : original);
    }
    expect(repaintWorthwhile(torso)).toBe(false); // 80 px is a sliver: not worth a minute of model time
    expect(repaintWorthwhile({ filledPixels: 5000, bounds: { x: 0, y: 0, width: 200, height: 300 } })).toBe(true);
  });

  it("shows the repaint model the part with nothing in front of it", () => {
    const context = compositeBehind({ width: W, height: H }, parts, filled, "torso");
    const torso = art("torso");
    // Where the shield was, the model sees the torso's own fill, not the shield.
    const at = (16 * W + 25) * 4; const local = ((16 - torso.bounds.y) * torso.image.width + (25 - torso.bounds.x)) * 4;
    expect(Array.from(context.data.subarray(at, at + 4))).toEqual(Array.from(torso.image.data.subarray(local, local + 4)));
    // The shield itself is not drawn anywhere in the context.
    const shield = art("shield"); const shieldPixel = (12 * W + 29) * 4; const shieldLocal = ((12 - shield.bounds.y) * shield.image.width + (29 - shield.bounds.x)) * 4;
    expect(Array.from(context.data.subarray(shieldPixel, shieldPixel + 3))).not.toEqual(Array.from(shield.image.data.subarray(shieldLocal, shieldLocal + 3)));
  });

  it("does not cap the torso with a forearm that hangs against it while the upper arm exists", () => {
    // The forearm (x 8–15, y 16–27) touches the torso's side. Capping the torso with it would leave a copy of the forearm
    // on the body whenever the arm moves (seen on 48 px chibis).
    const torso = art("torso");
    for (let y = 16; y < 28; y += 1) for (let x = 8; x < 16; x += 1) {
      if (x < torso.bounds.x || y < torso.bounds.y || x >= torso.bounds.x + torso.bounds.width || y >= torso.bounds.y + torso.bounds.height) continue;
      expect(torso.image.data[((y - torso.bounds.y) * torso.image.width + (x - torso.bounds.x)) * 4 + 3], `${x},${y}`).toBe(0);
    }
  });

  it("still joins the torso and forearm when the upper arm is missing", () => {
    const skipped = fillPartArt(image, [part("torso", "torso", 16, 4, 16, 24), part("fore", "leftForearm", 8, 16, 8, 12)]);
    expect(skipped.find((candidate) => candidate.partId === "torso")!.capPixels).toBeGreaterThan(0);
  });

  it("does not join parts that merely touch", () => {
    // Torso and forearm are not a joint here, because the upper arm sits between them anatomically but they share an edge.
    const alone = fillPartArt(image, [part("torso", "torso", 16, 4, 16, 24), part("hand", "leftHand", 8, 4, 8, 24)]);
    expect(alone.every((candidate) => candidate.capPixels === 0)).toBe(true);
  });
});

describe("gap filling under a staff held across a robe", () => {
  // A mage: a robe (the torso, legs folded into it) with a staff lying diagonally across it from the hem to past the
  // shoulder. Cutting gave the staff's pixels to the staff, so the robe has a slash where it lay; raising the staff in
  // an attack must not open that slash.
  const onStaff = (x: number, y: number): boolean => Math.abs((x - 14) - (36 - y) * .6) < 2.2 && y >= 2 && y < 38;
  const inRobe = (x: number, y: number): boolean => x >= 10 && x < 30 && y >= 8 && y < 36;
  const parts = [
    part("robe", "torso", 10, 8, 20, 28, onStaff),
    part("staff", "mainHandEquipment", 12, 2, 26, 36, (x, y) => !onStaff(x, y)),
  ];
  const image = source((x, y) => inRobe(x, y) || onStaff(x, y));
  const filled = fillPartArt(image, parts);

  it("paints the robe under every pixel of the staff that lies inside the robe", () => {
    const robe = filled.find((candidate) => candidate.partId === "robe")!;
    const drawn = (x: number, y: number): boolean => {
      const lx = x - robe.bounds.x; const ly = y - robe.bounds.y;
      return lx >= 0 && ly >= 0 && lx < robe.image.width && ly < robe.image.height && robe.image.data[(ly * robe.image.width + lx) * 4 + 3] > 0;
    };
    let under = 0;
    for (let y = 8; y < 36; y += 1) for (let x = 11; x < 29; x += 1) if (onStaff(x, y)) { under += 1; expect(drawn(x, y), `robe missing at ${x},${y}`).toBe(true); }
    expect(under).toBeGreaterThan(40);
    // Not past the robe: the staff's ends beyond it are not painted as robe.
    expect(drawn(36, 3)).toBe(false);
  });
});

