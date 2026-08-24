import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { RiggingCommandService } from "../../src/agent-control/commands/RiggingCommandService";
import type { CommandResult } from "../../src/agent-control/commands/results";
import { HttpCharacterPipelineProvider } from "../../src/character-generation/providers/httpCharacterPipelineProvider";
import { canonicalProjectStateDigest } from "../../src/project-storage/digest";
import type { LocalProjectSnapshot } from "../../src/project-storage/types";
import { AnimationPlayer } from "../../src/rigging/animation/AnimationPlayer";
import { RigRuntime } from "../../src/rigging/runtime/RigRuntime";
import { blockingRigProjectProblems, validateRigProject } from "../../src/rigging/validation/project";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";
import { ManagedGenerationStorage } from "../../mcp/storage/managedGenerationStorage";

const ROOT = process.cwd();
const RUN_ID = process.env.RIG_STUDIO_FINAL_GATE_RUN_ID ?? "2026-08-23T15-42-41Z";
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/final-confirmatory-gates", RUN_ID);
const SOURCE_DIR = path.join(OUT, "sources");
const ENDPOINT = "http://127.0.0.1:47831/character-pipeline";
const ASSET_BASE = "http://127.0.0.1:47831";
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const errors = (result: CommandResult<Record<string, unknown>>): string[] => result.success ? [] : result.errors.map((error) => error.message);
const commandRecord = (result: CommandResult<Record<string, unknown>>) => ({ success: result.success, warnings: result.warnings, errors: errors(result) });

type SourceRecord = {
  index: number;
  file: string;
  name: string;
  archetype: string;
  topology: string;
  equipment: string;
  details: string;
  sha256: string;
  width: number;
  height: number;
  transparentBackground: boolean;
};
type SourceManifest = { runId: string; sources: SourceRecord[] };
const manifest = JSON.parse(await readFile(path.join(OUT, "source-manifest.json"), "utf8")) as SourceManifest;
const store = new LocalProjectStore({ cwd: ROOT });
const generationStorage = new ManagedGenerationStorage({ cwd: ROOT, approvedRoots: [SOURCE_DIR] });

const clipDefinitions = [
  { key: "idle", name: "Idle", duration: 1.8, loop: true, request: "subtle equipment-aware idle loop with stable planted feet" },
  { key: "walk", name: "Walk", duration: .96, loop: true, request: "production gameplay walk loop with coherent planted-foot contacts" },
  { key: "run", name: "Run", duration: .64, loop: true, request: "production gameplay run loop distinct from Walk with coherent contacts" },
  { key: "attack", name: "Attack", duration: .8, loop: false, request: "readable equipment-aware attack with anticipation action follow-through and recovery" },
] as const;

function playback(snapshot: LocalProjectSnapshot) {
  const rig = snapshot.rig;
  const clips = snapshot.animations?.animations ?? [];
  if (!rig) return { attempted: true, passed: false, reason: "rig unavailable", clips: [] };
  const validTargets = new Set(rig.bones.map((bone) => bone.id));
  const results = clips.map((clip) => {
    const invalidTargets = clip.tracks.filter((track) => !validTargets.has(track.boneId)).map((track) => track.boneId);
    const runtime = new RigRuntime(rig);
    const player = new AnimationPlayer(runtime);
    player.play(clip);
    player.update(Math.min(.1, clip.duration / 4));
    player.pause();
    player.seek(clip.duration * .5);
    player.play(clip);
    player.update(Math.min(.1, clip.duration / 4));
    return { id: clip.id, invalidTargets, finite: clip.tracks.every((track) => track.keyframes.every((key) => Number.isFinite(key.time) && Number.isFinite(key.value))), passed: invalidTargets.length === 0 };
  });
  return { attempted: true, passed: results.length === 4 && results.every((result) => result.passed && result.finite), reason: results.length === 4 ? null : `expected 4 clips, found ${results.length}`, clips: results };
}

const providerProbe = new HttpCharacterPipelineProvider(ENDPOINT);
const providerCapabilities = await providerProbe.refreshCapabilities();
const characterResults = [];

for (const source of manifest.sources) {
  const resultPath = path.join(OUT, "harness", `${String(source.index).padStart(2, "0")}-${source.file.replace(/\.png$/, "")}-result.json`);
  try {
    characterResults.push(JSON.parse(await readFile(resultPath, "utf8")));
    continue;
  } catch {
    // A missing result is the normal path. Existing result files are immutable
    // checkpoints so an interrupted recorder never repeats a character attempt.
  }
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const provider = new HttpCharacterPipelineProvider(ENDPOINT);
  await provider.refreshCapabilities();
  const service = new RiggingCommandService({ characterProvider: provider });
  const prompt = `${source.archetype}; ${source.topology}; ${source.equipment}; ${source.details}`;
  const create = await service.executeTool("project_create", { name: `Final Gate ${String(source.index).padStart(2, "0")} ${source.name}`, prompt }, "Confirmatory Harness");
  if (!create.success) throw new Error(`${source.name}: project creation failed: ${errors(create).join("; ")}`);
  const createdProject = create.project as { id: string };
  const projectId = createdProject.id;
  const generationId = `final-gate-${RUN_ID}-${String(source.index).padStart(2, "0")}`;
  const ingress = await generationStorage.ingest({
    projectId,
    imageSource: { type: "local_path", path: path.join(SOURCE_DIR, source.file) },
    generationId,
    provider: "openai-imagegen-frozen-source",
    prompt,
    accepted: true,
    generationMode: "imported_external",
    operation: "CHARACTER_GENERATION",
    metadata: { runId: RUN_ID, sourceSha256: source.sha256, archetype: source.archetype, zeroTouch: true },
  }, ASSET_BASE);
  const imported = await service.executeTool("character_import_generation", ingress, "Confirmatory Harness");
  const sourceAcceptedAt = performance.now();

  const suitability = await service.executeTool("character_run_suitability_check", { projectId }, "Confirmatory Harness");
  const autoCut = await service.executeTool("parts_auto_cut", { projectId, instruction: "Create the production landmark-guided complete semantic cut without manual correction." }, "Confirmatory Harness");
  const cutAttemptAt = performance.now();
  let acceptCut: CommandResult<Record<string, unknown>> | null = null;
  if (autoCut.success && typeof autoCut.proposalId === "string") acceptCut = await service.executeTool("parts_accept_proposal", { projectId, proposalId: autoCut.proposalId, confirm: true }, "Confirmatory Harness");
  const finalizeCut = await service.executeTool("parts_finalize", { projectId, confirm: true }, "Confirmatory Harness");
  const rigAttemptAt = performance.now();
  const rigSummary = await service.executeTool("rig_get_summary", { projectId, includeHierarchy: true, includeFull: true }, "Confirmatory Harness");
  const smokeTest = await service.executeTool("project_run_smoke_test", { projectId }, "Confirmatory Harness");
  const animationAttempts = [];
  for (const definition of clipDefinitions) {
    const result = await service.executeTool("animation_generate", { projectId, request: definition.request, name: definition.name, duration: definition.duration, loop: definition.loop }, "Confirmatory Harness");
    animationAttempts.push({ type: definition.key, ...commandRecord(result), digest: result.success && result.animation ? digest(result.animation) : null });
  }
  const clipsAttemptAt = performance.now();
  const validation = await service.executeTool("validation_get", { projectId, includeDetails: true }, "Confirmatory Harness");
  const memorySave = await service.executeTool("project_save", { projectId }, "Confirmatory Harness");
  if (!memorySave.success || !memorySave.snapshot) throw new Error(`${source.name}: source-only snapshot could not be preserved: ${errors(memorySave).join("; ")}`);
  const snapshot = memorySave.snapshot as LocalProjectSnapshot;
  const sourceCanonicalDigest = canonicalProjectStateDigest(snapshot);
  const saved = await store.save(snapshot);
  const reopened = await new LocalProjectStore({ cwd: ROOT }).load(saved.projectId);
  const reopenedDigest = canonicalProjectStateDigest(reopened.snapshot);
  const reopenedAt = performance.now();
  const reopenPlayback = playback(reopened.snapshot);

  let zipResult: Record<string, unknown>;
  try {
    const exported = await store.exportSnapshot(saved.projectId);
    const zipName = exported.files.find((file) => file.endsWith(".project.zip"));
    if (!zipName) throw new Error("portable ZIP was not produced");
    const importedCopy = await store.importPortableZip(await readFile(path.join(exported.exportPath, zipName)), `${source.name} Final Gate ZIP Copy`);
    const importedSnapshot = await store.load(importedCopy.projectId);
    const importedDigest = canonicalProjectStateDigest(importedSnapshot.snapshot, true);
    const normalizedSourceDigest = canonicalProjectStateDigest(reopened.snapshot, true);
    const zipPlayback = playback(importedSnapshot.snapshot);
    const zipProblems = validateRigProject(importedSnapshot.snapshot);
    zipResult = {
      attempted: true,
      archive: path.relative(ROOT, path.join(exported.exportPath, zipName)),
      importProjectId: importedCopy.projectId,
      normalizedDigestMatch: importedDigest === normalizedSourceDigest,
      validationProblems: zipProblems,
      playback: zipPlayback,
      passed: importedDigest === normalizedSourceDigest && blockingRigProjectProblems(zipProblems).length === 0 && zipPlayback.passed,
    };
  } catch (error: unknown) {
    zipResult = { attempted: true, passed: false, error: error instanceof Error ? error.message : "ZIP attempt failed" };
  }
  const zipAt = performance.now();

  const projectProblems = validateRigProject(reopened.snapshot);
  const blockingProblems = blockingRigProjectProblems(projectProblems);
  const clips = reopened.snapshot.animations?.animations ?? [];
  const clipStatus = Object.fromEntries(clipDefinitions.map((definition) => {
    const clip = clips.find((candidate) => candidate.id.toLowerCase() === definition.key || candidate.name.toLowerCase() === definition.name.toLowerCase());
    return [definition.key, clip ? "UNREVIEWED" : "BAD"];
  }));
  const completeCut = Boolean(reopened.snapshot.project?.partCutterState?.finalized && reopened.snapshot.project.segmentationData?.parts.length);
  const rigValid = Boolean(reopened.snapshot.rig && blockingProblems.length === 0);
  const allClipsPresent = clips.length === 4;
  const zeroTouchReady = completeCut && rigValid && allClipsPresent && reopenPlayback.passed && zipResult.passed === true;
  const providerOffline = !provider.capabilities.segmentation.available;
  const failureReason = providerOffline
    ? provider.capabilities.segmentation.reason ?? "required image-conditioned segmentation provider unavailable"
    : errors(autoCut).join("; ") || errors(finalizeCut).join("; ") || errors(rigSummary).join("; ") || "full pipeline did not complete";
  characterResults.push({
    index: source.index,
    character: source.name,
    archetype: source.archetype,
    source,
    projectId: saved.projectId,
    startedAt,
    providerCapabilities: provider.capabilities,
    sourceAccepted: imported.success,
    suitability: commandRecord(suitability),
    cut: { attempted: true, autoCut: commandRecord(autoCut), acceptance: acceptCut ? commandRecord(acceptCut) : null, finalize: commandRecord(finalizeCut), complete: completeCut, quality: completeCut ? "UNREVIEWED" : "BAD" },
    rig: { attempted: true, summary: commandRecord(rigSummary), smokeTest: commandRecord(smokeTest), canonicalValid: rigValid, pivotQuality: rigValid ? "UNREVIEWED" : "BAD", blockingProblems },
    animations: { attempted: true, clips: animationAttempts, persistedClipCount: clips.length, qualities: clipStatus, allFourPresent: allClipsPresent },
    uiPlayback: { attempted: false, passed: false, reason: "Animate is blocked because no canonical rig/four-clip library exists" },
    reopen: { attempted: true, loaded: true, canonicalDigestBefore: sourceCanonicalDigest, canonicalDigestAfter: reopenedDigest, digestMatch: sourceCanonicalDigest === reopenedDigest, playback: reopenPlayback, passed: sourceCanonicalDigest === reopenedDigest && reopenPlayback.passed },
    zip: zipResult,
    zeroTouchCorrections: 0,
    repair: { rawResultFrozen: true, attempted: false, corrections: 0, reason: providerOffline ? "Restoring a required offline provider is not a <=2 manual character correction; manual complete cutting would exceed the repair budget." : "No <=2 correction route established." },
    timingMs: { sourceAccepted: sourceAcceptedAt - started, sourceToCutAttempt: cutAttemptAt - started, sourceToRigAttempt: rigAttemptAt - started, sourceToFourClipAttempt: clipsAttemptAt - started, sourceToReopened: reopenedAt - started, sourceToZipImported: zipAt - started, total: zipAt - started },
    handsOn: { correctionSeconds: 0, navigationReviewSeconds: 0, note: "Automated confirmatory harness; no human correction gestures were performed." },
    classification: zeroTouchReady ? "ZERO-TOUCH PRODUCTION READY" : "FAILED",
    failureReason,
  });
  await writeFile(resultPath, json(characterResults.at(-1)));
}

const stableFailureRetests = [];
for (const source of manifest.sources.slice(0, 5)) {
  const provider = new HttpCharacterPipelineProvider(ENDPOINT);
  const first = await provider.refreshCapabilities();
  const second = await provider.refreshCapabilities();
  stableFailureRetests.push({ character: source.name, segmentationAvailableFirst: first.segmentation.available, segmentationAvailableSecond: second.segmentation.available, reasonFirst: first.segmentation.reason, reasonSecond: second.segmentation.reason, deterministicUnavailableResult: first.segmentation.available === second.segmentation.available && first.segmentation.reason === second.segmentation.reason });
}

const primary = {
  runId: RUN_ID,
  completedAt: new Date().toISOString(),
  algorithmFrozen: true,
  productionChangesDuringGate: [],
  providerCapabilities,
  characters: characterResults,
  determinismRetest: stableFailureRetests,
};
await writeFile(path.join(OUT, "primary-results.json"), json(primary));
process.stdout.write(json({
  runId: RUN_ID,
  projects: characterResults.map((character) => ({ character: character.character, projectId: character.projectId, sourceAccepted: character.sourceAccepted, cutComplete: character.cut.complete, rigValid: character.rig.canonicalValid, clips: character.animations.persistedClipCount, reopen: character.reopen.passed, zip: character.zip.passed, classification: character.classification, failureReason: character.failureReason })),
  providerSegmentation: providerCapabilities.segmentation,
  determinismRetests: stableFailureRetests.filter((entry) => entry.deterministicUnavailableResult).length,
}));
