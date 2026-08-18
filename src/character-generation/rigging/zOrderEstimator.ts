import type { ProposedCharacterPart } from "../segmentation/segmentationSchema";

const defaultOrder: Readonly<Record<ProposedCharacterPart["semanticType"], number>> = {
  rootReference: -20, rightThigh: -12, rightLowerLeg: -11, rightFoot: -10, leftThigh: -9, leftLowerLeg: -8, leftFoot: -7,
  cape: -6, backEquipment: -5, leftUpperArm: -4, leftForearm: -3, shoulderLeft: -2, torso: 0, face: 1, hair: 7,
  rightUpperArm: 2, rightForearm: 3, leftHand: 4, rightHand: 5, shoulderRight: 6, head: 8, helmet: 9,
  offHandEquipment: 10, mainHandEquipment: 11, accessory: 12, tail: -1,
};

export const estimateZIndex = (part: ProposedCharacterPart): number => Number.isInteger(part.suggestedZIndex) ? part.suggestedZIndex : defaultOrder[part.semanticType];
export const sortPartsByZOrder = (parts: readonly ProposedCharacterPart[]): readonly ProposedCharacterPart[] => [...parts].sort((a, b) => estimateZIndex(a) - estimateZIndex(b) || a.id.localeCompare(b.id));
