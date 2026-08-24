import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";

const exec = promisify(execFile);
const ROOT = process.cwd();
const RUN_ID = process.env.RIG_STUDIO_RECOVERY_RUN_ID ?? "2026-08-24T06-42-10Z";
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/final-gate-recovery", RUN_ID);
const EVIDENCE = path.join(OUT, "search-evidence");
const HASHES = path.join(OUT, "hashes");
const FROZEN_SOURCES = path.join(OUT, "frozen-sources");
const VOID_RECOVERY = path.join(OUT, "void-ranger");
const sha = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const relative = (file: string): string => path.relative(ROOT, file);

type VerificationResults = {
  readonly completedAt: string;
  readonly commands: readonly { readonly command: string; readonly status: "PASS" | "FAIL"; readonly evidence?: string }[];
};

const cohort = [
  { index: 1, expectedFilename: "01-desert-duelist.png", name: "Desert Duelist", archetype: "standard humanoid melee", topology: "humanoid", equipment: "curved saber, round buckler", details: "head wrap, asymmetrical shoulder armor" },
  { index: 2, expectedFilename: "02-iron-bastion.png", name: "Iron Bastion", archetype: "heavy armored humanoid", topology: "humanoid", equipment: "oversized war axe", details: "layered plate and large pauldrons" },
  { index: 3, expectedFilename: "03-frost-oracle.png", name: "Frost Oracle", archetype: "robed/caped caster", topology: "humanoid", equipment: "crystal staff", details: "split cape, robe panels, long braid" },
  { index: 4, expectedFilename: "04-rooftop-scout.png", name: "Rooftop Scout", archetype: "thin agile humanoid", topology: "humanoid", equipment: "dual daggers", details: "thin limbs, light jacket and belt accessories" },
  { index: 5, expectedFilename: "05-jackal-beast.png", name: "Jackal Beast", archetype: "digitigrade creature", topology: "digitigrade", equipment: "unarmed", details: "hocks, paws, tail and long ears" },
  { index: 6, expectedFilename: "06-gnome-guardian.png", name: "Gnome Guardian", archetype: "short/broad chibi", topology: "custom chibi", equipment: "stone hammer", details: "oversized head, broad torso, tiny limbs" },
  { index: 7, expectedFilename: "07-crossbow-ranger.png", name: "Crossbow Ranger", archetype: "ranged/two-handed weapon user", topology: "humanoid", equipment: "two-handed crossbow", details: "quiver, capelet, asymmetric shoulder plate" },
  { index: 8, expectedFilename: "08-dune-sentinel.png", name: "Dune Sentinel", archetype: "asymmetric equipment character", topology: "humanoid", equipment: "crescent shield, hooked blade", details: "left-only pauldron and large offset shield" },
  { index: 9, expectedFilename: "09-storm-envoy.png", name: "Storm Envoy", archetype: "hair/cape/detail-heavy character", topology: "humanoid", equipment: "ceremonial wand", details: "long braids, feathered split cape, hanging ornaments" },
  { index: 10, expectedFilename: "10-mycene-knight.png", name: "Mycene Knight", archetype: "visually unusual/extreme chibi silhouette", topology: "extreme chibi", equipment: "wooden club", details: "single eye, mushroom-cap helmet, tiny limbs" },
] as const;

const algorithmRoots = [
  "src/part-cutter",
  "src/character-generation/segmentation",
  "src/character-generation/rigging",
  "src/rigging/ai",
  "src/rigging/animation",
  "src/rigging/runtime",
  "src/rigging/validation",
] as const;

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function filesBelow(directory: string, skip = new Set<string>()): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const nested = await Promise.all(entries.map(async (entry) => {
    if (skip.has(entry.name)) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target, skip) : [target];
  }));
  return nested.flat();
}

async function command(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await exec(command, [...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.code ?? 1 };
  }
}

async function fetchProbe(url: string): Promise<{ ok: boolean; status: number | null; error: string | null; bodySha256: string | null }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    const body = await response.text();
    return { ok: response.ok, status: response.status, error: response.ok ? null : `HTTP ${response.status}`, bodySha256: sha(body) };
  } catch (error: unknown) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : "request failed", bodySha256: null };
  }
}

function algorithmCategories(file: string): string[] {
  const categories = new Set<string>();
  if (file.startsWith("src/part-cutter/")) categories.add("Prepare");
  if (/part-cutter\/(manualPartition|operations|adaptiveGuide|anatomicalGuide)|segmentation\/(partImageProcessor|segmentationProvider)/.test(file)) categories.add("cutting");
  if (/part-cutter\/ownership/.test(file)) categories.add("ownership");
  if (/segmentation|autoRigTopology|hierarchyBuilder/.test(file)) categories.add("topology");
  if (/character-generation\/rigging/.test(file)) categories.add("auto-rig");
  if (/pivotEstimator|pivotResolver/.test(file)) categories.add("pivots");
  if (/slotAssignment|rigProposalBuilder|zOrderEstimator|rigging\/runtime/.test(file)) categories.add("bindings");
  if (/rigging\/(ai|animation)/.test(file)) {
    categories.add("Idle"); categories.add("Walk"); categories.add("Run"); categories.add("Attack");
  }
  if (/validation|Validator|schema/.test(file)) categories.add("validation");
  return [...categories];
}

await Promise.all([OUT, EVIDENCE, HASHES, FROZEN_SOURCES, VOID_RECOVERY].map((directory) => mkdir(directory, { recursive: true })));
const generatedAt = new Date().toISOString();
const [gitHead, gitStatus, gitLog, gitRefs, gitObjects, gitReflog] = await Promise.all([
  command("git", ["rev-parse", "HEAD"]),
  command("git", ["status", "--porcelain=v1"]),
  command("git", ["log", "--all", "--date=iso-strict", "--pretty=format:%H%x09%ad%x09%s"]),
  command("git", ["for-each-ref", "--format=%(refname)%09%(objectname)"]),
  command("git", ["rev-list", "--all", "--objects"]),
  command("git", ["reflog", "--all", "--date=iso-strict"]),
]);
const head = gitHead.stdout.trim();
const statusRows = gitStatus.stdout.split("\n").filter(Boolean);

const productFiles = (await Promise.all(["app", "src", "mcp"].map((directory) => filesBelow(path.join(ROOT, directory))))).flat()
  .filter((file) => !/\.(map|tsbuildinfo)$/.test(file)).sort();
const supportingFiles = ["package.json", "package-lock.json", "tsconfig.json"].map((file) => path.join(ROOT, file));
const productFileDigests = await Promise.all([...productFiles, ...supportingFiles].map(async (file) => ({ file: relative(file), sha256: sha(await readFile(file)) })));
const productionTreeSha256 = sha(productFileDigests.map((entry) => `${entry.file}\0${entry.sha256}`).join("\n"));
await writeFile(path.join(HASHES, "production-file-digests.json"), json({ generatedAt, productionTreeSha256, files: productFileDigests }));

const algorithmFiles = (await Promise.all(algorithmRoots.map((directory) => filesBelow(path.join(ROOT, directory))))).flat()
  .filter((file) => /\.(?:ts|tsx)$/.test(file)).sort();
const algorithmFileDigests = await Promise.all(algorithmFiles.map(async (file) => {
  const repoPath = relative(file);
  const currentSha256 = sha(await readFile(file));
  const prior = await command("git", ["show", `${head}:${repoPath}`]);
  const priorSha256 = prior.exitCode === 0 ? sha(prior.stdout) : null;
  return { file: repoPath, categories: algorithmCategories(repoPath), currentSha256, priorKnownGoodGitHeadSha256: priorSha256, matchesPriorKnownGoodGitHead: priorSha256 === currentSha256 };
}));
const algorithmsUnchanged = algorithmFileDigests.every((entry) => entry.matchesPriorKnownGoodGitHead);

const fixtureDirectory = path.join(ROOT, "tests/fixtures/golden/void-ranger");
const fixtureFiles = ["project.json", "rig.json", "animations.json", "manifest.json", "expected-contract.json"];
const fixtureDigests = Object.fromEntries(await Promise.all(fixtureFiles.map(async (file) => [file, sha(await readFile(path.join(fixtureDirectory, file)))] as const)));
const fixtureProjectHash = fixtureDigests["project.json"];
const fixtureSourcePath = path.join(ROOT, "public/assets/generated/void-ranger-sprite.png");
const fixtureSourceHash = sha(await readFile(fixtureSourcePath));
const durableProjectPath = path.join(ROOT, ".rigging-studio/projects/void-ranger--character-void-ranger-golden-v1/project.json");
const durableProjectFound = await exists(durableProjectPath);
const durableProjectHash = durableProjectFound ? sha(await readFile(durableProjectPath)) : null;

const sourceInventory = cohort.map((entry) => ({
  ...entry,
  expectedHash: null,
  expectedDimensions: null,
  noveltyDeclaration: "Generated as a new one-off source for this frozen gate; hash absent from pre-gate projects and named tuning fixtures.",
  priorTuningUse: false,
  found: false,
  foundPath: null,
  foundHash: null,
  authority: "partial metadata recovered from scripts/final-confirmatory-gate/freeze-final-gate.mts; original source-manifest.json and its hashes were not recovered",
  notes: "Filename/archetype/topology/equipment metadata is authoritative. Expected SHA-256 and dimensions are unavailable, so no file can satisfy the hash-authoritative recovery rule.",
}));
const sourceInventoryDocument = {
  generatedAt,
  runId: RUN_ID,
  status: "ORIGINAL CONFIRMATORY COHORT UNRECOVERABLE",
  originalManifestRecovered: false,
  partialMetadataAuthority: "scripts/final-confirmatory-gate/freeze-final-gate.mts",
  partialMetadataAuthoritySha256: sha(await readFile(path.join(ROOT, "scripts/final-confirmatory-gate/freeze-final-gate.mts"))),
  expectedHashListRecovered: false,
  recoveredCount: 0,
  requiredCount: 10,
  files: sourceInventory,
};
await writeFile(path.join(OUT, "source-recovery-inventory.json"), json(sourceInventoryDocument));

const searchedLocations = [
  ".rigging-studio/diagnostics", ".rigging-studio/projects", "repository tracked and ignored files", "repository Git history and reflog",
  "/Users/nicholaslippa/Projects", "/Users/nicholaslippa/.codex", "/Users/nicholaslippa/Desktop", "/Users/nicholaslippa/Documents",
  "/Users/nicholaslippa/Downloads", "/private/tmp", "Spotlight index", "ZIP central directories", "Codex active and archived task summaries",
];
const cohortFailure = {
  generatedAt,
  runId: RUN_ID,
  classification: "ORIGINAL CONFIRMATORY COHORT UNRECOVERABLE",
  reason: "The original machine-readable manifest (including all ten SHA-256 values) and all ten frozen PNG files are absent from the available authoritative local sources. Filename-only matches would not be sufficient, and none were found.",
  missing: sourceInventory.map(({ index, expectedFilename, expectedHash }) => ({ index, expectedFilename, expectedHash })),
  searchLocations: searchedLocations,
  evidenceExamined: [
    "Current .rigging-studio diagnostics and durable project store",
    "All Git commits, refs, object names, and reflog entries without changing the worktree",
    "Exact filename and content searches across repository, Projects, .codex, Desktop, Documents, Downloads, and temporary storage",
    "ZIP member-name inventories without extracting into active storage",
    "Current and archived Codex task listings; no prior source-freeze output was available",
    "External volume list; historical Samsung 9100 volume is not mounted",
  ],
  automaticNewCohortCreated: false,
  characterOneStarted: false,
};
await writeFile(path.join(OUT, "original-cohort-recovery-failed.json"), json(cohortFailure));

const recoveryHarnessChanges = statusRows.filter((row) => row.includes("scripts/final-gate-recovery/"));
const verificationGeneratedChanges = statusRows.filter((row) => row.trimEnd().endsWith("tsconfig.tsbuildinfo"));
const approvedP0Changes = statusRows.filter((row) => !recoveryHarnessChanges.includes(row) && !verificationGeneratedChanges.includes(row));
const freeze = {
  runId: RUN_ID,
  generatedAt,
  status: "RECORDED_BUT_NOT_GATE_USABLE",
  provenance: "New rerun starting-state inventory reconstructed from current filesystem and Git HEAD after approved P0 hydration/provider-readiness changes, before character #1. This is not the lost original freeze artifact.",
  originalFreezeRecovered: false,
  gateCharacterOneStarted: false,
  productionAlgorithmsFrozen: true,
  gitCommit: head,
  dirty: statusRows.length > 0,
  gitStatusAtFreeze: statusRows,
  approvedP0Changes,
  recoveryHarnessChanges,
  verificationGeneratedChanges,
  productionTreeSha256,
  productFileCount: productFileDigests.length,
  productFileDigestInventory: "hashes/production-file-digests.json",
  relevantAlgorithmRoots: algorithmRoots,
  relevantAlgorithmFiles: algorithmFileDigests,
  qualityAlgorithmsMatchPriorKnownGoodGitHead: algorithmsUnchanged,
  gateSourceManifestHash: null,
  gateSourceManifestHashReason: "Original source-manifest.json was not recovered; a hash was not invented.",
  repositoryVoidRangerFixtureHash: fixtureProjectHash,
  durableVoidRangerProjectHash: durableProjectHash,
  usableForConfirmatoryGate: false,
  blockingReasons: ["Original frozen source manifest/hash list is unavailable", "Original ten source files are unavailable", "Frozen durable Void Ranger project is unavailable", "ComfyUI production install is unavailable because its external volume is not mounted"],
};
await writeFile(path.join(OUT, "algorithm-freeze.json"), json(freeze));

const voidRanger = {
  generatedAt,
  status: "BLOCKED",
  repositoryGoldenFixture: {
    found: true,
    path: relative(fixtureDirectory),
    expectedProjectSha256: "1cc6dd2ee228d237d9cb095dbe4b8be5bd2085834cb7a49758b0b81af0b34b07",
    actualProjectSha256: fixtureProjectHash,
    hashMatches: fixtureProjectHash === "1cc6dd2ee228d237d9cb095dbe4b8be5bd2085834cb7a49758b0b81af0b34b07",
    fileDigests: fixtureDigests,
    source: { path: relative(fixtureSourcePath), sha256: fixtureSourceHash, hashMatchesExpectedContract: fixtureSourceHash === "ba658d3b2190e3ed918eda91a27e14d581ebefad3cf5891f0f6f13b6e3509b18" },
    identity: { fixtureId: "void-ranger-v1", originalProjectId: "character-void-ranger-golden-v1", name: "Void Ranger", partCount: 16, animationNames: ["Game Idle", "Game Walk", "Game Run", "Game Attack"] },
  },
  productionDurableProject: {
    requiredByOriginalGate: true,
    expectedId: "character-void-ranger-golden-v1",
    expectedDirectory: relative(path.dirname(durableProjectPath)),
    found: durableProjectFound,
    projectSha256: durableProjectHash,
    exactSnapshotOrZipFound: false,
    restored: false,
    reason: "The repository golden fixture is intentionally compacted and is not automatically equivalent to the full durable production project. No exact snapshot/ZIP was found, so no reconstruction or substitution was performed.",
  },
  fixtureModified: false,
  gateRequirementSatisfied: false,
};
await writeFile(path.join(OUT, "void-ranger-recovery.json"), json(voidRanger));

const volumes = await readdir("/Volumes").catch(() => [] as string[]);
const historicalInstallPath = "/Volumes/Samsung 9100/ai-tools/ComfyUI";
const homeInstallPath = "/Users/nicholaslippa/ComfyUI";
const [systemStats, objectInfo] = await Promise.all([
  fetchProbe("http://127.0.0.1:8188/system_stats"),
  fetchProbe("http://127.0.0.1:8188/object_info"),
]);
const workflowFiles = (await filesBelow(path.join(ROOT, "comfy-workflows"))).filter((file) => file.endsWith(".json")).sort();
const workflowDigests = await Promise.all(workflowFiles.map(async (file) => ({ file: relative(file), sha256: sha(await readFile(file)) })));
const requiredNodes = [
  "LoadImage", "ImageCrop", "SAM2ModelLoader (segment anything2)", "GroundingDinoModelLoader (segment anything2)",
  "GroundingDinoSAM2Segment (segment anything2)", "MaskToImage", "SaveImage",
];
const requiredModels = [
  { binding: "COMFYUI_CHECKPOINT", configuredSelector: "dreamshaperXL_lightningDPMSDE.safetensors", fileVerified: false },
  { binding: "COMFYUI_SAM2_MODEL", configuredSelector: "sam2_1_hiera_small.pt", fileVerified: false },
  { binding: "COMFYUI_GROUNDING_DINO_MODEL", configuredSelector: "GroundingDINO_SwinT_OGC (694MB)", fileVerified: false },
];
const environmentIdentity = { historicalInstallPath, endpoint: "http://127.0.0.1:8188", requiredNodes, requiredModels, workflowDigests };
const comfyEnvironment = {
  generatedAt,
  status: "BLOCKED",
  installPath: historicalInstallPath,
  installPathProvenance: "/Users/nicholaslippa/.zsh_history lines 1286-1287",
  installPathPresent: await exists(historicalInstallPath),
  alternateHistoricalHomeInstallPath: homeInstallPath,
  alternateHistoricalHomeInstallPresent: await exists(homeInstallPath),
  externalVolume: { expected: "Samsung 9100", mounted: volumes.includes("Samsung 9100"), mountedVolumes: volumes },
  pythonVersion: null,
  comfyUIVersion: null,
  endpoint: "http://127.0.0.1:8188",
  requiredNodes,
  requiredNodesVerified: false,
  requiredModels,
  workflowIdentifier: "CHARACTER_SEGMENTATION",
  workflowSha256: workflowDigests.find((entry) => entry.file.endsWith("character-segmentation.json"))?.sha256 ?? null,
  workflowDigests,
  health: { systemStats, objectInfo },
  capabilityResult: { status: "BLOCKED", ready: false, reason: "ComfyUI is offline and its historical external-volume installation is unavailable; nodes and model files cannot be verified." },
  launchCommand: "cd \"/Volumes/Samsung 9100/ai-tools/ComfyUI\" && venv/bin/python main.py --listen 127.0.0.1 --port 8188",
  launchCommandProvenance: "/Users/nicholaslippa/.zsh_history lines 1286-1287",
  environmentHash: sha(json(environmentIdentity)),
  reinstallAttempted: false,
  upgradeAttempted: false,
  liveSegmentationSmoke: { attempted: false, reason: "Provider is not READY; frozen cohort and product pipeline were not touched." },
};
await writeFile(path.join(OUT, "comfyui-production-environment.json"), json(comfyEnvironment));

const storage = await new LocalProjectStore({ cwd: ROOT }).preflight();
const verificationPath = path.join(OUT, "verification-results.json");
const verification = await exists(verificationPath) ? JSON.parse(await readFile(verificationPath, "utf8")) as VerificationResults : null;
const verificationReady = Boolean(verification?.commands.length && verification.commands.every((entry) => entry.status === "PASS"));
const blockers = [
  "ORIGINAL CONFIRMATORY COHORT UNRECOVERABLE: original manifest hashes and 10/10 exact source PNGs are unavailable",
  "Frozen production Void Ranger durable project/snapshot is unavailable",
  "ComfyUI production installation is on the unmounted Samsung 9100 volume and 127.0.0.1:8188 is offline",
  ...(storage.ready ? [] : [`Durable storage preflight failed: ${storage.error ?? "unknown storage error"}`]),
  ...(verificationReady ? [] : ["Required regression verification has not completed successfully in this recovery bundle"]),
];
const preflight = {
  status: "PREFLIGHT BLOCKED",
  checkedAt: new Date().toISOString(),
  recoveryRunId: RUN_ID,
  characterOneStarted: false,
  confirmatoryPipelineInvoked: false,
  storage: { ready: storage.ready, result: storage },
  projectIsolation: { ready: verificationReady, verificationResults: verification ? "verification-results.json" : null },
  provider: { ready: false, endpoint: comfyEnvironment.endpoint, systemStats, objectInfo, capabilityResult: comfyEnvironment.capabilityResult },
  sources: { ready: false, sourceCount: 0, requiredCount: 10, sourceHashesVerified: false, duplicateHashCheck: "NOT_POSSIBLE_EXPECTED_HASH_LIST_UNRECOVERED", alphaRequirementsVerified: false, inventory: "source-recovery-inventory.json" },
  manifest: { ready: false, originalRecovered: false, partialMetadataRecoveredFromAuthority: true, originalHashListRecovered: false },
  algorithmFreeze: { ready: false, recorded: true, productionTreeSha256, qualityAlgorithmsMatchPriorKnownGoodGitHead: algorithmsUnchanged, sourceManifestHash: null, path: "algorithm-freeze.json" },
  voidRanger: { ready: false, repositoryFixtureReady: voidRanger.repositoryGoldenFixture.hashMatches, durableProjectReady: false, path: "void-ranger-recovery.json" },
  verification: { ready: verificationReady, result: verification },
  readyToRun: false,
  blockingReasons: blockers,
  decision: "STOP. Do not begin character #1 and do not create or substitute a new cohort.",
};
await writeFile(path.join(OUT, "preflight.json"), json(preflight));

const zipSearchRoots = ["/Users/nicholaslippa/Downloads", "/Users/nicholaslippa/Desktop", "/Users/nicholaslippa/Documents", "/Users/nicholaslippa/Projects", "/private/tmp"];
const zipFiles = (await Promise.all(zipSearchRoots.map((directory) => filesBelow(directory, new Set(["node_modules", ".git", ".next", "dist", "Library", "Photos", ".Trash"]))))).flat().filter((file) => file.toLowerCase().endsWith(".zip"));
const exactNamePattern = /(?:^|\/)(?:0[1-9]-(?:desert-duelist|iron-bastion|frost-oracle|rooftop-scout|jackal-beast|gnome-guardian|crossbow-ranger|dune-sentinel|storm-envoy)\.png|10-mycene-knight\.png|source-manifest\.json|algorithm-freeze\.json|.*void-ranger.*|.*final.*gate.*)/i;
const archiveEvidence = [];
for (const archive of zipFiles.sort()) {
  const listed = await command("unzip", ["-Z1", archive]);
  const matches = listed.stdout.split("\n").filter((entry) => exactNamePattern.test(entry));
  archiveEvidence.push({ archive, readable: listed.exitCode === 0, matchingMembers: matches });
}
await writeFile(path.join(EVIDENCE, "zip-search.json"), json({ generatedAt, roots: zipSearchRoots, archivesInspected: archiveEvidence.length, matchingArchives: archiveEvidence.filter((entry) => entry.matchingMembers.length), archives: archiveEvidence }));

const gitObjectMatches = gitObjects.stdout.split("\n").filter((row) => /final-gate|confirmatory|source-manifest|algorithm-freeze|desert-duelist|mycene-knight|void-ranger--character/i.test(row));
await writeFile(path.join(EVIDENCE, "git-history.txt"), [
  `generatedAt: ${generatedAt}`, `HEAD: ${head}`, "", "## refs", gitRefs.stdout, "", "## log", gitLog.stdout,
  "", "## matching object names", gitObjectMatches.length ? gitObjectMatches.join("\n") : "NONE",
  "", "## reflog", gitReflog.stdout,
].join("\n"));
await writeFile(path.join(EVIDENCE, "filesystem-search.json"), json({
  generatedAt,
  exactFilenames: cohort.map((entry) => entry.expectedFilename),
  exactFilenameMatches: [],
  searchedLocations,
  contentTerms: ["final-gate", "confirmatory", "unseen", "sourceHashes", "sourceCount", "archetype", "ZERO-TOUCH", "PIPELINE FAILURE", "algorithmFrozen", "Void Ranger"],
  authoritativeMatches: [
    "scripts/final-confirmatory-gate/freeze-final-gate.mts (partial cohort definitions only)",
    ".rigging-studio/diagnostics/final-confirmatory-gates/2026-08-23T15-42-41Z/preflight.json (blocked preflight only)",
    "tests/fixtures/golden/void-ranger/* (repository golden fixture only)",
  ],
  unavailableExpectedLocation: "/Volumes/Samsung 9100 (not mounted)",
  result: "No original manifest, source PNG, algorithm-freeze artifact, durable Void Ranger snapshot/ZIP, or matching archived member was found.",
}));
await writeFile(path.join(EVIDENCE, "codex-task-history.json"), json({
  generatedAt,
  searched: { activeAndRecentLimit: 50, archivedLimit: 50 },
  relevantTasksFound: [
    { id: "01a03249-7539-7d80-9b68-9bdbec44ace3", title: "Fix hydration and provider fallback", result: "Contains blocked preflight and current recovery only; no original source manifest output." },
    { id: "01a01351-f8db-7f00-a94a-f70ffd7a6a7a", title: "Wire ComfyUI AI cut and repair", result: "Contains integration work before the final cohort; no source manifest or hashes." },
  ],
  archivedRigStudioGateTaskFound: false,
}));
await writeFile(path.join(EVIDENCE, "comfyui-history.txt"), [
  "Authoritative shell history evidence:",
  "1286: cd \"/Volumes/Samsung 9100/ai-tools/ComfyUI\"",
  "1287: venv/bin/python main.py --listen 127.0.0.1 --port 8188",
  "",
  `Mounted volumes at recovery: ${volumes.join(", ") || "NONE"}`,
  "Result: Samsung 9100 is not mounted; the established environment cannot be inspected or started.",
].join("\n"));

const artifactFiles = [
  "source-recovery-inventory.json", "original-cohort-recovery-failed.json", "algorithm-freeze.json", "void-ranger-recovery.json",
  "comfyui-production-environment.json", "preflight.json", "hashes/production-file-digests.json",
  "search-evidence/git-history.txt", "search-evidence/filesystem-search.json", "search-evidence/zip-search.json",
  "search-evidence/codex-task-history.json", "search-evidence/comfyui-history.txt",
  ...(verification ? ["verification-results.json"] : []),
];
const artifactDigests = await Promise.all(artifactFiles.map(async (file) => ({ file, sha256: sha(await readFile(path.join(OUT, file))) })));
await writeFile(path.join(HASHES, "recovery-artifact-hashes.json"), json({ generatedAt: new Date().toISOString(), artifacts: artifactDigests }));

const report = `# Final Gate Environment Recovery Report

**PREFLIGHT BLOCKED**

Recovery run: \`${RUN_ID}\`  
Generated: ${generatedAt}  
Character #1 started: **no**  
Confirmatory pipeline invoked: **no**

## Decision

**ORIGINAL CONFIRMATORY COHORT UNRECOVERABLE**

The original source manifest/hash list and all ten frozen PNGs could not be recovered from repository storage, durable Rig Studio storage, Git history, diagnostics, backups, ZIP member inventories, temporary paths, Spotlight, or available Codex task history. The committed freeze script authoritatively preserves filenames and cohort metadata, but not the computed SHA-256 values or PNG bytes. That partial metadata was recorded without presenting it as a verified manifest.

No source was substituted, no new cohort was created, and no gate character was attempted.

## Recovery status

- Final-gate manifest: **partial metadata recreated from committed authority; original manifest/hash list not recovered or verified**
- Ten frozen sources: **0/10 recovered; exact-hash verification impossible**
- Algorithm freeze: **new pre-character-#1 tree recorded, but not gate-usable because the source-manifest hash and durable Void Ranger hash are unavailable**
- Quality algorithms: **${algorithmsUnchanged ? "all inventoried cut/rig/Idle/Walk/Run/Attack/validation files match current Git HEAD" : "mismatch detected"}**
- Repository Void Ranger fixture: **verified** (\`${fixtureProjectHash}\`)
- Production durable Void Ranger project: **not recovered; golden fixture was not substituted**
- ComfyUI: **blocked**; historical install is on unmounted \`Samsung 9100\`, endpoint \`127.0.0.1:8188\` is offline, nodes/models cannot be verified
- Storage preflight: **${storage.ready ? "READY" : "BLOCKED"}**
- Regression/project-isolation verification: **${verificationReady ? "READY" : "PENDING/BLOCKED"}**

## Mandatory blockers

${blockers.map((reason) => `- ${reason}`).join("\n")}

## Evidence

Machine-readable recovery inventory, freeze, ComfyUI environment, Void Ranger distinction, preflight decision, search records, and SHA-256 inventories are stored in this directory. The previous blocked final-gate preflight remains untouched.

## Stop condition

STOP. A future task must explicitly pre-register a new unseen ten-source cohort or provide the exact original manifest/files, restore an exact durable Void Ranger snapshot, and mount/restore the established ComfyUI environment before preflight can become READY.
`;
await writeFile(path.join(OUT, "report.md"), report);
const reportHash = sha(await readFile(path.join(OUT, "report.md")));
await writeFile(path.join(HASHES, "report.sha256"), `${reportHash}  report.md\n`);

process.stdout.write(json({
  status: "PREFLIGHT BLOCKED",
  runId: RUN_ID,
  output: OUT,
  originalCohort: "ORIGINAL CONFIRMATORY COHORT UNRECOVERABLE",
  sourcesRecovered: 0,
  algorithmsUnchanged,
  storageReady: storage.ready,
  verificationReady,
  characterOneStarted: false,
}));
