import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { safeParseAnimationJson, safeParseRigJson } from "../../src/rigging/schema/parsing";
import { applyViewportEdit, setupPoseUnchanged } from "../../src/tools/rig-editor/animation/autokey";
import { AnimationCommandHistory } from "../../src/tools/rig-editor/animation/history";
import { animationById, createAnimationLibrary, replaceAnimation } from "../../src/tools/rig-editor/animation/library";
import {
  matchFirstPoseAtEnd, moveKeyframes, reverseAnimation, scaleAnimationTiming, upsertKeyframe,
} from "../../src/tools/rig-editor/animation/operations";
import { validAnimation, validRig } from "./fixtures";

describe("animation authoring operations", () => {
  it("ships six clips that validate against the sample rig", () => {
    const rigResult = safeParseRigJson(readFileSync(resolve("public/rig-test/minimal-rig.json"), "utf8"));
    expect(rigResult.success).toBe(true);
    if (!rigResult.success) return;
    for (const id of ["idle", "walk", "run", "melee_attack", "hurt", "death"]) {
      const result = safeParseAnimationJson(readFileSync(resolve(`public/rig-test/animations/${id}.json`), "utf8"), rigResult.data);
      expect(result.success, id).toBe(true);
    }
  });

  it("inserts a keyframe in sorted order", () => {
    const result = upsertKeyframe(validAnimation(), "child", "rotation", { time: .5, value: 12, easing: "easeIn" });
    expect(result.tracks[0].keyframes.map((frame) => frame.time)).toEqual([0, .5, 1]);
  });

  it("replaces effectively duplicate times instead of adding duplicates", () => {
    let result = upsertKeyframe(validAnimation(), "child", "rotation", { time: .5, value: 12, easing: "linear" });
    result = upsertKeyframe(result, "child", "rotation", { time: .50001, value: 20, easing: "stepped" });
    expect(result.tracks[0].keyframes).toHaveLength(3);
    expect(result.tracks[0].keyframes[1].value).toBe(20);
  });

  it("drags a keyframe and returns its new selection", () => {
    const animation = upsertKeyframe(validAnimation(), "child", "rotation", { time: .5, value: 12, easing: "linear" });
    const result = moveKeyframes(animation, [{ boneId: "child", property: "rotation", time: .5 }], .2, "clamp");
    expect(result.animation.tracks[0].keyframes.map((frame) => frame.time)).toEqual([0, .7, 1]);
    expect(result.selections[0].time).toBeCloseTo(.7);
  });

  it("moves multiple keys by one shared clamped delta", () => {
    let animation = upsertKeyframe(validAnimation(), "child", "x", { time: .25, value: 3, easing: "linear" });
    animation = upsertKeyframe(animation, "child", "y", { time: .5, value: 4, easing: "linear" });
    const result = moveKeyframes(animation, [
      { boneId: "child", property: "x", time: .25 }, { boneId: "child", property: "y", time: .5 },
    ], .8, "clamp");
    expect(result.selections.map((selection) => selection.time)).toEqual([.75, 1]);
  });

  it("reverses animation key times and preserves duration", () => {
    const animation = upsertKeyframe(validAnimation(), "child", "rotation", { time: .25, value: 4, easing: "easeIn" });
    const result = reverseAnimation(animation);
    expect(result.duration).toBe(1);
    expect(result.tracks[0].keyframes.map((frame) => frame.time)).toEqual([0, .75, 1]);
    expect(result.tracks[0].keyframes[1].value).toBe(4);
  });

  it("scales key times and duration together", () => {
    const result = scaleAnimationTiming(validAnimation(), 2.5);
    expect(result.duration).toBe(2.5);
    expect(result.tracks[0].keyframes.at(-1)?.time).toBe(2.5);
  });

  it("matches every track's first value at animation end", () => {
    const source = { ...validAnimation(), tracks: [{ ...validAnimation().tracks[0], keyframes: [
      { time: 0, value: 3, easing: "linear" as const }, { time: 1, value: 8, easing: "linear" as const },
    ] }] };
    const result = matchFirstPoseAtEnd(source);
    expect(result.tracks[0].keyframes.at(-1)?.value).toBe(3);
  });

  it("gates viewport edits behind Auto-Key without mutating setup data", () => {
    const rig = validRig(); const before = structuredClone(rig); const animation = validAnimation();
    const off = applyViewportEdit(animation, "child", .4, { rotation: 25 }, false);
    expect(off.animation).toBe(animation); expect(off.pendingPatch).toEqual({ rotation: 25 });
    const on = applyViewportEdit(animation, "child", .4, { rotation: 25 }, true);
    expect(on.animation.tracks[0].keyframes.some((frame) => frame.time === .4 && frame.value === 25)).toBe(true);
    expect(setupPoseUnchanged(before, rig)).toBe(true);
  });

  it("undoes and redoes animation commands", () => {
    const initial = createAnimationLibrary("unit-rig", [validAnimation()]);
    const history = new AnimationCommandHistory(initial);
    history.execute("Insert key", (library) => {
      const current = animationById(library, "idle")!;
      return replaceAnimation(library, upsertKeyframe(current, "child", "x", { time: .5, value: 2, easing: "linear" }));
    });
    expect(animationById(history.present, "idle")?.tracks).toHaveLength(2);
    expect(animationById(history.undo(), "idle")?.tracks).toHaveLength(1);
    expect(animationById(history.redo(), "idle")?.tracks).toHaveLength(2);
  });

  it("coalesces an animation drag transaction into one undo entry", () => {
    const initial = createAnimationLibrary("unit-rig", [validAnimation()]);
    const history = new AnimationCommandHistory(initial);
    history.beginTransaction("Drag keys");
    history.updateTransaction({ ...history.present, metadata: { preview: 1 } });
    history.updateTransaction({ ...history.present, metadata: { preview: 2 } });
    history.commitTransaction();
    expect(history.undoCount).toBe(1);
  });
});
