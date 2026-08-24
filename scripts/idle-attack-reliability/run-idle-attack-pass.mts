import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";
import { evaluateAnimationAtTime } from "../../src/rigging/animation/evaluate";
import { AnimationGenerationGuard } from "../../src/rigging/ai/animationGenerationGuard";
import { buildAnimationGenerationContext } from "../../src/rigging/ai/animationContextBuilder";
import { diagnoseNormalizedFootSliding } from "../../src/rigging/ai/footSlideDiagnostic";
import { buildIdleAttackAnimation, type AttackPlan, type IdleAttackKind } from "../../src/rigging/ai/idleAttackEngine";
import { MockAnimationGenerationProvider } from "../../src/rigging/ai/mockAnimationGenerationProvider";
import { validateAnimationProposal } from "../../src/rigging/ai/animationProposalValidator";
import { createRestPose } from "../../src/rigging/runtime/pose";
import { computeWorldTransforms } from "../../src/rigging/runtime/worldTransforms";
import type { AnimationDefinition, RigDefinition } from "../../src/rigging/schema/types";
import { blockingRigProjectProblems, validateRigProject } from "../../src/rigging/validation/project";
import type { AnimationLibrary } from "../../src/tools/rig-editor/animation/types";

const ROOT = process.cwd(); const RUN_ID = process.env.RIG_STUDIO_IDLE_ATTACK_RUN_ID ?? "2026-08-23T10-43-00Z";
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/idle-attack-reliability", RUN_ID); const COMMIT = process.env.RIG_STUDIO_IDLE_ATTACK_COMMIT === "1";
const CHARACTERS = [
  ["A", "Standard Swordsman", "character-torture-a-clean-swordsman-v1"], ["B", "Plague Doctor", "character-torture-b-plague-doctor-v1"],
  ["C", "Broad Dwarf", "character-torture-c-dwarf-heavy-fighter-v1"], ["D", "Digitigrade Beastman", "character-torture-d-digitigrade-beastman-v1"],
  ["E", "Robed Mage", "character-torture-e-robed-mage-v1"], ["F", "Bulky Marine", "character-torture-f-bulky-sci-fi-marine-v1"],
  ["G", "Thin Rogue", "character-torture-g-agile-rogue-v1"], ["H", "Extreme Chibi Fighter", "character-torture-h-extreme-chibi-fighter-v1"],
] as const;
const REQUESTS = [
  { kind: "idle" as const, request: "Create a subtle breathing idle with restrained head and arm movement.", duration: 2, loop: true },
  { kind: "attack" as const, request: "Create an equipment-aware class attack with anticipation, action, follow-through, and recovery.", duration: .85, loop: false },
];

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const stable = (value: unknown): string => JSON.stringify(value, (_key, current) => current && typeof current === "object" && !Array.isArray(current) ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) : current);
const digest = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");
const clipDigest = (clip: AnimationDefinition | undefined): string | null => clip ? digest(clip) : null;
const topologyDigest = (rig: RigDefinition): string => digest({ bones: rig.bones, rootBoneId: rig.rootBoneId, anatomyProfile: rig.metadata.anatomyProfile });
const pivotDigest = (rig: RigDefinition): string => digest({ pivotSources: rig.metadata.pivotSources, attachmentPivotSources: rig.metadata.attachmentPivotSources, slots: rig.slots.map(({ id, pivotX, pivotY }) => ({ id, pivotX, pivotY })) });
const bindingDigest = (rig: RigDefinition): string => digest({ bindingSources: rig.metadata.bindingSources, slots: rig.slots.map(({ id, boneId, attachmentId }) => ({ id, boneId, attachmentId })) });
const nonAnimationDigest = (snapshot: Awaited<ReturnType<LocalProjectStore["load"]>>["snapshot"]): string => digest({ ...snapshot, animations: null, project: snapshot.project ? { ...snapshot.project, updatedAt: "<ignored>" } : null });
const replaceClip = (library: AnimationLibrary, clip: AnimationDefinition): AnimationLibrary => {
  const matches = (candidate: AnimationDefinition): boolean => candidate.id === clip.id || (clip.id === "attack" && /attack|melee/i.test(`${candidate.id} ${candidate.name}`)) || (clip.id === "idle" && /idle/i.test(`${candidate.id} ${candidate.name}`));
  return library.animations.some(matches) ? { ...library, animations: library.animations.map((candidate) => matches(candidate) ? clip : candidate) } : { ...library, animations: [...library.animations, clip] };
};

function rigHeight(rig: RigDefinition): number {
  const world = computeWorldTransforms(rig, createRestPose(rig)); const ys = Object.values(world).map((item) => item.y);
  return Math.max(1, Math.max(...ys) - Math.min(...ys));
}

function handRelationship(rig: RigDefinition, animation: AnimationDefinition, primaryHand: "left" | "right"): { mean: number; max: number; meanHeight: number; maxHeight: number } {
  const primary = `${primaryHand}-hand`; const support = `${primaryHand === "right" ? "left" : "right"}-hand`; const base = createRestPose(rig); const samples = Array.from({ length: 33 }, (_, index) => animation.duration * index / 32);
  const distances = samples.map((time) => { const world = computeWorldTransforms(rig, evaluateAnimationAtTime(animation, base, time)); return Math.hypot(world[primary].x - world[support].x, world[primary].y - world[support].y); });
  const errors = distances.map((value) => Math.abs(value - distances[0])); const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length; const max = Math.max(...errors); const height = rigHeight(rig);
  return { mean, max, meanHeight: mean / height, maxHeight: max / height };
}

function weaponPath(rig: RigDefinition, animation: AnimationDefinition, plan: AttackPlan): { points: Array<{ phase: number; x: number; y: number }>; arcLength: number; maximumSegment: number; teleportRatio: number } {
  const boneId = `${plan.primaryHand}-hand`; const base = createRestPose(rig); const points = plan.phases.map(({ phase }) => {
    const world = computeWorldTransforms(rig, evaluateAnimationAtTime(animation, base, phase * animation.duration))[boneId];
    return { phase, x: Number(world.x.toFixed(4)), y: Number(world.y.toFixed(4)) };
  });
  const segments = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y)); const arcLength = segments.reduce((sum, value) => sum + value, 0); const maximumSegment = Math.max(0, ...segments);
  return { points, arcLength, maximumSegment, teleportRatio: maximumSegment / Math.max(1, arcLength) };
}

function invariantState(snapshot: Awaited<ReturnType<LocalProjectStore["load"]>>["snapshot"], rig: RigDefinition): Record<string, string | null> {
  const animations = snapshot.animations?.animations ?? [];
  return { projectDigest: nonAnimationDigest(snapshot), rigDigest: digest(rig), topologyDigest: topologyDigest(rig), pivotDigest: pivotDigest(rig), bindingDigest: bindingDigest(rig), attachmentDigest: digest(rig.attachments), walkDigest: clipDigest(animations.find((clip) => clip.id === "walk")), runDigest: clipDigest(animations.find((clip) => clip.id === "run")) };
}

function visualClass(kind: IdleAttackKind, metrics: { footMax: number; seamOrRecovery: boolean; gripMax: number; teleportRatio: number }): "GOOD" | "USABLE" | "BAD" {
  if (!metrics.seamOrRecovery || metrics.footMax > .035 || metrics.gripMax > .09 || metrics.teleportRatio > .75) return "BAD";
  if (kind === "idle") return metrics.footMax <= .012 ? "GOOD" : "USABLE";
  return metrics.footMax <= .022 && metrics.gripMax <= .065 && metrics.teleportRatio <= .65 ? "GOOD" : "USABLE";
}

await mkdir(OUT, { recursive: true });
const frozen = JSON.parse(await readFile(path.join(OUT, "frozen-digests.json"), "utf8")) as { characters: Array<Record<string, unknown>> }; const frozenByLetter = new Map(frozen.characters.map((item) => [String(item.letter), item]));
const store = new LocalProjectStore({ cwd: ROOT }); const provider = new MockAnimationGenerationProvider(); const results = [];
for (const [letter, name, projectId] of CHARACTERS) {
  const loaded = await store.load(projectId); const rig = loaded.snapshot.rig; if (!rig || !loaded.snapshot.animations) throw new Error(`${letter}: persisted rig/library missing`);
  const expected = frozenByLetter.get(letter); if (!expected) throw new Error(`${letter}: frozen record missing`);
  const before = invariantState(loaded.snapshot, rig); for (const [key, value] of Object.entries(before)) if (value !== expected[key]) throw new Error(`${letter}: ${key} changed before Idle/Attack candidate`);
  let library = loaded.snapshot.animations; const clips = [];
  for (const target of REQUESTS) {
    const context = buildAnimationGenerationContext(rig, {
      request: target.request, mode: "create", selectedBoneIds: [], leftRightMappings: [], groundPlaneY: rig.canvas.height * .92,
      leftFootBoneId: rig.bones.find((bone) => /left.*foot/i.test(bone.id))?.id ?? null, rightFootBoneId: rig.bones.find((bone) => /right.*foot/i.test(bone.id))?.id ?? null,
      contactIntervals: [], referenceAnimations: library.animations, includeSlotNames: true,
      constraints: { duration: target.duration, loop: target.loop, intensity: .65, weight: .65, exaggeration: .45, rootMovementAllowance: 80, preserveTiming: false, preserveContactFrames: true, styleNotes: "Idle/Attack reliability production pass" },
    });
    const started = performance.now(); const proposal = await provider.generateAnimationProposal({ prompt: target.request, context }); const generationMs = performance.now() - started;
    const validation = validateAnimationProposal(proposal, rig); if (!validation.success) throw new Error(`${letter} ${target.kind}: ${validation.message}`);
    const planned = buildIdleAttackAnimation(context, target.kind); if (!planned) throw new Error(`${letter} ${target.kind}: plan unavailable`);
    const animation = { ...validation.proposal.animation, id: target.kind, name: target.kind === "idle" ? "Idle" : "Attack" };
    const feet = { leftFootBoneId: context.feet.leftFootBoneId, rightFootBoneId: context.feet.rightFootBoneId };
    const intervals = target.kind === "idle" ? [{ foot: "leftFoot" as const, start: 0, end: animation.duration }, { foot: "rightFoot" as const, start: 0, end: animation.duration }]
      : [{ foot: ((planned.plan as AttackPlan).primaryHand === "right" ? "leftFoot" : "rightFoot") as "leftFoot" | "rightFoot", start: 0, end: animation.duration }];
    const diagnostics = diagnoseNormalizedFootSliding(rig, animation, feet, intervals); const meanHeightDrift = diagnostics.reduce((sum, item) => sum + (item.normalizedToHeight ?? 0), 0) / Math.max(1, diagnostics.length); const maxHeightDrift = Math.max(0, ...diagnostics.map((item) => item.normalizedToHeight ?? 0));
    const endpointPassed = animation.tracks.every((track) => track.keyframes[0].value === track.keyframes.at(-1)?.value && track.keyframes.at(-1)?.time === animation.duration);
    const attackPlan = planned.plan.kind === "attack" ? planned.plan : null; const grip = attackPlan?.supportArmMode === "two-handed-lock" ? handRelationship(rig, animation, attackPlan.primaryHand) : { mean: 0, max: 0, meanHeight: 0, maxHeight: 0 };
    const pathEvidence = attackPlan ? weaponPath(rig, animation, attackPlan) : null; const classification = visualClass(target.kind, { footMax: maxHeightDrift, seamOrRecovery: endpointPassed, gripMax: grip.maxHeight, teleportRatio: pathEvidence?.teleportRatio ?? 0 });
    if (classification === "BAD") throw new Error(`${letter} ${target.kind}: candidate quality BAD (foot ${(maxHeightDrift * 100).toFixed(2)}%, grip ${(grip.maxHeight * 100).toFixed(2)}%, arc ${pathEvidence?.teleportRatio.toFixed(3) ?? "n/a"})`);
    library = replaceClip(library, animation);
    clips.push({ kind: target.kind, digest: digest(animation), duration: animation.duration, loop: animation.loop, tracks: animation.tracks.length, keyframes: animation.tracks.reduce((sum, track) => sum + track.keyframes.length, 0), generationMs, significantManualCorrections: 0, validatorPassed: true, candidateValidatedBeforeCommit: true, endpointPassed, diagnostics, meanHeightDrift, maxHeightDrift, gripError: grip, weaponPath: pathEvidence, visualClass: classification, assumptions: proposal.assumptions, warnings: proposal.warnings, plan: planned.plan });
  }
  library = { ...library, metadata: { ...library.metadata, idleAttackEngine: "deterministic-structured-motion-v1", idleAttackRunId: RUN_ID } };
  const candidateSnapshot = { ...loaded.snapshot, animations: library }; const blocking = blockingRigProjectProblems(validateRigProject(candidateSnapshot)); if (blocking.length) throw new Error(`${letter}: candidate project invalid: ${blocking.map((problem) => problem.message).join("; ")}`);
  if (COMMIT) await store.save(candidateSnapshot, { expectedModifiedAt: loaded.summary.modifiedAt });
  const verified = COMMIT ? await new LocalProjectStore({ cwd: ROOT }).load(projectId) : { ...loaded, snapshot: candidateSnapshot };
  const postRig = verified.snapshot.rig!; const after = invariantState(verified.snapshot, postRig); const invariants = Object.fromEntries(Object.entries(after).map(([key, value]) => [key, { frozen: expected[key], post: value, passed: value === expected[key] }]));
  const persisted = Object.fromEntries((verified.snapshot.animations?.animations ?? []).filter((clip) => /^(idle|attack)$/.test(clip.id)).map((clip) => [clip.id, digest(clip)]));
  results.push({ letter, name, projectId, committed: COMMIT, clips, reopen: { passed: clips.every((clip) => persisted[clip.kind] === clip.digest), digests: persisted }, invariants, allInvariantsPassed: Object.values(invariants).every((item) => item.passed), modifiedAt: verified.summary.modifiedAt });
}

const zipResults = [];
if (COMMIT) for (const [letter, name, projectId] of CHARACTERS.filter(([letter]) => ["A", "D", "F"].includes(letter))) {
  const source = await store.load(projectId); const exported = await store.exportSnapshot(projectId); const zipName = exported.files.find((file) => file.endsWith(".project.zip")); if (!zipName) throw new Error(`${letter}: ZIP missing`);
  const temp = await mkdtemp(path.join(tmpdir(), `rig-studio-idle-attack-${letter.toLowerCase()}-`)); const target = new LocalProjectStore({ cwd: temp, root: path.join(temp, "projects"), trashRoot: path.join(temp, "trash") });
  const imported = await target.importPortableZip(await readFile(path.join(exported.exportPath, zipName)), `${name} Idle Attack copy`); const roundTrip = await target.load(imported.projectId);
  const sourceClips = Object.fromEntries(source.snapshot.animations!.animations.filter((clip) => /^(idle|walk|run|attack)$/.test(clip.id)).map((clip) => [clip.id, digest(clip)])); const targetClips = Object.fromEntries(roundTrip.snapshot.animations!.animations.filter((clip) => /^(idle|walk|run|attack)$/.test(clip.id)).map((clip) => [clip.id, digest(clip)]));
  zipResults.push({ letter, projectId, zip: path.relative(ROOT, path.join(exported.exportPath, zipName)), rigDigestPassed: digest(source.snapshot.rig) === digest(roundTrip.snapshot.rig), clipDigestsPassed: stable(sourceClips) === stable(targetClips), sourceClips, targetClips, playbackTargetsValid: roundTrip.snapshot.animations!.animations.filter((clip) => /^(idle|walk|run|attack)$/.test(clip.id)).every((clip) => clip.tracks.every((track) => roundTrip.snapshot.rig!.bones.some((bone) => bone.id === track.boneId))) });
}

const guard = new AnimationGenerationGuard(); const isolation = [];
for (const kind of ["idle", "attack"] as const) {
  const delayed = guard.begin(`character-torture-a-clean-swordsman-v1:session-a:revision-4:${kind}`); guard.setSource(`character-torture-b-plague-doctor-v1:session-b:revision-1:${kind}`);
  isolation.push({ kind, source: "A", switchedTo: "B", delayedAcceptedInB: guard.isCurrent(delayed, `character-torture-b-plague-doctor-v1:session-b:revision-1:${kind}`), passed: !guard.isCurrent(delayed, `character-torture-b-plague-doctor-v1:session-b:revision-1:${kind}`) });
}
const sequence = Array.from({ length: 32 }, (_, index) => CHARACTERS[(index * 5 + 3) % CHARACTERS.length]); const switchChecks = [];
for (const [letter, , projectId] of sequence) { const loaded = await store.load(projectId); const expected = frozenByLetter.get(letter)!; switchChecks.push({ letter, projectId, rigDigest: digest(loaded.snapshot.rig), expected: expected.rigDigest, passed: digest(loaded.snapshot.rig) === expected.rigDigest }); }
const allClips = results.flatMap((item) => item.clips); const summary = {
  runId: RUN_ID, completedAt: new Date().toISOString(), committed: COMMIT, engine: "deterministic-structured-motion-v1", characters: results,
  aggregate: { usableIdle: results.filter((item) => ["GOOD", "USABLE"].includes(item.clips.find((clip) => clip.kind === "idle")?.visualClass ?? "BAD")).length, goodIdle: results.filter((item) => item.clips.find((clip) => clip.kind === "idle")?.visualClass === "GOOD").length, usableAttack: results.filter((item) => ["GOOD", "USABLE"].includes(item.clips.find((clip) => clip.kind === "attack")?.visualClass ?? "BAD")).length, goodAttack: results.filter((item) => item.clips.find((clip) => clip.kind === "attack")?.visualClass === "GOOD").length, averageIdleGenerationMs: results.reduce((sum, item) => sum + item.clips.find((clip) => clip.kind === "idle")!.generationMs, 0) / 8, averageAttackGenerationMs: results.reduce((sum, item) => sum + item.clips.find((clip) => clip.kind === "attack")!.generationMs, 0) / 8, averageIdleMeanHeightDrift: results.reduce((sum, item) => sum + item.clips.find((clip) => clip.kind === "idle")!.meanHeightDrift, 0) / 8, averageAttackMeanHeightDrift: results.reduce((sum, item) => sum + item.clips.find((clip) => clip.kind === "attack")!.meanHeightDrift, 0) / 8, averageGripMeanHeight: results.reduce((sum, item) => sum + item.clips.find((clip) => clip.kind === "attack")!.gripError.meanHeight, 0) / 8, loopFailures: allClips.filter((clip) => clip.kind === "idle" && !clip.endpointPassed).length, recoveryFailures: allClips.filter((clip) => clip.kind === "attack" && !clip.endpointPassed).length, manualCorrections: allClips.reduce((sum, clip) => sum + clip.significantManualCorrections, 0), invariantPasses: results.filter((item) => item.allInvariantsPassed).length, reopenPasses: results.filter((item) => item.reopen.passed).length, zipPasses: zipResults.filter((item) => item.rigDigestPassed && item.clipDigestsPassed && item.playbackTargetsValid).length, isolationPasses: isolation.filter((item) => item.passed).length + switchChecks.filter((item) => item.passed).length },
  zipRoundTrips: zipResults, projectIsolation: { delayedGeneration: isolation, switchChecks, passed: isolation.every((item) => item.passed) && switchChecks.every((item) => item.passed) },
};
await writeFile(path.join(OUT, COMMIT ? "run-results.json" : "candidate-results.json"), json(summary));
process.stdout.write(json({ out: path.relative(ROOT, OUT), committed: COMMIT, aggregate: summary.aggregate, profiles: results.map((item) => ({ letter: item.letter, attack: (item.clips.find((clip) => clip.kind === "attack")!.plan as AttackPlan).type, idle: item.clips.find((clip) => clip.kind === "idle")!.visualClass, attackClass: item.clips.find((clip) => clip.kind === "attack")!.visualClass })) }));
