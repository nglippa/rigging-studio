import type { AnimationDefinition, AnimationTrack, Keyframe } from "../schema/types";

export const animationTrackKey = (track: Pick<AnimationTrack, "boneId" | "property">): string => `${track.boneId}:${track.property}`;
const TIME_EPSILON = .0001;
const findFrameAt = (frames: readonly Keyframe[], time: number): Keyframe | undefined => frames.find((frame) => Math.abs(frame.time - time) <= TIME_EPSILON);

export type AnimationTrackDiff = {
  readonly key: string;
  readonly boneId: string;
  readonly property: AnimationTrack["property"];
  readonly status: "added" | "removed" | "changed";
  readonly keyframesAdded: number;
  readonly keyframesRemoved: number;
  readonly valuesChanged: number;
};

export type AnimationDiff = {
  readonly tracksAdded: number;
  readonly tracksRemoved: number;
  readonly tracksChanged: number;
  readonly keyframesAdded: number;
  readonly keyframesRemoved: number;
  readonly valuesChanged: number;
  readonly durationChanged: boolean;
  readonly previousDuration: number;
  readonly nextDuration: number;
  readonly loopChanged: boolean;
  readonly previousLoop: boolean;
  readonly nextLoop: boolean;
  readonly tracks: readonly AnimationTrackDiff[];
};

export const diffAnimations = (before: AnimationDefinition, after: AnimationDefinition): AnimationDiff => {
  const previous = new Map(before.tracks.map((track) => [animationTrackKey(track), track]));
  const next = new Map(after.tracks.map((track) => [animationTrackKey(track), track]));
  const keys = new Set([...previous.keys(), ...next.keys()]);
  const tracks: AnimationTrackDiff[] = [];
  keys.forEach((key) => {
    const left = previous.get(key); const right = next.get(key);
    if (!left && right) { tracks.push({ key, boneId: right.boneId, property: right.property, status: "added", keyframesAdded: right.keyframes.length, keyframesRemoved: 0, valuesChanged: 0 }); return; }
    if (left && !right) { tracks.push({ key, boneId: left.boneId, property: left.property, status: "removed", keyframesAdded: 0, keyframesRemoved: left.keyframes.length, valuesChanged: 0 }); return; }
    if (!left || !right) return;
    const added = right.keyframes.filter((frame) => !findFrameAt(left.keyframes, frame.time)).length;
    const removed = left.keyframes.filter((frame) => !findFrameAt(right.keyframes, frame.time)).length;
    const changed = right.keyframes.filter((frame) => {
      const match = findFrameAt(left.keyframes, frame.time);
      return match && (match.value !== frame.value || match.easing !== frame.easing);
    }).length;
    if (added || removed || changed) tracks.push({ key, boneId: right.boneId, property: right.property, status: "changed", keyframesAdded: added, keyframesRemoved: removed, valuesChanged: changed });
  });
  return {
    tracksAdded: tracks.filter((track) => track.status === "added").length,
    tracksRemoved: tracks.filter((track) => track.status === "removed").length,
    tracksChanged: tracks.filter((track) => track.status === "changed").length,
    keyframesAdded: tracks.reduce((sum, track) => sum + track.keyframesAdded, 0),
    keyframesRemoved: tracks.reduce((sum, track) => sum + track.keyframesRemoved, 0),
    valuesChanged: tracks.reduce((sum, track) => sum + track.valuesChanged, 0),
    durationChanged: before.duration !== after.duration,
    previousDuration: before.duration,
    nextDuration: after.duration,
    loopChanged: before.loop !== after.loop,
    previousLoop: before.loop,
    nextLoop: after.loop,
    tracks,
  };
};
