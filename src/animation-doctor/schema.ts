import { z } from "zod";

export const DOCTOR_LIMITS = Object.freeze({ iterations: 3, toolCalls: 12, renders: 8, edits: 24, rotationDelta: 15, translationDelta: 12, timeoutMs: 300_000 });
const id = z.string().min(1).max(160);
const text = z.string().min(1).max(600);
export const doctorIdentitySchema = z.object({ projectId: id, projectSessionToken: id, revision: z.number().int().nonnegative(), clipId: id, beforeDigest: id }).strict();
export type DoctorIdentity = z.infer<typeof doctorIdentitySchema>;
export const doctorEditSchema = z.object({
  id, boneId: id, property: z.enum(["rotation", "x", "y"]), time: z.number().finite().nonnegative(),
  currentValue: z.number().finite(), proposedValue: z.number().finite(),
  reasonCode: z.enum(["loop_pop", "foot_slide", "grip_separation", "over_rotation", "anticipation", "follow_through", "recovery", "weight_transfer", "secondary_motion"]),
  expectedVisualEffect: text, confidence: z.number().min(0).max(1), evidence: z.array(id).min(1).max(8),
}).strict();
export type DoctorEdit = z.infer<typeof doctorEditSchema>;
export const doctorIssueSchema = z.object({ boneId: id, severity: z.enum(["low", "medium", "critical"]), description: text, evidence: z.array(id).min(1).max(8) }).strict();
export const doctorToolRequestSchema = z.object({ tool: z.enum(["inspect_bone", "render_pose"]), boneId: id.nullable(), time: z.number().finite().nonnegative().nullable() }).strict().superRefine((request, context) => { if (request.tool === "render_pose" && request.time === null) context.addIssue({ code: "custom", path: ["time"], message: "render_pose requires an explicit bounded time" }); });
export const doctorReviewSchema = z.object({
  issues: z.array(doctorIssueSchema).max(24), edits: z.array(doctorEditSchema).max(DOCTOR_LIMITS.edits),
  visualScore: z.number().finite().min(0).max(1), expectedImprovement: text,
  rerenderRequired: z.boolean(), requests: z.array(doctorToolRequestSchema).max(2),
}).strict();
export type DoctorReview = z.infer<typeof doctorReviewSchema>;
export const doctorProposalSchema = z.object({ identity: doctorIdentitySchema, edits: z.array(doctorEditSchema).min(1).max(DOCTOR_LIMITS.edits) }).strict();
export type DoctorProposal = z.infer<typeof doctorProposalSchema>;
export const DOCTOR_REVIEW_JSON_SCHEMA = z.toJSONSchema(doctorReviewSchema);

// Contact phases and sockets are author-owned measurement constraints, never model output.
export const doctorMeasurementSchema = z.object({
  contacts: z.array(z.object({ boneId: id, start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative() }).strict()).max(16),
  grips: z.array(z.object({ handBoneId: id, equipmentBoneId: id, handX: z.number().finite(), handY: z.number().finite(), equipmentX: z.number().finite(), equipmentY: z.number().finite() }).strict()).max(8),
}).strict();
export type DoctorMeasurements = z.infer<typeof doctorMeasurementSchema>;
