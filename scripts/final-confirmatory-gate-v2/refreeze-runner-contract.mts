import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveV2ExecutionPlan } from "../final-confirmatory-gate/execution-plan.mjs";

const exec = promisify(execFile);
const ROOT = process.cwd();
const RUN_ID = process.env.RIG_STUDIO_FINAL_GATE_RUN_ID;
if (!RUN_ID) throw new Error("RIG_STUDIO_FINAL_GATE_RUN_ID is required");
const ORIGINAL = path.join(ROOT, ".rigging-studio/diagnostics/final-confirmatory-gates/v2-preflight/2026-08-24T07-05-52Z");
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/final-confirmatory-gates/v2-execution", RUN_ID);
const SOURCE_DIRECTORY = path.join(ROOT, ".rigging-studio/final-confirmatory-gate/v2/frozen-sources");
const OLD_RUNNER = "/tmp/rig-studio-frozen-runner-before-contract-repair.mts";
const OLD_PREFLIGHT = "/tmp/rig-studio-frozen-preflight-before-contract-repair.mts";
const EXPECTED_MANIFEST_HASH = "1afe1c0430c412c55ef46ef97d473833e4c6c07c1c8d50175fe9e893b09e4bf2";
const EXPECTED_OLD_RUNNER_HASH = "9009e8e2826a0db896517e0d071acc0c27f78743009f452d9f5e9b9f6d16139b";
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function shaFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function diff(oldFile: string, newFile: string, oldLabel: string, newLabel: string): Promise<string> {
  try {
    const result = await exec("diff", ["-u", "--label", oldLabel, "--label", newLabel, oldFile, newFile], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return result.stdout;
  } catch (error: unknown) {
    const failure = error as { code?: number; stdout?: string };
    if (failure.code === 1) return failure.stdout ?? "";
    throw error;
  }
}

async function newFileDiff(file: string): Promise<string> {
  return diff("/dev/null", path.join(ROOT, file), "/dev/null", `b/${file}`);
}

await mkdir(OUT, { recursive: true });
const copiedArtifacts = [
  "frozen-cohort-manifest.json",
  "frozen-cohort-manifest.md",
  "final-confirmatory-gate-v2-spec.json",
  "comfyui-production-environment.json",
  "source-hashes.json",
  "source-novelty.json",
];
for (const file of copiedArtifacts) await copyFile(path.join(ORIGINAL, file), path.join(OUT, file));

const manifestHash = await shaFile(path.join(OUT, "frozen-cohort-manifest.json"));
if (manifestHash !== EXPECTED_MANIFEST_HASH) throw new Error(`Frozen manifest changed: ${manifestHash}`);
const resolved = await resolveV2ExecutionPlan({ artifactDirectory: OUT, sourceDirectory: SOURCE_DIRECTORY });
await writeFile(path.join(OUT, "execution-plan.json"), resolved.planJson);
await writeFile(path.join(OUT, "execution-plan.sha256"), `${resolved.planSha256}\n`);

const oldRunnerHash = await shaFile(OLD_RUNNER);
if (oldRunnerHash !== EXPECTED_OLD_RUNNER_HASH) throw new Error("Captured pre-repair runner does not match the frozen old runner hash");
const harnessPaths = [
  "scripts/final-confirmatory-gate/preflight.mts",
  "scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts",
  "scripts/final-confirmatory-gate/execution-plan.mts",
  "scripts/final-confirmatory-gate-v2/refreeze-runner-contract.mts",
  "scripts/final-confirmatory-gate-v2/ui-v2-execution-check.mts",
];
const repairedDiff = [
  await diff(OLD_RUNNER, path.join(ROOT, "scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts"), "a/scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts", "b/scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts"),
  await diff(OLD_PREFLIGHT, path.join(ROOT, "scripts/final-confirmatory-gate/preflight.mts"), "a/scripts/final-confirmatory-gate/preflight.mts", "b/scripts/final-confirmatory-gate/preflight.mts"),
  await newFileDiff("scripts/final-confirmatory-gate/execution-plan.mts"),
  await newFileDiff("scripts/final-confirmatory-gate-v2/refreeze-runner-contract.mts"),
  await newFileDiff("scripts/final-confirmatory-gate-v2/ui-v2-execution-check.mts"),
].join("\n");
await writeFile(path.join(OUT, "repaired-runner.diff"), repairedDiff);

const originalFreeze = JSON.parse(await readFile(path.join(ORIGINAL, "algorithm-freeze-v2.json"), "utf8")) as {
  relevantAlgorithmFiles: Array<{ file: string; currentSha256: string; [key: string]: unknown }>;
  sourceHashes: Array<{ file: string; sha256: string; [key: string]: unknown }>;
  productionTreeSha256: string;
  repositoryVoidRangerFixtureHash: string;
  frozenCohortManifestSha256: string;
  gateSpecSha256: string;
  comfyUIEnvironmentFileSha256: string;
  comfyUIEnvironmentIdentitySha256: string;
  comfyUIWorkflowAggregateSha256: string;
  [key: string]: unknown;
};
const algorithmChecks = await Promise.all(originalFreeze.relevantAlgorithmFiles.map(async (entry) => ({ ...entry, refreezeSha256: await shaFile(path.join(ROOT, entry.file)), matchesPreviousFreeze: await shaFile(path.join(ROOT, entry.file)) === entry.currentSha256 })));
if (algorithmChecks.length !== 56 || algorithmChecks.some((entry) => !entry.matchesPreviousFreeze)) throw new Error("Quality algorithm revalidation failed");
const sourceChecks = await Promise.all(originalFreeze.sourceHashes.map(async (entry) => ({ ...entry, refreezeSha256: await shaFile(path.join(SOURCE_DIRECTORY, entry.file)), matchesPreviousFreeze: await shaFile(path.join(SOURCE_DIRECTORY, entry.file)) === entry.sha256 })));
if (sourceChecks.length !== 10 || sourceChecks.some((entry) => !entry.matchesPreviousFreeze)) throw new Error("Frozen source revalidation failed");

const preservedInfrastructure = [
  "app/studio-ui/ProjectHydrationBoundary.tsx",
  "app/studio-ui/useProviderHealth.ts",
  "src/project-storage/projectLifecycle.ts",
  "src/local-services/providerHealth.ts",
  "mcp/storage/localProjectStore.ts",
];
const approvedInfrastructureFiles = await Promise.all([...preservedInfrastructure, ...harnessPaths].map(async (file) => ({ file, sha256: await shaFile(path.join(ROOT, file)), role: harnessPaths.includes(file) ? "approved final-gate harness" : "unchanged approved infrastructure" })));
const runnerProbe = await exec(process.execPath, ["--import", "tsx", path.join(ROOT, "scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts")], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
  env: {
    ...process.env,
    RIG_STUDIO_FINAL_GATE_VERSION: "v2",
    RIG_STUDIO_FINAL_GATE_V2_PREFLIGHT_DIR: OUT,
    RIG_STUDIO_FINAL_GATE_RUN_ID: RUN_ID,
    RIG_STUDIO_FINAL_GATE_PLAN_ONLY: "1",
  },
});
const runnerPlan = JSON.parse(runnerProbe.stdout) as { processedSources: number; plannedGateIds: string[]; executionPlanSha256: string };
const semanticOrderExact = runnerPlan.processedSources === 0
  && runnerPlan.executionPlanSha256 === resolved.planSha256
  && JSON.stringify(runnerPlan.plannedGateIds) === JSON.stringify(resolved.plannedGateIds);
if (!semanticOrderExact) throw new Error("Actual runner plan-only output differs from canonical spec resolution");

const refrozenAt = new Date().toISOString();
const updatedFreeze = {
  ...originalFreeze,
  runId: RUN_ID,
  frozenAt: refrozenAt,
  status: "HARNESS_CONTRACT_REPAIRED_AND_REFROZEN",
  relevantAlgorithmFiles: algorithmChecks,
  qualityAlgorithmsMatchPreviousBlockedGate: true,
  sourceHashes: sourceChecks,
  frozenCohortManifestSha256: manifestHash,
  executionPlanSha256: resolved.planSha256,
  approvedInfrastructureFiles,
  gateRunner: {
    file: "scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts",
    oldSha256: oldRunnerHash,
    sha256: await shaFile(path.join(ROOT, "scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts")),
    reason: "execution-order contract repair",
    canonicalOrderSource: "final-confirmatory-gate-v2-spec.json#executionOrder",
    planOnlySemanticProbe: { processedSources: runnerPlan.processedSources, plannedGateIds: runnerPlan.plannedGateIds, executionPlanSha256: runnerPlan.executionPlanSha256, exact: semanticOrderExact },
  },
  repairedHarnessDiff: { file: "repaired-runner.diff", sha256: await shaFile(path.join(OUT, "repaired-runner.diff")) },
  characterOneStarted: false,
  confirmatoryPipelineInvoked: false,
};
await writeFile(path.join(OUT, "algorithm-freeze-v2.json"), json(updatedFreeze));
const refreeze = {
  refrozenAt,
  runId: RUN_ID,
  reason: "execution-order contract repair",
  oldRunnerSha256: oldRunnerHash,
  newRunnerSha256: updatedFreeze.gateRunner.sha256,
  oldPreflightSha256: await shaFile(OLD_PREFLIGHT),
  newPreflightSha256: await shaFile(path.join(ROOT, "scripts/final-confirmatory-gate/preflight.mts")),
  manifestSha256: manifestHash,
  manifestUnchanged: manifestHash === EXPECTED_MANIFEST_HASH,
  executionPlanSha256: resolved.planSha256,
  plannedGateIds: resolved.plannedGateIds,
  runnerSemanticPlanExact: semanticOrderExact,
  algorithmsVerified: `${algorithmChecks.filter((entry) => entry.matchesPreviousFreeze).length}/56`,
  sourcesVerified: `${sourceChecks.filter((entry) => entry.matchesPreviousFreeze).length}/10`,
  productCodeChanges: [],
  approvedHarnessFiles: harnessPaths,
  diff: "repaired-runner.diff",
  readyForSemanticPreflight: true,
};
await writeFile(path.join(OUT, "harness-refreeze.json"), json(refreeze));
process.stdout.write(json(refreeze));
