import type { ProposedCharacterPart } from "../segmentation/segmentationSchema";
import { PART_RIGGING_SPECS } from "../segmentation/partTaxonomy";

export const estimateZIndex = (part: ProposedCharacterPart): number => PART_RIGGING_SPECS[part.semanticType].zIndex;
export const sortPartsByZOrder = (parts: readonly ProposedCharacterPart[]): readonly ProposedCharacterPart[] => [...parts].sort((a, b) => estimateZIndex(a) - estimateZIndex(b) || a.id.localeCompare(b.id));
