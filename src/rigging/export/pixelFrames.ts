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
export function renderPixelFrame(rig: RigDefinition, pose: RigPose, pixels: PartPixels, window?: FrameWindow, cache = new Map<string, { image: RgbaImage; pivot: { x: number; y: number } }>()): RgbaImage {
  const full = window ?? { x: 0, y: 0, width: rig.canvas?.width ?? 256, height: rig.canvas?.height ?? 256 };
  const k = pixelScaleOf(rig);
  // True pixel art drawn k times larger is composed at its own resolution: every part on the one art-pixel grid.
  const area = k > 1 ? { x: Math.floor(full.x / k), y: Math.floor(full.y / k), width: Math.ceil(full.width / k), height: Math.ceil(full.height / k) } : full;
  const data = new Uint8ClampedArray(area.width * area.height * 4);
  const world = computeWorldTransforms(rig, pose); const pixelArt = isPixelArtRig(rig);
  const palette = pixelArt ? paletteCache.get(pixels) ?? (() => { const made = rigPalette(pixels); paletteCache.set(pixels, made); return made; })() : undefined;
  for (const { slot, attachment } of resolveSlots(rig)) {
    const bone = world[slot.boneId]; if (!slot.visible || !attachment || !bone) continue;
    const source = pixels[attachment.id]; if (!source) continue;
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
    const scaleX = Math.hypot(matrix.a, matrix.b); const scaleY = Math.hypot(matrix.c, matrix.d);
    const rotationOnly = Math.abs(scaleX - 1) <= .03 && Math.abs(scaleY - 1) <= .03 && matrix.a * matrix.d - matrix.b * matrix.c > 0;
    if (rotationOnly) {
      const angle = snapAngle(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI);
      const key = `${attachment.id}:${k}:${angle}:${pivotX.toFixed(1)},${pivotY.toFixed(1)}`;
      let rotated = cache.get(key); if (!rotated) { rotated = rotsprite(texture, angle, { x: pivotX, y: pivotY }); cache.set(key, rotated); }
      blit(data, area, rotated.image, Math.round(matrix.tx) - rotated.pivot.x, Math.round(matrix.ty) - rotated.pivot.y, slot.tint, palette);
    } else affine(data, area, texture, matrix, pivotX, pivotY, slot.tint, palette);
  }
  return { width: area.width, height: area.height, data };
}

const paletteCache = new WeakMap<PartPixels, Palette>();

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
  const frames = Array.from({ length: count }, (_, index) => renderPixelFrame(rig, evaluateAnimationAtTime(animation, base, drawingTime(animation, Math.min(animation.duration, index / fps))), pixels, options.window, cache));
  return { frames, fps };
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
