import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateAnimationAtTime } from "../../src/rigging/animation/evaluate";
import { analyzeRigAnatomy, buildMotionClip, buildStandardClips, motionForRequest, type RigFacing } from "../../src/rigging/motion/rigMotion";
import { createRestPose } from "../../src/rigging/runtime/pose";
import { computeWorldTransforms } from "../../src/rigging/runtime/worldTransforms";
import { safeParseAnimationDefinition, safeParseRigJson } from "../../src/rigging/schema/parsing";
import type { AnimationDefinition, BoneDefinition, RigDefinition } from "../../src/rigging/schema/types";
import { createAnimationLibrary } from "../../src/tools/rig-editor/animation/library";
import { refreshStandardClips } from "../../src/tools/rig-editor/animation/samplePaths";

const b = (id: string, parentId: string | null, x: number, y: number): BoneDefinition => ({ id, parentId, x, y, rotation: 0, scaleX: 1, scaleY: 1, length: 20, inheritRotation: true, inheritScale: true });

/** A generated-style rig: every bone unrotated, limbs hanging straight down. `leftOnScreen` puts the character's left side at −x or +x. */
const rig = (facing: RigFacing | null, options: { readonly leftOnScreen?: -1 | 1; readonly armsOut?: boolean } = {}): RigDefinition => {
  const side = options.leftOnScreen ?? -1;
  const arm = (name: "left" | "right", sign: number): BoneDefinition[] => options.armsOut
    ? [b(`${name}-upper-arm`, "torso", 22 * sign, -30), b(`${name}-lower-arm`, `${name}-upper-arm`, 26 * sign, 0), b(`${name}-hand`, `${name}-lower-arm`, 22 * sign, 0)]
    : [b(`${name}-upper-arm`, "torso", 22 * sign, -30), b(`${name}-lower-arm`, `${name}-upper-arm`, 0, 26), b(`${name}-hand`, `${name}-lower-arm`, 0, 22)];
  const leg = (name: "left" | "right", sign: number): BoneDefinition[] => [b(`${name}-upper-leg`, "pelvis", 10 * sign, 3), b(`${name}-lower-leg`, `${name}-upper-leg`, 0, 43), b(`${name}-foot`, `${name}-lower-leg`, 0, 38)];
  return {
    schemaVersion: 1, id: `rig-${facing ?? "auto"}`, canvas: { width: 240, height: 260 }, rootBoneId: "root",
    bones: [b("root", null, 120, 105), b("pelvis", "root", 0, 0), b("torso", "pelvis", 0, -34), b("neck", "torso", 0, -38), b("head", "neck", 0, -16), ...arm("left", side), ...arm("right", -side), ...leg("left", side), ...leg("right", -side)],
    slots: [], attachments: [], skins: [{ id: "base", name: "Base", slotAttachments: {} }], defaultSkinId: "base", metadata: facing ? { facing } : {},
  };
};

/** Adds foot art whose toes point along `toes` (+1 right, −1 left, 0 centred under the ankle). */
const withFeet = (source: RigDefinition, toes: -1 | 0 | 1): RigDefinition => ({
  ...source,
  slots: (["left", "right"] as const).map((name, index) => ({ id: `${name}-foot-slot`, boneId: `${name}-foot`, attachmentId: `${name}-foot`, zIndex: index, visible: true, blendMode: "normal" as const, tint: 0xffffff, pivotX: toes === 1 ? 4 : toes === -1 ? 20 : 12, pivotY: 2 })),
  attachments: (["left", "right"] as const).map((name) => ({ id: `${name}-foot`, imagePath: `parts/${name}-foot.png`, width: 24, height: 10, offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1, category: "body" as const, tags: ["body"] })),
});

const joints = (source: RigDefinition, clip: AnimationDefinition | null, time: number): Record<string, { x: number; y: number }> => {
  const rest = createRestPose(source);
  const world = computeWorldTransforms(source, clip ? evaluateAnimationAtTime(clip, rest, time) : rest);
  return Object.fromEntries(source.bones.map((bone) => [bone.id, { x: world[bone.id].x, y: world[bone.id].y }]));
};
const clipFor = (source: RigDefinition, id: Parameters<typeof buildMotionClip>[1]): AnimationDefinition => {
  const clip = buildMotionClip(source, id);
  if (!clip) throw new Error(`no ${id} clip`);
  return clip;
};

describe("rig-aware standard motions", () => {
  it("reads which way a character faces from its feet, and accepts a declared facing", () => {
    expect(analyzeRigAnatomy(withFeet(rig(null), 1)).facing).toBe("right");
    expect(analyzeRigAnatomy(withFeet(rig(null), -1)).facing).toBe("left");
    expect(analyzeRigAnatomy(withFeet(rig(null), 0))).toMatchObject({ facing: "front", facingSource: "feet-art" });
    expect(analyzeRigAnatomy(rig(null))).toMatchObject({ facing: "front", facingSource: "default" });
    expect(analyzeRigAnatomy(withFeet(rig("left"), 1))).toMatchObject({ facing: "left", facingSource: "metadata" });
  });

  it("says when the art cannot settle which way the character faces", () => {
    expect(analyzeRigAnatomy(withFeet(rig(null), 1)).facingCertainty).toBe("clear");
    expect(analyzeRigAnatomy(withFeet(rig(null), 0)).facingCertainty).toBe("clear");
    expect(analyzeRigAnatomy(rig("left")).facingCertainty).toBe("declared");
    expect(analyzeRigAnatomy(rig(null)).facingCertainty).toBe("unsure");
    // Feet splayed in opposite directions: a front view and a three-quarter view look the same.
    const splayed = withFeet(rig(null), 1);
    const outward = { ...splayed, slots: splayed.slots.map((slot) => slot.boneId === "left-foot" ? { ...slot, pivotX: 20 } : slot) };
    expect(analyzeRigAnatomy(outward)).toMatchObject({ facing: "front", facingCertainty: "unsure" });
  });

  it("every clip is valid for its rig and starts from the rest pose", () => {
    for (const source of [rig("right"), rig("left"), rig("front"), rig("front", { leftOnScreen: 1, armsOut: true })]) {
      const clips = buildStandardClips(source);
      expect(clips.map((clip) => clip.id)).toEqual(["idle", "walk", "run", "raise_arms", "melee_attack", "hurt", "death"]);
      const rest = joints(source, null, 0);
      for (const clip of clips) {
        expect(safeParseAnimationDefinition(clip, source).success, `${source.id} ${clip.id}`).toBe(true);
        if (clip.id === "walk" || clip.id === "run") continue;
        const start = joints(source, clip, 0);
        for (const id of Object.keys(rest)) { expect(start[id].x).toBeCloseTo(rest[id].x, 3); expect(start[id].y).toBeCloseTo(rest[id].y, 3); }
      }
    }
  });

  it.each([["right", 1], ["left", -1]] as const)("a %s-facing gait follows the human cycle: reach forward at heel strike, trail behind at push-off, knees fold backward", (facing, sign) => {
    for (const gait of ["walk", "run"] as const) {
      const source = rig(facing); const clip = clipFor(source, gait); const rest = joints(source, null, 0);
      const strike = joints(source, clip, 0); const pushOff = joints(source, clip, clip.duration * .5);
      const ahead = (pose: typeof rest, name: string): number => (pose[`${name}-foot`].x - pose.pelvis.x) * sign;
      // The first leg lands in front of the body and half a cycle later is behind it; the second leg is the opposite.
      expect(ahead(strike, "left")).toBeGreaterThan(15); expect(ahead(pushOff, "left")).toBeLessThan(-3);
      expect(ahead(strike, "right")).toBeLessThan(-3); expect(ahead(pushOff, "right")).toBeGreaterThan(15);
      // A stride reaches further forward than back, as a hip does.
      const knee = (pose: typeof rest): number => (pose["left-lower-leg"].x - pose["left-upper-leg"].x) * sign;
      expect(knee(strike)).toBeGreaterThan(-knee(pushOff) * 1.5);
      let peakKnee = 0; let peakAt = 0; let grounded = 0;
      for (let step = 0; step < 48; step += 1) {
        const pose = joints(source, clip, clip.duration * step / 48);
        for (const name of ["left", "right"]) {
          const hip = pose[`${name}-upper-leg`]; const knee = pose[`${name}-lower-leg`]; const foot = pose[`${name}-foot`];
          // A knee only folds one way: the foot is never in front of the line of its thigh.
          const bend = (knee.x - hip.x) * (foot.y - knee.y) - (knee.y - hip.y) * (foot.x - knee.x);
          expect(bend * sign, `${gait} ${name} step ${step}`).toBeGreaterThanOrEqual(-1e-6);
          if (name === "left" && bend * sign > peakKnee) { peakKnee = bend * sign; peakAt = step / 48; }
          // Neither foot ever sinks below the ground.
          expect(foot.y).toBeLessThanOrEqual(rest[`${name}-foot`].y + 1.5);
        }
        if (Math.max(pose["left-foot"].y, pose["right-foot"].y) > rest["left-foot"].y - 2) grounded += 1;
      }
      // The big knee bend comes in swing, after push-off, while the thigh travels forward.
      expect(peakAt).toBeGreaterThan(.5); expect(peakAt).toBeLessThan(.9);
      // A walk always has a foot on the ground; a run leaves it.
      if (gait === "walk") expect(grounded).toBeGreaterThanOrEqual(46); else expect(grounded).toBeLessThan(40);
      // Arms swing against the leg on their own side.
      expect((strike["left-hand"].x - strike["left-upper-arm"].x) * sign).toBeLessThan(0);
      expect((strike["right-hand"].x - strike["right-upper-arm"].x) * sign).toBeGreaterThan(0);
    }
  });

  it("a character drawn with its legs apart still walks with a normal stride in profile", () => {
    const base = rig("right");
    const spread: RigDefinition = { ...base, bones: base.bones.map((bone) => bone.id === "left-lower-leg" ? { ...bone, x: -14 } : bone.id === "right-lower-leg" ? { ...bone, x: 14 } : bone) };
    const clip = clipFor(spread, "walk");
    // A third of the way through, the first leg is under the body carrying the weight: its thigh is close to vertical.
    const pose = joints(spread, clip, clip.duration * .3);
    expect(Math.abs(pose["left-lower-leg"].x - pose["left-upper-leg"].x)).toBeLessThan(8);
    const strike = joints(spread, clip, 0);
    const reach = (name: string): number => Math.atan2(strike[`${name}-lower-leg`].x - strike[`${name}-upper-leg`].x, strike[`${name}-lower-leg`].y - strike[`${name}-upper-leg`].y) * 180 / Math.PI;
    // Measured mean hip angles at heel strike and at the opposite leg's push-off (Fukuchi et al. 2018).
    expect(reach("left")).toBeCloseTo(30.7, 0); expect(reach("right")).toBeCloseTo(-7.6, 0);
  });

  it("mirrors exactly when the same character faces the other way", () => {
    const right = clipFor(rig("right"), "walk"); const left = clipFor(rig("left"), "walk");
    const thigh = (clip: AnimationDefinition): number[] => clip.tracks.find((track) => track.boneId === "left-upper-leg" && track.property === "rotation")!.keyframes.map((key) => key.value);
    expect(thigh(left)).toEqual(thigh(right).map((value) => value === 0 ? 0 : -value));
  });

  it("a front-facing step lifts the foot straight up under its hip and never swings a leg sideways", () => {
    for (const leftOnScreen of [-1, 1] as const) {
      const source = rig("front", { leftOnScreen }); const clip = clipFor(source, "walk"); const rest = joints(source, null, 0);
      expect(clip.tracks.some((track) => /upper-leg/.test(track.boneId) && track.property === "scaleY")).toBe(true);
      const swing = joints(source, clip, clip.duration * .7); const stance = joints(source, clip, clip.duration * .25);
      // In its swing the left foot is clearly off the ground while the right foot stands on it, and the reverse half a cycle later.
      expect(swing["left-foot"].y).toBeLessThan(rest["left-foot"].y - 6);
      expect(swing["right-foot"].y).toBeCloseTo(rest["right-foot"].y, 0);
      expect(stance["left-foot"].y).toBeCloseTo(rest["left-foot"].y, 0);
      for (let step = 0; step < 24; step += 1) {
        const pose = joints(source, clip, clip.duration * step / 24);
        for (const name of ["left", "right"]) {
          // Knee and foot stay under the hip: no splaying outward.
          expect(Math.abs((pose[`${name}-foot`].x - pose[`${name}-upper-leg`].x) - (rest[`${name}-foot`].x - rest[`${name}-upper-leg`].x))).toBeLessThan(4);
          expect(pose[`${name}-foot`].y).toBeLessThanOrEqual(rest[`${name}-foot`].y + 1.5);
        }
      }
      // The hips move over the standing leg.
      expect(Math.sign(stance.pelvis.x - rest.pelvis.x)).toBe(leftOnScreen);
    }
  });

  it("lifts each foot visibly even when the legs are tiny, as on a chibi or pixel sprite", () => {
    const base = rig("front");
    const chibi: RigDefinition = { ...base, bones: base.bones.map((bone) => /lower-leg$/.test(bone.id) ? { ...bone, y: 6 } : /foot$/.test(bone.id) ? { ...bone, y: 5 } : bone) };
    const clip = clipFor(chibi, "walk"); const rest = joints(chibi, null, 0);
    const height = Math.max(...Object.values(rest).map((point) => point.y)) - Math.min(...Object.values(rest).map((point) => point.y));
    const highest = Math.max(...Array.from({ length: 24 }, (_unused, step) => rest["left-foot"].y - joints(chibi, clip, clip.duration * step / 24)["left-foot"].y));
    expect(highest).toBeGreaterThanOrEqual(height * .035);
  });

  it("keeps a held weapon at the angle it was drawn while the arms go up", () => {
    const base = rig("front");
    const armed: RigDefinition = { ...base,
      slots: [
        { id: "sword-slot", boneId: "right-hand", attachmentId: "sword", zIndex: 1, visible: true, blendMode: "normal", tint: 0xffffff, pivotX: 2, pivotY: 18 },
        { id: "fist-slot", boneId: "left-hand", attachmentId: "fist", zIndex: 1, visible: true, blendMode: "normal", tint: 0xffffff, pivotX: 3, pivotY: 0 },
      ],
      attachments: [
        { id: "sword", imagePath: "parts/sword.png", width: 4, height: 20, offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1, category: "equipment", tags: ["mainHandEquipment"] },
        { id: "fist", imagePath: "parts/fist.png", width: 6, height: 6, offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1, category: "body", tags: ["leftHand"] },
      ],
      skins: [{ id: "base", name: "Base", slotAttachments: { "sword-slot": "sword", "fist-slot": "fist" } }] };
    const clip = clipFor(armed, "raise_arms");
    const world = (time: number) => computeWorldTransforms(armed, evaluateAnimationAtTime(clip, createRestPose(armed), time));
    expect(world(clip.duration * .5)["right-hand"].rotation).toBeCloseTo(world(0)["right-hand"].rotation, 3);
    // The free hand is not held level: it follows its arm up.
    expect(Math.abs(world(clip.duration * .5)["left-hand"].rotation - world(0)["left-hand"].rotation)).toBeGreaterThan(1);
  });

  it("raise arms puts both hands above the head whichever way the arms rest and the character faces", () => {
    for (const source of [rig("right"), rig("left"), rig("front"), rig("front", { leftOnScreen: 1 }), rig("front", { armsOut: true }), rig("right", { armsOut: true })]) {
      const clip = clipFor(source, "raise_arms"); const held = joints(source, clip, clip.duration * .5);
      for (const name of ["left", "right"]) {
        expect(held[`${name}-hand`].y, `${source.id} ${name}`).toBeLessThan(held.head.y);
        expect(held[`${name}-hand`].y).toBeLessThan(held[`${name}-lower-arm`].y);
        expect(held[`${name}-lower-arm`].y).toBeLessThan(held[`${name}-upper-arm`].y);
      }
      if (source.metadata.facing === "front") {
        // Each arm goes up on its own side of the body.
        const centre = held.torso.x;
        expect(Math.sign(held["left-hand"].x - centre)).toBe(Math.sign(joints(source, null, 0)["left-upper-arm"].x - centre));
      }
    }
  });

  it("attacks strike forward, hurt recoils backward and death falls onto the back", () => {
    for (const [facing, sign] of [["right", 1], ["left", -1]] as const) {
      const source = rig(facing); const rest = joints(source, null, 0);
      const attack = clipFor(source, "melee_attack");
      const windUp = joints(source, attack, attack.duration * .22); const strike = joints(source, attack, attack.duration * .45);
      expect((strike["right-hand"].x - windUp["right-hand"].x) * sign).toBeGreaterThan(10);
      const hurt = clipFor(source, "hurt");
      expect((joints(source, hurt, hurt.duration * .15).head.x - rest.head.x) * sign).toBeLessThan(-2);
      const death = clipFor(source, "death"); const fallen = joints(source, death, death.duration);
      expect((fallen.head.x - fallen.pelvis.x) * sign).toBeLessThan(-20);
      expect(Math.abs(fallen.head.y - fallen.pelvis.y)).toBeLessThan(12);
      expect(fallen.pelvis.y).toBeGreaterThan(rest.pelvis.y + 20);
    }
  });

  it("works on a hand-built rig whose bones are rotated at rest", () => {
    const parsed = safeParseRigJson(readFileSync(new URL("../../public/rig-test/minimal-rig.json", import.meta.url), "utf8"));
    if (!parsed.success) throw new Error(parsed.message);
    const knight = parsed.data; const anatomy = analyzeRigAnatomy(knight);
    expect(["left", "right", "front"]).toContain(anatomy.facing);
    const clip = clipFor(knight, "raise_arms"); const held = joints(knight, clip, clip.duration * .5);
    expect(held["left-hand"].y).toBeLessThan(held["left-upper-arm"].y);
    expect(held["right-hand"].y).toBeLessThan(held["right-upper-arm"].y);
  });

  it("names the motion a request asks for", () => {
    expect(motionForRequest("Raise both arms overhead")).toBe("raise_arms");
    expect(motionForRequest("a brisk walk cycle")).toBe("walk");
    expect(motionForRequest("Run fast")).toBe("run");
    expect(motionForRequest("wiggle the ears")).toBeNull();
  });

  it("rebuilds standard clips nobody edited and keeps the ones somebody did", () => {
    const source = rig("right"); const standard = buildStandardClips(source);
    const knightWalk: AnimationDefinition = { schemaVersion: 1, id: "walk", name: "Walk", duration: 1, loop: true, tracks: [{ boneId: "left-upper-leg", property: "rotation", keyframes: [{ time: 0, value: 62, easing: "linear" }] }] };
    const editedRun: AnimationDefinition = { ...standard.find((clip) => clip.id === "run")!, duration: 2 };
    const first = refreshStandardClips(createAnimationLibrary(source.id, [knightWalk, editedRun]), [knightWalk], standard);
    expect(first.animations.find((clip) => clip.id === "walk")).toEqual(standard.find((clip) => clip.id === "walk"));
    expect(first.animations.find((clip) => clip.id === "run")?.duration).toBe(2);
    expect(first.animations.map((clip) => clip.id)).toContain("raise_arms");
    // The rig changes facing: untouched clips follow it, the edited one and a deleted one do not come back.
    const turned = buildStandardClips({ ...source, metadata: { facing: "left" } });
    const second = refreshStandardClips({ ...first, animations: first.animations.filter((clip) => clip.id !== "death") }, [knightWalk], turned);
    expect(second.animations.find((clip) => clip.id === "walk")).toEqual(turned.find((clip) => clip.id === "walk"));
    expect(second.animations.find((clip) => clip.id === "run")?.duration).toBe(2);
    expect(second.animations.some((clip) => clip.id === "death")).toBe(false);
    expect(refreshStandardClips(second, [knightWalk], turned).animations.some((clip) => clip.id === "death")).toBe(false);
  });
});

describe("three-quarter characters", () => {
  /** The largest thigh rotation over a walk cycle, in degrees. */
  const thighSwing = (source: RigDefinition): number => {
    const clip = clipFor(source, "walk");
    const track = clip.tracks.find((candidate) => candidate.boneId === "left-upper-leg" && candidate.property === "rotation");
    if (!track) throw new Error("no thigh track");
    const values = track.keyframes.map((key) => Number(key.value));
    return Math.max(...values) - Math.min(...values);
  };

  it("foreshortens the stride of a turned character instead of swinging it as if drawn side-on", () => {
    const profile = rig("right");
    const turned = { ...profile, metadata: { ...profile.metadata, characterView: "three-quarter" } };
    expect(analyzeRigAnatomy(turned).planeScale).toBeCloseTo(Math.SQRT1_2, 6);
    expect(analyzeRigAnatomy(profile).planeScale).toBe(1);
    const side = thighSwing(profile); const quarter = thighSwing(turned);
    expect(quarter).toBeLessThan(side * .85);
    expect(quarter).toBeGreaterThan(side * .55);
  });

  it("leaves front-facing characters alone even when the view says three-quarter", () => {
    const front = { ...rig("front"), metadata: { facing: "front", characterView: "three-quarter" } };
    expect(analyzeRigAnatomy(front).planeScale).toBe(1);
  });
});
