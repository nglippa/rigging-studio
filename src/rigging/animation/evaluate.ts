import { updateBonePose } from "../runtime/pose";
import { degreesToRadians } from "../math/rotation";
import type { RigPose } from "../runtime/types";
import type { AnimationDefinition, AnimationTrack, Keyframe } from "../schema/types";
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

export function evaluateAnimation(animation: AnimationDefinition, basePose: RigPose, elapsed: number): RigPose {
  return evaluateAnimationAtTime(animation, basePose, animationTime(animation, elapsed));
}

export function evaluateAnimationAtTime(animation: AnimationDefinition, basePose: RigPose, time: number): RigPose {
  return animation.tracks.reduce((pose, track) => updateBonePose(pose, track.boneId, {
    [track.property]: track.property === "rotation"
      ? degreesToRadians(sampleTrack(track, time))
      : sampleTrack(track, time),
  }), basePose);
}
