import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateAnimationAtTime } from "../../src/rigging/animation/evaluate";
import { clampToLimits, defaultBendLimits, withDefaultBendLimits } from "../../src/rigging/motion/bendLimits";
import { buildStandardClips } from "../../src/rigging/motion/rigMotion";
import { createRestPose } from "../../src/rigging/runtime/pose";
import { safeParseRigJson } from "../../src/rigging/schema/parsing";
import type { RigPose } from "../../src/rigging/runtime/types";
import type { RigDefinition } from "../../src/rigging/schema/types";

const bench = (name: string): RigDefinition => {
  const parsed = safeParseRigJson(readFileSync(`tests/fixtures/bench-rigs/${name}.rig.json`, "utf8"));
  if (!parsed.success) throw new Error(`bench rig ${name} did not parse`);
  return parsed.data;
};
const degrees = (radians: number): number => radians * 180 / Math.PI;
const radians = (value: number): number => value * Math.PI / 180;

describe("bend limits", () => {
  const goblin = bench("goblin-warrior-pixel");
  const limited: RigDefinition = { ...goblin, bones: goblin.bones.map((bone) => bone.id === "left-lower-arm" ? { ...bone, rotation: 10, rotationLimits: { min: -10, max: 20 } } : bone) };
  const posed = (value: number): RigPose => { const rest = createRestPose(limited); return { bones: { ...rest.bones, "left-lower-arm": { ...rest.bones["left-lower-arm"], rotation: radians(value) } } }; };

  it("clamps a posed rotation into the bone's range, measured from its rest rotation", () => {
    expect(degrees(clampToLimits(limited, posed(10 + 45)).bones["left-lower-arm"].rotation)).toBeCloseTo(30);
    expect(degrees(clampToLimits(limited, posed(10 - 30)).bones["left-lower-arm"].rotation)).toBeCloseTo(0);
    expect(degrees(clampToLimits(limited, posed(15)).bones["left-lower-arm"].rotation)).toBeCloseTo(15);
  });

  it("leaves a bone without limits unchanged", () => {
    const pose = posed(15); const rest = pose.bones["left-upper-arm"];
    const moved = { bones: { ...pose.bones, "left-upper-arm": { ...rest, rotation: radians(300) } } };
    expect(clampToLimits(limited, moved).bones["left-upper-arm"].rotation).toBe(radians(300));
  });

  it("is applied last by evaluateAnimationAtTime when given the rig", () => {
    const clip = { schemaVersion: 1, id: "test", name: "Test", duration: 1, loop: false, tracks: [{ boneId: "left-lower-arm", property: "rotation" as const, keyframes: [{ time: 0, value: 90, easing: "linear" as const }, { time: 1, value: 90, easing: "linear" as const }] }] };
    const pose = evaluateAnimationAtTime(clip as never, createRestPose(limited), .5, limited);
    expect(degrees(pose.bones["left-lower-arm"].rotation)).toBeCloseTo(30);
    expect(degrees(evaluateAnimationAtTime(clip as never, createRestPose(limited), .5).bones["left-lower-arm"].rotation)).toBeCloseTo(90);
  });

  it("gives each joint a starting range by its role", () => {
    const limits = defaultBendLimits(goblin);
    expect(limits["left-lower-arm"]).toEqual({ min: -150, max: 150 });
    expect(limits["right-lower-leg"]).toEqual({ min: -150, max: 150 });
    expect(limits["left-foot"]).toEqual({ min: -120, max: 120 });
    expect(limits.head).toEqual({ min: -40, max: 40 });
    expect(limits.torso).toEqual({ min: -30, max: 30 });
    // Shoulders and wrists circle overhead in Raise arms; the root moves the whole body.
    expect(limits["left-upper-arm"]).toBeUndefined();
    expect(limits["left-hand"]).toBeUndefined();
    expect(limits.root).toBeUndefined();
  });

  const variants = (["goblin-warrior-pixel", "elf-mage-pixel"] as const).flatMap((name) => ([null, "left", "right"] as const).map((facing) => [name, facing] as const));
  it.each(variants)("does not change today's standard clips on %s (facing %s)", (name, facing) => {
    const source = bench(name); const rig = facing ? { ...source, metadata: { ...source.metadata, facing } } : source;
    const withLimits = withDefaultBendLimits(rig); const rest = createRestPose(rig);
    for (const clip of buildStandardClips(rig)) {
      const times = [...(clip.drawings ?? []), ...Array.from({ length: 97 }, (_, index) => clip.duration * index / 96)];
      for (const time of times) {
        const free = evaluateAnimationAtTime(clip, rest, time);
        const clamped = evaluateAnimationAtTime(clip, rest, time, withLimits);
        for (const [boneId, bone] of Object.entries(free.bones)) expect(clamped.bones[boneId].rotation, `${clip.id} ${boneId} at ${time.toFixed(3)}`).toBeCloseTo(bone.rotation, 6);
      }
    }
  });
});
