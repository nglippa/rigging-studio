/**
 * Turns "pixel-art-looking" generated images into true pixel art: finds the hidden grid the model drew its blocks on,
 * gives every cell one colour, and merges near-duplicate colours. The method follows proper-pixel-art (K. J. Allen) and
 * unfake.js: per-axis edge profiles, cell sizes judged by within-cell colour variance (which catches locking on to twice
 * the true size), and an elastic mesh whose lines snap to nearby edge peaks, because model
 * output is never exactly grid-aligned (Command Center's sprite benchmark: no model output was).
 */
import type { RgbaImage } from "../../rigging/rendering/rotsprite";

export type PixelGrid = { readonly cell: number; readonly xs: readonly number[]; readonly ys: readonly number[] };
export type PixelizeResult = {
  /** One pixel per cell. */
  readonly native: RgbaImage;
  /** The native image enlarged by `scale` with nearest-neighbour: same look, every block exact. */
  readonly exact: RgbaImage;
  readonly scale: number;
  readonly grid: PixelGrid;
  readonly colours: number;
};

const diff = (data: Uint8ClampedArray, a: number, b: number) =>
  Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]) + Math.abs(data[a + 3] - data[b + 3]) * 2;

/** How strongly colour changes across each vertical (axis "x") or horizontal (axis "y") line. */
function edgeProfile(image: RgbaImage, axis: "x" | "y"): Float64Array {
  const { width, height, data } = image; const length = axis === "x" ? width : height; const profile = new Float64Array(length);
  for (let y = axis === "y" ? 1 : 0; y < height; y += 1) for (let x = axis === "x" ? 1 : 0; x < width; x += 1) {
    const here = (y * width + x) * 4; const before = axis === "x" ? here - 4 : here - width * 4;
    profile[axis === "x" ? x : y] += diff(data, here, before);
  }
  return profile;
}

/**
 * Grid lines `cell` apart (fractional allowed), anchored on the first strong edge and stepped from each previous line, so
 * the mesh follows a grid that drifts. Each line snaps to a strong edge within a quarter cell, or stays where the step put
 * it when there is none (neighbouring blocks of one colour have no edge between them).
 */
function mesh(profile: Float64Array, cell: number): number[] {
  const n = profile.length; const sorted = [...profile].filter((value) => value > 0).sort((a, b) => b - a);
  const strong = (sorted[Math.floor(sorted.length * .1)] ?? 0) * .3; const reach = Math.max(1, Math.round(cell / 4));
  const anchor = profile.findIndex((value) => value >= strong && value > 0); if (anchor < 0) return [0, n];
  const snap = (ideal: number) => {
    let best = -1; let bestValue = strong;
    for (let at = Math.max(1, Math.round(ideal) - reach); at <= Math.min(n - 1, Math.round(ideal) + reach); at += 1) if (profile[at] >= bestValue) { bestValue = profile[at]; best = at; }
    return best >= 0 ? best : ideal;
  };
  const forward: number[] = [anchor]; for (let at = anchor; at + cell < n; ) { at = snap(at + cell); forward.push(at); }
  const backward: number[] = []; for (let at = anchor; at - cell > 0; ) { at = snap(at - cell); backward.unshift(at); }
  const lines = [0, ...backward, ...forward, n].map((value) => Math.round(value));
  return lines.filter((value, index) => index === 0 || value - lines[index - 1] >= Math.max(1, cell * .5) || value === n);
}

/** Mean squared colour spread inside the cells of a mesh: low when the mesh matches the blocks the image was drawn in. */
function cellVariance(image: RgbaImage, xs: readonly number[], ys: readonly number[]): number {
  const { width, data } = image; let total = 0; let count = 0;
  for (let row = 0; row + 1 < ys.length; row += 1) for (let column = 0; column + 1 < xs.length; column += 1) {
    const sum = [0, 0, 0, 0]; const squares = [0, 0, 0, 0]; let n = 0;
    // Inner pixels only: a cell's border pixels are where model blocks blur into each other.
    for (let y = ys[row] + 1; y < ys[row + 1] - 1; y += 1) for (let x = xs[column] + 1; x < xs[column + 1] - 1; x += 1) {
      const i = (y * width + x) * 4; for (let c = 0; c < 4; c += 1) { sum[c] += data[i + c]; squares[c] += data[i + c] ** 2; } n += 1;
    }
    if (n < 2) continue;
    for (let c = 0; c < 4; c += 1) total += squares[c] / n - (sum[c] / n) ** 2;
    count += 1;
  }
  return count ? total / count : Infinity;
}

/** The hidden pixel grid of an upscaled pixel-art image, or a 1-pixel grid when there is none. */
export function detectPixelGrid(image: RgbaImage, maxCell = 32): PixelGrid {
  const px = edgeProfile(image, "x"); const py = edgeProfile(image, "y");
  // Every cell size is tried. Any grid that divides the true blocks is as flat as the true grid (a half-size grid never
  // crosses a block edge), while a grid that is too coarse mixes blocks and its cells' colour spread jumps. So the answer is
  // the largest size whose spread is still close to the flattest (this is what catches locking on to twice the true size).
  const scored: { readonly grid: PixelGrid; readonly variance: number }[] = [];
  for (let cell = 2; cell <= maxCell; cell += .25) {
    const xs = mesh(px, cell); const ys = mesh(py, cell);
    if (xs.length < 4 || ys.length < 4) continue;
    scored.push({ grid: { cell, xs, ys }, variance: cellVariance(image, xs, ys) });
  }
  // Cells under 4 px hold too few inner pixels to judge (their spread reads low), so flatness is measured from 4 px up. A
  // picture with no flat grid at all is already at its true resolution.
  const flattest = Math.min(...scored.filter((entry) => entry.grid.cell >= 4).map((entry) => entry.variance));
  const native = { cell: 1, xs: Array.from({ length: image.width + 1 }, (_, i) => i), ys: Array.from({ length: image.height + 1 }, (_, i) => i) };
  if (!Number.isFinite(flattest) || flattest > 400) return native;

  // The mesh follows real edges, so a flat mesh's own line spacing is the true cell size even when the step that built it
  // was larger; a half-size grid spaces its lines half as far. The flat mesh with the widest spacing wins, re-meshed at it.
  const spacing = (lines: readonly number[]) => { const gaps = lines.slice(2, -1).map((line, index) => line - lines[index + 1]).sort((a, b) => a - b); return gaps.length ? gaps[gaps.length >> 1] : 0; };
  let widest = 0;
  for (const entry of scored) if (entry.grid.cell >= 4 && entry.variance <= flattest * 2 + 25) widest = Math.max(widest, (spacing(entry.grid.xs) + spacing(entry.grid.ys)) / 2);

  if (widest < 2) return native;
  // Refine the size to a quarter pixel: the one whose mesh is flattest near that spacing.
  let best = scored[0].grid; let bestVariance = Infinity;
  for (const entry of scored) if (Math.abs(entry.grid.cell - widest) <= 1 && entry.variance < bestVariance) { bestVariance = entry.variance; best = entry.grid; }
  return { ...best, cell: widest };
}

/** The colour most of a cell's inner pixels share (binned so model noise does not split it), averaged within its bin. */
function dominant(image: RgbaImage, x0: number, x1: number, y0: number, y1: number): [number, number, number, number] {
  const { width, data } = image; const bins = new Map<number, number[]>();
  const inset = (a: number, b: number) => b - a > 2 ? [a + 1, b - 1] : [a, b];
  const [ix0, ix1] = inset(x0, x1); const [iy0, iy1] = inset(y0, y1);
  let opaque = 0; let total = 0;
  for (let y = iy0; y < iy1; y += 1) for (let x = ix0; x < ix1; x += 1) {
    const i = (y * width + x) * 4; total += 1;
    if (data[i + 3] < 128) continue;
    opaque += 1;
    const bin = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const entry = bins.get(bin) ?? [0, 0, 0, 0]; entry[0] += data[i]; entry[1] += data[i + 1]; entry[2] += data[i + 2]; entry[3] += 1; bins.set(bin, entry);
  }
  if (opaque * 2 < total || !bins.size) return [0, 0, 0, 0];
  let top: number[] = [0, 0, 0, 0]; bins.forEach((entry) => { if (entry[3] > top[3]) top = entry; });
  return [Math.round(top[0] / top[3]), Math.round(top[1] / top[3]), Math.round(top[2] / top[3]), 255];
}

/** Merges colours closer than `cutoff` (sum of channel differences) into their most-used member. */
function mergeColours(native: RgbaImage, cutoff: number): number {
  const { data } = native; const counts = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) { const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]; counts.set(key, (counts.get(key) ?? 0) + 1); }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const kept: number[] = []; const map = new Map<number, number>();
  const distance = (a: number, b: number) => Math.abs((a >> 16) - (b >> 16)) + Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) + Math.abs((a & 255) - (b & 255));
  for (const colour of ordered) {
    const near = kept.find((other) => distance(colour, other) < cutoff);
    if (near === undefined) { kept.push(colour); map.set(colour, colour); } else map.set(colour, near);
  }
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) {
    const to = map.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])!;
    data[i] = to >> 16; data[i + 1] = (to >> 8) & 255; data[i + 2] = to & 255;
  }
  return kept.length;
}

/** Reduces the palette to at most `max` colours by repeatedly merging the closest pair into the more-used one. */
function limitPalette(native: RgbaImage, max: number): number {
  const { data } = native; const counts = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) { const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]; counts.set(key, (counts.get(key) ?? 0) + 1); }
  const colours = [...counts.entries()].map(([key, count]) => ({ key, count, to: key }));
  const distance = (a: number, b: number) => Math.abs((a >> 16) - (b >> 16)) + Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) + Math.abs((a & 255) - (b & 255));
  const alive = colours.slice();
  while (alive.length > max) {
    let bestI = 0; let bestJ = 1; let bestCost = Infinity;
    for (let i = 0; i < alive.length; i += 1) for (let j = i + 1; j < alive.length; j += 1) {
      // Rare colours merge first: a cost of distance weighted by the smaller colour's use.
      const cost = distance(alive[i].key, alive[j].key) * Math.min(alive[i].count, alive[j].count);
      if (cost < bestCost) { bestCost = cost; bestI = i; bestJ = j; }
    }
    const [keep, drop] = alive[bestI].count >= alive[bestJ].count ? [alive[bestI], alive[bestJ]] : [alive[bestJ], alive[bestI]];
    keep.count += drop.count; for (const colour of colours) if (colour.to === drop.key) colour.to = keep.key;
    alive.splice(alive.indexOf(drop), 1);
  }
  const map = new Map(colours.map((colour) => [colour.key, colour.to]));
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) { const to = map.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])!; data[i] = to >> 16; data[i + 1] = (to >> 8) & 255; data[i + 2] = to & 255; }
  return alive.length;
}

/** Removes specks: drawn pixels touching fewer than two other drawn pixels (eight-neighbourhood). */
function despeckle(native: RgbaImage): void {
  const { width, height, data } = native; const remove: number[] = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (!data[(y * width + x) * 4 + 3]) continue;
    let around = 0;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      if (!dx && !dy) continue; const nx = x + dx; const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height && data[(ny * width + nx) * 4 + 3]) around += 1;
    }
    if (around < 2) remove.push((y * width + x) * 4);
  }
  for (const at of remove) data.fill(0, at, at + 4);
}

/**
 * True pixel art from an upscaled-looking image. `scale` (default: the detected cell, rounded) sets how large the exact
 * copy is drawn; the exact copy starts at the grid's first line, so it is `columns * scale` by `rows * scale`.
 */
export function pixelize(image: RgbaImage, options: { readonly scale?: number; readonly colourCutoff?: number; readonly maxColours?: number; readonly grid?: PixelGrid } = {}): PixelizeResult {
  const grid = options.grid ?? detectPixelGrid(image);
  const columns = grid.xs.length - 1; const rows = grid.ys.length - 1;
  const native = { width: columns, height: rows, data: new Uint8ClampedArray(columns * rows * 4) };
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    native.data.set(dominant(image, grid.xs[column], grid.xs[column + 1], grid.ys[row], grid.ys[row + 1]), (row * columns + column) * 4);
  }
  despeckle(native);
  mergeColours(native, options.colourCutoff ?? 24);
  const colours = limitPalette(native, options.maxColours ?? 32);
  // Drawn back at about the source's size: model grids are irregular, so the average cell sets it, not the typical one.
  const scale = options.scale ?? Math.max(1, Math.round(image.width / columns));
  const exact = { width: columns * scale, height: rows * scale, data: new Uint8ClampedArray(columns * scale * rows * scale * 4) };
  for (let y = 0; y < exact.height; y += 1) for (let x = 0; x < exact.width; x += 1) {
    const from = (Math.floor(y / scale) * columns + Math.floor(x / scale)) * 4; const to = (y * exact.width + x) * 4;
    exact.data[to] = native.data[from]; exact.data[to + 1] = native.data[from + 1]; exact.data[to + 2] = native.data[from + 2]; exact.data[to + 3] = native.data[from + 3];
  }
  return { native, exact, scale, grid, colours };
}
