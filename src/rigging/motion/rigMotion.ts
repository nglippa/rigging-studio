import { matrixFromTransform, multiplyMatrices, transformPoint, type Point } from "../math/matrix";
import { degreesToRadians } from "../math/rotation";
import { createRestPose } from "../runtime/pose";
import { computeWorldTransforms } from "../runtime/worldTransforms";
import { ANIMATION_SCHEMA_VERSION, type AnimatedProperty, type AnimationDefinition, type AnimationTrack, type BoneDefinition, type Easing, type RigDefinition } from "../schema/types";

/**
 * Standard motions built for one particular rig.
 *
 * A clip stores absolute local angles, so a clip authored for one character only works on a character whose
 * bones rest the same way. This module instead describes each motion anatomically ("swing the thigh forward",
 * "bend the knee", "lift the arm overhead") and resolves every such instruction against the rig it is given:
 * which way the character faces, which way each limb points at rest, and which way its knees and elbows bend.
 * Every value written is the bone's own rest value plus a delta, so the rest pose is always the starting point.
 */
export type RigFacing = "left" | "right" | "front";
export type FacingSource = "metadata" | "feet-art" | "foot-bones" | "default";
/** "unsure" means the art alone cannot settle it: feet splayed in opposite directions read the same from the front and in a three-quarter view. */
export type FacingCertainty = "declared" | "clear" | "unsure";
export type MotionId = "idle" | "walk" | "run" | "raise_arms" | "melee_attack" | "hurt" | "death";
export const STANDARD_MOTIONS: readonly { readonly id: MotionId; readonly name: string; readonly duration: number; readonly loop: boolean }[] = [
  { id: "idle", name: "Idle", duration: 2, loop: true },
  { id: "walk", name: "Walk", duration: 1, loop: true },
  { id: "run", name: "Run", duration: .7, loop: true },
  { id: "raise_arms", name: "Raise Arms", duration: 1.6, loop: true },
  { id: "melee_attack", name: "Melee Attack", duration: .8, loop: false },
  { id: "hurt", name: "Hurt", duration: .6, loop: false },
  { id: "death", name: "Death", duration: 1.5, loop: false },
];

type Side = "left" | "right";
type Limb = {
  readonly side: Side;
  readonly upper: BoneDefinition;
  readonly lower: BoneDefinition | null;
  readonly end: BoneDefinition | null;
  /** Rest direction of the upper segment (joint to next joint), world space, y down. */
  readonly upperDir: Point;
  readonly lowerDir: Point;
  /** +1 when this limb sits on the screen-right side of the body, −1 on the screen-left side. */
  readonly outward: 1 | -1;
  /** Rotation sign that bends the middle joint (knee or elbow) the way that joint bends. */
  readonly bendSign: 1 | -1;
  /** How far the middle joint is already bent at rest, in degrees (unsigned). */
  readonly restBend: number;
  readonly length: number;
  readonly carriesEquipment: boolean;
  /** The local scale axis that runs along each segment, used to foreshorten a limb that swings toward the viewer. */
  readonly upperAxis: "scaleX" | "scaleY";
  readonly lowerAxis: "scaleX" | "scaleY";
};
export type RigAnatomy = {
  readonly facing: RigFacing;
  readonly facingSource: FacingSource;
  readonly facingCertainty: FacingCertainty;
  /**
   * How much of a side-on swing shows on screen: 1 in profile, cos 45° for a three-quarter view (rig.metadata.characterView,
   * set by the pose model at Build rig). Picture-plane angles are projected through it, so a turned character's stride is
   * foreshortened instead of swinging as if drawn side-on.
   */
  readonly planeScale: number;
  readonly height: number;
  readonly groundY: number;
  readonly arms: readonly Limb[];
  readonly legs: readonly Limb[];
  readonly root: BoneDefinition | null;
  readonly pelvis: BoneDefinition | null;
  readonly torso: BoneDefinition | null;
  readonly head: BoneDefinition | null;
  /** The bone whose vertical motion carries the body: the pelvis when the legs hang from it, otherwise the torso. */
  readonly bodyBone: BoneDefinition | null;
  readonly bodyCarriesLegs: boolean;
  readonly torsoDir: Point;
};

const UP: Point = { x: 0, y: -1 };
const DOWN: Point = { x: 0, y: 1 };
const deg = (radians: number): number => radians * 180 / Math.PI;
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const len = (p: Point): number => Math.hypot(p.x, p.y);
const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
/** Signed angle in degrees that rotates `from` onto `to`. Positive is the runtime's positive rotation (clockwise on screen). */
const angleTo = (from: Point, to: Point): number => deg(Math.atan2(cross(from, to), dot(from, to)));
/** The rotation sign that moves a segment pointing along `direction` toward `toward`. */
const turn = (direction: Point, toward: Point): 1 | -1 => cross(direction, toward) >= 0 ? 1 : -1;
const round = (value: number): number => { const next = Number(value.toFixed(3)); return Object.is(next, -0) ? 0 : next; };

type World = ReturnType<typeof computeWorldTransforms>;

const artCentre = (rig: RigDefinition, world: World, bone: BoneDefinition): { readonly centre: Point; readonly width: number } | null => {
  const skin = rig.skins.find((candidate) => candidate.id === rig.defaultSkinId);
  for (const slot of rig.slots) {
    if (slot.boneId !== bone.id || slot.visible === false) continue;
    const assigned = skin?.slotAttachments[slot.id];
    const attachment = rig.attachments.find((candidate) => candidate.id === (assigned === undefined ? slot.attachmentId : assigned));
    if (!attachment || attachment.category === "equipment") continue;
    const matrix = multiplyMatrices(world[bone.id].matrix, matrixFromTransform({ x: attachment.offsetX, y: attachment.offsetY, rotation: degreesToRadians(attachment.rotation), scaleX: attachment.scaleX, scaleY: attachment.scaleY }));
    return { centre: transformPoint(matrix, { x: attachment.width / 2 - slot.pivotX, y: attachment.height / 2 - slot.pivotY }), width: attachment.width * Math.abs(attachment.scaleX) };
  }
  return null;
};

const carriesEquipment = (rig: RigDefinition, boneId: string): boolean => rig.slots.some((slot) => {
  if (slot.boneId !== boneId) return false;
  const attachment = rig.attachments.find((candidate) => candidate.id === slot.attachmentId);
  return attachment?.category === "equipment";
});

function limb(rig: RigDefinition, world: World, side: Side, kind: "arm" | "leg", facingSign: number): Limb | null {
  const on = (pattern: RegExp): BoneDefinition | null => rig.bones.find((bone) => bone.id.toLowerCase().includes(side) && pattern.test(bone.id)) ?? null;
  const upper = kind === "arm" ? on(/upper.*arm|shoulder/i) : on(/upper.*leg|thigh/i);
  if (!upper) return null;
  const lower = kind === "arm" ? on(/lower.*arm|fore.*arm/i) : on(/lower.*leg|shin|calf/i);
  const end = kind === "arm" ? on(/hand/i) : on(/foot/i);
  const at = (bone: BoneDefinition): Point => ({ x: world[bone.id].x, y: world[bone.id].y });
  const axis = (bone: BoneDefinition): Point => { const rotation = world[bone.id].rotation; const reach = Math.max(1, bone.length); return { x: Math.cos(rotation) * reach, y: Math.sin(rotation) * reach }; };
  const next = lower ?? end;
  const upperDir = next && len(sub(at(next), at(upper))) >= 1 ? sub(at(next), at(upper)) : axis(upper);
  const lowerDir = lower && end && len(sub(at(end), at(lower))) >= 1 ? sub(at(end), at(lower)) : lower ? axis(lower) : upperDir;
  const other = rig.bones.find((bone) => bone.id === upper.id.replace(side, side === "left" ? "right" : "left"));
  const offset = other ? at(upper).x - at(other).x : upperDir.x;
  const outward: 1 | -1 = Math.abs(offset) >= 1 ? (offset > 0 ? 1 : -1) : side === "left" ? -1 : 1;
  const restAngle = angleTo(upperDir, lowerDir);
  // A joint that is already bent shows which way it bends. A straight one is resolved from the anatomy:
  // knees carry the foot backward, elbows carry the hand forward; seen from the front both fold toward the body.
  const anatomical = facingSign === 0 ? turn(lowerDir, { x: -outward, y: 0 }) : turn(lowerDir, { x: kind === "leg" ? -facingSign : facingSign, y: 0 });
  const bendSign: 1 | -1 = lower && Math.abs(restAngle) > 12 ? (restAngle > 0 ? 1 : -1) : anatomical;
  const alongAxis = (bone: BoneDefinition, direction: Point): "scaleX" | "scaleY" => { const rotation = world[bone.id].rotation; return Math.abs(direction.x * Math.cos(rotation) + direction.y * Math.sin(rotation)) > Math.abs(-direction.x * Math.sin(rotation) + direction.y * Math.cos(rotation)) ? "scaleX" : "scaleY"; };
  return {
    side, upper, lower, end, upperDir, lowerDir, outward, bendSign, restBend: Math.abs(restAngle), length: len(upperDir) + (lower ? len(lowerDir) : 0),
    carriesEquipment: [upper, lower, end].some((bone) => bone && carriesEquipment(rig, bone.id)), upperAxis: alongAxis(upper, upperDir), lowerAxis: lower ? alongAxis(lower, lowerDir) : "scaleY",
  };
}

function detectFacing(rig: RigDefinition, world: World): { readonly facing: RigFacing; readonly source: FacingSource; readonly certainty: FacingCertainty } {
  const declared = rig.metadata.facing;
  if (declared === "left" || declared === "right" || declared === "front") return { facing: declared, source: "metadata", certainty: "declared" };
  const feet = rig.bones.filter((bone) => /foot/i.test(bone.id));
  // Toes point the way the character faces: where the foot art sits relative to its ankle.
  // Measured against the shin's art where there is one: an ankle pivot can sit anywhere along the foot, the shin cannot.
  const toes = feet.flatMap((foot) => {
    const art = artCentre(rig, world, foot); if (!art) return [];
    const shin = rig.bones.find((bone) => bone.id === foot.parentId); const shinArt = shin ? artCentre(rig, world, shin) : null;
    return [(art.centre.x - (shinArt ? shinArt.centre.x : world[foot.id].x)) / Math.max(1, art.width / 2)];
  });
  if (toes.length) {
    const agree = toes.every((value) => Math.sign(value) === Math.sign(toes[0]));
    const mean = toes.reduce((sum, value) => sum + value, 0) / toes.length;
    // A side view hides the far leg behind the near one: one leg has no art, or the two hips sit almost on top of each other.
    // In that shape even a slight toe lean is enough to say which way the character faces.
    const hips = (["left", "right"] as const).map((side) => rig.bones.find((bone) => bone.id.toLowerCase().includes(side) && /upper.*leg|thigh/i.test(bone.id)));
    const legHasArt = (side: string): boolean => rig.bones.some((bone) => bone.id.toLowerCase().includes(side) && /leg|thigh|shin|calf|foot/i.test(bone.id) && artCentre(rig, world, bone) !== null);
    const ys = rig.bones.map((bone) => world[bone.id].y); const height = Math.max(1, Math.max(...ys) - Math.min(...ys));
    const profileShape = legHasArt("left") !== legHasArt("right") || (!!hips[0] && !!hips[1] && Math.abs(world[hips[0].id].x - world[hips[1].id].x) < height * .05);
    const sideways = agree && (toes.every((value) => Math.abs(value) > .22) || (profileShape && Math.abs(mean) > .05));
    // Front is only certain when every foot points straight at the viewer.
    const certainty: FacingCertainty = sideways || toes.every((value) => Math.abs(value) < .25) ? "clear" : "unsure";
    return { facing: sideways ? (mean > 0 ? "right" : "left") : "front", source: "feet-art", certainty };
  }
  // Hand-built rigs aim each bone along its part, so a foot bone's own axis points at the toes. Generated rigs keep every bone unrotated.
  if (feet.length && rig.bones.some((bone) => Math.abs(bone.rotation) > .5)) {
    const axes = feet.map((foot) => Math.cos(world[foot.id].rotation));
    if (axes.every((value) => Math.abs(value) > .6) && axes.every((value) => Math.sign(value) === Math.sign(axes[0]))) return { facing: axes[0] > 0 ? "right" : "left", source: "foot-bones", certainty: "clear" };
    return { facing: "front", source: "foot-bones", certainty: "unsure" };
  }
  return { facing: "front", source: "default", certainty: "unsure" };
}

export function analyzeRigAnatomy(rig: RigDefinition): RigAnatomy {
  const world = computeWorldTransforms(rig, createRestPose(rig));
  const { facing, source, certainty } = detectFacing(rig, world);
  const facingSign = facing === "right" ? 1 : facing === "left" ? -1 : 0;
  const named = (pattern: RegExp): BoneDefinition | null => rig.bones.find((bone) => pattern.test(bone.id) && !/left|right/i.test(bone.id)) ?? null;
  const root = rig.bones.find((bone) => bone.id === rig.rootBoneId) ?? rig.bones.find((bone) => bone.parentId === null) ?? null;
  const pelvis = named(/pelvis|hips/i); const torso = named(/torso|chest|spine/i); const head = named(/head/i); const neck = named(/neck/i);
  const limbs = (kind: "arm" | "leg"): Limb[] => (["left", "right"] as const).flatMap((side) => { const found = limb(rig, world, side, kind, facingSign); return found ? [found] : []; });
  const arms = limbs("arm"); const legs = limbs("leg");
  const ys = rig.bones.map((bone) => world[bone.id].y);
  const feetY = legs.flatMap((leg) => leg.end ? [world[leg.end.id].y] : []);
  const descendsFrom = (bone: BoneDefinition, ancestor: BoneDefinition): boolean => {
    for (let cursor: BoneDefinition | undefined = bone, guard = 0; cursor && guard < rig.bones.length; guard += 1) {
      if (cursor.parentId === ancestor.id) return true;
      cursor = rig.bones.find((candidate) => candidate.id === cursor!.parentId);
    }
    return false;
  };
  const pelvisCarriesLegs = !!pelvis && pelvis.id !== root?.id && legs.length > 0 && legs.every((leg) => descendsFrom(leg.upper, pelvis));
  const bodyBone = pelvisCarriesLegs ? pelvis : torso;
  const above = head ?? neck;
  const torsoDir = torso && above && len(sub(world[above.id], world[torso.id])) >= 1 ? sub(world[above.id], world[torso.id]) : UP;
  return {
    facing, facingSource: source, facingCertainty: certainty, planeScale: rig.metadata?.characterView === "three-quarter" && facing !== "front" ? Math.SQRT1_2 : 1, height: Math.max(1, Math.max(...ys) - Math.min(...ys)), groundY: feetY.length ? Math.max(...feetY) : Math.max(...ys),
    arms, legs, root, pelvis, torso, head, bodyBone, bodyCarriesLegs: pelvisCarriesLegs, torsoDir,
  };
}

/** Collects per-bone deltas at a fixed set of times and writes them out as absolute tracks. */
class ClipBuilder {
  private readonly values = new Map<string, { readonly bone: BoneDefinition; readonly property: AnimatedProperty; readonly deltas: number[] }>();
  constructor(private readonly times: readonly number[], private readonly easing: Easing) {}
  add(bone: BoneDefinition | null, property: AnimatedProperty, delta: (index: number) => number): void {
    if (!bone) return;
    const key = `${bone.id}:${property}`;
    const entry = this.values.get(key) ?? { bone, property, deltas: this.times.map(() => 0) };
    this.times.forEach((_time, index) => { entry.deltas[index] += delta(index); });
    this.values.set(key, entry);
  }
  /** The rig's pose at one of the builder's times, for measuring where the motion so far puts a joint. */
  worldAt(rig: RigDefinition, index: number): World {
    const pose = createRestPose(rig);
    const bones = { ...pose.bones };
    for (const entry of this.values.values()) {
      const current = bones[entry.bone.id]; const delta = entry.deltas[index];
      bones[entry.bone.id] = { ...current, [entry.property]: current[entry.property] + (entry.property === "rotation" ? degreesToRadians(delta) : delta) };
    }
    return computeWorldTransforms(rig, { bones });
  }
  tracks(): AnimationTrack[] {
    return [...this.values.values()].filter((entry) => entry.deltas.some((delta) => Math.abs(delta) > .01)).map((entry) => ({
      boneId: entry.bone.id, property: entry.property,
      keyframes: this.times.map((time, index) => ({ time: round(time), value: round(entry.bone[entry.property] + entry.deltas[index]), easing: this.easing })),
    }));
  }
}

const TAU = Math.PI * 2;
const facingVector = (anatomy: RigAnatomy): Point | null => anatomy.facing === "front" ? null : { x: anatomy.facing === "right" ? 1 : -1, y: 0 };
/** Rotation sign that swings a segment toward where the character faces. A limb already pointing that way swings up instead. */
const forwardSign = (direction: Point, forward: Point): 1 | -1 => {
  const sideways = Math.abs(cross(direction, forward)) / Math.max(1e-6, len(direction));
  if (sideways >= .3) return turn(direction, forward);
  return turn(direction, dot(direction, forward) > 0 ? UP : DOWN);
};
const outwardSign = (limbItem: Limb): 1 | -1 => {
  const out = { x: limbItem.outward, y: 0 };
  return Math.abs(cross(limbItem.upperDir, out)) / Math.max(1e-6, len(limbItem.upperDir)) >= .3 ? turn(limbItem.upperDir, out) : turn(limbItem.upperDir, UP);
};

/**
 * Joint angles through one gait cycle, in degrees, sampled every sixteenth of the cycle from that leg's heel strike.
 * Hip: flexion positive, extension negative. Knee: flexion. Ankle: dorsiflexion positive, plantarflexion negative.
 *
 * Measured, not hand-tuned: the mean of every subject's left and right leg in two open (CC BY 4.0) motion-capture datasets.
 * - Walk: Fukuchi, Fukuchi & Duarte (2018), "A public dataset of overground and treadmill walking kinematics and kinetics
 *   in healthy individuals", PeerJ 6:e4640, doi:10.7717/peerj.4640; 42 adults, overground at comfortable speed.
 * - Run: Fukuchi, Fukuchi & Duarte (2017), "A public data set of running biomechanics and the effects of running speed on
 *   lower extremity kinematics and kinetics", PeerJ 5:e3298, doi:10.7717/peerj.3298; 30 adults on a treadmill at 3.5 m/s.
 * Pelvic obliquity (walk) is from the same walking dataset: the stance side rises about 5°, peaking 16% into the cycle.
 * Arm swing has no measured source here; it follows the opposing-leg rule and published ranges for arm swing in walking.
 */
const GAIT = {
  walk: {
    hip: [30.7, 29.7, 27.2, 19.7, 13.4, 6.8, 0.6, -4.1, -7.6, -8.4, -2.7, 10.8, 21.6, 28.4, 31.9, 31.1],
    knee: [0.9, 8.3, 15.6, 13.5, 10.0, 6.4, 3.9, 3.8, 7.4, 16.6, 35.6, 57.8, 61.9, 52.3, 28.7, 5.9],
    ankle: [1.8, -4.4, 0.5, 5.3, 7.6, 9.4, 11.7, 13.3, 12.6, 5.7, -9.4, -7.6, 0.9, 6.1, 6.1, 2.3],
    pelvisObliquity: [0.6, 2.2, 4.5, 4.9, 2.9, 1.0, -0.2, -0.3, -0.5, -2.1, -4.5, -4.9, -3.0, -1.1, 0.2, 0.3],
    shoulder: [-15, 20], elbow: [8, 32], lean: 3, steps: 12,
  },
  run: {
    hip: [37.7, 35.6, 34.7, 24.9, 12.0, -0.5, -7.1, -6.0, -2.0, 4.1, 16.2, 35.5, 47.2, 52.0, 50.1, 43.4],
    knee: [11.2, 25.0, 41.3, 41.6, 31.5, 18.3, 13.9, 28.6, 52.4, 77.2, 97.8, 106.5, 97.0, 75.9, 43.1, 17.3],
    ankle: [2.0, 1.2, 12.9, 22.1, 17.6, -1.4, -21.3, -21.3, -19.4, -18.0, -12.3, -5.9, -2.5, -0.7, 2.0, 3.1],
    // No running obliquity in the data used; the walking curve is the closest measured shape.
    pelvisObliquity: [0.6, 2.2, 4.5, 4.9, 2.9, 1.0, -0.2, -0.3, -0.5, -2.1, -4.5, -4.9, -3.0, -1.1, 0.2, 0.3],
    shoulder: [-30, 40], elbow: [80, 100], lean: 10, steps: 12,
  },
} as const;

/** Smooth periodic lookup through evenly spaced samples (Catmull-Rom), so keys can be cut at any spacing from the table. */
const cycle = (samples: readonly number[], phase: number): number => {
  const count = samples.length; const position = (((phase % 1) + 1) % 1) * count; const index = Math.floor(position); const t = position - index;
  const at = (offset: number): number => samples[(index + offset + count) % count];
  const [p0, p1, p2, p3] = [at(-1), at(0), at(1), at(2)];
  return .5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
};
const cosDeg = (degrees: number): number => Math.max(.35, Math.cos(degreesToRadians(degrees)));

/**
 * Exaggeration over the measured gait (skill ch08, "exaggeration within restraint"): the measured shoulder swing reads
 * as almost nothing on a sprite, so it is enlarged, more in a walk than a run (a run already swings wide).
 */
const ARM_SWING = (run: boolean): number => run ? 1.35 : 1.6;
/** Overlap: the forearm follows the upper arm this share of a cycle later; the head counters the chest this much later. */
const ELBOW_DRAG = .06;
const HEAD_LAG = .05;

function gait(rig: RigDefinition, anatomy: RigAnatomy, kind: "walk" | "run", duration: number): AnimationTrack[] {
  const table = GAIT[kind]; const steps = table.steps;
  const phases = Array.from({ length: steps + 1 }, (_unused, index) => index / steps);
  const clip = new ClipBuilder(phases.map((phase) => phase * duration), "linear");
  const forward = facingVector(anatomy);
  const run = kind === "run";
  const legLength = anatomy.legs.length ? anatomy.legs.reduce((sum, leg) => sum + leg.length, 0) / anatomy.legs.length : anatomy.height * .45;
  // The second leg runs half a cycle behind the first; each arm runs opposite the leg on its own side.
  const legPhase = (leg: Limb, index: number): number => phases[index] + (anatomy.legs.indexOf(leg) === 0 ? 0 : .5);
  const armPhase = (arm: Limb, index: number): number => { const own = anatomy.legs.find((leg) => leg.side === arm.side); return own ? legPhase(own, index) : phases[index] + (anatomy.arms.indexOf(arm) === 0 ? 0 : .5); };
  // Arm angles as a function of its own leg's phase: furthest back at that leg's heel strike, furthest forward half a cycle later.
  const shoulderAt = (phase: number): number => (table.shoulder[0] + table.shoulder[1]) / 2 - (table.shoulder[1] - table.shoulder[0]) / 2 * Math.cos(TAU * phase);
  const elbowAt = (phase: number): number => (table.elbow[0] + table.elbow[1]) / 2 - (table.elbow[1] - table.elbow[0]) / 2 * Math.cos(TAU * phase);
  const elbowDelta = (arm: Limb, phase: number): number => Math.max(0, elbowAt(phase) - arm.restBend) + Math.min(arm.restBend, elbowAt(phase)) / Math.max(1, elbowAt(phase)) * (elbowAt(phase) - table.elbow[0]) * .35;

  if (forward) {
    // In profile every one of these angles is a rotation in the picture plane. Leg angles are measured from vertical,
    // as in the gait data, so a character drawn standing with its legs apart still walks with a normal stride
    // instead of having the stride added on top of its stance.
    const toward = turn(DOWN, forward);
    // A turned (three-quarter) character swings its limbs in a plane at an angle to the screen: project each angle.
    const seen = (degrees: number): number => anatomy.planeScale === 1 ? degrees : Math.atan(Math.tan(degrees * Math.PI / 180) * anatomy.planeScale) * 180 / Math.PI;
    for (const leg of anatomy.legs) {
      const restThigh = angleTo(DOWN, leg.upperDir); const restShin = angleTo(DOWN, leg.lowerDir);
      const thigh = (index: number): number => seen(cycle(table.hip, legPhase(leg, index))) * toward - restThigh;
      const shinWorld = (index: number): number => seen(cycle(table.hip, legPhase(leg, index)) - cycle(table.knee, legPhase(leg, index))) * toward - restShin;
      clip.add(leg.upper, "rotation", thigh);
      if (leg.lower) clip.add(leg.lower, "rotation", (index) => shinWorld(index) - thigh(index));
      // The foot follows the shin's true angle plus the ankle, so it lies flat when the shin is upright.
      clip.add(leg.end, "rotation", (index) => seen(cycle(table.ankle, legPhase(leg, index))) * toward + (leg.lower ? restShin : restThigh));
    }
    for (const arm of anatomy.arms) {
      const restraint = arm.carriesEquipment ? .4 : 1; const shoulder = forwardSign(arm.upperDir, forward);
      // Exaggerated over the measured swing, which is too small to read at sprite size; the elbow drags a beat behind.
      clip.add(arm.upper, "rotation", (index) => seen(shoulderAt(armPhase(arm, index))) * restraint * shoulder * ARM_SWING(run));
      clip.add(arm.lower, "rotation", (index) => seen(elbowDelta(arm, armPhase(arm, index) - ELBOW_DRAG)) * restraint * arm.bendSign * ARM_SWING(run));
    }
    const lean = turn(anatomy.torsoDir, forward);
    // The chest bobs forward twice a cycle, with each step; the head counters it a beat later, so it stays steadier than the body.
    const chest = (phase: number) => seen(table.lean + (run ? 4.5 : 3) * Math.sin(TAU * 2 * phase));
    clip.add(anatomy.torso, "rotation", (index) => chest(phases[index]) * lean);
    clip.add(anatomy.head, "rotation", (index) => -.75 * chest(phases[index] - HEAD_LAG) * lean);
  } else {
    // Seen from the front the same joint angles point toward the viewer. They cannot be drawn as rotations;
    // what the eye sees is each segment getting shorter by the cosine of its angle, which lifts the foot straight up.
    // On a short-legged sprite (chibi or pixel art) that shortening is a fraction of a pixel, so every step is lifted at
    // least a small share of the character's height, keeping the same timing.
    const minimumLift = anatomy.height * (run ? .075 : .05);
    for (const leg of anatomy.legs) {
      const thighLength = len(leg.upperDir); const shinLength = leg.lower ? len(leg.lowerDir) : 0; const total = Math.max(1, thighLength + shinLength);
      const naturalThigh = (index: number): number => cosDeg(cycle(table.hip, legPhase(leg, index)));
      const naturalShin = (index: number): number => cosDeg(cycle(table.hip, legPhase(leg, index)) - cycle(table.knee, legPhase(leg, index)));
      const naturalLift = (index: number): number => thighLength * (1 - naturalThigh(index)) + shinLength * (1 - naturalShin(index));
      const peak = Math.max(1e-6, ...phases.map((_phase, index) => naturalLift(index)));
      const boost = (index: number): number => {
        const lift = naturalLift(index); const wanted = Math.min(total * .6, Math.max(lift, minimumLift * lift / peak));
        return Math.max(.4, (total - wanted) / Math.max(1e-6, total - lift));
      };
      const thigh = (index: number): number => naturalThigh(index) * boost(index);
      const shin = (index: number): number => naturalShin(index) * boost(index);
      clip.add(leg.upper, leg.upperAxis, (index) => leg.upper[leg.upperAxis] * (thigh(index) - 1));
      if (leg.lower) clip.add(leg.lower, leg.lowerAxis, (index) => leg.lower![leg.lowerAxis] * (shin(index) / thigh(index) - 1));
      // The foot keeps its own size: undo the shortening it inherits.
      if (leg.end) clip.add(leg.end, leg.lowerAxis, (index) => leg.end![leg.lowerAxis] * (1 / (leg.lower ? shin(index) : thigh(index)) - 1));
    }
    for (const arm of anatomy.arms) {
      const restraint = arm.carriesEquipment ? .4 : 1;
      const upper = (index: number): number => cosDeg(shoulderAt(armPhase(arm, index)) * restraint * ARM_SWING(run));
      const fore = (index: number): number => cosDeg((shoulderAt(armPhase(arm, index)) + elbowDelta(arm, armPhase(arm, index) - ELBOW_DRAG)) * restraint * ARM_SWING(run));
      clip.add(arm.upper, arm.upperAxis, (index) => arm.upper[arm.upperAxis] * (upper(index) - 1));
      if (arm.lower) clip.add(arm.lower, arm.lowerAxis, (index) => arm.lower![arm.lowerAxis] * (fore(index) / upper(index) - 1));
      if (arm.end) clip.add(arm.end, arm.lowerAxis, (index) => arm.end![arm.lowerAxis] * (1 / (arm.lower ? fore(index) : upper(index)) - 1));
    }
    // Weight transfer is what a front view does show: the hips move over the standing leg and drop on the side of the free leg.
    const [first, second] = anatomy.legs;
    if (first && second && anatomy.pelvis && anatomy.bodyCarriesLegs) {
      const stanceMid = run ? .2 : .3;
      const weight = (index: number): number => Math.cos(TAU * (phases[index] - stanceMid));
      // Measured pelvic obliquity: positive while the first leg carries the weight.
      const roll = (index: number): number => cycle(table.pelvisObliquity, phases[index]) * second.outward;
      clip.add(anatomy.pelvis, "x", (index) => anatomy.height * (run ? .012 : .02) * weight(index) * first.outward);
      clip.add(anatomy.pelvis, "rotation", roll);
      // Legs stay upright and the chest stays level over the tilting hips.
      for (const leg of anatomy.legs) clip.add(leg.upper, "rotation", (index) => -roll(index));
      clip.add(anatomy.torso, "rotation", (index) => -1.4 * roll(index));
    }
  }

  // Put the body where the legs can reach the ground: whichever foot hangs lowest stays at its rest height.
  if (anatomy.bodyBone && anatomy.bodyCarriesLegs) {
    const rest = computeWorldTransforms(rig, createRestPose(rig));
    const feet = anatomy.legs.flatMap((leg) => { const foot = leg.end ?? leg.lower; return foot ? [foot.id] : []; });
    const settle = phases.map((_phase, index) => { const world = clip.worldAt(rig, index); return feet.length ? Math.min(...feet.map((id) => rest[id].y - world[id].y)) : 0; });
    // A run leaves the ground twice per cycle, between one foot's push-off and the other's landing.
    const float = (index: number): number => run ? legLength * .05 * Math.max(0, Math.cos(TAU * 2 * (phases[index] - .45))) : 0;
    clip.add(anatomy.bodyBone, "y", (index) => settle[index] - float(index));
  } else {
    clip.add(anatomy.bodyBone, "y", (index) => anatomy.height * (run ? .02 : .012) * Math.cos(TAU * 2 * phases[index]) * .5);
  }
  return clip.tracks();
}

function idle(anatomy: RigAnatomy, duration: number): AnimationTrack[] {
  const clip = new ClipBuilder([0, duration / 2, duration], "easeInOut");
  const breath = [0, 1, 0];
  clip.add(anatomy.torso, "y", (index) => -anatomy.height * .004 * breath[index]);
  clip.add(anatomy.torso, "rotation", (index) => .8 * breath[index]);
  clip.add(anatomy.head, "rotation", (index) => -1.2 * breath[index]);
  for (const arm of anatomy.arms) clip.add(arm.upper, "rotation", (index) => (arm.carriesEquipment ? .8 : 1.8) * breath[index] * outwardSign(arm));
  return clip.tracks();
}

/**
 * A keyed curve over a clip, from 0 to 1: values at key times, eased in and out at every key (slow in, slow out), so a
 * limb settles into each extreme. `delay` shifts the whole curve later, which is how one part lags another (overlap,
 * drag, and the proximal-to-distal order of a strike).
 */
const curve = (keys: readonly (readonly [number, number])[], t: number, delay = 0): number => {
  const at = Math.min(1, Math.max(0, t - delay));
  if (at <= keys[0][0]) return keys[0][1];
  for (let index = 1; index < keys.length; index += 1) {
    const [t1, v1] = keys[index]; const [t0, v0] = keys[index - 1];
    if (at <= t1) { const u = (at - t0) / Math.max(1e-6, t1 - t0); const eased = u * u * (3 - 2 * u); return v0 + (v1 - v0) * eased; }
  }
  return keys[keys.length - 1][1];
};
/** Dense, evenly spaced sample times for clips whose parts move on their own timing (the curves carry the easing). */
const SAMPLES = 24;
const sampled = (duration: number) => { const fractions = Array.from({ length: SAMPLES + 1 }, (_unused, index) => index / SAMPLES); return { fractions, clip: new ClipBuilder(fractions.map((fraction) => fraction * duration), "linear") }; };

/**
 * Both arms overhead, following the shoulder's real mechanics (scapulohumeral rhythm; see the human-motion-rigging skill,
 * ch07): for the first 30° the shoulder blade barely moves; from 30° to 90° the arm moves about twice as much as the
 * blade; above 90° about as much. The blade's turn shows in 2D as the shoulder rising and moving in toward the neck, so
 * the upper arm's joint is lifted with it instead of the arm swinging round a fixed point. The forearm and hand follow a
 * beat behind the upper arm, and the chest lifts and leans back a little.
 */
function raiseArms(anatomy: RigAnatomy, duration: number): AnimationTrack[] {
  const { fractions, clip } = sampled(duration);
  const forward = facingVector(anatomy);
  // Up, hold with a small settle, down: slow in and out at each extreme.
  // Every curve is back at rest by 88%, so parts that follow a beat later still end exactly at rest.
  const lift: readonly (readonly [number, number])[] = [[0, 0], [.36, 1.04], [.44, 1], [.62, 1], [.88, 0], [1, 0]];
  const torsoLength = len(anatomy.torsoDir);
  // torsoDir runs from the waist up to the neck, so it already points up the spine.
  const up = { x: anatomy.torsoDir.x / Math.max(1, torsoLength), y: anatomy.torsoDir.y / Math.max(1, torsoLength) };
  const scapula = (elevation: number): number => elevation <= 30 ? 0 : elevation <= 90 ? (elevation - 30) / 3 : 20 + (elevation - 90) / 2;
  for (const arm of anatomy.arms) {
    // Overhead, tipped slightly toward the side the arm travels through, so the arm goes round the body rather than through it.
    const through = forward ?? { x: arm.outward, y: 0 };
    const target = { x: through.x * .28, y: -1 };
    const direction = turn(arm.upperDir, through);
    let angle = angleTo(arm.upperDir, target);
    if (Math.sign(angle) !== direction && Math.abs(angle) > 25) angle += 360 * direction;
    const elevation = (t: number) => Math.abs(angle) * curve(lift, t);
    clip.add(arm.upper, "rotation", (index) => angle * curve(lift, fractions[index]));
    // The shoulder rises and draws in toward the neck as the blade turns: up to about a fifth of the torso at full height.
    const shoulderLift = (index: number) => scapula(elevation(fractions[index])) / 65 * torsoLength * .2;
    clip.add(arm.upper, "x", (index) => up.x * shoulderLift(index) - arm.outward * shoulderLift(index) * .25);
    clip.add(arm.upper, "y", (index) => up.y * shoulderLift(index));
    // The forearm straightens a beat later (overlap), so the elbow leads and the arm unfolds on an arc.
    const straighten = arm.lower ? -angleTo(arm.upperDir, arm.lowerDir) * .85 : 0;
    if (arm.lower) clip.add(arm.lower, "rotation", (index) => straighten * curve(lift, fractions[index], .06));
    // A hand holding a weapon or shield keeps it at the angle it was drawn, as a wrist does, instead of turning it upside down.
    if (arm.carriesEquipment && arm.end) clip.add(arm.end, "rotation", (index) => -(angle * curve(lift, fractions[index]) + straighten * curve(lift, fractions[index], .06)));
  }
  // The chest lifts and leans back slightly with the arms; the head tips up a beat later.
  const lean = forward ? turn(anatomy.torsoDir, forward) : 0;
  clip.add(anatomy.torso, "rotation", (index) => -4 * curve(lift, fractions[index], .03) * lean);
  clip.add(anatomy.torso, "y", (index) => -anatomy.height * .012 * curve(lift, fractions[index]));
  clip.add(anatomy.head, "rotation", (index) => -3 * curve(lift, fractions[index], .08) * lean);
  return clip.tracks();
}

/**
 * A strike, built from how real strikes and throws move (skill ch08): a distinct wind-up away from the target, then the
 * power travels proximal to distal: the hips lead, the chest follows (hip-shoulder separation), then the shoulder, then
 * the elbow, which extends last, and the hand snaps through; everything overshoots past the target and settles back
 * with the parts arriving at different times. The body shifts its weight back and then lunges forward.
 */
function attack(anatomy: RigAnatomy, duration: number): AnimationTrack[] {
  const { fractions, clip } = sampled(duration);
  const forward = facingVector(anatomy);
  // Strike with the weapon arm; with no weapon, with the arm that is not holding anything; otherwise the right.
  const arm = anatomy.arms.find((candidate) => candidate.carriesEquipment && anatomy.arms.some((other) => other !== candidate && !other.carriesEquipment))
    ?? anatomy.arms.find((candidate) => candidate.side === "right") ?? anatomy.arms[0];
  if (!arm) return [];
  // From the side the blow travels forward; from the front it travels across the body.
  const strike = forward ? forwardSign(arm.upperDir, forward) : turn(arm.upperDir, { x: -arm.outward, y: 0 });
  const lean = turn(anatomy.torsoDir, forward ?? { x: -arm.outward, y: 0 });
  const toward = forward ? forward.x : -arm.outward;
  // Wind-up extreme at 30%, contact at 44%, overshoot at 52%, settled by 88% (plus each part's delay). Each part's curve is delayed after the one
  // that drives it, so the strike runs hips → chest → shoulder → elbow → hand.
  const wind = (back: number, through: number, over: number): readonly (readonly [number, number])[] => [[0, 0], [.3, back], [.44, through], [.52, over], [.88, 0], [1, 0]];
  const t = (index: number) => fractions[index];
  if (!forward) return frontChop(anatomy, arm, fractions, clip, wind);
  clip.add(anatomy.pelvis ?? anatomy.bodyBone, "rotation", (index) => curve(wind(-5, 6, 4), t(index)) * lean);
  clip.add(anatomy.torso, "rotation", (index) => curve(wind(-16, 15, 11), t(index), .03) * lean);
  clip.add(anatomy.head, "rotation", (index) => curve(wind(9, -6, -4), t(index), .08) * lean);
  clip.add(arm.upper, "rotation", (index) => curve(wind(-70, 78, 62), t(index), .05) * strike);
  // The elbow folds deep in the wind-up and extends last, just before contact.
  clip.add(arm.lower, "rotation", (index) => curve([[0, 0], [.3, 55], [.41, 20], [.46, -arm.restBend * .9], [.54, -arm.restBend * .7], [.88, 0], [1, 0]], t(index), .07) * arm.bendSign);
  // The wrist cocks back, then snaps through after the elbow.
  if (arm.end) clip.add(arm.end, "rotation", (index) => curve(wind(18, -22, -12), t(index), .09) * strike);
  // The other arm counterbalances: back during the strike.
  for (const other of anatomy.arms) if (other !== arm) clip.add(other.upper, "rotation", (index) => -curve(wind(12, -24, -18), t(index), .06) * strike);
  // Weight: back over the rear foot in the wind-up, forward into the blow, and the body dips as the front leg takes it.
  if (anatomy.bodyBone) {
    clip.add(anatomy.bodyBone, "x", (index) => curve(wind(-.025, .045, .05), t(index)) * anatomy.height * toward);
    clip.add(anatomy.bodyBone, "y", (index) => curve(wind(.008, .02, .022), t(index)) * anatomy.height);
  }
  // The front knee bends to take the weight at contact; the back leg straightens.
  const front = anatomy.legs.find((leg) => Math.sign(leg.outward) === Math.sign(toward)) ?? anatomy.legs[0];
  if (front?.lower) {
    clip.add(front.upper, "rotation", (index) => -curve(wind(-4, 12, 14), t(index)) * front.bendSign);
    clip.add(front.lower, "rotation", (index) => curve(wind(-4, 18, 20), t(index)) * front.bendSign);
  }
  return clip.tracks();
}

/**
 * A front-facing strike. Seen from the front, a body cannot show its twist, so a strike across the waist reads as a
 * shrug. Front-facing characters chop instead: the weapon arm rises up and back over the shoulder (the shoulder lifting
 * with it, ch07), then cuts down diagonally across the body past the other hip, the elbow extending last; the chest leans
 * into the cut and the knees dip to take it.
 */
function frontChop(anatomy: RigAnatomy, arm: Limb, fractions: readonly number[], clip: ClipBuilder, wind: (back: number, through: number, over: number) => readonly (readonly [number, number])[]): AnimationTrack[] {
  const t = (index: number) => fractions[index];
  const across = turn(arm.upperDir, { x: -arm.outward, y: 0 });
  // Up and back over the shoulder (outward), then down across the body.
  const upper = (index: number) => curve(wind(-150, 40, 52), t(index), .05);
  clip.add(arm.upper, "rotation", (index) => upper(index) * across);
  // The shoulder rises with the arm overhead.
  const torsoLength = len(anatomy.torsoDir);
  const up = { x: anatomy.torsoDir.x / Math.max(1, torsoLength), y: anatomy.torsoDir.y / Math.max(1, torsoLength) };
  const lift = (index: number) => { const elevation = Math.abs(Math.min(0, upper(index))); return elevation <= 30 ? 0 : Math.min(1, (elevation - 30) / 120) * torsoLength * .16; };
  clip.add(arm.upper, "x", (index) => up.x * lift(index)); clip.add(arm.upper, "y", (index) => up.y * lift(index));
  // The elbow folds behind the head, then extends last into the cut.
  clip.add(arm.lower, "rotation", (index) => curve([[0, 0], [.3, 80], [.41, 30], [.46, -arm.restBend * .9], [.54, -arm.restBend * .6], [.88, 0], [1, 0]], t(index), .07) * arm.bendSign);
  if (arm.end) clip.add(arm.end, "rotation", (index) => curve(wind(-20, 25, 15), t(index), .09) * across);
  // The other arm comes up and out for balance, and drops as the blow lands.
  for (const other of anatomy.arms) if (other !== arm) clip.add(other.upper, "rotation", (index) => curve(wind(-25, 15, 10), t(index), .06) * turn(other.upperDir, { x: -other.outward, y: 0 }));
  // The chest leans away in the wind-up and into the cut; the head follows a beat later.
  const lean = arm.outward;
  clip.add(anatomy.torso, "rotation", (index) => curve(wind(-7, 9, 8), t(index), .03) * lean);
  clip.add(anatomy.head, "rotation", (index) => curve(wind(4, -5, -4), t(index), .08) * lean);
  // Rise slightly into the wind-up, then the knees dip as the blow lands.
  if (anatomy.bodyBone) clip.add(anatomy.bodyBone, "y", (index) => curve(wind(-.012, .025, .03), t(index)) * anatomy.height);
  for (const leg of anatomy.legs) if (leg.lower) {
    clip.add(leg.upper, "rotation", (index) => -curve(wind(-2, 9, 11), t(index)) * leg.bendSign);
    clip.add(leg.lower, "rotation", (index) => curve(wind(-3, 14, 16), t(index)) * leg.bendSign);
  }
  return clip.tracks();
}

function hurt(anatomy: RigAnatomy, duration: number): AnimationTrack[] {
  // A hit reads as a fast snap away from the blow, a small overshoot back, then a slower recovery.
  const clip = new ClipBuilder([0, duration * .12, duration * .4, duration * .65, duration], "easeOut");
  const forward = facingVector(anatomy);
  const recoil = [0, 1, .45, -.12, 0];
  // The body is knocked away from where it faces; from the front it buckles to one side.
  const away = forward ? { x: -forward.x, y: 0 } : { x: 1, y: 0 };
  const back = turn(anatomy.torsoDir, away);
  clip.add(anatomy.torso, "rotation", (index) => (forward ? 20 : 12) * recoil[index] * back);
  // The head whips a little further than the chest.
  clip.add(anatomy.head, "rotation", (index) => 12 * recoil[index] * back);
  clip.add(anatomy.bodyBone, "x", (index) => away.x * anatomy.height * (forward ? .035 : .02) * Math.max(0, recoil[index]));
  // Knees give under the impact.
  clip.add(anatomy.bodyBone, "y", (index) => anatomy.height * .015 * Math.max(0, recoil[index]));
  for (const leg of anatomy.legs) clip.add(leg.lower, "rotation", (index) => 10 * Math.max(0, recoil[index]) * leg.bendSign);
  // Arms are flung forward, toward where the hit came from, opposite to the body.
  for (const arm of anatomy.arms) {
    const toward = forward ? forwardSign(arm.upperDir, forward) : outwardSign(arm);
    clip.add(arm.upper, "rotation", (index) => (arm.carriesEquipment ? 14 : 24) * Math.max(0, recoil[index]) * toward);
    clip.add(arm.lower, "rotation", (index) => 12 * Math.max(0, recoil[index]) * arm.bendSign);
  }
  return clip.tracks();
}

function death(anatomy: RigAnatomy, rootWorldY: number, duration: number): AnimationTrack[] {
  const clip = new ClipBuilder([0, duration * .25, duration * .7, duration], "easeIn");
  const forward = facingVector(anatomy);
  // Fall onto the back: away from the facing direction. Seen from the front, to one side.
  const fall = turn(UP, forward ? { x: -forward.x, y: 0 } : { x: 1, y: 0 });
  const tip = [0, 8, 80, 88];
  const drop = Math.max(0, anatomy.groundY - rootWorldY - anatomy.height * .07);
  const sink = [0, 0, .9, 1];
  clip.add(anatomy.root, "rotation", (index) => tip[index] * fall);
  clip.add(anatomy.root, "y", (index) => drop * sink[index]);
  const slack = [0, .4, 1, 1];
  clip.add(anatomy.torso, "rotation", (index) => -6 * slack[index] * fall);
  clip.add(anatomy.head, "rotation", (index) => 10 * slack[index] * fall);
  for (const arm of anatomy.arms) clip.add(arm.upper, "rotation", (index) => 18 * slack[index] * outwardSign(arm));
  for (const leg of anatomy.legs) clip.add(leg.lower, "rotation", (index) => 16 * slack[index] * leg.bendSign);
  return clip.tracks();
}

/**
 * Arm and leg bones that carry no art and have none below them: the far limbs a side view hides, or parts that were skipped.
 * They still take part in a gait (the hidden leg carries the weight half the time) but there is nothing to show or key for them.
 */
export function artlessLimbBones(rig: RigDefinition): ReadonlySet<string> {
  const carrying = new Set(rig.slots.filter((slot) => slot.visible !== false && slot.attachmentId !== null).map((slot) => slot.boneId));
  if (!carrying.size) return new Set();
  const hasArtBelow = (boneId: string, depth = 0): boolean => depth < rig.bones.length && (carrying.has(boneId) || rig.bones.some((bone) => bone.parentId === boneId && hasArtBelow(bone.id, depth + 1)));
  return new Set(rig.bones.filter((bone) => /left|right/i.test(bone.id) && /arm|hand|leg|thigh|shin|calf|foot|hock/i.test(bone.id) && !hasArtBelow(bone.id)).map((bone) => bone.id));
}

/** Builds one standard motion for this rig, or null when the rig has none of the bones that motion needs. */
export function buildMotionClip(rig: RigDefinition, id: MotionId, anatomy: RigAnatomy = analyzeRigAnatomy(rig)): AnimationDefinition | null {
  const spec = STANDARD_MOTIONS.find((motion) => motion.id === id);
  if (!spec) return null;
  const tracks = id === "walk" || id === "run" ? gait(rig, anatomy, id, spec.duration)
    : id === "idle" ? idle(anatomy, spec.duration)
      : id === "raise_arms" ? raiseArms(anatomy, spec.duration)
        : id === "melee_attack" ? attack(anatomy, spec.duration)
          : id === "hurt" ? hurt(anatomy, spec.duration)
            : death(anatomy, anatomy.root ? computeWorldTransforms(rig, createRestPose(rig))[anatomy.root.id].y : anatomy.groundY, spec.duration);
  const artless = artlessLimbBones(rig);
  const shown = tracks.filter((track) => !artless.has(track.boneId));
  return shown.length ? { schemaVersion: ANIMATION_SCHEMA_VERSION, id: spec.id, name: spec.name, duration: spec.duration, loop: spec.loop, tracks: shown } : null;
}

/** The standard clip set for a rig, each resolved against that rig's rest pose and facing. */
export function buildStandardClips(rig: RigDefinition): AnimationDefinition[] {
  const anatomy = analyzeRigAnatomy(rig);
  return STANDARD_MOTIONS.flatMap((motion) => { const clip = buildMotionClip(rig, motion.id, anatomy); return clip ? [clip] : []; });
}

/** The motion a free-text request names, if it names one of the standard ones. */
export function motionForRequest(request: string): MotionId | null {
  const text = request.toLowerCase();
  if (/\brun|sprint|jog/.test(text)) return "run";
  if (/\bwalk|stride|march/.test(text)) return "walk";
  if (/rais\w* (?:both |the |her |his |their )?(?:arms?|hands?)|arms? (?:up|overhead)|hands? up|celebrat|cheer/.test(text)) return "raise_arms";
  if (/\bidle|breath/.test(text)) return "idle";
  if (/attack|melee|strike|slash|swing/.test(text)) return "melee_attack";
  if (/\bhurt|\bhit\b|recoil|flinch/.test(text)) return "hurt";
  if (/death|\bdie|collapse|fall over/.test(text)) return "death";
  return null;
}
