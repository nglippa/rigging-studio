/**
 * The rig's pose drawn as an OpenPose COCO-18 skeleton (coloured limb sticks and joint discs on black), the input the
 * RefControl pose LoRA for FLUX.2 Klein 4B is trained on: "image 1: an OpenPose-style COCO-18 render; image 2: the
 * reference; prompt: apply pose from image 1 with reference from image 2" (xocialize/refcontrol-FLUX.2-klein-4B-pose-lora).
 *
 * Joints come from the rig's bones (shoulder = upper arm origin, elbow = lower arm origin, wrist = hand origin, and the same
 * for legs); the face points from the head's art. OpenPose's "right" is the person's right, which is the screen-left side
 * of a character facing the viewer, and the rig names sides by the screen, so screen-left rig bones are OpenPose's right.
 */
import { PNG } from "pngjs";
import { matrixFromTransform, multiplyMatrices, transformPoint } from "../../rigging/math/matrix";
import { degreesToRadians } from "../../rigging/math/rotation";
import type { RigPose } from "../../rigging/runtime/types";
import { computeWorldTransforms } from "../../rigging/runtime/worldTransforms";
import type { RigDefinition } from "../../rigging/schema/types";

type Point = { readonly x: number; readonly y: number };

/** controlnet_aux / OpenPose body colours, one per joint and per limb, in order. */
const COLOURS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 85], [255, 0, 170]] as const;
/** COCO-18 limbs (0-based joint pairs), in OpenPose's drawing order. */
const LIMBS = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]] as const;

/** The 18 COCO joints of a pose, in picture pixels, or null where the rig has no such bone. */
export function poseJoints(rig: RigDefinition, pose: RigPose): (Point | null)[] {
  const world = computeWorldTransforms(rig, pose);
  // A limb the character doesn't show (an arm behind a shield) is left out: drawn as a stick, the model paints an arm there.
  const hidden = new Set(Array.isArray(rig.metadata?.hiddenAnatomy) ? rig.metadata.hiddenAnatomy as string[] : []);
  const bone = (pattern: RegExp): Point | null => { const found = rig.bones.find((candidate) => pattern.test(candidate.id)); const at = found && !hidden.has(found.id) ? world[found.id] : undefined; return at ? { x: at.x, y: at.y } : null; };
  // OpenPose right = person's right = the rig's screen-left side (see the module note).
  const side = (openPoseSide: "R" | "L") => (openPoseSide === "R" ? "left" : "right");
  const arm = (s: "R" | "L", piece: RegExp) => bone(new RegExp(`^${side(s)}-${piece.source}`));
  // The face: the head art's centre (its slot attachment placed by the head bone), with eyes and ears either side.
  const headSlot = rig.slots.find((slot) => /head/.test(slot.boneId) && slot.attachmentId);
  const headArt = headSlot ? rig.attachments.find((attachment) => attachment.id === headSlot.attachmentId) : undefined;
  let face: Point | null = null; let headWidth = 0;
  if (headSlot && headArt && world[headSlot.boneId]) {
    const matrix = multiplyMatrices(world[headSlot.boneId].matrix, matrixFromTransform({ x: headArt.offsetX, y: headArt.offsetY, rotation: degreesToRadians(headArt.rotation), scaleX: headArt.scaleX, scaleY: headArt.scaleY }));
    face = transformPoint(matrix, { x: headArt.width / 2 - headSlot.pivotX, y: headArt.height * .58 - headSlot.pivotY }); headWidth = headArt.width;
  }
  const neck = bone(/^neck$/) ?? bone(/^head$/);
  const eye = (dx: number) => face ? { x: face.x + dx * headWidth, y: face.y - headWidth * .06 } : null;
  return [
    face, neck,
    arm("R", /upper-arm/), arm("R", /lower-arm|forearm/), arm("R", /hand/),
    arm("L", /upper-arm/), arm("L", /lower-arm|forearm/), arm("L", /hand/),
    arm("R", /upper-leg|thigh/), arm("R", /lower-leg/), arm("R", /foot/),
    arm("L", /upper-leg|thigh/), arm("L", /lower-leg/), arm("L", /foot/),
    eye(-.12), eye(.12), eye(-.32), eye(.32),
  ];
}

/**
 * The skeleton as a PNG of `width` x `height`, where picture point (x, y) lands at ((x - originX) * scale, ...). Stick
 * width follows OpenPose's 4 px at 512 px.
 */
export function renderPoseSkeleton(joints: readonly (Point | null)[], width: number, height: number, origin: Point, scale: number): Uint8Array {
  const png = new PNG({ width, height }); for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 0; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = 255; }
  const at = (point: Point) => ({ x: (point.x - origin.x) * scale, y: (point.y - origin.y) * scale });
  const stick = Math.max(3, Math.round(Math.max(width, height) / 512 * 4));
  const blend = (x: number, y: number, colour: readonly number[], alpha: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return; const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c += 1) png.data[i + c] = Math.round(png.data[i + c] * (1 - alpha) + colour[c] * alpha);
  };
  LIMBS.forEach(([a, b], index) => {
    const from = joints[a]; const to = joints[b]; if (!from || !to) return;
    const p = at(from); const q = at(to); const length = Math.hypot(q.x - p.x, q.y - p.y);
    const left = Math.floor(Math.min(p.x, q.x) - stick); const right = Math.ceil(Math.max(p.x, q.x) + stick);
    const top = Math.floor(Math.min(p.y, q.y) - stick); const bottom = Math.ceil(Math.max(p.y, q.y) + stick);
    for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) {
      // Inside the stick (an ellipse along the limb, as OpenPose draws it).
      const t = length ? Math.max(0, Math.min(1, ((x - p.x) * (q.x - p.x) + (y - p.y) * (q.y - p.y)) / (length * length))) : 0;
      const distance = Math.hypot(x - (p.x + (q.x - p.x) * t), y - (p.y + (q.y - p.y) * t));
      if (distance <= stick) blend(x, y, COLOURS[index], .6);
    }
  });
  joints.forEach((joint, index) => {
    if (!joint) return; const p = at(joint);
    for (let y = Math.floor(p.y - stick); y <= Math.ceil(p.y + stick); y += 1) for (let x = Math.floor(p.x - stick); x <= Math.ceil(p.x + stick); x += 1) if (Math.hypot(x - p.x, y - p.y) <= stick) blend(x, y, COLOURS[index], 1);
  });
  return PNG.sync.write(png);
}
