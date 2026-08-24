/* eslint-disable @typescript-eslint/no-explicit-any -- comparison consumes heterogeneous versioned evidence JSON */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

type Summary = Record<string, any>;
const ROOT = resolve(import.meta.dirname, "../..");

const round = (value: number, precision = 3): number => Number(value.toFixed(precision));
const delta = (before: number | null | undefined, after: number | null | undefined): number | null => before == null || after == null ? null : round(after - before);
const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, "-");
const table = (headers: string[], rows: unknown[][]): string => [
  `| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => `| ${row.map((value) => String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ")).join(" | ")} |`),
].join("\n");

async function resolveRun(input: string): Promise<{ dir: string; summary: Summary }> {
  const direct = resolve(input); const candidates = [direct, join(direct, "summary.json"), join(ROOT, ".rigging-studio/diagnostics/ux-inspection", input, "summary.json")];
  for (const candidate of candidates) {
    const path = candidate.endsWith(".json") ? candidate : join(candidate, "summary.json");
    try { await access(path); return { dir: resolve(path, ".."), summary: JSON.parse(await readFile(path, "utf8")) as Summary }; } catch { /* continue */ }
  }
  throw new Error(`Could not locate an inspection summary for ${input}`);
}

function countsBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => { const value = key(item); counts[value] = (counts[value] ?? 0) + 1; return counts; }, {});
}

function numericMapDiff(before: Record<string, number>, after: Record<string, number>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().map((key) => ({ key, before: before[key] ?? 0, after: after[key] ?? 0, delta: (after[key] ?? 0) - (before[key] ?? 0) }));
}

function panelRows(before: Summary, after: Summary) {
  const keys = [...new Set([...Object.keys(before.panels ?? {}), ...Object.keys(after.panels ?? {})])].sort();
  return keys.flatMap((key) => ["topRail", "leftRail", "rightRail", "bottomRail", "timeline"].flatMap((panel) => {
    const a = before.panels?.[key]?.[panel]?.bounds; const b = after.panels?.[key]?.[panel]?.bounds;
    if (!a && !b) return [];
    return [{ capture: key, panel, beforeWidth: a?.width ?? null, afterWidth: b?.width ?? null, widthDelta: delta(a?.width, b?.width), beforeHeight: a?.height ?? null, afterHeight: b?.height ?? null, heightDelta: delta(a?.height, b?.height) }];
  }));
}

function canvasRows(before: Summary, after: Summary) {
  const keys = [...new Set([...Object.keys(before.canvas ?? {}), ...Object.keys(after.canvas ?? {})])].sort();
  return keys.map((key) => ({ capture: key, before: before.canvas?.[key]?.visibleAreaRatio ?? null, after: after.canvas?.[key]?.visibleAreaRatio ?? null, delta: delta(before.canvas?.[key]?.visibleAreaRatio, after.canvas?.[key]?.visibleAreaRatio) }));
}

function bottomRows(before: Summary, after: Summary) {
  const keys = [...new Set([...Object.keys(before.bottomRail ?? {}), ...Object.keys(after.bottomRail ?? {})])].sort();
  return keys.map((key) => ({ capture: key, beforeDepth: before.bottomRail?.[key]?.totalOccupiedVerticalDepth ?? null, afterDepth: after.bottomRail?.[key]?.totalOccupiedVerticalDepth ?? null, delta: delta(before.bottomRail?.[key]?.totalOccupiedVerticalDepth, after.bottomRail?.[key]?.totalOccupiedVerticalDepth) }));
}

function buttonDimensionRows(before: Summary, after: Summary) {
  const index = (summary: Summary) => Object.fromEntries((summary.buttons ?? []).map((button: any) => [`${button.state}@${button.viewport}|${button.label}`, button]));
  const a = index(before); const b = index(after); const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap((key) => {
    if (!a[key] || !b[key]) return [];
    const widthDelta = delta(a[key].width, b[key].width); const heightDelta = delta(a[key].height, b[key].height);
    if (widthDelta === 0 && heightDelta === 0) return [];
    return [{ control: key, beforeWidth: a[key].width, afterWidth: b[key].width, widthDelta, beforeHeight: a[key].height, afterHeight: b[key].height, heightDelta }];
  });
}

function buildComparison(before: Summary, after: Summary) {
  const fontSizeCounts = numericMapDiff(before.typography?.sizeCounts ?? {}, after.typography?.sizeCounts ?? {});
  const primaryCounts = numericMapDiff(countsBy(before.primaryCandidates ?? [], (item: any) => `${item.state}@${item.viewport}`), countsBy(after.primaryCandidates ?? [], (item: any) => `${item.state}@${item.viewport}`));
  const consoleErrors = (summary: Summary) => (summary.console ?? []).filter((item: any) => item.type === "console.error" || item.type === "pageerror").length;
  const uniqueConsole = (summary: Summary) => summary.consoleSummary?.uniqueCount ?? new Set((summary.console ?? []).map((item: any) => `${item.type}|${item.text}`)).size;
  const uniqueNetwork = (summary: Summary) => summary.networkSummary?.uniqueCount ?? new Set((summary.network ?? []).map((item: any) => `${item.method}|${item.url}|${item.status ?? item.text}`)).size;
  return {
    schemaVersion: 1,
    before: { id: before.run?.id, directory: before.run?.directory, url: before.run?.baseUrl }, after: { id: after.run?.id, directory: after.run?.directory, url: after.run?.baseUrl },
    fontSizeCounts, buttonDimensions: buttonDimensionRows(before, after), canvasArea: canvasRows(before, after), bottomOccupiedDepth: bottomRows(before, after), primaryCandidateCounts: primaryCounts,
    overflowCount: { before: before.overflow?.length ?? 0, after: after.overflow?.length ?? 0, delta: (after.overflow?.length ?? 0) - (before.overflow?.length ?? 0) },
    consoleErrorCount: { before: consoleErrors(before), after: consoleErrors(after), delta: consoleErrors(after) - consoleErrors(before) },
    uniqueConsoleCount: { before: uniqueConsole(before), after: uniqueConsole(after), delta: uniqueConsole(after) - uniqueConsole(before) },
    networkCount: { before: before.network?.length ?? 0, after: after.network?.length ?? 0, delta: (after.network?.length ?? 0) - (before.network?.length ?? 0) },
    uniqueNetworkCount: { before: uniqueNetwork(before), after: uniqueNetwork(after), delta: uniqueNetwork(after) - uniqueNetwork(before) },
    panelSizes: panelRows(before, after),
  };
}

function buildMarkdown(comparison: ReturnType<typeof buildComparison>): string {
  return `# Rig Studio UX inspection comparison

This is a factual delta report. It does not select a winner.

${table(["Run", "ID", "URL"], [["Before", comparison.before.id, comparison.before.url], ["After", comparison.after.id, comparison.after.url]])}

## Font size counts

${table(["Bucket", "Before", "After", "Delta"], comparison.fontSizeCounts.map((row) => [row.key, row.before, row.after, row.delta]))}

## Button dimension changes

${comparison.buttonDimensions.length ? table(["Control", "Width before", "Width after", "Δ width", "Height before", "Height after", "Δ height"], comparison.buttonDimensions.map((row) => [row.control, row.beforeWidth, row.afterWidth, row.widthDelta, row.beforeHeight, row.afterHeight, row.heightDelta])) : "No button width or height deltas were detected for matching control keys."}

## Canvas visible-area ratio

${table(["Capture", "Before", "After", "Delta"], comparison.canvasArea.map((row) => [row.capture, row.before, row.after, row.delta]))}

## Bottom occupied depth

${table(["Capture", "Before", "After", "Delta (px)"], comparison.bottomOccupiedDepth.map((row) => [row.capture, row.beforeDepth, row.afterDepth, row.delta]))}

## Primary-candidate counts

${table(["Capture", "Before", "After", "Delta"], comparison.primaryCandidateCounts.map((row) => [row.key, row.before, row.after, row.delta]))}

## Overflow and console errors

${table(["Metric", "Before", "After", "Delta"], [["Overflow observations", comparison.overflowCount.before, comparison.overflowCount.after, comparison.overflowCount.delta], ["console.error + uncaught", comparison.consoleErrorCount.before, comparison.consoleErrorCount.after, comparison.consoleErrorCount.delta], ["Unique console signatures", comparison.uniqueConsoleCount.before, comparison.uniqueConsoleCount.after, comparison.uniqueConsoleCount.delta], ["Network failures", comparison.networkCount.before, comparison.networkCount.after, comparison.networkCount.delta], ["Unique endpoint/failure pairs", comparison.uniqueNetworkCount.before, comparison.uniqueNetworkCount.after, comparison.uniqueNetworkCount.delta]])}

## Panel sizes

${table(["Capture", "Panel", "Width before", "Width after", "Δ width", "Height before", "Height after", "Δ height"], comparison.panelSizes.map((row) => [row.capture, row.panel, row.beforeWidth, row.afterWidth, row.widthDelta, row.beforeHeight, row.afterHeight, row.heightDelta]))}
`;
}

async function main() {
  const args = process.argv.slice(2).filter((item) => !item.startsWith("--output"));
  if (args.length < 2) throw new Error("Usage: npm run ux:compare -- <before-run-directory-or-id> <after-run-directory-or-id> [--output path]");
  const outputInline = process.argv.slice(2).find((item) => item.startsWith("--output="))?.slice("--output=".length);
  const outputIndex = process.argv.indexOf("--output"); const outputArg = outputInline ?? (outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined);
  const [beforeRun, afterRun] = await Promise.all([resolveRun(args[0]), resolveRun(args[1])]);
  if (beforeRun.summary.schemaVersion !== afterRun.summary.schemaVersion) throw new Error(`Schema versions differ (${beforeRun.summary.schemaVersion} vs ${afterRun.summary.schemaVersion})`);
  const comparison = buildComparison(beforeRun.summary, afterRun.summary); const markdown = buildMarkdown(comparison);
  const outputDirectory = outputArg ? resolve(outputArg).endsWith(".md") ? resolve(outputArg, "..") : resolve(outputArg) : join(afterRun.dir, "comparisons");
  await mkdir(outputDirectory, { recursive: true });
  const base = `${safeName(beforeRun.summary.run?.id ?? basename(beforeRun.dir))}-to-${safeName(afterRun.summary.run?.id ?? basename(afterRun.dir))}`;
  const markdownPath = outputArg?.endsWith(".md") ? resolve(outputArg) : join(outputDirectory, `${base}.md`); const jsonPath = markdownPath.replace(/\.md$/i, ".json");
  await writeFile(markdownPath, `${markdown.trim()}\n`, "utf8"); await writeFile(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
  process.stdout.write(`${markdown.trim()}\n\nArtifacts:\n- ${markdownPath}\n- ${jsonPath}\n`);
}

await main();
