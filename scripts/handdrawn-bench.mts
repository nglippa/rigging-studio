/**
 * Hand-drawn bench: scores rigged animation against hand-animated pixel art on the frames a game displays.
 *
 *   npx tsx scripts/handdrawn-bench.mts            all rigs in tests/fixtures/bench-rigs, all hand-drawn references
 *   npx tsx scripts/handdrawn-bench.mts --strips   also writes each clip's drawings side by side to .bench/
 *
 * References (tests/fixtures/handdrawn, CC0): DezrasDragons' Samurai idle/run/attack GIFs, played with their own frame
 * durations. Rigs: saved from the app after Cut all parts and Build rig (window.__RIG_STUDIO_RIG_SNAPSHOT__); their clips
 * are rebuilt here with the current motion code, so motion and rendering changes are measured without the browser.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { buildStandardClips } from "../src/rigging/motion/rigMotion";
import { maskElongation } from "../src/character-generation/rigging/rigProposalBuilder";
import { framesWindow, pixelScaleOf, renderClip, renderPixelFrame, type PartPixels } from "../src/rigging/export/pixelFrames";
import { scoreAnimation, drawingsOf, type BenchScores } from "../src/rigging/export/handDrawnBench";
import { createRestPose } from "../src/rigging/runtime/pose";
import type { RgbaImage } from "../src/rigging/rendering/rotsprite";
import type { RigDefinition } from "../src/rigging/schema/types";

const root = path.resolve(import.meta.dirname, "..");
const strips = process.argv.includes("--strips"); const handOnly = process.argv.includes("--hand");
const out = path.join(root, ".bench"); if (strips) mkdirSync(out, { recursive: true });
const decode = (bytes: Buffer): RgbaImage => { const png = PNG.sync.read(bytes); return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) }; };

function writeStrip(name: string, frames: readonly RgbaImage[]): void {
  if (!strips || !frames.length) return;
  const { drawings } = drawingsOf(frames); const shown = drawings.slice(0, 24);
  const width = shown.reduce((sum, frame) => sum + frame.width, 0); const height = Math.max(...shown.map((frame) => frame.height));
  const png = new PNG({ width, height }); let left = 0;
  for (const frame of shown) {
    for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
      const from = (y * frame.width + x) * 4; const to = (y * width + left + x) * 4;
      const a = frame.data[from + 3] / 255; const back = ((x >> 3) + (y >> 3)) % 2 ? 46 : 58;
      for (let c = 0; c < 3; c += 1) png.data[to + c] = Math.round(frame.data[from + c] * a + back * (1 - a)); png.data[to + 3] = 255;
    }
    left += frame.width;
  }
  writeFileSync(path.join(out, `${name}.png`), PNG.sync.write(png));
}

const rows: { readonly source: string; readonly clip: string; readonly scores: BenchScores }[] = [];

// Hand-drawn references: GIF frames expanded to 100 ticks a second by their own durations.
const handDir = path.join(root, "tests/fixtures/handdrawn");
for (const name of readdirSync(handDir).filter((file) => file.endsWith(".gif"))) {
  const gif = path.join(handDir, name); const work = mkdtempSync(path.join(tmpdir(), "hd-"));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", gif, "-fps_mode", "passthrough", path.join(work, "f%03d.png")]);
  const durations = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=duration_time", "-of", "csv=p=0", gif]).toString().trim().split("\n").map(Number);
  const images = readdirSync(work).filter((file) => file.endsWith(".png")).sort().map((file) => decode(readFileSync(path.join(work, file))));
  const frames = images.flatMap((image, index) => Array.from({ length: Math.max(1, Math.round((durations[index] ?? .1) * 100)) }, () => image));
  rows.push({ source: "hand-drawn", clip: name.replace(/\.gif$/, ""), scores: scoreAnimation(frames, 100, images[0]) });
  writeStrip(`hand-${name.replace(/\.gif$/, "")}`, frames);
}

// Rigs, with their clips rebuilt by the current motion code and rendered as the game renderer would.
const rigDir = path.join(root, "tests/fixtures/bench-rigs");
for (const name of handOnly ? [] : readdirSync(rigDir).filter((file) => file.endsWith(".rig.json"))) {
  const rig = JSON.parse(readFileSync(path.join(rigDir, name), "utf8")) as RigDefinition;
  const pixels: Record<string, RgbaImage> = {};
  for (const attachment of rig.attachments) {
    const match = /^data:image\/png;base64,([^#]+)/.exec(attachment.imagePath);
    if (match) pixels[attachment.id] = decode(Buffer.from(match[1], "base64"));
  }
  // Rigs saved before held items' shapes were recorded get them from their art, as a rebuild would.
  if (!rig.metadata.equipmentElongation) (rig as { metadata: Record<string, unknown> }).metadata = { ...rig.metadata, equipmentElongation: Object.fromEntries(rig.attachments.filter((attachment) => attachment.category === "equipment" && pixels[attachment.id]).map((attachment) => { const image = pixels[attachment.id]; return [attachment.id, maskElongation({ width: image.width, height: image.height, alpha: Array.from({ length: image.width * image.height }, (_, i) => image.data[i * 4 + 3]) }) ?? 1]; })) };
  const canvas = { x: 0, y: 0, width: rig.canvas?.width ?? 256, height: rig.canvas?.height ?? 256 };
  const restFull = renderPixelFrame(rig, createRestPose(rig), pixels as PartPixels, canvas);
  // The rest frame comes back at the art's own resolution for true-pixel rigs; the window is given in picture pixels.
  const k = pixelScaleOf(rig); const nativeFigure = framesWindow([restFull], { x: 0, y: 0, width: restFull.width, height: restFull.height }, 0);
  const figure = { x: (Math.floor(canvas.x / k) + nativeFigure.x) * k, y: (Math.floor(canvas.y / k) + nativeFigure.y) * k, width: nativeFigure.width * k, height: nativeFigure.height * k };
  // Room for limbs and weapons to swing: half the figure's size on every side.
  const window = { x: figure.x - Math.round(figure.width / 2), y: figure.y - Math.round(figure.height / 2), width: figure.width * 2, height: figure.height * 2 };
  const still = renderPixelFrame(rig, createRestPose(rig), pixels as PartPixels, window);
  const character = name.replace(/\.rig\.json$/, "");
  for (const clip of buildStandardClips(rig)) {
    const { frames, fps } = renderClip(rig, clip, pixels as PartPixels, { fps: 60, window });
    rows.push({ source: character, clip: clip.id, scores: scoreAnimation(frames, fps, still) });
    writeStrip(`${character}-${clip.id}`, frames);
  }
}

const fixed = (value: number, digits = 2) => value.toFixed(digits).padStart(7);
console.log(`${"source".padEnd(16)}${"clip".padEnd(18)}  px  offGrid newCol  flicker  strays   gaps  drawings  /sec  holdVar`);
for (const { source, clip, scores } of rows) {
  console.log(`${source.padEnd(16)}${clip.padEnd(18)}${String(scores.pixelSize).padStart(4)}${fixed(scores.offGrid, 3)}${fixed(scores.newColours, 3)}${fixed(scores.flicker, 1)}${fixed(scores.strays, 1)}${fixed(scores.gaps, 1)}${String(scores.drawings).padStart(9)}${fixed(scores.drawingsPerSecond, 1)}${fixed(scores.holdVariation)}`);
}
// The bench: each rigged clip must score like the hand-drawn references (their worst value, with a margin).
const ACTIONS = new Set(["melee_attack", "hurt", "death"]);
const failures = (clip: string, scores: BenchScores): string[] => [
  scores.offGrid > .01 ? `off-grid ${scores.offGrid.toFixed(3)}` : "",
  scores.newColours > .01 ? `new colours ${scores.newColours.toFixed(3)}` : "",
  scores.flicker > 1.5 ? `flicker ${scores.flicker.toFixed(1)}` : "",
  scores.strays > .5 ? `strays ${scores.strays.toFixed(1)}` : "",
  scores.gaps > .5 ? `gaps ${scores.gaps.toFixed(1)}` : "",
  scores.drawingsPerSecond < 6 || scores.drawingsPerSecond > 16 ? `${scores.drawingsPerSecond.toFixed(1)} drawings/s` : "",
  ACTIONS.has(clip) && scores.holdVariation < .35 ? `even holds ${scores.holdVariation.toFixed(2)}` : "",
].filter(Boolean);
let passed = 0; let total = 0;
for (const { source, clip, scores } of rows) {
  if (source === "hand-drawn") continue;
  const failed = failures(clip, scores); total += 1; if (!failed.length) passed += 1;
  console.log(`${failed.length ? "FAIL" : "PASS"}  ${source} ${clip}${failed.length ? `: ${failed.join(", ")}` : ""}`);
}
console.log(`\n${passed} / ${total} rigged clips meet the hand-drawn bench`);
writeFileSync(path.join(root, "tests/fixtures/bench-rigs/last-report.json"), `${JSON.stringify(rows, null, 2)}\n`);
