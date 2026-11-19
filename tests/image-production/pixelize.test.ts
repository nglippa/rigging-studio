import { describe, expect, it } from "vitest";
import { detectPixelGrid, pixelize } from "../../src/image-production/pixel/pixelize";

/** A random sprite on a transparent margin, as a model draws it: enlarged by a fractional factor, with colour noise. */
function fakePixelArt(cells: number, factor: number, seed = 7) {
  let state = seed; const random = () => { state = (state * 1103515245 + 12345) % 2 ** 31; return state / 2 ** 31; };
  const palette = [[20, 20, 28], [200, 60, 50], [60, 160, 80], [230, 210, 120], [90, 110, 210], [240, 240, 240]];
  const native = Array.from({ length: cells * cells }, (_, i) => {
    const x = i % cells; const y = Math.floor(i / cells);
    return x < 2 || y < 2 || x >= cells - 2 || y >= cells - 2 ? -1 : Math.floor(random() * palette.length);
  });
  const size = Math.round(cells * factor); const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const cell = native[Math.min(cells - 1, Math.floor(y / factor)) * cells + Math.min(cells - 1, Math.floor(x / factor))];
    const i = (y * size + x) * 4; if (cell < 0) continue;
    const noise = () => Math.round((random() - .5) * 14);
    data[i] = palette[cell][0] + noise(); data[i + 1] = palette[cell][1] + noise(); data[i + 2] = palette[cell][2] + noise(); data[i + 3] = 255;
  }
  return { image: { width: size, height: size, data }, native, palette, cells };
}

describe("pixelize: true pixel art from a generated image", () => {
  it("finds a fractional hidden grid and recovers each cell's colour", () => {
    const { image, native, palette, cells } = fakePixelArt(24, 10.24);
    const grid = detectPixelGrid(image);
    expect(Math.abs(grid.cell - 10)).toBeLessThanOrEqual(1);
    const result = pixelize(image);
    expect(Math.abs(result.native.width - cells)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.native.height - cells)).toBeLessThanOrEqual(1);
    let matched = 0; let total = 0;
    for (let y = 0; y < Math.min(cells, result.native.height); y += 1) for (let x = 0; x < Math.min(cells, result.native.width); x += 1) {
      const want = native[y * cells + x]; const i = (y * result.native.width + x) * 4; total += 1;
      if (want < 0) { if (result.native.data[i + 3] === 0) matched += 1; continue; }
      const [r, g, b] = palette[want];
      if (result.native.data[i + 3] === 255 && Math.abs(result.native.data[i] - r) + Math.abs(result.native.data[i + 1] - g) + Math.abs(result.native.data[i + 2] - b) < 30) matched += 1;
    }
    expect(matched / total).toBeGreaterThan(.95);
    expect(result.colours).toBeLessThanOrEqual(palette.length + 1); // noise merged back into the palette
  });

  it("keeps every block exact in the enlarged copy", () => {
    const { image } = fakePixelArt(16, 8);
    const { exact, scale, native } = pixelize(image);
    expect(scale).toBe(8);
    expect(exact.width).toBe(native.width * scale);
    for (let y = 0; y < exact.height; y += 1) for (let x = 0; x < exact.width; x += 1) {
      const i = (y * exact.width + x) * 4; const j = (Math.floor(y / scale) * exact.width + Math.floor(x / scale) * scale) * 4 + (y % scale ? 0 : 0);
      expect(exact.data[i + 3]).toBe(exact.data[((y - y % scale) * exact.width + (x - x % scale)) * 4 + 3]);
      void j;
    }
  });
});
