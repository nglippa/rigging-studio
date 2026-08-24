import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";
import { buildAnimationGenerationContext } from "../../src/rigging/ai/animationContextBuilder";
import { diagnoseFootSliding } from "../../src/rigging/ai/footSlideDiagnostic";
import { MockAnimationGenerationProvider } from "../../src/rigging/ai/mockAnimationGenerationProvider";
import { validateAnimationProposal } from "../../src/rigging/ai/animationProposalValidator";
import { evaluateAnimationAtTime } from "../../src/rigging/animation/evaluate";
import { createRestPose } from "../../src/rigging/runtime/pose";
import { computeWorldTransforms } from "../../src/rigging/runtime/worldTransforms";
import type { AnimatedProperty, AnimationDefinition, RigDefinition } from "../../src/rigging/schema/types";

const ROOT = process.cwd();
const RUN_ID = process.env.RIG_STUDIO_LOCOMOTION_RUN_ID ?? "2026-08-23T09-30-00Z";
const STAGE = process.env.RIG_STUDIO_LOCOMOTION_STAGE ?? "baseline";
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/locomotion-reliability", RUN_ID);
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const stable = (value: unknown): string => JSON.stringify(value, (_key, current) => current && typeof current === "object" && !Array.isArray(current) ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) : current);
const digest = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");

const CHARACTERS = [
  ["A", "Standard Swordsman", "character-torture-a-clean-swordsman-v1"],
  ["B", "Plague Doctor", "character-torture-b-plague-doctor-v1"],
  ["C", "Broad Dwarf", "character-torture-c-dwarf-heavy-fighter-v1"],
  ["D", "Digitigrade Beastman", "character-torture-d-digitigrade-beastman-v1"],
  ["E", "Robed Mage", "character-torture-e-robed-mage-v1"],
  ["F", "Bulky Marine", "character-torture-f-bulky-sci-fi-marine-v1"],
  ["G", "Thin Rogue", "character-torture-g-agile-rogue-v1"],
  ["H", "Extreme Chibi Fighter", "character-torture-h-extreme-chibi-fighter-v1"],
] as const;

const GAITS = [
  { id: "walk", request: "gameplay walk loop with opposing arms and legs and stable equipment", duration: .96 },
  { id: "run", request: "energetic gameplay run loop with larger stride and body bounce", duration: .64 },
] as const;

const clipDigest = (clip: AnimationDefinition | undefined): string | null => clip ? digest(clip) : null;
const track = (clip: AnimationDefinition, boneId: string, property: AnimatedProperty) => clip.tracks.find((candidate) => candidate.boneId === boneId && candidate.property === property);
const keyValue = (clip: AnimationDefinition, boneId: string, property: AnimatedProperty, index: number): number => track(clip, boneId, property)?.keyframes[index]?.value ?? 0;

function clipMetrics(rig: RigDefinition, clip: AnimationDefinition, gait: "walk" | "run") {
  const leftFoot = rig.bones.find((bone) => /left.*foot/i.test(bone.id))?.id ?? null;
  const rightFoot = rig.bones.find((bone) => /right.*foot/i.test(bone.id))?.id ?? null;
  const rest = createRestPose(rig);
  const restWorld = computeWorldTransforms(rig, rest);
  const ys = Object.values(restWorld).map((value) => value.y);
  const characterHeight = Math.max(1, Math.max(...ys) - Math.min(...ys));
  const samples = Array.from({ length: 17 }, (_, index) => {
    const phase = index / 16;
    const world = computeWorldTransforms(rig, evaluateAnimationAtTime(clip, rest, phase * clip.duration));
    return { phase, leftFoot: leftFoot ? { x: world[leftFoot].x, y: world[leftFoot].y } : null, rightFoot: rightFoot ? { x: world[rightFoot].x, y: world[rightFoot].y } : null };
  });
  const contactEnd = gait === "walk" ? .375 : .125;
  const intervals = [{ foot: "leftFoot" as const, start: 0, end: clip.duration * contactEnd }, { foot: "rightFoot" as const, start: clip.duration * .5, end: clip.duration * (.5 + contactEnd) }];
  const footDrift = diagnoseFootSliding(rig, clip, { leftFootBoneId: leftFoot, rightFootBoneId: rightFoot }, intervals, characterHeight * .012).map((item) => ({ ...item, normalizedToHeight: item.drift / characterHeight }));
  const start = evaluateAnimationAtTime(clip, rest, 0);
  const end = evaluateAnimationAtTime(clip, rest, clip.duration);
  const seam = Math.max(0, ...clip.tracks.flatMap((item) => {
    const a = start.bones[item.boneId]?.[item.property]; const b = end.bones[item.boneId]?.[item.property];
    return a === undefined || b === undefined ? [] : [Math.abs(a - b)];
  }));
  const leftArm = rig.bones.find((bone) => /left.*upper.*arm/i.test(bone.id))?.id;
  const rightArm = rig.bones.find((bone) => /right.*upper.*arm/i.test(bone.id))?.id;
  const leftLeg = rig.bones.find((bone) => /left.*upper.*leg/i.test(bone.id))?.id;
  const rightLeg = rig.bones.find((bone) => /right.*upper.*leg/i.test(bone.id))?.id;
  const opposition = leftArm && rightArm && leftLeg && rightLeg ? {
    phase0: Math.sign(keyValue(clip, leftArm, "rotation", 0) - rig.bones.find((bone) => bone.id === leftArm)!.rotation) === -Math.sign(keyValue(clip, leftLeg, "rotation", 0) - rig.bones.find((bone) => bone.id === leftLeg)!.rotation),
    bilateralArms: Math.sign(keyValue(clip, leftArm, "rotation", 0)) === -Math.sign(keyValue(clip, rightArm, "rotation", 0)),
    bilateralLegs: Math.sign(keyValue(clip, leftLeg, "rotation", 0)) === -Math.sign(keyValue(clip, rightLeg, "rotation", 0)),
  } : null;
  const maximumNormalizedDrift = Math.max(0, ...footDrift.map((item) => item.normalizedToHeight));
  return {
    digest: digest(clip), duration: clip.duration, loop: clip.loop, tracks: clip.tracks.length,
    keyframes: clip.tracks.reduce((sum, item) => sum + item.keyframes.length, 0),
    targets: [...new Set(clip.tracks.map((item) => item.boneId))], channels: [...new Set(clip.tracks.map((item) => item.property))],
    phaseTimes: [0, .25, .5, .75, 1].map((phase) => Number((phase * clip.duration).toFixed(4))),
    loopSeamMaximumPoseDelta: seam, footDrift, maximumNormalizedDrift, opposition, samples,
    pelvisAndTorsoTracks: clip.tracks.filter((item) => /root|pelvis|torso/i.test(item.boneId)).map((item) => `${item.boneId}:${item.property}`),
    armTracks: clip.tracks.filter((item) => /arm|hand/i.test(item.boneId)).map((item) => `${item.boneId}:${item.property}`),
    visualClass: seam > 1e-6 || maximumNormalizedDrift > .04 ? "BAD" : maximumNormalizedDrift > .018 ? "USABLE" : "GOOD",
  };
}

await mkdir(OUT, { recursive: true });
const store = new LocalProjectStore({ cwd: ROOT });
const provider = new MockAnimationGenerationProvider();
const frozen = [];
const baseline = [];

for (const [letter, name, projectId] of CHARACTERS) {
  const loaded = await store.load(projectId);
  const { project, rig, animations } = loaded.snapshot;
  if (!project || !rig) throw new Error(`${letter}: incomplete persisted project`);
  const existingClips = animations?.animations ?? [];
  const idle = existingClips.find((clip) => /idle/i.test(`${clip.id} ${clip.name}`));
  const attack = existingClips.find((clip) => /attack|melee/i.test(`${clip.id} ${clip.name}`));
  const metadata = rig.metadata as Record<string, unknown>;
  const nonAnimationState = { ...loaded.snapshot, animations: null, project: { ...project, updatedAt: "<ignored>" } };
  frozen.push({
    letter, name, projectId, storageModifiedAt: loaded.summary.modifiedAt,
    projectDigest: digest(nonAnimationState), rigDigest: digest(rig), topologyDigest: digest({ bones: rig.bones, rootBoneId: rig.rootBoneId, anatomyProfile: metadata.anatomyProfile }),
    pivotDigest: digest({ pivotSources: metadata.pivotSources, attachmentPivotSources: metadata.attachmentPivotSources, slots: rig.slots.map(({ id, pivotX, pivotY }) => ({ id, pivotX, pivotY })) }),
    bindingDigest: digest({ bindingSources: metadata.bindingSources, slots: rig.slots.map(({ id, boneId, attachmentId }) => ({ id, boneId, attachmentId })) }),
    attachmentDigest: digest(rig.attachments), idleDigest: clipDigest(idle), attackDigest: clipDigest(attack), animationLibraryDigest: digest(animations),
  });
  const clips = [];
  for (const gait of GAITS) {
    const context = buildAnimationGenerationContext(rig, {
      request: gait.request, mode: "create", constraints: { duration: gait.duration, loop: true, intensity: .65, weight: .65, exaggeration: .45, rootMovementAllowance: 80, preserveTiming: false, preserveContactFrames: true, styleNotes: "Locomotion reliability baseline" },
      selectedBoneIds: [], leftRightMappings: [], groundPlaneY: rig.canvas.height * .92,
      leftFootBoneId: rig.bones.find((bone) => /left.*foot/i.test(bone.id))?.id ?? null,
      rightFootBoneId: rig.bones.find((bone) => /right.*foot/i.test(bone.id))?.id ?? null,
      contactIntervals: [], referenceAnimations: existingClips, includeSlotNames: true,
    });
    const proposal = await provider.generateAnimationProposal({ prompt: gait.request, context });
    const validation = validateAnimationProposal(proposal, rig);
    if (!validation.success) throw new Error(`${letter} ${gait.id}: ${validation.message}`);
    const clip = { ...validation.proposal.animation, id: gait.id, name: gait.id === "walk" ? "Walk" : "Run" };
    clips.push({ gait: gait.id, assumptions: proposal.assumptions, warnings: proposal.warnings, validatorPassed: true, ...clipMetrics(rig, clip, gait.id) });
  }
  baseline.push({ letter, name, projectId, clips });
}

if (STAGE === "baseline") await writeFile(path.join(OUT, "frozen-digests.json"), json({ runId: RUN_ID, capturedAt: new Date().toISOString(), convention: "in-place", characters: frozen }));
await writeFile(path.join(OUT, `${STAGE}.json`), json({ runId: RUN_ID, stage: STAGE, capturedAt: new Date().toISOString(), provider: provider.id, characters: baseline }));
process.stdout.write(json({ out: path.relative(ROOT, OUT), frozen: frozen.length, baselineClips: baseline.flatMap((item) => item.clips).length, classes: baseline.flatMap((item) => item.clips).reduce<Record<string, number>>((counts, clip) => ({ ...counts, [clip.visualClass]: (counts[clip.visualClass] ?? 0) + 1 }), {}) }));
