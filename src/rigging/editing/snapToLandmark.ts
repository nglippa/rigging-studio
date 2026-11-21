import { invertMatrix, matrixFromTransform, multiplyMatrices, transformPoint, type Point } from "../math/matrix";
import { degreesToRadians } from "../math/rotation";
import { createRestPose } from "../runtime/pose";
import { computeWorldTransforms } from "../runtime/worldTransforms";
import type { RigDefinition } from "../schema/types";

export type Landmark = { readonly x: number; readonly y: number; readonly label: string };

/** The joint word for a bone's landmark: what "Snap to …" says. */
const jointWord = (boneId: string): string =>
  /upper.*arm|shoulder/i.test(boneId) ? "shoulder"
    : /lower.*arm|fore.*arm/i.test(boneId) ? "elbow"
      : /upper.*leg|thigh/i.test(boneId) ? "hip"
        : /lower.*leg|shin|calf/i.test(boneId) ? "knee"
          : /neck|head/i.test(boneId) ? "neck"
            : "landmark";

/** Where Build rig found this bone's joint on the art (rig.metadata.pivotSources), in rig space; null when it recorded none. */
export function landmarkFor(rig: RigDefinition, boneId: string): Landmark | null {
  if (!rig.bones.some((bone) => bone.id === boneId)) return null;
  const sources = rig.metadata?.pivotSources as Record<string, { readonly point?: { readonly x?: unknown; readonly y?: unknown } } | undefined> | undefined;
  const point = sources?.[boneId]?.point;
  if (!point || typeof point.x !== "number" || typeof point.y !== "number" || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: point.x, y: point.y, label: jointWord(boneId) };
}

/**
 * The rig with the bone's pivot moved back onto its landmark. Everything hanging from the bone (child bones and the
 * art drawn on it) keeps its place on screen: only the point the bone turns around moves.
 */
export function snapPivotToLandmark(rig: RigDefinition, boneId: string): RigDefinition {
  const landmark = landmarkFor(rig, boneId);
  const bone = rig.bones.find((candidate) => candidate.id === boneId);
  if (!landmark || !bone) return rig;
  const world = computeWorldTransforms(rig, createRestPose(rig));
  const parent = bone.parentId ? world[bone.parentId] : null;
  const toParent = parent ? invertMatrix(parent.matrix) : null;
  if (parent && !toParent) return rig;
  const origin: Point = toParent ? transformPoint(toParent, landmark) : { x: landmark.x, y: landmark.y };
  // The bone's new frame: same turn and scale, new origin. A point fixed on screen moves in that frame by `shift`.
  const local = matrixFromTransform({ x: origin.x, y: origin.y, rotation: degreesToRadians(bone.rotation), scaleX: bone.scaleX, scaleY: bone.scaleY });
  const moved = parent ? multiplyMatrices(parent.matrix, local) : local;
  const fromMoved = invertMatrix(moved);
  if (!fromMoved) return rig;
  const shift = transformPoint(fromMoved, { x: world[boneId].x, y: world[boneId].y });
  const onBone = new Set(rig.slots.filter((slot) => slot.boneId === boneId).flatMap((slot) => [slot.attachmentId, ...rig.skins.map((skin) => skin.slotAttachments[slot.id])]).filter((id): id is string => typeof id === "string"));
  return {
    ...rig,
    bones: rig.bones.map((candidate) => candidate.id === boneId ? { ...candidate, x: origin.x, y: origin.y }
      : candidate.parentId === boneId ? { ...candidate, x: candidate.x + shift.x, y: candidate.y + shift.y } : candidate),
    attachments: rig.attachments.map((attachment) => onBone.has(attachment.id) ? { ...attachment, offsetX: attachment.offsetX + shift.x, offsetY: attachment.offsetY + shift.y } : attachment),
  };
}
