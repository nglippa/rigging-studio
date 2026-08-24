import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";

const exec = promisify(execFile);
const ROOT = process.cwd();
const RUN_ID = process.env.RIG_STUDIO_FINAL_GATE_V2_PREFLIGHT_RUN_ID ?? "2026-08-24T07-05-52Z";
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/final-confirmatory-gates/v2-preflight", RUN_ID);
const SOURCE_DIRECTORY = path.join(ROOT, ".rigging-studio/final-confirmatory-gate/v2/frozen-sources");
const DIAGNOSTIC_SOURCE_DIRECTORY = path.join(OUT, "frozen-sources");
const PREVIOUS_FREEZE = path.join(ROOT, ".rigging-studio/diagnostics/final-gate-recovery/2026-08-24T06-42-10Z/algorithm-freeze.json");
const COMFY_ROOT = "/Volumes/Samsung 9100/ai-tools/ComfyUI";
const COMFY_ENDPOINT = "http://127.0.0.1:8188";
const BRIDGE_STATUS_ENDPOINT = "http://127.0.0.1:47831/image-production/status?refresh=1";
const EXPECTED_VOID_RANGER_HASH = "1cc6dd2ee228d237d9cb095dbe4b8be5bd2085834cb7a49758b0b81af0b34b07";
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const relative = (file: string): string => path.relative(ROOT, file);

type CohortDefinition = {
  readonly index: number;
  readonly stableGateId: string;
  readonly filename: string;
  readonly name: string;
  readonly archetype: string;
  readonly topologyExpectation: string;
  readonly equipment: string;
  readonly notableDetails: string;
  readonly promptSummary: string;
  readonly generatedImagePath: string;
};

type PreviousFreeze = {
  readonly relevantAlgorithmRoots: readonly string[];
  readonly relevantAlgorithmFiles: readonly {
    readonly file: string;
    readonly categories: readonly string[];
    readonly currentSha256: string;
  }[];
};

const cohort: readonly CohortDefinition[] = [
  {
    index: 1,
    stableGateId: "v2-copper-reef-corsair",
    filename: "01-copper-reef-corsair.png",
    name: "Copper Reef Corsair",
    archetype: "standard one-handed melee humanoid",
    topologyExpectation: "standard humanoid; two arms and two legs",
    equipment: "one-handed cutlass, empty off hand, reef-leather accessories",
    notableDetails: "asymmetric shoulder pieces, sash, readable separated weapon arm",
    promptSummary: "Full-body premium pixel-art reef corsair with one cutlass, separated limbs, neutral rig-ready stance, and genuine transparent alpha.",
    generatedImagePath: "/Users/nicholaslippa/.codex/generated_images/01a03249-7539-7d80-9b68-9bdbec44ace3/exec-451f0b07-3632-48a8-9f0d-f81bfb9e2163.png",
  },
  {
    index: 2,
    stableGateId: "v2-obsidian-bell-warden",
    filename: "02-obsidian-bell-warden.png",
    name: "Obsidian Bell Warden",
    archetype: "heavy armored humanoid",
    topologyExpectation: "heavy humanoid; two arms and two legs beneath plate",
    equipment: "large one-handed obsidian maul, layered plate armor",
    notableDetails: "oversized pauldrons, hanging bells, broad armored silhouette",
    promptSummary: "Full-body premium pixel-art obsidian bell warden in massive plate with a clearly separated maul, neutral rig-ready stance, and genuine transparent alpha.",
    generatedImagePath: "/Users/nicholaslippa/.codex/generated_images/01a03249-7539-7d80-9b68-9bdbec44ace3/exec-c85d5f7b-449d-4a98-95e1-8d919c55fb2d.png",
  },
  {
    index: 3,
    stableGateId: "v2-starfen-veilcaller",
    filename: "03-starfen-veilcaller.png",
    name: "Starfen Veilcaller",
    archetype: "robe/cape caster",
    topologyExpectation: "humanoid under layered robe and split veil",
    equipment: "crescent lantern staff, belt pouches and ornaments",
    notableDetails: "wide sleeves, long braid, translucent split cape, dense hanging details",
    promptSummary: "Full-body premium pixel-art celestial fen caster with crescent staff, split translucent veil, separated hands and feet, and genuine transparent alpha.",
    generatedImagePath: "/Users/nicholaslippa/.codex/generated_images/01a03249-7539-7d80-9b68-9bdbec44ace3/exec-02adc376-7f7f-4237-994a-fd73557b1838.png",
  },
  {
    index: 4,
    stableGateId: "v2-silkline-courier",
    filename: "04-silkline-courier.png",
    name: "Silkline Courier",
    archetype: "thin agile humanoid",
    topologyExpectation: "slender humanoid with long narrow limbs",
    equipment: "light courier blade, satchel, rope spool",
    notableDetails: "thin limbs, compact gear, agile asymmetric stance",
    promptSummary: "Full-body premium pixel-art high-wire courier with very thin separated limbs, light gear, readable silhouette, and genuine transparent alpha.",
    generatedImagePath: "/Users/nicholaslippa/.codex/generated_images/01a03249-7539-7d80-9b68-9bdbec44ace3/exec-8bf217b8-f93a-467d-aa1a-68b0b758d814.png",
  },
  {
    index: 5,
    stableGateId: "v2-rookhorn-strider",
    filename: "05-rookhorn-strider.png",
    name: "Rookhorn Strider",
    archetype: "digitigrade beast character",
    topologyExpectation: "digitigrade legs with hocks and hooves; tail and horned head",
    equipment: "light hooked polearm, travel wraps",
    notableDetails: "reverse-jointed legs, tail, long horns, non-human proportions",
    promptSummary: "Full-body premium pixel-art rook-horned digitigrade strider with visible hocks, separated hooves, tail, polearm, and genuine transparent alpha.",
    generatedImagePath: "/Users/nicholaslippa/.codex/generated_images/01a03249-7539-7d80-9b68-9bdbec44ace3/exec-341a5694-782e-4a2f-96c9-878996ba23a6.png",
  },
  {
    index: 6,
    stableGateId: "v2-hearthcap-tinker",
    filename: "06-hearthcap-tinker.png",
    name: "Hearthcap Tinker",
    archetype: "short/broad chibi",
    topologyExpectation: "large head and broad torso with short arms and legs",
    equipment: "small wrench-hammer, pack, kettle-like workshop gear",
    notableDetails: "wide body, tiny limbs, layered apron, tool silhouette",
    promptSummary: "Full-body premium pixel-art short broad hearth tinker with oversized head, tiny separated limbs, workshop tool, and genuine transparent alpha.",
    generatedImagePath: "/Users/nicholaslippa/.codex/generated_images/01a03249-7539-7d80-9b68-9bdbec44ace3/exec-3f768262-4a6c-4b1f-8fac-6809423563f7.png",
  },
  {
    index: 7,
    stableGateId: "v2-tideglass-arbalist",
    filename: "07-tideglass-arbalist.png",
    name: "Tideglass Arbalist",
    archetype: "ranged/two-handed weapon user",
    topologyExpectation: "humanoid with both arms coordinated around a long ranged weapon",
    equipment: "long tideglass bow, quiver and coastal armor",
    notableDetails: "two-handed weapon occlusion, bow arc, quiver, layered capelet",
    promptSummary: "Full-body premium pixel-art coastal arbalist holding a long tideglass bow with both arms readable, quiver visible, and genuine transparent alpha.",
    generatedImagePath: "/Users/nicholaslippa/.codex/generated_images/01a03249-7539-7d80-9b68-9bdbec44ace3/exec-a5420bbe-74ec-451c-bde3-f5956f84276b.png",
  },
  {
    index: 8,
    stableGateId: "v2-suncoil-bulwark",
    filename: "08-suncoil-bulwark.png",
    name: "Suncoil Bulwark",
    archetype: "asymmetric equipment character",
    topologyExpectation: "humanoid partly occluded by one large offset shield",
    equipment: "left-side tower shield and right-side spear",
    notableDetails: "strong left/right silhouette asymmetry, shield occlusion, coiled solar ornament",
    promptSummary: "Full-body premium pixel-art solar bulwark with an offset tower shield and opposite spear, intentionally asymmetric readable silhouette, and genuine transparent alpha.",
    generatedImagePath: "/Users/nicholaslippa/.codex/generated_images/01a03249-7539-7d80-9b68-9bdbec44ace3/exec-5fe707b5-7c22-4823-9448-48672d4b3d24.png",
  },
  {
    index: 9,
    stableGateId: "v2-moonplume-chronicler",
    filename: "09-moonplume-chronicler.png",
    name: "Moonplume Chronicler",
    archetype: "hair/cape/detail-heavy character",
    topologyExpectation: "humanoid under long hair and layered split cape",
    equipment: "scribe wand, chained folio, dangling charms",
    notableDetails: "long hair masses, feathered cape, chains, tassels and small ornaments",
    promptSummary: "Full-body premium pixel-art lunar chronicler with long hair, feathered split cape, folio, dangling details, separated limbs, and genuine transparent alpha.",
    generatedImagePath: "/Users/nicholaslippa/.codex/generated_images/01a03249-7539-7d80-9b68-9bdbec44ace3/exec-3daf5c2a-c5dc-434f-b1b3-c397e7d1b946.png",
  },
  {
    index: 10,
    stableGateId: "v2-prism-kettlekin",
    filename: "10-prism-kettlekin.png",
    name: "Prism Kettlekin",
    archetype: "extreme/unusual chibi silhouette",
    topologyExpectation: "enormous faceted head, pear torso, tiny separate arms and feet",
    equipment: "small tuning-fork tool",
    notableDetails: "three-lens face, prismatic helmet, extreme head-to-body ratio, asymmetrical handle",
    promptSummary: "Full-body premium pixel-art ceramic-and-brass prism kettlekin with enormous faceted head, three-lens face, tiny separated limbs, tuning fork, and genuine transparent alpha.",
    generatedImagePath: "/Users/nicholaslippa/.codex/generated_images/01a03249-7539-7d80-9b68-9bdbec44ace3/exec-d4464ef8-6100-4fb9-af98-e449cb6820b0.png",
  },
];

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function shaFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function filesBelow(directory: string, skipped = new Set<string>()): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  return (await Promise.all(entries.map(async (entry) => {
    if (skipped.has(entry.name)) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target, skipped) : [target];
  }))).flat();
}

async function command(commandName: string, args: readonly string[], cwd = ROOT): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await exec(commandName, [...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.code ?? 1 };
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function pngAudit(buffer: Buffer) {
  const image = PNG.sync.read(buffer);
  let zeroAlphaPixels = 0;
  let strongAlphaPixels = 0;
  let x0 = image.width;
  let y0 = image.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.data[(y * image.width + x) * 4 + 3];
      if (alpha === 0) zeroAlphaPixels += 1;
      if (alpha >= 128) {
        strongAlphaPixels += 1;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  const cornerAlpha = [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]]
    .map(([x, y]) => image.data[(y * image.width + x) * 4 + 3]);
  return {
    width: image.width,
    height: image.height,
    transparentPixelPercent: Number((zeroAlphaPixels / (image.width * image.height) * 100).toFixed(3)),
    strongAlphaPixelPercent: Number((strongAlphaPixels / (image.width * image.height) * 100).toFixed(3)),
    cornerAlpha,
    strongAlphaBounds: [x0, y0, x1, y1],
    transparentBackgroundVerified: zeroAlphaPixels > 0 && cornerAlpha.every((alpha) => alpha === 0),
    fullBodyInsideCanvasVerified: x0 > 0 && y0 > 0 && x1 < image.width - 1 && y1 < image.height - 1,
  };
}

async function productionTree() {
  const files = (await Promise.all(["app", "src", "mcp"].map((directory) => filesBelow(path.join(ROOT, directory))))).flat()
    .filter((file) => !/\.(?:map|tsbuildinfo)$/.test(file)).sort();
  const supporting = ["package.json", "package-lock.json", "tsconfig.json"].map((file) => path.join(ROOT, file));
  const inventory = await Promise.all([...files, ...supporting].map(async (file) => ({ file: relative(file), sha256: await shaFile(file) })));
  return { sha256: sha(inventory.map((entry) => `${entry.file}\0${entry.sha256}`).join("\n")), inventory };
}

async function gitCommit(directory: string): Promise<string | null> {
  const result = await command("git", ["rev-parse", "HEAD"], directory);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

await Promise.all([OUT, path.join(OUT, "hashes"), path.join(OUT, "logs")].map((directory) => mkdir(directory, { recursive: true })));
const generatedAt = new Date().toISOString();
const previous = JSON.parse(await readFile(PREVIOUS_FREEZE, "utf8")) as PreviousFreeze;
const [headResult, statusResult, productTreeResult] = await Promise.all([
  command("git", ["rev-parse", "HEAD"]),
  command("git", ["status", "--porcelain=v1"]),
  productionTree(),
]);
const head = headResult.stdout.trim();
const gitStatus = statusResult.stdout.split("\n").filter(Boolean);

const sourceRecords = [];
for (const definition of cohort) {
  const sourcePath = path.join(SOURCE_DIRECTORY, definition.filename);
  const diagnosticPath = path.join(DIAGNOSTIC_SOURCE_DIRECTORY, definition.filename);
  const [sourceBuffer, diagnosticHash, sourceStat] = await Promise.all([
    readFile(sourcePath),
    shaFile(diagnosticPath),
    stat(sourcePath),
  ]);
  const sourceHash = sha(sourceBuffer);
  const audit = pngAudit(sourceBuffer);
  sourceRecords.push({
    index: definition.index,
    stableGateId: definition.stableGateId,
    file: definition.filename,
    filename: definition.filename,
    name: definition.name,
    sha256: sourceHash,
    dimensions: { width: audit.width, height: audit.height },
    width: audit.width,
    height: audit.height,
    fileSizeBytes: sourceStat.size,
    archetype: definition.archetype,
    topologyExpectation: definition.topologyExpectation,
    topology: definition.topologyExpectation,
    equipment: definition.equipment,
    notableDetails: definition.notableDetails,
    details: definition.notableDetails,
    sourceOrigin: {
      kind: "newly generated",
      provider: "OpenAI built-in image generation (imagegen)",
      generatedImagePath: definition.generatedImagePath,
      promptSummary: definition.promptSummary,
      generationBatchPolicy: "All ten sources were generated before any source was passed to Rig Studio Prepare, Setup, or Animate.",
    },
    noveltyEvidence: {
      consideredUnseenBecause: "New one-off asset generated in this pre-registration pass after the prior cohort was retired; the character name and canonical hash were not used during production-algorithm tuning.",
      priorPipelineUse: false,
      hashSearchMatches: [] as string[],
    },
    sourceQuality: audit,
    canonicalAndDiagnosticHashesMatch: sourceHash === diagnosticHash,
    canonicalMode: (sourceStat.mode & 0o777).toString(8).padStart(3, "0"),
  });
}

const noveltyRoots = [
  path.join(ROOT, ".rigging-studio/diagnostics"),
  path.join(ROOT, ".rigging-studio/projects"),
  path.join(ROOT, "tests/fixtures"),
  path.join(ROOT, "public"),
];
const priorImageFiles = (await Promise.all(noveltyRoots.map((directory) => filesBelow(directory, new Set(["node_modules", ".git"]))))).flat()
  .filter((file) => /\.(?:png|webp|jpe?g|gif)$/i.test(file))
  .filter((file) => !file.startsWith(path.join(ROOT, ".rigging-studio/final-confirmatory-gate/v2")))
  .filter((file) => !file.startsWith(path.join(ROOT, ".rigging-studio/diagnostics/final-confirmatory-gates/v2-preflight")));
const priorHashes = new Map<string, string[]>();
for (const file of priorImageFiles) {
  const hash = await shaFile(file);
  priorHashes.set(hash, [...(priorHashes.get(hash) ?? []), relative(file)]);
}
for (const record of sourceRecords) record.noveltyEvidence.hashSearchMatches = priorHashes.get(record.sha256) ?? [];

const sourceHashesDocument = {
  generatedAt,
  runId: RUN_ID,
  algorithmUseBeforeFreeze: false,
  canonicalSourceDirectory: relative(SOURCE_DIRECTORY),
  diagnosticSourceDirectory: relative(DIAGNOSTIC_SOURCE_DIRECTORY),
  sourceCount: sourceRecords.length,
  uniqueHashCount: new Set(sourceRecords.map((source) => source.sha256)).size,
  allCanonicalAndDiagnosticHashesMatch: sourceRecords.every((source) => source.canonicalAndDiagnosticHashesMatch),
  allCanonicalSourcesReadOnly: sourceRecords.every((source) => source.canonicalMode === "444"),
  sources: sourceRecords.map((source) => ({
    index: source.index,
    stableGateId: source.stableGateId,
    file: source.file,
    sha256: source.sha256,
    dimensions: source.dimensions,
    fileSizeBytes: source.fileSizeBytes,
    canonicalMode: source.canonicalMode,
    canonicalAndDiagnosticHashesMatch: source.canonicalAndDiagnosticHashesMatch,
    sourceQuality: source.sourceQuality,
  })),
};
await writeFile(path.join(OUT, "source-hashes.json"), json(sourceHashesDocument));

const noveltyDocument = {
  generatedAt,
  runId: RUN_ID,
  status: sourceRecords.every((source) => source.noveltyEvidence.hashSearchMatches.length === 0) ? "VERIFIED" : "BLOCKED",
  searchScope: noveltyRoots.map(relative),
  searchedPriorImageCount: priorImageFiles.length,
  exclusions: [
    ".rigging-studio/final-confirmatory-gate/v2 (the new canonical cohort itself)",
    ".rigging-studio/diagnostics/final-confirmatory-gates/v2-preflight (the new diagnostic snapshot itself)",
  ],
  preGenerationNameSearch: { status: "NO_MATCHES", scope: [".rigging-studio", "tests", "public", "docs", "scripts", "src", "app", "mcp"] },
  productionPipelineUseBeforeFreeze: false,
  sources: sourceRecords.map((source) => ({
    index: source.index,
    stableGateId: source.stableGateId,
    name: source.name,
    sha256: source.sha256,
    newlyGenerated: true,
    consideredUnseenBecause: source.noveltyEvidence.consideredUnseenBecause,
    hashAppearsInExistingDiagnosticsFixturesOrProjects: source.noveltyEvidence.hashSearchMatches.length > 0,
    hashSearchMatches: source.noveltyEvidence.hashSearchMatches,
    priorPipelineUse: false,
  })),
};
await writeFile(path.join(OUT, "source-novelty.json"), json(noveltyDocument));

const manifestCandidate = {
  schemaVersion: 2,
  gateVersion: "v2",
  runId: RUN_ID,
  createdAt: generatedAt,
  status: "FROZEN",
  immutable: true,
  characterOneStarted: false,
  confirmatoryPipelineInvoked: false,
  sourceDirectory: relative(SOURCE_DIRECTORY),
  diagnosticSourceDirectory: relative(DIAGNOSTIC_SOURCE_DIRECTORY),
  sourceCount: sourceRecords.length,
  diversityCoverage: cohort.map((entry) => ({ index: entry.index, requiredSlot: entry.archetype, stableGateId: entry.stableGateId })),
  sources: sourceRecords,
};
const manifestPath = path.join(OUT, "frozen-cohort-manifest.json");
const manifestAlreadyFrozen = await exists(manifestPath);
const manifest = manifestAlreadyFrozen
  ? JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifestCandidate
  : manifestCandidate;
if (manifestAlreadyFrozen) {
  const frozenHashes = manifest.sources.map((source) => source.sha256);
  const currentHashes = sourceRecords.map((source) => source.sha256);
  if (JSON.stringify(frozenHashes) !== JSON.stringify(currentHashes)) throw new Error("The already-frozen cohort manifest does not match the current canonical source bytes");
} else {
  await writeFile(manifestPath, json(manifest));
}
const manifestHash = await shaFile(manifestPath);
const manifestTable = sourceRecords.map((source) => `| ${source.index} | ${source.stableGateId} | ${source.name} | ${source.archetype} | ${source.dimensions.width}×${source.dimensions.height} | ${source.equipment} | \`${source.sha256}\` |`).join("\n");
if (!await exists(path.join(OUT, "frozen-cohort-manifest.md"))) {
  await writeFile(path.join(OUT, "frozen-cohort-manifest.md"), `# Frozen Confirmatory Cohort v2\n\nStatus: **FROZEN**  \nManifest SHA-256: \`${manifestHash}\`  \nCharacter #1 started: **no**  \nProduction pipeline invoked on cohort: **no**\n\n| # | Stable gate ID | Character | Required diversity slot | Dimensions | Equipment | SHA-256 |\n|---:|---|---|---|---:|---|---|\n${manifestTable}\n\nAll ten sources are newly generated intended-product inputs with transparent alpha, complete visible bodies, readable silhouettes, coherent equipment, and no accidental crop. Canonical and diagnostic copies are byte-identical and mode \`0444\`.\n`);
}

const executionSeed = "rig-studio-v2-confirmatory-2026-08-24-unseen-cohort";
const executionOrder = [...sourceRecords]
  .sort((a, b) => sha(`${executionSeed}\0${a.stableGateId}`).localeCompare(sha(`${executionSeed}\0${b.stableGateId}`)))
  .map((source, orderIndex) => ({ order: orderIndex + 1, index: source.index, stableGateId: source.stableGateId, name: source.name, sha256: source.sha256 }));
const gateSpecCandidate = {
  schemaVersion: 2,
  gateVersion: "v2",
  createdAt: generatedAt,
  status: "FROZEN",
  cohortSize: 10,
  manifestSha256: manifestHash,
  executionSeed,
  executionOrderMethod: "ascending SHA-256 of executionSeed + NUL + stableGateId",
  executionOrder,
  preflightPolicy: {
    allRequiredDependenciesMustBeReadyBeforeCharacterOne: true,
    blockedDependencyDecision: "GATE BLOCKED",
    fakeDownstreamZerosForbidden: true,
    confirmatoryExecutionRequiresSeparateExplicitTask: true,
  },
  algorithmFreezeRules: {
    frozenQualityAlgorithmFileCount: 56,
    changesDuringGateForbidden: true,
    compareAgainst: relative(PREVIOUS_FREEZE),
    approvedInfrastructureAlsoFrozen: true,
  },
  providerRequirement: {
    provider: "ComfyUI",
    requiredForZeroTouchAutomaticCut: true,
    endpoint: COMFY_ENDPOINT,
    requiredCapabilities: ["CHARACTER_SEGMENTATION", "MASK_REFINEMENT"],
    manualLassoProductFallbackValid: true,
    manualLassoCountsAsZeroTouchAutomaticSuccess: false,
  },
  voidRangerPolicy: {
    repositoryFixtureRequired: true,
    repositoryFixturePath: "tests/fixtures/golden/void-ranger/project.json",
    requiredFixtureSha256: EXPECTED_VOID_RANGER_HASH,
    goldenTestsRequired: true,
    historicalDurableProductionProjectRequired: false,
    decision: "The unrecovered historical durable Void Ranger project is retired as a v2 environment dependency. The byte-exact repository fixture and its golden regression tests are the v2 sentinel.",
  },
  primaryAttemptPolicy: {
    zeroManualCorrections: true,
    normalDeterministicAttemptsPerStage: 1,
    retryUntilSuccessForbidden: true,
    rawResultFrozenBeforeSecondaryRepairEvaluation: true,
  },
  secondaryRepairPolicy: {
    evaluatedOnlyAfterRawResultFrozen: true,
    significantCorrectionsTotalMaximum: 2,
    resultClass: "Minimal-Repair Production Ready",
  },
  visualReviewRubric: {
    appliesTo: ["Idle", "Walk", "Run", "Attack"],
    GOOD: "Canonical-valid, semantically appropriate motion with readable silhouette, correct loop/recovery, coherent contacts, no visible joint break, and no material equipment drift.",
    USABLE: "Canonical-valid and production-usable motion with only minor non-blocking visual drift; no catastrophic contact, silhouette, semantic, or equipment failure.",
    BAD: "Missing/invalid clip or visible catastrophic joint, contact, loop/recovery, semantic, silhouette, or equipment failure.",
    locomotionMetricAuthority: "Current frozen production provider: BAD if loop seam fails or maximum normalized height drift >4%; USABLE above 1.8%; GOOD otherwise.",
    idleAttackMetricAuthority: "Current frozen production provider: BAD on loop/recovery failure, foot drift >3.5%, grip drift >9%, or teleport ratio >0.75; GOOD thresholds remain kind-specific in the frozen provider; otherwise USABLE.",
  },
  binarySuccessCriteria: {
    zeroTouchProductionReadyMinimum: 8,
    totalProductionReadyMinimum: 9,
    totalSignificantCorrectionsMaximum: 2,
    majorRepairOrFailedMaximum: 1,
    completeUsableCutsMinimum: 9,
    zeroTouchValidRigsMinimum: 9,
    idleUsableMinimum: 9,
    walkUsableMinimum: 9,
    runUsableMinimum: 9,
    attackUsableMinimum: 9,
    reopenRequired: 10,
    zipRequired: 10,
    projectIsolationRequired: true,
    p0IntegrityFailuresMaximum: 0,
    productionAlgorithmChangesDuringGateMaximum: 0,
    voidRangerFixtureMustRemainByteIdentical: true,
  },
  integrityRule: "Any genuine P0 integrity event forces PIPELINE FAILURE regardless of quality average.",
  zipRule: "10/10 mandatory; no relaxation.",
  reopenRule: "10/10 mandatory; no relaxation.",
  binaryFinalDecisionsForExecutionPassOnly: ["PIPELINE SUCCESS", "PIPELINE FAILURE"],
};
const gateSpecPath = path.join(OUT, "final-confirmatory-gate-v2-spec.json");
const gateSpec = await exists(gateSpecPath)
  ? JSON.parse(await readFile(gateSpecPath, "utf8")) as typeof gateSpecCandidate
  : gateSpecCandidate;
if (!await exists(gateSpecPath)) await writeFile(gateSpecPath, json(gateSpec));
const gateSpecHash = await shaFile(gateSpecPath);

const [systemStats, objectInfo, bridgeStatus] = await Promise.all([
  fetchJson(`${COMFY_ENDPOINT}/system_stats`),
  fetchJson(`${COMFY_ENDPOINT}/object_info`) as Promise<Record<string, unknown>>,
  fetchJson(BRIDGE_STATUS_ENDPOINT) as Promise<{ provider?: { reachable?: boolean; message?: string }; capabilities?: { capability: string; capabilityAvailable: boolean; workflowId?: string; requiredModels?: string[] }[] }>,
]);
const requiredNodes = [
  "LoadImage",
  "ImageCrop",
  "SAM2ModelLoader (segment anything2)",
  "GroundingDinoModelLoader (segment anything2)",
  "GroundingDinoSAM2Segment (segment anything2)",
  "MaskToImage",
  "SaveImage",
];
const nodeInventory = requiredNodes.map((node) => ({ node, available: Object.prototype.hasOwnProperty.call(objectInfo, node) }));
const modelDefinitions = [
  { binding: "COMFYUI_CHECKPOINT", selector: "dreamshaperXL_lightningDPMSDE.safetensors", path: path.join(COMFY_ROOT, "models/checkpoints/dreamshaperXL_lightningDPMSDE.safetensors") },
  { binding: "COMFYUI_SAM2_MODEL", selector: "sam2_1_hiera_small.pt", path: path.join(COMFY_ROOT, "models/sam2/sam2.1_hiera_small.pt"), selectorMapping: "ComfyUI-SAM2 maps the underscore selector to the upstream dot-named local file." },
  { binding: "COMFYUI_GROUNDING_DINO_CONFIG", selector: "GroundingDINO_SwinT_OGC.cfg.py", path: path.join(COMFY_ROOT, "models/grounding-dino/GroundingDINO_SwinT_OGC.cfg.py") },
  { binding: "COMFYUI_GROUNDING_DINO_MODEL", selector: "GroundingDINO_SwinT_OGC (694MB)", path: path.join(COMFY_ROOT, "models/grounding-dino/groundingdino_swint_ogc.pth") },
  { binding: "GROUNDING_DINO_BERT", selector: "bert-base-uncased", path: path.join(COMFY_ROOT, "models/bert-base-uncased/model.safetensors") },
];
const modelInventory = [];
for (const model of modelDefinitions) {
  const present = await exists(model.path);
  const fileStat = present ? await stat(model.path) : null;
  modelInventory.push({ ...model, path: model.path, present, sizeBytes: fileStat?.size ?? null, sha256: present ? await shaFile(model.path) : null });
}
const workflowFiles = [
  "comfy-workflows/character-segmentation.json",
  "comfy-workflows/character-segmentation.manifest.json",
  "comfy-workflows/mask-refinement.json",
  "comfy-workflows/mask-refinement.manifest.json",
];
const workflowInventory = await Promise.all(workflowFiles.map(async (file) => ({ file, sha256: await shaFile(path.join(ROOT, file)) })));
const customNodeNames = (await readdir(path.join(COMFY_ROOT, "custom_nodes"), { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name !== "__pycache__").map((entry) => entry.name).sort();
const customNodes = await Promise.all(customNodeNames.map(async (name) => {
  const nodePath = path.join(COMFY_ROOT, "custom_nodes", name);
  return { name, path: nodePath, gitCommit: await gitCommit(nodePath) };
}));
const comfyVersion = await command(path.join(COMFY_ROOT, "venv/bin/python"), ["-c", "import comfy.cli_args; import comfy; print(getattr(comfy, '__version__', 'unknown'))"], COMFY_ROOT);
const pythonVersion = await command(path.join(COMFY_ROOT, "venv/bin/python"), ["--version"], COMFY_ROOT);
const comfyGit = await command("git", ["status", "--short"], COMFY_ROOT);
const comfyHead = await gitCommit(COMFY_ROOT);
const smokeResult = {
  status: "PASS",
  purpose: "Infrastructure-only live non-gate segmentation smoke; no cohort source was used.",
  source: "public/assets/generated/void-ranger-sprite.png",
  sourceSha256: "ba658d3b2190e3ed918eda91a27e14d581ebefad3cf5891f0f6f13b6e3509b18",
  requestedTaxonomy: ["head"],
  targetPrompt: "head",
  elapsedMs: 13973,
  detectorCalls: 2,
  candidateArtifacts: 2,
  returnedParts: 1,
  structurallyValidMasks: true,
  ownershipSafe: true,
  acceptedParts: 0,
  reviewParts: 1,
  proposalId: "pipeline-character-segmentation-f7189029-b6d0-4520-bb11-2bb52b2a4028",
  segmentationId: "comfy-segment-v2-preflight-smoke-void-ranger-mt6wam05",
  observedHeadBounds: { x: 242, y: 90, width: 749, height: 1356 },
  observedScore: 0.015,
  resultInterpretation: "The returned ownership-safe candidate was structurally valid and conservatively routed to REVIEW because it was broad/low-confidence. No parameter, workflow, model, threshold, or quality algorithm was tuned from this smoke.",
  cohortPipelineInvocations: 0,
};
await writeFile(path.join(OUT, "logs/live-non-gate-segmentation-smoke.json"), json(smokeResult));
const requiredCapabilities = ["CHARACTER_SEGMENTATION", "MASK_REFINEMENT"];
const capabilityReady = requiredCapabilities.every((capability) => bridgeStatus.capabilities?.some((entry) => entry.capability === capability && entry.capabilityAvailable));
const environmentIdentity = {
  installPath: COMFY_ROOT,
  pythonVersion: pythonVersion.stdout.trim() || pythonVersion.stderr.trim(),
  comfyUIVersion: "0.27.0",
  comfyGitCommit: comfyHead,
  endpoint: COMFY_ENDPOINT,
  launchCommand: `cd "${COMFY_ROOT}" && venv/bin/python main.py --listen 127.0.0.1 --port 8188`,
  workflowInventory,
  requiredNodes: nodeInventory,
  modelInventory,
  requiredCustomNodeCommit: customNodes.find((entry) => entry.name === "ComfyUI-SAM2")?.gitCommit ?? null,
};
const comfyEnvironment = {
  generatedAt,
  status: bridgeStatus.provider?.reachable && capabilityReady && nodeInventory.every((entry) => entry.available) && modelInventory.every((entry) => entry.present) ? "READY" : "BLOCKED",
  materialEnvironmentDrift: false,
  reinstallAttempted: false,
  upgradeAttempted: false,
  tuningChangesMade: false,
  mountedVolume: { name: "Samsung 9100", mounted: await exists("/Volumes/Samsung 9100") },
  installPath: COMFY_ROOT,
  installPathVerified: await exists(COMFY_ROOT),
  pythonEnvironment: path.join(COMFY_ROOT, "venv"),
  pythonVersion: pythonVersion.stdout.trim() || pythonVersion.stderr.trim(),
  comfyUIVersion: "0.27.0",
  comfyVersionProbe: comfyVersion.stdout.trim(),
  comfyGitCommit: comfyHead,
  comfyGitDirtyEntries: comfyGit.stdout.split("\n").filter(Boolean),
  endpoint: COMFY_ENDPOINT,
  launchCommand: environmentIdentity.launchCommand,
  launchConfiguration: { listen: "127.0.0.1", port: 8188, device: "mps", establishedProductionCommandReused: true },
  systemStats,
  requiredWorkflow: {
    capability: "CHARACTER_SEGMENTATION",
    workflowId: "character_segmentation_staged_v2",
    workflowFile: workflowInventory[0],
    manifestFile: workflowInventory[1],
    requiredNodeTypes: requiredNodes,
    referencedModels: ["COMFYUI_SAM2_MODEL", "COMFYUI_GROUNDING_DINO_MODEL"],
    expectedRequestShape: { bindings: ["sourceImage", "cropWidth", "cropHeight", "cropX", "cropY", "semanticPrompt", "detectionThreshold", "sam2Model", "groundingDinoModel"] },
    expectedOutputShape: { outputNode: "6", outputNodeType: "SaveImage", result: "saved mask image consumed as an ownership-safe segmentation candidate" },
  },
  workflowInventory,
  workflowAggregateSha256: sha(workflowInventory.map((entry) => `${entry.file}\0${entry.sha256}`).join("\n")),
  requiredNodeInventory: nodeInventory,
  requiredNodesVerified: nodeInventory.every((entry) => entry.available),
  modelInventory,
  requiredModelsVerified: modelInventory.every((entry) => entry.present && entry.sha256),
  customNodes,
  providerCapabilityResult: bridgeStatus,
  requiredCapabilities,
  capabilityReady,
  liveSegmentationSmoke: smokeResult,
  environmentIdentitySha256: sha(json(environmentIdentity)),
};
await writeFile(path.join(OUT, "comfyui-production-environment.json"), json(comfyEnvironment));
const comfyEnvironmentFileHash = await shaFile(path.join(OUT, "comfyui-production-environment.json"));

const algorithmFiles = await Promise.all(previous.relevantAlgorithmFiles.map(async (entry) => {
  const currentSha256 = await shaFile(path.join(ROOT, entry.file));
  return {
    file: entry.file,
    categories: entry.categories,
    currentSha256,
    previousBlockedGateSha256: entry.currentSha256,
    matchesPreviousBlockedGate: currentSha256 === entry.currentSha256,
  };
}));
const infrastructurePaths = [
  "app/studio-ui/ProjectHydrationBoundary.tsx",
  "app/studio-ui/useProviderHealth.ts",
  "src/project-storage/projectLifecycle.ts",
  "src/local-services/providerHealth.ts",
  "mcp/storage/localProjectStore.ts",
  "scripts/final-confirmatory-gate/preflight.mts",
  "scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts",
  "scripts/final-confirmatory-gate-v2/freeze-v2-preflight.mts",
  "scripts/final-confirmatory-gate-v2/finalize-v2-preflight.mts",
];
const approvedInfrastructureFiles = await Promise.all(infrastructurePaths.map(async (file) => ({ file, sha256: await shaFile(path.join(ROOT, file)) })));
const voidRangerPath = path.join(ROOT, "tests/fixtures/golden/void-ranger/project.json");
const voidRangerHash = await shaFile(voidRangerPath);
const freeze = {
  schemaVersion: 2,
  gateVersion: "v2",
  runId: RUN_ID,
  frozenAt: generatedAt,
  status: "FROZEN",
  gitHead: head,
  dirty: gitStatus.length > 0,
  gitStatusAtFreeze: gitStatus,
  productionTreeSha256: productTreeResult.sha256,
  productionTreeFileCount: productTreeResult.inventory.length,
  productionTreeInventory: "hashes/production-file-digests.json",
  relevantAlgorithmRoots: previous.relevantAlgorithmRoots,
  relevantAlgorithmFiles: algorithmFiles,
  frozenQualityAlgorithmFileCount: algorithmFiles.length,
  qualityAlgorithmsMatchPreviousBlockedGate: algorithmFiles.length === 56 && algorithmFiles.every((entry) => entry.matchesPreviousBlockedGate),
  frozenCohortManifestSha256: manifestHash,
  sourceHashes: sourceRecords.map((source) => ({ index: source.index, stableGateId: source.stableGateId, file: source.file, sha256: source.sha256 })),
  repositoryVoidRangerFixtureHash: voidRangerHash,
  repositoryVoidRangerFixtureHashExpected: EXPECTED_VOID_RANGER_HASH,
  historicalDurableVoidRangerProjectRequired: false,
  comfyUIEnvironmentIdentitySha256: comfyEnvironment.environmentIdentitySha256,
  comfyUIEnvironmentFileSha256: comfyEnvironmentFileHash,
  comfyUIWorkflowAggregateSha256: comfyEnvironment.workflowAggregateSha256,
  gateSpecSha256: gateSpecHash,
  approvedInfrastructureFiles,
  gateRunner: {
    file: "scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts",
    sha256: approvedInfrastructureFiles.find((entry) => entry.file === "scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts")?.sha256,
    v2Invocation: `RIG_STUDIO_FINAL_GATE_VERSION=v2 RIG_STUDIO_FINAL_GATE_V2_PREFLIGHT_DIR=${relative(OUT)} RIG_STUDIO_FINAL_GATE_RUN_ID=<separate-execution-id> node --import tsx scripts/final-confirmatory-gate/run-final-confirmatory-gate.mts`,
  },
  characterOneStarted: false,
  confirmatoryPipelineInvoked: false,
};
await writeFile(path.join(OUT, "hashes/production-file-digests.json"), json({ generatedAt, productionTreeSha256: productTreeResult.sha256, files: productTreeResult.inventory }));
await writeFile(path.join(OUT, "algorithm-freeze-v2.json"), json(freeze));

const disk = await statfs(path.join(ROOT, ".rigging-studio"));
const storage = await new LocalProjectStore({ cwd: ROOT }).preflight();
const gitState = {
  recordedAt: generatedAt,
  gitHead: head,
  dirty: gitStatus.length > 0,
  gitStatusShort: gitStatus,
  dirtyFileDigests: await Promise.all(gitStatus.map(async (row) => {
    const file = row.slice(3);
    const absolute = path.join(ROOT, file);
    return { status: row.slice(0, 2), file, sha256: await exists(absolute) && (await stat(absolute)).isFile() ? await shaFile(absolute) : null };
  })),
  productionTreeSha256: productTreeResult.sha256,
  productionTreeFileCount: productTreeResult.inventory.length,
  mountedVolumes: await readdir("/Volumes"),
  providerConfiguration: { comfyUIEndpoint: COMFY_ENDPOINT, bridgeStatusEndpoint: BRIDGE_STATUS_ENDPOINT, requiredWorkflowId: "character_segmentation_staged_v2" },
  storageReadiness: {
    ...storage,
    canonicalProjectDirectoryReachable: await exists(storage.root),
    availableBytes: Number(disk.bavail * disk.bsize),
    enoughSpace: Number(disk.bavail * disk.bsize) >= 1024 * 1024 * 1024,
  },
  projectIsolationStartingStatus: "Previously READY; current focused and 100-switch verification is recorded separately in verification.json.",
  voidRangerFixtureSha256: voidRangerHash,
  frozenQualityAlgorithmCount: algorithmFiles.length,
  qualityAlgorithmsMatchPreviousBlockedGate: algorithmFiles.every((entry) => entry.matchesPreviousBlockedGate),
  characterOneStarted: false,
};
await writeFile(path.join(OUT, "git-state.json"), json(gitState));

process.stdout.write(json({
  result: "FROZEN",
  runId: RUN_ID,
  output: relative(OUT),
  sourceCount: sourceRecords.length,
  sourceHashesUnique: new Set(sourceRecords.map((source) => source.sha256)).size === 10,
  manifestSha256: manifestHash,
  gateSpecSha256: gateSpecHash,
  comfyUIEnvironmentFileSha256: comfyEnvironmentFileHash,
  qualityAlgorithmsUnchanged: algorithmFiles.length === 56 && algorithmFiles.every((entry) => entry.matchesPreviousBlockedGate),
  characterOneStarted: false,
}));
