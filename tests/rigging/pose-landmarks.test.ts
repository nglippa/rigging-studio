import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DetectedPose, PoseKeypoint, PoseKeypointName } from "../../src/character-generation/pose/poseDetector";
import { estimateView, poseToLandmarks } from "../../src/character-generation/pose/poseLandmarks";
import { applyPoseLandmarks, buildAdaptiveAnatomicalPartitionGuide, createPartCutterState } from "../../src/part-cutter";

// Real MediaPipe output on a front-facing 1024x1536 illustration (see the fixture's note).
const courier = JSON.parse(readFileSync(new URL("../fixtures/pose/courier-front.json", import.meta.url), "utf8")) as DetectedPose;

/** A pose built from the courier's, with some keypoints replaced. */
const variant = (changes: Partial<Record<PoseKeypointName, Partial<PoseKeypoint>>>): DetectedPose => ({
  ...courier,
  keypoints: Object.fromEntries(Object.entries(courier.keypoints).map(([name, point]) => [name, { ...point, ...changes[name as PoseKeypointName] }])) as DetectedPose["keypoints"],
});

describe("pose keypoints to guide joints", () => {
  it("names limbs by screen side, as the guide does, not by the character's own side", () => {
    const joints = poseToLandmarks(courier);
    // Facing the viewer, the character's right shoulder is on the viewer's left: it becomes the guide's left shoulder.
    expect(joints.leftShoulder?.point.x).toBeCloseTo(courier.keypoints.rightShoulder.x, 3);
    expect(joints.rightShoulder?.point.x).toBeCloseTo(courier.keypoints.leftShoulder.x, 3);
    expect(joints.leftShoulder!.point.x).toBeLessThan(joints.rightShoulder!.point.x);
    expect(joints.leftAnkle!.point.x).toBeLessThan(joints.rightAnkle!.point.x);
    // The neck sits between the shoulder line and the face; the pelvis between the hips.
    expect(joints.neck!.point.y).toBeLessThan(Math.min(courier.keypoints.leftShoulder.y, courier.keypoints.rightShoulder.y));
    expect(joints.neck!.point.y).toBeGreaterThan(courier.keypoints.nose.y);
    expect(joints.pelvis!.point.y).toBeCloseTo((courier.keypoints.leftHip.y + courier.keypoints.rightHip.y) / 2, 3);
  });

  it("leaves out keypoints the model is unsure of, or that fall outside the image", () => {
    const joints = poseToLandmarks(variant({ leftKnee: { visibility: .3 }, rightAnkle: { y: courier.height * 1.4 } }));
    expect(joints.rightKnee).toBeUndefined(); // the character's left knee is on the viewer's right
    expect(joints.leftAnkle).toBeUndefined();
    expect(joints.leftKnee).toBeDefined();
  });

  it("moves the guide's joints to the pose and rebuilds the zones around them, keeping hand-placed joints", () => {
    const width = courier.width; const height = courier.height;
    const foreground = new Array<number>(width * height).fill(0);
    for (let y = 120; y < 1450; y += 1) for (let x = 260; x < 780; x += 1) foreground[y * width + x] = 255;
    const base = createPartCutterState("pose-guide", width, height, "manual", "2026-11-17T12:00:00.000Z");
    const guide = buildAdaptiveAnatomicalPartitionGuide(base, foreground, "humanoid");
    const handPlaced = { ...guide, landmarks: guide.landmarks.map((landmark) => landmark.landmarkId === "leftKnee" ? { ...landmark, source: "manual" as const, point: { x: 400, y: 900 } } : landmark) };
    const posed = applyPoseLandmarks(handPlaced, poseToLandmarks(courier), foreground);
    const elbow = posed.landmarks.find((landmark) => landmark.landmarkId === "rightElbow")!;
    expect(elbow.source).toBe("pose_model");
    expect(elbow.point.x).toBeCloseTo(Math.round(courier.keypoints.leftElbow.x), 0);
    expect(posed.landmarks.find((landmark) => landmark.landmarkId === "leftKnee")!.point).toEqual({ x: 400, y: 900 });
    // The right forearm's zone now runs along the pose's right forearm.
    const forearm = posed.zones.find((zone) => zone.semanticType === "rightForearm")!;
    const wrist = courier.keypoints.leftWrist;
    expect(forearm.bounds.x).toBeLessThanOrEqual(Math.max(elbow.point.x, Math.min(wrist.x, 779)));
    expect(forearm.bounds.x + forearm.bounds.width).toBeGreaterThanOrEqual(Math.min(elbow.point.x, 779));
  });
});

describe("which way the character faces", () => {
  it("reads a front-facing character as front", () => {
    expect(estimateView(courier)).toMatchObject({ view: "front", facing: "front" });
  });

  it("reads a back view when the character's own left shoulder is on the viewer's left and the face is hidden", () => {
    const k = courier.keypoints;
    const back = variant({ leftShoulder: { x: k.rightShoulder.x }, rightShoulder: { x: k.leftShoulder.x }, leftHip: { x: k.rightHip.x }, rightHip: { x: k.leftHip.x }, nose: { visibility: .1 } });
    expect(estimateView(back)).toMatchObject({ view: "back", facing: "front" });
  });

  it("reads a profile from narrow shoulders and hips, facing where the nose points", () => {
    const k = courier.keypoints; const x = 520;
    const profile = variant({ leftShoulder: { x }, rightShoulder: { x: x + 20 }, leftHip: { x: x + 10 }, rightHip: { x: x + 25 }, nose: { x: x + 110, y: k.nose.y } });
    expect(estimateView(profile)).toMatchObject({ view: "profile", facing: "right" });
    const flipped = variant({ leftShoulder: { x }, rightShoulder: { x: x + 20 }, leftHip: { x: x + 10 }, rightHip: { x: x + 25 }, nose: { x: x - 110 } });
    expect(estimateView(flipped)).toMatchObject({ view: "profile", facing: "left" });
  });

  it("reads a three-quarter view from a partly narrowed torso", () => {
    const k = courier.keypoints;
    const turned = variant({ rightShoulder: { x: k.leftShoulder.x - 110 }, rightHip: { x: k.leftHip.x - 90 }, nose: { x: k.leftShoulder.x + 30 } });
    expect(estimateView(turned)).toMatchObject({ view: "three-quarter", facing: "right" });
  });

  it("gives no answer without confident shoulders and hips", () => {
    expect(estimateView(variant({ leftHip: { visibility: .2 } }))).toBeNull();
  });
});
