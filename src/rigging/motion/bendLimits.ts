import { clampToLimits } from "../runtime/limits";
import type { RigDefinition } from "../schema/types";
import { analyzeRigAnatomy } from "./rigMotion";

export { clampToLimits };

export type BendLimits = { min: number; max: number };

const either = (degrees: number): BendLimits => ({ min: -degrees, max: degrees });

/**
 * Starting bend ranges for a rig's joints, by the role each bone plays, in degrees either way from rest:
 * elbows, knees and hips 150°; ankles 120°; neck and head 40°; torso 30°. Shoulders and wrists get none, because
 * Raise arms carries them overhead through almost a full turn. Other bones get none.
 *
 * The ranges are symmetric and generous on purpose: the generated clips bend elbows and knees both ways depending on
 * the view (seen from the front a fold has no fixed side), and these defaults must never change the studio's own
 * motion. They stop a joint flipping inside out; tighter, one-sided ranges are set per joint in the Rig expanded view.
 */
export function defaultBendLimits(rig: RigDefinition): Record<string, BendLimits> {
  const anatomy = analyzeRigAnatomy(rig);
  const limits: Record<string, BendLimits> = {};
  for (const arm of anatomy.arms) if (arm.lower) limits[arm.lower.id] = either(150);
  for (const leg of anatomy.legs) {
    limits[leg.upper.id] = either(150);
    if (leg.lower) limits[leg.lower.id] = either(150);
    if (leg.end) limits[leg.end.id] = either(120);
  }
  for (const bone of rig.bones) if (/neck/i.test(bone.id)) limits[bone.id] = either(40);
  if (anatomy.head) limits[anatomy.head.id] = either(40);
  if (anatomy.torso) limits[anatomy.torso.id] = either(30);
  return limits;
}

/** The rig with the default ranges filled in for every joint that has none of its own. */
export function withDefaultBendLimits(rig: RigDefinition): RigDefinition {
  const defaults = defaultBendLimits(rig);
  return { ...rig, bones: rig.bones.map((bone) => bone.rotationLimits || !defaults[bone.id] ? bone : { ...bone, rotationLimits: defaults[bone.id] }) };
}
