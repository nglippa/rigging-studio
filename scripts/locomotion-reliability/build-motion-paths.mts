import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd(); const RUN_ID = "2026-08-23T09-30-00Z"; const OUT = path.join(ROOT, ".rigging-studio/diagnostics/locomotion-reliability", RUN_ID); const TARGET = path.join(OUT, "motion-paths");
const data = JSON.parse(await readFile(path.join(OUT, "run-results.json"), "utf8")) as { characters: Array<{ letter: string; name: string; clips: Array<{ gait: string; meanHeightDrift: number; maxHeightDrift: number; plan: { footTargets: { left: Array<{ phase: number; x: number; y: number; clamped: boolean }>; right: Array<{ phase: number; x: number; y: number; clamped: boolean }> } } }> }> };
const esc = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
await mkdir(TARGET, { recursive: true }); const files = [];
for (const character of data.characters) for (const clip of character.clips) {
  const all = [...clip.plan.footTargets.left, ...clip.plan.footTargets.right]; const xs = all.map((point) => point.x); const ys = all.map((point) => point.y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys); const scaleX = 700 / Math.max(1, maxX - minX); const scaleY = 260 / Math.max(1, maxY - minY);
  const point = (value: { x: number; y: number }): string => `${100 + (value.x - minX) * scaleX},${110 + (value.y - minY) * scaleY}`;
  const polyline = (values: typeof all, color: string, label: string): string => `<polyline points="${values.map(point).join(" ")}" fill="none" stroke="${color}" stroke-width="4"/><text x="${label === "LEFT" ? 100 : 690}" y="410" fill="${color}" font-family="ui-monospace,monospace" font-size="16">${label}</text>${values.map((value) => `<circle cx="${point(value).split(",")[0]}" cy="${point(value).split(",")[1]}" r="${value.clamped ? 7 : 4}" fill="${value.clamped ? "#f6b34b" : color}"/>`).join("")}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="450" viewBox="0 0 900 450"><rect width="900" height="450" fill="#070a14"/><text x="28" y="38" fill="#f3f6ff" font-family="ui-monospace,monospace" font-size="22" font-weight="700">${esc(`${character.letter} · ${character.name} · ${clip.gait.toUpperCase()} FOOT TARGET PATH`)}</text><text x="28" y="68" fill="#9ba9c6" font-family="ui-monospace,monospace" font-size="14">mean/max height drift ${(clip.meanHeightDrift * 100).toFixed(2)}%/${(clip.maxHeightDrift * 100).toFixed(2)}% · orange = reach clamp · in-place world targets</text><line x1="80" y1="370" x2="820" y2="370" stroke="#48516a" stroke-dasharray="7 7"/>${polyline(clip.plan.footTargets.left, "#62c7ff", "LEFT")}${polyline(clip.plan.footTargets.right, "#ff7f72", "RIGHT")}</svg>`;
  const file = path.join(TARGET, `${character.letter.toLowerCase()}-${clip.gait}-foot-path.svg`); await writeFile(file, svg); files.push(path.relative(OUT, file));
}
await writeFile(path.join(OUT, "motion-paths.json"), `${JSON.stringify({ runId: RUN_ID, files }, null, 2)}\n`); process.stdout.write(`${JSON.stringify({ count: files.length, directory: path.relative(ROOT, TARGET) }, null, 2)}\n`);
