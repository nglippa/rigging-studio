import { describe, expect, it } from "vitest";
import { AnimationPlayer } from "../../src/rigging/animation/AnimationPlayer";
import { RigRuntime } from "../../src/rigging/runtime/RigRuntime";
import type { AnimationDefinition, RigDefinition } from "../../src/rigging/schema/types";
import { validRig } from "./fixtures";

const animation = (
  property: "x" | "y" | "rotation" | "scaleX" | "scaleY",
  easing: "linear" | "easeIn" | "easeOut" | "easeInOut" | "stepped" = "linear",
  loop = true,
): AnimationDefinition => ({
  schemaVersion: 1,
  id: `${property}-${easing}`,
  name: "Test",
  duration: 1,
  loop,
  tracks: [{ boneId: "child", property, keyframes: [
    { time: 0, value: 0, easing },
    { time: 1, value: 10, easing: "linear" },
  ] }],
});

describe("AnimationPlayer", () => {
  it("interpolates linearly between keyframes", () => {
    const runtime = new RigRuntime(validRig());
    const player = new AnimationPlayer(runtime);
    player.play(animation("x"));
    player.pause();
    player.seek(0.5);
    expect(runtime.getPose().bones.child.x).toBeCloseTo(5);
  });

  it("holds the prior value for stepped interpolation", () => {
    const runtime = new RigRuntime(validRig());
    const player = new AnimationPlayer(runtime);
    player.play(animation("x", "stepped"));
    player.seek(0.75);
    expect(runtime.getPose().bones.child.x).toBe(0);
  });

  it("wraps loop time", () => {
    const runtime = new RigRuntime(validRig());
    const player = new AnimationPlayer(runtime);
    player.play(animation("x"));
    player.update(1.25);
    expect(player.currentTime).toBeCloseTo(0.25);
    expect(runtime.getPose().bones.child.x).toBeCloseTo(2.5);
  });

  it("completes and clamps non-looping playback", () => {
    const runtime = new RigRuntime(validRig());
    const player = new AnimationPlayer(runtime);
    player.play(animation("x", "linear", false));
    player.update(2);
    expect(player.currentTime).toBe(1);
    expect(player.completed).toBe(true);
    expect(player.isPlaying).toBe(false);
    expect(runtime.getPose().bones.child.x).toBe(10);
  });

  it("uses setup-pose values for unanimated properties", () => {
    const rig: RigDefinition = {
      ...validRig(),
      bones: validRig().bones.map((bone) => bone.id === "child" ? { ...bone, y: 7, rotation: 30, scaleY: 1.4 } : bone),
    };
    const runtime = new RigRuntime(rig);
    const player = new AnimationPlayer(runtime);
    player.play(animation("x"));
    player.seek(0.5);
    const pose = runtime.getPose().bones.child;
    expect(pose.y).toBe(7);
    expect(pose.rotation).toBeCloseTo(Math.PI / 6);
    expect(pose.scaleY).toBe(1.4);
  });

  it("produces the same pose every time it seeks to a time", () => {
    const source = animation("x", "easeInOut");
    const sourceSnapshot = structuredClone(source);
    const runtime = new RigRuntime(validRig());
    const player = new AnimationPlayer(runtime);
    player.play(source);
    player.seek(0.37);
    const first = runtime.getPose();
    player.seek(0.82);
    player.seek(0.37);
    expect(runtime.getPose()).toEqual(first);
    expect(source).toEqual(sourceSnapshot);
  });
});
