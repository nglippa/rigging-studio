import { adoptStrayArtwork, deriveRiggingExtraction, ensureOwnershipPartition, partCutToSegmentation, type PartCutterState } from "../../part-cutter";
import { estimateForeground, extractPartToDataUrl, pixelImageToDataUrl, readImagePixels, type PixelImage } from "../segmentation/partImageProcessor";
import type { Rect } from "../segmentation/segmentationSchema";
import { fillPartArt } from "./jointFill";

export type RiggedPartArt = { readonly partId: string; readonly image: string; readonly width: number; readonly height: number; readonly padding: number; readonly status: "manual" | "accepted" | "reconstructed" };

/**
 * Everything a cut character needs before it becomes a rig, shared by every way of building one (the Parts screen and
 * the agent command): uncut slivers join their nearest part, then each part's art is extended with joint caps and
 * hidden-area fill so the character stays whole when its parts move. A part with an approved reconstruction keeps it.
 */
export async function prepareRiggedPartArt(sourceImage: string, sourceSize: { readonly width: number; readonly height: number }, state: PartCutterState, options: { readonly foreground?: readonly number[]; readonly pixels?: PixelImage } = {}): Promise<{
  readonly state: PartCutterState; readonly segmentation: ReturnType<typeof partCutToSegmentation>; readonly parts: readonly RiggedPartArt[]; readonly artBounds: Readonly<Record<string, Rect>>;
}> {
  const pixels = options.pixels ?? await readImagePixels(sourceImage).catch(() => null);
  const matches = pixels !== null && pixels.width === sourceSize.width && pixels.height === sourceSize.height;
  const foreground = options.foreground ?? (matches ? estimateForeground(pixels).mask : undefined);
  const canonical = adoptStrayArtwork(ensureOwnershipPartition(state), foreground, Math.max(2, Math.round(Math.hypot(sourceSize.width, sourceSize.height) * .06))).state;
  const segmentation = partCutToSegmentation(canonical);
  const filled = matches ? fillPartArt(pixels, segmentation.parts) : [];
  const artBounds: Record<string, Rect> = {};
  const parts = await Promise.all(segmentation.parts.map(async (part): Promise<RiggedPartArt> => {
    const cut = canonical.parts.find((candidate) => candidate.partId === part.id);
    const extraction = deriveRiggingExtraction(canonical, part.id);
    const status = part.provenance === "reconstructed" ? "reconstructed" : part.provenance === "accepted" ? "accepted" : "manual";
    if (cut?.reconstructionImage) return { partId: part.id, image: cut.reconstructionImage, width: extraction.bounds.width, height: extraction.bounds.height, padding: extraction.padding, status };
    const art = filled.find((candidate) => candidate.partId === part.id);
    if (art) { artBounds[part.id] = art.bounds; return { partId: part.id, image: pixelImageToDataUrl(art.image), width: art.bounds.width, height: art.bounds.height, padding: 0, status }; }
    return { partId: part.id, image: await extractPartToDataUrl(sourceImage, extraction.bounds, extraction.mask, 0), width: extraction.bounds.width, height: extraction.bounds.height, padding: extraction.padding, status };
  }));
  return { state: canonical, segmentation, parts, artBounds };
}
