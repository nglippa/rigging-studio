import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { characterPalette, polishInput, snapPolished } from "../../src/image-production/bake/polishDrawing";

/** A small native drawing: an outlined figure with two colours on a transparent canvas. */
function drawing() {
  const width = 40; const height = 50; const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 8; y < 44; y += 1) for (let x = 12; x < 28; x += 1) {
    const edge = y === 8 || y === 43 || x === 12 || x === 27; const colour = edge ? [20, 18, 24] : y < 20 ? [230, 190, 150] : [60, 90, 170];
    data.set([...colour, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

/** What the model would return: the input image, optionally shifted by some art pixels. */
function echo(png: Uint8Array, scale: number, shift = 0): Uint8Array {
  const image = PNG.sync.read(Buffer.from(png)); const out = new PNG({ width: image.width, height: image.height }); out.data.fill(255);
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    const sx = x - shift * scale; if (sx < 0 || sx >= image.width) continue;
    for (let c = 0; c < 4; c += 1) out.data[(y * image.width + x) * 4 + c] = image.data[(y * image.width + sx) * 4 + c];
  }
  return PNG.sync.write(out);
}

describe("hand-drawn polish: a redraw is made the character's own pixel art again", () => {
  it("lands a faithful redraw exactly on the rig's drawing, even when the model shifted it", () => {
    const original = drawing(); const palette = characterPalette([original]);
    const { png, crop } = polishInput(original, 4);
    for (const shift of [0, 2]) {
      const result = snapPolished(echo(png, 4, shift), crop, original, palette);
      expect(result.accepted).toBe(true);
      expect(result.overlap).toBeGreaterThan(.98);
      expect(Buffer.from(result.image.data).equals(Buffer.from(original.data))).toBe(true);
    }
  });

  it("refuses a redraw that changed the silhouette and keeps the rig's drawing", () => {
    const original = drawing(); const palette = characterPalette([original]);
    const { crop } = polishInput(original, 4);
    const wrong = new PNG({ width: crop.width * 4, height: crop.height * 4 }); wrong.data.fill(255);
    for (let y = 0; y < 40; y += 1) for (let x = 0; x < wrong.width; x += 1) wrong.data.set([60, 90, 170, 255], (y * wrong.width + x) * 4);
    const result = snapPolished(PNG.sync.write(wrong), crop, original, palette);
    expect(result.accepted).toBe(false);
    expect(result.image).toBe(original);
  });
});
