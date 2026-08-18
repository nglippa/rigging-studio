import { sampleTrack } from "../../../rigging/animation/evaluate";
import type { AnimatedProperty, AnimationDefinition, AnimationTrack, Easing, Keyframe, RigDefinition } from "../../../rigging/schema/types";
import type { AnimationBonePatch, DurationPolicy, KeyframeClipboard, KeyframeSelection } from "./types";

export const KEY_TIME_EPSILON = 0.0001;
const sameTime = (left: number, right: number): boolean => Math.abs(left - right) <= KEY_TIME_EPSILON;
const trackMatches = (track: AnimationTrack, ref: KeyframeSelection): boolean => track.boneId === ref.boneId && track.property === ref.property;
const snapTime = (time: number, increment?: number): number => increment && increment > 0 ? Math.round(time / increment) * increment : time;

export const upsertKeyframe = (animation: AnimationDefinition, boneId: string, property: AnimatedProperty, frame: Keyframe): AnimationDefinition => {
  const tracks = [...animation.tracks];
  const index = tracks.findIndex((track) => track.boneId === boneId && track.property === property);
  if (index < 0) return { ...animation, tracks: [...tracks, { boneId, property, keyframes: [frame] }] };
  const track = tracks[index];
  const frames = track.keyframes.filter((candidate) => !sameTime(candidate.time, frame.time));
  frames.push(frame);
  frames.sort((left, right) => left.time - right.time);
  tracks[index] = { ...track, keyframes: frames };
  return { ...animation, tracks };
};

export const removeKeyframes = (animation: AnimationDefinition, selections: readonly KeyframeSelection[]): AnimationDefinition => {
  const tracks = animation.tracks.flatMap((track) => {
    const frames = track.keyframes.filter((frame) => !selections.some((selection) => trackMatches(track, selection) && sameTime(frame.time, selection.time)));
    return frames.length ? [{ ...track, keyframes: frames }] : [];
  });
  return { ...animation, tracks };
};

export const updateKeyframe = (animation: AnimationDefinition, selection: KeyframeSelection, patch: Partial<Keyframe>): AnimationDefinition => {
  const track = animation.tracks.find((candidate) => trackMatches(candidate, selection));
  const current = track?.keyframes.find((frame) => sameTime(frame.time, selection.time));
  if (!current) return animation;
  const without = removeKeyframes(animation, [selection]);
  const nextTime = Math.max(0, Math.min(animation.duration, patch.time ?? current.time));
  return upsertKeyframe(without, selection.boneId, selection.property, { ...current, ...patch, time: nextTime });
};

export const selectedFrames = (animation: AnimationDefinition, selections: readonly KeyframeSelection[]) => animation.tracks.flatMap((track) =>
  track.keyframes.flatMap((frame) => selections.some((selection) => trackMatches(track, selection) && sameTime(frame.time, selection.time))
    ? [{ selection: { boneId: track.boneId, property: track.property, time: frame.time }, frame }]
    : []));

export const moveKeyframes = (animation: AnimationDefinition, selections: readonly KeyframeSelection[], requestedDelta: number, policy: DurationPolicy, increment?: number): { animation: AnimationDefinition; selections: readonly KeyframeSelection[] } => {
  const picked = selectedFrames(animation, selections);
  if (!picked.length) return { animation, selections };
  const minTime = Math.min(...picked.map(({ frame }) => frame.time));
  const maxTime = Math.max(...picked.map(({ frame }) => frame.time));
  let delta = requestedDelta;
  if (policy === "clamp") delta = Math.max(-minTime, Math.min(animation.duration - maxTime, delta));
  else delta = Math.max(-minTime, delta);
  let next = removeKeyframes(animation, selections);
  const moved: KeyframeSelection[] = [];
  let duration = animation.duration;
  for (const { selection, frame } of picked) {
    const time = Math.max(0, snapTime(frame.time + delta, increment));
    duration = policy === "expand" ? Math.max(duration, time) : duration;
    next = upsertKeyframe(next, selection.boneId, selection.property, { ...frame, time });
    moved.push({ ...selection, time });
  }
  return { animation: { ...next, duration }, selections: moved };
};

export const copyKeyframes = (animation: AnimationDefinition, selections: readonly KeyframeSelection[]): KeyframeClipboard => {
  const picked = selectedFrames(animation, selections);
  const start = picked.length ? Math.min(...picked.map(({ frame }) => frame.time)) : 0;
  return { duration: animation.duration, keyframes: picked.map(({ selection, frame }) => ({
    boneId: selection.boneId, property: selection.property, relativeTime: frame.time - start, value: frame.value, easing: frame.easing,
  })) };
};

export const pasteKeyframes = (animation: AnimationDefinition, clipboard: KeyframeClipboard, atTime: number, policy: DurationPolicy): { animation: AnimationDefinition; selections: readonly KeyframeSelection[] } => {
  let next = animation;
  let duration = animation.duration;
  const selections: KeyframeSelection[] = [];
  for (const copied of clipboard.keyframes) {
    let time = atTime + copied.relativeTime;
    if (policy === "clamp") time = Math.min(duration, time); else duration = Math.max(duration, time);
    next = upsertKeyframe(next, copied.boneId, copied.property, { time, value: copied.value, easing: copied.easing });
    selections.push({ boneId: copied.boneId, property: copied.property, time });
  }
  return { animation: { ...next, duration }, selections };
};

const reverseEasing = (easing: Easing): Easing => easing === "easeIn" ? "easeOut" : easing === "easeOut" ? "easeIn" : easing;
export const reverseAnimation = (animation: AnimationDefinition): AnimationDefinition => ({ ...animation, tracks: animation.tracks.map((track) => ({
  ...track,
  keyframes: track.keyframes.map((frame, index, frames) => ({
    ...frame,
    time: animation.duration - frame.time,
    easing: index > 0 ? reverseEasing(frames[index - 1].easing) : frame.easing,
  })).sort((a, b) => a.time - b.time),
})) });

export const setAnimationDuration = (animation: AnimationDefinition, duration: number): AnimationDefinition => {
  if (!Number.isFinite(duration) || duration <= 0) return animation;
  return { ...animation, duration, tracks: animation.tracks.map((track) => {
    const frames: Keyframe[] = [];
    for (const source of track.keyframes) {
      const frame = { ...source, time: Math.min(source.time, duration) };
      if (frames.length && sameTime(frames[frames.length - 1].time, frame.time)) frames[frames.length - 1] = frame;
      else frames.push(frame);
    }
    return { ...track, keyframes: frames };
  }) };
};

export const scaleAnimationTiming = (animation: AnimationDefinition, factor: number): AnimationDefinition => {
  if (!Number.isFinite(factor) || factor <= 0) return animation;
  return { ...animation, duration: animation.duration * factor, tracks: animation.tracks.map((track) => ({
    ...track, keyframes: track.keyframes.map((frame) => ({ ...frame, time: frame.time * factor })),
  })) };
};

export const matchFirstPoseAtEnd = (animation: AnimationDefinition): AnimationDefinition => animation.tracks.reduce((next, track) =>
  upsertKeyframe(next, track.boneId, track.property, { time: animation.duration, value: sampleTrack(track, 0), easing: track.keyframes[0].easing }), animation);

export const removeRedundantKeys = (animation: AnimationDefinition, tolerance = 0.001): AnimationDefinition => ({ ...animation, tracks: animation.tracks.map((track) => {
  const frames = track.keyframes.filter((frame, index, all) => {
    if (index === 0 || index === all.length - 1) return true;
    const previous = all[index - 1]; const next = all[index + 1];
    const ratio = (frame.time - previous.time) / (next.time - previous.time);
    const expected = previous.value + (next.value - previous.value) * ratio;
    return Math.abs(frame.value - expected) > tolerance || previous.easing !== "linear" || frame.easing !== "linear";
  });
  return { ...track, keyframes: frames };
}) });

export const applyBonePatch = (animation: AnimationDefinition, boneId: string, time: number, patch: AnimationBonePatch, easing: Easing = "linear"): AnimationDefinition =>
  (Object.entries(patch) as [AnimatedProperty, number][]).reduce((next, [property, value]) => upsertKeyframe(next, boneId, property, { time, value, easing }), animation);

export const mirrorPose = (animation: AnimationDefinition, rig: RigDefinition, time: number, pairs: readonly (readonly [string, string])[]): AnimationDefinition => {
  const setup = new Map(rig.bones.map((bone) => [bone.id, bone]));
  const value = (boneId: string, property: AnimatedProperty): number => {
    const track = animation.tracks.find((candidate) => candidate.boneId === boneId && candidate.property === property);
    const bone = setup.get(boneId);
    return track ? sampleTrack(track, time) : (bone?.[property] ?? (property.startsWith("scale") ? 1 : 0));
  };
  let next = animation;
  for (const [left, right] of pairs) for (const property of ["x", "y", "rotation", "scaleX", "scaleY"] as const) {
    const sign = property === "x" || property === "rotation" ? -1 : 1;
    next = applyBonePatch(next, left, time, { [property]: value(right, property) * sign });
    next = applyBonePatch(next, right, time, { [property]: value(left, property) * sign });
  }
  return next;
};

export const adjacentKeyTimes = (animation: AnimationDefinition, time: number): { previous: number | null; next: number | null } => {
  const times = [...new Set(animation.tracks.flatMap((track) => track.keyframes.map((frame) => frame.time)))].sort((a, b) => a - b);
  return { previous: times.filter((candidate) => candidate < time - KEY_TIME_EPSILON).at(-1) ?? null, next: times.find((candidate) => candidate > time + KEY_TIME_EPSILON) ?? null };
};
