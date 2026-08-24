import type { CharacterSegmentationResponse, ProposedCharacterPart, Rect, SegmentationMask } from "../character-generation/segmentation/segmentationSchema";
import { SEMANTIC_TAXONOMY, type PartLayerGroup, type PartSemanticType } from "./semanticTaxonomy";
import { partCutProposalSchema, type AnatomicalLandmark, type AnatomicalLandmarkId, type AnatomicalPartitionGuide, type AnatomicalZone, type PartCutProposal, type PartCutterState, type ProposedPartCut } from "./schema";

const BODY_ZONE_TYPES = [
  "head", "torso", "pelvis",
  "leftUpperArm", "leftForearm", "leftHand",
  "rightUpperArm", "rightForearm", "rightHand",
  "leftThigh", "leftLowerLeg", "leftFoot",
  "rightThigh", "rightLowerLeg", "rightFoot",
] as const satisfies readonly PartSemanticType[];

const LANDMARK_SPECS: readonly [AnatomicalLandmarkId, number, number, AnatomicalLandmarkId | null][] = [
  ["root", .5, .96, null], ["pelvis", .5, .55, "root"], ["chest", .5, .34, "pelvis"], ["neck", .5, .23, "chest"], ["head", .5, .12, "neck"],
  ["leftShoulder", .39, .28, "chest"], ["leftElbow", .29, .43, "leftShoulder"], ["leftWrist", .25, .58, "leftElbow"],
  ["rightShoulder", .61, .28, "chest"], ["rightElbow", .71, .43, "rightShoulder"], ["rightWrist", .75, .58, "rightElbow"],
  ["leftHip", .44, .58, "pelvis"], ["leftKnee", .41, .76, "leftHip"], ["leftAnkle", .39, .91, "leftKnee"],
  ["rightHip", .56, .58, "pelvis"], ["rightKnee", .59, .76, "rightHip"], ["rightAnkle", .61, .91, "rightKnee"],
];

type ZoneSpec = readonly [PartSemanticType, PartSemanticType | null, readonly AnatomicalLandmarkId[], number, number, number, number];
const BODY_ZONE_SPECS: readonly ZoneSpec[] = [
  ["head", "torso", ["neck", "head"], .32, .02, .36, .25],
  ["torso", "pelvis", ["pelvis", "chest", "neck"], .30, .21, .40, .37],
  ["pelvis", null, ["pelvis", "leftHip", "rightHip"], .35, .49, .30, .15],
  ["leftUpperArm", "torso", ["leftShoulder", "leftElbow"], .16, .22, .31, .27],
  ["leftForearm", "leftUpperArm", ["leftElbow", "leftWrist"], .10, .37, .30, .26],
  ["leftHand", "leftForearm", ["leftWrist"], .09, .52, .24, .16],
  ["rightUpperArm", "torso", ["rightShoulder", "rightElbow"], .53, .22, .31, .27],
  ["rightForearm", "rightUpperArm", ["rightElbow", "rightWrist"], .60, .37, .30, .26],
  ["rightHand", "rightForearm", ["rightWrist"], .67, .52, .24, .16],
  ["leftThigh", "pelvis", ["leftHip", "leftKnee"], .29, .54, .25, .26],
  ["leftLowerLeg", "leftThigh", ["leftKnee", "leftAnkle"], .27, .71, .24, .24],
  ["leftFoot", "leftLowerLeg", ["leftAnkle"], .21, .87, .31, .11],
  ["rightThigh", "pelvis", ["rightHip", "rightKnee"], .46, .54, .25, .26],
  ["rightLowerLeg", "rightThigh", ["rightKnee", "rightAnkle"], .49, .71, .24, .24],
  ["rightFoot", "rightLowerLeg", ["rightAnkle"], .48, .87, .31, .11],
];

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const integerBounds = (bounds: Rect, width: number, height: number): Rect => {
  const x = clamp(Math.floor(bounds.x), 0, Math.max(0, width - 1));
  const y = clamp(Math.floor(bounds.y), 0, Math.max(0, height - 1));
  const right = clamp(Math.ceil(bounds.x + bounds.width), x + 1, width);
  const bottom = clamp(Math.ceil(bounds.y + bounds.height), y + 1, height);
  return { x, y, width: right - x, height: bottom - y };
};
const normalizedBounds = (width: number, height: number, x: number, y: number, zoneWidth: number, zoneHeight: number): Rect => integerBounds({ x: x * width, y: y * height, width: zoneWidth * width, height: zoneHeight * height }, width, height);
const zoneIdFor = (semanticType: PartSemanticType): string => semanticType;
const semanticFromProvider = (part: ProposedCharacterPart): PartSemanticType | null => {
  const semanticType = part.semanticType === "rootReference" ? "root" : part.semanticType === "shoulderLeft" ? "leftShoulderArmor" : part.semanticType === "shoulderRight" ? "rightShoulderArmor" : part.semanticType;
  return semanticType in SEMANTIC_TAXONOMY ? semanticType as PartSemanticType : null;
};

export function buildAnatomicalPartitionGuide(state: Pick<PartCutterState, "sourceCanvasSize" | "parts" | "anatomicalGuide">, profile: AnatomicalPartitionGuide["profile"] = "humanoid", timestamp = new Date().toISOString()): AnatomicalPartitionGuide {
  const { width, height } = state.sourceCanvasSize;
  const existingByType = new Map(state.parts.map((part) => [part.semanticType, part]));
  const previous = state.anatomicalGuide?.sourceCanvasSize.width === width && state.anatomicalGuide.sourceCanvasSize.height === height ? state.anatomicalGuide : undefined;
  const previousLandmarks = new Map(previous?.landmarks.map((landmark) => [landmark.landmarkId, landmark]) ?? []);
  const landmarks: AnatomicalLandmark[] = LANDMARK_SPECS.map(([landmarkId, x, y, parentLandmarkId]) => previousLandmarks.get(landmarkId) ?? { landmarkId, point: { x: Math.round(x * width), y: Math.round(y * height) }, parentLandmarkId });
  const baseZones = BODY_ZONE_SPECS.map(([semanticType, parentType, anchorLandmarkIds, x, y, zoneWidth, zoneHeight]): AnatomicalZone => {
    const existing = existingByType.get(semanticType); const prior = previous?.zones.find((zone) => zone.semanticType === semanticType);
    return prior ?? { zoneId: zoneIdFor(semanticType), semanticType, label: SEMANTIC_TAXONOMY[semanticType].label, parentZoneId: parentType ? zoneIdFor(parentType) : null, anchorLandmarkIds, bounds: existing?.boundingBox ?? normalizedBounds(width, height, x, y, zoneWidth, zoneHeight), optional: false, refinementMargin: Math.max(2, Math.round(Math.min(width, height) * .035)) };
  });
  const guidedTypes = new Set<PartSemanticType>(BODY_ZONE_TYPES);
  const optionalParts = [...new Map(state.parts.filter((part) => !guidedTypes.has(part.semanticType) && part.semanticType !== "root").map((part) => [part.semanticType, part])).values()];
  const optionalZones = optionalParts.map((part): AnatomicalZone => {
    const prior = previous?.zones.find((zone) => zone.semanticType === part.semanticType);
    if (prior) return prior;
    const defaults = SEMANTIC_TAXONOMY[part.semanticType];
    const parentType = state.parts.find((candidate) => candidate.partId === part.suggestedParent)?.semanticType ?? (defaults.suggestedParentBone === "head" ? "head" : defaults.suggestedParentBone === "pelvis" ? "pelvis" : "torso");
    return { zoneId: zoneIdFor(part.semanticType), semanticType: part.semanticType, label: part.label, parentZoneId: parentType && parentType !== part.semanticType ? zoneIdFor(parentType as PartSemanticType) : null, anchorLandmarkIds: defaults.suggestedParentBone === "head" ? ["head"] : defaults.suggestedParentBone === "pelvis" ? ["pelvis"] : ["chest"], bounds: part.boundingBox, optional: true, refinementMargin: Math.max(2, Math.round(Math.min(width, height) * .035)) };
  });
  return { guideVersion: 1, profile, sourceCanvasSize: state.sourceCanvasSize, landmarks, zones: [...baseZones, ...optionalZones], status: previous?.status ?? "seeded", createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp };
}

export function anatomicalGuidePrompt(guide: AnatomicalPartitionGuide, instruction: string): string {
  const zones = guide.zones.map((zone) => `${zone.zoneId}=${zone.semanticType}; parent=${zone.parentZoneId ?? "skeleton-root"}; bounds=${zone.bounds.x},${zone.bounds.y},${zone.bounds.width},${zone.bounds.height}`).join("\n");
  return `${instruction}\n\nRig Studio has already established the landmark skeleton and anatomical hierarchy below. Refine boundary pixels for these exact zone IDs only. Return at most one mask per zone, preserve each semantic identity and parent, and do not invent, split, merge, rename, or reposition parts. Pixels outside a zone envelope will be discarded.\n${zones}`;
}

const expandBounds = (bounds: Rect, margin: number, width: number, height: number): Rect => integerBounds({ x: bounds.x - margin, y: bounds.y - margin, width: bounds.width + margin * 2, height: bounds.height + margin * 2 }, width, height);
const intersectBounds = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x); const y = Math.max(a.y, b.y); const right = Math.min(a.x + a.width, b.x + b.width); const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
};
export type ConstrainedRefinementMask = {
  readonly bounds: Rect;
  readonly mask: SegmentationMask;
  readonly proposedPixelCount: number;
  readonly acceptedPixelCount: number;
  readonly clippedPixelCount: number;
  readonly clippedPercentage: number;
};

export const constrainProviderMaskToZone = (part: ProposedCharacterPart, zone: AnatomicalZone, canvasWidth: number, canvasHeight: number): ConstrainedRefinementMask | null => {
  if (!part.mask) return null;
  const allowed = zone.mask ? zone.bounds : expandBounds(zone.bounds, zone.refinementMargin, canvasWidth, canvasHeight);
  const providerBounds = integerBounds(part.bounds, canvasWidth, canvasHeight); const overlap = intersectBounds(providerBounds, allowed);
  const proposedPixelCount = part.mask.alpha.filter((value) => value > 0).length;
  if (!overlap) return null;
  const bounds = integerBounds(overlap, canvasWidth, canvasHeight); const alpha = new Array<number>(bounds.width * bounds.height).fill(0);
  const sourceLeft = Math.round(part.bounds.x); const sourceTop = Math.round(part.bounds.y);
  for (let y = 0; y < bounds.height; y += 1) for (let x = 0; x < bounds.width; x += 1) {
    const sourceX = bounds.x + x - sourceLeft; const sourceY = bounds.y + y - sourceTop;
    if (sourceX >= 0 && sourceY >= 0 && sourceX < part.mask.width && sourceY < part.mask.height) {
      const globalX = bounds.x + x; const globalY = bounds.y + y; const zoneX = globalX - Math.round(zone?.bounds.x ?? 0); const zoneY = globalY - Math.round(zone?.bounds.y ?? 0);
      const insideAdaptiveZone = !zone?.mask || (zoneX >= 0 && zoneY >= 0 && zoneX < zone.mask.width && zoneY < zone.mask.height && (zone.mask.alpha[zoneY * zone.mask.width + zoneX] ?? 0) > 0);
      if (insideAdaptiveZone) alpha[y * bounds.width + x] = part.mask.alpha[sourceY * part.mask.width + sourceX] ?? 0;
    }
  }
  const acceptedPixelCount = alpha.filter((value) => value > 0).length;
  if (!acceptedPixelCount) return null;
  const clippedPixelCount = Math.max(0, proposedPixelCount - acceptedPixelCount);
  return {
    bounds,
    mask: { width: bounds.width, height: bounds.height, alpha },
    proposedPixelCount,
    acceptedPixelCount,
    clippedPixelCount,
    clippedPercentage: proposedPixelCount ? clippedPixelCount / proposedPixelCount : 0,
  };
};
const layerOrder: Readonly<Record<PartLayerGroup, number>> = { back: -10, body: 0, front: 10 };
const pivotForZone = (zone: AnatomicalZone, guide: AnatomicalPartitionGuide): { x: number; y: number } => {
  const points = zone.anchorLandmarkIds.map((id) => guide.landmarks.find((landmark) => landmark.landmarkId === id)?.point).filter((point): point is { x: number; y: number } => Boolean(point));
  return points.length ? { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length } : { x: zone.bounds.x + zone.bounds.width / 2, y: zone.bounds.y + zone.bounds.height / 2 };
};

export function guidedProposalFromSegmentation(response: CharacterSegmentationResponse, guide: AnatomicalPartitionGuide, instruction: string, parentProposalId?: string, createdAt = new Date().toISOString()): PartCutProposal {
  if (response.imageWidth !== guide.sourceCanvasSize.width || response.imageHeight !== guide.sourceCanvasSize.height) throw new Error("Segmentation canvas does not match the anatomical guide");
  const byType = new Map<PartSemanticType, ProposedCharacterPart[]>();
  response.parts.forEach((part) => { const type = semanticFromProvider(part); if (!type) return; byType.set(type, [...(byType.get(type) ?? []), part]); });
  const acceptedProviderIds = new Set<string>(); const warnings = [...response.warnings]; const parts: ProposedPartCut[] = []; const refinementMetrics: ConstrainedRefinementMask[] = [];
  guide.zones.forEach((zone) => {
    const candidates = byType.get(zone.semanticType) ?? []; const candidate = candidates[0];
    if (!candidate) { if (!zone.optional) warnings.push(`AI omitted predetermined zone ${zone.zoneId}; it remains available for manual assignment.`); return; }
    acceptedProviderIds.add(candidate.id); candidates.slice(1).forEach((duplicate) => warnings.push(`Ignored duplicate AI region ${duplicate.id}; ${zone.zoneId} permits one mask.`));
    if (!candidate.mask && response.providerMetadata.imageConditioned === true && response.providerMetadata.mock !== true) throw new Error(`Image-conditioned provider omitted the pixel mask for ${candidate.id}`);
    const candidateWithMask = candidate.mask ? candidate : { ...candidate, mask: { width: Math.max(1, Math.round(candidate.bounds.width)), height: Math.max(1, Math.round(candidate.bounds.height)), alpha: new Array<number>(Math.max(1, Math.round(candidate.bounds.width)) * Math.max(1, Math.round(candidate.bounds.height))).fill(255) } };
    const constrained = constrainProviderMaskToZone(candidateWithMask, zone, response.imageWidth, response.imageHeight);
    if (!constrained) { warnings.push(`AI mask ${candidate.id} did not overlap ${zone.zoneId} and was ignored.`); return; }
    refinementMetrics.push(constrained);
    const defaults = SEMANTIC_TAXONOMY[zone.semanticType]; const notes = [...candidate.warnings, `Landmark-guided refinement of ${zone.zoneId}`, `Refinement pixels: proposed=${constrained.proposedPixelCount}; accepted=${constrained.acceptedPixelCount}; clipped=${constrained.clippedPixelCount}; clippedPercent=${(constrained.clippedPercentage * 100).toFixed(2)}`, ...(constrained.clippedPixelCount ? ["Pixels outside the anatomical zone envelope were discarded"] : [])];
    parts.push({ proposedPartId: zone.zoneId, label: zone.label, semanticType: zone.semanticType, mask: constrained.mask, boundingBox: constrained.bounds, sourceBoundingBox: constrained.bounds, sourceCanvasSize: guide.sourceCanvasSize, pivot: pivotForZone(zone, guide), suggestedParent: defaults.suggestedParentBone, suggestedSlot: `${zone.zoneId}-slot`, zOrder: layerOrder[defaults.defaultLayerGroup], layer: defaults.defaultLayerGroup, confidence: candidate.confidence, confidenceSource: candidate.confidenceSource, articulated: defaults.articulated, equipment: defaults.equipment, occlusionState: candidate.warnings.some((warning) => /hidden|occluded|beneath|overlap/i.test(warning)) ? "likely-incomplete" : "complete", provenance: "ai", selected: candidate.confidence !== null && candidate.confidence >= .8 && candidate.warnings.length === 0 && constrained.clippedPixelCount === 0, notes });
  });
  response.parts.filter((part) => !acceptedProviderIds.has(part.id)).forEach((part) => warnings.push(`Ignored provider-invented region ${part.id}; it is not a predetermined anatomical zone.`));
  const proposedPixels = refinementMetrics.reduce((sum, item) => sum + item.proposedPixelCount, 0); const acceptedPixels = refinementMetrics.reduce((sum, item) => sum + item.acceptedPixelCount, 0); const clippedPixels = refinementMetrics.reduce((sum, item) => sum + item.clippedPixelCount, 0);
  return partCutProposalSchema.parse({ proposalId: `guided-cut-${Date.now().toString(36)}`, sourceImageId: response.segmentationId.replace(/^segment-/, ""), instruction, parts, warnings, assumptions: ["Landmarks, semantic identities, hierarchy, pivots, and zone envelopes are project-owned", "AI may refine boundary pixels only inside predetermined zones", "No proposed cut is accepted automatically"], status: "pending", providerMetadata: { ...response.providerMetadata, guideVersion: guide.guideVersion, partitionStrategy: "landmark-guided-hierarchical", guideZoneCount: guide.zones.length, proposedPixels, acceptedPixels, clippedPixels, clippedPercentage: proposedPixels ? clippedPixels / proposedPixels : 0, clipFightZoneCount: refinementMetrics.filter((item) => item.clippedPercentage > .25).length }, ...(parentProposalId ? { parentProposalId } : {}), createdAt });
}

export function installAnatomicalGuide(state: PartCutterState, guide: AnatomicalPartitionGuide, status: AnatomicalPartitionGuide["status"] = guide.status): PartCutterState {
  return { ...state, anatomicalGuide: { ...guide, status, updatedAt: new Date().toISOString() }, finalized: false, updatedAt: new Date().toISOString() };
}
