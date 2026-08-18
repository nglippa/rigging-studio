import type { Rect, SegmentationMask } from "./segmentationSchema";

export type PixelImage = { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray };
export type PartExtractionInput = { readonly source: PixelImage; readonly bounds: Rect; readonly mask?: SegmentationMask; readonly padding?: number };

export function extractPartPixels(input: PartExtractionInput): PixelImage {
  const padding = Math.max(0, Math.floor(input.padding ?? 0));
  const left = Math.floor(input.bounds.x); const top = Math.floor(input.bounds.y);
  const width = Math.ceil(input.bounds.width); const height = Math.ceil(input.bounds.height);
  if (left < 0 || top < 0 || left + width > input.source.width || top + height > input.source.height) throw new Error("Part extraction bounds leave the source image");
  if (input.mask && (input.mask.width !== width || input.mask.height !== height)) throw new Error("Part mask dimensions must match crop bounds");
  const outputWidth = width + padding * 2; const outputHeight = height + padding * 2;
  const data = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sourceOffset = ((top + y) * input.source.width + left + x) * 4;
    const targetOffset = ((y + padding) * outputWidth + x + padding) * 4;
    data[targetOffset] = input.source.data[sourceOffset]; data[targetOffset + 1] = input.source.data[sourceOffset + 1]; data[targetOffset + 2] = input.source.data[sourceOffset + 2];
    const maskAlpha = input.mask?.alpha[y * width + x] ?? 255;
    data[targetOffset + 3] = Math.round(input.source.data[sourceOffset + 3] * maskAlpha / 255);
  }
  return { width: outputWidth, height: outputHeight, data };
}

export async function extractPartToDataUrl(imageSource: string, bounds: Rect, mask?: SegmentationMask, padding = 0): Promise<string> {
  const image = new Image(); image.crossOrigin = "anonymous"; image.src = imageSource;
  await image.decode();
  const sourceCanvas = document.createElement("canvas"); sourceCanvas.width = image.naturalWidth; sourceCanvas.height = image.naturalHeight;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true }); if (!sourceContext) throw new Error("Canvas extraction is unavailable");
  sourceContext.drawImage(image, 0, 0);
  const sourceData = sourceContext.getImageData(0, 0, image.naturalWidth, image.naturalHeight);
  const scaleX = image.naturalWidth / Math.max(bounds.x + bounds.width, image.naturalWidth); const scaleY = image.naturalHeight / Math.max(bounds.y + bounds.height, image.naturalHeight);
  const actualBounds = { x: Math.floor(bounds.x * scaleX), y: Math.floor(bounds.y * scaleY), width: Math.max(1, Math.round(bounds.width * scaleX)), height: Math.max(1, Math.round(bounds.height * scaleY)) };
  const extracted = extractPartPixels({ source: sourceData, bounds: actualBounds, mask, padding });
  const output = document.createElement("canvas"); output.width = extracted.width; output.height = extracted.height;
  const outputContext = output.getContext("2d"); if (!outputContext) throw new Error("Canvas extraction is unavailable");
  const imageBytes = new Uint8ClampedArray(extracted.data.length); imageBytes.set(extracted.data);
  outputContext.putImageData(new ImageData(imageBytes, extracted.width, extracted.height), 0, 0);
  return output.toDataURL("image/png");
}
