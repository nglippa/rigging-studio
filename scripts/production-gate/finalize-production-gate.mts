/* eslint-disable @typescript-eslint/no-explicit-any */
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const ROOT = process.cwd();
const RUN_ID = "2026-08-23T06-00-00Z";
const RUN_ROOT = path.join(ROOT, ".rigging-studio/diagnostics/production-gates", RUN_ID);
const TORTURE_ROOT = path.join(ROOT, ".rigging-studio/diagnostics/torture-runs/2026-08-22T07-24-30Z");
const UI_ROOT = path.join(RUN_ROOT, "screenshots/ui");
const REVIEW_ROOT = path.join(RUN_ROOT, "review-sheets");
const summary = JSON.parse(await readFile(path.join(RUN_ROOT, "summary.json"), "utf8")) as any;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const exists = async (file: string): Promise<boolean> => { try { await access(file); return true; } catch { return false; } };

const prefixes: Record<string, string> = { A: "a-standard-swordsman", B: "b-plague-doctor", C: "c-broad-dwarf", D: "d-digitigrade-beastman", E: "e-robed-mage", F: "f-bulky-sci-fi-marine", G: "g-thin-rogue", H: "h-extreme-chibi-fighter" };
const oldSheetPath = (character: any): string => path.join(TORTURE_ROOT, `character-${character.letter.toLowerCase()}-${character.slug}`, "review-sheet.png");
const animationShot = (character: any, clip: string): string => path.join(UI_ROOT, `${prefixes[character.letter]}-${clip}-1440x900.png`);

const color = (value: number) => ({ r: value >> 16 & 255, g: value >> 8 & 255, b: value & 255 });
const blank = (width: number, height: number, value = 0x0b0c18): PNG => { const output = new PNG({ width, height }); const c = color(value); for (let index = 0; index < width * height; index += 1) { output.data[index * 4] = c.r; output.data[index * 4 + 1] = c.g; output.data[index * 4 + 2] = c.b; output.data[index * 4 + 3] = 255; } return output; };
const paint = (target: PNG, left: number, top: number, width: number, height: number, value: number): void => { const c = color(value); for (let y = Math.max(0, top); y < Math.min(target.height, top + height); y += 1) for (let x = Math.max(0, left); x < Math.min(target.width, left + width); x += 1) { const index = (y * target.width + x) * 4; target.data[index] = c.r; target.data[index + 1] = c.g; target.data[index + 2] = c.b; target.data[index + 3] = 255; } };
const blit = (source: PNG, target: PNG, crop: { x: number; y: number; width: number; height: number }, box: { x: number; y: number; width: number; height: number }): void => {
  const scale = Math.min(box.width / crop.width, box.height / crop.height); const width = Math.max(1, Math.floor(crop.width * scale)); const height = Math.max(1, Math.floor(crop.height * scale)); const left = box.x + Math.floor((box.width - width) / 2); const top = box.y + Math.floor((box.height - height) / 2);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const sx = Math.min(source.width - 1, crop.x + Math.floor(x / scale)); const sy = Math.min(source.height - 1, crop.y + Math.floor(y / scale)); const si = (sy * source.width + sx) * 4; const ti = ((top + y) * target.width + left + x) * 4; target.data[ti] = source.data[si] ?? 0; target.data[ti + 1] = source.data[si + 1] ?? 0; target.data[ti + 2] = source.data[si + 2] ?? 0; target.data[ti + 3] = 255; }
};

const FONT: Record<string, readonly string[]> = {
  " ":["000","000","000","000","000","000","000"], "-":["000","000","000","111","000","000","000"], "/":["001","001","010","010","100","100","100"],
  A:["01110","10001","10001","11111","10001","10001","10001"],B:["11110","10001","10001","11110","10001","10001","11110"],C:["01111","10000","10000","10000","10000","10000","01111"],D:["11110","10001","10001","10001","10001","10001","11110"],E:["11111","10000","10000","11110","10000","10000","11111"],F:["11111","10000","10000","11110","10000","10000","10000"],G:["01111","10000","10000","10111","10001","10001","01111"],H:["10001","10001","10001","11111","10001","10001","10001"],I:["111","010","010","010","010","010","111"],J:["00111","00010","00010","00010","10010","10010","01100"],K:["10001","10010","10100","11000","10100","10010","10001"],L:["10000","10000","10000","10000","10000","10000","11111"],M:["10001","11011","10101","10101","10001","10001","10001"],N:["10001","11001","10101","10011","10001","10001","10001"],O:["01110","10001","10001","10001","10001","10001","01110"],P:["11110","10001","10001","11110","10000","10000","10000"],Q:["01110","10001","10001","10001","10101","10010","01101"],R:["11110","10001","10001","11110","10100","10010","10001"],S:["01111","10000","10000","01110","00001","00001","11110"],T:["11111","00100","00100","00100","00100","00100","00100"],U:["10001","10001","10001","10001","10001","10001","01110"],V:["10001","10001","10001","10001","10001","01010","00100"],W:["10001","10001","10001","10101","10101","11011","10001"],X:["10001","10001","01010","00100","01010","10001","10001"],Y:["10001","10001","01010","00100","00100","00100","00100"],Z:["11111","00001","00010","00100","01000","10000","11111"],
  "0":["01110","10001","10011","10101","11001","10001","01110"],"1":["010","110","010","010","010","010","111"],"2":["01110","10001","00001","00010","00100","01000","11111"],"3":["11110","00001","00001","01110","00001","00001","11110"],"4":["00010","00110","01010","10010","11111","00010","00010"],"5":["11111","10000","10000","11110","00001","00001","11110"],"6":["01110","10000","10000","11110","10001","10001","01110"],"7":["11111","00001","00010","00100","01000","01000","01000"],"8":["01110","10001","10001","01110","10001","10001","01110"],"9":["01110","10001","10001","01111","00001","00001","01110"],
};
const drawText = (target: PNG, text: string, left: number, top: number, value = 0xffffff, scale = 2): void => { const c = color(value); let cursor = left; for (const character of text.toUpperCase()) { const glyph = FONT[character] ?? FONT[" "]!; glyph.forEach((row, y) => [...row].forEach((pixel, x) => { if (pixel !== "1") return; for (let py = 0; py < scale; py += 1) for (let px = 0; px < scale; px += 1) { const tx = cursor + x * scale + px; const ty = top + y * scale + py; if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) return; const index = (ty * target.width + tx) * 4; target.data[index] = c.r; target.data[index + 1] = c.g; target.data[index + 2] = c.b; target.data[index + 3] = 255; } })); cursor += (glyph[0]!.length + 1) * scale; } };

await mkdir(REVIEW_ROOT, { recursive: true });
const reviewSheets = [];
for (const character of summary.characters) {
  const output = blank(1600, 1040); const oldSheet = PNG.sync.read(await readFile(oldSheetPath(character)));
  const cells = [{ label: "A SOURCE", oldX: 0 }, { label: "B FINAL CUT", oldX: 300 }, { label: "C RIG PIVOTS", oldX: 900 }];
  cells.forEach((cell, index) => { const x = index * 400; paint(output, x + 4, 44, 392, 406, 0x141729); drawText(output, cell.label, x + 14, 14, 0xd8dcff, 2); blit(oldSheet, output, { x: cell.oldX, y: 48, width: 300, height: 666 }, { x: x + 8, y: 48, width: 384, height: 398 }); });
  const clips = ["idle", "walk", "run", "attack"];
  for (let index = 0; index < clips.length; index += 1) {
    const cellIndex = index + 3; const x = cellIndex % 4 * 400; const y = cellIndex < 4 ? 0 : 470; const label = `${String.fromCharCode(68 + index)} ${clips[index]}`; paint(output, x + 4, y + 44, 392, 406, 0x141729); drawText(output, label, x + 14, y + 14, 0xd8dcff, 2);
    const shot = animationShot(character, clips[index]!);
    if (await exists(shot)) { const image = PNG.sync.read(await readFile(shot)); blit(image, output, { x: 220, y: 108, width: 1190, height: 535 }, { x: x + 8, y: y + 48, width: 384, height: 398 }); }
    else { drawText(output, "BLOCKED AT SETUP", x + 88, y + 220, 0xff6b7a, 3); }
  }
  const metricsX = 1200; const metricsY = 470; paint(output, metricsX + 4, metricsY + 44, 392, 406, character.classification === "FAILED" ? 0x2b111b : 0x17152b); drawText(output, "H METRICS", metricsX + 14, metricsY + 14, 0xd8dcff, 2);
  const metricLines = [`PREP ${character.prepare.lassoOperations} LASSO`, `SETUP ${character.setup.significantSetupCorrections} FIX`, `ANIM ${character.animate.clips.length}/4 AUTO`, `SCORE ${character.score.total}/50`, character.classification];
  metricLines.forEach((line, index) => drawText(output, line, metricsX + 26, metricsY + 105 + index * 54, index === metricLines.length - 1 ? 0xffd166 : 0xffffff, 2));
  paint(output, 0, 960, 1600, 80, character.classification === "FAILED" ? 0xa8243b : 0x6757d9); drawText(output, `${character.letter} ${character.character} - ${character.classification} - ${character.score.total}/50`, 24, 985, 0xffffff, 3);
  const outputPath = path.join(REVIEW_ROOT, `${prefixes[character.letter]}-review-sheet.png`); await writeFile(outputPath, PNG.sync.write(output)); reviewSheets.push({ character: character.character, path: path.relative(ROOT, outputPath) });
}

const uiFiles = (await readdir(UI_ROOT)).filter((file) => file.endsWith(".png")).sort();
const uiPlayback = {
  runId: RUN_ID,
  actualUi: true,
  browser: "Codex in-app browser",
  screenshots: uiFiles.map((file) => path.posix.join("screenshots/ui", file)),
  clipCaptures: uiFiles.filter((file) => /-(idle|walk|run|attack)-1440x900\.png$/.test(file)).length,
  stageCaptures: uiFiles.filter((file) => /-(prepare-accepted|setup-valid)-1440x900\.png$/.test(file)).length,
  operations: ["switch", "start", "pause", "scrub"],
  visualRatings: summary.browserQa.visualResults,
  blocker: summary.browserQa.blocker,
};
await writeFile(path.join(RUN_ROOT, "ui-playback.json"), json(uiPlayback));
await writeFile(path.join(RUN_ROOT, "review-sheets.json"), json(reviewSheets));

const verification = {
  typeScript: { command: "npm run typecheck", passed: true },
  lint: { command: "npm run lint", passed: false, errors: 8, warnings: 2, note: "Pre-existing React hooks/ref lint findings remain in PartCutterWorkspace, AnimateWorkspace, and RigEditor; no production algorithm was changed in this gate." },
  unit: { command: "npm run test:unit", passed: true, tests: "228/228", files: "34/34" },
  focusedReliability: { command: "npx vitest run ...project-integrity/project-storage/animation-player/void-ranger/part-cutter", passed: true, tests: "39/39", files: "5/5" },
  renderedHtml: { command: "node --test tests/rendered-html.test.mjs", passed: true, tests: "5/5" },
  productionBuild: { command: "npm run build", passed: true },
  voidRangerGolden: { command: "npx vitest run --config vitest.config.ts tests/rigging/void-ranger-golden.test.ts", passed: true, tests: "3/3", beforeSha256: summary.golden.beforeSha256, afterSha256: summary.golden.afterSha256, unchanged: summary.golden.unchanged },
  localhostHarness: { command: "npm run ux:inspect -- --url http://localhost:3000", passed: true, run: ".rigging-studio/diagnostics/ux-inspection/2026-08-23T05-57-55Z", captures: "70/70", screenshots: 184, actionableRuntimeEvents: 0, expectedOptionalServiceEvents: 60 },
  browserPlaybackQa: { passed: false, projectsReopenedAndPlayed: "5/8", clipsPlayed: 20, blocker: "transition_state_loss after stage navigation and subsequent durable open" },
};
await writeFile(path.join(RUN_ROOT, "verification.json"), json(verification));

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const detailTotal = summary.characters.reduce((sum: number, character: any) => sum + character.prepare.equipmentAutomation.manualLasso, 0);
const sourceRows = summary.characters.map((character: any) => `| ${character.letter} | ${character.character} | ${character.source.file} | ${character.source.width}×${character.source.height} | \`${character.source.sha256}\` | ${character.source.styleReview} |`).join("\n");
const zipByName = new Map(summary.zipRoundTrips.map((entry: any) => [entry.character, entry]));
const finalRows = summary.characters.map((character: any) => {
  const qualities = Object.fromEntries(["idle", "walk", "run", "attack"].map((clip) => [clip, character.animate.clips.find((entry: any) => entry.type === clip)?.quality ?? "BLOCKED"]));
  const zip = zipByName.get(character.character) as any;
  return `| ${character.character} | ${character.cutComplete ? "YES" : "NO"} | ${character.prepare.lassoOperations} lasso | ${character.setup.rigValidPreFix ? "YES" : "NO"} | ${character.setup.significantSetupCorrections} | ${qualities.idle} | ${qualities.walk} | ${qualities.run} | ${qualities.attack} | ${character.animate.significantManualEdits} | 0/${character.prepare.equipmentAutomation.manualLasso} auto/manual | ${character.reopen.loaded ? "YES" : "NO"} | ${zip ? (zip.passed ? "PASS" : "FAIL") : "N/T"} | ${character.handsOnMinutes.total}m | ${character.score.total} | ${character.classification} | ${character.primaryFailure} |`;
}).join("\n");
const clusterRows = summary.failureClusters.toSorted((a: any, b: any) => b.rankScore - a.rankScore).map((cluster: any, index: number) => `| ${index + 1} | ${cluster.cluster} | ${cluster.frequency} | ${cluster.severity} | ${cluster.manualCost} | ${cluster.rankScore} | ${cluster.evidence ?? "none observed"} |`).join("\n");

const report = `# Rig Studio End-to-End Production Gate

Run: \`${RUN_ID}\`  
Baseline rule: algorithms frozen; no landmark, equipment, pivot, animation, or validator tuning occurred.

## 1. Exact eight sources

All eight exact existing torture-suite sources were reused; none was regenerated. Seven are stylized high-resolution character art rather than strict pixel art, which is retained as a source-quality limitation rather than hidden.

| # | Character | Source | Dimensions | SHA-256 | Style review |
|---|---|---|---:|---|---|
${sourceRows}

## 2. Provider availability

ComfyUI: offline. Ollama: offline. The product's deterministic local animation provider was available. Provider outages are reported separately and are not scored as visual-quality failures; no provider output was fabricated.

## 3. Complete-cut rate

${summary.characters.filter((character: any) => character.cutComplete).length}/8 (${percent(summary.aggregate.completeCutRate)}) own 100% of visible foreground with zero overlaps and passing reassembly. The robed mage intentionally records the hidden right foot as unresolved and later fails the humanoid rig gate.

## 4. Average Prepare interventions

${summary.aggregate.averagePrepareInterventions.toFixed(3)} significant mask operations per character. Ordinary acceptance clicks are excluded.

## 5. Equipment/detail automation rate

0/${detailTotal} visible equipment/detail regions were automatic (${percent(summary.aggregate.equipmentDetailAutomationRate)}). All ${detailTotal} used manual lasso fallback.

## 6. Manual-lasso dependency

8/8 characters required lasso (${percent(summary.aggregate.manualLassoDependencyRate)}). Brush/polygon were 0 on 8/8 (${percent(summary.aggregate.zeroManualPaintRate)} zero-manual-paint rate).

## 7. Auto-rig validator pass rate

5/8 passed the canonical aggregate validator before correction (${percent(summary.aggregate.autoRigValidatorPassRate)}). The plague doctor and marine have stale equipment references; the robed mage lacks the required right-foot slot.

## 8. Average Setup interventions

${summary.aggregate.averageSetupInterventions.toFixed(2)} recorded setup corrections per character. This low number does not imply high quality: invalid rigs were stopped rather than repaired during the frozen baseline.

## 9. Pivot-quality findings

GOOD: swordsman, marine, rogue. USABLE: plague doctor, dwarf, digitigrade, extreme chibi. BAD: robed mage. ±20° structural diagnostics were retained in every prior review sheet where a valid rig existed; custom proportions remain the main pivot risk.

## 10. Equipment-binding findings

Swords, shield, hammer, staff, rifle, daggers, cape, hair, armor, tail, and accessories were cut separately where visible. Canonical validation found three stale equipment references: bird mask plus two shoulder plates. Those are immediate blockers.

## 11. Idle success rate

5/8 usable without significant repair (${percent(summary.aggregate.clipUsableWithoutRepairRate.idle)}). Every project that reached Animate had a stable, subtle Idle.

## 12. Walk success rate

0/8 usable. All five generated Walk clips visibly separate major joints; three projects were blocked before Animate.

## 13. Run success rate

0/8 usable. Run differs in timing/amplitude from Walk but fails visually with more severe hierarchy separation.

## 14. Attack success rate

4/8 usable (${percent(summary.aggregate.clipUsableWithoutRepairRate.attack)}): swordsman, digitigrade, rogue, and extreme chibi. Dwarf attack is structurally valid JSON but visually breaks the heavy silhouette; three projects were blocked.

## 15. Average animation interventions

0.00 manual edits. The baseline intentionally did not repair bad automatic clips, so this is not a success signal.

## 16. End-to-end success rate

0/8 (${percent(summary.aggregate.endToEndSuccessRate)}) reached MINOR REPAIR or better. Five completed the full structural path but require major cutting and animation repair; three failed the canonical Setup gate.

## 17. Production-ready count

${summary.aggregate.counts["PRODUCTION READY"]}.

## 18. Minor-repair count

${summary.aggregate.counts["MINOR REPAIR"]}.

## 19. Major-repair count

${summary.aggregate.counts["MAJOR REPAIR"]}.

## 20. Failure count

${summary.aggregate.counts.FAILED} (plague doctor, robed mage, marine).

## 21. Average hands-on time

${summary.aggregate.averageHandsOnMinutes.toFixed(2)} minutes, excluding build/test runtime, provider waiting, and harness overhead.

## 22. Fastest/slowest character

Fastest: ${summary.aggregate.fastest}. Slowest: ${summary.aggregate.slowest}. Per-character stage timing is in \`summary.json\`.

## 23. Reopen results

Disk-store reopen succeeded for all 8 projects. Exact four-clip structural replay succeeded for 5/8. Actual UI reopen/playback covered 5 viable projects and 20 clips before the cross-project transition blocker stopped further UI work.

## 24. ZIP results

2/3 required round trips passed. Standard humanoid and digitigrade preserved parts, rig, four clips, and playback. Equipment-heavy marine imported but correctly failed because its stale armor references block Animate and it has zero accepted clips.

## 25. Integrity failures

${summary.aggregate.integrityFailures}: three stale equipment references plus one cross-project transition state-loss failure. The latter mixed prior Prepare parts with a newly opened rig after Prepare/Setup navigation, producing a project-rig mismatch and 49 issues. No rollback, ownership, ZIP recovery, NaN, zombie-target, or golden corruption failure was observed.

## 26. Per-character table

| Character | Cut Complete? | Prepare Fixes | Rig Valid Pre-Fix? | Setup Fixes | Idle | Walk | Run | Attack | Animation Fixes | Equipment Auto/Manual | Reopen | ZIP | Hands-On Time | Score /50 | Classification | Primary Failure |
|---|---:|---:|---:|---:|---|---|---|---|---:|---|---|---|---:|---:|---|---|
${finalRows}

## 27. Failure clusters ranked

Rank score is frequency × severity × manual cost.

| Rank | Cluster | Frequency | Severity | Manual cost | Rank score | Evidence |
|---:|---|---:|---:|---:|---:|---|
${clusterRows}

## 28. Single next product priority

**${summary.nextProductPriority}**

This priority was selected only; it was not implemented.

## 29. Void Ranger golden before/after

Before: \`${summary.golden.beforeSha256}\`  
After: \`${summary.golden.afterSha256}\`  
Unchanged: **${summary.golden.unchanged ? "YES" : "NO"}**. Golden tests passed 3/3.

## 30. Exact verification results

- TypeScript: PASS.
- Lint: FAIL — 8 existing React hooks/ref errors and 2 warnings; production gate code is clean.
- Unit: PASS — 228/228 across 34 files.
- Focused reliability: PASS — 39/39 across 5 files.
- Rendered HTML: PASS — 5/5.
- Production build: PASS.
- Void Ranger golden: PASS — 3/3 and identical hash.
- Localhost harness: PASS — 70/70 captures, 184 screenshots, 0 actionable runtime events; 60 expected offline-Ollama events.
- Browser playback QA: FAIL — 20 clips exercised in the actual Animate UI, then cross-project transition state loss produced 49 issues and correctly blocked further Animate entry.

## Evidence index

- \`summary.json\` — complete machine-readable results.
- \`ui-playback.json\` — exact actual-UI screenshots and operations.
- \`review-sheets/\` — one consistent sheet per character.
- \`verification.json\` — exact command results.
- \`algorithm-freeze.json\` — baseline freeze declaration.
- Localhost harness: \`.rigging-studio/diagnostics/ux-inspection/2026-08-23T05-57-55Z/\`.
`;
await writeFile(path.join(RUN_ROOT, "report.md"), `${report.trim()}\n`, "utf8");
process.stdout.write(json({ report: path.relative(ROOT, path.join(RUN_ROOT, "report.md")), summary: path.relative(ROOT, path.join(RUN_ROOT, "summary.json")), reviewSheets: reviewSheets.length, uiScreenshots: uiFiles.length }));
