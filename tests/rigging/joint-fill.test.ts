import { describe, expect, it } from "vitest";
import { fillPartArt } from "../../src/character-generation/rigging/jointFill";
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

  it("does not join parts that merely touch", () => {
    // Torso and forearm are not a joint here, because the upper arm sits between them anatomically but they share an edge.
    const alone = fillPartArt(image, [part("torso", "torso", 16, 4, 16, 24), part("hand", "leftHand", 8, 4, 8, 24)]);
    expect(alone.every((candidate) => candidate.capPixels === 0)).toBe(true);
  });
});
