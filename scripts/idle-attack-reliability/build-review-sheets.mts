import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = process.cwd(); const RUN_ID = "2026-08-23T10-43-00Z"; const OUT = path.join(ROOT, ".rigging-studio/diagnostics/idle-attack-reliability", RUN_ID);
const UI = path.join(OUT, "screenshots/ui"); const SHEETS = path.join(OUT, "review-sheets");
type Clip = { kind: "idle" | "attack"; duration: number; tracks: number; keyframes: number; significantManualCorrections: number; meanHeightDrift: number; maxHeightDrift: number; visualClass: string; gripError: { meanHeight: number; maxHeight: number }; weaponPath: { teleportRatio: number } | null; plan: { type?: string; archetype: string; topology: string; equipmentConstraints: string[]; hockTracks?: string[] } };
const result = JSON.parse(await readFile(path.join(OUT, "run-results.json"), "utf8")) as { characters: Array<{ letter: string; name: string; clips: Clip[] }> };
const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
await mkdir(SHEETS, { recursive: true }); const sheets = [];

for (const character of result.characters) for (const kind of ["idle", "attack"] as const) {
  const metrics = character.clips.find((clip) => clip.kind === kind)!;
  const phases = kind === "idle" ? ["neutral", "mid-breath", "opposite", "loop-return"] : ["anticipation", "action", "follow-through", "recovery"];
  const panels = await Promise.all(phases.map(async (phase) => sharp(path.join(UI, `${character.letter.toLowerCase()}-${kind}-${phase}.jpg`)).resize(480, 300, { fit: "fill" }).png().toBuffer()));
  const title = `${character.letter} · ${character.name} · ${kind.toUpperCase()} · ${metrics.visualClass}`;
  const detail = kind === "idle"
    ? `${metrics.duration.toFixed(3)}s · ${metrics.tracks} tracks/${metrics.keyframes} keys · mean/max foot drift ${(metrics.meanHeightDrift * 100).toFixed(2)}%/${(metrics.maxHeightDrift * 100).toFixed(2)}% · ${metrics.plan.archetype}/${metrics.plan.topology} · fixes ${metrics.significantManualCorrections}`
    : `${metrics.duration.toFixed(3)}s · ${metrics.plan.type} · ${metrics.tracks} tracks/${metrics.keyframes} keys · support-foot ${(metrics.maxHeightDrift * 100).toFixed(2)}% · grip mean/max ${(metrics.gripError.meanHeight * 100).toFixed(2)}%/${(metrics.gripError.maxHeight * 100).toFixed(2)}% · arc segment ratio ${metrics.weaponPath?.teleportRatio.toFixed(3) ?? "n/a"}`;
  const overlay = Buffer.from(`<svg width="1920" height="420" xmlns="http://www.w3.org/2000/svg"><rect width="1920" height="120" fill="#070a14"/><text x="24" y="36" fill="#f5f7ff" font-family="ui-monospace,monospace" font-size="24" font-weight="700">${escape(title)}</text><text x="24" y="66" fill="#98a6c7" font-family="ui-monospace,monospace" font-size="14">${escape(detail)}</text><text x="24" y="92" fill="#7383a8" font-family="ui-monospace,monospace" font-size="13">${escape(metrics.plan.equipmentConstraints.join(" · ") || "No equipment-specific constraint required")}</text>${phases.map((phase, index) => `<rect x="${index * 480}" y="96" width="480" height="24" fill="${index % 2 ? "#1a1530" : "#10172a"}"/><text x="${index * 480 + 16}" y="113" fill="#8fe8ff" font-family="ui-monospace,monospace" font-size="13" font-weight="700">${phase.toUpperCase()}</text>`).join("")}</svg>`);
  const file = path.join(SHEETS, `${character.letter.toLowerCase()}-${kind}-review.png`);
  await sharp({ create: { width: 1920, height: 420, channels: 4, background: "#070a14" } }).composite([...panels.map((input, index) => ({ input, left: index * 480, top: 120 })), { input: overlay, left: 0, top: 0 }]).png().toFile(file);
  sheets.push({ letter: character.letter, character: character.name, kind, phases, file: path.relative(OUT, file), visualClass: metrics.visualClass });
}
await writeFile(path.join(OUT, "review-sheets.json"), `${JSON.stringify({ runId: RUN_ID, sheets }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ sheets: sheets.length, directory: path.relative(ROOT, SHEETS) }, null, 2)}\n`);
