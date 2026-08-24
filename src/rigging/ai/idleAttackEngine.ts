import type { AnimatedProperty, AnimationDefinition, AnimationTrack, Easing } from "../schema/types";
import type { AnimationEquipmentItem, AnimationGenerationContext, LocomotionArchetype } from "./animationContextBuilder";

export type IdlePhaseName = "neutral" | "inhale-weight" | "settle" | "exhale-opposite" | "loop-return";
export type IdlePlan = {
  readonly kind: "idle";
  readonly topology: AnimationGenerationContext["locomotionProfile"]["topology"];
  readonly archetype: LocomotionArchetype;
  readonly duration: number;
  readonly phases: readonly { readonly phase: number; readonly name: IdlePhaseName }[];
  readonly pelvisShift: number;
  readonly breathingLift: number;
  readonly footContacts: readonly string[];
  readonly equipmentConstraints: readonly string[];
  readonly hockTracks: readonly string[];
};

export type AttackType = "slash" | "staff-sweep" | "staff-cast" | "heavy-swing" | "firearm-recoil" | "dagger-strike" | "unarmed-strike";
export type AttackPlan = {
  readonly kind: "attack";
  readonly type: AttackType;
  readonly topology: AnimationGenerationContext["locomotionProfile"]["topology"];
  readonly archetype: LocomotionArchetype;
  readonly duration: number;
  readonly phases: readonly { readonly phase: number; readonly name: "neutral" | "anticipation" | "action" | "follow-through" | "recovery" }[];
  readonly primaryEquipment: AnimationEquipmentItem | null;
  readonly primaryHand: "left" | "right";
  readonly supportArmMode: "free" | "shield-stable" | "staff-support" | "two-handed-lock" | "dual-weapon";
  readonly rootShift: number;
  readonly pelvisTurn: number;
  readonly torsoTurn: number;
  readonly leadArmAmplitude: number;
  readonly weaponArc: readonly number[];
  readonly headCompensation: number;
  readonly followThrough: number;
  readonly recoveryEase: Easing;
  readonly equipmentConstraints: readonly string[];
};

export type IdleAttackPlan = IdlePlan | AttackPlan;
export type IdleAttackKind = "idle" | "attack";
type Bone = AnimationGenerationContext["bones"][number];

const IDLE_PHASES = [0, .25, .5, .75, 1] as const;
const rounded = (value: number): number => { const next = Number(value.toFixed(6)); return Object.is(next, -0) ? 0 : next; };
const frame = (time: number, value: number, easing: Easing = "easeInOut") => ({ time: rounded(time), value: rounded(value), easing });
const find = (context: AnimationGenerationContext, pattern: RegExp): Bone | undefined => context.bones.find((bone) => pattern.test(bone.id));
const setup = (bone: Bone | undefined, property: AnimatedProperty): number => bone?.setup[property] ?? (property.startsWith("scale") ? 1 : 0);
const track = (bone: Bone | undefined, property: AnimatedProperty, phases: readonly number[], values: readonly number[], duration: number, easing: Easing = "easeInOut"): AnimationTrack | null => bone
  ? { boneId: bone.id, property, keyframes: phases.map((phase, index) => frame(phase * duration, values[index], easing)) }
  : null;
const uniqueTracks = (tracks: readonly (AnimationTrack | null)[]): AnimationTrack[] => tracks.filter((item): item is AnimationTrack => item !== null)
  .filter((item, index, all) => all.findIndex((candidate) => candidate?.boneId === item.boneId && candidate?.property === item.property) === index);

function dimensions(context: AnimationGenerationContext): { height: number; legLength: number; armLength: number } {
  const vertical = context.bones.map((bone) => bone.setup.y);
  const height = Math.max(1, Math.max(...vertical) - Math.min(...vertical));
  const chain = (pattern: RegExp): number => context.bones.filter((bone) => pattern.test(bone.id)).reduce((sum, bone) => sum + Math.hypot(bone.setup.x, bone.setup.y), 0);
  return { height, legLength: Math.max(1, (chain(/left.*(?:upper.*leg|lower.*leg|hock|foot)/i) + chain(/right.*(?:upper.*leg|lower.*leg|hock|foot)/i)) / 2), armLength: Math.max(1, (chain(/left.*(?:upper.*arm|lower.*arm|hand)/i) + chain(/right.*(?:upper.*arm|lower.*arm|hand)/i)) / 2) };
}

const idleDuration = (archetype: LocomotionArchetype): number => ({ standard: 1.8, broad: 2.2, chibi: 1.6, agile: 1.5, heavy: 2.15, robed: 2, digitigrade: 1.85 })[archetype];

export function buildIdleAnimation(context: AnimationGenerationContext): { readonly animation: AnimationDefinition; readonly plan: IdlePlan } | null {
  const pelvis = find(context, /pelvis/i); const torso = find(context, /torso/i); const head = find(context, /head/i);
  if (!pelvis || !torso) return null;
  const profile = context.locomotionProfile; const { height } = dimensions(context);
  const compact = profile.archetype === "chibi" ? .65 : profile.archetype === "broad" ? .82 : 1;
  const grounded = profile.archetype === "heavy" || profile.archetype === "broad" ? .72 : profile.archetype === "robed" ? .82 : 1;
  const duration = context.constraints.preserveTiming ? context.requestedDuration : idleDuration(profile.archetype);
  const shift = Math.min(3.2, height * .0024) * compact * grounded;
  const lift = Math.min(3.6, height * .0028) * compact * grounded;
  const pelvisTurn = 1.05 * compact * grounded; const torsoTurn = 1.7 * compact * grounded; const headTurn = 1.15 * compact;
  const leftArm = find(context, /left.*upper.*arm/i); const rightArm = find(context, /right.*upper.*arm/i);
  const leftHock = find(context, /left.*hock/i); const rightHock = find(context, /right.*hock/i);
  const leftFoot = find(context, /left.*foot/i); const rightFoot = find(context, /right.*foot/i);
  const breath = [0, 1, .15, -.55, 0]; const counter = [0, -.72, -.08, .45, 0]; const sway = [0, .68, .12, -.58, 0];
  const constraints: string[] = [];
  const armValues = (bone: Bone | undefined, sign: number, constrained: boolean): number[] => {
    const restraint = constrained ? .22 : profile.archetype === "heavy" ? .42 : profile.archetype === "robed" ? .55 : .72;
    if (bone && constrained) constraints.push(`${bone.id}: occupied-hand idle amplitude suppressed to 22%`);
    return sway.map((value) => setup(bone, "rotation") + sign * value * 2.4 * restraint);
  };
  const tracks = uniqueTracks([
    track(pelvis, "x", IDLE_PHASES, sway.map((value) => setup(pelvis, "x") + value * shift), duration),
    track(pelvis, "y", IDLE_PHASES, breath.map((value) => setup(pelvis, "y") - value * lift * .34), duration),
    track(pelvis, "rotation", IDLE_PHASES, sway.map((value) => setup(pelvis, "rotation") + value * pelvisTurn), duration),
    track(torso, "y", IDLE_PHASES, breath.map((value) => setup(torso, "y") - value * lift), duration),
    track(torso, "rotation", IDLE_PHASES, counter.map((value) => setup(torso, "rotation") + value * torsoTurn), duration),
    track(head, "rotation", IDLE_PHASES, counter.map((value) => setup(head, "rotation") - value * headTurn), duration),
    track(leftArm, "rotation", IDLE_PHASES, armValues(leftArm, -1, profile.equipment.leftHand), duration),
    track(rightArm, "rotation", IDLE_PHASES, armValues(rightArm, 1, profile.equipment.rightHand), duration),
    ...(profile.topology === "digitigrade" ? [
      track(leftHock, "rotation", IDLE_PHASES, breath.map((value) => setup(leftHock, "rotation") + value * 1.25), duration),
      track(rightHock, "rotation", IDLE_PHASES, breath.map((value) => setup(rightHock, "rotation") + value * 1.25), duration),
      track(leftFoot, "rotation", IDLE_PHASES, breath.map((value) => setup(leftFoot, "rotation") - value * 1.25), duration),
      track(rightFoot, "rotation", IDLE_PHASES, breath.map((value) => setup(rightFoot, "rotation") - value * 1.25), duration),
    ] : []),
  ]);
  if (profile.equipment.torso) constraints.push("torso-mounted equipment inherits breathing without independent oscillation");
  if (profile.equipment.head) constraints.push("head equipment follows restrained head compensation without secondary keys");
  const animation: AnimationDefinition = { schemaVersion: 1, id: "idle", name: "Idle", duration, loop: true, tracks };
  return { animation, plan: { kind: "idle", topology: profile.topology, archetype: profile.archetype, duration, phases: [
    { phase: 0, name: "neutral" }, { phase: .25, name: "inhale-weight" }, { phase: .5, name: "settle" }, { phase: .75, name: "exhale-opposite" }, { phase: 1, name: "loop-return" },
  ], pelvisShift: shift, breathingLift: lift, footContacts: [leftFoot?.id, rightFoot?.id].filter((id): id is string => Boolean(id)), equipmentConstraints: constraints, hockTracks: tracks.filter((item) => /hock/i.test(item.boneId)).map((item) => `${item.boneId}:${item.property}`) } };
}

function primaryEquipment(context: AnimationGenerationContext): AnimationEquipmentItem | null {
  const priority = ["firearm", "staff", "dagger", "heavy", "sword"];
  const rank = (kind: AnimationEquipmentItem["kind"]): number => { const index = priority.indexOf(kind); return index < 0 ? priority.length : index; };
  return [...context.locomotionProfile.equipmentItems].sort((left, right) => rank(left.kind) - rank(right.kind))[0] ?? null;
}

function attackType(context: AnimationGenerationContext, primary: AnimationEquipmentItem | null): AttackType {
  if (primary?.kind === "firearm") return "firearm-recoil";
  if (primary?.kind === "staff") return context.locomotionProfile.role === "mage" ? "staff-cast" : "staff-sweep";
  if (primary?.kind === "dagger") return "dagger-strike";
  if (primary?.kind === "heavy") return "heavy-swing";
  if (primary?.kind === "sword") return "slash";
  return "unarmed-strike";
}

const ATTACK_PROFILE: Readonly<Record<AttackType, { duration: number; phases: readonly number[]; arm: number; pelvis: number; torso: number; shift: number; head: number; follow: number }>> = {
  slash: { duration: .78, phases: [0, .22, .48, .68, 1], arm: 58, pelvis: 4.2, torso: 13, shift: 4, head: 2.5, follow: .56 },
  "staff-sweep": { duration: .92, phases: [0, .25, .5, .72, 1], arm: 44, pelvis: 3.7, torso: 11, shift: 3.5, head: 2.2, follow: .6 },
  "staff-cast": { duration: .96, phases: [0, .24, .52, .74, 1], arm: 34, pelvis: 2.8, torso: 8.5, shift: 2.8, head: 1.8, follow: .5 },
  "heavy-swing": { duration: 1.05, phases: [0, .3, .56, .78, 1], arm: 68, pelvis: 5.2, torso: 16, shift: 4.5, head: 2.4, follow: .68 },
  "firearm-recoil": { duration: .62, phases: [0, .28, .45, .62, 1], arm: 9, pelvis: 1.8, torso: 5, shift: 1.8, head: 1.3, follow: .42 },
  "dagger-strike": { duration: .52, phases: [0, .16, .42, .58, 1], arm: 46, pelvis: 3.4, torso: 10, shift: 3.4, head: 2, follow: .4 },
  "unarmed-strike": { duration: .7, phases: [0, .2, .46, .64, 1], arm: 48, pelvis: 3.5, torso: 11, shift: 3.5, head: 2.2, follow: .48 },
};

export function buildAttackAnimation(context: AnimationGenerationContext): { readonly animation: AnimationDefinition; readonly plan: AttackPlan } | null {
  const pelvis = find(context, /pelvis/i); const torso = find(context, /torso/i); const head = find(context, /head/i);
  if (!pelvis || !torso) return null;
  const profile = context.locomotionProfile; const primary = primaryEquipment(context); const type = attackType(context, primary); const base = ATTACK_PROFILE[type];
  const compact = profile.archetype === "chibi" ? .7 : profile.archetype === "broad" ? .88 : 1;
  const durationFactor = profile.archetype === "chibi" && type === "heavy-swing" ? .78 : profile.archetype === "broad" && type === "heavy-swing" ? 1 : 1;
  const duration = rounded(context.constraints.preserveTiming ? context.requestedDuration : base.duration * durationFactor);
  const amplitude = compact * (.86 + context.constraints.intensity * .22); const armAmplitude = base.arm * amplitude;
  const primaryHand = primary?.hand === "left" ? "left" : "right";
  const leadUpper = find(context, new RegExp(`${primaryHand}.*upper.*arm`, "i")); const leadLower = find(context, new RegExp(`${primaryHand}.*lower.*arm`, "i")); const leadHand = find(context, new RegExp(`${primaryHand}.*hand`, "i"));
  const supportHand = primaryHand === "right" ? "left" : "right"; const supportUpper = find(context, new RegExp(`${supportHand}.*upper.*arm`, "i")); const supportLower = find(context, new RegExp(`${supportHand}.*lower.*arm`, "i")); const support = find(context, new RegExp(`${supportHand}.*hand`, "i"));
  const leftUpperLeg = find(context, /left.*upper.*leg/i); const rightUpperLeg = find(context, /right.*upper.*leg/i);
  const shield = profile.equipmentItems.some((item) => item.kind === "shield"); const dual = profile.equipmentItems.filter((item) => item.kind === "dagger").length > 1;
  const supportArmMode: AttackPlan["supportArmMode"] = primary?.twoHanded ? "two-handed-lock" : dual ? "dual-weapon" : shield ? "shield-stable" : primary?.kind === "staff" ? "staff-support" : "free";
  const sign = primaryHand === "right" ? 1 : -1; const weaponArc = [0, armAmplitude * .58, -armAmplitude, -armAmplitude * base.follow, 0];
  const lowerArc = [0, -armAmplitude * .12, armAmplitude * .31, armAmplitude * .18, 0];
  const handArc = [0, armAmplitude * .16, -armAmplitude * .28, -armAmplitude * .2, 0];
  const pelvisArc = [0, -base.pelvis * .42, base.pelvis, base.pelvis * .54, 0].map((value) => value * amplitude * sign);
  const torsoArc = [0, -base.torso * .5, base.torso, base.torso * .58, 0].map((value) => value * amplitude * sign);
  const shiftArc = [0, -base.shift * .5, base.shift, base.shift * .62, 0].map((value) => value * compact * sign);
  const headArc = [0, base.head * .28, -base.head, -base.head * .45, 0].map((value) => value * compact * sign);
  if (type === "firearm-recoil") {
    weaponArc.splice(0, weaponArc.length, 0, 0, 0, 0, 0);
    lowerArc.splice(0, lowerArc.length, 0, 0, 0, 0, 0);
    handArc.splice(0, handArc.length, 0, 0, -armAmplitude * .45, -armAmplitude * .2, 0);
  }
  const supportFactor = supportArmMode === "two-handed-lock" ? .92 : supportArmMode === "dual-weapon" ? -.72 : supportArmMode === "staff-support" ? .42 : supportArmMode === "shield-stable" ? .08 : .22;
  const constraints: string[] = [];
  if (primary) constraints.push(`${primary.id}: ${primary.kind} profile on ${primary.boneId}`);
  if (supportArmMode === "two-handed-lock") constraints.push(`${supportHand} arm follows the primary firearm chain at 92% amplitude`);
  if (supportArmMode === "shield-stable") constraints.push(`${supportHand} shield arm limited to 8% counter-motion`);
  if (supportArmMode === "staff-support") constraints.push(`${supportHand} arm supplies restrained staff support`);
  if (supportArmMode === "dual-weapon") constraints.push("dual daggers use asymmetric opposed arcs");
  const supportUpperValues = weaponArc.map((value) => setup(supportUpper, "rotation") + sign * value * supportFactor);
  const supportLowerValues = lowerArc.map((value) => setup(supportLower, "rotation") + sign * value * Math.abs(supportFactor));
  const tracks = uniqueTracks([
    track(pelvis, "x", base.phases, shiftArc.map((value) => setup(pelvis, "x") + value), duration),
    track(pelvis, "rotation", base.phases, pelvisArc.map((value) => setup(pelvis, "rotation") + value), duration),
    track(torso, "rotation", base.phases, torsoArc.map((value) => setup(torso, "rotation") + value), duration),
    track(head, "rotation", base.phases, headArc.map((value) => setup(head, "rotation") + value), duration),
    track(leadUpper, "rotation", base.phases, weaponArc.map((value) => setup(leadUpper, "rotation") + sign * value), duration, "easeOut"),
    track(leadLower, "rotation", base.phases, lowerArc.map((value) => setup(leadLower, "rotation") + sign * value), duration, "easeOut"),
    track(leadHand, "rotation", base.phases, handArc.map((value) => setup(leadHand, "rotation") + sign * value), duration, "easeOut"),
    track(supportUpper, "rotation", base.phases, supportUpperValues, duration, "easeOut"),
    track(supportLower, "rotation", base.phases, supportLowerValues, duration, "easeOut"),
    track(support, "rotation", base.phases, handArc.map((value) => setup(support, "rotation") + sign * value * Math.abs(supportFactor) * .45), duration, "easeOut"),
    track(leftUpperLeg, "rotation", base.phases, pelvisArc.map((value) => setup(leftUpperLeg, "rotation") - value * .82), duration),
    track(rightUpperLeg, "rotation", base.phases, pelvisArc.map((value) => setup(rightUpperLeg, "rotation") - value * .82), duration),
  ]);
  const animation: AnimationDefinition = { schemaVersion: 1, id: "attack", name: "Attack", duration, loop: false, tracks };
  return { animation, plan: {
    kind: "attack", type, topology: profile.topology, archetype: profile.archetype, duration,
    phases: [
      { phase: base.phases[0], name: "neutral" }, { phase: base.phases[1], name: "anticipation" }, { phase: base.phases[2], name: "action" }, { phase: base.phases[3], name: "follow-through" }, { phase: base.phases[4], name: "recovery" },
    ], primaryEquipment: primary, primaryHand, supportArmMode, rootShift: 0, pelvisTurn: base.pelvis * amplitude, torsoTurn: base.torso * amplitude,
    leadArmAmplitude: armAmplitude, weaponArc: weaponArc.map(rounded), headCompensation: base.head * compact, followThrough: base.follow, recoveryEase: "easeInOut", equipmentConstraints: constraints,
  } };
}

export function buildIdleAttackAnimation(context: AnimationGenerationContext, kind: IdleAttackKind): { readonly animation: AnimationDefinition; readonly plan: IdleAttackPlan } | null {
  return kind === "idle" ? buildIdleAnimation(context) : buildAttackAnimation(context);
}
