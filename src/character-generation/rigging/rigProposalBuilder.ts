import type { AttachmentDefinition, RigDefinition } from "../../rigging/schema/types";
import type { ProposedCharacterPart } from "../segmentation/segmentationSchema";
import { buildProposedHierarchy } from "./hierarchyBuilder";
import { estimatePartPivot, localPivot } from "./pivotEstimator";
import type { RigProposal } from "./rigProposalSchema";
import { assignSlots } from "./slotAssignment";

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "generated-character";

export type RigProposalBuildInput = { readonly name: string; readonly parts: readonly ProposedCharacterPart[]; readonly imageWidth: number; readonly imageHeight: number; readonly resolvedImages?: Readonly<Record<string, string>> };

export function buildRigProposal(input: RigProposalBuildInput): RigProposal {
  const accepted = input.parts.filter((part) => part.accepted && part.semanticType !== "rootReference");
  if (!accepted.length) throw new Error("At least one accepted part is required to propose a rig");
  const hierarchy = buildProposedHierarchy(accepted, input.imageWidth, input.imageHeight);
  const pivots: Record<string, { x: number; y: number }> = {};
  const attachments: AttachmentDefinition[] = accepted.map((part) => {
    // Keep source-pixel dimensions. Semantic fixture sizes caused freshly cut
    // characters to drift away from their original static pose.
    const width = part.bounds.width; const height = part.bounds.height;
    pivots[part.id] = localPivot(estimatePartPivot(part).point, part.bounds, width, height);
    return { id: part.id, imagePath: input.resolvedImages?.[part.id] ?? part.fixtureImagePath ?? input.resolvedImages?.source ?? "/rig-test/body-base.png", width, height, offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1, category: /Equipment|helmet|hair|cape|accessory/i.test(part.semanticType) ? "equipment" : "body", tags: [part.semanticType, part.provenance] };
  });
  const slots = assignSlots(accepted, pivots);
  const skinAttachments = Object.fromEntries(slots.map((slot) => [slot.id, slot.attachmentId]));
  const id = `rig-${slug(input.name)}`;
  const warnings = accepted.flatMap((part) => part.warnings.map((warning) => `${part.id}: ${warning}`));
  if (accepted.some((part) => part.semanticType === "torso" && !accepted.some((candidate) => candidate.semanticType === "accessory"))) warnings.push("Torso armor is currently part of the base body attachment and cannot be swapped independently.");
  const rig: RigDefinition = {
    schemaVersion: 1, id, canvas: { width: input.imageWidth, height: input.imageHeight }, rootBoneId: "root", bones: hierarchy.bones,
    slots, attachments, skins: [{ id: "default", name: "Default", slotAttachments: skinAttachments }], defaultSkinId: "default",
    metadata: { name: input.name, authoringSource: "generated-character-pipeline", rotationUnit: "degrees", coordinateSystem: "x-right-y-down", generatedAt: new Date(0).toISOString() },
  };
  return { proposalVersion: 1, rig, confidence: hierarchy.confidence, warnings };
}
