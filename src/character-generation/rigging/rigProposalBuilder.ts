import type { AttachmentDefinition, RigDefinition } from "../../rigging/schema/types";
import type { PartCutterState } from "../../part-cutter/schema";
import type { ProposedCharacterPart } from "../segmentation/segmentationSchema";
import { PART_RIGGING_SPECS } from "../segmentation/partTaxonomy";
import type { AutoRigTopology } from "./autoRigTopology";
import { buildProposedHierarchy } from "./hierarchyBuilder";
import { localPivot } from "./pivotEstimator";
import { resolvePartPivot } from "./pivotResolver";
import type { RigProposal } from "./rigProposalSchema";
import { assignSlots } from "./slotAssignment";

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "generated-character";

export type RigProposalBuildInput = {
  readonly name: string;
  readonly parts: readonly ProposedCharacterPart[];
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly resolvedImages?: Readonly<Record<string, string>>;
  readonly partCutterState?: PartCutterState;
  readonly topology?: AutoRigTopology;
};

export function buildRigProposal(input: RigProposalBuildInput): RigProposal {
  const accepted = input.parts.filter((part) => part.accepted && part.semanticType !== "rootReference");
  if (!accepted.length) throw new Error("At least one accepted part is required to propose a rig");
  const hierarchy = buildProposedHierarchy(accepted, input.imageWidth, input.imageHeight, { name: input.name, partCutterState: input.partCutterState, topology: input.topology });
  const pivots: Record<string, { x: number; y: number }> = {};
  const attachmentPivotSources: Record<string, string> = {};
  const bindingSources: Record<string, string> = {};
  const attachments: AttachmentDefinition[] = accepted.map((part) => {
    // Keep source-pixel dimensions. Semantic fixture sizes caused freshly cut
    // characters to drift away from their original static pose.
    const width = part.bounds.width; const height = part.bounds.height;
    const resolved = resolvePartPivot(part, accepted, input.partCutterState);
    pivots[part.id] = localPivot(resolved.point, part.bounds, width, height);
    attachmentPivotSources[part.id] = resolved.source;
    const prepared = input.partCutterState?.parts.find((candidate) => candidate.partId === part.id);
    const spec = PART_RIGGING_SPECS[part.semanticType];
    bindingSources[part.id] = `${spec.bindingKind}:semantic:${spec.boneId}`;
    return { id: part.id, imagePath: input.resolvedImages?.[part.id] ?? part.fixtureImagePath ?? input.resolvedImages?.source ?? "/rig-test/body-base.png", width, height, offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1, category: prepared?.equipment || spec.bindingKind !== "body" ? "equipment" : "body", tags: [part.semanticType, part.provenance, spec.bindingKind] };
  });
  const visibleSlots = assignSlots(accepted, pivots);
  const requiredVisuals = ["head", "torso", "leftUpperArm", "leftForearm", "leftHand", "rightUpperArm", "rightForearm", "rightHand", "leftThigh", "leftLowerLeg", "leftFoot", "rightThigh", "rightLowerLeg", "rightFoot"] as const;
  const hiddenAnatomy = requiredVisuals.filter((semanticType) => !accepted.some((part) => part.semanticType === semanticType)).map((semanticType) => PART_RIGGING_SPECS[semanticType].boneId);
  const hiddenSlots = hiddenAnatomy.map((boneId) => ({ id: `${boneId}-hidden-slot`, boneId, attachmentId: null, zIndex: -20, visible: false, blendMode: "normal" as const, tint: 0xffffff, pivotX: 0, pivotY: 0 }));
  const slots = [...visibleSlots, ...hiddenSlots];
  const skinAttachments = Object.fromEntries(slots.map((slot) => [slot.id, slot.attachmentId]));
  const id = `rig-${slug(input.name)}`;
  const warnings = accepted.flatMap((part) => part.warnings.map((warning) => `${part.id}: ${warning}`));
  if (accepted.some((part) => part.semanticType === "torso" && !accepted.some((candidate) => candidate.semanticType === "accessory"))) warnings.push("Torso armor is currently part of the base body attachment and cannot be swapped independently.");
  const rig: RigDefinition = {
    schemaVersion: 1, id, canvas: { width: input.imageWidth, height: input.imageHeight }, rootBoneId: "root", bones: hierarchy.bones,
    slots, attachments, skins: [{ id: "default", name: "Default", slotAttachments: skinAttachments }], defaultSkinId: "default",
    metadata: {
      name: input.name, authoringSource: "generated-character-pipeline", rotationUnit: "degrees", coordinateSystem: "x-right-y-down", generatedAt: new Date(0).toISOString(),
      anatomyProfile: hierarchy.topology.topology, topologySource: hierarchy.topology.source, topologySupported: hierarchy.topology.supported,
      pivotSources: Object.fromEntries(Object.entries(hierarchy.pivotSources).map(([boneId, pivot]) => [boneId, { source: pivot.source, confidence: pivot.confidence, detail: pivot.detail, point: pivot.point }])),
      attachmentPivotSources, bindingSources, hiddenAnatomy, expectedAnimationTargets: hierarchy.bones.map((bone) => bone.id), manualOverrides: { bones: {}, slots: {}, attachments: {} },
    },
  };
  return { proposalVersion: 1, rig, confidence: hierarchy.confidence, warnings };
}
