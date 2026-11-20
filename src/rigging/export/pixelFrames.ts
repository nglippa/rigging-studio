/**
 * Renders a rig's frames on the CPU exactly as the game renderer draws them (RigRenderer). Pixel-art rigs: parts on whole
 * pixels, rotated parts drawn with RotSprite at the nearest 5° step, stretched parts sampled nearest-neighbour, slot tints
 * multiplied in. Other rigs: bilinear sampling at sub-pixel positions, as the GPU does. Pure array code, so it runs in Node
 * (the hand-drawn bench, sprite-sheet export) and in the browser.
 */
import { drawingTime, evaluateAnimationAtTime } from "../animation/evaluate";
import { matrixFromTransform, multiplyMatrices } from "../math/matrix";
import { degreesToRadians } from "../math/rotation";
import { createRestPose } from "../runtime/pose";
import { resolveSlots } from "../runtime/slots";
import type { RigPose } from "../runtime/types";
import { computeWorldTransforms } from "../runtime/worldTransforms";
import { rotsprite, snapAngle, type RgbaImage } from "../rendering/rotsprite";
import type { AnimationDefinition, RigDefinition } from "../schema/types";

export type PartPixels = Readonly<Record<string, RgbaImage>>;
export type FrameWindow = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

type Matrix = { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly tx: number; readonly ty: number };

/** Draws `source` over `target` where it is opaque enough, multiplying by `tint` (0xRRGGBB). */
function blit(target: Uint8ClampedArray, window: FrameWindow, source: RgbaImage, left: number, top: number, tint: number, palette?: Palette): void {
  const tr = ((tint >> 16) & 255) / 255; const tg = ((tint >> 8) & 255) / 255; const tb = (tint & 255) / 255;
  const snap = tint !== 0xffffff && palette;
  for (let y = 0; y < source.height; y += 1) {
    const ty = top + y - window.y; if (ty < 0 || ty >= window.height) continue;
    for (let x = 0; x < source.width; x += 1) {
      const tx = left + x - window.x; if (tx < 0 || tx >= window.width) continue;
      const from = (y * source.width + x) * 4; const alpha = source.data[from + 3];
      if (alpha < 128) continue; // pixel art is drawn with hard edges: a pixel is there or it is not
      const to = (ty * window.width + tx) * 4;
      target[to] = Math.round(source.data[from] * tr); target[to + 1] = Math.round(source.data[from + 1] * tg); target[to + 2] = Math.round(source.data[from + 2] * tb); target[to + 3] = 255;
      if (snap) palette.snap(target, to);
    }
  }
}

/**
 * The colours a pixel-art rig is drawn with. A tinted part (a far limb drawn darker) takes the nearest of them instead of
 * an invented darker colour, which usually lands on the next shade down the same ramp, as an artist shades a back limb.
 */
export type Palette = { readonly snap: (data: Uint8ClampedArray, at: number) => void };
export function rigPalette(pixels: PartPixels): Palette {
  const keys = new Set<number>();
  for (const image of Object.values(pixels)) for (let i = 0; i < image.data.length; i += 4) if (image.data[i + 3] >= 128 && keys.size < 512) keys.add((image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2]);
  const colours = [...keys].map((key) => [key >> 16, (key >> 8) & 255, key & 255] as const); const memo = new Map<number, readonly [number, number, number]>();
  return {
    snap: (data, at) => {
      const key = (data[at] << 16) | (data[at + 1] << 8) | data[at + 2]; let best = memo.get(key);
      if (!best) { let distance = Infinity; for (const colour of colours) { const d = 2 * (colour[0] - data[at]) ** 2 + 4 * (colour[1] - data[at + 1]) ** 2 + 3 * (colour[2] - data[at + 2]) ** 2; if (d < distance) { distance = d; best = colour; } } best ??= [data[at], data[at + 1], data[at + 2]]; memo.set(key, best); }
      data[at] = best[0]; data[at + 1] = best[1]; data[at + 2] = best[2];
    },
  };
}

/** A part drawn under a general transform (stretched or mirrored): every destination pixel reads its nearest source pixel. */
function affine(target: Uint8ClampedArray, window: FrameWindow, source: RgbaImage, matrix: Matrix, pivotX: number, pivotY: number, tint: number, palette?: Palette): void {
  const det = matrix.a * matrix.d - matrix.b * matrix.c; if (Math.abs(det) < 1e-9) return;
  const ox = Math.round(matrix.tx); const oy = Math.round(matrix.ty);
  const corners = [[-pivotX, -pivotY], [source.width - pivotX, -pivotY], [-pivotX, source.height - pivotY], [source.width - pivotX, source.height - pivotY]]
    .map(([u, v]) => [matrix.a * u + matrix.c * v + ox, matrix.b * u + matrix.d * v + oy]);
  const minX = Math.floor(Math.min(...corners.map((p) => p[0]))); const maxX = Math.ceil(Math.max(...corners.map((p) => p[0])));
  const minY = Math.floor(Math.min(...corners.map((p) => p[1]))); const maxY = Math.ceil(Math.max(...corners.map((p) => p[1])));
  const tr = ((tint >> 16) & 255) / 255; const tg = ((tint >> 8) & 255) / 255; const tb = (tint & 255) / 255;
  for (let y = minY; y < maxY; y += 1) {
    const ty = y - window.y; if (ty < 0 || ty >= window.height) continue;
    for (let x = minX; x < maxX; x += 1) {
      const tx = x - window.x; if (tx < 0 || tx >= window.width) continue;
      const dx = x + .5 - ox; const dy = y + .5 - oy;
      const u = (matrix.d * dx - matrix.c * dy) / det + pivotX; const v = (-matrix.b * dx + matrix.a * dy) / det + pivotY;
      const sx = Math.floor(u); const sy = Math.floor(v);
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
      const from = (sy * source.width + sx) * 4; if (source.data[from + 3] < 128) continue;
      const to = (ty * window.width + tx) * 4;
      target[to] = Math.round(source.data[from] * tr); target[to + 1] = Math.round(source.data[from + 1] * tg); target[to + 2] = Math.round(source.data[from + 2] * tb); target[to + 3] = 255;
      if (tint !== 0xffffff && palette) palette.snap(target, to);
    }
  }
}

/** Bilinear read (premultiplied), as a GPU samples an HD texture: what the game shows for a rig that is not pixel art. */
function smooth(target: Uint8ClampedArray, window: FrameWindow, source: RgbaImage, matrix: Matrix, pivotX: number, pivotY: number, tint: number): void {
  const det = matrix.a * matrix.d - matrix.b * matrix.c; if (Math.abs(det) < 1e-9) return;
  const corners = [[-pivotX, -pivotY], [source.width - pivotX, -pivotY], [-pivotX, source.height - pivotY], [source.width - pivotX, source.height - pivotY]]
    .map(([u, v]) => [matrix.a * u + matrix.c * v + matrix.tx, matrix.b * u + matrix.d * v + matrix.ty]);
  const minX = Math.floor(Math.min(...corners.map((p) => p[0]))); const maxX = Math.ceil(Math.max(...corners.map((p) => p[0])));
  const minY = Math.floor(Math.min(...corners.map((p) => p[1]))); const maxY = Math.ceil(Math.max(...corners.map((p) => p[1])));
  const tints = [((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255];
  const texel = (x: number, y: number, channel: number) => (x < 0 || y < 0 || x >= source.width || y >= source.height) ? 0 : source.data[(y * source.width + x) * 4 + channel];
  for (let y = minY; y < maxY; y += 1) {
    const ty = y - window.y; if (ty < 0 || ty >= window.height) continue;
    for (let x = minX; x < maxX; x += 1) {
      const tx = x - window.x; if (tx < 0 || tx >= window.width) continue;
      const dx = x + .5 - matrix.tx; const dy = y + .5 - matrix.ty;
      const u = (matrix.d * dx - matrix.c * dy) / det + pivotX - .5; const v = (-matrix.b * dx + matrix.a * dy) / det + pivotY - .5;
      const x0 = Math.floor(u); const y0 = Math.floor(v); const fx = u - x0; const fy = v - y0;
      const weights = [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]] as const;
      let alpha = 0; const colour = [0, 0, 0];
      for (const [sx, sy, w] of weights) { const a = texel(sx, sy, 3) / 255 * w; alpha += a; for (let c = 0; c < 3; c += 1) colour[c] += texel(sx, sy, c) * a; }
      if (alpha < 1 / 255) continue;
      const to = (ty * window.width + tx) * 4; const under = target[to + 3] / 255;
      for (let c = 0; c < 3; c += 1) target[to + c] = Math.round((colour[c] * tints[c]) + target[to + c] * under * (1 - alpha));
      const outAlpha = alpha + under * (1 - alpha);
      for (let c = 0; c < 3; c += 1) target[to + c] = Math.round(target[to + c] / Math.max(outAlpha, 1e-6));
      target[to + 3] = Math.round(outAlpha * 255);
    }
  }
}

/** True when the game renderer draws this rig as pixel art (RigRenderer's rule). */
export const isPixelArtRig = (rig: RigDefinition): boolean => rig.metadata?.pixelArt === true || Math.max(rig.canvas?.width ?? Infinity, rig.canvas?.height ?? Infinity) <= 256;

/**
 * Draws one pose. `pixels` holds each attachment's texture by attachment id (the same image the game loads); `window` is
 * the area of the rig's canvas to draw (default: the whole canvas).
 */
export function renderPixelFrame(rig: RigDefinition, pose: RigPose, pixels: PartPixels, window?: FrameWindow, cache = new Map<string, { image: RgbaImage; pivot: { x: number; y: number } }>(), smearFrom?: RigPose): RgbaImage {
  const full = window ?? { x: 0, y: 0, width: rig.canvas?.width ?? 256, height: rig.canvas?.height ?? 256 };
  const k = pixelScaleOf(rig);
  // True pixel art drawn k times larger is composed at its own resolution: every part on the one art-pixel grid.
  const area = k > 1 ? { x: Math.floor(full.x / k), y: Math.floor(full.y / k), width: Math.ceil(full.width / k), height: Math.ceil(full.height / k) } : full;
  const data = new Uint8ClampedArray(area.width * area.height * 4);
  const world = computeWorldTransforms(rig, pose); const pixelArt = isPixelArtRig(rig);
  const palette = pixelArt ? paletteCache.get(pixels) ?? (() => { const made = rigPalette(pixels); paletteCache.set(pixels, made); return made; })() : undefined;
  const weapons = smearFrom && pixelArt ? weaponAttachments(rig) : null; const smears: { readonly swept: Uint8Array; readonly colour: readonly number[] }[] = [];
  for (const { slot, attachment } of resolveSlots(rig)) {
    const bone = world[slot.boneId]; if (!slot.visible || !attachment || !bone) continue;
    const source = pixels[attachment.id]; if (!source) continue;
    if (weapons?.has(attachment.id)) smears.push(drawSmear(rig, smearFrom!, pose, slot, attachment, source, data, area, k, cache));
    const attachmentMatrix = matrixFromTransform({
      x: attachment.offsetX, y: attachment.offsetY, rotation: degreesToRadians(attachment.rotation),
      scaleX: attachment.scaleX * attachment.width / Math.max(1, source.width), scaleY: attachment.scaleY * attachment.height / Math.max(1, source.height),
    });
    const full = multiplyMatrices(bone.matrix, attachmentMatrix) as Matrix;
    const sourcePivotX = slot.pivotX / attachment.width * source.width; const sourcePivotY = slot.pivotY / attachment.height * source.height;
    if (!pixelArt) { smooth(data, area, source, full, sourcePivotX, sourcePivotY, slot.tint); continue; }
    const native = k > 1 ? nativePart(rig, slot.id, attachment.id, source, sourcePivotX, sourcePivotY, k, cache) : null;
    const texture = native?.image ?? source; const pivotX = native?.pivot.x ?? sourcePivotX; const pivotY = native?.pivot.y ?? sourcePivotY;
    const matrix: Matrix = k > 1 ? { ...full, tx: full.tx / k, ty: full.ty / k } : full;
    const scaleX = Math.hypot(matrix.a, matrix.b); const det = matrix.a * matrix.d - matrix.b * matrix.c; const scaleY = det / Math.max(1e-9, scaleX);
    // Rotation with a squash or stretch (scale within 25%): scaled nearest-neighbour first, then RotSprite, so squashed parts
    // keep clean outlines. Mirrored or strongly stretched parts are sampled directly.
    const drawable = det > 0 && Math.abs(scaleX - 1) <= .25 && Math.abs(scaleY - 1) <= .25;
    if (drawable) {
      const angle = snapAngle(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI);
      const sx = Math.round(scaleX * 50) / 50; const sy = Math.round(scaleY * 50) / 50;
      const key = `${attachment.id}:${k}:${angle}:${sx},${sy}:${pivotX.toFixed(1)},${pivotY.toFixed(1)}`;
      let rotated = cache.get(key);
      if (!rotated) { const scaled = sx === 1 && sy === 1 ? { image: texture, pivot: { x: pivotX, y: pivotY } } : scaleNearest(texture, sx, sy, pivotX, pivotY); rotated = rotsprite(scaled.image, angle, scaled.pivot); cache.set(key, rotated); }
      blit(data, area, rotated.image, Math.round(matrix.tx) - rotated.pivot.x, Math.round(matrix.ty) - rotated.pivot.y, slot.tint, palette);
    } else affine(data, area, texture, matrix, pivotX, pivotY, slot.tint, palette);
  }
  for (const smear of smears) fillSmearPockets(data, area, smear.swept, smear.colour);
  return { width: area.width, height: area.height, data };
}

const paletteCache = new WeakMap<PartPixels, Palette>();

/** Held items long enough to smear when swung (a blade, a spear): their recorded shape is elongated. */
function weaponAttachments(rig: RigDefinition): ReadonlySet<string> {
  const shapes = (rig.metadata?.equipmentElongation ?? {}) as Record<string, unknown>;
  return new Set(rig.attachments.filter((attachment) => attachment.category === "equipment" && typeof shapes[attachment.id] === "number" && (shapes[attachment.id] as number) >= 2.5).map((attachment) => attachment.id));
}

/** A pose between two poses: each bone's values interpolated. */
function between(from: RigPose, to: RigPose, t: number): RigPose {
  return { bones: Object.fromEntries(Object.entries(to.bones).map(([id, end]) => { const start = from.bones[id] ?? end; return [id, { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t, rotation: start.rotation + (end.rotation - start.rotation) * t, scaleX: start.scaleX + (end.scaleX - start.scaleX) * t, scaleY: start.scaleY + (end.scaleY - start.scaleY) * t }]; })) };
}

/**
 * A smear (pixel-art practice for fast strikes): the area the weapon swept between the previous drawing and this one,
 * filled with its lightest colour and drawn just under it, so the blow reads as one fast arc rather than a jump.
 */
function drawSmear(rig: RigDefinition, from: RigPose, to: RigPose, slot: RigDefinition["slots"][number], attachment: RigDefinition["attachments"][number], source: RgbaImage, data: Uint8ClampedArray, area: FrameWindow, k: number, cache: Map<string, { image: RgbaImage; pivot: { x: number; y: number } }>): { readonly swept: Uint8Array; readonly colour: readonly number[] } {
  // A light colour of the part that draws the arc, the end away from the grip (a sword's blade, a staff's crystal), not
  // the whole item: a staff's wood made a solid brown arc. Not its single brightest highlight either (a glint is white).
  const gripX = slot.pivotX * source.width / Math.max(1, attachment.width); const gripY = slot.pivotY * source.height / Math.max(1, attachment.height);
  // The tip is the drawn point farthest from the grip; the arc is drawn by the third of the item nearest it (a staff runs
  // both ways from the hand, so "far from the grip" alone would include its butt end).
  let reach = 0; let tipX = gripX; let tipY = gripY;
  for (let i = 0; i < source.data.length; i += 4) if (source.data[i + 3] >= 128) { const p = i / 4; const x = p % source.width; const y = Math.floor(p / source.width); const d = Math.hypot(x - gripX, y - gripY); if (d > reach) { reach = d; tipX = x; tipY = y; } }
  const shades: { readonly lum: number; readonly rgb: readonly number[] }[] = [];
  for (let i = 0; i < source.data.length; i += 4) {
    const p = i / 4; if (source.data[i + 3] < 128 || Math.hypot(p % source.width - tipX, Math.floor(p / source.width) - tipY) > reach * .34) continue;
    shades.push({ lum: source.data[i] * .299 + source.data[i + 1] * .587 + source.data[i + 2] * .114, rgb: [source.data[i], source.data[i + 1], source.data[i + 2]] });
  }
  shades.sort((a, b) => a.lum - b.lum);
  const lightest = shades.length ? shades[Math.floor(shades.length * .75)].rgb : [255, 255, 255];
  const swept = new Uint8Array(area.width * area.height);
  // A sword smears its outer third; a staff or spear (very long) only the arc its tip draws.
  const shape = (rig.metadata?.equipmentElongation as Record<string, unknown> | undefined)?.[attachment.id];
  const inner = typeof shape === "number" && shape > 8 ? .8 : .65;
  // Enough in-between positions that the swept area is one solid crescent, not a fan of separate blades (one per ~4°).
  const angleAt = (pose: RigPose) => { const bone = computeWorldTransforms(rig, pose)[slot.boneId]; return bone ? Math.atan2(bone.matrix.b, bone.matrix.a) * 180 / Math.PI : 0; };
  let turned = Math.abs(angleAt(to) - angleAt(from)); if (turned > 180) turned = 360 - turned;
  const steps = Math.min(48, Math.max(6, Math.ceil(turned / 4)));
  for (const t of Array.from({ length: steps }, (_, index) => (index + 1) / (steps + 1))) {
    const world = computeWorldTransforms(rig, between(from, to, t)); const bone = world[slot.boneId]; if (!bone) continue;
    const full = multiplyMatrices(bone.matrix, matrixFromTransform({ x: attachment.offsetX, y: attachment.offsetY, rotation: degreesToRadians(attachment.rotation), scaleX: attachment.scaleX * attachment.width / Math.max(1, source.width), scaleY: attachment.scaleY * attachment.height / Math.max(1, source.height) })) as Matrix;
    const sourcePivotX = slot.pivotX / attachment.width * source.width; const sourcePivotY = slot.pivotY / attachment.height * source.height;
    const native = k > 1 ? nativePart(rig, slot.id, attachment.id, source, sourcePivotX, sourcePivotY, k, cache) : null;
    const texture = native?.image ?? source; const pivotX = native?.pivot.x ?? sourcePivotX; const pivotY = native?.pivot.y ?? sourcePivotY;
    const angle = snapAngle(Math.atan2(full.b, full.a) * 180 / Math.PI);
    const key = `${attachment.id}:${k}:${angle}:${pivotX.toFixed(1)},${pivotY.toFixed(1)}`;
    let rotated = cache.get(key); if (!rotated) { rotated = rotsprite(texture, angle, { x: pivotX, y: pivotY }); cache.set(key, rotated); }
    const left = Math.round((k > 1 ? full.tx / k : full.tx)) - rotated.pivot.x - area.x; const top = Math.round((k > 1 ? full.ty / k : full.ty)) - rotated.pivot.y - area.y;
    // Only the outer third of the swing smears (the tip travels far; the grip hardly moves), as a crescent.
    let reach = 0;
    for (let y = 0; y < rotated.image.height; y += 1) for (let x = 0; x < rotated.image.width; x += 1) if (rotated.image.data[(y * rotated.image.width + x) * 4 + 3] >= 128) reach = Math.max(reach, Math.hypot(x - rotated.pivot.x, y - rotated.pivot.y));
    for (let y = 0; y < rotated.image.height; y += 1) for (let x = 0; x < rotated.image.width; x += 1) {
      if (rotated.image.data[(y * rotated.image.width + x) * 4 + 3] < 128 || Math.hypot(x - rotated.pivot.x, y - rotated.pivot.y) < reach * inner) continue;
      const tx = left + x; const ty = top + y; if (tx >= 0 && ty >= 0 && tx < area.width && ty < area.height) swept[ty * area.width + tx] = 1;
    }
  }
  for (let i = 0; i < swept.length; i += 1) if (swept[i]) { data[i * 4] = lightest[0]; data[i * 4 + 1] = lightest[1]; data[i * 4 + 2] = lightest[2]; data[i * 4 + 3] = 255; }
  return { swept, colour: lightest };
}

/** A smear is drawn solid: see-through pockets it closes off against the body are filled with it (other holes stay). */
function fillSmearPockets(data: Uint8ClampedArray, area: FrameWindow, swept: Uint8Array, colour: readonly number[]): void {
  const { width, height } = area; const outside = new Uint8Array(width * height); const queue: number[] = [];
  const push = (index: number) => { if (!outside[index] && data[index * 4 + 3] < 128) { outside[index] = 1; queue.push(index); } };
  for (let x = 0; x < width; x += 1) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { push(y * width); push(y * width + width - 1); }
  for (let cursor = 0; cursor < queue.length; cursor += 1) { const i = queue[cursor]; const x = i % width; const y = (i - x) / width; if (x > 0) push(i - 1); if (x + 1 < width) push(i + 1); if (y > 0) push(i - width); if (y + 1 < height) push(i + width); }
  const seen = new Uint8Array(width * height);
  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] || outside[start] || data[start * 4 + 3] >= 128) continue;
    const pocket = [start]; seen[start] = 1; let touches = false;
    for (let cursor = 0; cursor < pocket.length; cursor += 1) {
      const i = pocket[cursor]; const x = i % width; const y = (i - x) / width;
      for (const next of [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, y > 0 ? i - width : -1, y + 1 < height ? i + width : -1]) {
        if (next < 0) continue; if (swept[next]) touches = true;
        if (!seen[next] && !outside[next] && data[next * 4 + 3] < 128) { seen[next] = 1; pocket.push(next); }
      }
    }
    if (touches) for (const i of pocket) { data[i * 4] = colour[0]; data[i * 4 + 1] = colour[1]; data[i * 4 + 2] = colour[2]; data[i * 4 + 3] = 255; }
  }
}

/** The image resized by (sx, sy) with nearest-neighbour sampling, and where the pivot lands in it. */
function scaleNearest(image: RgbaImage, sx: number, sy: number, pivotX: number, pivotY: number): { image: RgbaImage; pivot: { x: number; y: number } } {
  const width = Math.max(1, Math.round(image.width * sx)); const height = Math.max(1, Math.round(image.height * sy)); const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const from = (Math.min(image.height - 1, Math.floor((y + .5) / sy)) * image.width + Math.min(image.width - 1, Math.floor((x + .5) / sx))) * 4; const to = (y * width + x) * 4;
    data[to] = image.data[from]; data[to + 1] = image.data[from + 1]; data[to + 2] = image.data[from + 2]; data[to + 3] = image.data[from + 3];
  }
  return { image: { width, height, data }, pivot: { x: pivotX * sx, y: pivotY * sy } };
}

/** The art pixel size of a rig made from true pixel art drawn larger (metadata.pixelScale), else 1. */
export const pixelScaleOf = (rig: RigDefinition): number => {
  const value = rig.metadata?.pixelScale;
  return typeof value === "number" && Number.isInteger(value) && value > 1 ? value : 1;
};

/**
 * A part at the art's own resolution: one pixel per art pixel, sampled at the centres of the global art grid. Where the
 * part sits on that grid comes from the rest pose (the art's own position in the picture it was cut from).
 */
function nativePart(rig: RigDefinition, slotId: string, attachmentId: string, source: RgbaImage, pivotX: number, pivotY: number, k: number, cache: Map<string, { image: RgbaImage; pivot: { x: number; y: number } }>): { image: RgbaImage; pivot: { x: number; y: number } } {
  const key = `${attachmentId}:native:${k}`; const cached = cache.get(key); if (cached) return cached;
  const rest = computeWorldTransforms(rig, createRestPose(rig)); const slot = rig.slots.find((candidate) => candidate.id === slotId)!;
  const attachment = rig.attachments.find((candidate) => candidate.id === attachmentId)!;
  const matrix = multiplyMatrices(rest[slot.boneId].matrix, matrixFromTransform({ x: attachment.offsetX, y: attachment.offsetY, rotation: degreesToRadians(attachment.rotation), scaleX: 1, scaleY: 1 }));
  // The part's top-left corner in the picture, and how far that is from the grid line before it.
  const left = Math.round(matrix.tx - pivotX); const top = Math.round(matrix.ty - pivotY);
  const phaseX = ((left % k) + k) % k; const phaseY = ((top % k) + k) % k;
  const width = Math.ceil((source.width + phaseX) / k); const height = Math.ceil((source.height + phaseY) / k);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sx = x * k - phaseX + (k >> 1); const sy = y * k - phaseY + (k >> 1);
    if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
    const from = (sy * source.width + sx) * 4; const to = (y * width + x) * 4;
    data[to] = source.data[from]; data[to + 1] = source.data[from + 1]; data[to + 2] = source.data[from + 2]; data[to + 3] = source.data[from + 3];
  }
  const result = { image: { width, height, data }, pivot: { x: (pivotX + phaseX) / k, y: (pivotY + phaseY) / k } };
  cache.set(key, result);
  return result;
}

/** What a game displays while a clip plays at `fps`: one frame per display tick over one pass of the clip. */
export function renderClip(rig: RigDefinition, animation: AnimationDefinition, pixels: PartPixels, options: { readonly fps?: number; readonly window?: FrameWindow } = {}): { readonly frames: RgbaImage[]; readonly fps: number } {
  const fps = options.fps ?? 60; const count = Math.max(1, Math.round(animation.duration * fps));
  const base = createRestPose(rig); const cache = new Map<string, { image: RgbaImage; pivot: { x: number; y: number } }>();
  const frames = Array.from({ length: count }, (_, index) => {
    const shown = drawingTime(animation, Math.min(animation.duration, index / fps));
    return renderPixelFrame(rig, evaluateAnimationAtTime(animation, base, shown), pixels, options.window, cache, smearOrigin(animation, base, shown));
  });
  return { frames, fps };
}

/** For a drawing that shows a smear, the pose of the drawing before it (where the swing came from). */
export function smearOrigin(animation: AnimationDefinition, base: RigPose, shown: number): RigPose | undefined {
  if (!animation.smears?.some((at) => Math.abs(at - shown) < 1e-6) || !animation.drawings) return undefined;
  const index = animation.drawings.findIndex((at) => Math.abs(at - shown) < 1e-6);
  return index > 0 ? evaluateAnimationAtTime(animation, base, animation.drawings[index - 1]) : undefined;
}

/** The smallest window holding every opaque pixel of the given frames, padded. */
export function framesWindow(frames: readonly RgbaImage[], origin: FrameWindow, pad = 2): FrameWindow {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const frame of frames) for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
    if (frame.data[(y * frame.width + x) * 4 + 3] === 0) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return origin;
  return { x: origin.x + minX - pad, y: origin.y + minY - pad, width: maxX - minX + 1 + pad * 2, height: maxY - minY + 1 + pad * 2 };
}
