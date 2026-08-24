import type { AnimationDefinition, RigDefinition } from "../schema/types";

export type AnimationGenerationMode = "create" | "revise" | "reviseSelectedBones";
export type FootRole = "leftFoot" | "rightFoot";
export type FootContactInterval = { readonly foot: FootRole; readonly start: number; readonly end: number };
export type LeftRightMapping = { readonly left: string; readonly right: string };
export type LocomotionArchetype = "standard" | "broad" | "chibi" | "agile" | "heavy" | "robed" | "digitigrade";
export type AnimationEquipmentKind = "sword" | "shield" | "staff" | "firearm" | "dagger" | "heavy" | "other";
export type AnimationEquipmentItem = {
  readonly id: string;
  readonly boneId: string;
  readonly hand: "left" | "right" | "body";
  readonly kind: AnimationEquipmentKind;
  readonly twoHanded: boolean;
};
export type LocomotionRigProfile = {
  readonly topology: "humanoid" | "digitigrade" | "custom";
  readonly archetype: LocomotionArchetype;
  readonly role: "fighter" | "doctor" | "mage" | "marine" | "rogue" | "beast";
  readonly equipment: { readonly leftHand: boolean; readonly rightHand: boolean; readonly torso: boolean; readonly head: boolean };
  readonly equipmentItems: readonly AnimationEquipmentItem[];
};

export type AnimationAuthoringConstraints = {
  readonly duration: number;
  readonly loop: boolean;
  readonly intensity: number;
  readonly weight: number;
  readonly exaggeration: number;
  readonly rootMovementAllowance: number;
  readonly preserveTiming: boolean;
  readonly preserveContactFrames: boolean;
  readonly styleNotes: string;
};

export type AnimationContextOptions = {
  readonly request: string;
  readonly mode: AnimationGenerationMode;
  readonly constraints: AnimationAuthoringConstraints;
  readonly selectedBoneIds: readonly string[];
  readonly leftRightMappings: readonly LeftRightMapping[];
  readonly groundPlaneY: number;
  readonly leftFootBoneId: string | null;
  readonly rightFootBoneId: string | null;
  readonly contactIntervals: readonly FootContactInterval[];
  readonly currentAnimation?: AnimationDefinition;
  readonly referenceAnimations?: readonly AnimationDefinition[];
  readonly includeSlotNames?: boolean;
};

export type AnimationGenerationContext = {
  readonly rigSchemaVersion: number;
  readonly bones: readonly {
    readonly id: string;
    readonly parentId: string | null;
    readonly length: number;
    readonly setup: { readonly x: number; readonly y: number; readonly rotation: number; readonly scaleX: number; readonly scaleY: number };
    readonly inheritRotation: boolean;
    readonly inheritScale: boolean;
  }[];
  readonly slotNames?: readonly string[];
  readonly currentAnimation?: AnimationDefinition;
  readonly referenceAnimations: readonly AnimationDefinition[];
  readonly requestedDuration: number;
  readonly loop: boolean;
  readonly mode: AnimationGenerationMode;
  readonly selectedBoneIds: readonly string[];
  readonly leftRightMappings: readonly LeftRightMapping[];
  readonly motionDescription: string;
  readonly groundPlaneY: number;
  readonly feet: { readonly leftFootBoneId: string | null; readonly rightFootBoneId: string | null; readonly contactIntervals: readonly FootContactInterval[] };
  readonly constraints: AnimationAuthoringConstraints;
  readonly locomotionProfile: LocomotionRigProfile;
  readonly authoringRules: readonly string[];
};

const RULES = [
  "Use only existing bone IDs and never rename a bone.",
  "Animation values are absolute local transforms. Rotation uses degrees and time uses seconds.",
  "Preserve every untouched track when revising an animation.",
  "Use x, y, rotation, scaleX, and scaleY tracks only.",
  "Keep keyframes strictly sorted and avoid excessive keys.",
  "When looping is requested, make the first and final poses seamless.",
  "Keep planted feet stable during marked contact intervals.",
  "Use opposing arm and leg motion for natural locomotion.",
  "Report assumptions and uncertainty instead of inventing rig structure.",
] as const;

const locomotionProfile = (rig: RigDefinition): LocomotionRigProfile => {
  const metadata = rig.metadata as Readonly<Record<string, unknown>>;
  const source = `${String(metadata.name ?? "")} ${String(metadata.anatomyProfile ?? "")} ${rig.id}`.toLowerCase();
  const topology = rig.bones.some((bone) => /hock/i.test(bone.id)) || /digitigrade/.test(source) ? "digitigrade" : metadata.anatomyProfile === "custom" ? "custom" : "humanoid";
  const archetype: LocomotionArchetype = topology === "digitigrade" ? "digitigrade"
    : /chibi/.test(source) ? "chibi" : /dwarf|broad/.test(source) ? "broad" : /rogue|agile|thin/.test(source) ? "agile"
      : /marine|bulky|heavy/.test(source) ? "heavy" : /robe|mage|doctor|coat/.test(source) ? "robed" : "standard";
  const equipmentSlots = rig.slots.filter((slot) => {
    const attachment = rig.attachments.find((candidate) => candidate.id === slot.attachmentId);
    return attachment?.category === "equipment" && attachment.tags.some((tag) => /equipment|weapon|shield|staff|club|hammer|rifle|cape|coat|armor/i.test(tag));
  });
  const equipmentItems: AnimationEquipmentItem[] = equipmentSlots.flatMap((slot) => {
    const attachment = rig.attachments.find((candidate) => candidate.id === slot.attachmentId);
    if (!attachment) return [];
    const semantic = `${attachment.id} ${attachment.tags.join(" ")}`.toLowerCase();
    const kind: AnimationEquipmentKind = /rifle|gun|firearm|blaster/.test(semantic) ? "firearm" : /staff|wand/.test(semantic) ? "staff"
      : /dagger|knife/.test(semantic) ? "dagger" : /hammer|club|axe|mace/.test(semantic) ? "heavy"
        : /sword|blade/.test(semantic) ? "sword" : /shield/.test(semantic) ? "shield" : "other";
    const hand = /left.*hand/i.test(slot.boneId) ? "left" : /right.*hand/i.test(slot.boneId) ? "right" : "body";
    return [{ id: attachment.id, boneId: slot.boneId, hand, kind, twoHanded: kind === "firearm" }];
  });
  return {
    topology, archetype,
    role: /marine|soldier/.test(source) ? "marine" : /rogue|agile/.test(source) ? "rogue" : /mage|wizard|sorcer/.test(source) ? "mage"
      : /doctor|plague/.test(source) ? "doctor" : topology === "digitigrade" ? "beast" : "fighter",
    equipment: {
      leftHand: equipmentSlots.some((slot) => /left.*hand/i.test(slot.boneId)),
      rightHand: equipmentSlots.some((slot) => /right.*hand/i.test(slot.boneId)),
      torso: equipmentSlots.some((slot) => /torso|pelvis/i.test(slot.boneId)),
      head: equipmentSlots.some((slot) => /head|neck/i.test(slot.boneId)),
    },
    equipmentItems,
  };
};

export const buildAnimationGenerationContext = (rig: RigDefinition, options: AnimationContextOptions): AnimationGenerationContext => ({
  rigSchemaVersion: rig.schemaVersion,
  bones: rig.bones.map((bone) => ({
    id: bone.id,
    parentId: bone.parentId,
    length: bone.length,
    setup: { x: bone.x, y: bone.y, rotation: bone.rotation, scaleX: bone.scaleX, scaleY: bone.scaleY },
    inheritRotation: bone.inheritRotation,
    inheritScale: bone.inheritScale,
  })),
  ...(options.includeSlotNames ? { slotNames: rig.slots.map((slot) => slot.id) } : {}),
  ...(options.mode !== "create" && options.currentAnimation ? { currentAnimation: options.currentAnimation } : {}),
  referenceAnimations: options.referenceAnimations ?? [],
  requestedDuration: options.constraints.duration,
  loop: options.constraints.loop,
  mode: options.mode,
  selectedBoneIds: options.mode === "reviseSelectedBones" ? [...options.selectedBoneIds] : [],
  leftRightMappings: options.leftRightMappings,
  motionDescription: options.request,
  groundPlaneY: options.groundPlaneY,
  feet: {
    leftFootBoneId: options.leftFootBoneId,
    rightFootBoneId: options.rightFootBoneId,
    contactIntervals: options.contactIntervals,
  },
  constraints: options.constraints,
  locomotionProfile: locomotionProfile(rig),
  authoringRules: RULES,
});
