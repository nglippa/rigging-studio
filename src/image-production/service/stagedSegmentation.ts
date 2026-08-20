import type { PartType } from "../../character-generation/segmentation/partTaxonomy";
import type { Rect } from "../../character-generation/segmentation/segmentationSchema";

export type DetectionStage = "foreground" | "equipment" | "stable" | "left-arm" | "right-arm" | "left-leg" | "right-leg" | "optional";
export type ScreenSide = "screen-left" | "screen-right";

export type MaskSummary = {
  readonly bounds: Rect;
  readonly area: number;
  readonly bboxArea: number;
  readonly fillRatio: number;
  readonly centroid: { readonly x: number; readonly y: number };
  readonly areaRatio: number;
};

export type TrustedSemanticRegion = {
  readonly semanticType: PartType;
  readonly mask: Uint8Array;
  readonly summary: MaskSummary;
  readonly qualityScore: number;
};

export type SegmentationAnchors = Readonly<Partial<Record<PartType, TrustedSemanticRegion>>>;

export type CandidateQuality = {
  readonly score: number;
  readonly semanticConsistency: number;
  readonly hierarchyConsistency: number;
  readonly sizePlausibility: number;
  readonly positionPlausibility: number;
  readonly conflictingOverlap: number;
  readonly broad: boolean;
  readonly safe: boolean;
  readonly reasons: readonly string[];
};

export type SemanticReclassification = {
  readonly semanticType: PartType;
  readonly confidence: number;
  readonly ambiguous: boolean;
  readonly reason: string;
};

export type OverlapDecision = {
  readonly expected: boolean;
  readonly conflicting: boolean;
  readonly intersection: number;
  readonly fractionOfLeft: number;
  readonly fractionOfRight: number;
  readonly reason: string;
};

export type ResolvableMask = {
  readonly semanticType: PartType;
  readonly mask: Uint8Array;
  readonly qualityScore: number;
};

export const STAGED_CORE_TARGETS: readonly PartType[] = [
  "mainHandEquipment", "offHandEquipment",
  "head", "torso",
  "leftUpperArm", "leftForearm", "leftHand",
  "rightUpperArm", "rightForearm", "rightHand",
  "leftThigh", "leftLowerLeg", "leftFoot",
  "rightThigh", "rightLowerLeg", "rightFoot",
  "hair", "helmet",
];

export const DETECTOR_PHRASE_REGISTRY: Readonly<Record<PartType, readonly string[]>> = {
  rootReference: ["person"],
  torso: ["chest armor", "torso", "body armor", "chest and abdomen"],
  head: ["head", "human head"],
  leftUpperArm: ["upper arm", "arm from shoulder to elbow", "sleeve"],
  leftForearm: ["forearm", "lower arm", "gauntlet forearm"],
  leftHand: ["hand", "gloved hand"],
  rightUpperArm: ["upper arm", "arm from shoulder to elbow", "sleeve"],
  rightForearm: ["forearm", "lower arm", "gauntlet forearm"],
  rightHand: ["hand", "gloved hand"],
  leftThigh: ["thigh", "upper leg"],
  leftLowerLeg: ["lower leg", "shin", "boot shaft"],
  leftFoot: ["boot", "foot"],
  rightThigh: ["thigh", "upper leg"],
  rightLowerLeg: ["lower leg", "shin", "boot shaft"],
  rightFoot: ["boot", "foot"],
  hair: ["hair"],
  helmet: ["helmet"],
  face: ["face"],
  shoulderLeft: ["left pauldron", "shoulder armor"],
  shoulderRight: ["right pauldron", "shoulder armor"],
  cape: ["cape", "cloak"],
  tail: ["tail"],
  mainHandEquipment: ["sword", "longsword", "blade"],
  offHandEquipment: ["shield", "round shield"],
  accessory: ["pouch", "belt pouch"],
  backEquipment: ["backpack", "back equipment"],
};

const ARM_TYPES = new Set<PartType>(["leftUpperArm", "leftForearm", "leftHand", "rightUpperArm", "rightForearm", "rightHand"]);
const LEG_TYPES = new Set<PartType>(["leftThigh", "leftLowerLeg", "leftFoot", "rightThigh", "rightLowerLeg", "rightFoot"]);
const EQUIPMENT_TYPES = new Set<PartType>(["mainHandEquipment", "offHandEquipment"]);

export function stagedTargets(requested?: readonly PartType[]): readonly PartType[] {
  const allowed = new Set<PartType>((requested?.length ? requested : STAGED_CORE_TARGETS).filter((type) => type !== "rootReference"));
  const ordered = STAGED_CORE_TARGETS.filter((type) => allowed.delete(type));
  return [...ordered, ...allowed];
}

export function detectionStage(type: PartType): DetectionStage {
  if (EQUIPMENT_TYPES.has(type)) return "equipment";
  if (type === "head" || type === "torso" || type === "hair" || type === "helmet") return "stable";
  if (/^left(?:UpperArm|Forearm|Hand)$/.test(type)) return "left-arm";
  if (/^right(?:UpperArm|Forearm|Hand)$/.test(type)) return "right-arm";
  if (/^left(?:Thigh|LowerLeg|Foot)$/.test(type)) return "left-leg";
  if (/^right(?:Thigh|LowerLeg|Foot)$/.test(type)) return "right-leg";
  return "optional";
}

export function detectorPhrases(type: PartType, maximum = 4): readonly string[] {
  return DETECTOR_PHRASE_REGISTRY[type].slice(0, Math.max(1, Math.min(4, maximum)));
}

export function resolveCharacterScreenSides(width: number, anchors: SegmentationAnchors): { readonly characterLeft: ScreenSide; readonly characterRight: ScreenSide; readonly reason: string } {
  const bodyCenter = anchors.head?.summary.centroid.x ?? anchors.torso?.summary.centroid.x ?? width / 2;
  const swordX = anchors.mainHandEquipment?.summary.centroid.x;
  const shieldX = anchors.offHandEquipment?.summary.centroid.x;
  const side = (x: number): ScreenSide => x < bodyCenter ? "screen-left" : "screen-right";
  if (swordX !== undefined && shieldX !== undefined && side(swordX) !== side(shieldX)) {
    return { characterRight: side(swordX), characterLeft: side(shieldX), reason: "Sword anchors the character-right hand; shield anchors the character-left hand" };
  }
  if (swordX !== undefined) {
    const characterRight = side(swordX); return { characterRight, characterLeft: opposite(characterRight), reason: "Sword anchor resolved the character-right side" };
  }
  if (shieldX !== undefined) {
    const characterLeft = side(shieldX); return { characterLeft, characterRight: opposite(characterLeft), reason: "Shield anchor resolved the character-left side" };
  }
  return { characterRight: "screen-left", characterLeft: "screen-right", reason: "No equipment anchor; using the Rigging Studio front/three-quarter convention" };
}

export function detectorCrop(type: PartType, width: number, height: number, anchors: SegmentationAnchors): Rect {
  const sides = resolveCharacterScreenSides(width, anchors);
  if (type === "rootReference" || EQUIPMENT_TYPES.has(type) || type === "head" || type === "hair" || type === "helmet") return full(width, height);
  if (type === "torso") return normalized(width, height, .25, .12, .5, .48);
  if (ARM_TYPES.has(type)) {
    const characterSide = type.startsWith("left") ? sides.characterLeft : sides.characterRight;
    const left = characterSide === "screen-left";
    if (type.endsWith("UpperArm")) return normalized(width, height, left ? .18 : .46, .13, .36, .31);
    if (type.endsWith("Forearm")) return normalized(width, height, left ? .16 : .48, .24, .36, .34);
    return normalized(width, height, left ? .15 : .5, .43, .27, .16);
  }
  if (LEG_TYPES.has(type)) {
    const characterSide = type.startsWith("left") ? sides.characterLeft : sides.characterRight;
    const left = characterSide === "screen-left";
    if (type.endsWith("Thigh")) return normalized(width, height, left ? .23 : .47, .42, .3, .31);
    if (type.endsWith("LowerLeg")) return normalized(width, height, left ? .22 : .48, .62, .3, .32);
    return normalized(width, height, left ? .17 : .52, .83, .31, .17);
  }
  return full(width, height);
}

export function summarizeMask(alpha: ArrayLike<number>, width: number, height: number, canvasWidth = width, canvasHeight = height): MaskSummary | null {
  let left = width; let top = height; let right = -1; let bottom = -1; let area = 0; let xTotal = 0; let yTotal = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if ((alpha[y * width + x] ?? 0) > 0) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); area += 1; xTotal += x; yTotal += y;
  }
  if (!area) return null;
  const bounds = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  const bboxArea = bounds.width * bounds.height;
  return { bounds, area, bboxArea, fillRatio: area / bboxArea, centroid: { x: xTotal / area, y: yTotal / area }, areaRatio: area / Math.max(1, canvasWidth * canvasHeight) };
}

export function scoreMaskCandidate(type: PartType, summary: MaskSummary, crop: Rect, canvasWidth: number, canvasHeight: number, anchors: SegmentationAnchors, detectorConfidence: number | null = null): CandidateQuality {
  const range = expectedAreaRange(type);
  const sizePlausibility = rangeScore(summary.areaRatio, range[0], range[1]);
  const target = expectedZone(type, crop, canvasWidth, canvasHeight);
  const positionPlausibility = pointRectScore(summary.centroid, target);
  const hierarchyConsistency = hierarchyScore(type, summary, anchors, canvasWidth, canvasHeight);
  const semanticConsistency = semanticGeometryScore(type, summary, canvasWidth, canvasHeight, anchors);
  let conflictingOverlap = 0;
  for (const region of Object.values(anchors)) {
    if (!region || expectedSemanticOverlap(type, region.semanticType)) continue;
    conflictingOverlap = Math.max(conflictingOverlap, boundsOverlapFraction(summary.bounds, region.summary.bounds));
  }
  const detector = detectorConfidence ?? .5;
  const cropOccupancy = summary.bboxArea / Math.max(1, crop.width * crop.height);
  const broad = cropOccupancy > broadCropOccupancy(type) || summary.areaRatio > broadCanvasRatio(type);
  const score = clamp01(sizePlausibility * .22 + positionPlausibility * .2 + hierarchyConsistency * .22 + semanticConsistency * .26 + detector * .1 - conflictingOverlap * .25 - (broad ? .2 : 0));
  const reasons: string[] = [];
  if (broad) reasons.push(`Mask is broad for ${type} (${Math.round(cropOccupancy * 100)}% of contextual crop bbox)`);
  if (sizePlausibility < .35) reasons.push(`Area ratio ${(summary.areaRatio * 100).toFixed(2)}% is implausible for ${type}`);
  if (positionPlausibility < .35) reasons.push(`Mask centroid contradicts the expected ${type} region`);
  if (hierarchyConsistency < .3) reasons.push(`Mask is poorly attached to its expected semantic chain`);
  if (semanticConsistency < .45) reasons.push(`Geometry is inconsistent with ${type}`);
  if (conflictingOverlap > .45) reasons.push(`Mask has catastrophic overlap with a trusted unrelated region (${Math.round(conflictingOverlap * 100)}%)`);
  const safe = !broad && score >= .58 && semanticConsistency >= .5 && hierarchyConsistency >= .28 && conflictingOverlap <= .45;
  if (safe) reasons.push("Passed the staged source-conditioned safety gate");
  return { score, semanticConsistency, hierarchyConsistency, sizePlausibility, positionPlausibility, conflictingOverlap, broad, safe, reasons };
}

export function reclassifySemantic(requested: PartType, summary: MaskSummary, anchors: SegmentationAnchors, canvasWidth: number, canvasHeight: number): SemanticReclassification {
  const elongated = Math.max(summary.bounds.width / summary.bounds.height, summary.bounds.height / summary.bounds.width);
  const sword = anchors.mainHandEquipment?.summary;
  const nearSword = sword ? rectDistance(summary.bounds, sword.bounds) < Math.max(canvasWidth, canvasHeight) * .04 : false;
  if (requested === "tail" && elongated >= 2.4 && (nearSword || summary.centroid.x < canvasWidth * .35) && summary.centroid.y > canvasHeight * .35) {
    return { semanticType: "mainHandEquipment", confidence: .9, ambiguous: false, reason: "Rigid elongated mask is hand/equipment-aligned and fails the pelvis-origin rule for a tail" };
  }
  if (requested === "mainHandEquipment" && elongated >= 2.2) return { semanticType: requested, confidence: .9, ambiguous: false, reason: "Elongated rigid mask is consistent with a sword" };
  if (requested === "offHandEquipment" && summary.fillRatio >= .25 && summary.areaRatio >= .008) return { semanticType: requested, confidence: .88, ambiguous: false, reason: "Broad compact equipment mask is consistent with a shield" };
  const consistency = semanticGeometryScore(requested, summary, canvasWidth, canvasHeight, anchors);
  return { semanticType: requested, confidence: consistency, ambiguous: consistency < .45, reason: consistency < .45 ? `Geometry is ambiguous for ${requested}` : `Geometry remains consistent with requested semantic ${requested}` };
}

export function overlapDecision(leftType: PartType, left: Uint8Array, rightType: PartType, right: Uint8Array): OverlapDecision {
  let intersection = 0; let leftArea = 0; let rightArea = 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = (left[index] ?? 0) > 0; const b = (right[index] ?? 0) > 0;
    if (a) leftArea += 1; if (b) rightArea += 1; if (a && b) intersection += 1;
  }
  const fractionOfLeft = intersection / Math.max(1, leftArea); const fractionOfRight = intersection / Math.max(1, rightArea);
  const expected = expectedSemanticOverlap(leftType, rightType);
  const threshold = expected ? .35 : .18;
  const conflicting = Math.min(fractionOfLeft, fractionOfRight) > threshold || (!expected && Math.max(fractionOfLeft, fractionOfRight) > .55);
  return { expected, conflicting, intersection, fractionOfLeft, fractionOfRight, reason: conflicting ? `${expected ? "Expected seam" : "Unrelated masks"} exceeds overlap tolerance` : expected ? "Expected attachment overlap" : "No catastrophic semantic overlap" };
}

export function resolveConflictingOverlaps(parts: readonly ResolvableMask[]): { readonly parts: readonly ResolvableMask[]; readonly decisions: readonly (OverlapDecision & { readonly left: PartType; readonly right: PartType; readonly subtractedFrom?: PartType })[] } {
  const mutable = parts.map((part) => ({ ...part, mask: Uint8Array.from(part.mask) }));
  const decisions: Array<OverlapDecision & { readonly left: PartType; readonly right: PartType; readonly subtractedFrom?: PartType }> = [];
  for (let leftIndex = 0; leftIndex < mutable.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < mutable.length; rightIndex += 1) {
    const left = mutable[leftIndex]; const right = mutable[rightIndex]; const decision = overlapDecision(left.semanticType, left.mask, right.semanticType, right.mask);
    if (!decision.conflicting || Math.abs(left.qualityScore - right.qualityScore) < .12) { decisions.push({ ...decision, left: left.semanticType, right: right.semanticType }); continue; }
    const lower = left.qualityScore < right.qualityScore ? left : right; const higher = lower === left ? right : left;
    for (let index = 0; index < lower.mask.length; index += 1) if (higher.mask[index] > 0) lower.mask[index] = 0;
    decisions.push({ ...decision, left: left.semanticType, right: right.semanticType, subtractedFrom: lower.semanticType });
  }
  return { parts: mutable, decisions };
}

export function foregroundCoverage(parts: readonly Uint8Array[], foreground: Uint8Array): { readonly foregroundPixels: number; readonly assignedPixels: number; readonly unresolvedPixels: number; readonly overlappingPixels: number; readonly percentAssigned: number } {
  const counts = new Uint8Array(foreground.length); let foregroundPixels = 0; let assignedPixels = 0; let unresolvedPixels = 0; let overlappingPixels = 0;
  for (const mask of parts) for (let index = 0; index < counts.length; index += 1) if ((mask[index] ?? 0) > 0 && counts[index] < 255) counts[index] += 1;
  for (let index = 0; index < foreground.length; index += 1) if (foreground[index] > 0) {
    foregroundPixels += 1;
    if (counts[index] > 0) assignedPixels += 1; else unresolvedPixels += 1;
    if (counts[index] > 1) overlappingPixels += 1;
  }
  return { foregroundPixels, assignedPixels, unresolvedPixels, overlappingPixels, percentAssigned: assignedPixels / Math.max(1, foregroundPixels) };
}

export function maskIntersectionOverUnion(left: Uint8Array, right: Uint8Array): number {
  let intersection = 0; let union = 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = (left[index] ?? 0) > 0; const b = (right[index] ?? 0) > 0;
    if (a && b) intersection += 1; if (a || b) union += 1;
  }
  return intersection / Math.max(1, union);
}

export function remapCropMask(alpha: ArrayLike<number>, cropWidth: number, cropHeight: number, crop: Rect, sourceWidth: number, sourceHeight: number): Uint8Array {
  if (cropWidth !== Math.round(crop.width) || cropHeight !== Math.round(crop.height)) throw new Error("Crop mask dimensions do not match the declared detector crop");
  const mapped = new Uint8Array(sourceWidth * sourceHeight); const offsetX = Math.round(crop.x); const offsetY = Math.round(crop.y);
  for (let y = 0; y < cropHeight; y += 1) for (let x = 0; x < cropWidth; x += 1) {
    const targetX = offsetX + x; const targetY = offsetY + y;
    if (targetX >= 0 && targetY >= 0 && targetX < sourceWidth && targetY < sourceHeight) mapped[targetY * sourceWidth + targetX] = alpha[y * cropWidth + x] ?? 0;
  }
  return mapped;
}

function expectedAreaRange(type: PartType): readonly [number, number] {
  if (type === "head") return [.004, .055];
  if (type === "torso") return [.035, .22];
  if (type.endsWith("UpperArm") || type.endsWith("Forearm")) return [.006, .07];
  if (type.endsWith("Hand")) return [.0008, .022];
  if (type.endsWith("Thigh") || type.endsWith("LowerLeg")) return [.008, .09];
  if (type.endsWith("Foot")) return [.003, .045];
  if (type === "mainHandEquipment") return [.002, .045];
  if (type === "offHandEquipment") return [.008, .11];
  return [.001, .12];
}

function semanticGeometryScore(type: PartType, summary: MaskSummary, width: number, height: number, anchors: SegmentationAnchors): number {
  const b = summary.bounds; const aspect = Math.max(b.width / b.height, b.height / b.width);
  if (type === "mainHandEquipment") return clamp01((aspect - 1.5) / 3 + (summary.areaRatio < .06 ? .35 : 0));
  if (type === "offHandEquipment") return clamp01(summary.fillRatio * .65 + (b.height > b.width ? .25 : .1));
  if (type === "head") return clamp01((summary.centroid.y < height * .25 ? .6 : 0) + (summary.areaRatio < .08 ? .4 : 0));
  if (type === "torso") return clamp01((Math.abs(summary.centroid.x - width / 2) < width * .22 ? .45 : .1) + (summary.centroid.y > height * .14 && summary.centroid.y < height * .58 ? .4 : 0) + (summary.areaRatio < .25 ? .15 : 0));
  if (type.endsWith("Hand")) return clamp01((summary.areaRatio < .025 ? .55 : 0) + (b.height < height * .18 ? .25 : 0) + (b.width < width * .25 ? .2 : 0));
  if (ARM_TYPES.has(type)) return clamp01((summary.areaRatio < .09 ? .45 : 0) + (aspect > 1.25 ? .3 : .15) + (summary.centroid.y < height * .62 ? .25 : 0));
  if (LEG_TYPES.has(type)) return clamp01((summary.areaRatio < .12 ? .4 : 0) + (summary.centroid.y > height * .4 ? .35 : 0) + (aspect > 1.2 ? .25 : .1));
  if (type === "tail") {
    const pelvis = anchors.torso?.summary.bounds; const originNearPelvis = pelvis ? rectDistance(b, pelvis) < width * .08 : summary.centroid.y > height * .4;
    return clamp01((originNearPelvis ? .55 : 0) + (summary.centroid.x > width * .15 && summary.centroid.x < width * .85 ? .25 : 0) + (aspect < 5 ? .2 : 0));
  }
  return .55;
}

function hierarchyScore(type: PartType, summary: MaskSummary, anchors: SegmentationAnchors, width: number, height: number): number {
  const parentType = parentSemantic(type);
  if (!parentType) return .75;
  const parent = anchors[parentType]?.summary;
  if (!parent) return .55;
  const distance = rectDistance(summary.bounds, parent.bounds);
  const scale = Math.max(width, height);
  const proximity = clamp01(1 - distance / (scale * .18));
  if (type.endsWith("Hand") || type.endsWith("Foot")) return proximity;
  return clamp01(proximity * .8 + .2);
}

function parentSemantic(type: PartType): PartType | null {
  const map: Partial<Record<PartType, PartType>> = {
    leftUpperArm: "torso", rightUpperArm: "torso", leftForearm: "leftUpperArm", rightForearm: "rightUpperArm", leftHand: "leftForearm", rightHand: "rightForearm",
    leftThigh: "torso", rightThigh: "torso", leftLowerLeg: "leftThigh", rightLowerLeg: "rightThigh", leftFoot: "leftLowerLeg", rightFoot: "rightLowerLeg",
    mainHandEquipment: "rightHand", offHandEquipment: "leftHand", hair: "head", helmet: "head",
  };
  return map[type] ?? null;
}

function expectedSemanticOverlap(left: PartType, right: PartType): boolean {
  if (left === right) return true;
  const pair = new Set([left, right]);
  const expectedPairs: readonly (readonly [PartType, PartType])[] = [
    ["head", "hair"], ["head", "helmet"], ["torso", "leftUpperArm"], ["torso", "rightUpperArm"], ["torso", "leftThigh"], ["torso", "rightThigh"],
    ["leftUpperArm", "leftForearm"], ["leftForearm", "leftHand"], ["rightUpperArm", "rightForearm"], ["rightForearm", "rightHand"],
    ["leftThigh", "leftLowerLeg"], ["leftLowerLeg", "leftFoot"], ["rightThigh", "rightLowerLeg"], ["rightLowerLeg", "rightFoot"],
    ["rightHand", "mainHandEquipment"], ["leftHand", "offHandEquipment"],
  ];
  return expectedPairs.some(([a, b]) => pair.has(a) && pair.has(b));
}

function expectedZone(type: PartType, crop: Rect, width: number, height: number): Rect {
  if (type === "torso") return normalized(width, height, .3, .15, .4, .42);
  if (type === "head") return normalized(width, height, .25, 0, .5, .25);
  return { x: crop.x + crop.width * .08, y: crop.y + crop.height * .06, width: crop.width * .84, height: crop.height * .88 };
}

function broadCropOccupancy(type: PartType): number {
  if (type === "torso") return .9;
  if (type.endsWith("Hand") || type.endsWith("Foot")) return .82;
  return .88;
}

function broadCanvasRatio(type: PartType): number {
  if (type === "torso") return .28;
  if (type === "head") return .1;
  if (type.endsWith("Hand")) return .05;
  if (ARM_TYPES.has(type)) return .13;
  if (LEG_TYPES.has(type)) return .16;
  if (type === "mainHandEquipment") return .07;
  if (type === "offHandEquipment") return .14;
  return .2;
}

function normalized(width: number, height: number, x: number, y: number, w: number, h: number): Rect {
  const left = clampInt(Math.floor(width * x), 0, width - 1); const top = clampInt(Math.floor(height * y), 0, height - 1);
  const right = clampInt(Math.ceil(width * (x + w)), left + 1, width); const bottom = clampInt(Math.ceil(height * (y + h)), top + 1, height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function full(width: number, height: number): Rect { return { x: 0, y: 0, width, height }; }
function opposite(side: ScreenSide): ScreenSide { return side === "screen-left" ? "screen-right" : "screen-left"; }
function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
function clampInt(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function rangeScore(value: number, minimum: number, maximum: number): number {
  if (value >= minimum && value <= maximum) return 1;
  if (value < minimum) return clamp01(value / Math.max(.000001, minimum));
  return clamp01(1 - (value - maximum) / Math.max(maximum, .000001));
}
function pointRectScore(point: { readonly x: number; readonly y: number }, rect: Rect): number {
  const centerX = rect.x + rect.width / 2; const centerY = rect.y + rect.height / 2;
  const distance = Math.hypot((point.x - centerX) / Math.max(1, rect.width / 2), (point.y - centerY) / Math.max(1, rect.height / 2));
  return clamp01(1 - distance / 1.6);
}
function rectDistance(left: Rect, right: Rect): number {
  const dx = Math.max(0, left.x - (right.x + right.width), right.x - (left.x + left.width));
  const dy = Math.max(0, left.y - (right.y + right.height), right.y - (left.y + left.height));
  return Math.hypot(dx, dy);
}
function boundsOverlapFraction(left: Rect, right: Rect): number {
  const x = Math.max(left.x, right.x); const y = Math.max(left.y, right.y);
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - x); const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - y);
  return width * height / Math.max(1, Math.min(left.width * left.height, right.width * right.height));
}
