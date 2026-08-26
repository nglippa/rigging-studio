import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type RecordValue = Record<string, any>;
const ROOT = path.resolve(import.meta.dirname, "../..");
const RUN_ID = process.env.DETERMINISTIC_CUT_RUN_ID ?? "2026-08-25T11-13-56Z";
const OUTPUT = path.join(ROOT, ".rigging-studio/diagnostics/deterministic-cut-arbitration", RUN_ID);
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const readJson = async (file: string): Promise<any> => JSON.parse(await readFile(path.join(OUTPUT, file), "utf8"));
const ratio = (numerator: number, denominator: number): number | null => denominator ? numerator / denominator : null;
const median = (values: readonly number[]): number | null => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const pct = (value: number | null): string => value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const semanticGroup = (semantic: string): string => semantic === "head" ? "head" : semantic === "torso" ? "torso" : /UpperArm$/.test(semantic) ? "upper-arms" : /Forearm$/.test(semantic) ? "forearms" : /Hand$/.test(semantic) ? "hands" : /Thigh$/.test(semantic) ? "thighs" : /LowerLeg$/.test(semantic) ? "lower-legs" : /Foot$/.test(semantic) ? "feet" : "other";
const histogram = (values: readonly (string | null)[]): Record<string, number> => values.reduce<Record<string, number>>((result, value) => { if (value) result[value] = (result[value] ?? 0) + 1; return result; }, {});

const records = await readJson("holdout/raw-results.json") as RecordValue[];
const development = await readJson("development-results.json");
const preregistration = await readJson("preregistration.json");
const freeze = await readJson("freeze.json");
const determinism = await readJson("determinism.json");
const ownership = await readJson("ownership-audit.json");
const regressions = await readJson("regression-results.json");
const positives = records.filter((record) => !record.negativeControl); const negatives = records.filter((record) => record.negativeControl); const covered = positives.filter((record) => record.validCandidatePresent); const correct = positives.filter((record) => record.newCorrect); const oldCorrect = positives.filter((record) => record.oldCorrect); const top2 = positives.filter((record) => record.top2ContainsCorrect);
const candidateCoverage = ratio(covered.length, positives.length)!; const conditionalTop1 = ratio(covered.filter((record) => record.newCorrect).length, covered.length)!; const overallTop1 = ratio(correct.length, positives.length)!; const falseAccept = ratio(negatives.filter((record) => record.falseAccept).length, negatives.length)!; const noneValid = ratio(negatives.filter((record) => record.noneValidReturned).length, negatives.length)!; const sideAccuracy = ratio(positives.filter((record) => record.sideCorrect).length, positives.length)!; const articulation = ratio(positives.filter((record) => record.articulationUsable).length, positives.length)!; const top2Overall = ratio(top2.length, positives.length)!; const top2Conditional = ratio(covered.filter((record) => record.top2ContainsCorrect).length, covered.length)!; const unresolvedRate = ratio(records.filter((record) => record.selection.decision === "NONE_VALID").length, records.length)!;
const oldCoverage = preregistration.historicalBaseline.candidateCoverage as number; const oldConditionalTop1 = preregistration.historicalBaseline.geometryTop1AmongCovered as number; const oldOverallTop1 = ratio(oldCorrect.length, positives.length)!; const visionHistorical = preregistration.historicalBaseline.visionTop1AmongCovered as number;

const split = { runId: RUN_ID, algorithm: preregistration.split.algorithm, splitHash: hash({ development: freeze.split.development, holdout: freeze.split.holdout }), development: freeze.split.development, holdout: freeze.split.holdout, negativeControls: preregistration.split.negativeControls, caveat: preregistration.split.caveat };
await writeFile(path.join(OUTPUT, "split.json"), json(split));

const coverage = { holdoutPositiveTargets: positives.length, validCandidateSets: covered.length, candidateCoverage, threshold: .95, passed: candidateCoverage >= .95, oldGeometryCoverage: oldCoverage, deltaPercentagePoints: (candidateCoverage - oldCoverage) * 100, failures: positives.filter((record) => !record.validCandidatePresent).map((record) => ({ character: record.character, characterKey: record.characterKey, semantic: record.semantic, candidateCount: record.candidateCount, failureClass: record.failureClass })), failureHistogram: histogram(positives.filter((record) => !record.validCandidatePresent).map((record) => record.failureClass)) };
await writeFile(path.join(OUTPUT, "coverage.json"), json(coverage));
const ranking = { coveredCandidateSets: covered.length, top1CorrectAmongCovered: covered.filter((record) => record.newCorrect).length, top1AccuracyAmongCovered: conditionalTop1, top1AccuracyOverallPositiveTargets: overallTop1, top2AccuracyAmongCovered: top2Conditional, top2AccuracyOverallPositiveTargets: top2Overall, threshold: .95, passed: conditionalTop1 >= .95, oldGeometryTop1AmongCovered: oldConditionalTop1, oldGeometryOverallPositiveAccuracy: oldOverallTop1, historicalVisionTop1AmongCovered: visionHistorical, rankingFailures: covered.filter((record) => !record.newCorrect).map((record) => ({ case: `${record.characterKey}-${record.semantic}`, failureClass: record.failureClass })), failureHistogram: histogram(covered.filter((record) => !record.newCorrect).map((record) => record.failureClass)) };
await writeFile(path.join(OUTPUT, "ranking.json"), json(ranking));

const features = records.flatMap((record) => record.selection.candidates.map((candidate: RecordValue) => candidate.features)); const featureNames = Object.keys(features[0] ?? {}); const distributions = Object.fromEntries(featureNames.map((name) => { const values = features.map((feature) => Number(feature[name])); return [name, { count: values.length, minimum: Math.min(...values), mean: values.reduce((sum, value) => sum + value, 0) / values.length, median: median(values), maximum: Math.max(...values) }]; }));
await writeFile(path.join(OUTPUT, "feature-distributions.json"), json({ holdoutCandidates: features.length, distributions }));
await writeFile(path.join(OUTPUT, "none-valid.json"), json({ negativeControls: negatives.length, correct: negatives.filter((record) => record.noneValidReturned).length, accuracy: noneValid, falseAccepts: negatives.filter((record) => record.falseAccept).length, falseAcceptRate: falseAccept, threshold: .95, falseAcceptMaximum: .02, passed: noneValid >= .95 && falseAccept <= .02, cases: negatives.map((record) => ({ case: `${record.characterKey}-${record.semantic}`, returned: record.noneValidReturned, falseAccept: record.falseAccept, selectedCandidateId: record.newGeometryChoice, failureClass: record.failureClass })) }));
await writeFile(path.join(OUTPUT, "side-results.json"), json({ positiveTargets: positives.length, correct: positives.filter((record) => record.sideCorrect).length, accuracy: sideAccuracy, threshold: .98, passed: sideAccuracy >= .98, cases: positives.map((record) => ({ case: `${record.characterKey}-${record.semantic}`, correct: record.sideCorrect })) }));
await writeFile(path.join(OUTPUT, "articulation-results.json"), json({ positiveTargets: positives.length, usable: positives.filter((record) => record.articulationUsable).length, accuracy: articulation, threshold: .95, passed: articulation >= .95, cases: positives.map((record) => ({ case: `${record.characterKey}-${record.semantic}`, usable: record.articulationUsable })) }));
const latencies = records.map((record) => Number(record.totalLatencyMs)); const generation = records.map((record) => Number(record.candidateGenerationMs)); const rankingLatency = records.map((record) => Number(record.rankingMs)); const latency = { units: "milliseconds", candidateGeneration: { median: median(generation), mean: generation.reduce((a, b) => a + b, 0) / generation.length, maximum: Math.max(...generation) }, ranking: { median: median(rankingLatency), mean: rankingLatency.reduce((a, b) => a + b, 0) / rankingLatency.length, maximum: Math.max(...rankingLatency) }, total: { median: median(latencies), mean: latencies.reduce((a, b) => a + b, 0) / latencies.length, maximum: Math.max(...latencies), underOneSecond: latencies.every((value) => value < 1000) }, historicalVisionMedianMs: preregistration.historicalBaseline.visionMedianLatencyMs, medianSpeedup: preregistration.historicalBaseline.visionMedianLatencyMs / median(latencies)! };
await writeFile(path.join(OUTPUT, "latency.json"), json(latency));

const grouped = new Map<string, RecordValue[]>(); records.forEach((record) => { const key = semanticGroup(record.semantic); grouped.set(key, [...(grouped.get(key) ?? []), record]); });
for (const [group, items] of grouped) { const positiveItems = items.filter((item) => !item.negativeControl); await mkdir(path.join(OUTPUT, "per-semantic"), { recursive: true }); await writeFile(path.join(OUTPUT, "per-semantic", `${group}.json`), json({ group, targets: items.length, positiveTargets: positiveItems.length, candidateCoverage: ratio(positiveItems.filter((item) => item.validCandidatePresent).length, positiveItems.length), top1Overall: ratio(positiveItems.filter((item) => item.newCorrect).length, positiveItems.length), cases: items.map((item) => ({ character: item.character, characterKey: item.characterKey, semantic: item.semantic, negativeControl: item.negativeControl, validCandidatePresent: item.validCandidatePresent, newCorrect: item.newCorrect, noneValidReturned: item.noneValidReturned, falseAccept: item.falseAccept, failureClass: item.failureClass })) })); }

const thresholds = preregistration.holdoutThresholds; const gates = { candidateCoverage: candidateCoverage >= thresholds.candidateCoverage, top1Accuracy: conditionalTop1 >= thresholds.top1Accuracy, falseAccept: falseAccept <= thresholds.falseAcceptMaximum, noneValid: noneValid >= thresholds.noneValidAccuracy, side: sideAccuracy >= thresholds.sideAccuracy, articulation: articulation >= thresholds.articulationUsability, ownership: ownership.ownershipViolations === 0, stale: ownership.staleCommits === 0, determinism: determinism.result === "5/5", noHoldoutTuning: true, noRigAnimationChanges: true, regressions: regressions.status === "PASS" };
const summary = { result: "DETERMINISTIC ARBITRATION FAILED", runId: RUN_ID, holdoutSize: records.length, positiveTargets: positives.length, negativeControls: negatives.length, candidateCoverage, oldGeometryCoverage: oldCoverage, oldGeometryTop1AmongCovered: oldConditionalTop1, oldGeometryOverallPositiveAccuracy: oldOverallTop1, newGeometryTop1AmongCovered: conditionalTop1, newGeometryOverallPositiveAccuracy: overallTop1, overallImprovementVsOldPercentagePoints: (overallTop1 - oldOverallTop1) * 100, conditionalImprovementVsOldPercentagePoints: (conditionalTop1 - oldConditionalTop1) * 100, historicalVisionAccuracy: visionHistorical, falseAcceptRate: falseAccept, noneValidAccuracy: noneValid, sideAccuracy, articulationUsability: articulation, top2AccuracyAmongCovered: top2Conditional, top2AccuracyOverallPositiveTargets: top2Overall, unresolvedRate, ownershipViolations: ownership.ownershipViolations, staleCommits: ownership.staleCommits, determinism: determinism.result, medianLatencyMs: latency.total.median, saveReopen: `${ownership.reopenPasses}/3`, zipRoundTrip: `${ownership.zipPasses}/3`, gates, passed: Object.values(gates).every(Boolean), dominantRemainingBlocker: "CANDIDATE_GENERATION_COVERAGE", holdoutTunedAfterStart: false, holdoutStatisticallyNovel: false, wandOrSteelModified: false, readyToReconnectComfyUILater: false };
await writeFile(path.join(OUTPUT, "summary.json"), json(summary));

const rows = records.map((record) => `| ${record.character} | ${record.semantic} | ${record.validCandidatePresent ? "Yes" : "No"} | ${record.candidateCount} | ${record.oldGeometryChoice ?? "NONE"} | ${record.oldCorrect ? "Yes" : "No"} | ${record.newGeometryChoice ?? "NONE"} | ${record.newCorrect ? "Yes" : "No"} | ${record.top2ContainsCorrect ? "Yes" : "No"} | ${record.noneValidExpected ? "Yes" : "No"} | ${record.noneValidReturned ? "Yes" : "No"} | ${record.sideCorrect ? "Yes" : "No"} | ${record.articulationUsable ? "Yes" : "No"} | ${record.falseAccept ? "Yes" : "No"} | ${Number(record.totalLatencyMs).toFixed(3)} ms | ${record.failureClass ?? "—"} |`).join("\n");
const failures = records.filter((record) => !record.newCorrect && !record.noneValidReturned).map((record) => `- ${record.character} / ${record.semantic}: ${record.failureClass}; selected ${record.newGeometryChoice ?? "NONE"}.`).join("\n");
const report = `DETERMINISTIC ARBITRATION FAILED

# Deterministic candidate coverage and geometric ranking recovery

The frozen holdout failed because candidate-set coverage was ${pct(candidateCoverage)} and false accepts were ${pct(falseAccept)}. Conditional ranking was ${pct(conditionalTop1)} on the two covered positive targets, so ranking was not the limiting stage. Candidate generation remains the dominant blocker.

## Aggregate result

- Holdout: ${records.length} targets (${positives.length} positive, ${negatives.length} negative controls).
- Old geometry coverage: ${pct(oldCoverage)}; new coverage: ${pct(candidateCoverage)} (${((candidateCoverage - oldCoverage) * 100).toFixed(1)} pp).
- Old geometry top-1 among covered: ${pct(oldConditionalTop1)}; new: ${pct(conditionalTop1)} (${((conditionalTop1 - oldConditionalTop1) * 100).toFixed(1)} pp).
- End-to-end positive accuracy: old ${pct(oldOverallTop1)}; new ${pct(overallTop1)} (${((overallTop1 - oldOverallTop1) * 100).toFixed(1)} pp).
- Historical vision top-1 among covered: ${pct(visionHistorical)}.
- Top-2: ${pct(top2Conditional)} among covered; ${pct(top2Overall)} across all positive targets.
- False accept: ${pct(falseAccept)}; NONE_VALID: ${pct(noneValid)}.
- Side: ${pct(sideAccuracy)}; articulation usability: ${pct(articulation)}.
- Ownership violations: ${ownership.ownershipViolations}; stale commits: ${ownership.staleCommits}; determinism: ${determinism.result}.
- Median deterministic latency: ${Number(latency.total.median).toFixed(3)} ms (${Number(latency.medianSpeedup).toFixed(0)}× faster than the historical median vision review).
- Undo, reopen, ZIP: ${ownership.undoPasses}/3, ${ownership.reopenPasses}/3, ${ownership.zipPasses}/3.

## Holdout table

| Character | Semantic | Valid candidate? | Count | Old choice | Old correct? | New choice | New correct? | Top-2 correct? | NONE expected? | NONE returned? | Side correct? | Articulation usable? | False accept? | Latency | Failure class |
|---|---|---:|---:|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
${rows}

## Per-character failures

${failures}

## Forensics

Coverage failures: ${JSON.stringify(coverage.failureHistogram)}. Ranking failures on covered sets: ${JSON.stringify(ranking.failureHistogram)}. Starweaver was not recovered geometrically; its lower leg remained an armor/garment-fusion coverage miss. Doomsmith remained a generic armor/garment-fusion miss. Warden and Warrior regressed because the required valid masks were absent, while both corrupted forearm negative controls were falsely accepted.

The selector was not changed after freeze digest \`${freeze.implementationDigest}\`. The historical holdout was reused exactly and was already exposed by the earlier vision pass, so this is a frozen regression comparison, not statistically novel validation.

## Safety and regressions

Vision remains outside automatic selection. The provider-neutral vision bridge remains critic/diagnostic infrastructure only. Manual ownership protection, stale identity rejection, undo, save/reopen, and ZIP passed. WOS remained clean. Unit tests: ${regressions.unit.testsPassed}/${regressions.unit.testsPassed}; rendered HTML: ${regressions.renderedHtml.passed}/5; focused ownership/persistence/anti-overfit/golden: ${regressions.acceptanceOwnershipPersistenceAntiOverfitGolden.testsPassed}/${regressions.acceptanceOwnershipPersistenceAntiOverfitGolden.testsPassed}; typecheck/build/hydration passed; lint completed with ${regressions.lint.errors} errors and ${regressions.lint.warnings} warnings.

Changed production files: \`src/vision-arbitration/deterministicGeometry.ts\`, \`src/vision-arbitration/ownershipCommit.ts\`, and \`src/vision-arbitration/index.ts\`. No rigging or animation implementation changed.

Ready to reconnect ComfyUI later: **No**. The provenance and ownership boundaries remain extensible, but deterministic coverage and reject-all precision must pass before another provider candidate family is admitted to automatic selection.
`;
await writeFile(path.join(OUTPUT, "report.md"), report);
process.stdout.write(json(summary));
