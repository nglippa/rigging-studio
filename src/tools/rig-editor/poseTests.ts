import { ANIMATION_SCHEMA_VERSION, type AnimationDefinition, type AnimationTrack, type RigDefinition } from "../../rigging/schema/types";
import { chainForBone, isEquipmentId, type RigChainId } from "./rigReview";

/**
 * Quick tests are throwaway rotation sweeps played in the viewport so a rig can be checked before any
 * animation exists. They are never added to the animation library and never change the rig.
 */
export type PoseTestId = "arm" | "leg" | "full" | "equipment";
export const POSE_TESTS: readonly { readonly id: PoseTestId; readonly label: string; readonly hint: string }[] = [
  { id: "arm", label: "Arm test", hint: "Swing shoulders, elbows and wrists" },
  { id: "leg", label: "Leg test", hint: "Swing hips, knees and ankles" },
  { id: "full", label: "Full rotation test", hint: "Rotate every joint in turn" },
  { id: "equipment", label: "Equipment test", hint: "Swing the bones that carry equipment" },
];

const CHAINS_BY_TEST: Readonly<Record<Exclude<PoseTestId, "full" | "equipment">, readonly RigChainId[]>> = { arm: ["left-arm", "right-arm"], leg: ["left-leg", "right-leg"] };

export function poseTestBoneIds(rig: RigDefinition, test: PoseTestId): readonly string[] {
  if (test === "full") return rig.bones.filter((bone) => bone.id !== rig.rootBoneId).map((bone) => bone.id);
  if (test === "equipment") {
    const carriers = new Set(rig.slots.filter((slot) => isEquipmentId(`${slot.id} ${slot.attachmentId ?? ""}`)).map((slot) => slot.boneId));
    return rig.bones.filter((bone) => bone.id !== rig.rootBoneId && (chainForBone(bone.id) === "equipment" || carriers.has(bone.id))).map((bone) => bone.id);
  }
  const chains = CHAINS_BY_TEST[test];
  return rig.bones.filter((bone) => chains.includes(chainForBone(bone.id))).map((bone) => bone.id);
}

/** A looping sweep that rotates each listed bone to +amplitude, −amplitude and back, staggered so joints read separately. */
export function buildRotationSweep(rig: RigDefinition, boneIds: readonly string[], options: { readonly id?: string; readonly amplitude?: number; readonly secondsPerBone?: number } = {}): AnimationDefinition | null {
  const bones = boneIds.flatMap((id) => { const bone = rig.bones.find((candidate) => candidate.id === id); return bone ? [bone] : []; });
  if (!bones.length) return null;
  const amplitude = options.amplitude ?? 32;
  const swing = options.secondsPerBone ?? 1.1;
  // Overlap neighbouring joints by 60% so a long chain still finishes quickly.
  const stagger = swing * 0.4;
  const duration = Number((swing + stagger * (bones.length - 1)).toFixed(3));
  const tracks: AnimationTrack[] = bones.map((bone, index) => {
    const start = stagger * index;
    const at = (fraction: number): number => Number(Math.min(duration, start + swing * fraction).toFixed(3));
    const frames = [
      { time: 0, value: bone.rotation },
      { time: at(0), value: bone.rotation },
      { time: at(0.25), value: bone.rotation + amplitude },
      { time: at(0.75), value: bone.rotation - amplitude },
      { time: at(1), value: bone.rotation },
      { time: duration, value: bone.rotation },
    ];
    const keyframes = frames.filter((frame, frameIndex) => frameIndex === 0 || frame.time > frames[frameIndex - 1].time).map((frame) => ({ ...frame, easing: "easeInOut" as const }));
    return { boneId: bone.id, property: "rotation", keyframes };
  });
  return { schemaVersion: ANIMATION_SCHEMA_VERSION, id: options.id ?? "pose-test", name: "Pose test", duration, loop: true, tracks };
}

export const buildPoseTest = (rig: RigDefinition, test: PoseTestId): AnimationDefinition | null => buildRotationSweep(rig, poseTestBoneIds(rig, test), { id: `pose-test-${test}` });
