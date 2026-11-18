import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { rotsprite, scale2x, snapAngle } from "../../src/rigging/rendering/rotsprite";

const load = (path: string) => { const png = PNG.sync.read(readFileSync(new URL(path, import.meta.url))); return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) }; };
const colours = (image: { data: Uint8ClampedArray }) => { const set = new Set<string>(); for (let i = 0; i < image.data.length; i += 4) if (image.data[i + 3] > 16) set.add(`${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`); return set; };
const opaque = (image: { data: Uint8ClampedArray }) => { let n = 0; for (let i = 3; i < image.data.length; i += 4) if (image.data[i] > 16) n += 1; return n; };

describe("RotSprite", () => {
  const sprite = load("../../public/benchmark/guided-manual/warrior.png");

  it("Scale2× doubles the image and adds no colours", () => {
    const big = scale2x(sprite);
    expect([big.width, big.height]).toEqual([sprite.width * 2, sprite.height * 2]);
    for (const colour of colours(big)) expect(colours(sprite).has(colour)).toBe(true);
  });

  it("a 0° rotation reproduces the sprite pixel for pixel around the pivot", () => {
    const pivot = { x: 24, y: 24 };
    const { image, pivot: centre } = rotsprite(sprite, 0, pivot);
    for (let y = 0; y < sprite.height; y += 1) for (let x = 0; x < sprite.width; x += 1) {
      const from = (y * sprite.width + x) * 4; const to = ((y - pivot.y + centre.y) * image.width + (x - pivot.x + centre.x)) * 4;
      expect([...image.data.slice(to, to + 4)]).toEqual([...sprite.data.slice(from, from + 4)]);
    }
  });

  it("rotating keeps the palette (no new colours) and about the same amount of artwork", () => {
    for (const angle of [15, 45, 90, 137]) {
      const { image } = rotsprite(sprite, angle, { x: 24, y: 30 });
      for (const colour of colours(image)) expect(colours(sprite).has(colour)).toBe(true);
      expect(Math.abs(opaque(image) - opaque(sprite)) / opaque(sprite)).toBeLessThan(.08);
    }
  });

  it("snaps angles to its pre-rendered steps", () => {
    expect(snapAngle(2.4)).toBe(0); expect(snapAngle(2.6)).toBe(5); expect(snapAngle(-7)).toBe(355); expect(snapAngle(362)).toBe(0);
  });
});
