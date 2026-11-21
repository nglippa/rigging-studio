import { updateBonePose } from "../runtime/pose";
import { degreesToRadians } from "../math/rotation";
import { clampToLimits } from "../runtime/limits";
import type { RigPose } from "../runtime/types";
import type { AnimationDefinition, AnimationTrack, Keyframe, RigDefinition } from "../schema/types";
import { applyEasing } from "./easing";

export const sampleTrack = (track: AnimationTrack, time: number): number => {
  const frames = track.keyframes;
  if (time <= frames[0].time) return frames[0].value;
  if (time >= frames[frames.length - 1].time) return frames[frames.length - 1].value;
  let left: Keyframe = frames[0];
  let right: Keyframe = frames[frames.length - 1];
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index].time >= time) { left = frames[index - 1]; right = frames[index]; break; }
  }
  const progress = (time - left.time) / (right.time - left.time);
  return left.value + (right.value - left.value) * applyEasing(left.easing, progress);
};

export function animationTime(animation: AnimationDefinition, elapsed: number): number {
  if (!animation.loop) return Math.min(animation.duration, Math.max(0, elapsed));
  return ((elapsed % animation.duration) + animation.duration) % animation.duration;
}

/** The time of the drawing on screen at `time`: the latest drawing time not after it (the time itself when the clip has none). */
export function drawingTime(animation: AnimationDefinition, time: number): number {
  const drawings = animation.drawings; if (!drawings?.length) return time;
  let shown = drawings[0]; for (const at of drawings) { if (at <= time + 1e-9) shown = at; else break; }
  return shown;
}

export function evaluateAnimation(animation: AnimationDefinition, basePose: RigPose, elapsed: number, rig?: RigDefinition): RigPose {
  return evaluateAnimationAtTime(animation, basePose, drawingTime(animation, animationTime(animation, elapsed)), rig);
}

/** The pose at `time`. Given the rig, each joint's bend limits are applied last, so no clip can bend a joint past them. */
export function evaluateAnimationAtTime(animation: AnimationDefinition, basePose: RigPose, time: number, rig?: RigDefinition): RigPose {
  const pose = animation.tracks.reduce((current, track) => updateBonePose(current, track.boneId, {
    [track.property]: track.property === "rotation"
      ? degreesToRadians(sampleTrack(track, time))
      : sampleTrack(track, time),
  }), basePose);
  return rig ? clampToLimits(rig, pose) : pose;
}
