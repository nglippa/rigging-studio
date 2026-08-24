import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpCharacterPipelineProvider } from "../../src/character-generation/providers/httpCharacterPipelineProvider";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";
import { verifyFrozenV2ExecutionPlan } from "./execution-plan.mjs";

const exec = promisify(execFile);

type FrozenSource = { readonly file: string; readonly sha256: string; readonly stableGateId?: string };
type SourceManifest = { readonly sources: readonly FrozenSource[] };
type FrozenFile = { readonly file: string; readonly sha256: string; readonly currentSha256?: string };
type AlgorithmFreeze = {
  readonly productionTreeSha256?: string;
  readonly voidRangerSha256?: string;
  readonly repositoryVoidRangerFixtureHash?: string;
  readonly frozenCohortManifestSha256?: string;
  readonly gateSpecSha256?: string;
  readonly comfyUIEnvironmentFileSha256?: string;
  readonly executionPlanSha256?: string;
  readonly sources?: readonly FrozenSource[];
  readonly relevantAlgorithmFiles?: readonly FrozenFile[];
  readonly approvedInfrastructureFiles?: readonly FrozenFile[];
};

export type FinalGatePreflight = {
  readonly status: "READY" | "GATE BLOCKED";
  readonly checkedAt: string;
  readonly storageReady: boolean;
  readonly storage: Awaited<ReturnType<LocalProjectStore["preflight"]>>;
  readonly bridgeReady: boolean;
  readonly requiredProviders: readonly { readonly provider: "comfyui"; readonly dependency: "REQUIRED_FOR_ZERO_TOUCH"; readonly ready: boolean; readonly reason: string | null }[];
  readonly providerCapabilities: unknown;
  readonly sourceCount: number;
  readonly sourceHashesVerified: boolean;
  readonly sourceHashes: readonly { readonly file: string; readonly expected: string; readonly actual: string | null; readonly matches: boolean }[];
  readonly algorithmTreeHash: string;
  readonly expectedAlgorithmTreeHash: string | null;
  readonly voidRangerHash: string | null;
  readonly expectedVoidRangerHash: string | null;
  readonly gateVersion: "v1" | "v2";
  readonly manifestHashVerified: boolean;
  readonly gateSpecVerified: boolean;
  readonly comfyUIEnvironmentVerified: boolean;
  readonly qualityAlgorithmsUnchanged: boolean;
  readonly runnerFrozen: boolean;
  readonly algorithmHashesVerified: boolean;
  readonly providerReady: boolean;
  readonly isolationReady: boolean;
  readonly runnerHashVerified: boolean;
  readonly executionPlanVerified: boolean;
  readonly executionOrderExact: boolean;
  readonly plannedGateIds: readonly string[];
  readonly readyToRun: boolean;
  readonly blockingReasons: readonly string[];
};

const sha = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? filesBelow(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
}

async function productTreeHash(root: string): Promise<string> {
  const productFiles = (await Promise.all(["app", "src", "mcp"].map((directory) => filesBelow(path.join(root, directory))))).flat()
    .filter((file) => !/\.(map|tsbuildinfo)$/.test(file)).sort();
  const supporting = ["package.json", "package-lock.json", "tsconfig.json"].map((file) => path.join(root, file));
  const rows: string[] = [];
  for (const file of [...productFiles, ...supporting]) rows.push(`${path.relative(root, file)}\0${sha(await readFile(file))}`);
  return sha(rows.join("\n"));
}

async function optionalJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return null; }
}

async function probeRunnerPlan(options: { readonly root: string; readonly artifactDirectory: string }): Promise<{ plannedGateIds: readonly string[]; executionPlanSha256: string }> {
  const result = await exec(process.execPath, ["--import", "tsx", path.join(options.root, "scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts")], {
    cwd: options.root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      RIG_STUDIO_FINAL_GATE_VERSION: "v2",
      RIG_STUDIO_FINAL_GATE_V2_PREFLIGHT_DIR: options.artifactDirectory,
      RIG_STUDIO_FINAL_GATE_RUN_ID: "semantic-plan-probe",
      RIG_STUDIO_FINAL_GATE_PLAN_ONLY: "1",
    },
  });
  const parsed = JSON.parse(result.stdout) as { mode?: string; processedSources?: number; plannedGateIds?: readonly string[]; executionPlanSha256?: string };
  if (parsed.mode !== "PLAN_ONLY" || parsed.processedSources !== 0 || !parsed.plannedGateIds || !parsed.executionPlanSha256) throw new Error("Runner plan-only response is malformed or attempted source processing");
  return { plannedGateIds: parsed.plannedGateIds, executionPlanSha256: parsed.executionPlanSha256 };
}

export async function runFinalGatePreflight(options: {
  readonly root: string;
  readonly out: string;
  readonly sourceDirectory: string;
  readonly characterPipelineEndpoint: string;
  readonly gateVersion?: "v1" | "v2";
  readonly artifactDirectory?: string;
}): Promise<FinalGatePreflight> {
  await mkdir(options.out, { recursive: true });
  const gateVersion = options.gateVersion ?? "v1";
  const artifactDirectory = options.artifactDirectory ?? options.out;
  const manifestName = gateVersion === "v2" ? "frozen-cohort-manifest.json" : "source-manifest.json";
  const freezeName = gateVersion === "v2" ? "algorithm-freeze-v2.json" : "algorithm-freeze.json";
  const blockingReasons: string[] = [];
  const manifestPath = path.join(artifactDirectory, manifestName);
  const freezePath = path.join(artifactDirectory, freezeName);
  const gateSpecPath = path.join(artifactDirectory, "final-confirmatory-gate-v2-spec.json");
  const comfyEnvironmentPath = path.join(artifactDirectory, "comfyui-production-environment.json");
  const [manifest, freeze, storage, algorithmTreeHash, manifestBytes, gateSpecBytes, comfyEnvironmentBytes] = await Promise.all([
    optionalJson<SourceManifest>(manifestPath),
    optionalJson<AlgorithmFreeze>(freezePath),
    new LocalProjectStore({ cwd: options.root }).preflight(),
    productTreeHash(options.root),
    readFile(manifestPath).catch(() => null),
    gateVersion === "v2" ? readFile(gateSpecPath).catch(() => null) : Promise.resolve(null),
    gateVersion === "v2" ? readFile(comfyEnvironmentPath).catch(() => null) : Promise.resolve(null),
  ]);
  if (!storage.ready) blockingReasons.push(`Storage preflight failed: ${storage.error ?? "write/read probe unavailable"}`);

  let bridgeReady = false;
  let providerCapabilities: unknown = null;
  let providerReason: string | null = null;
  try {
    const provider = new HttpCharacterPipelineProvider(options.characterPipelineEndpoint);
    providerCapabilities = await provider.refreshCapabilities();
    bridgeReady = true;
    const segmentation = provider.capabilities.segmentation;
    if (!segmentation.available || !segmentation.imageConditioned || !segmentation.workflow || !segmentation.modelFamily) providerReason = segmentation.reason ?? "Required image-conditioned segmentation workflow/model capability is unavailable";
  } catch (error: unknown) { providerReason = error instanceof Error ? error.message : "Provider capability preflight failed"; }
  if (!bridgeReady) blockingReasons.push("Local bridge is unavailable");
  if (providerReason) blockingReasons.push(`ComfyUI zero-touch segmentation is not ready: ${providerReason}`);

  if (!manifest || manifest.sources.length !== 10) blockingReasons.push("Frozen ten-source manifest is missing or does not contain exactly 10 sources");
  if (gateVersion === "v2" && manifest) {
    const ids = manifest.sources.map((source) => source.stableGateId);
    if (ids.some((id) => !id) || new Set(ids).size !== 10) blockingReasons.push("Frozen source stable gate IDs are missing or not unique");
    if (new Set(manifest.sources.map((source) => source.sha256)).size !== 10) blockingReasons.push("Frozen source hashes are not unique");
  }
  const sourceHashes = await Promise.all((manifest?.sources ?? []).map(async (source) => {
    try { const actual = sha(await readFile(path.join(options.sourceDirectory, source.file))); return { file: source.file, expected: source.sha256, actual, matches: actual === source.sha256 }; }
    catch { return { file: source.file, expected: source.sha256, actual: null, matches: false }; }
  }));
  const sourceHashesVerified = sourceHashes.length === 10 && sourceHashes.every((source) => source.matches);
  if (!sourceHashesVerified) blockingReasons.push("Frozen source files are missing or their hashes do not match the prior gate");

  const expectedAlgorithmTreeHash = freeze?.productionTreeSha256 ?? null;
  if (!freeze) blockingReasons.push("Algorithm freeze record is missing");
  if (expectedAlgorithmTreeHash && algorithmTreeHash !== expectedAlgorithmTreeHash) blockingReasons.push("Production tree changed after the algorithm freeze");
  const voidRangerPath = gateVersion === "v2"
    ? path.join(options.root, "tests/fixtures/golden/void-ranger/project.json")
    : path.join(options.root, ".rigging-studio/projects/void-ranger--character-void-ranger-golden-v1/project.json");
  let voidRangerHash: string | null = null;
  try { voidRangerHash = sha(await readFile(voidRangerPath)); } catch { blockingReasons.push(gateVersion === "v2" ? "Repository Void Ranger fixture is missing" : "Frozen Void Ranger project is missing"); }
  const expectedVoidRangerHash = gateVersion === "v2" ? freeze?.repositoryVoidRangerFixtureHash ?? null : freeze?.voidRangerSha256 ?? null;
  if (expectedVoidRangerHash && voidRangerHash !== expectedVoidRangerHash) blockingReasons.push("Void Ranger hash changed from the frozen gate");

  const manifestHashVerified = gateVersion === "v1" || Boolean(manifestBytes && freeze?.frozenCohortManifestSha256 === sha(manifestBytes));
  const gateSpecVerified = gateVersion === "v1" || Boolean(gateSpecBytes && freeze?.gateSpecSha256 === sha(gateSpecBytes));
  const comfyUIEnvironmentVerified = gateVersion === "v1" || Boolean(comfyEnvironmentBytes && freeze?.comfyUIEnvironmentFileSha256 === sha(comfyEnvironmentBytes));
  if (!manifestHashVerified) blockingReasons.push("Frozen cohort manifest hash does not match the v2 freeze");
  if (!gateSpecVerified) blockingReasons.push("V2 gate spec hash does not match the v2 freeze");
  if (!comfyUIEnvironmentVerified) blockingReasons.push("ComfyUI environment hash does not match the v2 freeze");

  const frozenAlgorithmFiles = freeze?.relevantAlgorithmFiles ?? [];
  const algorithmFileChecks = await Promise.all(frozenAlgorithmFiles.map(async (entry) => {
    try { return sha(await readFile(path.join(options.root, entry.file))) === (entry.currentSha256 ?? entry.sha256); } catch { return false; }
  }));
  const qualityAlgorithmsUnchanged = gateVersion === "v1" || (frozenAlgorithmFiles.length === 56 && algorithmFileChecks.every(Boolean));
  if (!qualityAlgorithmsUnchanged) blockingReasons.push("One or more of the 56 frozen quality algorithm files changed");

  const infrastructureFiles = freeze?.approvedInfrastructureFiles ?? [];
  const infrastructureChecks = await Promise.all(infrastructureFiles.map(async (entry) => {
    try { return sha(await readFile(path.join(options.root, entry.file))) === entry.sha256; } catch { return false; }
  }));
  const runnerFrozen = gateVersion === "v1" || (infrastructureFiles.some((entry) => entry.file === "scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts") && infrastructureChecks.every(Boolean));
  if (!runnerFrozen) blockingReasons.push("V2 gate runner or approved preflight infrastructure changed after freeze");

  let executionPlanVerified = gateVersion === "v1";
  let executionOrderExact = gateVersion === "v1";
  let plannedGateIds: readonly string[] = [];
  if (gateVersion === "v2") {
    try {
      const resolvedPlan = await verifyFrozenV2ExecutionPlan({ artifactDirectory, sourceDirectory: options.sourceDirectory });
      const runnerPlan = await probeRunnerPlan({ root: options.root, artifactDirectory });
      plannedGateIds = runnerPlan.plannedGateIds;
      executionPlanVerified = resolvedPlan.planSha256 === freeze?.executionPlanSha256 && runnerPlan.executionPlanSha256 === resolvedPlan.planSha256;
      executionOrderExact = JSON.stringify(runnerPlan.plannedGateIds) === JSON.stringify(resolvedPlan.plannedGateIds);
    } catch (error: unknown) {
      blockingReasons.push(`V2 semantic execution-plan preflight failed: ${error instanceof Error ? error.message : "unknown plan error"}`);
    }
    if (!executionPlanVerified) blockingReasons.push("Frozen execution plan/hash does not match spec, manifest resolution, and actual runner plan");
    if (!executionOrderExact) blockingReasons.push("Actual runner gate-ID order differs from the canonical gate-spec order");
  }

  const verification = gateVersion === "v2"
    ? await optionalJson<{ commands?: readonly { id: string; status: "PASS" | "FAIL" }[] }>(path.join(artifactDirectory, "verification.json"))
    : null;
  const isolationReady = gateVersion === "v1" || Boolean(verification?.commands?.some((entry) => entry.id === "isolation" && entry.status === "PASS") && verification.commands.some((entry) => entry.id === "browser-100-switch" && entry.status === "PASS"));
  const goldenReady = gateVersion === "v1" || Boolean(verification?.commands?.some((entry) => entry.id === "golden" && entry.status === "PASS"));
  if (!isolationReady) blockingReasons.push("Focused isolation and browser 100-switch verification are not both PASS in the refreeze bundle");
  if (!goldenReady) blockingReasons.push("Void Ranger golden verification is not PASS in the refreeze bundle");

  const readyToRun = blockingReasons.length === 0;
  const result: FinalGatePreflight = {
    status: readyToRun ? "READY" : "GATE BLOCKED", checkedAt: new Date().toISOString(), storageReady: storage.ready, storage,
    bridgeReady, requiredProviders: [{ provider: "comfyui", dependency: "REQUIRED_FOR_ZERO_TOUCH", ready: !providerReason, reason: providerReason }],
    providerCapabilities, sourceCount: manifest?.sources.length ?? 0, sourceHashesVerified, sourceHashes,
    algorithmTreeHash, expectedAlgorithmTreeHash, voidRangerHash, expectedVoidRangerHash, gateVersion,
    manifestHashVerified, gateSpecVerified, comfyUIEnvironmentVerified, qualityAlgorithmsUnchanged, runnerFrozen,
    algorithmHashesVerified: qualityAlgorithmsUnchanged,
    providerReady: !providerReason,
    isolationReady,
    runnerHashVerified: runnerFrozen,
    executionPlanVerified,
    executionOrderExact,
    plannedGateIds,
    readyToRun,
    blockingReasons,
  };
  await writeFile(path.join(options.out, gateVersion === "v2" ? "preflight-execution-v2.json" : "preflight.json"), json(result));
  return result;
}
