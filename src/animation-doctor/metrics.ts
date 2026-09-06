import { evaluateAnimationAtTime } from "../rigging/animation/evaluate";
import { transformPoint } from "../rigging/math/matrix";
import { createRestPose } from "../rigging/runtime/pose";
import { computeWorldTransforms } from "../rigging/runtime/worldTransforms";
import type { AnimationDefinition, RigDefinition } from "../rigging/schema/types";
import { doctorMeasurementSchema, type DoctorMeasurements } from "./schema";

export type MotionMetrics = { footDrift: number | null; gripError: number | null; loopContinuity: number | null; recoveryError: number | null; motionTravel: number; channelCount: number; animationLength: number };
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
export function measureDoctorMotion(rig: RigDefinition, animation: AnimationDefinition, input: DoctorMeasurements): MotionMetrics {
  const constraints = doctorMeasurementSchema.parse(input);
  const rest = createRestPose(rig);
  const worldAt = (time: number) => computeWorldTransforms(rig, evaluateAnimationAtTime(animation, rest, time));
  for (const contact of constraints.contacts) if (contact.start >= contact.end || contact.end > animation.duration || !rig.bones.some((bone) => bone.id === contact.boneId)) throw new Error("Invalid authored foot contact");
  for (const grip of constraints.grips) if (![grip.handBoneId, grip.equipmentBoneId].every((id) => rig.bones.some((bone) => bone.id === id))) throw new Error("Invalid authored grip reference");
  const worlds = Array.from({ length: 49 }, (_, i) => worldAt(animation.duration * i / 48));
  const first = worlds[0]; const last = worlds.at(-1)!;
  // Include bone tips as well as origins: rotation-only endpoint defects must be visible to the metric.
  const seam = Math.max(0, ...rig.bones.map((bone) => Math.max(distance(first[bone.id], last[bone.id]), distance(transformPoint(first[bone.id].matrix, { x: bone.length, y: 0 }), transformPoint(last[bone.id].matrix, { x: bone.length, y: 0 })))));
  const motionTravel = rig.bones.reduce((sum, bone) => sum + worlds.slice(1).reduce((travel, world, i) => travel + distance(transformPoint(world[bone.id].matrix, { x: bone.length, y: 0 }), transformPoint(worlds[i][bone.id].matrix, { x: bone.length, y: 0 })), 0), 0);
  const footDrift = constraints.contacts.length ? Math.max(...constraints.contacts.map((contact) => {
    const start = worldAt(contact.start)[contact.boneId];
    return Math.max(...Array.from({ length: 17 }, (_, i) => distance(start, worldAt(contact.start + (contact.end - contact.start) * i / 16)[contact.boneId])));
  })) : null;
  const gripError = constraints.grips.length ? Math.max(...constraints.grips.flatMap((grip) => worlds.map((world) => distance(transformPoint(world[grip.handBoneId].matrix, { x: grip.handX, y: grip.handY }), transformPoint(world[grip.equipmentBoneId].matrix, { x: grip.equipmentX, y: grip.equipmentY }))))) : null;
  return { footDrift, gripError, loopContinuity: animation.loop ? seam : null, recoveryError: animation.loop ? null : seam, motionTravel, channelCount: animation.tracks.length, animationLength: animation.duration };
}

export function compareDoctorMetrics(before: MotionMetrics, after: MotionMetrics): string[] {
  const vetoes: string[] = [];
  for (const key of ["footDrift", "gripError", "loopContinuity", "recoveryError"] as const) {
    if (before[key] !== null && (after[key] === null || after[key]! > before[key]! + .001)) vetoes.push(`${key} regressed`);
  }
  if (after.channelCount !== before.channelCount || after.animationLength !== before.animationLength) vetoes.push("Clip structure changed");
  if (before.motionTravel > .01 && after.motionTravel < before.motionTravel * .85) vetoes.push("Motion collapsed: possible metric gaming");
  if (!Object.values(after).every((value) => value === null || Number.isFinite(value))) vetoes.push("Non-finite measurement");
  return vetoes;
}
