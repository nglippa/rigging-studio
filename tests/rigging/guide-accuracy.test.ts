import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import type { DetectedPose } from "../../src/character-generation/pose/poseDetector";
import { poseModelSuitable, poseToLandmarks } from "../../src/character-generation/pose/poseLandmarks";
import { applyPoseLandmarks, buildAdaptiveAnatomicalPartitionGuide, createPartCutterState, detectProportions, type AnatomicalLandmarkId, type AnatomicalPartitionGuide } from "../../src/part-cutter";

/**
 * How close the guide's joints land to joints marked by hand, for EVERY sprite in
 * tests/fixtures/rigging/joint-ground-truth.json. Adding a sprite there (image, view, proportions, joints) is all it takes
 * to put it under the same standard:
 *   - proportions are detected automatically and must match the marked ones;
 *   - the mean joint error, as a share of the figure's own height (from its silhouette), must stay within UNIVERSAL_MEAN;
 *   - and must not get worse than the sprite's recorded baseline (tests/fixtures/rigging/guide-accuracy-baseline.json).
 * After an improvement, re-record the baselines with UPDATE_GUIDE_BASELINE=1 npx vitest run tests/rigging/guide-accuracy.test.ts.
 * Recording only ever lowers a baseline (keeps the better number), and adds baselines for new sprites.
 */
type Proportions = "chibi" | "adult";
type Truth = { readonly image: string; readonly view: string; readonly proportions: Proportions; readonly pairedLimbs: boolean; readonly joints: Readonly<Partial<Record<AnatomicalLandmarkId, readonly [number, number]>>> };
type Fixture = { readonly sprites: Record<string, Truth>; readonly proportionsOnly?: Record<string, { readonly image: string; readonly proportions: Proportions }> };
type Baseline = Record<string, { readonly mean: number; readonly worst: number }>;

/** Every marked sprite must be at least this good, whatever it is. */
const UNIVERSAL_MEAN = .10;
/** Measurement noise allowed before a change counts as worse than the baseline. */
const TOLERANCE = .005;

const fixtureUrl = new URL("../fixtures/rigging/joint-ground-truth.json", import.meta.url);
const baselineUrl = new URL("../fixtures/rigging/guide-accuracy-baseline.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as Fixture;
const baseline: Baseline = existsSync(baselineUrl) ? JSON.parse(readFileSync(baselineUrl, "utf8")) : {};
const updateBaseline = process.env.UPDATE_GUIDE_BASELINE === "1";

const load = (path: string) => {
  const png = PNG.sync.read(readFileSync(new URL(`../../${path}`, import.meta.url)));
  const foreground = Array.from({ length: png.width * png.height }, (_, index) => png.data[index * 4 + 3] > 16 ? 255 : 0);
  let top = png.height; let bottom = -1;
  for (let y = 0; y < png.height; y += 1) for (let x = 0; x < png.width; x += 1) if (foreground[y * png.width + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  return { width: png.width, height: png.height, foreground, figureHeight: Math.max(1, bottom - top + 1) };
};

const twin = (id: string): string => id.startsWith("left") ? id.replace(/^left/, "right") : id.replace(/^right/, "left");

/** Mean and worst joint error over the marked joints, as a share of the figure's height. */
function score(guide: AnatomicalPartitionGuide, sprite: Truth, figureHeight: number): { mean: number; worst: number; worstJoint: string } {
  const at = new Map(guide.landmarks.map((landmark) => [landmark.landmarkId as string, landmark.point]));
  const errors = Object.entries(sprite.joints).map(([id, [x, y]]) => {
    const candidates = sprite.pairedLimbs && /^(left|right)/.test(id) ? [id, twin(id)] : [id];
    const distance = Math.min(...candidates.flatMap((candidate) => { const point = at.get(candidate); return point ? [Math.hypot(point.x - x, point.y - y)] : []; }));
    return { id, error: distance / figureHeight };
  });
  const worst = errors.reduce((a, b) => b.error > a.error ? b : a);
  return { mean: errors.reduce((sum, item) => sum + item.error, 0) / errors.length, worst: worst.error, worstJoint: worst.id };
}

const guideFor = (sprite: Truth) => {
  const image = load(sprite.image);
  const base = createPartCutterState("accuracy", image.width, image.height, "manual", "2026-11-17T12:00:00.000Z");
  return { image, guide: buildAdaptiveAnatomicalPartitionGuide(base, image.foreground, "humanoid", "2026-11-17T12:00:00.000Z") };
};

const measured: Baseline = {};

describe("guide joint accuracy against hand-marked joints", () => {
  for (const [name, sprite] of Object.entries(fixture.sprites)) {
    it(`${name} (${sprite.view}, ${sprite.proportions}): proportions detected, joints within the standard and its baseline`, () => {
      const { image, guide } = guideFor(sprite);
      expect(guide.adaptiveMetadata?.proportions).toBe(sprite.proportions);
      const result = score(guide, sprite, image.figureHeight);
      measured[name] = { mean: Number(result.mean.toFixed(4)), worst: Number(result.worst.toFixed(4)) };
      const previous = baseline[name];
      console.info(`${name}: mean ${(result.mean * 100).toFixed(1)}%, worst ${(result.worst * 100).toFixed(1)}% at ${result.worstJoint}${previous ? ` (baseline ${(previous.mean * 100).toFixed(1)}%)` : " (no baseline yet)"}`);
      expect(result.mean).toBeLessThanOrEqual(UNIVERSAL_MEAN);
      if (previous && !updateBaseline) expect(result.mean).toBeLessThanOrEqual(previous.mean + TOLERANCE);
    });
  }

  // Sprites without marked joints can still be listed with their proportions, so detection is checked on them too.
  for (const [name, entry] of Object.entries(fixture.proportionsOnly ?? {})) {
    it(`${name}: proportions are detected as ${entry.proportions}`, () => {
      const image = load(entry.image);
      expect(detectProportions(image.foreground, image.width, image.height)).toBe(entry.proportions);
    });
  }

  it("records the baselines when asked (UPDATE_GUIDE_BASELINE=1)", () => {
    // A ratchet: recording keeps the better of the old and new numbers, so a slow slide cannot be recorded away.
    if (updateBaseline) {
      const next: Baseline = { ...baseline };
      for (const [name, value] of Object.entries(measured)) next[name] = baseline[name] ? { mean: Math.min(baseline[name].mean, value.mean), worst: Math.min(baseline[name].worst, value.worst) } : value;
      writeFileSync(baselineUrl, `${JSON.stringify(next, null, 2)}\n`);
    }
    // Every marked sprite has a baseline, so a newly added one is caught by the reminder below until it is recorded.
    const missing = Object.keys(fixture.sprites).filter((name) => !baseline[name] && !updateBaseline);
    if (missing.length) console.info(`No baseline yet for ${missing.join(", ")}. Record it with UPDATE_GUIDE_BASELINE=1.`);
    expect(true).toBe(true);
  });

  it("warrior: the pose model is not used on small pixel sprites, where it measured worse than the silhouette", () => {
    const sprite = fixture.sprites.warrior; const { image, guide } = guideFor(sprite);
    const pose = JSON.parse(readFileSync(new URL("../fixtures/pose/warrior-pixel.json", import.meta.url), "utf8")) as DetectedPose;
    const before = score(guide, sprite, image.figureHeight); const after = score(applyPoseLandmarks(guide, poseToLandmarks(pose), image.foreground), sprite, image.figureHeight);
    // Measured 2026-11-17: the pose model made the 48 px warrior worse (it reads the shield as a shoulder). Hence the size gate.
    expect(after.mean).toBeGreaterThan(before.mean);
    expect(poseModelSuitable(image.width, image.height)).toBe(false);
    expect(poseModelSuitable(1024, 1536)).toBe(true);
  });
});
