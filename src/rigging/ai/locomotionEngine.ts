import type { AnimatedProperty, AnimationDefinition, AnimationTrack, Easing } from "../schema/types";
import type { AnimationGenerationContext, FootContactInterval, LocomotionArchetype } from "./animationContextBuilder";

export type GaitKind = "walk" | "run";
export type GaitPhaseName = "contact" | "down" | "passing" | "up" | "opposite-contact" | "flight";
export type GaitPhase = { readonly phase: number; readonly left: GaitPhaseName; readonly right: GaitPhaseName };
export type FootTarget = { readonly phase: number; readonly x: number; readonly y: number; readonly clamped: boolean };
export type LocomotionPlan = {
  readonly gait: GaitKind;
  readonly convention: "in-place";
  readonly topology: AnimationGenerationContext["locomotionProfile"]["topology"];
  readonly archetype: LocomotionArchetype;
  readonly phases: readonly GaitPhase[];
  readonly contacts: readonly FootContactInterval[];
  readonly stride: number;
  readonly cadenceHz: number;
  readonly pelvisBob: number;
  readonly pelvisShift: number;
  readonly footTargets: { readonly left: readonly FootTarget[]; readonly right: readonly FootTarget[] };
  readonly targetClampCount: number;
  readonly equipmentConstraints: readonly string[];
  readonly hockTracks: readonly string[];
};

const PHASES = [0, .125, .25, .375, .5, .625, .75, .875, 1] as const;
const REVIEW_PHASES: readonly GaitPhase[] = [
  { phase: 0, left: "contact", right: "up" },
  { phase: .25, left: "down", right: "passing" },
  { phase: .5, left: "up", right: "opposite-contact" },
  { phase: .75, left: "passing", right: "down" },
  { phase: 1, left: "opposite-contact", right: "up" },
];
const RUN_REVIEW_PHASES: readonly GaitPhase[] = [
  { phase: 0, left: "contact", right: "flight" },
  { phase: .25, left: "flight", right: "passing" },
  { phase: .5, left: "flight", right: "opposite-contact" },
  { phase: .75, left: "passing", right: "flight" },
  { phase: 1, left: "opposite-contact", right: "flight" },
];

type Bone = AnimationGenerationContext["bones"][number];
type Point = { readonly x: number; readonly y: number };
type Leg = { readonly side: "left" | "right"; readonly upper: Bone; readonly lower: Bone; readonly hock?: Bone; readonly foot: Bone };
type Profile = {
  readonly height: number; readonly legLength: number; readonly cycleDuration: number; readonly stride: number; readonly lift: number; readonly bob: number; readonly shift: number;
  readonly armSwing: number; readonly torsoCounter: number; readonly torsoLean: number; readonly pelvisRoll: number;
};

const rad = (degrees: number): number => degrees * Math.PI / 180;
const deg = (radians: number): number => radians * 180 / Math.PI;
const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));
const length = (point: Point): number => Math.hypot(point.x, point.y);
const rotate = (point: Point, angle: number): Point => ({ x: point.x * Math.cos(angle) - point.y * Math.sin(angle), y: point.x * Math.sin(angle) + point.y * Math.cos(angle) });
const add = (left: Point, right: Point): Point => ({ x: left.x + right.x, y: left.y + right.y });
const frame = (time: number, value: number, easing: Easing = "linear") => {
  const normalized = Number(value.toFixed(6));
  return { time, value: Object.is(normalized, -0) ? 0 : normalized, easing };
};
const find = (context: AnimationGenerationContext, pattern: RegExp): Bone | undefined => context.bones.find((bone) => pattern.test(bone.id));
const bone = (context: AnimationGenerationContext, id: string): Bone | undefined => context.bones.find((candidate) => candidate.id === id);

function setupWorld(context: AnimationGenerationContext): Readonly<Record<string, { readonly x: number; readonly y: number; readonly rotation: number }>> {
  const result: Record<string, { x: number; y: number; rotation: number }> = {};
  const pending = new Set(context.bones.map((item) => item.id));
  while (pending.size) {
    let progress = false;
    for (const id of pending) {
      const item = bone(context, id)!;
      if (item.parentId && !result[item.parentId]) continue;
      const parent = item.parentId ? result[item.parentId] : null;
      const local = { x: item.setup.x, y: item.setup.y };
      const position = parent ? add({ x: parent.x, y: parent.y }, rotate(local, item.inheritRotation ? parent.rotation : 0)) : local;
      result[id] = { ...position, rotation: rad(item.setup.rotation) + (parent && item.inheritRotation ? parent.rotation : 0) };
      pending.delete(id); progress = true;
    }
    if (!progress) throw new Error("Cannot build locomotion profile for cyclic bone hierarchy");
  }
  return result;
}

function leg(context: AnimationGenerationContext, side: "left" | "right"): Leg | null {
  const upper = find(context, new RegExp(`${side}.*upper.*leg`, "i"));
  const lower = find(context, new RegExp(`${side}.*lower.*leg`, "i"));
  const hock = find(context, new RegExp(`${side}.*hock`, "i"));
  const foot = find(context, new RegExp(`${side}.*foot`, "i"));
  return upper && lower && foot ? { side, upper, lower, ...(hock ? { hock } : {}), foot } : null;
}

function profile(context: AnimationGenerationContext, gait: GaitKind, left: Leg, right: Leg, world: ReturnType<typeof setupWorld>): Profile {
  const ys = Object.values(world).map((item) => item.y);
  const height = Math.max(1, Math.max(...ys) - Math.min(...ys));
  const chain = (item: Leg): number => length({ x: item.lower.setup.x, y: item.lower.setup.y }) + (item.hock ? length({ x: item.hock.setup.x, y: item.hock.setup.y }) : 0) + length({ x: item.foot.setup.x, y: item.foot.setup.y });
  const legLength = Math.max(1, (chain(left) + chain(right)) / 2);
  const archetype = context.locomotionProfile.archetype;
  const compact = archetype === "chibi" ? .58 : archetype === "broad" ? .72 : 1;
  const weight = archetype === "heavy" ? .72 : archetype === "robed" ? .78 : 1;
  const agility = archetype === "agile" || archetype === "digitigrade" ? 1.14 : 1;
  const cadenceFactor = gait === "walk"
    ? archetype === "heavy" ? 1.12 : archetype === "broad" ? 1.09 : archetype === "robed" ? 1.04 : archetype === "agile" ? .88 : archetype === "digitigrade" ? .94 : archetype === "chibi" ? .92 : 1
    : archetype === "heavy" ? 1.11 : archetype === "broad" ? 1.07 : archetype === "robed" ? 1.04 : archetype === "agile" ? .86 : archetype === "digitigrade" ? .91 : archetype === "chibi" ? .94 : 1;
  const intensity = .72 + context.constraints.intensity * .42;
  const exaggeration = .82 + context.constraints.exaggeration * .35;
  return {
    height, legLength, cycleDuration: context.constraints.preserveTiming ? context.requestedDuration : context.requestedDuration * cadenceFactor,
    stride: legLength * (gait === "run" ? .16 : .085) * compact * agility * exaggeration,
    lift: legLength * (gait === "run" ? .075 : .035) * compact * agility,
    bob: height * (gait === "run" ? .018 : .009) * compact * intensity,
    shift: height * (gait === "run" ? .009 : .014) * weight,
    armSwing: (gait === "run" ? 24 : 13) * intensity * agility,
    torsoCounter: (gait === "run" ? 5.5 : 3.2) * weight,
    torsoLean: gait === "run" ? 5.5 * agility : 1.2,
    pelvisRoll: (gait === "run" ? 2.4 : 1.8) * compact,
  };
}

function footOffset(phase: number, gait: GaitKind, stride: number, lift: number): Point {
  const points = gait === "walk" ? [
    [0, 0], [0, 0], [0, 0], [0, 0], [-.18, -.2], [-.2, -.72], [0, -1], [.16, -.52], [0, 0],
  ] : [
    [0, 0], [0, 0], [-.3, -.72], [-.12, -1], [.22, -.82], [.3, -.55], [.15, -.9], [-.12, -.66], [0, 0],
  ];
  const index = Math.round(phase * 8) % 8;
  const pair = phase === 1 ? points[8] : points[index];
  return { x: pair[0] * stride, y: pair[1] * lift };
}

function pelvisOffset(phase: number, gait: GaitKind, value: Profile): Point {
  const wave = Math.sin(phase * Math.PI * 2);
  const double = .5 - .5 * Math.cos(phase * Math.PI * 4);
  return { x: value.shift * wave, y: (gait === "run" ? -1 : 1) * value.bob * double };
}

function solveLeg(item: Leg, hip: Point, target: Point, hockRotation: number): { readonly upper: number; readonly lower: number; readonly hock: number; readonly foot: number; readonly clamped: boolean } {
  const first = { x: item.lower.setup.x, y: item.lower.setup.y };
  const hockVector = item.hock ? { x: item.hock.setup.x, y: item.hock.setup.y } : { x: 0, y: 0 };
  const footVector = { x: item.foot.setup.x, y: item.foot.setup.y };
  const distal = item.hock ? add(hockVector, rotate(footVector, hockRotation)) : footVector;
  const l1 = Math.max(1e-3, length(first)); const l2 = Math.max(1e-3, length(distal));
  const requested = { x: target.x - hip.x, y: target.y - hip.y };
  const requestedDistance = length(requested);
  const minimum = Math.abs(l1 - l2) + Math.min(l1, l2) * .015;
  const maximum = l1 + l2 - Math.min(l1, l2) * .015;
  const distance = clamp(requestedDistance, minimum, maximum);
  const targetAngle = Math.atan2(requested.y, requested.x);
  const setupDelta = Math.atan2(distal.y, distal.x) - Math.atan2(first.y, first.x);
  const bendSign = Math.sin(setupDelta) < 0 ? -1 : 1;
  const cosine = clamp((distance * distance - l1 * l1 - l2 * l2) / (2 * l1 * l2), -1, 1);
  const delta = Math.acos(cosine) * bendSign;
  const firstAngle = targetAngle - Math.atan2(l2 * Math.sin(delta), l1 + l2 * Math.cos(delta));
  const upper = firstAngle - Math.atan2(first.y, first.x);
  const lower = delta - setupDelta;
  const foot = -(upper + lower + hockRotation);
  return { upper: deg(upper) + item.upper.setup.rotation, lower: deg(lower) + item.lower.setup.rotation, hock: deg(hockRotation) + (item.hock?.setup.rotation ?? 0), foot: deg(foot) + item.foot.setup.rotation, clamped: Math.abs(distance - requestedDistance) > .001 };
}

function makeTrack(boneId: string, property: AnimatedProperty, values: readonly number[], duration: number, easing: Easing = "linear"): AnimationTrack {
  return { boneId, property, keyframes: PHASES.map((phase, index) => frame(phase * duration, values[index], easing)) };
}

export function buildLocomotionAnimation(context: AnimationGenerationContext, gait: GaitKind): { readonly animation: AnimationDefinition; readonly plan: LocomotionPlan } | null {
  const left = leg(context, "left"); const right = leg(context, "right");
  if (!left || !right) return null;
  const world = setupWorld(context); const values = profile(context, gait, left, right, world);
  const duration = values.cycleDuration;
  const root = context.bones.find((item) => item.parentId === null); const pelvis = find(context, /pelvis/i); const torso = find(context, /torso/i);
  const leftArm = find(context, /left.*upper.*arm/i); const rightArm = find(context, /right.*upper.*arm/i);
  const tracks: AnimationTrack[] = [];
  const targets: { left: FootTarget[]; right: FootTarget[] } = { left: [], right: [] };
  const rotations: Record<string, number[]> = {};
  const appendRotation = (id: string, value: number): void => { (rotations[id] ??= []).push(value); };
  const pelvisPoints = PHASES.map((phase) => pelvisOffset(phase, gait, values));
  const hockAmplitude = gait === "run" ? 18 : 10;
  for (let index = 0; index < PHASES.length; index += 1) {
    const phase = PHASES[index]; const pelvisPoint = pelvisPoints[index];
    for (const item of [left, right]) {
      const localPhase = item.side === "left" ? phase : (phase + .5) % 1;
      const resolvedPhase = phase === 1 && item.side === "right" ? .5 : localPhase;
      const offset = footOffset(resolvedPhase, gait, values.stride, values.lift);
      const setupFoot = world[item.foot.id]; const setupHip = world[item.upper.id];
      const target = { x: setupFoot.x + offset.x, y: setupFoot.y + offset.y };
      const hip = { x: setupHip.x + pelvisPoint.x, y: setupHip.y + pelvisPoint.y };
      const hock = item.hock ? rad(hockAmplitude * Math.sin(resolvedPhase * Math.PI * 2)) : 0;
      const solved = solveLeg(item, hip, target, hock);
      appendRotation(item.upper.id, solved.upper); appendRotation(item.lower.id, solved.lower); appendRotation(item.foot.id, solved.foot);
      if (item.hock) appendRotation(item.hock.id, solved.hock);
      targets[item.side].push({ phase, x: Number(target.x.toFixed(4)), y: Number(target.y.toFixed(4)), clamped: solved.clamped });
    }
  }
  Object.entries(rotations).forEach(([id, rotation]) => tracks.push(makeTrack(id, "rotation", rotation, duration)));
  if (root) {
    tracks.push(makeTrack(root.id, "x", PHASES.map(() => root.setup.x), duration));
    tracks.push(makeTrack(root.id, "y", PHASES.map(() => root.setup.y), duration));
  }
  if (pelvis) {
    tracks.push(makeTrack(pelvis.id, "x", pelvisPoints.map((point) => pelvis.setup.x + point.x), duration));
    tracks.push(makeTrack(pelvis.id, "y", pelvisPoints.map((point) => pelvis.setup.y + point.y), duration));
    tracks.push(makeTrack(pelvis.id, "rotation", PHASES.map((phase) => pelvis.setup.rotation - values.pelvisRoll * Math.sin(phase * Math.PI * 2)), duration, "easeInOut"));
  }
  if (torso) tracks.push(makeTrack(torso.id, "rotation", PHASES.map((phase) => torso.setup.rotation + values.torsoLean + values.torsoCounter * Math.sin(phase * Math.PI * 2)), duration, "easeInOut"));
  const equipment = context.locomotionProfile.equipment;
  const armConstraints: string[] = [];
  for (const [item, sign, constrained] of [[leftArm, -1, equipment.leftHand], [rightArm, 1, equipment.rightHand]] as const) {
    if (!item) continue;
    const restraint = constrained ? .38 : context.locomotionProfile.archetype === "heavy" ? .62 : context.locomotionProfile.archetype === "robed" ? .72 : 1;
    if (constrained) armConstraints.push(`${item.id}: hand equipment swing restrained to 38%`);
    tracks.push(makeTrack(item.id, "rotation", PHASES.map((phase) => item.setup.rotation + sign * values.armSwing * restraint * Math.cos(phase * Math.PI * 2)), duration, "easeInOut"));
  }
  if (equipment.torso) armConstraints.push("torso attachments inherit restrained counter-motion without secondary offsets");
  if (equipment.head) armConstraints.push("head attachments remain on the unanimated head/neck chain");
  const contacts = gait === "walk" ? [
    { foot: "leftFoot" as const, start: 0, end: duration * .375 },
    { foot: "rightFoot" as const, start: duration * .5, end: duration * .875 },
  ] : [
    { foot: "leftFoot" as const, start: 0, end: duration * .125 },
    { foot: "rightFoot" as const, start: duration * .5, end: duration * .625 },
  ];
  const animation: AnimationDefinition = { schemaVersion: 1, id: gait, name: gait === "walk" ? "Walk" : "Run", duration, loop: true, tracks };
  const plan: LocomotionPlan = {
    gait, convention: "in-place", topology: context.locomotionProfile.topology, archetype: context.locomotionProfile.archetype,
    phases: gait === "run" ? RUN_REVIEW_PHASES : REVIEW_PHASES, contacts, stride: values.stride,
    cadenceHz: 1 / duration, pelvisBob: values.bob, pelvisShift: values.shift, footTargets: targets,
    targetClampCount: [...targets.left, ...targets.right].filter((target) => target.clamped).length,
    equipmentConstraints: armConstraints, hockTracks: tracks.filter((track) => /hock/i.test(track.boneId)).map((track) => `${track.boneId}:${track.property}`),
  };
  return { animation, plan };
}
