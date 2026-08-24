/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalProjectStateDigest } from "../../src/project-storage/digest";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";

const ROOT = process.cwd();
const RUN_ID = "2026-08-23T15-42-41Z";
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/final-confirmatory-gates", RUN_ID);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const freeze = JSON.parse(await readFile(path.join(OUT, "algorithm-freeze.json"), "utf8"));
const primary = JSON.parse(await readFile(path.join(OUT, "primary-results.json"), "utf8"));
const store = new LocalProjectStore({ cwd: ROOT });

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }))).flat();
}

const productFiles = (await Promise.all(["app", "src", "mcp"].map((root) => filesBelow(path.join(ROOT, root))))).flat()
  .filter((file) => !/\.(map|tsbuildinfo)$/.test(file)).sort();
const supportingFiles = ["package.json", "package-lock.json", "tsconfig.json"].map((file) => path.join(ROOT, file));
const fileDigests = [];
for (const file of [...productFiles, ...supportingFiles]) fileDigests.push({ file: path.relative(ROOT, file), sha256: sha(await readFile(file)) });
const productionTreeSha256After = sha(fileDigests.map((entry) => `${entry.file}\0${entry.sha256}`).join("\n"));
const productionTreeUnchanged = productionTreeSha256After === freeze.productionTreeSha256;
const goldenPath = path.join(ROOT, ".rigging-studio/projects/void-ranger--character-void-ranger-golden-v1/project.json");
const voidRangerSha256After = sha(await readFile(goldenPath));
const voidRangerByteIdentical = voidRangerSha256After === freeze.voidRangerSha256;

const reopenPostRestart: Array<{
  character: string;
  projectId: string;
  firstPersistedDigest: string;
  postRestartDigest: string;
  digestMatch: boolean;
  loaded: boolean;
  rigPresent: boolean;
  clipCount: number;
  playbackPassed: boolean;
  fullGatePassed: boolean;
  note: string;
}> = [];
for (const character of primary.characters) {
  const first = await store.load(character.projectId);
  const second = await new LocalProjectStore({ cwd: ROOT }).load(character.projectId);
  const firstDigest = canonicalProjectStateDigest(first.snapshot);
  const secondDigest = canonicalProjectStateDigest(second.snapshot);
  reopenPostRestart.push({
    character: character.character,
    projectId: character.projectId,
    firstPersistedDigest: firstDigest,
    postRestartDigest: secondDigest,
    digestMatch: firstDigest === secondDigest,
    loaded: true,
    rigPresent: Boolean(second.snapshot.rig),
    clipCount: second.snapshot.animations?.animations.length ?? 0,
    playbackPassed: false,
    fullGatePassed: false,
    note: "The original primary recorder compared pre-save memory to storage-normalized state. This post-save persisted baseline is the correct reopen measurement; full gate still fails because no rig or clips exist to replay.",
  });
}
await writeFile(path.join(OUT, "reopen-postrestart.json"), json(reopenPostRestart));

const uiQa = {
  actualProductUiUsed: true,
  viableCharacterCount: 0,
  animationPlaybackReviews: 0,
  prepareReopen: { character: "Final Gate 10 Mycene Knight", passed: true, stage: "prepare", parts: 0, animations: 0 },
  integrityFailure: {
    severity: "P0",
    type: "cross-project contamination / inconsistent active-project hydration",
    reproduction: [
      "Open Final Gate 10 Mycene Knight from Project storage; Prepare correctly shows 0 semantic regions.",
      "Click the Setup workspace step.",
      "Workspace changes to unrelated Dwarf Heavy Fighter with its 16-bone setup instead of blocking or retaining Mycene Knight.",
      "After full app/MCP restart, open three fresh in-app tabs: one hydrates Dwarf Heavy Fighter and two hydrate Mycene Knight; the latter disagree between SAVED TO DISK and LOCAL CACHE ONLY.",
    ],
    persistentDiskCorruptionObserved: false,
    screenshots: [
      "screenshots/ui/10-mycene-knight-prepare-blocked.png",
      "screenshots/ui/10-mycene-knight-setup-cross-project-contamination.png",
      "screenshots/ui/fresh-tab-1-unrelated-dwarf.png",
      "screenshots/ui/fresh-tab-2-mycene-saved.png",
      "screenshots/ui/fresh-tab-3-mycene-local-cache-only.png",
    ],
  },
  restart: { appRestarted: true, mcpRestarted: true, diskProjectReopened: true },
  freshContext: { requestedCharacters: 3, freshInAppTabsOpened: 3, separateProfilesAvailableInHarness: false, consistent: false },
};
await writeFile(path.join(OUT, "ui-qa.json"), json(uiQa));

const testResults = {
  executedAfterAllTen: true,
  typecheck: { passed: true, command: "npm run typecheck" },
  lint: { passed: true, errors: 0, warnings: 2, gateHarnessWarnings: 1, preExistingWarnings: 1, command: "npm run lint" },
  unit: { passed: true, files: 38, tests: 278, command: "npm run test:unit" },
  focusedReliability: { passed: true, files: 5, tests: 46, command: "npx vitest run --config vitest.config.ts tests/mcp/local-project-store.test.ts tests/rigging/project-lifecycle.test.ts tests/rigging/void-ranger-golden.test.ts tests/rigging/locomotion-reliability.test.ts tests/rigging/idle-attack-reliability.test.ts" },
  renderedHtml: { passed: true, tests: 5, command: "node --test tests/rendered-html.test.mjs" },
  build: { passed: true, command: "npm run build", warning: "Vite reported chunks larger than 500 kB." },
};
await writeFile(path.join(OUT, "verification-results.json"), json(testResults));

const characters = primary.characters.map((character: any, index: number) => ({
  ...character,
  reopen: { ...character.reopen, ...reopenPostRestart[index], originalRecorderDigestMatch: character.reopen.digestMatch },
}));
const aggregate = {
  zeroTouchProductionReady: characters.filter((character: any) => character.classification === "ZERO-TOUCH PRODUCTION READY").length,
  minimalRepairProductionReady: characters.filter((character: any) => character.classification === "MINIMAL-REPAIR PRODUCTION READY").length,
  totalProductionReady: characters.filter((character: any) => /PRODUCTION READY$/.test(character.classification)).length,
  majorRepair: characters.filter((character: any) => character.classification === "MAJOR REPAIR").length,
  failed: characters.filter((character: any) => character.classification === "FAILED").length,
  completeCuts: characters.filter((character: any) => character.cut.complete).length,
  validRigsZeroTouch: characters.filter((character: any) => character.rig.canonicalValid).length,
  idleUsable: characters.filter((character: any) => character.animations.qualities.idle !== "BAD").length,
  walkUsable: characters.filter((character: any) => character.animations.qualities.walk !== "BAD").length,
  runUsable: characters.filter((character: any) => character.animations.qualities.run !== "BAD").length,
  attackUsable: characters.filter((character: any) => character.animations.qualities.attack !== "BAD").length,
  persistedReopenDigestMatches: reopenPostRestart.filter((entry) => entry.digestMatch).length,
  fullReopenReplayPasses: reopenPostRestart.filter((entry) => entry.fullGatePassed).length,
  zipNormalizedDigestMatches: characters.filter((character: any) => character.zip.normalizedDigestMatch).length,
  fullZipPasses: characters.filter((character: any) => character.zip.passed).length,
  integrityFailures: 1,
  zeroCorrection: characters.filter((character: any) => character.zeroTouchCorrections === 0 && character.repair.corrections === 0).length,
  oneCorrection: 0,
  twoCorrections: 0,
  threePlusCorrections: 0,
};
const rules = {
  A: { requirement: ">=8/10 zero-touch production ready", actual: aggregate.zeroTouchProductionReady, pass: aggregate.zeroTouchProductionReady >= 8 },
  B: { requirement: ">=9/10 total production ready with <=2 corrections", actual: aggregate.totalProductionReady, pass: aggregate.totalProductionReady >= 9 },
  C: { requirement: "<=1 Major Repair/Failed", actual: aggregate.majorRepair + aggregate.failed, pass: aggregate.majorRepair + aggregate.failed <= 1 },
  D: { requirement: ">=9/10 complete usable cuts", actual: aggregate.completeCuts, pass: aggregate.completeCuts >= 9 },
  E: { requirement: ">=9/10 zero-touch valid rigs", actual: aggregate.validRigsZeroTouch, pass: aggregate.validRigsZeroTouch >= 9 },
  F: { requirement: ">=9/10 usable Idle", actual: aggregate.idleUsable, pass: aggregate.idleUsable >= 9 },
  G: { requirement: ">=9/10 usable Walk", actual: aggregate.walkUsable, pass: aggregate.walkUsable >= 9 },
  H: { requirement: ">=9/10 usable Run", actual: aggregate.runUsable, pass: aggregate.runUsable >= 9 },
  I: { requirement: ">=9/10 usable Attack", actual: aggregate.attackUsable, pass: aggregate.attackUsable >= 9 },
  J: { requirement: "10/10 reopen, canonical state and replay", actual: aggregate.fullReopenReplayPasses, pass: aggregate.fullReopenReplayPasses === 10 },
  K: { requirement: "10/10 ZIP round-trip, validate and replay", actual: aggregate.fullZipPasses, pass: aggregate.fullZipPasses === 10 },
  L: { requirement: "project isolation PASS and no observed contamination", actual: "FAIL — P0 UI contamination observed", pass: false },
  M: { requirement: "no P0 integrity failure", actual: aggregate.integrityFailures, pass: aggregate.integrityFailures === 0 },
  N: { requirement: "no production algorithm change during gate", actual: productionTreeUnchanged, pass: productionTreeUnchanged },
  O: { requirement: "Void Ranger byte-identical", actual: voidRangerByteIdentical, pass: voidRangerByteIdentical },
};
const decision = Object.values(rules).every((rule) => rule.pass) ? "PIPELINE SUCCESS" : "PIPELINE FAILURE";
const failedRules = Object.entries(rules).filter(([, rule]) => !rule.pass).map(([letter]) => letter);
const integrityFailures = [uiQa.integrityFailure];
const evidencePaths = {
  root: OUT,
  sourceManifest: path.join(OUT, "source-manifest.json"),
  algorithmFreeze: path.join(OUT, "algorithm-freeze.json"),
  primaryResults: path.join(OUT, "primary-results.json"),
  reopenPostRestart: path.join(OUT, "reopen-postrestart.json"),
  uiQa: path.join(OUT, "ui-qa.json"),
  verification: path.join(OUT, "verification-results.json"),
  reviewSheets: path.join(OUT, "review-sheets"),
  screenshots: path.join(OUT, "screenshots/ui"),
  motionPaths: path.join(OUT, "motion-paths"),
};
const result = {
  decision,
  runId: RUN_ID,
  completedAt: new Date().toISOString(),
  rules,
  perRulePass: Object.fromEntries(Object.entries(rules).map(([letter, rule]) => [letter, rule.pass])),
  failedRules,
  characterResults: characters,
  aggregates: aggregate,
  integrityFailures,
  algorithmFrozen: productionTreeUnchanged,
  productionTree: { before: freeze.productionTreeSha256, after: productionTreeSha256After, byteIdentical: productionTreeUnchanged, fileCount: fileDigests.length },
  voidRanger: { before: freeze.voidRangerSha256, after: voidRangerSha256After, byteIdentical: voidRangerByteIdentical },
  provider: primary.providerCapabilities,
  determinism: primary.determinismRetest,
  uiQa,
  verification: testResults,
  harnessChanges: [
    "Corrected LocalProjectSaveResult.projectId access after the first durable save. Character #1 was recovered from its immutable disk checkpoint and its production pipeline was not retried.",
    "Added immutable per-character result checkpoints so a recorder interruption cannot repeat an attempt.",
    "Corrected reopen measurement to compare persisted post-save state against a fresh post-restart disk load; raw primary-results.json remains unchanged.",
  ],
  evidencePaths,
  confidence: "HIGH",
  confidenceBasis: "Ten novel frozen sources all hit the same directly observed required-provider boundary; all ten artifacts/ZIP attempts exist; production and golden hashes match; P0 UI contamination was directly reproduced and captured. Animation visual review is unavailable because zero clips were produced, which cannot make the failure ambiguous.",
};
await writeFile(path.join(OUT, "final-gate-result.json"), json(result));

await mkdir(path.join(OUT, "review-sheets"), { recursive: true });
for (const character of characters) {
  const file = `${String(character.index).padStart(2, "0")}-${character.source.file.replace(/\.png$/, "")}.md`;
  const sheet = `# ${character.character} — confirmatory review sheet\n\n![Frozen unseen source](../sources/${character.source.file})\n\n| Evidence | Result |\n|---|---|\n| A. Source | Accepted; ${character.source.width}×${character.source.height}; transparent; SHA-256 \`${character.source.sha256}\` |\n| B. Complete cut | BAD — not produced; configured segmentation provider unavailable |\n| C. Rig + pivots | BAD — not produced; canonical rig validation could not begin |\n| D. Idle | BAD — not produced |\n| E. Walk | BAD — not produced; no foot path exists |\n| F. Run | BAD — not produced; no foot path exists |\n| G. Attack | BAD — not produced; no weapon path exists |\n| H. Metrics | 0 parts; 0 bones; 0 clips; 0 manual corrections; persisted reopen digest ${reopenPostRestart[character.index - 1].digestMatch ? "MATCH" : "MISMATCH"}; ZIP normalized digest ${character.zip.normalizedDigestMatch ? "MATCH" : "MISMATCH"} but replay FAIL |\n| I. Classification | **FAILED** — ${character.failureReason} |\n\nNo animation screenshot or motion path can be truthfully supplied because the primary product path created no rig or clip.\n`;
  await writeFile(path.join(OUT, "review-sheets", file), sheet);
}
await writeFile(path.join(OUT, "motion-paths", "README.md"), `# Motion-path evidence\n\nNo Walk, Run, or Attack clips were produced for any frozen source. Therefore there are no foot or weapon paths to capture. This is negative evidence, not a skipped successful review.\n`);

const tableRows = characters.map((character: any) => `| ${character.character} | ${character.archetype} | BAD | FAIL | BAD | BAD | BAD | BAD | FAIL* | FAIL† | 0 | 0 | 0s corrections | FAILED | ${character.failureReason} |`).join("\n");
const sourceRows = freeze.sources.map((source: any) => `| ${source.index} | ${source.file} | \`${source.sha256}\` | ${source.width}×${source.height} | yes | ${source.archetype} | ${source.topology} | ${source.equipment}; ${source.details} |`).join("\n");
const failedRuleRows = Object.entries(rules).filter(([, rule]) => !rule.pass).map(([letter, rule]) => `- ${letter}: ${rule.requirement}; actual: ${rule.actual}.`).join("\n");
const timed = characters.map((character: any) => character.timingMs.total).filter((value: unknown): value is number => typeof value === "number");
const meanTime = timed.reduce((sum: number, value: number) => sum + value, 0) / timed.length;

const report = `PIPELINE FAILURE\n\nRig Studio did not satisfy the frozen unseen-character confirmatory production gate.\n\n## 1. Binary decision\n\n**PIPELINE FAILURE.** Mandatory rules ${failedRules.join(", ")} failed. Rules N and O passed.\n\n## 2. Gate methodology\n\nTen new sources were generated and fixed as one cohort, hashed, then exercised once through the actual command/service pipeline from accepted source through automatic cut, finalize, rig, validation, four animation requests, save/reopen, ZIP export, import-as-copy, validation, and replay checks. Zero manual corrections were made. The required image-conditioned segmentation provider was unavailable, so downstream calls were attempted and preserved as failures rather than rescued.\n\n## 3. Frozen-algorithm confirmation\n\nProduction tree before: \`${freeze.productionTreeSha256}\`. After: \`${productionTreeSha256After}\`. **${productionTreeUnchanged ? "BYTE-IDENTICAL" : "CHANGED"}** across ${fileDigests.length} product/support files. Only evaluation-harness files changed. The interrupted first recorder was recovered from its disk checkpoint without repeating its product attempt.\n\n## 4. Exact 10 unseen sources\n\n| # | Filename | SHA-256 | Dimensions | Alpha | Archetype | Topology | Equipment/details |\n|---:|---|---|---:|---|---|---|---|\n${sourceRows}\n\n## 5. Source novelty statement\n\nAll ten were one-off sources generated before character #1, were absent from the prior eight-character torture suite and Void Ranger, and were frozen before execution. All are 1024×1536 RGBA with transparent corners and representative complete-character framing. No source was selected after observing gate behavior.\n\n## 6. Per-character table\n\n| Character | Archetype | Cut | Rig | Idle | Walk | Run | Attack | Reopen | ZIP | Zero-touch corrections | Repair corrections | Hands-on time | Classification | Failure reason |\n|---|---|---|---|---|---|---|---|---|---|---:|---:|---|---|---|\n${tableRows}\n\n\* All ten persisted projects reloaded with matching post-save canonical digests, but none could replay because no rig/clips existed; full reopen rule J is 0/10.  \n† All ten ZIP copies matched normalized source digests, but none could validate/replay a rig and four clips; full ZIP rule K is 0/10.\n\n## 7. Zero-touch rate\n\n**0/10 (0%).** Target: at least 8/10.\n\n## 8. Minimal-repair rate\n\n**0/10 (0%); total production-ready 0/10.** No repair was attempted: restoring an offline required provider is not a manual character correction, and manually cutting a complete character would exceed the two-correction total budget.\n\n## 9. Cut rate\n\n**0/10 complete usable cuts.** Every automatic segmentation attempt reported: \`${primary.providerCapabilities.segmentation.reason}\`.\n\n## 10. Rig rate\n\n**0/10 canonical zero-touch rigs.** Rig generation correctly remained blocked without a complete cut.\n\n## 11. Idle rate\n\n**0/10 usable.** No Idle clip was produced.\n\n## 12. Walk rate\n\n**0/10 usable.** No Walk clip or planted-foot path was produced.\n\n## 13. Run rate\n\n**0/10 usable.** No Run clip or planted-foot path was produced.\n\n## 14. Attack rate\n\n**0/10 usable.** No Attack clip or grip/weapon path was produced.\n\n## 15. Reopen rate\n\nPersisted canonical digest stability was **10/10** after correcting the harness baseline to post-save state. Full required reopen + four-clip replay was **0/10**, so rule J failed.\n\n## 16. ZIP rate\n\nZIP export/import was attempted for **10/10**. Normalized digest preservation was **10/10**. Full validate + four-clip replay was **0/10**, so rule K failed.\n\n## 17. Correction distribution\n\n0 corrections: 10. 1 correction: 0. 2 corrections: 0. 3+ corrections: 0. Zero corrections do not imply readiness; all ten failed before repair could be meaningfully bounded.\n\n## 18. Performance/time-to-result\n\nNine uninterrupted attempts averaged **${meanTime.toFixed(1)} ms** to the preserved source-only ZIP result because the provider failed immediately. Character #1 timing is intentionally unavailable after the recorder checkpoint recovery. These are failure-latency measurements, not successful production times.\n\n## 19. Integrity results\n\n**1 P0 integrity failure.** From Final Gate 10 Mycene Knight, clicking Setup changed the active character to unrelated Dwarf Heavy Fighter. After restart, three fresh in-app tabs disagreed on active project and disk/cache status. No persistent disk-byte corruption was observed, but cross-project in-memory hydration is explicitly a critical failure under the gate.\n\n## 20. Project-isolation result\n\n**FAIL.** Focused isolation/storage lifecycle tests passed (46/46 across the selected reliability group), but directly observed product UI contamination overrides the automated pass and fails rules L and M.\n\n## 21. Determinism result\n\nFive of five sampled sources reproduced the same provider-unavailable capability state and exact reason on repeated probes. No canonical generated-cut/rig/clip digest comparison was possible because no generated output existed. The failure mode was stable; the requested generation determinism evidence was unavailable.\n\n## 22. Restart/fresh-context result\n\nThe app and MCP bridge were fully stopped and restarted. Final Gate 10 reopened from disk at Prepare. Three fresh in-app tabs were then opened; they were inconsistent (one Dwarf, two Mycene, with conflicting saved/cache status). Separate browser profiles were not exposed by the in-app browser harness. Result: **FAIL**.\n\n## 23. Void Ranger result\n\nBefore: \`${freeze.voidRangerSha256}\`. After: \`${voidRangerSha256After}\`. **${voidRangerByteIdentical ? "BYTE-IDENTICAL" : "CHANGED"}**. Focused golden tests passed.\n\n## 24. Test/build/typecheck/lint result\n\n- Typecheck: PASS.\n- Lint: PASS, 0 errors and 2 warnings (one pre-existing diagnostic harness warning; one final-gate harness unused measurement warning).\n- Unit: PASS, 38/38 files and 278/278 tests.\n- Focused storage/lifecycle/Void Ranger/locomotion/Idle-Attack: PASS, 5/5 files and 46/46 tests.\n- Rendered HTML: PASS, 5/5.\n- Production build: PASS; Vite emitted a large-chunk warning.\n\n## 25. Failed mandatory conditions\n\n${failedRuleRows}\n\n## 26. Failure clusters\n\n- Cut: 10 systemic failures at required image-conditioned segmentation provider availability.\n- Rig, pivot, binding, equipment, Idle, Walk, Run, Attack: 10 downstream non-results each; no quality inference was substituted.\n- Reopen and ZIP: persisted/normalized bytes matched 10/10, but required rig/clip replay failed 10/10.\n- Project isolation: one P0 cross-project UI hydration/session failure with multiple direct observations.\n\n## 27. Single next blocker\n\nThe highest-leverage blocker is **availability of the configured production image-conditioned segmentation path (ComfyUI at 127.0.0.1:8188)**. It prevented every unseen source from reaching a complete cut. No fix was implemented after the decision.\n\n## 28. Confidence\n\n**HIGH.** Source novelty and freeze evidence are strong; all ten attempts, disk reopens, ZIPs, hashes, tests, and UI captures are preserved. Animation visual evidence is absent because zero animations existed, which strengthens rather than obscures the binary failure.\n\n## 29. Final binary conclusion\n\n**PIPELINE FAILURE.** Rig Studio is not production-successful under the frozen currently configured workflow. No product code or algorithm was changed after the decision.\n`;
await writeFile(path.join(OUT, "report.md"), report);
process.stdout.write(json({ decision, failedRules, aggregates: aggregate, productionTreeUnchanged, voidRangerByteIdentical, artifactDirectory: OUT }));
