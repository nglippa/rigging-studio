import { PNG } from "pngjs";
import type { Point } from "../../src/character-generation/segmentation/segmentationSchema";

const SCALE = 8;
const LABEL_HEIGHT = 48;
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
};
const set = (image: PNG, x: number, y: number, rgba: readonly number[]): void => { if (x < 0 || y < 0 || x >= image.width || y >= image.height) return; const offset = (y * image.width + x) * 4; image.data[offset] = rgba[0]; image.data[offset + 1] = rgba[1]; image.data[offset + 2] = rgba[2]; image.data[offset + 3] = rgba[3]; };
export function renderCandidateOverlay(source: PNG, candidate: readonly number[], anchors: readonly Point[], truth?: readonly number[], label?: string): Buffer {
  const labelHeight = label ? LABEL_HEIGHT : 0; const output = new PNG({ width: source.width * SCALE, height: source.height * SCALE + labelHeight });
  if (label) { for (let y = 0; y < labelHeight; y += 1) for (let x = 0; x < output.width; x += 1) set(output, x, y, [18, 22, 30, 255]); const glyph = GLYPHS[label]; glyph?.forEach((row, y) => [...row].forEach((pixel, x) => { if (pixel === "1") for (let sy = 0; sy < 5; sy += 1) for (let sx = 0; sx < 5; sx += 1) set(output, 12 + x * 5 + sx, 6 + y * 5 + sy, [255, 235, 90, 255]); })); }
  for (let y = 0; y < source.height; y += 1) for (let x = 0; x < source.width; x += 1) { const index = y * source.width + x; const sourceOffset = index * 4; const selected = candidate[index] > 0; const expected = (truth?.[index] ?? 0) > 0; const sourceAlpha = source.data[sourceOffset + 3] / 255; const checker = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 ? 34 : 48;
    const base = sourceAlpha ? [source.data[sourceOffset], source.data[sourceOffset + 1], source.data[sourceOffset + 2], 255] : [checker, checker, checker + 5, 255]; const color = selected ? [Math.round(base[0] * .45 + 45), Math.round(base[1] * .45 + 140), Math.round(base[2] * .45 + 65), 255] : expected ? [190, 55, 190, 255] : sourceAlpha ? [Math.round(base[0] * .38), Math.round(base[1] * .38), Math.round(base[2] * .38), 255] : base;
    const boundary = selected && ([index - 1, index + 1, index - source.width, index + source.width].some((next) => next < 0 || next >= candidate.length || !candidate[next]));
    for (let sy = 0; sy < SCALE; sy += 1) for (let sx = 0; sx < SCALE; sx += 1) set(output, x * SCALE + sx, labelHeight + y * SCALE + sy, boundary && (sx === 0 || sy === 0 || sx === SCALE - 1 || sy === SCALE - 1) ? [255, 225, 45, 255] : color);
  }
  anchors.forEach((anchor) => { const cx = Math.round((anchor.x + .5) * SCALE); const cy = labelHeight + Math.round((anchor.y + .5) * SCALE); for (let delta = -7; delta <= 7; delta += 1) { set(output, cx + delta, cy, [30, 225, 255, 255]); set(output, cx, cy + delta, [30, 225, 255, 255]); } }); return PNG.sync.write(output);
}
export function contactSheet(images: readonly Buffer[], columns = 3): Buffer { const decoded = images.map((image) => PNG.sync.read(image)); const cellWidth = Math.max(...decoded.map((image) => image.width)); const cellHeight = Math.max(...decoded.map((image) => image.height)); const output = new PNG({ width: cellWidth * columns, height: cellHeight * Math.ceil(decoded.length / columns) }); decoded.forEach((image, index) => { const column = index % columns; const row = Math.floor(index / columns); for (let y = 0; y < image.height; y += 1) image.data.copy(output.data, ((row * cellHeight + y) * output.width + column * cellWidth) * 4, y * image.width * 4, (y + 1) * image.width * 4); }); return PNG.sync.write(output); }
