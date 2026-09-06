import { z } from "zod";
import type { LocalProjectSnapshot } from "../project-storage/types";
import { createDiagnosticCapturePlan } from "../rigging/ai-vision/diagnosticCapturePlan";
import { DiagnosticFrameRenderer } from "../rigging/ai-vision/diagnosticFrameRenderer";
import { evaluateAnimationAtTime } from "../rigging/animation/evaluate";
import { createRestPose } from "../rigging/runtime/pose";
import { computeWorldTransforms } from "../rigging/runtime/worldTransforms";
import { resolveSlots } from "../rigging/runtime/slots";
import { animationDefinitionSchema, boneDefinitionSchema } from "../rigging/schema/schemas";
import { doctorEditSchema, doctorIdentitySchema, doctorReviewSchema, type DoctorIdentity } from "./schema";
import type { MotionMetrics } from "./metrics";

export const evidenceImageSchema = z.object({ id: z.string().min(1).max(160), time: z.number().nonnegative().nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/), dataUrl: z.string().startsWith("data:image/png;base64,").max(4_000_000) }).strict();
export type EvidenceImage = z.infer<typeof evidenceImageSchema>;
const nullableMetric = z.number().finite().nonnegative().nullable();
export const motionMetricsSchema = z.object({ footDrift: nullableMetric, gripError: nullableMetric, loopContinuity: nullableMetric, recoveryError: nullableMetric, motionTravel: z.number().finite().nonnegative(), channelCount: z.number().int().nonnegative(), animationLength: z.number().positive() }).strict();
export const doctorPacketSchema = z.object({
  identity: doctorIdentitySchema, version: z.number().int().min(0).max(3), purpose: z.enum(["propose", "compare"]),
  clip: animationDefinitionSchema, bones: z.array(boneDefinitionSchema).max(200),
  equipment: z.array(z.object({ slotId: z.string(), boneId: z.string(), category: z.string(), tags: z.array(z.string()).max(40) }).strict()).max(100),
  metrics: motionMetricsSchema, baselineMetrics: motionMetricsSchema,
  images: z.array(evidenceImageSchema).min(1).max(8),
  paths: z.array(z.object({ boneId: z.string(), points: z.array(z.object({ time: z.number(), x: z.number(), y: z.number() }).strict()).max(49) }).strict()).max(20),
  evidenceRefs: z.array(z.object({ id: z.string().min(1).max(160), kind: z.enum(["image", "metrics", "paths", "channels", "bone"]), description: z.string().max(600) }).strict()).min(4).max(40),
  previousReview: doctorReviewSchema.nullable(), findings: z.array(z.string().max(600)).max(30),
}).strict();
export type DoctorPacket = z.infer<typeof doctorPacketSchema>;
export const doctorAuditSchema = z.object({
  provider: z.literal("astra-local-agent"), model: z.literal("gpt-6-astra"), jobType: z.literal("ANIMATION_DOCTOR"), identity: doctorIdentitySchema,
  action: z.enum(["reviewed", "accepted", "rejected"]), beforeDigest: z.string().max(160), afterDigest: z.string().max(160),
  acceptedEdits: z.array(doctorEditSchema).max(24),
  versions: z.array(z.object({ version: z.number().int().min(0).max(3), digest: z.string().max(160), review: doctorReviewSchema.nullable(), metrics: motionMetricsSchema, canonicalValidity: z.boolean(), retained: z.boolean(), vetoes: z.array(z.string().max(600)).max(50), imageHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8) }).strict()).min(1).max(4),
  startedAt: z.string().datetime(), completedAt: z.string().datetime(), timestamp: z.string().datetime(),
  toolCalls: z.number().int().min(0).max(12), renderRequests: z.number().int().min(0).max(8),
}).strict();

export async function doctorImage(blob: Blob, id: string, time: number | null): Promise<EvidenceImage> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let binary = ""; bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return { id, time, sha256, dataUrl: `data:image/png;base64,${btoa(binary)}` };
}

export async function renderDoctorSource(snapshot: LocalProjectSnapshot, clipId: string): Promise<EvidenceImage> {
  if (snapshot.project?.sourceImage?.image) {
    const image = new Image(); image.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Source evidence could not load")); image.src = snapshot.project!.sourceImage!.image; });
    const canvas = document.createElement("canvas"); const scale = Math.min(1, 480 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d"); if (!context) throw new Error("Source evidence canvas unavailable");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Source PNG encoding failed")), "image/png"));
    return doctorImage(blob, "source-character", null);
  }
  const restSnapshot = { ...snapshot, animations: { ...snapshot.animations!, animations: snapshot.animations!.animations.map((clip) => clip.id === clipId ? { ...clip, tracks: [] } : clip) } };
  const frame = (await renderDoctorEvidence(restSnapshot, clipId, 0, 0))[0];
  return { ...frame, id: "rest-rig-source-unavailable", time: null };
}

export async function renderDoctorEvidence(snapshot: LocalProjectSnapshot, clipId: string, version: number, time?: number, overlay = false): Promise<EvidenceImage[]> {
  const rig = snapshot.rig!; const clip = snapshot.animations!.animations.find((clip) => clip.id === clipId)!;
  if (time !== undefined && (time < 0 || time > clip.duration || !Number.isFinite(time))) throw new Error("Evidence time outside clip");
  const base = createDiagnosticCapturePlan(clip, { frameCount: 6, frameWidth: 240, frameHeight: 280, includeIndividualFrames: true, overlays: overlay ? { motionArcs: true } : { bones: false, jointPoints: false, groundLine: false, rootTrajectory: false, footTrajectories: false, motionArcs: false } });
  // Unlike playback, diagnostic endpoint sampling must not wrap duration back to zero.
  const plan = { ...base, times: time === undefined ? Array.from({ length: 6 }, (_, i) => clip.duration * i / 5) : [time] };
  const capture = await new DiagnosticFrameRenderer().capture({ ...rig, defaultSkinId: snapshot.selectedSkinId ?? rig.defaultSkinId }, clip, plan, {
    leftFootBoneId: rig.bones.find((bone) => /left.*foot/i.test(bone.id))?.id ?? null,
    rightFootBoneId: rig.bones.find((bone) => /right.*foot/i.test(bone.id))?.id ?? null, groundPlaneY: rig.canvas.height * .92,
  });
  return Promise.all(capture.individualFrames.map((blob, i) => doctorImage(blob, `v${version}-frame-${time === undefined ? i : `at-${time}`}`, plan.times[i])));
}

export function inspectDoctorPacket(snapshot: LocalProjectSnapshot, identity: DoctorIdentity, version: number, metrics: MotionMetrics, baselineMetrics: MotionMetrics, images: EvidenceImage[]): DoctorPacket {
  const rig = snapshot.rig!; const clip = snapshot.animations!.animations.find((clip) => clip.id === identity.clipId)!;
  const paths = rig.bones.filter((bone) => bone.id === rig.rootBoneId || /pelvis|hip|foot|hand|weapon/i.test(bone.id)).slice(0, 20).map((bone) => ({ boneId: bone.id, points: Array.from({ length: 25 }, (_, i) => {
    const time = clip.duration * i / 24; const world = computeWorldTransforms(rig, evaluateAnimationAtTime(clip, createRestPose(rig), time))[bone.id];
    return { time, x: world.x, y: world.y };
  }) }));
  const evidenceRefs = [
    { id: "metrics", kind: "metrics", description: "Deterministic motion metrics for this clip." },
    { id: "paths", kind: "paths", description: "World-space trajectories for selected bones." },
    { id: "channels", kind: "channels", description: "Current clip channels and exact keyframe values." },
    ...images.map((image) => ({ id: image.id, kind: "image" as const, description: `Rendered evidence at ${image.time === null ? "source" : `${image.time.toFixed(3)} seconds`}.` })),
    ...rig.bones.slice(0, 20).map((bone) => ({ id: `bone:${bone.id}`, kind: "bone" as const, description: `Setup transform for ${bone.id}.` })),
  ];
  return doctorPacketSchema.parse({ identity, version, purpose: "propose", clip, bones: rig.bones, equipment: resolveSlots(rig, snapshot.selectedSkinId ?? rig.defaultSkinId, {}).flatMap(({ slot, attachment }) => {
    return attachment?.category === "equipment" ? [{ slotId: slot.id, boneId: slot.boneId, category: attachment.category, tags: [...attachment.tags] }] : [];
  }), metrics, baselineMetrics, images, paths, evidenceRefs, previousReview: null, findings: [
    "metrics and paths refer to world coordinates; key values are absolute LOCAL transforms, degrees and seconds",
    "metrics: footDrift and gripError are null without authored contact intervals and socket pairs; null is unmeasured, never a pass",
    "recoveryError measures end-to-start pose distance; it is not an authored recovery target",
    "frame-0 and frame-5 show the literal clip endpoints; overlays show bone joints and motion paths",
  ] });
}
