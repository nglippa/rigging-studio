import type { SlotDefinition } from "../../rigging/schema/types";
import type { ProposedCharacterPart } from "../segmentation/segmentationSchema";
import { partTypeToBoneId } from "../segmentation/partTaxonomy";
import { estimateZIndex } from "./zOrderEstimator";

export function assignSlots(parts: readonly ProposedCharacterPart[], pivots: Readonly<Record<string, { readonly x: number; readonly y: number }>>): readonly SlotDefinition[] {
  return parts.filter((part) => part.accepted && part.semanticType !== "rootReference").map((part) => ({
    id: `${part.id}-slot`, boneId: part.suggestedBoneId || partTypeToBoneId(part.semanticType), attachmentId: part.id,
    zIndex: estimateZIndex(part), visible: true, blendMode: "normal", tint: 0xffffff,
    pivotX: pivots[part.id]?.x ?? part.bounds.width / 2, pivotY: pivots[part.id]?.y ?? part.bounds.height / 2,
  }));
}
