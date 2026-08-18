export const PART_SEMANTIC_TYPES = [
  "root", "pelvis", "torso", "head",
  "leftUpperArm", "leftForearm", "leftHand",
  "rightUpperArm", "rightForearm", "rightHand",
  "leftThigh", "leftLowerLeg", "leftFoot",
  "rightThigh", "rightLowerLeg", "rightFoot",
  "hair", "face", "beard", "helmet",
  "leftShoulderArmor", "rightShoulderArmor", "cape", "tail",
  "mainHandEquipment", "offHandEquipment", "backEquipment", "accessory", "custom",
] as const;

export type PartSemanticType = (typeof PART_SEMANTIC_TYPES)[number];
export type PartLayerGroup = "front" | "body" | "back";

export type SemanticPartDefaults = {
  readonly label: string;
  readonly suggestedBone: string;
  readonly suggestedParentBone: string | null;
  readonly suggestedChild?: PartSemanticType;
  readonly suggestedJoint?: string;
  readonly defaultLayerGroup: PartLayerGroup;
  readonly articulated: boolean;
  readonly equipment: boolean;
  readonly swapCompatible: boolean;
};

const body = (label: string, suggestedBone: string, suggestedParentBone: string | null, defaultLayerGroup: PartLayerGroup = "body", suggestedChild?: PartSemanticType, suggestedJoint?: string): SemanticPartDefaults => ({
  label, suggestedBone, suggestedParentBone, defaultLayerGroup, articulated: true, equipment: false, swapCompatible: false, ...(suggestedChild ? { suggestedChild } : {}), ...(suggestedJoint ? { suggestedJoint } : {}),
});
const fixed = (label: string, suggestedBone: string, suggestedParentBone: string | null, defaultLayerGroup: PartLayerGroup = "body", swapCompatible = false): SemanticPartDefaults => ({
  label, suggestedBone, suggestedParentBone, defaultLayerGroup, articulated: false, equipment: swapCompatible, swapCompatible,
});

export const SEMANTIC_TAXONOMY: Readonly<Record<PartSemanticType, SemanticPartDefaults>> = {
  root: body("Root", "root", null, "body", "pelvis"),
  pelvis: body("Pelvis", "pelvis", "root", "body", "torso", "hips"),
  torso: body("Torso", "torso", "pelvis", "body", "head", "waist"),
  head: body("Head", "head", "torso", "body", undefined, "neck"),
  leftUpperArm: body("Left Upper Arm", "left-upper-arm", "torso", "back", "leftForearm", "leftShoulder"),
  leftForearm: body("Left Forearm", "left-lower-arm", "left-upper-arm", "back", "leftHand", "leftElbow"),
  leftHand: body("Left Hand", "left-hand", "left-lower-arm", "front", undefined, "leftWrist"),
  rightUpperArm: body("Right Upper Arm", "right-upper-arm", "torso", "front", "rightForearm", "rightShoulder"),
  rightForearm: body("Right Forearm", "right-lower-arm", "right-upper-arm", "front", "rightHand", "rightElbow"),
  rightHand: body("Right Hand", "right-hand", "right-lower-arm", "front", undefined, "rightWrist"),
  leftThigh: body("Left Thigh", "left-upper-leg", "pelvis", "body", "leftLowerLeg", "leftHip"),
  leftLowerLeg: body("Left Lower Leg", "left-lower-leg", "left-upper-leg", "body", "leftFoot", "leftKnee"),
  leftFoot: body("Left Foot", "left-foot", "left-lower-leg", "body", undefined, "leftAnkle"),
  rightThigh: body("Right Thigh", "right-upper-leg", "pelvis", "back", "rightLowerLeg", "rightHip"),
  rightLowerLeg: body("Right Lower Leg", "right-lower-leg", "right-upper-leg", "back", "rightFoot", "rightKnee"),
  rightFoot: body("Right Foot", "right-foot", "right-lower-leg", "back", undefined, "rightAnkle"),
  hair: fixed("Hair", "head", "head", "front", true),
  face: fixed("Face", "head", "head", "front", true),
  beard: fixed("Beard", "head", "head", "front", true),
  helmet: fixed("Helmet", "head", "head", "front", true),
  leftShoulderArmor: fixed("Left Shoulder Armor", "left-upper-arm", "torso", "back", true),
  rightShoulderArmor: fixed("Right Shoulder Armor", "right-upper-arm", "torso", "front", true),
  cape: fixed("Cape", "torso", "torso", "back", true),
  tail: body("Tail", "pelvis", "pelvis", "back"),
  mainHandEquipment: fixed("Main Hand Equipment", "right-hand", "right-hand", "front", true),
  offHandEquipment: fixed("Off Hand Equipment", "left-hand", "left-hand", "back", true),
  backEquipment: fixed("Back Equipment", "torso", "torso", "back", true),
  accessory: fixed("Accessory", "torso", "torso", "front", true),
  custom: fixed("Custom", "torso", "torso", "body"),
};

export const semanticLabel = (type: PartSemanticType): string => SEMANTIC_TAXONOMY[type].label;

export const semanticShortcut: Readonly<Partial<Record<string, PartSemanticType>>> = {
  h: "head", t: "torso", p: "pelvis", "1": "leftUpperArm", "2": "leftForearm", "3": "leftHand",
  "4": "rightUpperArm", "5": "rightForearm", "6": "rightHand",
};
