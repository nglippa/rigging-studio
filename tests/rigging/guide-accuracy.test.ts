import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import type { DetectedPose } from "../../src/character-generation/pose/poseDetector";
import { poseModelSuitable, poseToLandmarks } from "../../src/character-generation/pose/poseLandmarks";
import { applyPoseLandmarks, buildAdaptiveAnatomicalPartitionGuide, createPartCutterState, type AnatomicalLandmarkId, type AnatomicalPartitionGuide } from "../../src/part-cutter";

/**
 * How close the guide's joints land to joints marked by hand, as a share of the character's height. This is the
 * number to watch when changing the guide or the pose mapping: each sprite has a ceiling that is today's measured
 * error plus a small margin, so a change that makes it worse fails here.
 */
type Truth = { readonly image: string; readonly view: string; readonly height: number; readonly pairedLimbs: boolean; readonly joints: Readonly<Partial<Record<AnatomicalLandmarkId, readonly [number, number]>>> };
const truth = JSON.parse(readFileSync(new URL("../fixtures/rigging/joint-ground-truth.json", import.meta.url), "utf8")) as { sprites: Record<string, Truth> };

const foregroundOf = (path: string) => {
  const png = PNG.sync.read(readFileSync(new URL(`../../${path}`, import.meta.url)));
  return { width: png.width, height: png.height, foreground: Array.from({ length: png.width * png.height }, (_, index) => png.data[index * 4 + 3] > 16 ? 255 : 0) };
};

const twin = (id: string): string => id.startsWith("left") ? id.replace(/^left/, "right") : id.replace(/^right/, "left");

/** Mean and worst joint error over the marked joints, as a fraction of the character's height. */
function score(guide: AnatomicalPartitionGuide, sprite: Truth): { mean: number; worst: number; worstJoint: string } {
  const at = new Map(guide.landmarks.map((landmark) => [landmark.landmarkId as string, landmark.point]));
  const errors = Object.entries(sprite.joints).map(([id, [x, y]]) => {
    const candidates = sprite.pairedLimbs && /^(left|right)/.test(id) ? [id, twin(id)] : [id];
    const distance = Math.min(...candidates.flatMap((candidate) => { const point = at.get(candidate); return point ? [Math.hypot(point.x - x, point.y - y)] : []; }));
    return { id, error: distance / sprite.height };
  });
  const worst = errors.reduce((a, b) => b.error > a.error ? b : a);
  return { mean: errors.reduce((sum, item) => sum + item.error, 0) / errors.length, worst: worst.error, worstJoint: worst.id };
}

const guideFor = (name: string) => {
  const sprite = truth.sprites[name]; const image = foregroundOf(sprite.image);
  const base = createPartCutterState(`accuracy-${name}`, image.width, image.height, "manual", "2026-11-17T12:00:00.000Z");
  return { sprite, image, guide: buildAdaptiveAnatomicalPartitionGuide(base, image.foreground, "humanoid") };
};

describe("guide joint accuracy against hand-marked joints", () => {
  // Ceilings: measured 2026-11-17, plus a margin. Lower them when the guide improves.
  const ceilings: Record<string, { mean: number }> = { warrior: { mean: .055 }, goblin: { mean: .13 } };

  for (const name of Object.keys(ceilings)) {
    it(`${name}: the silhouette guide stays within its measured error`, () => {
      const { sprite, guide } = guideFor(name);
      const result = score(guide, sprite);
      console.info(`${name} (${sprite.view}) silhouette guide: mean ${(result.mean * 100).toFixed(1)}% of height, worst ${(result.worst * 100).toFixed(1)}% at ${result.worstJoint}`);
      expect(result.mean).toBeLessThanOrEqual(ceilings[name].mean);
    });
  }

  it("warrior: the pose model is not used on small pixel sprites, where it measured worse than the silhouette", () => {
    const { sprite, image, guide } = guideFor("warrior");
    const pose = JSON.parse(readFileSync(new URL("../fixtures/pose/warrior-pixel.json", import.meta.url), "utf8")) as DetectedPose;
    const before = score(guide, sprite); const after = score(applyPoseLandmarks(guide, poseToLandmarks(pose), image.foreground), sprite);
    console.info(`warrior with pose model: mean ${(after.mean * 100).toFixed(1)}% (silhouette alone ${(before.mean * 100).toFixed(1)}%), worst ${(after.worst * 100).toFixed(1)}% at ${after.worstJoint}`);
    // Measured 2026-11-17: 7.5% with the pose model against 5.0% without it. Hence the size gate.
    expect(after.mean).toBeGreaterThan(before.mean);
    expect(poseModelSuitable(image.width, image.height)).toBe(false);
    expect(poseModelSuitable(1024, 1536)).toBe(true);
  });
});
