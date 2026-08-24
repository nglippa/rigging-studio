export const BODY_PART_TYPES = [
  "rootReference", "torso", "head",
  "leftUpperArm", "leftForearm", "leftHand",
  "rightUpperArm", "rightForearm", "rightHand",
  "leftThigh", "leftLowerLeg", "leftFoot",
  "rightThigh", "rightLowerLeg", "rightFoot",
] as const;

export const OPTIONAL_PART_TYPES = [
  "hair", "helmet", "face", "shoulderLeft", "shoulderRight", "cape", "tail",
  "mainHandEquipment", "offHandEquipment", "accessory", "backEquipment",
] as const;

export const PART_TYPES = [...BODY_PART_TYPES, ...OPTIONAL_PART_TYPES] as const;
export type PartType = (typeof PART_TYPES)[number];

export const REQUIRED_RIG_PARTS: readonly PartType[] = BODY_PART_TYPES.filter((part) => part !== "rootReference");

export type RigLayer = "back" | "body" | "front";
export type PartRiggingSpec = {
  readonly boneId: string;
  readonly zIndex: number;
  readonly layer: RigLayer;
  readonly pivotLandmark?: string;
  readonly adjacentSemantic?: PartType;
  readonly bindingKind: "body" | "detail" | "equipment";
};

/** The one canonical semantic → rig mapping used by hierarchy, slots, pivots and draw order. */
export const PART_RIGGING_SPECS: Readonly<Record<PartType, PartRiggingSpec>> = {
  rootReference: { boneId: "root", zIndex: -30, layer: "back", bindingKind: "body" },
  rightThigh: { boneId: "right-upper-leg", zIndex: -18, layer: "back", pivotLandmark: "rightHip", adjacentSemantic: "torso", bindingKind: "body" },
  rightLowerLeg: { boneId: "right-lower-leg", zIndex: -17, layer: "back", pivotLandmark: "rightKnee", adjacentSemantic: "rightThigh", bindingKind: "body" },
  rightFoot: { boneId: "right-foot", zIndex: -16, layer: "back", pivotLandmark: "rightAnkle", adjacentSemantic: "rightLowerLeg", bindingKind: "body" },
  cape: { boneId: "torso", zIndex: -15, layer: "back", bindingKind: "detail" },
  backEquipment: { boneId: "torso", zIndex: -14, layer: "back", adjacentSemantic: "torso", bindingKind: "equipment" },
  tail: { boneId: "pelvis", zIndex: -13, layer: "back", bindingKind: "detail" },
  leftThigh: { boneId: "left-upper-leg", zIndex: -12, layer: "body", pivotLandmark: "leftHip", adjacentSemantic: "torso", bindingKind: "body" },
  leftLowerLeg: { boneId: "left-lower-leg", zIndex: -11, layer: "body", pivotLandmark: "leftKnee", adjacentSemantic: "leftThigh", bindingKind: "body" },
  leftFoot: { boneId: "left-foot", zIndex: -10, layer: "body", pivotLandmark: "leftAnkle", adjacentSemantic: "leftLowerLeg", bindingKind: "body" },
  leftUpperArm: { boneId: "left-upper-arm", zIndex: -8, layer: "back", pivotLandmark: "leftShoulder", adjacentSemantic: "torso", bindingKind: "body" },
  leftForearm: { boneId: "left-lower-arm", zIndex: -7, layer: "back", pivotLandmark: "leftElbow", adjacentSemantic: "leftUpperArm", bindingKind: "body" },
  shoulderLeft: { boneId: "left-upper-arm", zIndex: -6, layer: "back", pivotLandmark: "leftShoulder", adjacentSemantic: "leftUpperArm", bindingKind: "equipment" },
  torso: { boneId: "torso", zIndex: 0, layer: "body", pivotLandmark: "chest", bindingKind: "body" },
  rightUpperArm: { boneId: "right-upper-arm", zIndex: 2, layer: "front", pivotLandmark: "rightShoulder", adjacentSemantic: "torso", bindingKind: "body" },
  rightForearm: { boneId: "right-lower-arm", zIndex: 3, layer: "front", pivotLandmark: "rightElbow", adjacentSemantic: "rightUpperArm", bindingKind: "body" },
  leftHand: { boneId: "left-hand", zIndex: 4, layer: "front", pivotLandmark: "leftWrist", adjacentSemantic: "leftForearm", bindingKind: "body" },
  rightHand: { boneId: "right-hand", zIndex: 5, layer: "front", pivotLandmark: "rightWrist", adjacentSemantic: "rightForearm", bindingKind: "body" },
  shoulderRight: { boneId: "right-upper-arm", zIndex: 6, layer: "front", pivotLandmark: "rightShoulder", adjacentSemantic: "rightUpperArm", bindingKind: "equipment" },
  head: { boneId: "head", zIndex: 8, layer: "body", pivotLandmark: "head", adjacentSemantic: "torso", bindingKind: "body" },
  face: { boneId: "head", zIndex: 9, layer: "front", bindingKind: "detail" },
  hair: { boneId: "head", zIndex: 10, layer: "front", bindingKind: "detail" },
  helmet: { boneId: "head", zIndex: 11, layer: "front", adjacentSemantic: "head", bindingKind: "equipment" },
  offHandEquipment: { boneId: "left-hand", zIndex: 12, layer: "front", pivotLandmark: "leftWrist", adjacentSemantic: "leftHand", bindingKind: "equipment" },
  mainHandEquipment: { boneId: "right-hand", zIndex: 13, layer: "front", pivotLandmark: "rightWrist", adjacentSemantic: "rightHand", bindingKind: "equipment" },
  accessory: { boneId: "torso", zIndex: 14, layer: "front", bindingKind: "detail" },
};

export const partTypeToBoneId = (part: PartType): string => PART_RIGGING_SPECS[part].boneId;

export const partTypeToSlotId = (part: PartType): string => `${partTypeToBoneId(part)}-${part === "mainHandEquipment" ? "weapon" : part === "offHandEquipment" ? "shield" : part}-slot`;
