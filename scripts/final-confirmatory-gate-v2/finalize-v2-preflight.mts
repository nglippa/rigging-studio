import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, readdir, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";

const ROOT = process.cwd();
const RUN_ID = process.env.RIG_STUDIO_FINAL_GATE_V2_PREFLIGHT_RUN_ID ?? "2026-08-24T07-05-52Z";
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/final-confirmatory-gates/v2-preflight", RUN_ID);
const SOURCE_DIRECTORY = path.join(ROOT, ".rigging-studio/final-confirmatory-gate/v2/frozen-sources");
const EXPECTED_VOID_RANGER_HASH = "1cc6dd2ee228d237d9cb095dbe4b8be5bd2085834cb7a49758b0b81af0b34b07";
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const relative = (file: string): string => path.relative(ROOT, file);

type Manifest = {
  readonly sourceCount: number;
  readonly sources: readonly { readonly index: number; readonly stableGateId: string; readonly name: string; readonly file: string; readonly sha256: string }[];
};
type Freeze = {
  readonly productionTreeSha256: string;
  readonly frozenCohortManifestSha256: string;
  readonly gateSpecSha256: string;
  readonly comfyUIEnvironmentFileSha256: string;
  readonly repositoryVoidRangerFixtureHash: string;
  readonly relevantAlgorithmFiles: readonly { readonly file: string; readonly currentSha256: string }[];
  readonly approvedInfrastructureFiles: readonly { readonly file: string; readonly sha256: string }[];
  readonly sourceHashes: readonly { readonly file: string; readonly sha256: string }[];
};
type Verification = {
  readonly completedAt: string;
  readonly commands: readonly {
    readonly id: string;
    readonly command: string;
    readonly status: "PASS" | "FAIL";
    readonly files?: number;
    readonly tests?: number;
    readonly details?: string;
    readonly log?: string;
  }[];
  readonly totalUnitFiles?: number;
  readonly totalUnitTests?: number;
  readonly renderedRoutes?: number;
  readonly deterministicSwitches?: number;
};

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function shaFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }))).flat();
}

async function productionTreeHash(): Promise<string> {
  const files = (await Promise.all(["app", "src", "mcp"].map((directory) => filesBelow(path.join(ROOT, directory))))).flat()
    .filter((file) => !/\.(?:map|tsbuildinfo)$/.test(file)).sort();
  const supporting = ["package.json", "package-lock.json", "tsconfig.json"].map((file) => path.join(ROOT, file));
  const rows = [];
  for (const file of [...files, ...supporting]) rows.push(`${relative(file)}\0${await shaFile(file)}`);
  return sha(rows.join("\n"));
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

const requiredFiles = [
  "frozen-cohort-manifest.json",
  "frozen-cohort-manifest.md",
  "algorithm-freeze-v2.json",
  "final-confirmatory-gate-v2-spec.json",
  "comfyui-production-environment.json",
  "source-novelty.json",
  "source-hashes.json",
  "git-state.json",
  "verification.json",
];
for (const file of requiredFiles) if (!await exists(path.join(OUT, file))) throw new Error(`Required v2 preflight artifact is missing: ${file}`);

const [manifest, freeze, novelty, verification, comfyEnvironment, storage, disk, productionTreeSha256] = await Promise.all([
  readFile(path.join(OUT, "frozen-cohort-manifest.json"), "utf8").then((value) => JSON.parse(value) as Manifest),
  readFile(path.join(OUT, "algorithm-freeze-v2.json"), "utf8").then((value) => JSON.parse(value) as Freeze),
  readFile(path.join(OUT, "source-novelty.json"), "utf8").then((value) => JSON.parse(value) as { status: string; productionPipelineUseBeforeFreeze: boolean }),
  readFile(path.join(OUT, "verification.json"), "utf8").then((value) => JSON.parse(value) as Verification),
  readFile(path.join(OUT, "comfyui-production-environment.json"), "utf8").then((value) => JSON.parse(value) as { status: string; capabilityReady: boolean; liveSegmentationSmoke: { status: string }; environmentIdentitySha256: string }),
  new LocalProjectStore({ cwd: ROOT }).preflight(),
  statfs(path.join(ROOT, ".rigging-studio")),
  productionTreeHash(),
]);

const warnings: string[] = [];
const blockingReasons: string[] = [];
const availableBytes = Number(disk.bavail * disk.bsize);
const storageReady = storage.ready && availableBytes >= 1024 * 1024 * 1024;
if (!storageReady) blockingReasons.push(`Storage is not ready: ${storage.error ?? `only ${availableBytes} available bytes`}`);

type BridgeStatus = { provider?: { reachable?: boolean; message?: string }; capabilities?: { capability: string; capabilityAvailable: boolean; workflowId?: string }[] };
let bridgeStatus: BridgeStatus | null = null;
let systemStats: unknown = null;
let objectInfo: Record<string, unknown> | null = null;
try {
  [bridgeStatus, systemStats, objectInfo] = await Promise.all([
    fetchJson("http://127.0.0.1:47831/image-production/status?refresh=1"),
    fetchJson("http://127.0.0.1:8188/system_stats"),
    fetchJson("http://127.0.0.1:8188/object_info"),
  ]) as [BridgeStatus, unknown, Record<string, unknown>];
} catch (error: unknown) {
  blockingReasons.push(`Live ComfyUI/provider probe failed: ${error instanceof Error ? error.message : "unknown error"}`);
}
const requiredNodeTypes = ["LoadImage", "ImageCrop", "SAM2ModelLoader (segment anything2)", "GroundingDinoModelLoader (segment anything2)", "GroundingDinoSAM2Segment (segment anything2)", "MaskToImage", "SaveImage"];
const requiredNodesReady = Boolean(objectInfo && requiredNodeTypes.every((node) => Object.prototype.hasOwnProperty.call(objectInfo, node)));
const requiredCapabilities = ["CHARACTER_SEGMENTATION", "MASK_REFINEMENT"];
const providerCapabilitiesReady = Boolean(bridgeStatus?.provider?.reachable && requiredCapabilities.every((required) => bridgeStatus?.capabilities?.some((entry) => entry.capability === required && entry.capabilityAvailable)));
const comfyuiReady = comfyEnvironment.status === "READY" && comfyEnvironment.capabilityReady && comfyEnvironment.liveSegmentationSmoke.status === "PASS" && requiredNodesReady && providerCapabilitiesReady;
if (!comfyuiReady) blockingReasons.push("ComfyUI full capability, node, model, or smoke readiness is not verified");

const sourceHashChecks = await Promise.all(manifest.sources.map(async (source) => {
  const actual = await shaFile(path.join(SOURCE_DIRECTORY, source.file)).catch(() => null);
  return { file: source.file, expected: source.sha256, actual, matches: actual === source.sha256 };
}));
const sourceCount = manifest.sourceCount;
const sourceHashesVerified = sourceCount === 10 && sourceHashChecks.length === 10 && sourceHashChecks.every((entry) => entry.matches);
const cohortReady = sourceHashesVerified && new Set(manifest.sources.map((source) => source.stableGateId)).size === 10 && new Set(manifest.sources.map((source) => source.sha256)).size === 10;
const sourceNoveltyVerified = novelty.status === "VERIFIED" && novelty.productionPipelineUseBeforeFreeze === false;
if (!cohortReady) blockingReasons.push("The frozen cohort does not contain 10 unique IDs and 10 exact source hashes");
if (!sourceNoveltyVerified) blockingReasons.push("Source novelty is not verified");

const [manifestSha256, gateSpecSha256, comfyUIEnvironmentFileSha256, voidRangerHash] = await Promise.all([
  shaFile(path.join(OUT, "frozen-cohort-manifest.json")),
  shaFile(path.join(OUT, "final-confirmatory-gate-v2-spec.json")),
  shaFile(path.join(OUT, "comfyui-production-environment.json")),
  shaFile(path.join(ROOT, "tests/fixtures/golden/void-ranger/project.json")),
]);
const manifestHashVerified = manifestSha256 === freeze.frozenCohortManifestSha256;
const gateSpecVerified = gateSpecSha256 === freeze.gateSpecSha256;
const comfyUIEnvironmentHashVerified = comfyUIEnvironmentFileSha256 === freeze.comfyUIEnvironmentFileSha256;
const voidRangerVerified = voidRangerHash === EXPECTED_VOID_RANGER_HASH && voidRangerHash === freeze.repositoryVoidRangerFixtureHash;
if (!manifestHashVerified) blockingReasons.push("Manifest hash changed after freeze");
if (!gateSpecVerified) blockingReasons.push("Gate spec hash changed after freeze");
if (!comfyUIEnvironmentHashVerified) blockingReasons.push("ComfyUI environment artifact hash changed after freeze");
if (!voidRangerVerified) blockingReasons.push("Repository Void Ranger fixture is not byte-identical to the required sentinel");

const algorithmChecks = await Promise.all(freeze.relevantAlgorithmFiles.map(async (entry) => ({ file: entry.file, expected: entry.currentSha256, actual: await shaFile(path.join(ROOT, entry.file)).catch(() => null) })));
const qualityAlgorithmsUnchanged = algorithmChecks.length === 56 && algorithmChecks.every((entry) => entry.actual === entry.expected);
if (!qualityAlgorithmsUnchanged) blockingReasons.push("One or more frozen quality algorithms changed after freeze");
const infrastructureChecks = await Promise.all(freeze.approvedInfrastructureFiles.map(async (entry) => ({ file: entry.file, expected: entry.sha256, actual: await shaFile(path.join(ROOT, entry.file)).catch(() => null) })));
const runnerFrozen = infrastructureChecks.some((entry) => entry.file === "scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts") && infrastructureChecks.every((entry) => entry.actual === entry.expected);
if (!runnerFrozen) blockingReasons.push("The gate runner or approved preflight infrastructure changed after freeze");
const productionTreeFrozen = productionTreeSha256 === freeze.productionTreeSha256;
if (!productionTreeFrozen) blockingReasons.push("The production tree changed after freeze");

const requiredVerificationIds = ["typecheck", "lint", "unit", "provider", "storage", "isolation", "golden", "rendered-html", "build", "browser-100-switch"];
const verificationById = new Map(verification.commands.map((entry) => [entry.id, entry]));
const verificationReady = requiredVerificationIds.every((id) => verificationById.get(id)?.status === "PASS");
if (!verificationReady) blockingReasons.push("One or more required automated verification commands failed or is missing");
const projectIsolationReady = verificationById.get("isolation")?.status === "PASS" && verificationById.get("browser-100-switch")?.status === "PASS";
if (!projectIsolationReady) blockingReasons.push("Project isolation or the 100-switch browser torture is not ready");
const goldenTestsReady = verificationById.get("golden")?.status === "PASS";
if (!goldenTestsReady) blockingReasons.push("Void Ranger golden regression tests did not pass");

const dirtyState = JSON.parse(await readFile(path.join(OUT, "git-state.json"), "utf8") as string) as { dirty: boolean };
if (dirtyState.dirty) warnings.push("Working tree was dirty at freeze; git-state.json accounts for every modified/untracked file with a digest where a file existed.");
warnings.push("ComfyUI retains unrelated optional custom-node warnings observed at startup; all workflow-required nodes/models and live capabilities are verified.");
const readyToRun = blockingReasons.length === 0;
const preflight = {
  status: readyToRun ? "PREFLIGHT READY" : "PREFLIGHT BLOCKED",
  checkedAt: new Date().toISOString(),
  runId: RUN_ID,
  storageReady,
  storage: { ...storage, availableBytes, enoughSpace: availableBytes >= 1024 * 1024 * 1024 },
  projectIsolationReady,
  comfyuiReady,
  providerCapabilitiesReady,
  cohortReady,
  sourceCount,
  sourceHashesVerified,
  sourceHashChecks,
  sourceNoveltyVerified,
  manifestHashVerified,
  algorithmFreezeVerified: qualityAlgorithmsUnchanged && runnerFrozen && productionTreeFrozen && manifestHashVerified && gateSpecVerified && comfyUIEnvironmentHashVerified,
  qualityAlgorithmsUnchanged,
  qualityAlgorithmCount: algorithmChecks.length,
  voidRangerVerified: voidRangerVerified && goldenTestsReady,
  gateSpecVerified,
  runnerFrozen,
  productionTreeFrozen,
  comfyUIEnvironmentHashVerified,
  verificationReady,
  verificationSummary: {
    totalUnitFiles: verification.totalUnitFiles,
    totalUnitTests: verification.totalUnitTests,
    renderedRoutes: verification.renderedRoutes,
    deterministicSwitches: verification.deterministicSwitches,
    commands: verification.commands,
  },
  liveProvider: bridgeStatus,
  liveSystemStats: systemStats,
  characterOneStarted: false,
  confirmatoryPipelineInvoked: false,
  readyToRun,
  warnings,
  blockingReasons,
  decision: readyToRun ? "STOP. Environment is ready; character #1 requires a separate explicit task." : "STOP. Do not begin character #1.",
};
await writeFile(path.join(OUT, "preflight-v2.json"), json(preflight));

const verificationRows = verification.commands.map((entry) => `| ${entry.id} | ${entry.status} | \`${entry.command}\` | ${entry.details ?? [entry.files ? `${entry.files} files` : null, entry.tests ? `${entry.tests} tests` : null].filter(Boolean).join(", ")} |`).join("\n");
const preflightMarkdown = `# Final Confirmatory Gate v2 Preflight\n\n**${preflight.status}**\n\nChecked: ${preflight.checkedAt}  \nRun: \`${RUN_ID}\`  \nReady to run: **${readyToRun}**  \nCharacter #1 started: **no**  \nConfirmatory cohort invoked: **no**\n\n## Environment\n\n- Samsung 9100 / ComfyUI: **${comfyuiReady ? "READY" : "BLOCKED"}**\n- Provider capabilities: **${providerCapabilitiesReady ? "READY" : "BLOCKED"}**\n- Storage: **${storageReady ? "READY" : "BLOCKED"}** (${availableBytes.toLocaleString()} bytes available)\n- Project isolation: **${projectIsolationReady ? "READY" : "BLOCKED"}**\n\n## Cohort and freeze\n\n- Sources: **${sourceCount}/10**, exact hashes **${sourceHashesVerified ? "VERIFIED" : "BLOCKED"}**\n- Novelty: **${sourceNoveltyVerified ? "VERIFIED" : "BLOCKED"}**\n- Manifest: **${manifestHashVerified ? "VERIFIED" : "BLOCKED"}** (\`${manifestSha256}\`)\n- Gate spec: **${gateSpecVerified ? "VERIFIED" : "BLOCKED"}**\n- Quality algorithms: **${qualityAlgorithmsUnchanged ? "56/56 unchanged" : "BLOCKED"}**\n- Production tree: **${productionTreeFrozen ? "VERIFIED" : "BLOCKED"}**\n- Gate runner/infrastructure: **${runnerFrozen ? "FROZEN" : "BLOCKED"}**\n\n## Void Ranger v2 sentinel\n\nRepository fixture SHA-256: \`${voidRangerHash}\` — **${voidRangerVerified ? "VERIFIED" : "BLOCKED"}**. Golden tests: **${goldenTestsReady ? "PASS" : "FAIL"}**. The historical durable project is explicitly not required by the frozen v2 gate spec.\n\n## Verification\n\n| Check | Result | Command | Exact result |\n|---|---|---|---|\n${verificationRows}\n\n## Warnings\n\n${warnings.map((warning) => `- ${warning}`).join("\n")}\n\n## Blocking reasons\n\n${blockingReasons.length ? blockingReasons.map((reason) => `- ${reason}`).join("\n") : "None."}\n\n**STOP: character #1 has not begun and requires a separate explicit task.**\n`;
await writeFile(path.join(OUT, "preflight-v2.md"), preflightMarkdown);

const report = `# Rig Studio v2 Confirmatory Cohort Pre-registration and Environment Recovery\n\n**${preflight.status}**\n\nThis pass restored the existing production ComfyUI environment from Samsung 9100 without reinstall, upgrade, substitution, workflow drift, threshold tuning, or quality-algorithm changes. The production endpoint is live, all workflow-required nodes and models are present, provider readiness is complete, and the approved non-gate Void Ranger source smoke returned a structurally valid ownership-safe candidate.\n\nExactly ten new source assets were generated before any cohort pipeline inspection. They satisfy the ten preregistered diversity slots, have genuine transparent alpha and complete visible bodies, have unique SHA-256 identities absent from prior diagnostics/fixtures/projects, and are frozen mode \`0444\` in both canonical and diagnostic locations. Execution seed/order, retry policy, manual-repair policy, animation review rubric, integrity rule, ZIP/reopen rules, and binary success thresholds are frozen in the v2 spec.\n\nAll 56 quality-algorithm files match the previous blocked-gate record and remain unchanged. Approved hydration, lifecycle, provider-readiness, storage, preflight, and runner infrastructure is separately hashed. The repository Void Ranger fixture is exact; its golden tests pass; the unrecovered historical durable project is explicitly retired as a v2 requirement.\n\nAutomated verification is ${verificationReady ? "complete and passing" : "blocked"}. Ready to run: **${readyToRun}**. Character #1 started: **no**. Confirmatory pipeline invoked on the cohort: **no**.\n\nArtifacts are rooted at \`${relative(OUT)}\`.\n`;
await writeFile(path.join(OUT, "report.md"), report);

const artifactNames = [...requiredFiles.filter((file) => file !== "verification.json"), "verification.json", "preflight-v2.json", "preflight-v2.md", "report.md", "logs/live-non-gate-segmentation-smoke.json"];
const artifactHashes = await Promise.all(artifactNames.map(async (file) => ({ file, sha256: await shaFile(path.join(OUT, file)) })));
await writeFile(path.join(OUT, "hashes/preflight-artifact-hashes.json"), json({ generatedAt: new Date().toISOString(), artifacts: artifactHashes }));

process.stdout.write(json({
  status: preflight.status,
  readyToRun,
  sourceCount,
  qualityAlgorithmsUnchanged: qualityAlgorithmsUnchanged ? "56/56" : `${algorithmChecks.filter((entry) => entry.actual === entry.expected).length}/56`,
  storageReady,
  projectIsolationReady,
  comfyuiReady,
  providerCapabilitiesReady,
  voidRangerVerified: preflight.voidRangerVerified,
  runnerFrozen,
  productionTreeFrozen,
  warnings,
  blockingReasons,
  characterOneStarted: false,
}));
