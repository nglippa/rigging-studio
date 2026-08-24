import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpCharacterPipelineProvider } from "../../src/character-generation/providers/httpCharacterPipelineProvider";
import { canonicalProjectStateDigest } from "../../src/project-storage/digest";
import { blockingRigProjectProblems, validateRigProject } from "../../src/rigging/validation/project";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";

const ROOT = process.cwd();
const RUN_ID = "2026-08-23T15-42-41Z";
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/final-confirmatory-gates", RUN_ID);
const manifest = JSON.parse(await readFile(path.join(OUT, "source-manifest.json"), "utf8"));
const source = manifest.sources[0];
const store = new LocalProjectStore({ cwd: ROOT });
const summary = (await store.list()).find((candidate) => candidate.name === "Final Gate 01 Desert Duelist");
if (!summary) throw new Error("Interrupted first-character project was not found");
const loaded = await store.load(summary.projectId);
const beforeDigest = canonicalProjectStateDigest(loaded.snapshot);
const reopened = await new LocalProjectStore({ cwd: ROOT }).load(summary.projectId);
const afterDigest = canonicalProjectStateDigest(reopened.snapshot);
const provider = new HttpCharacterPipelineProvider("http://127.0.0.1:47831/character-pipeline");
const capabilities = await provider.refreshCapabilities();
const reason = capabilities.segmentation.reason ?? "required image-conditioned segmentation provider unavailable";

let zip: Record<string, unknown>;
try {
  const exported = await store.exportSnapshot(summary.projectId);
  const zipName = exported.files.find((file) => file.endsWith(".project.zip"));
  if (!zipName) throw new Error("portable ZIP was not produced");
  const imported = await store.importPortableZip(await readFile(path.join(exported.exportPath, zipName)), "Desert Duelist Final Gate ZIP Copy");
  const roundTrip = await store.load(imported.projectId);
  const normalizedDigestMatch = canonicalProjectStateDigest(reopened.snapshot, true) === canonicalProjectStateDigest(roundTrip.snapshot, true);
  const problems = validateRigProject(roundTrip.snapshot);
  zip = {
    attempted: true,
    archive: path.relative(ROOT, path.join(exported.exportPath, zipName)),
    importProjectId: imported.projectId,
    normalizedDigestMatch,
    validationProblems: problems,
    playback: { attempted: true, passed: false, reason: "rig unavailable", clips: [] },
    passed: normalizedDigestMatch && blockingRigProjectProblems(problems).length === 0 && false,
  };
} catch (error) {
  zip = { attempted: true, passed: false, error: error instanceof Error ? error.message : "ZIP attempt failed" };
}

const failedCommand = { success: false, warnings: [], errors: [reason] };
const result = {
  index: source.index,
  character: source.name,
  archetype: source.archetype,
  source,
  projectId: summary.projectId,
  startedAt: summary.createdAt,
  providerCapabilities: capabilities,
  sourceAccepted: true,
  suitability: { success: false, warnings: [], errors: ["Suitability request completed before the recorder interruption; the source-only persisted state contains no accepted suitability result."] },
  cut: { attempted: true, autoCut: failedCommand, acceptance: null, finalize: { success: false, warnings: [], errors: ["Parts must be finalized before rigging"] }, complete: false, quality: "BAD" },
  rig: { attempted: true, summary: { success: false, warnings: [], errors: ["No rig exists"] }, smokeTest: { success: false, warnings: [], errors: ["No rig exists"] }, canonicalValid: false, pivotQuality: "BAD", blockingProblems: [] },
  animations: {
    attempted: true,
    clips: ["idle", "walk", "run", "attack"].map((type) => ({ type, success: false, warnings: [], errors: ["No rig exists"], digest: null })),
    persistedClipCount: 0,
    qualities: { idle: "BAD", walk: "BAD", run: "BAD", attack: "BAD" },
    allFourPresent: false,
  },
  uiPlayback: { attempted: false, passed: false, reason: "Animate is blocked because no canonical rig/four-clip library exists" },
  reopen: { attempted: true, loaded: true, canonicalDigestBefore: beforeDigest, canonicalDigestAfter: afterDigest, digestMatch: beforeDigest === afterDigest, playback: { attempted: true, passed: false, reason: "rig unavailable", clips: [] }, passed: false },
  zip,
  zeroTouchCorrections: 0,
  repair: { rawResultFrozen: true, attempted: false, corrections: 0, reason: "Restoring a required offline provider is not a <=2 manual character correction; manual complete cutting would exceed the repair budget." },
  timingMs: { sourceAccepted: null, sourceToCutAttempt: null, sourceToRigAttempt: null, sourceToFourClipAttempt: null, sourceToReopened: null, sourceToZipImported: null, total: null },
  handsOn: { correctionSeconds: 0, navigationReviewSeconds: 0, note: "Automated confirmatory harness; no human correction gestures were performed." },
  classification: "FAILED",
  failureReason: reason,
  harnessRecovery: { recorderFailure: "LocalProjectSaveResult was read through a nonexistent summary field after the durable save completed.", productionRetried: false, pipelineAttemptRepeated: false, checkpointRecoveredFromDisk: true },
};

const resultPath = path.join(OUT, "harness", "01-01-desert-duelist-result.json");
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ resultPath, projectId: summary.projectId, digestMatch: beforeDigest === afterDigest, zip }, null, 2)}\n`);
