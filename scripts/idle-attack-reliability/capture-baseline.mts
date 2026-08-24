import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";
import { evaluateAnimationAtTime } from "../../src/rigging/animation/evaluate";
import { buildAnimationGenerationContext } from "../../src/rigging/ai/animationContextBuilder";
import { MockAnimationGenerationProvider } from "../../src/rigging/ai/mockAnimationGenerationProvider";
import { validateAnimationProposal } from "../../src/rigging/ai/animationProposalValidator";
import { createRestPose } from "../../src/rigging/runtime/pose";
import { computeWorldTransforms } from "../../src/rigging/runtime/worldTransforms";
import type { AnimationDefinition, RigDefinition } from "../../src/rigging/schema/types";

const ROOT = process.cwd();
const RUN_ID = process.env.RIG_STUDIO_IDLE_ATTACK_RUN_ID ?? "2026-08-23T10-43-00Z";
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/idle-attack-reliability", RUN_ID);
const CLIP_OUT = path.join(OUT, "baseline-clips");
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

const stable = (value: unknown): string => JSON.stringify(value, (_key, current) => current && typeof current === "object" && !Array.isArray(current)
  ? Object.fromEntries(Object.entries(current).sort(([left], [right]) => left.localeCompare(right)))
  : current);
const digest = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const topologyDigest = (rig: RigDefinition): string => digest({ bones: rig.bones, rootBoneId: rig.rootBoneId, anatomyProfile: rig.metadata.anatomyProfile });
const pivotDigest = (rig: RigDefinition): string => digest({ pivotSources: rig.metadata.pivotSources, attachmentPivotSources: rig.metadata.attachmentPivotSources, slots: rig.slots.map(({ id, pivotX, pivotY }) => ({ id, pivotX, pivotY })) });
const bindingDigest = (rig: RigDefinition): string => digest({ bindingSources: rig.metadata.bindingSources, slots: rig.slots.map(({ id, boneId, attachmentId }) => ({ id, boneId, attachmentId })) });
const nonAnimationDigest = (snapshot: Awaited<ReturnType<LocalProjectStore["load"]>>["snapshot"]): string => digest({ ...snapshot, animations: null, project: snapshot.project ? { ...snapshot.project, updatedAt: "<ignored>" } : null });
const boneRange = (animation: AnimationDefinition, pattern: RegExp): Array<{ channel: string; range: number }> => animation.tracks
  .filter((track) => pattern.test(track.boneId))
  .map((track) => ({ channel: `${track.boneId}:${track.property}`, range: Math.max(...track.keyframes.map((key) => key.value)) - Math.min(...track.keyframes.map((key) => key.value)) }));

function height(rig: RigDefinition): number {
  const world = computeWorldTransforms(rig, createRestPose(rig));
  const ys = Object.values(world).map((entry) => entry.y);
  return Math.max(1, Math.max(...ys) - Math.min(...ys));
}

function drift(rig: RigDefinition, animation: AnimationDefinition, boneIds: readonly string[]): { mean: number; max: number; meanHeight: number; maxHeight: number } {
  const base = createRestPose(rig); const samples = Array.from({ length: 33 }, (_, index) => animation.duration * index / 32);
  const values = boneIds.flatMap((boneId) => {
    const positions = samples.map((time) => computeWorldTransforms(rig, evaluateAnimationAtTime(animation, base, time))[boneId]).filter(Boolean);
    const origin = positions[0];
    return origin ? positions.map((position) => Math.hypot(position.x - origin.x, position.y - origin.y)) : [];
  });
  const rigHeight = height(rig); const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; const max = Math.max(0, ...values);
  return { mean, max, meanHeight: mean / rigHeight, maxHeight: max / rigHeight };
}

function equipment(rig: RigDefinition): Array<{ id: string; boneId: string; tags: readonly string[] }> {
  return rig.slots.flatMap((slot) => {
    const attachment = rig.attachments.find((candidate) => candidate.id === slot.attachmentId);
    return attachment?.category === "equipment" ? [{ id: attachment.id, boneId: slot.boneId, tags: attachment.tags }] : [];
  });
}

function oldClass(letter: string, clip: "idle" | "attack"): "GOOD" | "USABLE" | "BAD" {
  if (clip === "idle") return "USABLE";
  return ["A", "D", "G", "H"].includes(letter) ? "USABLE" : "BAD";
}

function oldIssue(letter: string, clip: "idle" | "attack"): string {
  if (clip === "idle") return "generic fixed-duration torso bob and head sway; stable but not archetype-specific";
  return ({ A: "arm-dominant sword arc with minimal body mechanics", B: "staff treated as generic sword arm", C: "generic swing lacks heavy anticipation and follow-through", D: "unarmed action is readable but generic", E: "staff/cast semantics ignored", F: "rifle treated as melee swing with no support grip", G: "dagger action lacks sharp archetype timing", H: "club action lacks proportion-scaled heavy mechanics" } as Record<string, string>)[letter];
}

await mkdir(CLIP_OUT, { recursive: true });
const store = new LocalProjectStore({ cwd: ROOT }); const provider = new MockAnimationGenerationProvider(); const frozen = []; const baseline = [];
for (const [letter, name, projectId] of CHARACTERS) {
  const loaded = await store.load(projectId); const rig = loaded.snapshot.rig; const library = loaded.snapshot.animations;
  if (!rig || !loaded.snapshot.project || !library) throw new Error(`${letter}: persisted project incomplete`);
  const walk = library.animations.find((clip) => clip.id === "walk"); const run = library.animations.find((clip) => clip.id === "run");
  if (!walk || !run) throw new Error(`${letter}: frozen locomotion clips missing`);
  frozen.push({
    letter, name, projectId, projectDigest: nonAnimationDigest(loaded.snapshot), rigDigest: digest(rig), topologyDigest: topologyDigest(rig),
    pivotDigest: pivotDigest(rig), bindingDigest: bindingDigest(rig), attachmentDigest: digest(rig.attachments), walkDigest: digest(walk), runDigest: digest(run),
    animationLibraryDigest: digest(library), modifiedAt: loaded.summary.modifiedAt,
  });
  const clips = [];
  for (const target of [{ id: "idle" as const, request: "Create a subtle breathing idle with restrained head and arm movement.", duration: 2, loop: true }, { id: "attack" as const, request: "Create a sword attack with anticipation, a fast strike, impact, and recovery.", duration: .85, loop: false }]) {
    const context = buildAnimationGenerationContext(rig, {
      request: target.request, mode: "create", selectedBoneIds: [], leftRightMappings: [], groundPlaneY: rig.canvas.height * .92,
      leftFootBoneId: rig.bones.find((bone) => /left.*foot/i.test(bone.id))?.id ?? null, rightFootBoneId: rig.bones.find((bone) => /right.*foot/i.test(bone.id))?.id ?? null,
      contactIntervals: [], referenceAnimations: library.animations, includeSlotNames: true,
      constraints: { duration: target.duration, loop: target.loop, intensity: .65, weight: .65, exaggeration: .45, rootMovementAllowance: 80, preserveTiming: false, preserveContactFrames: true, styleNotes: "Raw post-locomotion baseline" },
    });
    const started = performance.now(); const proposal = await provider.generateAnimationProposal({ prompt: target.request, context }); const generationMs = performance.now() - started;
    const validation = validateAnimationProposal(proposal, rig); if (!validation.success) throw new Error(`${letter} ${target.id}: ${validation.message}`);
    const animation = { ...validation.proposal.animation, id: target.id, name: target.id === "idle" ? "Idle" : "Attack" };
    await writeFile(path.join(CLIP_OUT, `${letter.toLowerCase()}-${target.id}.json`), json(animation));
    const feet = rig.bones.filter((bone) => /(?:left|right).*foot/i.test(bone.id)).map((bone) => bone.id); const footDrift = drift(rig, animation, feet);
    const firstLastMatch = animation.tracks.every((track) => track.keyframes[0]?.value === track.keyframes.at(-1)?.value && track.keyframes.at(-1)?.time === animation.duration);
    clips.push({
      type: target.id, digest: digest(animation), duration: animation.duration, loop: animation.loop, channels: animation.tracks.map((track) => `${track.boneId}:${track.property}`),
      targets: [...new Set(animation.tracks.map((track) => track.boneId))], tracks: animation.tracks.length, keyframes: animation.tracks.reduce((sum, track) => sum + track.keyframes.length, 0),
      equipment: equipment(rig), equipmentBehavior: target.id === "idle" ? "inherited and unanimated" : "primary hand inherits generic arm rotation; semantic unsupported",
      rootPelvisMotion: boneRange(animation, /root|pelvis/i), torsoMotion: boneRange(animation, /torso/i), armMotion: boneRange(animation, /arm|hand/i), footDrift,
      idleLoopSeamPassed: target.id === "idle" ? firstLastMatch : null, attackRecoveryPosePassed: target.id === "attack" ? firstLastMatch : null,
      visualClass: oldClass(letter, target.id), primaryIssue: oldIssue(letter, target.id), generationMs, validatorPassed: true, warnings: proposal.warnings, assumptions: proposal.assumptions,
    });
  }
  baseline.push({ letter, name, projectId, clips });
}

await writeFile(path.join(OUT, "frozen-digests.json"), json({ runId: RUN_ID, capturedAt: new Date().toISOString(), characters: frozen }));
await writeFile(path.join(OUT, "baseline.json"), json({ runId: RUN_ID, capturedAt: new Date().toISOString(), provider: provider.id, characters: baseline }));
process.stdout.write(json({ out: path.relative(ROOT, OUT), frozen: frozen.length, baselineClips: baseline.flatMap((item) => item.clips).length, classes: baseline.flatMap((item) => item.clips).reduce<Record<string, number>>((counts, clip) => ({ ...counts, [clip.visualClass]: (counts[clip.visualClass] ?? 0) + 1 }), {}) }));
