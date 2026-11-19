/**
 * Measures how a sprite animation differs from hand-drawn pixel animation, on the frames a game would display. Each metric
 * is one of the tells named by pixel-art practice and by the 3D-to-pixel pipelines built to hide them (Pixor, "3D to pixel
 * art"; Motion Twin, "Using a 3D pipeline for 2D animation in Dead Cells"; Azzi, "Pixel Logic", rotated mixels):
 *
 *   offGrid     share of colour edges that fall off the art's own pixel grid (mixed or rotated pixel sizes, "mixels")
 *   newColours  share of drawn pixels whose colour the still drawing does not use (resampling blends, smoothing)
 *   flicker     specks that appear for a single drawing and vanish (per 1,000 drawn pixels); moving shapes are not specks
 *   strays      lone pixels belonging to no shape, beyond those the still drawing itself has (per 1,000 drawn pixels)
 *   gaps        see-through cracks inside the figure that the still drawing does not have (per 1,000 drawn pixels);
 *               small slivers only, since large enclosed areas are negative space between shapes
 *   drawingsPerSecond, holdVariation   timing: hand animation shows a few drawings per second, and attacks hold their
 *               extremes (varied hold lengths); sampled motion changes every display tick at an even pace
 *
 * Hand-drawn references score near zero on the first five and set the timing range (tests/fixtures/handdrawn).
 */
import type { RgbaImage } from "../rendering/rotsprite";

export type BenchScores = {
  readonly pixelSize: number;
  readonly offGrid: number;
  readonly newColours: number;
  readonly flicker: number;
  readonly strays: number;
  readonly gaps: number;
  readonly drawings: number;
  readonly drawingsPerSecond: number;
  readonly holdVariation: number;
};

const key = (data: Uint8ClampedArray, index: number) => data[index * 4 + 3] < 128 ? -1 : (data[index * 4] << 16) | (data[index * 4 + 1] << 8) | data[index * 4 + 2];
const opaque = (frame: RgbaImage) => { let count = 0; for (let i = 3; i < frame.data.length; i += 4) if (frame.data[i] >= 128) count += 1; return count; };
const sameFrame = (a: RgbaImage, b: RgbaImage) => { if (a.width !== b.width || a.height !== b.height) return false; for (let i = 0; i < a.data.length; i += 1) if (a.data[i] !== b.data[i]) return false; return true; };

/**
 * The art's pixel size: hand-drawn art and AI "pixel art" alike are drawn in square blocks of one colour. The largest block
 * size that most colour runs are a multiple of (1 for true native-resolution art).
 */
export function artPixelSize(frame: RgbaImage, max = 16): number {
  const runs = new Map<number, number>(); let total = 0;
  for (let y = 0; y < frame.height; y += 1) {
    let start = 0;
    for (let x = 1; x <= frame.width; x += 1) {
      const changed = x === frame.width || key(frame.data, y * frame.width + x) !== key(frame.data, y * frame.width + x - 1);
      if (!changed) continue;
      if (key(frame.data, y * frame.width + start) !== -1) { const length = x - start; runs.set(length, (runs.get(length) ?? 0) + length); total += length; }
      start = x;
    }
  }
  for (let size = max; size > 1; size -= 1) {
    let multiple = 0; runs.forEach((weight, length) => { if (length % size === 0) multiple += weight; });
    if (total && multiple / total >= .9) return size; // an upscaled sprite: (nearly) every run is a whole number of blocks
  }
  return 1;
}

/** Where the grid lines fall (0..size-1), from the most common position of colour edges along rows. */
function gridPhase(frame: RgbaImage, size: number): number {
  const counts = new Array(size).fill(0);
  for (let y = 0; y < frame.height; y += 1) for (let x = 1; x < frame.width; x += 1) if (key(frame.data, y * frame.width + x) !== key(frame.data, y * frame.width + x - 1)) counts[x % size] += 1;
  return counts.indexOf(Math.max(...counts));
}

/** Share of colour edges (along rows and columns) that do not fall on the grid. */
function offGridShare(frame: RgbaImage, size: number, phaseX: number, phaseY: number): number {
  if (size <= 1) return 0;
  let edges = 0; let off = 0;
  for (let y = 0; y < frame.height; y += 1) for (let x = 1; x < frame.width; x += 1) {
    if (key(frame.data, y * frame.width + x) === key(frame.data, y * frame.width + x - 1)) continue;
    edges += 1; if (x % size !== phaseX) off += 1;
  }
  for (let x = 0; x < frame.width; x += 1) for (let y = 1; y < frame.height; y += 1) {
    if (key(frame.data, y * frame.width + x) === key(frame.data, (y - 1) * frame.width + x)) continue;
    edges += 1; if (y % size !== phaseY) off += 1;
  }
  return edges ? off / edges : 0;
}

/** Lone pixels: drawn, with no same-coloured pixel among their eight neighbours. */
function strayCount(frame: RgbaImage): number {
  let count = 0;
  for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
    const here = key(frame.data, y * frame.width + x); if (here === -1) continue;
    let alone = true;
    for (let dy = -1; dy <= 1 && alone; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      if (!dx && !dy) continue; const nx = x + dx; const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < frame.width && ny < frame.height && key(frame.data, ny * frame.width + nx) === here) { alone = false; break; }
    }
    if (alone) count += 1;
  }
  return count;
}

/** See-through pixels enclosed by the figure (not connected to the frame border through transparency). */
function enclosedHoles(frame: RgbaImage): number {
  const { width, height } = frame; const outside = new Uint8Array(width * height); const queue: number[] = [];
  const push = (index: number) => { if (!outside[index] && frame.data[index * 4 + 3] < 128) { outside[index] = 1; queue.push(index); } };
  for (let x = 0; x < width; x += 1) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { push(y * width); push(y * width + width - 1); }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]; const x = index % width; const y = (index - x) / width;
    if (x > 0) push(index - 1); if (x + 1 < width) push(index + 1); if (y > 0) push(index - width); if (y + 1 < height) push(index + width);
  }
  // Cracks only: a joint opening is a small sliver. Large enclosed regions are negative space between shapes (a staff
  // held away from the face), which hand-drawn figures have too.
  let drawn = 0; for (let i = 3; i < frame.data.length; i += 4) if (frame.data[i] >= 128) drawn += 1;
  const limit = Math.max(4, drawn * .006); const seen = new Uint8Array(width * height); let holes = 0;
  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] || outside[start] || frame.data[start * 4 + 3] >= 128) continue;
    const component = [start]; seen[start] = 1;
    for (let cursor = 0; cursor < component.length; cursor += 1) {
      const index = component[cursor]; const x = index % width; const y = (index - x) / width;
      for (const next of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) if (next >= 0 && !seen[next] && !outside[next] && frame.data[next * 4 + 3] < 128) { seen[next] = 1; component.push(next); }
    }
    if (component.length <= limit) holes += component.length;
  }
  return holes;
}

/** Collapses identical consecutive display frames into drawings with how many ticks each is shown. */
export function drawingsOf(frames: readonly RgbaImage[]): { readonly drawings: RgbaImage[]; readonly holds: number[] } {
  const drawings: RgbaImage[] = []; const holds: number[] = [];
  for (const frame of frames) {
    if (drawings.length && sameFrame(drawings[drawings.length - 1], frame)) holds[holds.length - 1] += 1;
    else { drawings.push(frame); holds.push(1); }
  }
  return { drawings, holds };
}

/**
 * Scores one animation. `frames` is what the game displays, one per tick at `fps`; `still` is the character's own still
 * drawing (the source art, or the first frame of a hand-drawn clip), which sets its grid, palette, strays and holes.
 */
export function scoreAnimation(frames: readonly RgbaImage[], fps: number, still: RgbaImage): BenchScores {
  const pixelSize = artPixelSize(still);
  const phaseX = gridPhase(still, pixelSize);
  const transposed = { width: still.height, height: still.width, data: new Uint8ClampedArray(still.data.length) };
  for (let y = 0; y < still.height; y += 1) for (let x = 0; x < still.width; x += 1) transposed.data.set(still.data.subarray((y * still.width + x) * 4, (y * still.width + x) * 4 + 4), (x * still.height + y) * 4);
  const phaseY = gridPhase(transposed, pixelSize);
  const palette = new Set<number>(); for (let i = 0; i < still.width * still.height; i += 1) { const k = key(still.data, i); if (k !== -1) palette.add(k); }
  const stillStrays = strayCount(still) / Math.max(1, opaque(still)); const stillHoles = enclosedHoles(still) / Math.max(1, opaque(still));
  const { drawings, holds } = drawingsOf(frames);

  let offGrid = 0; let drawn = 0; let foreign = 0; let strays = 0; let holes = 0;
  for (const drawing of drawings) {
    offGrid += offGridShare(drawing, pixelSize, phaseX, phaseY);
    const area = opaque(drawing); drawn += area;
    for (let i = 0; i < drawing.width * drawing.height; i += 1) { const k = key(drawing.data, i); if (k !== -1 && !palette.has(k)) foreign += 1; }
    strays += Math.max(0, strayCount(drawing) / Math.max(1, area) - stillStrays);
    holes += Math.max(0, enclosedHoles(drawing) / Math.max(1, area) - stillHoles);
  }
  // Flicker: a pixel that differs from the drawings on both sides while those two agree (it appears for one drawing only).
  // Moving shapes change whole areas for a drawing; flicker is a speck: at most two such pixels touching (at art-pixel scale).
  let blips = 0;
  for (let index = 1; index + 1 < drawings.length; index += 1) {
    const [before, now, after] = [drawings[index - 1], drawings[index], drawings[index + 1]];
    if (before.width !== now.width || after.width !== now.width) continue;
    const { width, height } = now; const changed = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i += 1) { const b = key(before.data, i); if (b === key(after.data, i) && key(now.data, i) !== b) changed[i] = 1; }
    const reach = pixelSize; const limit = 2 * pixelSize * pixelSize;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      if (!changed[y * width + x]) continue;
      let around = 0;
      for (let dy = -reach; dy <= reach; dy += 1) for (let dx = -reach; dx <= reach; dx += 1) {
        const nx = x + dx; const ny = y + dy; if (nx >= 0 && ny >= 0 && nx < width && ny < height && changed[ny * width + nx]) around += 1;
      }
      if (around > limit) continue;
      // Motion, not flicker: the same colour sits within four art pixels in the drawing before (the edge of a part that
      // moved). Flicker is a colour that appears for one drawing with nowhere it could have come from.
      const here = key(now.data, y * width + x); const radius = 4 * pixelSize; let explained = false;
      for (let dy = -radius; dy <= radius && !explained; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
        const nx = x + dx; const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && key(before.data, ny * width + nx) === here) { explained = true; break; }
      }
      if (!explained) blips += 1;
    }
  }
  const seconds = frames.length / fps;
  const mean = holds.reduce((sum, value) => sum + value, 0) / holds.length;
  const deviation = Math.sqrt(holds.reduce((sum, value) => sum + (value - mean) ** 2, 0) / holds.length);
  return {
    pixelSize,
    offGrid: offGrid / drawings.length,
    newColours: foreign / Math.max(1, drawn),
    flicker: blips / Math.max(1, drawn) * 1000,
    strays: strays / drawings.length * 1000,
    gaps: holes / drawings.length * 1000,
    drawings: drawings.length,
    drawingsPerSecond: drawings.length / seconds,
    holdVariation: mean ? deviation / mean : 0,
  };
}
