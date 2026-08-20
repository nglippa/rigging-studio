import { characterSegmentationResponseSchema, type CharacterSegmentationResponse } from "./segmentationSchema";
import { REQUIRED_RIG_PARTS, type PartType } from "./partTaxonomy";

export type SegmentationValidation = {
  readonly success: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly data?: CharacterSegmentationResponse;
};

export function validateSegmentationResponse(input: unknown): SegmentationValidation {
  const parsed = characterSegmentationResponseSchema.safeParse(input);
  if (!parsed.success) return { success: false, errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "segmentation"}: ${issue.message}`), warnings: [] };
  const errors: string[] = [];
  const warnings: string[] = [...parsed.data.warnings];
  const ids = new Set<string>();
  const semanticCounts = new Map<PartType, number>();
  parsed.data.parts.forEach((part) => {
    if (ids.has(part.id)) errors.push(`Duplicate part ID "${part.id}"`);
    ids.add(part.id);
    semanticCounts.set(part.semanticType, (semanticCounts.get(part.semanticType) ?? 0) + 1);
    if (part.bounds.x < 0 || part.bounds.y < 0 || part.bounds.x + part.bounds.width > parsed.data.imageWidth || part.bounds.y + part.bounds.height > parsed.data.imageHeight) errors.push(`${part.id}: crop bounds leave the source image`);
    if (part.pivotHint.x < part.bounds.x || part.pivotHint.x > part.bounds.x + part.bounds.width || part.pivotHint.y < part.bounds.y || part.pivotHint.y > part.bounds.y + part.bounds.height) errors.push(`${part.id}: pivot is outside its part bounds`);
    if (part.confidence === null && part.confidenceSource !== "unavailable") errors.push(`${part.id}: null confidence must use confidenceSource unavailable`);
    if (part.confidence !== null && part.confidenceSource === "unavailable") errors.push(`${part.id}: unavailable confidence source must not include a numeric confidence`);
    if (!part.mask) {
      if (parsed.data.providerMetadata.imageConditioned === true && parsed.data.providerMetadata.mock !== true) errors.push(`${part.id}: image-conditioned segmentation omitted its pixel mask`);
      return;
    }
    const expectedWidth = Math.max(1, Math.round(part.bounds.width));
    const expectedHeight = Math.max(1, Math.round(part.bounds.height));
    if (part.mask.width !== expectedWidth || part.mask.height !== expectedHeight) errors.push(`${part.id}: mask dimensions do not match its source bounding box`);
    const opaque = part.mask.alpha.filter((alpha) => alpha > 0).length;
    if (opaque === 0) errors.push(`${part.id}: mask is empty`);
    const footprint = opaque / Math.max(1, part.mask.width * part.mask.height);
    if (opaque > 0 && footprint < .005) warnings.push(`${part.id}: mask occupies less than 0.5% of its bounding box`);
    if (part.mask.alpha.some((alpha) => !Number.isInteger(alpha) || alpha < 0 || alpha > 255)) errors.push(`${part.id}: mask alpha contains invalid values`);
  });
  REQUIRED_RIG_PARTS.forEach((part) => {
    const count = semanticCounts.get(part) ?? 0;
    if (count === 0) warnings.push(`Missing recommended part: ${part}`);
    if (count > 1) warnings.push(`Multiple parts assigned as ${part}`);
  });
  return { success: errors.length === 0, errors, warnings, data: parsed.data };
}
