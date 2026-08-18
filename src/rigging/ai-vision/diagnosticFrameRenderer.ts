import { evaluateAnimationAtTime } from "../animation/evaluate";
import { degreesToRadians } from "../math/rotation";
import { matrixFromTransform, multiplyMatrices, transformPoint, type Matrix2D } from "../math/matrix";
import { createRestPose } from "../runtime/pose";
import { resolveSlots } from "../runtime/slots";
import { computeWorldTransforms } from "../runtime/worldTransforms";
import type { RigPose, WorldTransforms } from "../runtime/types";
import type { AnimationDefinition, RigDefinition } from "../schema/types";
import type { DiagnosticCapturePlan } from "./diagnosticCapturePlan";

export type DiagnosticSceneOptions = {
  readonly leftFootBoneId: string | null;
  readonly rightFootBoneId: string | null;
  readonly groundPlaneY: number;
};
export type DiagnosticFrameSample = { readonly time: number; readonly pose: RigPose; readonly world: WorldTransforms };
export type DiagnosticCaptureResult = {
  readonly plan: DiagnosticCapturePlan;
  readonly contactSheet: Blob;
  readonly individualFrames: readonly Blob[];
  readonly samples: readonly DiagnosticFrameSample[];
};

type LoadedImage = { readonly attachmentId: string; readonly image: HTMLImageElement };
const sampleTimes = (duration: number, count = 41): readonly number[] => Array.from({ length: count }, (_, index) => duration * index / Math.max(1, count - 1));

export const sampleDiagnosticFrames = (rig: RigDefinition, animation: AnimationDefinition, plan: DiagnosticCapturePlan): readonly DiagnosticFrameSample[] => {
  const setup = createRestPose(rig);
  return plan.times.map((time) => {
    const pose = evaluateAnimationAtTime(animation, setup, time);
    return { time, pose, world: computeWorldTransforms(rig, pose) };
  });
};

const canvasBlob = (canvas: HTMLCanvasElement): Promise<Blob> => new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Canvas PNG encoding failed")), "image/png"));

const loadImage = (path: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image();
  image.decoding = "async";
  image.crossOrigin = "anonymous";
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(`Diagnostic capture could not load "${path}"`));
  image.src = path.startsWith("/") || path.startsWith("blob:") || path.startsWith("data:") ? path : `/${path}`;
});

const applyMatrix = (context: CanvasRenderingContext2D, matrix: Matrix2D, scale: number, offsetX: number, offsetY: number): void =>
  context.setTransform(matrix.a * scale, matrix.b * scale, matrix.c * scale, matrix.d * scale, offsetX + matrix.tx * scale, offsetY + matrix.ty * scale);

const drawPath = (context: CanvasRenderingContext2D, points: readonly { readonly x: number; readonly y: number }[], scale: number, offsetX: number, offsetY: number, color: string): void => {
  if (!points.length) return;
  context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.beginPath(); context.moveTo(offsetX + points[0].x * scale, offsetY + points[0].y * scale);
  points.slice(1).forEach((point) => context.lineTo(offsetX + point.x * scale, offsetY + point.y * scale));
  context.strokeStyle = color; context.globalAlpha = .58; context.lineWidth = 1.5; context.stroke(); context.restore();
};

const CANVAS_BLEND_MODES: Readonly<Record<"normal" | "add" | "multiply" | "screen", GlobalCompositeOperation>> = { normal: "source-over", add: "lighter", multiply: "multiply", screen: "screen" };
const canvasBlendMode = (mode: "normal" | "add" | "multiply" | "screen"): GlobalCompositeOperation => CANVAS_BLEND_MODES[mode];

const tintedImage = (image: HTMLImageElement, tint: number): CanvasImageSource => {
  if (tint === 0xffffff) return image;
  const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d"); if (!context) return image;
  context.drawImage(image, 0, 0); context.globalCompositeOperation = "multiply"; context.fillStyle = `#${tint.toString(16).padStart(6, "0")}`; context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "destination-in"; context.drawImage(image, 0, 0); context.globalCompositeOperation = "source-over";
  return canvas;
};

export class DiagnosticFrameRenderer {
  async capture(rig: RigDefinition, animation: AnimationDefinition, plan: DiagnosticCapturePlan, scene: DiagnosticSceneOptions): Promise<DiagnosticCaptureResult> {
    if (typeof document === "undefined") throw new Error("Diagnostic frame capture requires a browser canvas environment");
    const samples = sampleDiagnosticFrames(rig, animation, plan);
    const resolved = resolveSlots(rig, rig.defaultSkinId, {}).filter((item) => item.slot.visible && item.attachment).sort((left, right) => left.slot.zIndex - right.slot.zIndex);
    const attachmentIds = [...new Set(resolved.flatMap((item) => item.attachment ? [item.attachment.id] : []))];
    const images: LoadedImage[] = await Promise.all(attachmentIds.map(async (attachmentId) => {
      const attachment = rig.attachments.find((candidate) => candidate.id === attachmentId);
      if (!attachment) throw new Error(`Attachment "${attachmentId}" is missing`);
      return { attachmentId, image: await loadImage(attachment.imagePath) };
    }));
    const imageMap = new Map(images.map((item) => [item.attachmentId, item.image]));
    const tintedImages = new Map(resolved.flatMap(({ slot, attachment }) => {
      const image = attachment ? imageMap.get(attachment.id) : undefined;
      return attachment && image ? [[`${attachment.id}:${slot.tint}`, tintedImage(image, slot.tint)] as const] : [];
    }));
    const trajectoryTimes = sampleTimes(animation.duration);
    const trajectoryWorld = trajectoryTimes.map((time) => computeWorldTransforms(rig, evaluateAnimationAtTime(animation, createRestPose(rig), time)));
    const trajectory = (boneId: string | null): readonly { readonly x: number; readonly y: number }[] => boneId ? trajectoryWorld.flatMap((world) => world[boneId] ? [{ x: world[boneId].x, y: world[boneId].y }] : []) : [];
    const rootPoints = trajectory(rig.rootBoneId);
    const leftFootPoints = trajectory(scene.leftFootBoneId);
    const rightFootPoints = trajectory(scene.rightFootBoneId);
    const arcBoneIds = rig.bones.filter((bone) => /hand|foot|weapon/i.test(bone.id)).map((bone) => bone.id);
    const arcPoints = new Map(arcBoneIds.map((boneId) => [boneId, trajectory(boneId)]));
    const frames: HTMLCanvasElement[] = [];

    for (const sample of samples) {
      const canvas = document.createElement("canvas"); canvas.width = plan.frameWidth; canvas.height = plan.frameHeight;
      const context = canvas.getContext("2d"); if (!context) throw new Error("2D diagnostic canvas is unavailable");
      context.fillStyle = plan.backgroundColor; context.fillRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(plan.frameWidth / rig.canvas.width, plan.frameHeight / rig.canvas.height) * .92;
      const offsetX = (plan.frameWidth - rig.canvas.width * scale) / 2; const offsetY = (plan.frameHeight - rig.canvas.height * scale) / 2;
      if (plan.overlays.groundLine) {
        context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.beginPath(); context.moveTo(0, offsetY + scene.groundPlaneY * scale); context.lineTo(plan.frameWidth, offsetY + scene.groundPlaneY * scale); context.strokeStyle = "rgba(255,213,108,.62)"; context.setLineDash([6, 5]); context.stroke(); context.restore();
      }
      if (plan.overlays.rootTrajectory) drawPath(context, rootPoints, scale, offsetX, offsetY, "#f4c45f");
      if (plan.overlays.footTrajectories) { drawPath(context, leftFootPoints, scale, offsetX, offsetY, "#63b7ff"); drawPath(context, rightFootPoints, scale, offsetX, offsetY, "#ff7f68"); }
      if (plan.overlays.motionArcs) arcPoints.forEach((points, boneId) => drawPath(context, points, scale, offsetX, offsetY, /left/i.test(boneId) ? "#69c6ff" : "#ff9b77"));

      for (const { slot, attachment } of resolved) {
        if (!attachment) continue;
        const bone = sample.world[slot.boneId]; const image = tintedImages.get(`${attachment.id}:${slot.tint}`); if (!bone || !image) continue;
        const matrix = multiplyMatrices(bone.matrix, matrixFromTransform({ x: attachment.offsetX, y: attachment.offsetY, rotation: degreesToRadians(attachment.rotation), scaleX: attachment.scaleX, scaleY: attachment.scaleY }));
        context.save(); applyMatrix(context, matrix, scale, offsetX, offsetY); context.globalAlpha = 1; context.globalCompositeOperation = canvasBlendMode(slot.blendMode); context.drawImage(image, -slot.pivotX, -slot.pivotY, attachment.width, attachment.height);
        if (plan.overlays.slotBounds) { context.strokeStyle = "rgba(97,216,255,.85)"; context.lineWidth = 1 / scale; context.strokeRect(-slot.pivotX, -slot.pivotY, attachment.width, attachment.height); }
        context.restore();
      }
      if (plan.overlays.bones || plan.overlays.jointPoints || plan.overlays.boneNames) {
        context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.font = "10px ui-monospace, monospace";
        rig.bones.forEach((bone) => {
          const transform = sample.world[bone.id]; if (!transform) return; const end = transformPoint(transform.matrix, { x: bone.length, y: 0 });
          const x = offsetX + transform.x * scale; const y = offsetY + transform.y * scale;
          if (plan.overlays.bones) { context.beginPath(); context.moveTo(x, y); context.lineTo(offsetX + end.x * scale, offsetY + end.y * scale); context.strokeStyle = "rgba(111,235,255,.86)"; context.lineWidth = 1.5; context.stroke(); }
          if (plan.overlays.jointPoints) { context.beginPath(); context.arc(x, y, 2.8, 0, Math.PI * 2); context.fillStyle = "#d8fbff"; context.fill(); }
          if (plan.overlays.boneNames) { context.fillStyle = "rgba(224,247,250,.86)"; context.fillText(bone.id, x + 4, y - 4); }
        });
        context.restore();
      }
      frames.push(canvas);
    }

    const sheet = document.createElement("canvas"); sheet.width = plan.contactSheetWidth; sheet.height = plan.contactSheetHeight;
    const sheetContext = sheet.getContext("2d"); if (!sheetContext) throw new Error("Contact-sheet canvas is unavailable");
    sheetContext.fillStyle = "#090d0f"; sheetContext.fillRect(0, 0, sheet.width, sheet.height);
    frames.forEach((frameCanvas, index) => {
      const column = index % plan.columns; const row = Math.floor(index / plan.columns); const x = column * plan.frameWidth; const y = row * (plan.frameHeight + plan.labelHeight);
      sheetContext.drawImage(frameCanvas, x, y); sheetContext.fillStyle = "#151d20"; sheetContext.fillRect(x, y + plan.frameHeight, plan.frameWidth, plan.labelHeight);
      sheetContext.fillStyle = "#b8c8cc"; sheetContext.font = "11px ui-monospace, monospace"; sheetContext.fillText(`FRAME ${String(index + 1).padStart(2, "0")}  ${samples[index].time.toFixed(3)}s`, x + 8, y + plan.frameHeight + 15);
    });
    const contactSheet = await canvasBlob(sheet);
    const individualFrames = plan.includeIndividualFrames ? await Promise.all(frames.map(canvasBlob)) : [];
    return { plan, contactSheet, individualFrames, samples };
  }
}
