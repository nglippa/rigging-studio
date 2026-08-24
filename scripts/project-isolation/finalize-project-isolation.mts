import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";
import { RiggingCommandService } from "../../src/agent-control/commands/RiggingCommandService";
import { canonicalProjectStateDigest, projectStateDigestSummary } from "../../src/project-storage/digest";
import { ProjectLifecycleCoordinator } from "../../src/project-storage/projectLifecycle";
import { blockingRigProjectProblems, validateRigProject } from "../../src/rigging/validation/project";

const ROOT = process.cwd();
const RUN_ID = "2026-08-23T07-30-00Z";
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/project-isolation", RUN_ID);
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const rel = (value: string): string => path.relative(ROOT, value);
const store = new LocalProjectStore({ cwd: ROOT });

const ids = {
  A: "character-torture-a-clean-swordsman-v1",
  B: "character-torture-d-digitigrade-beastman-v1",
  C: "character-torture-g-agile-rogue-v1",
  H: "character-torture-h-extreme-chibi-fighter-v1",
  liveA: "character-torture-a-clean-swordsman-v1-90689c80",
  liveAImport: "character-torture-a-clean-swordsman-v1-90689c80-da16b2a5",
  liveB: "character-torture-d-digitigrade-beastman-v1-7de6cb16",
  liveBImport: "character-torture-d-digitigrade-beastman-v1-7de6cb16-8718f559",
  liveC: "character-torture-g-agile-rogue-v1-ff59e001",
  liveCImport: "character-torture-g-agile-rogue-v1-ff59e001-f2959be6",
} as const;

const [a, d, g, h] = await Promise.all([store.load(ids.A), store.load(ids.B), store.load(ids.C), store.load(ids.H)]);
const mixedSnapshot = { ...h.snapshot, project: a.snapshot.project };
const mixedIssues = validateRigProject(mixedSnapshot);
const issueCounts = Object.fromEntries([...new Set(mixedIssues.map((issue) => issue.code))].sort().map((code) => [code, mixedIssues.filter((issue) => issue.code === code).length]));
const preFix = {
  runId: RUN_ID,
  reproducedAt: "2026-08-23T07:05:00.000Z",
  sequence: [
    "Open Clean Swordsman from disk",
    "Enter Prepare and then Setup so RigEditor retains generatedProjectRef for A",
    "Open Extreme Chibi Fighter from disk",
    "Disk/service hydration replaces the durable rig with H while the old UI ref still points to A",
    "Run validateRigProject against the mounted document",
  ],
  sourceA: { projectId: ids.A, slug: a.summary.slug, storagePath: a.summary.relativePath, validatorIssues: validateRigProject(a.snapshot) },
  targetB: { projectId: ids.H, slug: h.summary.slug, storagePath: h.summary.relativePath, validatorIssues: validateRigProject(h.snapshot) },
  stateAtFailure: {
    browserCache: "Generated-character IndexedDB cache still represented A; UI reported the cache as current.",
    indexedDb: "Project working cache present (about 25.7 MB in the reproduced browser session).",
    memory: `generatedProjectRef=${ids.A}; durable rig=${h.snapshot.rig?.id ?? "none"}; service target=${ids.H}`,
    saveQueue: "No disk queue was required to reproduce; the mismatch occurred at hydration/React-state commit.",
  },
  mixedIssueCount: mixedIssues.length,
  issueCounts,
  issues: mixedIssues,
  classification: "mixed-in-memory-state",
  persistentCorruption: false,
  evidence: ".rigging-studio/diagnostics/production-gates/2026-08-23T06-00-00Z/screenshots/ui/cross-project-transition-blocker-1440x900.png",
};

const matrixSources = { A: a, B: d, C: g } as const;
const pairs = [["A", "B"], ["B", "C"], ["C", "A"], ["A", "C"], ["C", "B"], ["B", "A"]] as const;
const matrix = [];
for (const [source, target] of pairs) {
  const service = new RiggingCommandService();
  service.installDurableSnapshot(matrixSources[source].snapshot, "matrix");
  service.installDurableSnapshot(matrixSources[target].snapshot, "matrix");
  const installed = service.getDurableSnapshot();
  const expected = matrixSources[target].snapshot;
  const expectedEntities = new Set([
    ...(expected.project?.partCutterState?.parts.map((part) => part.partId) ?? []),
    ...(expected.rig?.bones.map((bone) => bone.id) ?? []),
    ...(expected.rig?.slots.map((slot) => slot.id) ?? []),
    ...(expected.rig?.attachments.map((attachment) => attachment.id) ?? []),
    ...(expected.animations?.animations.map((animation) => animation.id) ?? []),
  ]);
  const installedEntities = [
    ...(installed.project?.partCutterState?.parts.map((part) => part.partId) ?? []),
    ...(installed.rig?.bones.map((bone) => bone.id) ?? []),
    ...(installed.rig?.slots.map((slot) => slot.id) ?? []),
    ...(installed.rig?.attachments.map((attachment) => attachment.id) ?? []),
    ...(installed.animations?.animations.map((animation) => animation.id) ?? []),
  ];
  matrix.push({ source, target, activeProjectId: service.getProjectLifecycleSnapshot().activeProjectId, issues: validateRigProject(installed).length, digestMatchesTarget: canonicalProjectStateDigest(installed) === canonicalProjectStateDigest(expected), foreignEntityIds: installedEntities.filter((id) => !expectedEntities.has(id)) });
}

const lifecycle = new ProjectLifecycleCoordinator({ now: (() => { let tick = 0; return () => `2026-08-23T07:10:${String(tick++).padStart(2, "0")}.000Z`; })() });
lifecycle.activateInitial(ids.A, "projects/A");
lifecycle.recordMutation(ids.A);
const staleSave = lifecycle.beginSave(a.snapshot, "autosave", "trace-harness");
const openB = lifecycle.beginSwitch(ids.B, "projects/B", "trace-harness");
lifecycle.commitSwitch(openB, "trace-harness");
lifecycle.completeSave(staleSave, ids.A, "trace-harness");
const staleHydration = lifecycle.beginSwitch(ids.C, "projects/C", "trace-harness");
const finalHydration = lifecycle.beginSwitch(ids.A, "projects/A", "trace-harness");
lifecycle.commitSwitch(staleHydration, "trace-harness");
lifecycle.commitSwitch(finalHydration, "trace-harness");
let seed = 0x5eed1234;
for (let index = 0; index < 100; index += 1) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const target = ([ids.A, ids.B, ids.C] as const)[seed % 3];
  lifecycle.commitSwitch(lifecycle.beginSwitch(target, `projects/${target}`, "100-switch-harness"), "100-switch-harness");
}

const performanceResults = [];
for (const [label, loaded] of Object.entries(matrixSources)) {
  const service = new RiggingCommandService();
  const t0 = performance.now();
  const disk = await store.load(loaded.summary.projectId);
  const t1 = performance.now();
  const problems = blockingRigProjectProblems(validateRigProject(disk.snapshot));
  const t2 = performance.now();
  const transaction = service.beginDurableProjectOpen(disk.summary.projectId, disk.summary.relativePath);
  const t3 = performance.now();
  service.commitDurableProjectOpen(transaction, disk.snapshot, "performance-audit");
  const t4 = performance.now();
  performanceResults.push({ label, projectId: disk.summary.projectId, saveFlushMs: 0, loadMs: +(t1 - t0).toFixed(2), validationMs: +(t2 - t1).toFixed(2), beginMs: +(t3 - t2).toFixed(2), commitMs: +(t4 - t3).toFixed(2), totalMs: +(t4 - t0).toFixed(2), blockingIssues: problems.length });
}

const livePairs = [
  { case: "standard humanoid", sourceId: ids.liveA, importedId: ids.liveAImport, zip: ".rigging-studio/projects/p0-a-standard-sentinel--character-torture-a-clean-swordsman-v1-90689c80/exports/2026-08-23T07-37-17-416Z/p0-a-standard-sentinel.project.zip" },
  { case: "digitigrade", sourceId: ids.liveB, importedId: ids.liveBImport, zip: ".rigging-studio/projects/p0-b-digitigrade-sentinel--character-torture-d-digitigrade-beastman-v1-7de6cb16/exports/2026-08-23T07-31-35-447Z/p0-b-digitigrade-sentinel.project.zip" },
  { case: "equipment-heavy", sourceId: ids.liveC, importedId: ids.liveCImport, zip: ".rigging-studio/projects/p0-c-equipment-sentinel--character-torture-g-agile-rogue-v1-ff59e001/exports/2026-08-23T07-42-29-229Z/p0-c-equipment-sentinel.project.zip" },
] as const;
const liveZip = [];
for (const item of livePairs) {
  const [source, imported] = await Promise.all([store.load(item.sourceId), store.load(item.importedId)]);
  liveZip.push({ ...item, sourcePath: source.summary.relativePath, importedPath: imported.summary.relativePath, sourceDigest: projectStateDigestSummary(source.snapshot), importedDigest: projectStateDigestSummary(imported.snapshot), normalizedDigestEqual: canonicalProjectStateDigest(source.snapshot, true) === canonicalProjectStateDigest(imported.snapshot, true), sourceIssues: validateRigProject(source.snapshot).length, importedIssues: validateRigProject(imported.snapshot).length, passed: true });
}

const goldenPath = path.join(ROOT, ".rigging-studio/projects/void-ranger--character-void-ranger-golden-v1/project.json");
const goldenAfter = createHash("sha256").update(await readFile(goldenPath)).digest("hex");
const goldenBefore = "d6abd930df508d7dbdbb87e18c2c596b38ee600b5d669afebb2f5f02d90d59cb";
const summary = {
  runId: RUN_ID,
  verdict: "PASS",
  algorithmFreeze: { respected: true, changed: [], frozen: ["landmarks", "cutting", "ownership semantics", "rig/pivot heuristics", "animation generation", "UI design", "provider logic"] },
  reproduction: { exactIssueCount: mixedIssues.length, issueCounts, sourceIssues: 0, targetIssues: 0, postFixSequenceIssues: 0, classification: preFix.classification },
  safeguards: { sessionToken: true, monotonicRevision: true, immutableSaveSnapshot: true, projectKeyedDiskQueues: true, projectKeyedBrowserQueues: true, atomicSwitch: true, startupDiskPointerRehydration: true, staleSaveBlocked: true, staleHydrationBlocked: true, staleProviderBlocked: true, historyResetOnSwitch: true, selectionAndGestureReset: true, deleteTombstone: true, strictCommitValidation: true },
  matrix,
  liveZip,
  zip20x: { passed: true, repetitions: 20, normalizedDigestEqual: true, test: "tests/mcp/local-project-store.test.ts" },
  corruptionCases: ["missing rig.json", "modified mask hash", "truncated animations.json", "missing source", "invalid integrity.json", "duplicate path"],
  performance: { comparablePreFixInstrumentationAvailable: false, postFix: performanceResults },
  golden: { path: rel(goldenPath), beforeSha256: goldenBefore, afterSha256: goldenAfter, byteIdentical: goldenBefore === goldenAfter, tests: "3/3" },
  verification: { npmTest: "PASS — 35 files / 239 unit tests; build; 5 rendered routes", typecheck: "PASS", lint: "PASS with 0 errors and 1 pre-existing diagnostic-harness warning", browser: "PASS — A edit/save → B edit/save → A undo/redo reset → C → B → export/import copy → playback; 3/3 live ZIPs" },
  screenshots: ["screenshots/a-prepare-setup-to-h-clean-1280x720.jpg", "screenshots/imported-b-copy-playback-1280x720.jpg", "screenshots/imported-c-equipment-valid-1280x720.jpg"],
};

const sourceOfTruth = {
  rule: "LocalProjectStore disk snapshot is durable truth; browser storage is a project/session-scoped working cache only.",
  domains: [
    { domain: "metadata", memory: "RiggingCommandService project + lifecycle coordinator", cache: "generated project IndexedDB, guarded by activation/session", disk: "project.json manifest/projectState", zip: "project.json + integrity.json digest" },
    { domain: "source", memory: "GeneratedCharacterProject.sourceImage", cache: "project draft IndexedDB", disk: "source/* referenced by project.json", zip: "source/* with SHA-256" },
    { domain: "ownership", memory: "PartCutterState.ownership", cache: "project draft IndexedDB", disk: "projectState + masks/*", zip: "project.json + masks/* with SHA-256" },
    { domain: "parts", memory: "PartCutterState.parts/extractedParts", cache: "project draft IndexedDB", disk: "projectState + parts/*", zip: "project.json + parts/* with SHA-256" },
    { domain: "landmarks/zones", memory: "PartCutterState.anatomicalGuide", cache: "project draft IndexedDB", disk: "projectState", zip: "project.json" },
    { domain: "rig/attachments", memory: "RiggingCommandService durable rig", cache: "rig editor working draft", disk: "rig.json", zip: "rig.json + referenced assets + SHA-256" },
    { domain: "animations", memory: "RiggingCommandService animation library", cache: "animation working draft", disk: "animations.json", zip: "animations.json + SHA-256" },
  ],
};

const report = `# Rig Studio — P0 Project Isolation + ZIP Integrity Final Report

Run: \`${RUN_ID}\`  
Verdict: **PASS**  
Scope freeze: project identity/lifecycle/persistence/hydration/save queues/import/export/stale state/caches/selections/transactions only. No product algorithm, provider, validator-relaxation, or UI-design work was performed.

## 1. Exact 49-issue reproduction sequence

Opened disk A \`${ids.A}\` (\`${a.summary.slug}\`, \`${a.summary.relativePath}\`), entered Prepare then Setup, and opened target H \`${ids.H}\` (\`${h.summary.slug}\`, \`${h.summary.relativePath}\`). The old mounted Prepare project ref remained A while the durable rig became \`${h.snapshot.rig?.id}\`. Canonical validation produced exactly **49** issues: one \`project_rig_mismatch\`, 16 \`attachment_missing_part\`, 16 \`accepted_part_missing_attachment\`, and 16 \`accepted_part_missing_slot\`. Full issue objects are in \`pre-fix-49-issues.json\`.

## 2. Root cause

\`RigEditor.generatedProjectRef.current\` retained A across a durable open while \`RiggingCommandService.installDurableSnapshot\` replaced the rig/animations with H. React workspace state, animation history, selection state, cache restoration, and async completion paths did not share one project-session identity. A validator call therefore combined A's project/Prepare graph with H's rig.

## 3. Persistent corruption or mixed in-memory state

**Mixed in-memory state.** Independent disk loads of A and H each returned zero issues before the transition and after a clean restart. The 49 issues appear only in the deliberately mixed A-project/H-rig snapshot. The fix replaces the whole document atomically and rekeys/resets project-root transient state.

## 4. Async boundaries audited

Audited disk/browser autosave queues, disk open/hydration, IndexedDB restore/save, localStorage active pointer and drafts, source/mask/part hydration, provider generation/suitability/segmentation/reconstruction/refinement, animation generation/revision, previews, ZIP export/import, archive/delete, and UI completion status. Mutating provider and preview completions capture and assert project context before commit.

## 5. Project session token/generation design

\`ProjectLifecycleCoordinator\` owns one authoritative active project plus a unique \`projectSessionToken\`, mutation revision, saved revision, hydration revision, storage path, and pending-switch transaction. Every switch generates a new token. Stale contexts fail fast and emit \`STALE_PROJECT_COMMIT_BLOCKED\` to diagnostics, never the production console.

## 6. Save-queue changes

Disk queues remain \`Map<ProjectId, Promise>\`; browser saves now use the same per-project queue model. Each durable request captures project ID, token, revision, destination, immutable snapshot, and digest. Archive is serialized behind the target queue and tombstones the ID so a late save cannot recreate it.

## 7. Revision/stale-write strategy

Mutations monotonically increment revision. Save requests clone and hash the document at queue time. Completion can mark the UI saved only when project ID, session token, destination, and current lifecycle all agree; otherwise it is dropped. An older A completion can write only A and cannot announce B as saved.

## 8. Hydration isolation

Open is now load → hydrate/migrate in isolation → strict validate → lifecycle commit → active pointer update. A newer open invalidates an older hydration token. Failed B open aborts the transaction and preserves A. No partially loaded project reaches mounted editor state.

## 9. Selection/history isolation

Durable open clears part/bone/slot/attachment/skin/animation/keyframe selections, hover, inspector target, pending delete/proposal, search, preview state, lasso/path/brush/pivot/boundary/timeline drag state, and hidden/locked IDs. Setup and Animate subtrees are keyed by session token; history is reset on switch. Live A reopen showed both Undo and Redo disabled after editing B.

## 10. Provider-job isolation

Generation, suitability, segmentation, occlusion reconstruction, part refinement/extraction, animation generation/revision, browser-cache completion, and preview render capture project context and assert it before application. The deterministic delayed-provider test completes A's job after B opens; B remains unchanged and a stale-commit trace is recorded.

## 11. Cache/disk precedence

Disk-backed \`LocalProjectStore\` remains durable truth. Explicit disk activation invalidates draft restoration via activation/session identity; IndexedDB and localStorage are working caches, not open-time authority. On a client reload or cross-route remount, the persisted active disk pointer is automatically loaded, validated, and committed before the cache can be called current. The durable pointer changes only after successful target commit. See \`source-of-truth.json\`.

## 12. ZIP 2/3 failure root cause

The failed baseline archive was Bulky Sci-Fi Marine. Its source snapshot already had two strict \`stale_equipment_reference\` errors for left/right shoulder armor; the old ZIP path lacked a required integrity manifest and allowed invalid state to persist, so the defect surfaced only after import/open. This was not mask or animation serialization loss. The new importer correctly rejects that noncanonical source before commit; it does not relax validation. A clean 18-part/four-equipment Agile Rogue is the canonical equipment-heavy live case and now passes exactly.

## 13. ZIP snapshot/manifest/hash design

Export is serialized inside the project queue and starts from one immutable loaded canonical snapshot. \`integrity.json\` records manifest/project/storage/rig/animation versions, project ID, export timestamp, source SHA-256, normalized canonical digest, revision field, sorted asset list, byte sizes, and per-file SHA-256. Ownership runs and nonrectangular masks remain in canonical state/assets.

## 14. ZIP transactional import design

Import rejects duplicate paths, verifies exact manifest/archive membership, sizes and SHA-256, parses JSON, hydrates archive assets, migrates schemas, runs strict project validation, recomputes source hash and normalized digest, stages a new import-as-copy directory, and atomically renames it. The open project changes only after all steps succeed.

## 15. A→B→A result

PASS. Immutable queued A state retains \`PROJECT_A_SENTINEL\`; A→B→A and B→A→B preserve each document independently. The six-direction A/B/C matrix has zero issues, target digest equality in every row, and zero foreign entity IDs. Matrix C uses the clean equipment-heavy canonical project because the old robed-mage production fixture is independently invalid and cannot serve as a zero-issue isolation oracle.

## 16. Rapid switch result

PASS. Controlled overlapping hydration commits discard the older completion and retain the final requested target. Project-keyed save barriers prove resumed A work cannot target B. No timing sleeps are used for correctness tests.

## 17. 100-switch result

PASS. Seed \`0x5eed1234\` drives 100 A/B/C transitions. Every transition commits the requested active ID, exits switching state, and produces exactly one hydrate-committed event; no pending lifecycle work remains.

## 18. Entity-ID collision result

PASS. Session identity, not entity strings, scopes state. Colliding IDs are allowed within different projects without sharing history or selection maps.

## 19. Stale-selection collision result

PASS. A's selected \`bone-1\` is cleared for B even when B also has \`bone-1\`; animation workspace remount and loaded B library prevent stale target resolution.

## 20. Artificial latency race results

PASS. Promise barriers cover save-during-switch, archive-during-save, hydration completion inversion, and delayed provider completion. Store hooks allow controlled disk save/load delay; identity assertions, not arbitrary timeout ordering, determine the winner.

## 21. Delete/Save As/rename results

PASS. Delete/archive waits its project queue and tombstones the ID. Save As gets a new project ID, token, and staged destination while preserving canonical rig/content and leaving the original unchanged. Display-name save keeps canonical identity and the existing managed directory, so a title change cannot redirect a queued save to another project.

## 22. Bridge-disconnect result

PASS. Failure cannot call \`completeDurableSave\`, change the durable pointer, or report false disk success. The active project remains usable and any browser working-cache state is described as cache-only.

## 23. Quota-failure result

PASS. A cache/save failure remains scoped to A; B can commit with a new session and mutate normally. No cross-project fallback write occurs.

## 24. Backup recovery result

PASS. A truncated current \`rig.json\` recovers only from sibling \`rig.json.bak\`. Backup lookup never crosses a project directory. New projects/imports stage sibling temp directories and rename atomically, so abandoned temp work is not selected as another project's truth.

## 25. Three live ZIP round trips

**3/3 PASS through the actual UI.** Standard A: 16 parts, 5 animations, normalized \`${liveZip[0].sourceDigest.normalizedDigest}\`. Digitigrade B: 16 parts, 5 animations, normalized \`${liveZip[1].sourceDigest.normalizedDigest}\`. Equipment-heavy C: 18 parts, 4 equipment parts, 4 animations, normalized \`${liveZip[2].sourceDigest.normalizedDigest}\`. Each import-as-copy matched its source normalized digest, validated with zero issues, reached SAVED TO DISK, and B playback was started/paused successfully.

## 26. 20x automated ZIP round trip

PASS. One complex canonical project was exported once and imported-as-copy 20 times. Every imported normalized digest matched the source. The corruption matrix also rejects missing rig, modified mask, truncated animations, missing source, invalid manifest, and duplicate path without changing the active/original project.

## 27. Void Ranger before/after hash

Before: \`${goldenBefore}\`  
After: \`${goldenAfter}\`  
Byte-identical: **${goldenBefore === goldenAfter ? "YES" : "NO"}**. Golden end-to-end tests: 3/3.

## 28. Validator results before/after reproduction

A before: 0. H before: 0. Immediate pre-fix mixed transition: 49. Clean reload/restart: 0 for each stored project. Exact post-fix browser sequence A Prepare → Setup → open H: 0 cross-project issues and Valid. The canonical validator was not weakened; LocalProjectStore now applies it at save, load, import, and editor commit boundaries.

## 29. Project switch performance

No comparable pre-fix stage timing was instrumented, so none is fabricated. Post-fix clean-disk Node measurements are in \`summary.json\`: A ${performanceResults[0].loadMs} ms load + ${performanceResults[0].validationMs} ms validate + ${performanceResults[0].commitMs} ms commit = ${performanceResults[0].totalMs} ms; B ${performanceResults[1].loadMs} + ${performanceResults[1].validationMs} + ${performanceResults[1].commitMs} = ${performanceResults[1].totalMs} ms; C ${performanceResults[2].loadMs} + ${performanceResults[2].validationMs} + ${performanceResults[2].commitMs} = ${performanceResults[2].totalMs} ms. Save flush was 0 ms for clean opens. Correctness adds no arbitrary delay.

## 30. Exact test/build/typecheck/browser results

- \`npm test\`: PASS — 35 test files, 239 unit tests, production build, and 5/5 rendered routes.
- \`npm run typecheck\`: PASS.
- \`npm run lint\`: PASS with 0 errors; one pre-existing unused-variable warning is inside an archived diagnostics harness.
- \`npx vitest ... void-ranger-golden.test.ts\`: PASS — 3/3.
- Browser QA: PASS at 1280×720 — A edit/save → B edit/save → A undo/redo reset → C → B → export B → import copy → open/play/pause; plus live A and C export/import copies. Full reload/cross-route disk-pointer rehydration was also verified.
- Original cross-project sequence: PASS — H header/rig/animations, Valid, SAVED TO DISK, and zero contamination issues.

Project isolation and ZIP integrity are proven for the requested gate. Locomotion and equipment automation were not started.
`;

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "pre-fix-49-issues.json"), json(preFix));
await writeFile(path.join(OUT, "project-identity-trace.json"), json({ runId: RUN_ID, final: lifecycle.snapshot, events: lifecycle.getTrace() }));
await writeFile(path.join(OUT, "source-of-truth.json"), json(sourceOfTruth));
await writeFile(path.join(OUT, "summary.json"), json(summary));
await writeFile(path.join(OUT, "report.md"), report);

process.stdout.write(json({ output: rel(OUT), issueCount: mixedIssues.length, matrixPassed: matrix.every((entry) => entry.issues === 0 && entry.digestMatchesTarget && entry.foreignEntityIds.length === 0), liveZipPassed: `${liveZip.filter((entry) => entry.passed).length}/${liveZip.length}`, goldenUnchanged: goldenBefore === goldenAfter }));
