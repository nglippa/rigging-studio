import { z } from "zod";

export const VISION_REVIEW_JOB_TYPES = [
  "CUT_MASK_REVIEW",
  "OCCLUSION_RECONSTRUCTION_REVIEW",
  "CANONICAL_OWNERSHIP_REVIEW",
  "RIG_POSE_REVIEW",
  "ANIMATION_REVIEW",
] as const;
export const VISION_REVIEW_DECISIONS = ["ACCEPT", "REPAIR", "RECUT", "ESCALATE", "HUMAN_REVIEW"] as const;
export const VISION_REVIEW_PROVIDER_STATES = ["AVAILABLE_AND_MULTIMODAL", "AVAILABLE_TEXT_ONLY", "UNAVAILABLE", "AUTH_REQUIRED", "UNSUPPORTED_TRANSPORT"] as const;
export const VISION_REVIEW_POLICIES = ["local-first", "claude-first", "codex-first", "manual-only"] as const;

const id = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "Use a contained identifier");
const boundedText = z.string().max(4000);
const score = z.number().finite().min(0).max(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const visionReviewArtifactSchema = z.object({
  name: id,
  role: z.enum(["source", "mask", "isolated_part", "overlay", "reconstruction", "pose", "animation_frame", "candidate", "context"]),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  sha256,
  bytes: z.number().int().positive().max(24 * 1024 * 1024),
  candidateId: id.optional(),
}).strict();
export type VisionReviewArtifact = z.infer<typeof visionReviewArtifactSchema>;

export const visionReviewJobSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: id,
  parentJobId: id.nullable(),
  attempt: z.number().int().min(1).max(10),
  maxAttempts: z.number().int().min(1).max(10),
  type: z.enum(VISION_REVIEW_JOB_TYPES),
  mode: z.enum(["SINGLE", "RANK_CANDIDATES"]),
  subject: boundedText.min(1),
  expectedSemantic: z.string().trim().min(1).max(120).nullable(),
  deterministicFindings: z.array(z.string().trim().min(1).max(1000)).max(50),
  candidateIds: z.array(id).max(20),
  artifacts: z.array(visionReviewArtifactSchema).min(1).max(40),
  promptSchemaVersion: z.literal("vision-review-prompt-v1"),
  createdAt: z.string().datetime(),
  repairApplied: z.string().max(2000).nullable(),
}).strict().superRefine((job, context) => {
  if (job.attempt > job.maxAttempts) context.addIssue({ code: "custom", path: ["attempt"], message: "Attempt exceeds maxAttempts" });
  if (job.mode === "RANK_CANDIDATES" && job.candidateIds.length < 2) context.addIssue({ code: "custom", path: ["candidateIds"], message: "Candidate ranking requires at least two candidates" });
  const artifactCandidates = new Set(job.artifacts.map((artifact) => artifact.candidateId).filter(Boolean));
  job.candidateIds.forEach((candidateId) => { if (!artifactCandidates.has(candidateId)) context.addIssue({ code: "custom", path: ["artifacts"], message: `Candidate ${candidateId} has no attached artifact` }); });
});
export type VisionReviewJob = z.infer<typeof visionReviewJobSchema>;

export const visionReviewIssueSchema = z.object({
  type: z.string().trim().min(1).max(120),
  region: z.string().trim().min(1).max(240),
  severity: z.enum(["low", "medium", "high"]),
  description: z.string().trim().min(1).max(1000),
}).strict();

export const visionReviewRankingSchema = z.object({
  orderedCandidateIds: z.array(id).min(2).max(20),
  preferredCandidateId: id,
  confidenceGap: score,
  candidateDefects: z.array(z.object({ candidateId: id, defects: z.array(z.string().trim().min(1).max(500)).max(20) }).strict()).min(2).max(20),
}).strict();

export const visionReviewResultSchema = z.object({
  decision: z.enum(VISION_REVIEW_DECISIONS),
  confidence: score,
  semanticCorrectness: score,
  foreignPixelRisk: score,
  missingAnatomyRisk: score,
  jointRisk: score,
  occlusionRisk: score,
  issues: z.array(visionReviewIssueSchema).max(50),
  recommendedAction: z.string().trim().min(1).max(2000),
  notes: boundedText,
  ranking: visionReviewRankingSchema.nullable().optional(),
}).strict();
export type VisionReviewResult = z.infer<typeof visionReviewResultSchema>;

export const visionReviewProvenanceSchema = z.object({
  providerId: id,
  providerVersion: z.string().max(200).nullable(),
  model: z.string().max(240).nullable(),
  classification: z.enum(["local", "account-backed-cloud", "manual"]),
  authenticatedViaExistingSession: z.boolean(),
  timestamp: z.string().datetime(),
  sourceArtifactHashes: z.record(id, sha256),
  promptSchemaVersion: z.literal("vision-review-prompt-v1"),
  resultSchemaVersion: z.literal("vision-review-result-v1"),
  resultSha256: sha256,
  latencyMs: z.number().int().nonnegative(),
  deterministicVetoes: z.array(z.string().trim().min(1).max(1000)).max(50),
}).strict();
export type VisionReviewProvenance = z.infer<typeof visionReviewProvenanceSchema>;

export const persistedVisionReviewResultSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: id,
  result: visionReviewResultSchema,
  provenance: visionReviewProvenanceSchema,
}).strict();
export type PersistedVisionReviewResult = z.infer<typeof persistedVisionReviewResultSchema>;

export const visionReviewCapabilitiesSchema = z.object({
  providerId: id,
  label: z.string().trim().min(1).max(120),
  state: z.enum(VISION_REVIEW_PROVIDER_STATES),
  available: z.boolean(),
  multimodal: z.boolean(),
  supportsSourceImage: z.boolean(),
  supportsMaskImage: z.boolean(),
  supportsRenderedPose: z.boolean(),
  supportsAnimationFrames: z.boolean(),
  structuredOutput: z.boolean(),
  localOnly: z.boolean(),
  usesExistingAccountSession: z.boolean(),
  supportsIterativeReview: z.boolean(),
  supportsRelativeRanking: z.boolean(),
  supportedJobTypes: z.array(z.enum(VISION_REVIEW_JOB_TYPES)),
  transport: z.string().max(240),
  version: z.string().max(200).nullable(),
  model: z.string().max(240).nullable(),
  failureReason: z.string().max(2000).nullable(),
}).strict();
export type VisionReviewCapabilities = z.infer<typeof visionReviewCapabilitiesSchema>;

export const visionReviewProviderPolicySchema = z.object({
  policy: z.enum(VISION_REVIEW_POLICIES),
  maxAttempts: z.number().int().min(1).max(3).default(3),
}).strict();
export type VisionReviewProviderPolicy = z.infer<typeof visionReviewProviderPolicySchema>;

export function validateVisionReviewResult(input: unknown, job?: VisionReviewJob): VisionReviewResult {
  const result = visionReviewResultSchema.parse(input);
  if (job?.mode === "RANK_CANDIDATES") {
    if (!result.ranking) throw new Error("Candidate-ranking review omitted ranking");
    const expected = new Set(job.candidateIds); const ordered = new Set(result.ranking.orderedCandidateIds);
    if (ordered.size !== expected.size || [...expected].some((candidateId) => !ordered.has(candidateId))) throw new Error("Candidate ranking must contain every attached candidate exactly once");
    if (!expected.has(result.ranking.preferredCandidateId)) throw new Error("Preferred candidate is not part of this review job");
    const defectIds = new Set(result.ranking.candidateDefects.map((entry) => entry.candidateId));
    if (defectIds.size !== expected.size || [...expected].some((candidateId) => !defectIds.has(candidateId))) throw new Error("Candidate defects must contain every attached candidate exactly once");
  }
  return result;
}

export const VISION_REVIEW_RESULT_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    decision: { type: "string", enum: VISION_REVIEW_DECISIONS }, confidence: { type: "number", minimum: 0, maximum: 1 },
    semanticCorrectness: { type: "number", minimum: 0, maximum: 1 }, foreignPixelRisk: { type: "number", minimum: 0, maximum: 1 }, missingAnatomyRisk: { type: "number", minimum: 0, maximum: 1 }, jointRisk: { type: "number", minimum: 0, maximum: 1 }, occlusionRisk: { type: "number", minimum: 0, maximum: 1 },
    issues: { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false, properties: { type: { type: "string", maxLength: 120 }, region: { type: "string", maxLength: 240 }, severity: { type: "string", enum: ["low", "medium", "high"] }, description: { type: "string", maxLength: 1000 } }, required: ["type", "region", "severity", "description"] } },
    recommendedAction: { type: "string", minLength: 1, maxLength: 2000 }, notes: { type: "string", maxLength: 4000 },
    ranking: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, properties: { orderedCandidateIds: { type: "array", minItems: 2, maxItems: 20, items: { type: "string" } }, preferredCandidateId: { type: "string" }, confidenceGap: { type: "number", minimum: 0, maximum: 1 }, candidateDefects: { type: "array", minItems: 2, maxItems: 20, items: { type: "object", additionalProperties: false, properties: { candidateId: { type: "string" }, defects: { type: "array", maxItems: 20, items: { type: "string", maxLength: 500 } } }, required: ["candidateId", "defects"] } } }, required: ["orderedCandidateIds", "preferredCandidateId", "confidenceGap", "candidateDefects"] }] },
  },
  required: ["decision", "confidence", "semanticCorrectness", "foreignPixelRisk", "missingAnatomyRisk", "jointRisk", "occlusionRisk", "issues", "recommendedAction", "notes", "ranking"],
} as const;
