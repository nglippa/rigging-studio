import { PNG } from "pngjs";

/**
 * Removes a plain background from a generated character, without a model: the background colour is read from the
 * image border, every border-connected pixel close to it is made transparent (flood fill from the edges, as Animated
 * Drawings extracts a figure; body-segmentation skill ch01), and so are large enclosed pockets of it (the gap between an
 * arm and the body) when they are as flat as the background. Near-white art inside the outline (a blade's bevel) and
 * small spots (an eye shine) are kept. The pale anti-aliased halo along the outline is peeled off.
 *
 * Used when the engine has no background-removal model. Returns an RGBA PNG; an image whose border is not one plain
 * colour is returned unchanged (`removed` false), because guessing would eat the character.
 */
export function removePlainBackground(bytes: Uint8Array, options: { readonly tolerance?: number; readonly pocketShare?: number } = {}): { readonly bytes: Uint8Array; readonly removed: boolean } {
  const png = PNG.sync.read(Buffer.from(bytes)); const { width, height, data } = png; const count = width * height;
  const tolerance = options.tolerance ?? 60; const pocket = Math.max(16, Math.round(count * (options.pocketShare ?? .002)));
  // Background colour: the median of the border pixels, per channel.
  const border: number[] = [];
  for (let x = 0; x < width; x += 1) border.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y += 1) border.push(y * width, y * width + width - 1);
  const median = (channel: number) => { const values = border.map((index) => data[index * 4 + channel]).sort((a, b) => a - b); return values[values.length >> 1]; };
  const background = [median(0), median(1), median(2)];
  const near = (index: number) => Math.abs(data[index * 4] - background[0]) + Math.abs(data[index * 4 + 1] - background[1]) + Math.abs(data[index * 4 + 2] - background[2]) <= tolerance;
  // A plain background: nearly all of the border is that colour.
  if (border.filter(near).length < border.length * .9) return { bytes, removed: false };

  const clear = new Uint8Array(count);
  const fill = (starts: readonly number[]): number[] => {
    const queue = starts.filter((index) => !clear[index] && near(index)); for (const index of queue) clear[index] = 1;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]; const x = index % width; const y = (index - x) / width;
      for (const next of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) if (next >= 0 && !clear[next] && near(next)) { clear[next] = 1; queue.push(next); }
    }
    return queue;
  };
  fill(border);
  // Enclosed pockets of the background colour: cleared when large and as flat as the background itself (the gap between an
  // arm and the body). Near-white art inside the outline, such as a blade's bevel, varies by a few levels and is kept,
  // and so are small spots (an eye shine).
  const flatBackground = (pocketPixels: readonly number[]): boolean => {
    let spread = 0; let offset = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      let sum = 0; let squares = 0;
      for (const index of pocketPixels) { const value = data[index * 4 + channel]; sum += value; squares += value * value; }
      const mean = sum / pocketPixels.length;
      spread = Math.max(spread, Math.sqrt(Math.max(0, squares / pocketPixels.length - mean * mean))); offset = Math.max(offset, Math.abs(mean - background[channel]));
    }
    return spread <= 2.5 && offset <= 4;
  };
  const seen = new Uint8Array(count);
  for (let start = 0; start < count; start += 1) {
    if (clear[start] || seen[start] || !near(start)) continue;
    const queue = [start]; seen[start] = 1;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]; const x = index % width; const y = (index - x) / width;
      for (const next of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) if (next >= 0 && !seen[next] && !clear[next] && near(next)) { seen[next] = 1; queue.push(next); }
    }
    if (queue.length >= pocket && flatBackground(queue)) for (const index of queue) clear[index] = 1;
  }
  // The pale halo: anti-aliased pixels where the white background met the dark outline, too far from white for the
  // flood but much closer to it than the outline beside them. Peeled off, at most two pixels deep.
  const distance = (index: number) => Math.abs(data[index * 4] - background[0]) + Math.abs(data[index * 4 + 1] - background[1]) + Math.abs(data[index * 4 + 2] - background[2]);
  for (let pass = 0; pass < 2; pass += 1) {
    const peel: number[] = [];
    for (let index = 0; index < count; index += 1) {
      if (clear[index]) continue;
      const x = index % width; const y = (index - x) / width;
      if (!((x > 0 && clear[index - 1]) || (x + 1 < width && clear[index + 1]) || (y > 0 && clear[index - width]) || (y + 1 < height && clear[index + width]))) continue;
      let outline = 0;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
        const nx = x + dx; const ny = y + dy; if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx; if (!clear[next]) outline = Math.max(outline, distance(next));
      }
      if (outline >= 150 && distance(index) * 2 < outline) peel.push(index);
    }
    if (!peel.length) break;
    for (const index of peel) clear[index] = 1;
  }
  removeGroundShadow(data, width, height, clear);
  const out = new PNG({ width, height });
  for (let index = 0; index < count; index += 1) {
    out.data[index * 4] = data[index * 4]; out.data[index * 4 + 1] = data[index * 4 + 1]; out.data[index * 4 + 2] = data[index * 4 + 2];
    out.data[index * 4 + 3] = clear[index] ? 0 : (png.alpha === false ? 255 : data[index * 4 + 3]);
  }
  return { bytes: PNG.sync.write(out), removed: true };
}

/**
 * A floor shadow drawn under the feet: a flat grey patch with no outline, touching the background, at the bottom of the
 * figure. Left in, it is cut into the feet and slides around with them when they walk (no hand animator draws that). It is
 * cleared by flooding from the cleared background through grey, unsaturated pixels within the figure's bottom eighth; the
 * dark outline of boots or armour stops the flood, so grey boots are kept.
 */
function removeGroundShadow(data: Buffer | Uint8Array, width: number, height: number, clear: Uint8Array): void {
  let top = height; let bottom = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (!clear[y * width + x]) { if (y < top) top = y; if (y > bottom) bottom = y; }
  if (bottom < 0) return;
  const band = bottom - Math.round((bottom - top) / 8);
  const shadowy = (index: number) => {
    const r = data[index * 4]; const g = data[index * 4 + 1]; const b = data[index * 4 + 2];
    const lum = .299 * r + .587 * g + .114 * b; return Math.max(r, g, b) - Math.min(r, g, b) < 24 && lum > 90 && lum < 225;
  };
  const queue: number[] = [];
  for (let y = band; y <= bottom; y += 1) for (let x = 0; x < width; x += 1) {
    const index = y * width + x; if (clear[index] || !shadowy(index)) continue;
    if ((x > 0 && clear[index - 1]) || (x + 1 < width && clear[index + 1]) || (y > 0 && clear[index - width]) || (y + 1 < height && clear[index + width])) queue.push(index);
  }
  const taken = new Uint8Array(width * height); for (const index of queue) taken[index] = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]; const x = index % width; const y = (index - x) / width;
    for (const next of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > band ? index - width : -1, y < bottom ? index + width : -1]) {
      if (next >= 0 && !taken[next] && !clear[next] && shadowy(next)) { taken[next] = 1; queue.push(next); }
    }
  }
  for (const index of queue) clear[index] = 1;
}
