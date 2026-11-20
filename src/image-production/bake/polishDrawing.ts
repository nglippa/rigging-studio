/**
 * "Hand-drawn polish": one drawing of a rigged animation redrawn by the Studio's image model, then made the character's own
 * pixel art again. A rig moves art but cannot redraw it, so its drawings keep every part pixel-identical while it turns, with
 * seams where parts meet; a frame-by-frame artist redraws the whole figure each time. Following the 3D-to-pixel pipelines
 * (Motion Twin's Dead Cells, Pixor: render a clean base, then touch up each frame), the rig's drawing is the base and the
 * model is the touch-up: Klein 4B with the consistency LoRA (Command Center's klein2-4b-consistency profile), which keeps a
 * character and pose while restoring detail.
 *
 * The result is forced back onto the character's terms so it still matches every other drawing: the same art-pixel grid,
 * the character's own palette, and the same registration as the rig's drawing (feet and pivot do not jitter). A redraw that
 * changes the silhouette too much is refused and the rig's drawing kept, so a model mistake never reaches the sheet.
 */
import { PNG } from "pngjs";
import type { RgbaImage } from "../../rigging/rendering/rotsprite";
import { removePlainBackground } from "../profiles/plainBackground";

export const POLISH_PROMPT = "Redraw this exact pixel art game character in exactly this pose. Keep the same character design, proportions, colours, outfit and held items. Clean, consistent pixel art with crisp single-pixel dark outlines; repair any broken lines, gaps or seams between body parts so it looks drawn by hand as one figure. Plain white background, no shadow, no new objects.";

export type PolishPalette = readonly (readonly [number, number, number])[];
export type PolishOutcome = { readonly image: RgbaImage; readonly accepted: boolean; readonly overlap: number; readonly reason?: string };

/** The drawing cropped to its figure with a margin, enlarged `scale` times on white: what the model is shown. */
export function polishInput(native: RgbaImage, scale: number, margin = 6): { readonly png: Uint8Array; readonly crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } } {
  let x0 = native.width; let y0 = native.height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < native.height; y += 1) for (let x = 0; x < native.width; x += 1) if (native.data[(y * native.width + x) * 4 + 3] >= 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = native.width - 1; y1 = native.height - 1; }
  const crop = { x: x0 - margin, y: y0 - margin, width: x1 - x0 + 1 + margin * 2, height: y1 - y0 + 1 + margin * 2 };
  const out = new PNG({ width: crop.width * scale, height: crop.height * scale }); out.data.fill(255);
  for (let y = 0; y < out.height; y += 1) for (let x = 0; x < out.width; x += 1) {
    const sx = crop.x + Math.floor(x / scale); const sy = crop.y + Math.floor(y / scale);
    if (sx < 0 || sy < 0 || sx >= native.width || sy >= native.height) continue;
    const from = (sy * native.width + sx) * 4; if (native.data[from + 3] < 128) continue;
    const to = (y * out.width + x) * 4; out.data[to] = native.data[from]; out.data[to + 1] = native.data[from + 1]; out.data[to + 2] = native.data[from + 2];
  }
  return { png: PNG.sync.write(out), crop };
}

/** The colours a character is drawn with (its rig's parts), at most `max`, most used first. */
export function characterPalette(images: readonly RgbaImage[], max = 256): PolishPalette {
  // Near-identical shades are grouped first (5 bits a channel) and each group stands for its most common member. True
  // pixel art keeps its exact colours; an anti-aliased sprite has hundreds of shades, and counted one by one, a small
  // area such as the skin had no shade common enough to make the palette, so faces snapped to the nearest gold.
  const groups = new Map<number, { count: number; members: Map<number, number> }>();
  for (const image of images) for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] < 128) continue;
    const exact = (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2];
    const key = ((image.data[i] >> 3) << 10) | ((image.data[i + 1] >> 3) << 5) | (image.data[i + 2] >> 3);
    const group = groups.get(key) ?? { count: 0, members: new Map<number, number>() }; group.count += 1; group.members.set(exact, (group.members.get(exact) ?? 0) + 1); groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, max).map((group) => {
    const exact = [...group.members.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return [exact >> 16, (exact >> 8) & 255, exact & 255] as const;
  });
}

const nearest = (palette: PolishPalette, r: number, g: number, b: number): readonly [number, number, number] => {
  let best = palette[0] ?? [r, g, b] as const; let distance = Infinity;
  for (const colour of palette) { const d = 2 * (colour[0] - r) ** 2 + 4 * (colour[1] - g) ** 2 + 3 * (colour[2] - b) ** 2; if (d < distance) { distance = d; best = colour; } }
  return best;
};

/**
 * The model's output made the character's pixel art again: background removed, one colour per art pixel on the input's
 * grid (each cell's most common colour), the character's palette, then shifted to line up with the rig's drawing.
 */
export function snapPolished(outputPng: Uint8Array, crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, original: RgbaImage, palette: PolishPalette, minOverlap = .8): PolishOutcome {
  const cut = removePlainBackground(outputPng);
  const png = PNG.sync.read(Buffer.from(cut.bytes));
  // One art pixel per cell: the output covers the same crop, so a cell is output size / crop size (the model may resize).
  const cellX = png.width / crop.width; const cellY = png.height / crop.height;
  const cells = new Uint8ClampedArray(crop.width * crop.height * 4);
  for (let cy = 0; cy < crop.height; cy += 1) for (let cx = 0; cx < crop.width; cx += 1) {
    const x0 = Math.floor(cx * cellX); const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * cellX)); const y0 = Math.floor(cy * cellY); const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * cellY));
    const votes = new Map<number, number>(); let opaque = 0; let total = 0;
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
      const i = (y * png.width + x) * 4; total += 1; if (png.data[i + 3] < 128) continue; opaque += 1;
      const [r, g, b] = nearest(palette, png.data[i], png.data[i + 1], png.data[i + 2]); const key = (r << 16) | (g << 8) | b; votes.set(key, (votes.get(key) ?? 0) + 1);
    }
    if (opaque * 2 < total) continue;
    let key = 0; let most = 0; votes.forEach((count, colour) => { if (count > most) { most = count; key = colour; } });
    const to = (cy * crop.width + cx) * 4; cells[to] = key >> 16; cells[to + 1] = (key >> 8) & 255; cells[to + 2] = key & 255; cells[to + 3] = 255;
  }
  // Registration: the shift (within 4 art pixels) that best overlaps the rig's drawing, so the figure does not jitter.
  const originalAt = (x: number, y: number) => x >= 0 && y >= 0 && x < original.width && y < original.height && original.data[(y * original.width + x) * 4 + 3] >= 128;
  let bestShift = { dx: 0, dy: 0 }; let bestOverlap = -1;
  let originalArea = 0; for (let i = 3; i < original.data.length; i += 4) if (original.data[i] >= 128) originalArea += 1;
  for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) {
    let both = 0; let either = originalArea;
    for (let cy = 0; cy < crop.height; cy += 1) for (let cx = 0; cx < crop.width; cx += 1) {
      if (!cells[(cy * crop.width + cx) * 4 + 3]) continue;
      if (originalAt(crop.x + cx + dx, crop.y + cy + dy)) both += 1; else either += 1;
    }
    const overlap = either ? both / either : 0;
    if (overlap > bestOverlap) { bestOverlap = overlap; bestShift = { dx, dy }; }
  }
  if (bestOverlap < minOverlap) return { image: original, accepted: false, overlap: bestOverlap, reason: `the redraw changed the silhouette (overlap ${bestOverlap.toFixed(2)})` };
  const data = new Uint8ClampedArray(original.width * original.height * 4);
  for (let cy = 0; cy < crop.height; cy += 1) for (let cx = 0; cx < crop.width; cx += 1) {
    const from = (cy * crop.width + cx) * 4; if (!cells[from + 3]) continue;
    const x = crop.x + cx + bestShift.dx; const y = crop.y + cy + bestShift.dy; if (x < 0 || y < 0 || x >= original.width || y >= original.height) continue;
    data.set(cells.subarray(from, from + 4), (y * original.width + x) * 4);
  }
  return { image: { width: original.width, height: original.height, data }, accepted: true, overlap: bestOverlap };
}
