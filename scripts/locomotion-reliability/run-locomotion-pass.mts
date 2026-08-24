import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";
import { buildAnimationGenerationContext } from "../../src/rigging/ai/animationContextBuilder";
import { diagnoseNormalizedFootSliding } from "../../src/rigging/ai/footSlideDiagnostic";
import { buildLocomotionAnimation, type GaitKind } from "../../src/rigging/ai/locomotionEngine";
import { MockAnimationGenerationProvider } from "../../src/rigging/ai/mockAnimationGenerationProvider";
import { validateAnimationProposal } from "../../src/rigging/ai/animationProposalValidator";
import type { AnimationDefinition, RigDefinition } from "../../src/rigging/schema/types";
import { blockingRigProjectProblems, validateRigProject } from "../../src/rigging/validation/project";
import { createAnimationLibrary } from "../../src/tools/rig-editor/animation/library";
import type { AnimationLibrary } from "../../src/tools/rig-editor/animation/types";

const ROOT = process.cwd(); const RUN_ID = "2026-08-23T09-30-00Z";
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/locomotion-reliability", RUN_ID);
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const stable = (value: unknown): string => JSON.stringify(value, (_key, current) => current && typeof current === "object" && !Array.isArray(current) ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) : current);
const digest = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");
const clipDigest = (clip: AnimationDefinition | undefined): string | null => clip ? digest(clip) : null;
const CHARACTERS = [
  ["A", "Standard Swordsman", "character-torture-a-clean-swordsman-v1"], ["B", "Plague Doctor", "character-torture-b-plague-doctor-v1"],
  ["C", "Broad Dwarf", "character-torture-c-dwarf-heavy-fighter-v1"], ["D", "Digitigrade Beastman", "character-torture-d-digitigrade-beastman-v1"],
  ["E", "Robed Mage", "character-torture-e-robed-mage-v1"], ["F", "Bulky Marine", "character-torture-f-bulky-sci-fi-marine-v1"],
  ["G", "Thin Rogue", "character-torture-g-agile-rogue-v1"], ["H", "Extreme Chibi Fighter", "character-torture-h-extreme-chibi-fighter-v1"],
] as const;
const GAITS = [{ id: "walk" as const, duration: .96 }, { id: "run" as const, duration: .64 }];

const nonAnimationDigest = (snapshot: Awaited<ReturnType<LocalProjectStore["load"]>>["snapshot"]): string => digest({ ...snapshot, animations: null, project: snapshot.project ? { ...snapshot.project, updatedAt: "<ignored>" } : null });
const topologyDigest = (rig: RigDefinition): string => digest({ bones: rig.bones, rootBoneId: rig.rootBoneId, anatomyProfile: rig.metadata.anatomyProfile });
const pivotDigest = (rig: RigDefinition): string => digest({ pivotSources: rig.metadata.pivotSources, attachmentPivotSources: rig.metadata.attachmentPivotSources, slots: rig.slots.map(({ id, pivotX, pivotY }) => ({ id, pivotX, pivotY })) });
const bindingDigest = (rig: RigDefinition): string => digest({ bindingSources: rig.metadata.bindingSources, slots: rig.slots.map(({ id, boneId, attachmentId }) => ({ id, boneId, attachmentId })) });
const replaceClip = (library: AnimationLibrary, clip: AnimationDefinition): AnimationLibrary => library.animations.some((candidate) => candidate.id === clip.id || candidate.name.toLowerCase() === clip.name.toLowerCase())
  ? { ...library, animations: library.animations.map((candidate) => candidate.id === clip.id || candidate.name.toLowerCase() === clip.name.toLowerCase() ? clip : candidate) }
  : { ...library, animations: [...library.animations, clip] };

await mkdir(OUT, { recursive: true });
const freeze = JSON.parse(await readFile(path.join(OUT, "frozen-digests.json"), "utf8")) as { characters: Array<Record<string, unknown>> };
const frozenByLetter = new Map(freeze.characters.map((item) => [String(item.letter), item]));
const store = new LocalProjectStore({ cwd: ROOT }); const provider = new MockAnimationGenerationProvider(); const results = [];

for (const [letter, name, projectId] of CHARACTERS) {
  const loaded = await store.load(projectId); const rig = loaded.snapshot.rig; if (!rig || !loaded.snapshot.project) throw new Error(`${letter}: incomplete project`);
  const frozen = frozenByLetter.get(letter); if (!frozen) throw new Error(`${letter}: frozen digest missing`);
  const beforeInvariant = {
    projectDigest: nonAnimationDigest(loaded.snapshot), rigDigest: digest(rig), topologyDigest: topologyDigest(rig), pivotDigest: pivotDigest(rig),
    bindingDigest: bindingDigest(rig), attachmentDigest: digest(rig.attachments),
    idleDigest: clipDigest(loaded.snapshot.animations?.animations.find((clip) => /idle/i.test(`${clip.id} ${clip.name}`))),
    attackDigest: clipDigest(loaded.snapshot.animations?.animations.find((clip) => /attack|melee/i.test(`${clip.id} ${clip.name}`))),
  };
  for (const [key, value] of Object.entries(beforeInvariant)) if (value !== frozen[key]) throw new Error(`${letter}: frozen ${key} changed before locomotion commit`);
  let library = loaded.snapshot.animations ?? createAnimationLibrary(rig.id, []); const clips = [];
  for (const gait of GAITS) {
    const context = buildAnimationGenerationContext(rig, {
      request: gait.id === "walk" ? "gameplay walk loop with opposing arms and legs and stable equipment" : "energetic gameplay run loop with larger stride, flight, and body bounce",
      mode: "create", selectedBoneIds: [], leftRightMappings: [], groundPlaneY: rig.canvas.height * .92,
      leftFootBoneId: rig.bones.find((bone) => /left.*foot/i.test(bone.id))?.id ?? null, rightFootBoneId: rig.bones.find((bone) => /right.*foot/i.test(bone.id))?.id ?? null,
      contactIntervals: [], referenceAnimations: library.animations, includeSlotNames: true,
      constraints: { duration: gait.duration, loop: true, intensity: .65, weight: .65, exaggeration: .45, rootMovementAllowance: 80, preserveTiming: false, preserveContactFrames: true, styleNotes: "Locomotion reliability production pass" },
    });
    const generationStarted = performance.now();
    const candidate = await provider.generateAnimationProposal({ prompt: context.motionDescription, context });
    const generationMs = performance.now() - generationStarted;
    const validation = validateAnimationProposal(candidate, rig); if (!validation.success) throw new Error(`${letter} ${gait.id}: ${validation.message}`);
    const planned = buildLocomotionAnimation(context, gait.id as GaitKind); if (!planned) throw new Error(`${letter} ${gait.id}: gait plan unavailable`);
    const animation = { ...validation.proposal.animation, id: gait.id, name: gait.id === "walk" ? "Walk" : "Run" };
    const diagnostics = diagnoseNormalizedFootSliding(rig, animation, { leftFootBoneId: context.feet.leftFootBoneId, rightFootBoneId: context.feet.rightFootBoneId }, planned.plan.contacts);
    const maxHeightDrift = Math.max(0, ...diagnostics.map((item) => item.normalizedToHeight ?? 0));
    const maxLegDrift = Math.max(0, ...diagnostics.map((item) => item.normalizedToLegLength ?? 0));
    const meanHeightDrift = diagnostics.length ? diagnostics.reduce((sum, item) => sum + (item.normalizedToHeight ?? 0), 0) / diagnostics.length : 0;
    const meanLegDrift = diagnostics.length ? diagnostics.reduce((sum, item) => sum + (item.normalizedToLegLength ?? 0), 0) / diagnostics.length : 0;
    const seamPassed = animation.tracks.every((track) => track.keyframes[0].value === track.keyframes.at(-1)?.value && track.keyframes.at(-1)?.time === animation.duration);
    if (!seamPassed || diagnostics.some((item) => item.likelySliding)) throw new Error(`${letter} ${gait.id}: candidate quality gate failed`);
    library = replaceClip(library, animation);
    clips.push({ gait: gait.id, digest: digest(animation), duration: animation.duration, tracks: animation.tracks.length, keyframes: animation.tracks.reduce((sum, track) => sum + track.keyframes.length, 0), generationMs, significantManualCorrections: 0, validatorPassed: true, seamPassed, diagnostics, meanHeightDrift, maxHeightDrift, meanLegDrift, maxLegDrift, visualClass: maxHeightDrift > .018 ? "USABLE" : "GOOD", assumptions: candidate.assumptions, warnings: candidate.warnings, plan: planned.plan });
  }
  library = { ...library, metadata: { ...library.metadata, locomotionEngine: "deterministic-topology-gait-v1", locomotionConvention: "in-place", locomotionRunId: RUN_ID } };
  const candidateSnapshot = { ...loaded.snapshot, animations: library };
  const blocking = blockingRigProjectProblems(validateRigProject(candidateSnapshot)); if (blocking.length) throw new Error(`${letter}: candidate project invalid: ${blocking.map((problem) => problem.message).join("; ")}`);
  await store.save(candidateSnapshot, { expectedModifiedAt: loaded.summary.modifiedAt });
  const reopened = await new LocalProjectStore({ cwd: ROOT }).load(projectId); const postRig = reopened.snapshot.rig!;
  const afterInvariant = {
    projectDigest: nonAnimationDigest(reopened.snapshot), rigDigest: digest(postRig), topologyDigest: topologyDigest(postRig), pivotDigest: pivotDigest(postRig),
    bindingDigest: bindingDigest(postRig), attachmentDigest: digest(postRig.attachments),
    idleDigest: clipDigest(reopened.snapshot.animations?.animations.find((clip) => /idle/i.test(`${clip.id} ${clip.name}`))),
    attackDigest: clipDigest(reopened.snapshot.animations?.animations.find((clip) => /attack|melee/i.test(`${clip.id} ${clip.name}`))),
  };
  const invariants = Object.fromEntries(Object.entries(afterInvariant).map(([key, value]) => [key, { frozen: frozen[key], post: value, passed: value === frozen[key] }]));
  const reopenDigests = Object.fromEntries(reopened.snapshot.animations!.animations.filter((clip) => /^(walk|run)$/.test(clip.id)).map((clip) => [clip.id, digest(clip)]));
  results.push({ letter, name, projectId, clips, candidateValidatedBeforeCommit: true, reopen: { passed: clips.every((clip) => reopenDigests[clip.gait] === clip.digest), digests: reopenDigests }, invariants, allInvariantsPassed: Object.values(invariants).every((item) => item.passed), modifiedAt: reopened.summary.modifiedAt });
}

const zipResults = [];
for (const [letter, name, projectId] of CHARACTERS.filter(([letter]) => ["A", "D", "F"].includes(letter))) {
  const source = await store.load(projectId); const exported = await store.exportSnapshot(projectId); const zipName = exported.files.find((file) => file.endsWith(".project.zip")); if (!zipName) throw new Error(`${letter}: ZIP missing`);
  const temp = await mkdtemp(path.join(tmpdir(), `rig-studio-locomotion-${letter.toLowerCase()}-`)); const target = new LocalProjectStore({ cwd: temp, root: path.join(temp, "projects"), trashRoot: path.join(temp, "trash") });
  const imported = await target.importPortableZip(await readFile(path.join(exported.exportPath, zipName)), `${name} locomotion copy`); const roundTrip = await target.load(imported.projectId);
  const sourceClips = Object.fromEntries(source.snapshot.animations!.animations.filter((clip) => /^(walk|run)$/.test(clip.id)).map((clip) => [clip.id, digest(clip)]));
  const targetClips = Object.fromEntries(roundTrip.snapshot.animations!.animations.filter((clip) => /^(walk|run)$/.test(clip.id)).map((clip) => [clip.id, digest(clip)]));
  zipResults.push({ letter, projectId, zip: path.relative(ROOT, path.join(exported.exportPath, zipName)), rigDigestPassed: digest(source.snapshot.rig) === digest(roundTrip.snapshot.rig), clipDigestsPassed: stable(sourceClips) === stable(targetClips), sourceClips, targetClips, playbackTargetsValid: roundTrip.snapshot.animations!.animations.filter((clip) => /^(walk|run)$/.test(clip.id)).every((clip) => clip.tracks.every((track) => roundTrip.snapshot.rig!.bones.some((bone) => bone.id === track.boneId))) });
}

const isolationSequence = Array.from({ length: 32 }, (_, index) => CHARACTERS[(index * 5 + 3) % CHARACTERS.length]); const isolation = [];
for (const [letter, , projectId] of isolationSequence) { const loaded = await store.load(projectId); isolation.push({ letter, projectId, rigDigest: digest(loaded.snapshot.rig), expected: frozenByLetter.get(letter)?.rigDigest, passed: digest(loaded.snapshot.rig) === frozenByLetter.get(letter)?.rigDigest }); }
const summary = {
  runId: RUN_ID, completedAt: new Date().toISOString(), convention: "in-place", engine: "deterministic-topology-gait-v1", characters: results,
  aggregate: { usableWalk: results.filter((item) => item.clips.find((clip) => clip.gait === "walk")?.visualClass !== "BAD").length, usableRun: results.filter((item) => item.clips.find((clip) => clip.gait === "run")?.visualClass !== "BAD").length, goodClips: results.flatMap((item) => item.clips).filter((clip) => clip.visualClass === "GOOD").length, usableClips: results.flatMap((item) => item.clips).filter((clip) => clip.visualClass === "USABLE").length, averageGenerationMs: results.flatMap((item) => item.clips).reduce((sum, clip) => sum + clip.generationMs, 0) / results.flatMap((item) => item.clips).length, averageMeanHeightDrift: results.flatMap((item) => item.clips).reduce((sum, clip) => sum + clip.meanHeightDrift, 0) / results.flatMap((item) => item.clips).length, invariantPasses: results.filter((item) => item.allInvariantsPassed).length, reopenPasses: results.filter((item) => item.reopen.passed).length, zipPasses: zipResults.filter((item) => item.rigDigestPassed && item.clipDigestsPassed && item.playbackTargetsValid).length, isolationPasses: isolation.filter((item) => item.passed).length },
  zipRoundTrips: zipResults, projectIsolation: { sequenceLength: isolation.length, passed: isolation.every((item) => item.passed), sequence: isolation },
};
await writeFile(path.join(OUT, "run-results.json"), json(summary));
process.stdout.write(json({ out: path.relative(ROOT, OUT), aggregate: summary.aggregate }));
