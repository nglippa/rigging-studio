import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadImage, readTruth, scoreCut, seamTolerantAccuracy, truthLabels, truthNames } from "../../scripts/cut-bench.mjs";
import { cutAllParts } from "../../scripts/cut-pipeline.mjs";

/**
 * Cut all parts, run as the app runs it, against hand-labelled parts (tests/fixtures/rigging/part-truth, see
 * scripts/cut-bench.mts). Each character must stay at or above its recorded baseline, strict and seam-tolerant, so an
 * improvement is kept and a regression fails. After an improvement, record with
 * UPDATE_CUT_BASELINE=1 npx vitest run tests/rigging/cut-accuracy.test.ts (recording only ever raises a baseline).
 */
type Baseline = Record<string, { readonly strict: number; readonly tolerant: number }>;
const baselineUrl = new URL("../fixtures/rigging/cut-accuracy-baseline.json", import.meta.url);
const baseline: Baseline = existsSync(baselineUrl) ? JSON.parse(readFileSync(baselineUrl, "utf8")) : {};
const update = process.env.UPDATE_CUT_BASELINE === "1";
const modelInstalled = existsSync(fileURLToPath(new URL("../../public/models/dwpose/dw-ll_ucoco_384.onnx", import.meta.url)));
/** Measurement noise allowed before a change counts as worse. */
const TOLERANCE = .003;
const measured: Baseline = {};

describe("cut accuracy against hand-labelled parts", () => {
  if (!modelInstalled) { it.skip("needs the pose model (npm run setup:pose)", () => undefined); return; }
  for (const name of truthNames()) {
    it(`${name} stays at or above its baseline`, async () => {
      const truth = readTruth(name); const image = loadImage(truth.image); const labels = truthLabels(truth, image);
      const { predicted } = await cutAllParts(image);
      let top = image.height; let bottom = 0; image.foreground.forEach((value, index) => { if (value) { const y = Math.floor(index / image.width); top = Math.min(top, y); bottom = Math.max(bottom, y); } });
      const strict = scoreCut(truth, labels, predicted).accuracy;
      const tolerant = seamTolerantAccuracy(truth, labels, predicted, image.width, Math.round((bottom - top) * .02));
      measured[name] = { strict: Number(strict.toFixed(4)), tolerant: Number(tolerant.toFixed(4)) };
      const previous = baseline[name];
      if (previous && !update) { expect(strict).toBeGreaterThanOrEqual(previous.strict - TOLERANCE); expect(tolerant).toBeGreaterThanOrEqual(previous.tolerant - TOLERANCE); }
    }, 120_000);
  }
  afterAll(() => {
    if (!update) return;
    const next: Baseline = { ...baseline };
    for (const [name, value] of Object.entries(measured)) next[name] = { strict: Math.max(value.strict, baseline[name]?.strict ?? 0), tolerant: Math.max(value.tolerant, baseline[name]?.tolerant ?? 0) };
    writeFileSync(baselineUrl, `${JSON.stringify(next, null, 2)}\n`);
  });
});
