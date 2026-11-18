import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectDwpose } from "../../src/character-generation/pose/dwpose";
import { poseToLandmarks } from "../../src/character-generation/pose/poseLandmarks";
import { applyPoseLandmarks, buildAdaptiveAnatomicalPartitionGuide, createPartCutterState, detectProportions, type AnatomicalLandmarkId, type AnatomicalPartitionGuide } from "../../src/part-cutter";

/**
 * How close the joints land to joints marked by hand, for EVERY sprite in tests/fixtures/rigging/joint-ground-truth.json.
 * Adding a sprite there (image, view, proportions, joints) is all it takes to hold it to the same standard:
 *   - proportions are detected automatically and must match the marked ones;
 *   - "outline": the silhouette guide alone; "full": with each joint the pose model (DWPose) is confident about. The full
 *     pipeline is what Cut all parts uses. It runs here whenever the model is installed (npm run setup:pose);
 *   - the pose model must never make a sprite worse than the outline alone;
 *   - mean joint error, as a share of the figure's own height, must stay within UNIVERSAL_MEAN and must not get worse
 *     than the sprite's recorded baseline (tests/fixtures/rigging/guide-accuracy-baseline.json).
 * After an improvement, re-record baselines with UPDATE_GUIDE_BASELINE=1 npx vitest run tests/rigging/guide-accuracy.test.ts.
 * Recording only ever lowers a baseline (keeps the better number), and adds baselines for new sprites.
 */
type Proportions = "chibi" | "adult";
type Truth = { readonly image: string; readonly view: string; readonly proportions: Proportions; readonly pairedLimbs: boolean; readonly joints: Readonly<Partial<Record<AnatomicalLandmarkId, readonly [number, number]>>> };
type Fixture = { readonly sprites: Record<string, Truth>; readonly proportionsOnly?: Record<string, { readonly image: string; readonly proportions: Proportions }> };
type Score = { readonly mean: number; readonly worst: number };
type Baseline = Record<string, { readonly outline: Score; readonly full?: Score }>;

/** Every marked sprite must be at least this good, whatever it is. */
const UNIVERSAL_MEAN = .10;
/** Measurement noise allowed before a change counts as worse. */
const TOLERANCE = .005;

const fixture = JSON.parse(readFileSync(new URL("../fixtures/rigging/joint-ground-truth.json", import.meta.url), "utf8")) as Fixture;
const baselineUrl = new URL("../fixtures/rigging/guide-accuracy-baseline.json", import.meta.url);
const baseline: Baseline = existsSync(baselineUrl) ? JSON.parse(readFileSync(baselineUrl, "utf8")) : {};
const updateBaseline = process.env.UPDATE_GUIDE_BASELINE === "1";
const modelPath = fileURLToPath(new URL("../../public/models/dwpose/dw-ll_ucoco_384.onnx", import.meta.url));
const modelInstalled = existsSync(modelPath);

const load = (path: string) => {
  const png = PNG.sync.read(readFileSync(new URL(`../../${path}`, import.meta.url)));
  const foreground = Array.from({ length: png.width * png.height }, (_, index) => png.data[index * 4 + 3] > 16 ? 255 : 0);
  let top = png.height; let bottom = -1;
  for (let y = 0; y < png.height; y += 1) for (let x = 0; x < png.width; x += 1) if (foreground[y * png.width + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  return { png, width: png.width, height: png.height, foreground, figureHeight: Math.max(1, bottom - top + 1) };
};

const twin = (id: string): string => id.startsWith("left") ? id.replace(/^left/, "right") : id.replace(/^right/, "left");

function score(guide: AnatomicalPartitionGuide, sprite: Truth, figureHeight: number): Score & { worstJoint: string } {
  const at = new Map(guide.landmarks.map((landmark) => [landmark.landmarkId as string, landmark.point]));
  const errors = Object.entries(sprite.joints).map(([id, [x, y]]) => {
    const candidates = sprite.pairedLimbs && /^(left|right)/.test(id) ? [id, twin(id)] : [id];
    const distance = Math.min(...candidates.flatMap((candidate) => { const point = at.get(candidate); return point ? [Math.hypot(point.x - x, point.y - y)] : []; }));
    return { id, error: distance / figureHeight };
  });
  const worst = errors.reduce((a, b) => b.error > a.error ? b : a);
  return { mean: errors.reduce((sum, item) => sum + item.error, 0) / errors.length, worst: worst.error, worstJoint: worst.id };
}

let session: ort.InferenceSession | null = null;
beforeAll(async () => { if (modelInstalled) session = await ort.InferenceSession.create(modelPath, { executionProviders: ["wasm"] }); }, 60_000);
afterAll(async () => { await session?.release(); });

const runDwpose = async (input: Float32Array) => {
  const output = await session!.run({ [session!.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, 384, 288]) });
  return { simccX: output[session!.outputNames[0]].data as Float32Array, simccY: output[session!.outputNames[1]].data as Float32Array };
};

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const measured: Baseline = {};

describe("joint accuracy against hand-marked joints", () => {
  if (!modelInstalled) it.skip("full pipeline: install the pose model with npm run setup:pose", () => undefined);

  for (const [name, sprite] of Object.entries(fixture.sprites)) {
    it(`${name} (${sprite.view}, ${sprite.proportions}): proportions detected; outline and full pipeline within the standard and baselines`, async () => {
      const image = load(sprite.image);
      const base = createPartCutterState("accuracy", image.width, image.height, "manual", "2026-11-17T12:00:00.000Z");
      const guide = buildAdaptiveAnatomicalPartitionGuide(base, image.foreground, "humanoid", "2026-11-17T12:00:00.000Z");
      expect(guide.adaptiveMetadata?.proportions).toBe(sprite.proportions);

      const outline = score(guide, sprite, image.figureHeight);
      const previous = baseline[name];
      let line = `${name}: outline ${percent(outline.mean)} (worst ${percent(outline.worst)} at ${outline.worstJoint})`;
      expect(outline.mean).toBeLessThanOrEqual(UNIVERSAL_MEAN);
      if (previous && !updateBaseline) expect(outline.mean).toBeLessThanOrEqual(previous.outline.mean + TOLERANCE);
      measured[name] = { outline: { mean: Number(outline.mean.toFixed(4)), worst: Number(outline.worst.toFixed(4)) } };

      if (session) {
        const pose = await detectDwpose({ width: image.width, height: image.height, data: image.png.data }, runDwpose);
        const joints = pose ? poseToLandmarks(pose) : {};
        const full = score(applyPoseLandmarks(guide, joints, image.foreground), sprite, image.figureHeight);
        line += ` · full ${percent(full.mean)} (worst ${percent(full.worst)} at ${full.worstJoint}; ${Object.keys(joints).length} joints from the pose model)`;
        // The pose model only ever replaces joints it is confident about, so it must never make a sprite worse.
        expect(full.mean).toBeLessThanOrEqual(outline.mean + TOLERANCE);
        expect(full.mean).toBeLessThanOrEqual(UNIVERSAL_MEAN);
        if (previous?.full && !updateBaseline) expect(full.mean).toBeLessThanOrEqual(previous.full.mean + TOLERANCE);
        measured[name] = { ...measured[name], full: { mean: Number(full.mean.toFixed(4)), worst: Number(full.worst.toFixed(4)) } };
      }
      console.info(previous ? line : `${line} (no baseline yet: record it with UPDATE_GUIDE_BASELINE=1)`);
    }, 60_000);
  }

  // Sprites without marked joints can still be listed with their proportions, so detection is checked on them too.
  for (const [name, entry] of Object.entries(fixture.proportionsOnly ?? {})) {
    it(`${name}: proportions are detected as ${entry.proportions}`, () => {
      const image = load(entry.image);
      expect(detectProportions(image.foreground, image.width, image.height)).toBe(entry.proportions);
    });
  }

  it("records the baselines when asked (UPDATE_GUIDE_BASELINE=1)", () => {
    if (!updateBaseline) return;
    // A ratchet: recording keeps the better of the old and new numbers, so a slow slide cannot be recorded away.
    const better = (old: Score | undefined, now: Score | undefined): Score | undefined => !now ? old : !old ? now : { mean: Math.min(old.mean, now.mean), worst: Math.min(old.worst, now.worst) };
    const next: Baseline = { ...baseline };
    for (const [name, value] of Object.entries(measured)) {
      const full = better(baseline[name]?.full, value.full);
      next[name] = { outline: better(baseline[name]?.outline, value.outline)!, ...(full ? { full } : {}) };
    }
    writeFileSync(baselineUrl, `${JSON.stringify(next, null, 2)}\n`);
  });
});
