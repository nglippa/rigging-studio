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

export const partTypeToBoneId = (part: PartType): string => ({
  rootReference: "root", torso: "torso", head: "head",
  leftUpperArm: "left-upper-arm", leftForearm: "left-lower-arm", leftHand: "left-hand",
  rightUpperArm: "right-upper-arm", rightForearm: "right-lower-arm", rightHand: "right-hand",
  leftThigh: "left-upper-leg", leftLowerLeg: "left-lower-leg", leftFoot: "left-foot",
  rightThigh: "right-upper-leg", rightLowerLeg: "right-lower-leg", rightFoot: "right-foot",
  hair: "head", helmet: "head", face: "head", shoulderLeft: "left-upper-arm", shoulderRight: "right-upper-arm",
  cape: "torso", tail: "pelvis", mainHandEquipment: "right-hand", offHandEquipment: "left-hand",
  accessory: "torso", backEquipment: "torso",
} satisfies Record<PartType, string>)[part];

export const partTypeToSlotId = (part: PartType): string => `${partTypeToBoneId(part)}-${part === "mainHandEquipment" ? "weapon" : part === "offHandEquipment" ? "shield" : part}-slot`;
