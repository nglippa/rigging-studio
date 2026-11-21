/**
 * Cut accuracy bench: how much of each character Cut all parts assigns to the right part, against hand-labelled parts.
 *
 *   npx tsx scripts/cut-bench.mts render <name>...   draws the hand labels over the art (to check them) into .bench/cut/
 *   npx tsx scripts/cut-bench.mts score [name...]    cuts each character exactly as the app does and scores it
 *
 * Labels live in tests/fixtures/rigging/part-truth/<name>.json: { image, view, parts: { <semantic>: polygon | polygon[] },
 * equipment?: polygon[] }, polygons in source pixels, limbs named by SCREEN side like the cutter. A pixel of the character
 * takes the first part (in PRIORITY order) whose polygon holds it, so small parts are drawn first and the torso is the
 * catch-all; character pixels left outside every polygon go to the nearest labelled pixel, so polygons need not trace the
 * silhouette exactly, only the seams between parts. Equipment pixels (a held sword) are cut in a later step on the Mac
 * Studio and are left out of the body score.
 *
 * Score: the share of body pixels whose part is right (pixel accuracy), plus each part's IoU. When `pairedLimbs` is set
 * (side and three-quarter views, where which arm is "left" is a name, not a mistake), the arms and the legs may each be
 * swapped as a pair, and the better reading is kept.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { estimateForeground } from "../src/character-generation/segmentation/partImageProcessor";
import { applyCutPlan, planGrid } from "../src/part-cutter/cutPlan";
import { BODY_PARTS, cutAllParts, type LoadedImage } from "./cut-pipeline.mjs";

export { BODY_PARTS };

type Point = readonly [number, number];
type Polygon = readonly Point[];
/**
 * `scribbles`: strokes drawn inside each part (polylines). `parts`: hard regions, used where the art draws no line between
 * two parts (a knee in plain trousers), so the seam is placed by convention. Everything else follows the drawing.
 */
export type PartTruth = { readonly image: string; readonly view: string; readonly pairedLimbs?: boolean; readonly parts?: Readonly<Record<string, Polygon | readonly Polygon[]>>; readonly scribbles?: Readonly<Record<string, Polygon | readonly Polygon[]>>; readonly equipment?: readonly Polygon[]; readonly note?: string };

export const TRUTH_DIR = "tests/fixtures/rigging/part-truth";
export const EQUIPMENT = 255;


export function loadImage(file: string): LoadedImage {
  const png = PNG.sync.read(readFileSync(file));
  const data = new Uint8Array(png.data);
  return { width: png.width, height: png.height, data, foreground: estimateForeground({ width: png.width, height: png.height, data: new Uint8ClampedArray(data.buffer) }).mask };
}

/** Per-pixel truth: 0 background, 1..14 the body part (BODY_PARTS index + 1), 255 equipment. The labels are a cut plan
 * applied exactly as the app applies one (src/part-cutter/cutPlan.ts). */
export function truthLabels(truth: PartTruth, image: LoadedImage): Uint8Array { return applyCutPlan(truth, image); }

export type CutScore = { readonly accuracy: number; readonly bodyPixels: number; readonly iou: Readonly<Record<string, number>>; readonly swapped: string; readonly worst: readonly string[] };

const swaps: Record<string, Record<string, string>> = {
  none: {},
  arms: { leftUpperArm: "rightUpperArm", leftForearm: "rightForearm", leftHand: "rightHand", rightUpperArm: "leftUpperArm", rightForearm: "leftForearm", rightHand: "leftHand" },
  legs: { leftThigh: "rightThigh", leftLowerLeg: "rightLowerLeg", leftFoot: "rightFoot", rightThigh: "leftThigh", rightLowerLeg: "leftLowerLeg", rightFoot: "leftFoot" },
};

/**
 * Seam-tolerant accuracy: a pixel within `band` px of a seam between two true parts counts as right when it was given
 * to either of them. Where the art draws no line (a knee in plain trousers), where exactly the seam falls is a
 * convention two careful people place differently; everything away from seams is scored strictly.
 */
export function seamTolerantAccuracy(truth: PartTruth, labels: Uint8Array, predicted: Uint8Array, width: number, band: number): number {
  const readings = truth.pairedLimbs ? [["none"], ["arms"], ["legs"], ["arms", "legs"]] : [["none"]];
  const size = labels.length; const near = new Map<number, Set<number>>();
  // For each pixel near a seam, the labels within `band` (breadth-first out from every seam pixel).
  let frontier: number[] = [];
  for (let i = 0; i < size; i += 1) { if (!labels[i] || labels[i] === EQUIPMENT) continue; const x = i % width; for (const j of [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, i - width, i + width]) if (j >= 0 && j < size && labels[j] && labels[j] !== EQUIPMENT && labels[j] !== labels[i]) { const set = near.get(i) ?? new Set([labels[i]]); set.add(labels[j]); near.set(i, set); frontier.push(i); break; } }
  for (let step = 0; step < band && frontier.length; step += 1) {
    const next: number[] = [];
    for (const i of frontier) { const set = near.get(i)!; const x = i % width; for (const j of [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, i - width, i + width]) { if (j < 0 || j >= size || !labels[j] || labels[j] === EQUIPMENT) continue; const other = near.get(j); if (!other) { near.set(j, new Set([labels[j], ...set])); next.push(j); } else { const before = other.size; for (const v of set) other.add(v); if (other.size > before) next.push(j); } } }
    frontier = next;
  }
  let best = 0;
  for (const reading of readings) {
    const map = Object.assign({}, ...reading.map((name) => swaps[name])) as Record<string, string>;
    const rename = new Uint8Array(256); for (let label = 0; label < 256; label += 1) rename[label] = label;
    for (const [from, to] of Object.entries(map)) rename[BODY_PARTS.indexOf(from as never) + 1] = BODY_PARTS.indexOf(to as never) + 1;
    let correct = 0; let total = 0;
    for (let i = 0; i < size; i += 1) { const actual = labels[i]; if (!actual || actual === EQUIPMENT) continue; total += 1; const guess = rename[predicted[i]]; if (guess === actual || near.get(i)?.has(guess)) correct += 1; }
    best = Math.max(best, total ? correct / total : 0);
  }
  return best;
}

/** Scores predicted labels (same encoding, 0 for nothing) against the truth. */
export function scoreCut(truth: PartTruth, labels: Uint8Array, predicted: Uint8Array): CutScore {
  const readings = truth.pairedLimbs ? [["none"], ["arms"], ["legs"], ["arms", "legs"]] : [["none"]];
  let best: CutScore | null = null;
  for (const reading of readings) {
    const map = Object.assign({}, ...reading.map((name) => swaps[name])) as Record<string, string>;
    const rename = new Uint8Array(256); for (let label = 0; label < 256; label += 1) rename[label] = label;
    for (const [from, to] of Object.entries(map)) rename[BODY_PARTS.indexOf(from as never) + 1] = BODY_PARTS.indexOf(to as never) + 1;
    let correct = 0; let total = 0; const inter = new Map<number, number>(); const truthCount = new Map<number, number>(); const predCount = new Map<number, number>();
    for (let index = 0; index < labels.length; index += 1) {
      const actual = labels[index]; if (!actual || actual === EQUIPMENT) continue;
      const guess = rename[predicted[index]]; total += 1; truthCount.set(actual, (truthCount.get(actual) ?? 0) + 1);
      if (guess) predCount.set(guess, (predCount.get(guess) ?? 0) + 1);
      if (guess === actual) { correct += 1; inter.set(actual, (inter.get(actual) ?? 0) + 1); }
    }
    const iou: Record<string, number> = {};
    for (const [label, count] of truthCount) { const name = BODY_PARTS[label - 1]; const shared = inter.get(label) ?? 0; iou[name] = shared / (count + (predCount.get(label) ?? 0) - shared); }
    const score: CutScore = { accuracy: total ? correct / total : 0, bodyPixels: total, iou, swapped: reading.join("+"), worst: Object.entries(iou).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([name, value]) => `${name} ${(value * 100).toFixed(0)}%`) };
    if (!best || score.accuracy > best.accuracy) best = score;
  }
  return best!;
}

const palette = [[230, 70, 70], [70, 160, 240], [250, 190, 60], [110, 220, 110], [190, 110, 250], [250, 130, 210], [60, 230, 200], [250, 150, 80], [140, 160, 255], [200, 250, 90], [240, 240, 240], [250, 100, 150], [80, 130, 250], [170, 250, 190]];
export function overlay(image: LoadedImage, labels: Uint8Array, wrong?: Uint8Array): PNG {
  const out = new PNG({ width: image.width, height: image.height });
  for (let index = 0; index < labels.length; index += 1) {
    const a = image.data[index * 4 + 3] / 255; const base = [0, 1, 2].map((c) => image.data[index * 4 + c] * a * .4 + 18);
    const label = labels[index]; const colour = label === EQUIPMENT ? [90, 90, 90] : label ? palette[(label - 1) % palette.length] : null;
    for (let c = 0; c < 3; c += 1) out.data[index * 4 + c] = Math.round(colour ? base[c] * .45 + colour[c] * .55 : base[c]);
    if (wrong?.[index]) { out.data[index * 4] = 255; out.data[index * 4 + 1] = 0; out.data[index * 4 + 2] = 0; }
    out.data[index * 4 + 3] = 255;
  }
  return out;
}

export const readTruth = (name: string): PartTruth => JSON.parse(readFileSync(path.join(TRUTH_DIR, `${name}.json`), "utf8")) as PartTruth;
export const truthNames = (): string[] => readdirSync(TRUTH_DIR).filter((file) => file.endsWith(".json")).map((file) => file.replace(/\.json$/, "")).sort();

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [mode, ...names] = process.argv.slice(2); const out = ".bench/cut"; mkdirSync(out, { recursive: true });
  if (mode === "render") {
    for (const name of names) { const truth = readTruth(name); const image = loadImage(truth.image); writeFileSync(path.join(out, `${name}.truth.png`), PNG.sync.write(overlay(image, truthLabels(truth, image)))); console.log(`${out}/${name}.truth.png`); }
  } else if (mode === "score") {
    const scores: number[] = []; const tolerants: number[] = [];
    for (const name of names.length ? names : truthNames()) {
      const truth = readTruth(name); const image = loadImage(truth.image); const labels = truthLabels(truth, image);
      const { predicted, poseJoints } = await cutAllParts(image);
      const score = scoreCut(truth, labels, predicted); scores.push(score.accuracy);
      let top = image.height; let bottom = 0; image.foreground.forEach((value, index) => { if (value) { const y = Math.floor(index / image.width); top = Math.min(top, y); bottom = Math.max(bottom, y); } });
      const tolerant = seamTolerantAccuracy(truth, labels, predicted, image.width, Math.round((bottom - top) * .02)); tolerants.push(tolerant);
      const wrong = new Uint8Array(labels.length); for (let index = 0; index < labels.length; index += 1) if (labels[index] && labels[index] !== EQUIPMENT && predicted[index] !== labels[index]) wrong[index] = 1;
      writeFileSync(path.join(out, `${name}.cut.png`), PNG.sync.write(overlay(image, predicted)));
      writeFileSync(path.join(out, `${name}.wrong.png`), PNG.sync.write(overlay(image, labels, score.swapped === "none" ? wrong : undefined)));
      console.log(`${(score.accuracy * 100).toFixed(1).padStart(5)}%  seam-tolerant ${(tolerant * 100).toFixed(1).padStart(5)}%  ${name.padEnd(20)} pose ${String(poseJoints).padStart(2)}  worst: ${score.worst.join(", ")}${score.swapped !== "none" ? `  (read with ${score.swapped} swapped)` : ""}`);
    }
    const below = scores.filter((value) => value < .95).length;
    console.log(`\nseam-tolerant: mean ${(tolerants.reduce((a, b) => a + b, 0) / tolerants.length * 100).toFixed(1)}%  min ${(Math.min(...tolerants) * 100).toFixed(1)}%`);
    console.log(`strict: mean ${(scores.reduce((a, b) => a + b, 0) / scores.length * 100).toFixed(1)}%  min ${(Math.min(...scores) * 100).toFixed(1)}%  below 95%: ${below} of ${scores.length}`);
  } else if (mode === "grid") {
    // The numbered gridded view a planner reads coordinates from: grid <image.png> <out.png>
    const [file, target] = names; const grid = planGrid(loadImage(file)); const png = new PNG({ width: grid.width, height: grid.height }); png.data.set(grid.data);
    writeFileSync(target, PNG.sync.write(png)); console.log(target, "origin", grid.originX, grid.originY);
  } else if (mode === "plan") {
    // Renders any plan or label file (same format) to a PNG, to check strokes: plan <file.json> <out.png>
    const [file, target] = names; const plan = JSON.parse(readFileSync(file, "utf8")) as PartTruth; const image = loadImage(plan.image);
    writeFileSync(target, PNG.sync.write(overlay(image, truthLabels(plan, image)))); console.log(target);
  } else console.log("usage: cut-bench.mts render <name>... | score [name...] | plan <file.json> <out.png>");
}
