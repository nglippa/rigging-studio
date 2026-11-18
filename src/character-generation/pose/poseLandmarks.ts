import type { PoseLandmarkPoint } from "../../part-cutter/adaptiveGuide";
import type { AnatomicalLandmarkId } from "../../part-cutter/schema";
import type { DetectedPose, PoseKeypoint, PoseKeypointName } from "./poseDetector";

/**
 * The pose model is only consulted for images at least this large on their short side. On a 48 px pixel sprite it made
 * the joints worse (mean error 7.5% of height against 5.0% from the silhouette alone, tests/rigging/guide-accuracy.test.ts):
 * it is trained on photographs of people and reads a held shield as a shoulder.
 */
export const POSE_MODEL_MIN_SIDE = 256;
export const poseModelSuitable = (width: number, height: number): boolean => Math.min(width, height) >= POSE_MODEL_MIN_SIDE;

/** A keypoint is used only when the model is at least this sure it is in view. */
export const MIN_KEYPOINT_VISIBILITY = .6;

const usable = (pose: DetectedPose, point: PoseKeypoint): boolean =>
  point.visibility >= MIN_KEYPOINT_VISIBILITY
  && point.x >= -pose.width * .02 && point.x <= pose.width * 1.02 && point.y >= -pose.height * .02 && point.y <= pose.height * 1.02;
const mid = (a: PoseKeypoint, b: PoseKeypoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/**
 * The guide's joints from a pose. The guide names limbs by screen side (its "left" arm is the one on the viewer's
 * left), while the model names them by the character's own side, so each limb chain is matched by where it sits on
 * screen. Only confident keypoints inside the image are returned; the rest keep their silhouette estimate.
 */
export function poseToLandmarks(pose: DetectedPose): Partial<Record<AnatomicalLandmarkId, PoseLandmarkPoint>> {
  const k = pose.keypoints; const out: Partial<Record<AnatomicalLandmarkId, PoseLandmarkPoint>> = {};
  const put = (id: AnatomicalLandmarkId, point: PoseKeypoint) => { if (usable(pose, point)) out[id] = { point: { x: point.x, y: point.y }, confidence: point.visibility }; };
  const armsSwap = k.leftShoulder.x > k.rightShoulder.x; const legsSwap = k.leftHip.x > k.rightHip.x;
  const side = (swap: boolean, screenLeft: boolean, left: PoseKeypointName, right: PoseKeypointName) => k[(screenLeft !== swap) ? left : right];
  for (const screenLeft of [true, false]) {
    const prefix = screenLeft ? "left" : "right";
    put(`${prefix}Shoulder` as AnatomicalLandmarkId, side(armsSwap, screenLeft, "leftShoulder", "rightShoulder"));
    put(`${prefix}Elbow` as AnatomicalLandmarkId, side(armsSwap, screenLeft, "leftElbow", "rightElbow"));
    put(`${prefix}Wrist` as AnatomicalLandmarkId, side(armsSwap, screenLeft, "leftWrist", "rightWrist"));
    put(`${prefix}Hip` as AnatomicalLandmarkId, side(legsSwap, screenLeft, "leftHip", "rightHip"));
    put(`${prefix}Knee` as AnatomicalLandmarkId, side(legsSwap, screenLeft, "leftKnee", "rightKnee"));
    put(`${prefix}Ankle` as AnatomicalLandmarkId, side(legsSwap, screenLeft, "leftAnkle", "rightAnkle"));
  }
  const shouldersOk = usable(pose, k.leftShoulder) && usable(pose, k.rightShoulder);
  const hipsOk = usable(pose, k.leftHip) && usable(pose, k.rightHip);
  const confidence = (...points: PoseKeypoint[]) => Math.min(...points.map((point) => point.visibility));
  if (hipsOk) { const pelvis = mid(k.leftHip, k.rightHip); out.pelvis = { point: pelvis, confidence: confidence(k.leftHip, k.rightHip) }; out.root = out.pelvis; }
  if (shouldersOk) {
    const shoulders = mid(k.leftShoulder, k.rightShoulder);
    // The neck sits a little above the shoulder line, toward the face.
    const neck = usable(pose, k.nose) ? lerp(shoulders, k.nose, .25) : shoulders;
    out.neck = { point: neck, confidence: confidence(k.leftShoulder, k.rightShoulder) };
    if (hipsOk) out.chest = { point: lerp(shoulders, mid(k.leftHip, k.rightHip), .3), confidence: confidence(k.leftShoulder, k.rightShoulder, k.leftHip, k.rightHip) };
  }
  const face = [k.nose, k.leftEar, k.rightEar].filter((point) => usable(pose, point));
  if (face.length >= 2) out.head = { point: { x: face.reduce((sum, point) => sum + point.x, 0) / face.length, y: face.reduce((sum, point) => sum + point.y, 0) / face.length }, confidence: Math.min(...face.map((point) => point.visibility)) };
  return out;
}

export type CharacterView = "front" | "back" | "three-quarter" | "profile";
/** Which way the character is drawn. `facing` is the screen direction it looks toward, as the motion engine uses it. */
export type ViewEstimate = { readonly view: CharacterView; readonly facing: "left" | "right" | "front"; readonly confidence: number };

/**
 * The view, from how wide the shoulders and hips look against the torso's length, how far apart the two shoulders are
 * in depth, and which way the nose points. Front and back are told apart by which of the character's own shoulders is
 * on the viewer's left. Null when the shoulders or hips are not found confidently.
 */
export function estimateView(pose: DetectedPose): ViewEstimate | null {
  const k = pose.keypoints;
  if (![k.leftShoulder, k.rightShoulder, k.leftHip, k.rightHip].every((point) => usable(pose, point))) return null;
  const shoulders = mid(k.leftShoulder, k.rightShoulder); const hips = mid(k.leftHip, k.rightHip);
  const torso = Math.hypot(shoulders.x - hips.x, shoulders.y - hips.y); if (torso < 1) return null;
  const width = Math.max(Math.abs(k.leftShoulder.x - k.rightShoulder.x), Math.abs(k.leftHip.x - k.rightHip.x)) / torso;
  const depth = Math.abs(k.leftShoulder.z - k.rightShoulder.z);
  const noseSeen = k.nose.visibility >= .5;
  const lookOffset = noseSeen ? (k.nose.x - shoulders.x) / torso : 0;
  const look: "left" | "right" = lookOffset >= 0 ? "right" : "left";
  // Facing the viewer, the character's own left shoulder is on the viewer's right.
  const facesViewer = k.leftShoulder.x > k.rightShoulder.x;
  if (width < .2) return { view: "profile", facing: noseSeen ? look : facesViewer ? "right" : "left", confidence: .8 };
  if (width < .42 || depth > .45) return { view: "three-quarter", facing: look, confidence: .7 };
  if (!facesViewer && !noseSeen) return { view: "back", facing: "front", confidence: .6 };
  return { view: "front", facing: "front", confidence: Math.min(.95, .6 + width / 2) };
}
