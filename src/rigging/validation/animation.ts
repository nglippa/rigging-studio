import type { AnimationDefinition, RigDefinition } from "../schema/types";
import type { ValidationIssue } from "./issues";

export function validateAnimationDefinition(animation: AnimationDefinition, rig?: RigDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const boneIds = rig ? new Set(rig.bones.map((bone) => bone.id)) : undefined;
  const tracks = new Map<string, number>();
  animation.tracks.forEach((track, trackIndex) => {
    if (boneIds && !boneIds.has(track.boneId)) issues.push({ code: "missing_animation_bone", path: ["tracks", trackIndex, "boneId"], message: `Track references missing bone "${track.boneId}"` });
    const key = `${track.boneId}:${track.property}`;
    const first = tracks.get(key);
    if (first === undefined) tracks.set(key, trackIndex);
    else issues.push({ code: "duplicate_animation_track", path: ["tracks", trackIndex], message: `Track duplicates tracks[${first}]` });
    track.keyframes.forEach((frame, frameIndex) => {
      if (frame.time > animation.duration) issues.push({ code: "keyframe_after_duration", path: ["tracks", trackIndex, "keyframes", frameIndex, "time"], message: `Time ${frame.time} exceeds duration ${animation.duration}` });
      if (frameIndex > 0 && frame.time <= track.keyframes[frameIndex - 1].time) issues.push({ code: "unsorted_keyframes", path: ["tracks", trackIndex, "keyframes", frameIndex, "time"], message: "Keyframe times must be strictly increasing" });
    });
  });
  return issues;
}
