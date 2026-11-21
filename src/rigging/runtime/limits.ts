import { degreesToRadians } from "../math/rotation";
import type { RigDefinition } from "../schema/types";
import type { RigPose } from "./types";

const toDegrees = (radians: number): number => radians * 180 / Math.PI;
/** An angle folded into (-180, 180]. */
const wrap = (degrees: number): number => { const folded = ((degrees + 180) % 360 + 360) % 360 - 180; return folded === -180 ? 180 : folded; };

/**
 * The pose with every limited joint turned back inside its range. Ranges are in degrees from the bone's rest rotation;
 * bones without limits, and joints already inside their range, keep their pose object unchanged.
 */
export function clampToLimits(rig: RigDefinition, pose: RigPose): RigPose {
  let bones: Record<string, RigPose["bones"][string]> | null = null;
  for (const bone of rig.bones) {
    const limits = bone.rotationLimits; const posed = pose.bones[bone.id];
    if (!limits || !posed) continue;
    const turned = wrap(toDegrees(posed.rotation) - bone.rotation);
    const clamped = Math.min(limits.max, Math.max(limits.min, turned));
    if (clamped === turned) continue;
    bones ??= { ...pose.bones };
    bones[bone.id] = { ...posed, rotation: degreesToRadians(bone.rotation + clamped) };
  }
  return bones ? { ...pose, bones } : pose;
}
