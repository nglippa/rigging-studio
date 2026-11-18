/**
 * RotSprite (Xenowhirl; described in Wikipedia, "Pixel-art scaling algorithms"): rotates pixel art without blurring it and
 * without the broken lines of plain nearest-neighbour rotation, and never introduces a colour the sprite did not have.
 *
 *   1. Scale up 8× with Scale2× applied three times, treating similar colours as equal, so edges become smooth staircases.
 *   2. Rotate and shrink back to the original pixel size in one nearest-neighbour pass.
 *
 * (The optional offset search and single-pixel restoration steps of the original are left out.) Pure array code: the
 * renderer calls it once per part and angle and caches the result. See the human-motion-rigging skill, ch09.
 */
export type RgbaImage = { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray };

/** Colours closer than this (sum of channel differences, alpha included) count as the same for edge matching. */
const SIMILAR = 48;

const same = (data: Uint8ClampedArray, a: number, b: number): boolean => {
  if (data[a + 3] < 16 && data[b + 3] < 16) return true;
  return Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]) + Math.abs(data[a + 3] - data[b + 3]) < SIMILAR;
};

/** One Scale2× (EPX) pass with similar-colour matching: each pixel becomes four, rounding off diagonal staircases. */
export function scale2x(image: RgbaImage): RgbaImage {
  const { width, height, data } = image; const out = new Uint8ClampedArray(width * height * 16);
  const at = (x: number, y: number) => ((Math.min(height - 1, Math.max(0, y)) * width) + Math.min(width - 1, Math.max(0, x))) * 4;
  const put = (x: number, y: number, from: number) => { const to = (y * width * 2 + x) * 4; out[to] = data[from]; out[to + 1] = data[from + 1]; out[to + 2] = data[from + 2]; out[to + 3] = data[from + 3]; };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const p = at(x, y); const a = at(x, y - 1); const b = at(x + 1, y); const c = at(x - 1, y); const d = at(x, y + 1);
    put(x * 2, y * 2, same(data, c, a) && !same(data, c, d) && !same(data, a, b) ? a : p);
    put(x * 2 + 1, y * 2, same(data, a, b) && !same(data, a, c) && !same(data, b, d) ? b : p);
    put(x * 2, y * 2 + 1, same(data, d, c) && !same(data, d, b) && !same(data, c, a) ? c : p);
    put(x * 2 + 1, y * 2 + 1, same(data, b, d) && !same(data, b, a) && !same(data, d, c) ? d : p);
  }
  return { width: width * 2, height: height * 2, data: out };
}

/**
 * The sprite rotated by `degrees` about `pivot` (in source pixels), on a canvas large enough to hold every rotation, with
 * the pivot at its centre. Returns the image and where the pivot lies in it.
 */
export function rotsprite(image: RgbaImage, degrees: number, pivot: { readonly x: number; readonly y: number }): { readonly image: RgbaImage; readonly pivot: { readonly x: number; readonly y: number } } {
  const quarter = ((Math.round(degrees) % 360) + 360) % 360;
  // Quarter turns need no resampling at all: copy pixels exactly. Scale2× reshapes the corners of each enlarged pixel,
  // so sampling it at 0° would change pixels that should not change.
  const exact = quarter % 90 === 0 && Math.abs(degrees - Math.round(degrees)) < 1e-9;
  const big = exact ? null : scale2x(scale2x(scale2x(image)));
  const radius = Math.ceil(Math.max(
    Math.hypot(pivot.x, pivot.y), Math.hypot(image.width - pivot.x, pivot.y),
    Math.hypot(pivot.x, image.height - pivot.y), Math.hypot(image.width - pivot.x, image.height - pivot.y),
  )) + 1;
  const size = radius * 2; const out = new Uint8ClampedArray(size * size * 4);
  const angle = -degrees * Math.PI / 180; const cos = Math.cos(angle); const sin = Math.sin(angle);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    // Centre of the destination pixel, relative to the pivot, rotated back into the source and read from the 8× image.
    const dx = x + .5 - radius; const dy = y + .5 - radius;
    const rx = dx * cos - dy * sin + pivot.x; const ry = dx * sin + dy * cos + pivot.y;
    const source = big ?? image; const scale = big ? 8 : 1;
    const ix = Math.floor(rx * scale); const iy = Math.floor(ry * scale);
    if (ix < 0 || iy < 0 || ix >= source.width || iy >= source.height) continue;
    const from = (iy * source.width + ix) * 4; const to = (y * size + x) * 4;
    out[to] = source.data[from]; out[to + 1] = source.data[from + 1]; out[to + 2] = source.data[from + 2]; out[to + 3] = source.data[from + 3];
  }
  return { image: { width: size, height: size, data: out }, pivot: { x: radius, y: radius } };
}

/** Rotations are pre-rendered at this step (degrees) and the nearest is shown. */
export const ROTSPRITE_STEP = 5;
export const snapAngle = (degrees: number): number => {
  const snapped = Math.round(degrees / ROTSPRITE_STEP) * ROTSPRITE_STEP;
  return ((snapped % 360) + 360) % 360;
};
