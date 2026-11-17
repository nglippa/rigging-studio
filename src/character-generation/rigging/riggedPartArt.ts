import { adoptStrayArtwork, deriveRiggingExtraction, ensureOwnershipPartition, partCutToSegmentation, type PartCutterState } from "../../part-cutter";
import { estimateForeground, extractPartToDataUrl, pixelImageToDataUrl, readImagePixels, type PixelImage } from "../segmentation/partImageProcessor";
import type { ProposedCharacterPart, Rect } from "../segmentation/segmentationSchema";
import { fillPartArt, type FilledPart } from "./jointFill";
import { estimateZIndex } from "./zOrderEstimator";

export type RiggedPartArt = { readonly partId: string; readonly image: string; readonly width: number; readonly height: number; readonly padding: number; readonly status: "manual" | "accepted" | "reconstructed" };

/**
 * One request to repaint the hidden area of a part with a real inpainting model. Everything is in source-canvas
 * coordinates: `part` is the part as cut (its own pixels), `bounds` is the area its finished art covers and
 * `mask` (same size as `bounds`) marks the hidden pixels to paint. The answer is an image the size of `bounds`.
 */
export type HiddenAreaRepaintRequest = {
  readonly part: ProposedCharacterPart; readonly bounds: Rect; readonly mask: { readonly width: number; readonly height: number; readonly alpha: readonly number[] };
  /**
   * What the model should look at, the size of the source canvas: this part and everything drawn behind it, with the
   * hidden area roughed in by the built-in fill, and nothing in front. Shown the original image, the model continues
   * whatever covers the part (a sword across a thigh comes back as more sword) instead of the part itself.
   */
  readonly context: PixelImage;
};
export type HiddenAreaRepaint = (request: HiddenAreaRepaintRequest) => Promise<PixelImage | null>;
export type RepaintOutcome = { readonly partId: string; readonly status: "repainted" | "failed" | "skipped"; readonly pixels: number; readonly reason?: string };

/** A repaint model works on the whole image; on a tiny sprite there is nothing for it to work with. */
export const MIN_REPAINT_SOURCE_SIDE = 256;
/** Parts whose hidden area is a sliver are not worth a minute of model time; the built-in fill covers them. */
export const repaintWorthwhile = (filled: Pick<FilledPart, "filledPixels" | "bounds">): boolean =>
  filled.filledPixels >= Math.max(200, filled.bounds.width * filled.bounds.height * .02);

/**
 * Everything a cut character needs before it becomes a rig, shared by every way of building one (the Parts screen and
 * the agent command): uncut slivers join their nearest part, then each part's art is extended with joint caps and
 * hidden-area fill so the character stays whole when its parts move. A part with an approved reconstruction keeps it.
 *
 * With `repaint`, the hidden areas are then repainted by an inpainting model, one part at a time. Only the filled-in
 * pixels are replaced; the part's own art and its joint caps are always the original pixels. A part whose repaint fails
 * keeps the built-in fill.
 */
export async function prepareRiggedPartArt(sourceImage: string, sourceSize: { readonly width: number; readonly height: number }, state: PartCutterState, options: {
  readonly foreground?: readonly number[]; readonly pixels?: PixelImage;
  readonly repaint?: HiddenAreaRepaint; readonly onRepaintProgress?: (done: number, total: number, partId: string) => void;
} = {}): Promise<{
  readonly state: PartCutterState; readonly segmentation: ReturnType<typeof partCutToSegmentation>; readonly parts: readonly RiggedPartArt[];
  readonly artBounds: Readonly<Record<string, Rect>>; readonly filledParts: readonly string[]; readonly repaint: readonly RepaintOutcome[];
}> {
  const pixels = options.pixels ?? await readImagePixels(sourceImage).catch(() => null);
  const matches = pixels !== null && pixels.width === sourceSize.width && pixels.height === sourceSize.height;
  const foreground = options.foreground ?? (matches ? estimateForeground(pixels).mask : undefined);
  const canonical = adoptStrayArtwork(ensureOwnershipPartition(state), foreground, Math.max(2, Math.round(Math.hypot(sourceSize.width, sourceSize.height) * .06))).state;
  const segmentation = partCutToSegmentation(canonical);
  const filled = matches ? fillPartArt(pixels, segmentation.parts) : [];
  const worth = filled.filter((art) => repaintWorthwhile(art) && !canonical.parts.find((cut) => cut.partId === art.partId)?.reconstructionImage);
  const repaint: RepaintOutcome[] = [];
  const repainted = new Map<string, PixelImage>();
  if (options.repaint && worth.length) {
    if (Math.min(sourceSize.width, sourceSize.height) < MIN_REPAINT_SOURCE_SIDE) {
      for (const art of worth) repaint.push({ partId: art.partId, status: "skipped", pixels: art.filledPixels, reason: `Image is under ${MIN_REPAINT_SOURCE_SIDE} px; the built-in fill is used` });
    } else {
      for (const [index, art] of worth.entries()) {
        options.onRepaintProgress?.(index, worth.length, art.partId);
        const part = segmentation.parts.find((candidate) => candidate.id === art.partId)!;
        try {
          const context = compositeBehind(sourceSize, segmentation.parts, filled, art.partId);
          const result = await options.repaint({ part, bounds: art.bounds, mask: { width: art.image.width, height: art.image.height, alpha: Array.from(art.filledMask) }, context });
          if (!result || result.width !== art.image.width || result.height !== art.image.height) throw new Error("The repaint came back the wrong size");
          repainted.set(art.partId, mergeRepaint(art, result));
          repaint.push({ partId: art.partId, status: "repainted", pixels: art.filledPixels });
        } catch (reason: unknown) {
          repaint.push({ partId: art.partId, status: "failed", pixels: art.filledPixels, reason: reason instanceof Error ? reason.message : String(reason) });
        }
      }
      options.onRepaintProgress?.(worth.length, worth.length, "");
    }
  }
  const artBounds: Record<string, Rect> = {};
  const parts = await Promise.all(segmentation.parts.map(async (part): Promise<RiggedPartArt> => {
    const cut = canonical.parts.find((candidate) => candidate.partId === part.id);
    const extraction = deriveRiggingExtraction(canonical, part.id);
    const status = part.provenance === "reconstructed" ? "reconstructed" : part.provenance === "accepted" ? "accepted" : "manual";
    if (cut?.reconstructionImage) return { partId: part.id, image: cut.reconstructionImage, width: extraction.bounds.width, height: extraction.bounds.height, padding: extraction.padding, status };
    const art = filled.find((candidate) => candidate.partId === part.id);
    if (art) { artBounds[part.id] = art.bounds; return { partId: part.id, image: pixelImageToDataUrl(repainted.get(part.id) ?? art.image), width: art.bounds.width, height: art.bounds.height, padding: 0, status }; }
    return { partId: part.id, image: await extractPartToDataUrl(sourceImage, extraction.bounds, extraction.mask, 0), width: extraction.bounds.width, height: extraction.bounds.height, padding: extraction.padding, status };
  }));
  return { state: canonical, segmentation, parts, artBounds, filledParts: worth.map((art) => art.partId), repaint };
}

/** The part's art with only its filled-in pixels taken from the repaint; everything the artist drew stays as it was. */
export function mergeRepaint(art: Pick<FilledPart, "image" | "filledMask">, repainted: PixelImage): PixelImage {
  const data = new Uint8ClampedArray(art.image.data);
  for (let index = 0; index < art.filledMask.length; index += 1) {
    if (!art.filledMask[index]) continue;
    const offset = index * 4;
    data[offset] = repainted.data[offset]; data[offset + 1] = repainted.data[offset + 1]; data[offset + 2] = repainted.data[offset + 2]; data[offset + 3] = 255;
  }
  return { width: art.image.width, height: art.image.height, data };
}

/**
 * The character as it would look with everything in front of one part taken away: every part drawn behind it, then the
 * part itself with its hidden area filled in, in drawing order, on a transparent canvas the size of the source.
 */
export function compositeBehind(size: { readonly width: number; readonly height: number }, parts: readonly ProposedCharacterPart[], filled: readonly FilledPart[], partId: string): PixelImage {
  const order = parts.map((part, index) => ({ part, z: estimateZIndex(part) + index * 1e-4 })).sort((a, b) => a.z - b.z);
  const own = order.find((entry) => entry.part.id === partId);
  const data = new Uint8ClampedArray(size.width * size.height * 4);
  for (const entry of order) {
    if (!own || entry.z > own.z) continue;
    const art = filled.find((candidate) => candidate.partId === entry.part.id); if (!art) continue;
    for (let y = 0; y < art.image.height; y += 1) for (let x = 0; x < art.image.width; x += 1) {
      const from = (y * art.image.width + x) * 4; const alpha = art.image.data[from + 3]; if (!alpha) continue;
      const tx = art.bounds.x + x; const ty = art.bounds.y + y; if (tx < 0 || ty < 0 || tx >= size.width || ty >= size.height) continue;
      const to = (ty * size.width + tx) * 4; const a = alpha / 255;
      for (let channel = 0; channel < 3; channel += 1) data[to + channel] = Math.round(art.image.data[from + channel] * a + data[to + channel] * (1 - a));
      data[to + 3] = Math.max(data[to + 3], alpha);
    }
  }
  return { width: size.width, height: size.height, data };
}
