import { createRestPose } from "./pose";
import { resolveSlots, type ResolvedSlot, type SlotAttachmentOverrides } from "./slots";
import { computeWorldTransforms } from "./worldTransforms";
import type { BonePose, BonePosePatch, RigPose, WorldTransforms } from "./types";
import type { BoneDefinition, RigDefinition, SlotDefinition } from "../schema/types";
import { validateRigDefinition } from "../validation/rig";

type MutableBonePose = { x: number; y: number; rotation: number; scaleX: number; scaleY: number };

export class RuntimeBoneNode {
  private readonly localPose: MutableBonePose;

  constructor(readonly definition: BoneDefinition, setupPose: BonePose) {
    this.localPose = { ...setupPose };
  }

  readPose(): BonePose {
    return { ...this.localPose };
  }

  update(patch: BonePosePatch): void {
    Object.assign(this.localPose, patch);
  }

  reset(setupPose: BonePose): void {
    Object.assign(this.localPose, setupPose);
  }
}

export class RuntimeSlotNode {
  private hasOverride = false;
  private attachmentOverride: string | null = null;

  constructor(readonly definition: SlotDefinition) {}

  replaceAttachment(attachmentId: string | null): void {
    this.hasOverride = true;
    this.attachmentOverride = attachmentId;
  }

  clearAttachmentOverride(): void {
    this.hasOverride = false;
    this.attachmentOverride = null;
  }

  writeOverride(target: Record<string, string | null>): void {
    if (this.hasOverride) target[this.definition.id] = this.attachmentOverride;
  }
}

export class RigRuntime {
  readonly bones = new Map<string, RuntimeBoneNode>();
  readonly slots = new Map<string, RuntimeSlotNode>();
  private readonly setupPose: RigPose;
  private skinId: string;

  constructor(readonly definition: RigDefinition) {
    const issues = validateRigDefinition(definition);
    if (issues.length > 0) {
      throw new Error(`Cannot instantiate invalid rig: ${issues.map((issue) => issue.message).join("; ")}`);
    }
    this.setupPose = createRestPose(definition);
    this.skinId = definition.defaultSkinId;
    definition.bones.forEach((bone) => {
      const setup = this.setupPose.bones[bone.id];
      if (!setup) throw new Error(`Setup pose is missing bone "${bone.id}"`);
      this.bones.set(bone.id, new RuntimeBoneNode(bone, setup));
    });
    definition.slots.forEach((slot) => this.slots.set(slot.id, new RuntimeSlotNode(slot)));
  }

  getPose(): RigPose {
    return { bones: Object.fromEntries([...this.bones].map(([id, bone]) => [id, bone.readPose()])) };
  }

  getSetupPose(): RigPose {
    return { bones: Object.fromEntries(Object.entries(this.setupPose.bones).map(([id, pose]) => [id, { ...pose }])) };
  }

  setPose(pose: RigPose): void {
    this.bones.forEach((bone, boneId) => {
      const next = pose.bones[boneId];
      if (!next) throw new Error(`Pose is missing bone "${boneId}"`);
      bone.reset(next);
    });
  }

  updateBonePose(boneId: string, patch: BonePosePatch): void {
    const bone = this.bones.get(boneId);
    if (!bone) throw new Error(`Bone "${boneId}" does not exist`);
    bone.update(patch);
  }

  resetToSetupPose(): void {
    this.bones.forEach((bone, boneId) => {
      const setup = this.setupPose.bones[boneId];
      if (setup) bone.reset(setup);
    });
  }

  replaceSlotAttachment(slotId: string, attachmentId: string | null): void {
    const slot = this.slots.get(slotId);
    if (!slot) throw new Error(`Slot "${slotId}" does not exist`);
    if (attachmentId !== null && !this.definition.attachments.some((attachment) => attachment.id === attachmentId)) {
      throw new Error(`Attachment "${attachmentId}" does not exist`);
    }
    slot.replaceAttachment(attachmentId);
  }

  clearSlotAttachmentOverride(slotId: string): void {
    const slot = this.slots.get(slotId);
    if (!slot) throw new Error(`Slot "${slotId}" does not exist`);
    slot.clearAttachmentOverride();
  }

  applySkin(skinId: string): void {
    if (!this.definition.skins.some((skin) => skin.id === skinId)) throw new Error(`Skin "${skinId}" does not exist`);
    this.skinId = skinId;
  }

  getSkinId(): string {
    return this.skinId;
  }

  getSlotAttachmentOverrides(): SlotAttachmentOverrides {
    const overrides: Record<string, string | null> = {};
    this.slots.forEach((slot) => slot.writeOverride(overrides));
    return overrides;
  }

  getResolvedSlots(): ResolvedSlot[] {
    return resolveSlots(this.definition, this.skinId, this.getSlotAttachmentOverrides());
  }

  getWorldTransforms(): WorldTransforms {
    return computeWorldTransforms(this.definition, this.getPose());
  }
}
