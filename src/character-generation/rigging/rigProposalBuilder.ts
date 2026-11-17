import type { AttachmentDefinition, RigDefinition, SlotDefinition } from "../../rigging/schema/types";
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
  /** Where each resolved image sits on the source canvas when it is larger than the part's own cut (joint caps). */
  readonly artBounds?: Readonly<Record<string, { readonly x: number; readonly y: number; readonly width: number; readonly height: number }>>;
  readonly partCutterState?: PartCutterState;
  readonly topology?: AutoRigTopology;
};

/**
 * Version of the art preparation a generated rig was built with. 1: joint caps and hidden-area fill.
 * 2: texture-mirroring fill, joints across gaps, far leg for side views. Older rigs are offered a rebuild.
 */
export const ART_PREPARATION_VERSION = 2;

/** True for a rig built from cut parts before the current art preparation (gap filling, far leg). */
export const needsArtRebuild = (rig: RigDefinition): boolean =>
  rig.metadata.authoringSource === "generated-character-pipeline" && Number(rig.metadata.artPreparation ?? 0) < ART_PREPARATION_VERSION;

/** The far leg of a side view is drawn in shadow: a darker copy of the near leg. */
const FAR_LEG_TINT = 0x8a8a8a;

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
    // Art that was extended for joint caps is larger than the cut itself; its own bounds place it.
    const art = input.artBounds?.[part.id] ?? part.bounds;
    const width = art.width; const height = art.height;
    const resolved = resolvePartPivot(part, accepted, input.partCutterState);
    pivots[part.id] = localPivot(resolved.point, art, width, height);
    attachmentPivotSources[part.id] = resolved.source;
    const prepared = input.partCutterState?.parts.find((candidate) => candidate.partId === part.id);
    const spec = PART_RIGGING_SPECS[part.semanticType];
    bindingSources[part.id] = `${spec.bindingKind}:semantic:${spec.boneId}`;
    // The art's anchor is its own pivot; the bone sits at its joint. They coincide for a body part, but equipment rides on a
    // hand or torso bone that is somewhere else, so the offset carries the difference and the art stays where it was drawn.
    const joint = hierarchy.worldJoints[spec.boneId];
    const offsetX = joint ? resolved.point.x - joint.x : 0; const offsetY = joint ? resolved.point.y - joint.y : 0;
    return { id: part.id, imagePath: input.resolvedImages?.[part.id] ?? part.fixtureImagePath ?? input.resolvedImages?.source ?? "/rig-test/body-base.png", width, height, offsetX, offsetY, rotation: 0, scaleX: 1, scaleY: 1, category: prepared?.equipment || spec.bindingKind !== "body" ? "equipment" : "body", tags: [part.semanticType, part.provenance, spec.bindingKind] };
  });
  const visibleSlots = assignSlots(accepted, pivots);
  const requiredVisuals = ["head", "torso", "leftUpperArm", "leftForearm", "leftHand", "rightUpperArm", "rightForearm", "rightHand", "leftThigh", "leftLowerLeg", "leftFoot", "rightThigh", "rightLowerLeg", "rightFoot"] as const;
  const hiddenAnatomy = requiredVisuals.filter((semanticType) => !accepted.some((part) => part.semanticType === semanticType)).map((semanticType) => PART_RIGGING_SPECS[semanticType].boneId);
  // A side view hides the far leg behind the near one. When a whole leg was not drawn but its twin was, the far leg is
  // drawn as a darker copy of the near leg's art, behind the body, so a walk shows two legs instead of one. Its bones
  // already sit on the near leg's joints, so at rest the copy is hidden exactly behind the original.
  const LEGS = { left: ["leftThigh", "leftLowerLeg", "leftFoot"], right: ["rightThigh", "rightLowerLeg", "rightFoot"] } as const;
  const farLeg = (["left", "right"] as const).find((side) => LEGS[side].every((semantic) => !accepted.some((part) => part.semanticType === semantic)) && LEGS[side === "left" ? "right" : "left"].some((semantic) => accepted.some((part) => part.semanticType === semantic)));
  const backmost = Math.min(0, ...visibleSlots.map((slot) => slot.zIndex));
  const farLegSlots: SlotDefinition[] = farLeg ? LEGS[farLeg].flatMap((semantic, index) => {
    const twinSemantic = LEGS[farLeg === "left" ? "right" : "left"][index];
    const twin = accepted.find((part) => part.semanticType === twinSemantic);
    const twinSlot = twin ? visibleSlots.find((slot) => slot.attachmentId === twin.id) : undefined;
    if (!twin || !twinSlot) return [];
    const boneId = PART_RIGGING_SPECS[semantic].boneId;
    return [{ ...twinSlot, id: `${boneId}-far-slot`, boneId, zIndex: backmost - 3 + index, tint: FAR_LEG_TINT }];
  }) : [];
  const drawnFar = new Set(farLegSlots.map((slot) => slot.boneId));
  const hiddenSlots = hiddenAnatomy.filter((boneId) => !drawnFar.has(boneId)).map((boneId) => ({ id: `${boneId}-hidden-slot`, boneId, attachmentId: null, zIndex: -20, visible: false, blendMode: "normal" as const, tint: 0xffffff, pivotX: 0, pivotY: 0 }));
  const slots = [...farLegSlots, ...visibleSlots, ...hiddenSlots];
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
      // The far leg was still not drawn; it is a stand-in, so it stays listed as hidden anatomy.
      attachmentPivotSources, bindingSources, hiddenAnatomy, farLegFrom: farLeg ? (farLeg === "left" ? "right" : "left") : null, artPreparation: input.artBounds ? ART_PREPARATION_VERSION : 0, expectedAnimationTargets: hierarchy.bones.map((bone) => bone.id), manualOverrides: { bones: {}, slots: {}, attachments: {} },
    },
  };
  return { proposalVersion: 1, rig, confidence: hierarchy.confidence, warnings };
}
