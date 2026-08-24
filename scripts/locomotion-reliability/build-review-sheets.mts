import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = process.cwd(); const RUN_ID = "2026-08-23T09-30-00Z";
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/locomotion-reliability", RUN_ID);
const UI = path.join(OUT, "screenshots/ui"); const SHEETS = path.join(OUT, "review-sheets");
const result = JSON.parse(await readFile(path.join(OUT, "run-results.json"), "utf8")) as { characters: Array<{ letter: string; name: string; clips: Array<{ gait: "walk" | "run"; duration: number; significantManualCorrections: number; meanHeightDrift: number; maxHeightDrift: number; maxLegDrift: number; visualClass: string; plan: { cadenceHz: number; stride: number; pelvisBob: number; targetClampCount: number; hockTracks: string[] } }> }> };
const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
await mkdir(SHEETS, { recursive: true });

const sheets = [];
for (const character of result.characters) for (const gait of ["walk", "run"] as const) {
  const metrics = character.clips.find((clip) => clip.gait === gait)!;
  const phases = gait === "walk" ? ["contact", "passing", "opposite"] : ["contact", "flight", "opposite"];
  const panels = await Promise.all(phases.map(async (phase) => sharp(path.join(UI, `${character.letter.toLowerCase()}-${gait}-${phase}-1440x900.png`)).resize(640, 400, { fit: "fill" }).png().toBuffer()));
  const title = `${character.letter} · ${character.name} · ${gait.toUpperCase()} · ${metrics.visualClass}`;
  const detail = `${metrics.duration.toFixed(3)}s · mean/max height drift ${(metrics.meanHeightDrift * 100).toFixed(2)}%/${(metrics.maxHeightDrift * 100).toFixed(2)}% · fixes ${metrics.significantManualCorrections} · ${metrics.plan.cadenceHz.toFixed(3)} Hz · stride ${metrics.plan.stride.toFixed(1)} px · bob ${metrics.plan.pelvisBob.toFixed(1)} px · clamps ${metrics.plan.targetClampCount}${metrics.plan.hockTracks.length ? ` · hocks ${metrics.plan.hockTracks.length}` : ""}`;
  const overlay = Buffer.from(`<svg width="1920" height="500" xmlns="http://www.w3.org/2000/svg">
    <rect width="1920" height="100" fill="#070a14"/><text x="24" y="34" fill="#f5f7ff" font-family="ui-monospace, monospace" font-size="24" font-weight="700">${escape(title)}</text>
    <text x="24" y="64" fill="#98a6c7" font-family="ui-monospace, monospace" font-size="15">${escape(detail)}</text>
    ${phases.map((phase, index) => `<rect x="${index * 640}" y="72" width="640" height="28" fill="${index % 2 ? "#1a1530" : "#10172a"}"/><text x="${index * 640 + 20}" y="92" fill="#8fe8ff" font-family="ui-monospace, monospace" font-size="15" font-weight="700">PHASE ${(index === 0 ? 0 : index === 1 ? .25 : .5).toFixed(2)} · ${phase.toUpperCase()}</text>`).join("")}
  </svg>`);
  const file = path.join(SHEETS, `${character.letter.toLowerCase()}-${gait}-review.png`);
  await sharp({ create: { width: 1920, height: 500, channels: 4, background: "#070a14" } }).composite([
    ...panels.map((input, index) => ({ input, left: index * 640, top: 100 })), { input: overlay, left: 0, top: 0 },
  ]).png().toFile(file);
  sheets.push({ letter: character.letter, character: character.name, gait, phases, file: path.relative(OUT, file), metrics: { visualClass: metrics.visualClass, maxHeightDrift: metrics.maxHeightDrift, maxLegDrift: metrics.maxLegDrift, ...metrics.plan } });
}
await writeFile(path.join(OUT, "review-sheets.json"), `${JSON.stringify({ runId: RUN_ID, sheets }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ sheets: sheets.length, directory: path.relative(ROOT, SHEETS) }, null, 2)}\n`);
