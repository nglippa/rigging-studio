/**
 * How well the part model cuts sprites it has never seen: k-fold cross-validation over the hand-labelled bench. Each fold
 * trains on the other characters (train.py, on this Mac's GPU, about 25 minutes a fold), predicts its own, and every
 * prediction is cut through the real pipeline (cutAllParts with that prediction) and scored like the bench, next to the cut
 * without the model. A character and its posed- variant are kept in the same fold.
 *   npm run part-model:crossval [-- <folds> <iterations>]
 * Writes .bench/train/crossval.txt. Run npm run part-model:data first if labels changed (part-model:crossval does it).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { loadImage, readTruth, scoreCut, seamTolerantAccuracy, truthLabels, truthNames } from "../cut-bench.mjs";
import { cutAllParts } from "../cut-pipeline.mjs";

const folds = Number(process.argv[2] ?? 4); const iterations = Number(process.argv[3] ?? 2500);
const names = truthNames(); const base = (name: string) => name.replace(/^posed-/, "");
const groups = [...new Set(names.map(base))]; const foldOf = new Map(groups.map((group, index) => [group, index % folds]));
const lines: string[] = []; const rows: number[][] = [];
for (let fold = 0; fold < folds; fold += 1) {
  const test = names.filter((name) => foldOf.get(base(name)) === fold); const train = names.filter((name) => !test.includes(name));
  console.log(`fold ${fold + 1}/${folds}: ${test.join(", ")}`);
  const run = spawnSync("uv", ["run", "--quiet", "--with", "torch", "--with", "pillow", "--with", "numpy", "--with", "segmentation-models-pytorch", "python3", "scripts/part-model/train.py", `cv${fold + 1}`, String(iterations), train.join(","), test.join(",")], { stdio: "inherit" });
  if (run.status !== 0) throw new Error(`fold ${fold + 1} failed`);
  for (const name of test) {
    const truth = readTruth(name); const image = loadImage(truth.image); const labels = truthLabels(truth, image); const { width: w, height: h } = image;
    const lab = PNG.sync.read(readFileSync(`.bench/train/cv${fold + 1}/pred/${name}.lab.png`)); const conf = PNG.sync.read(readFileSync(`.bench/train/cv${fold + 1}/pred/${name}.conf.png`));
    const prediction = { labels: new Uint8Array(w * h), confidence: new Float32Array(w * h) };
    for (let i = 0; i < w * h; i += 1) { prediction.labels[i] = lab.data[i * 4]; prediction.confidence[i] = conf.data[i * 4] / 255; }
    let top = h; let bottom = 0; image.foreground.forEach((v: number, i: number) => { if (v) { const y = Math.floor(i / w); top = Math.min(top, y); bottom = Math.max(bottom, y); } });
    const band = Math.round((bottom - top) * .02);
    const score = (predicted: Uint8Array) => [scoreCut(truth, labels, predicted).accuracy * 100, seamTolerantAccuracy(truth, labels, predicted, w, band) * 100];
    const engine = score((await cutAllParts(image, null)).predicted); const model = score((await cutAllParts(image, prediction)).predicted);
    rows.push([...engine, ...model]);
    const line = `${name.padEnd(22)} without model ${engine[0].toFixed(1)}/${engine[1].toFixed(1)}   with model ${model[0].toFixed(1)}/${model[1].toFixed(1)}`;
    lines.push(line); console.log(line);
  }
}
const mean = (k: number) => (rows.reduce((sum, row) => sum + row[k], 0) / rows.length).toFixed(1); const min = (k: number) => Math.min(...rows.map((row) => row[k])).toFixed(1);
const summary = `mean without ${mean(0)}/${mean(1)}  with ${mean(2)}/${mean(3)}   worst without ${min(0)}/${min(1)}  with ${min(2)}/${min(3)}   (strict / seam-tolerant %, ${rows.length} characters, ${folds} folds)`;
console.log(summary); writeFileSync(".bench/train/crossval.txt", [...lines, summary, ""].join("\n"));
