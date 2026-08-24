import type { ProposedCharacterPart } from "../segmentation/segmentationSchema";
import type { PartCutterState } from "../../part-cutter/schema";

export type AutoRigTopology = "humanoid" | "digitigrade" | "custom";
export type TopologySelection = { readonly topology: AutoRigTopology; readonly source: "prepare-metadata" | "semantic-regions" | "fallback-inference"; readonly supported: boolean };

export type TopologyBone = {
  readonly id: string;
  readonly parentId: string | null;
  readonly semanticType?: ProposedCharacterPart["semanticType"];
  readonly landmarkId?: string;
};

const BASE: readonly TopologyBone[] = [
  { id: "root", parentId: null, landmarkId: "root" },
  { id: "pelvis", parentId: "root", landmarkId: "pelvis" },
  { id: "torso", parentId: "pelvis", semanticType: "torso", landmarkId: "chest" },
  { id: "neck", parentId: "torso", landmarkId: "neck" },
  { id: "head", parentId: "neck", semanticType: "head", landmarkId: "head" },
  { id: "left-upper-arm", parentId: "torso", semanticType: "leftUpperArm", landmarkId: "leftShoulder" },
  { id: "left-lower-arm", parentId: "left-upper-arm", semanticType: "leftForearm", landmarkId: "leftElbow" },
  { id: "left-hand", parentId: "left-lower-arm", semanticType: "leftHand", landmarkId: "leftWrist" },
  { id: "right-upper-arm", parentId: "torso", semanticType: "rightUpperArm", landmarkId: "rightShoulder" },
  { id: "right-lower-arm", parentId: "right-upper-arm", semanticType: "rightForearm", landmarkId: "rightElbow" },
  { id: "right-hand", parentId: "right-lower-arm", semanticType: "rightHand", landmarkId: "rightWrist" },
  { id: "left-upper-leg", parentId: "pelvis", semanticType: "leftThigh", landmarkId: "leftHip" },
  { id: "left-lower-leg", parentId: "left-upper-leg", semanticType: "leftLowerLeg", landmarkId: "leftKnee" },
  { id: "right-upper-leg", parentId: "pelvis", semanticType: "rightThigh", landmarkId: "rightHip" },
  { id: "right-lower-leg", parentId: "right-upper-leg", semanticType: "rightLowerLeg", landmarkId: "rightKnee" },
];

const HUMANOID: readonly TopologyBone[] = [
  ...BASE,
  { id: "left-foot", parentId: "left-lower-leg", semanticType: "leftFoot", landmarkId: "leftAnkle" },
  { id: "right-foot", parentId: "right-lower-leg", semanticType: "rightFoot", landmarkId: "rightAnkle" },
];

const DIGITIGRADE: readonly TopologyBone[] = [
  ...BASE,
  { id: "left-hock", parentId: "left-lower-leg", landmarkId: "leftHock" },
  { id: "left-foot", parentId: "left-hock", semanticType: "leftFoot", landmarkId: "leftAnkle" },
  { id: "right-hock", parentId: "right-lower-leg", landmarkId: "rightHock" },
  { id: "right-foot", parentId: "right-hock", semanticType: "rightFoot", landmarkId: "rightAnkle" },
];

export function selectAutoRigTopology(name: string, parts: readonly ProposedCharacterPart[], state?: PartCutterState): TopologySelection {
  const stored = state?.anatomicalGuide?.adaptiveMetadata?.topology ?? state?.anatomicalGuide?.profile;
  if (stored) return { topology: stored, source: "prepare-metadata", supported: stored !== "custom" };
  const semanticEvidence = `${parts.map((part) => `${part.name} ${part.semanticType} ${part.warnings.join(" ")}`).join(" ")}`.toLowerCase();
  if (/\b(?:digitigrade|hock|paw)\b/.test(semanticEvidence)) return { topology: "digitigrade", source: "semantic-regions", supported: true };
  if (/\b(?:digitigrade|beastman|hock|paw)\b/i.test(name)) return { topology: "digitigrade", source: "fallback-inference", supported: true };
  return { topology: "humanoid", source: "fallback-inference", supported: true };
}

export function topologyBones(topology: AutoRigTopology): readonly TopologyBone[] {
  return topology === "digitigrade" ? DIGITIGRADE : HUMANOID;
}

