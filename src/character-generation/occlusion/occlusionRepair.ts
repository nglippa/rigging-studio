import type { ProposedCharacterPart } from "../segmentation/segmentationSchema";

export const OCCLUSION_DECISIONS = ["unreviewed", "keep-visible-fragment", "reconstruct", "acceptable", "regenerate-source"] as const;
export type OcclusionDecision = (typeof OCCLUSION_DECISIONS)[number];
export type OcclusionReview = {
  readonly partId: string;
  readonly likelyOccluded: boolean;
  readonly confidence: number;
  readonly reason: string;
  readonly decision: OcclusionDecision;
  readonly reconstructedImage?: string;
  readonly reconstructionAccepted: boolean;
  readonly previewResourceInspected?: string;
  readonly inspectedAt?: string;
  readonly inspectedBy?: string;
};

export const detectOcclusionReviews = (parts: readonly ProposedCharacterPart[]): readonly OcclusionReview[] => parts
  .filter((part) => part.warnings.some((warning) => /hidden|occluded|beneath|overlap/i.test(warning)))
  .map((part) => ({ partId: part.id, likelyOccluded: true, confidence: part.confidence === null ? .55 : Math.max(.55, 1 - part.confidence), reason: part.warnings.join(" "), decision: "unreviewed", reconstructionAccepted: false }));

export function acceptReconstruction(review: OcclusionReview, image: string): OcclusionReview {
  return { ...review, decision: "reconstruct", reconstructedImage: image, reconstructionAccepted: true };
}

export function rejectReconstruction(review: OcclusionReview): OcclusionReview {
  return { ...review, decision: "keep-visible-fragment", reconstructedImage: undefined, reconstructionAccepted: false };
}
