import { createHash } from "node:crypto";
import { z } from "zod";
import { PART_SEMANTIC_TYPES } from "../part-cutter/semanticTaxonomy";

export const CUT_CANDIDATE_GENERATORS = ["anatomical-envelope", "anchor-corridor", "expanded-envelope", "side-aware-envelope", "articulation-split", "nearest-component"] as const;
export const CANDIDATE_REVIEW_TASKS = ["PART_SELECTION", "CONTAMINATION_CHECK", "SIDE_IDENTITY", "ARTICULATION_USABILITY", "RELATIVE_RANK"] as const;
export const CANDIDATE_REVIEW_DECISIONS = ["SELECT", "NONE_OF_THE_ABOVE", "NEEDS_ALTERNATIVE"] as const;
export const CANDIDATE_REASON_CODES = ["CORRECT_PART", "PARTIAL_PART", "WRONG_PART", "TORSO_CONTAMINATION", "OPPOSITE_LIMB_CONTAMINATION", "EQUIPMENT_CONTAMINATION", "TOO_BROAD", "TOO_NARROW", "JOINT_UNUSABLE", "SIDE_AMBIGUOUS", "NONE_VALID"] as const;
export const ARBITRATION_FAILURE_CLASSES = ["NO_VALID_CANDIDATE", "VISION_CHOSE_WRONG_PART", "VISION_CHOSE_CONTAMINATED", "VISION_SIDE_ERROR", "VISION_REJECTED_GOOD", "GEOMETRY_OVERRULED_GOOD", "VALIDATOR_FALSE_REJECTION", "LOW_CONFIDENCE_UNRESOLVED", "STALE_REVIEW", "PROVIDER_UNAVAILABLE", "OTHER"] as const;

const id = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();

export const cutCandidateManifestSchema = z.object({
  candidateId: id, candidateHash: hash, semantic: z.enum(PART_SEMANTIC_TYPES), generator: z.enum(CUT_CANDIDATE_GENERATORS),
  sourceHash: hash, width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192), pixelCount: z.number().int().positive(),
  geometryScore: z.number().finite().min(0).max(1), round: z.number().int().min(1).max(2), inputLandmarks: z.array(point).min(1).max(4),
  geometryParameters: z.record(z.string(), z.number().finite()).refine((value) => Object.keys(value).length <= 20),
}).strict();
export type CutCandidateManifest = z.infer<typeof cutCandidateManifestSchema>;

export type CutCandidate = CutCandidateManifest & { readonly alpha: readonly number[] };

export const candidateReviewJobSchema = z.object({
  schemaVersion: z.literal(1), jobId: id, projectId: id, sessionId: id, revision: id, semantic: z.enum(PART_SEMANTIC_TYPES),
  round: z.number().int().min(1).max(2), tasks: z.array(z.enum(CANDIDATE_REVIEW_TASKS)).min(1).max(5), sourceHash: hash, candidateSetHash: hash,
  characterLeftScreenSide: z.enum(["left", "right"]), candidates: z.array(cutCandidateManifestSchema).min(2).max(5), createdAt: z.string().datetime(),
}).strict().superRefine((job, context) => {
  const ids = new Set(job.candidates.map((candidate) => candidate.candidateId));
  const hashes = new Set(job.candidates.map((candidate) => candidate.candidateHash));
  if (ids.size !== job.candidates.length) context.addIssue({ code: "custom", path: ["candidates"], message: "Candidate IDs must be unique" });
  if (hashes.size !== job.candidates.length) context.addIssue({ code: "custom", path: ["candidates"], message: "Candidate masks must be unique" });
  job.candidates.forEach((candidate) => { if (candidate.sourceHash !== job.sourceHash || candidate.semantic !== job.semantic || candidate.round !== job.round) context.addIssue({ code: "custom", path: ["candidates"], message: "Candidate provenance does not match the review job" }); });
});
export type CandidateReviewJob = z.infer<typeof candidateReviewJobSchema>;

export const candidateAssessmentSchema = z.object({
  candidateId: id, reasonCodes: z.array(z.enum(CANDIDATE_REASON_CODES)).max(8),
  sideAssessment: z.enum(["CHARACTER_LEFT", "CHARACTER_RIGHT", "NOT_APPLICABLE", "AMBIGUOUS"]), articulationUsable: z.boolean(),
}).strict();

export const candidateReviewResultSchema = z.object({
  schemaVersion: z.literal(1), jobId: id, semantic: z.enum(PART_SEMANTIC_TYPES), decision: z.enum(CANDIDATE_REVIEW_DECISIONS),
  rankedCandidateIds: z.array(id).min(2).max(5), acceptedCandidateId: id.nullable(), confidence: z.number().finite().min(0).max(1),
  assessments: z.array(candidateAssessmentSchema).min(2).max(5), reasonCodes: z.array(z.enum(CANDIDATE_REASON_CODES)).max(8),
  reviewerProvider: id, model: z.string().trim().max(200).nullable(), sourceHash: hash, candidateSetHash: hash, notes: z.string().max(600),
}).strict();
export type CandidateReviewResult = z.infer<typeof candidateReviewResultSchema>;

export const CANDIDATE_REVIEW_RESULT_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", enum: [1] }, jobId: { type: "string" }, semantic: { type: "string", enum: PART_SEMANTIC_TYPES }, decision: { type: "string", enum: CANDIDATE_REVIEW_DECISIONS },
    rankedCandidateIds: { type: "array", minItems: 2, maxItems: 5, items: { type: "string" } }, acceptedCandidateId: { anyOf: [{ type: "string" }, { type: "null" }] }, confidence: { type: "number", minimum: 0, maximum: 1 },
    assessments: { type: "array", minItems: 2, maxItems: 5, items: { type: "object", additionalProperties: false, properties: { candidateId: { type: "string" }, reasonCodes: { type: "array", maxItems: 8, items: { type: "string", enum: CANDIDATE_REASON_CODES } }, sideAssessment: { type: "string", enum: ["CHARACTER_LEFT", "CHARACTER_RIGHT", "NOT_APPLICABLE", "AMBIGUOUS"] }, articulationUsable: { type: "boolean" } }, required: ["candidateId", "reasonCodes", "sideAssessment", "articulationUsable"] } },
    reasonCodes: { type: "array", maxItems: 8, items: { type: "string", enum: CANDIDATE_REASON_CODES } }, reviewerProvider: { type: "string" }, model: { anyOf: [{ type: "string" }, { type: "null" }] }, sourceHash: { type: "string" }, candidateSetHash: { type: "string" }, notes: { type: "string", maxLength: 600 },
  },
  required: ["schemaVersion", "jobId", "semantic", "decision", "rankedCandidateIds", "acceptedCandidateId", "confidence", "assessments", "reasonCodes", "reviewerProvider", "model", "sourceHash", "candidateSetHash", "notes"],
} as const;

const stableValue = (value: unknown): unknown => Array.isArray(value) ? value.map(stableValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableValue(entry)])) : value;
const stable = (value: unknown): string => JSON.stringify(stableValue(value));
export const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
export const candidateSetHash = (sourceHash: string, semantic: string, round: number, candidates: readonly CutCandidateManifest[]): string => sha256(stable({ sourceHash, semantic, round, candidates: candidates.map((candidate) => ({ candidateId: candidate.candidateId, candidateHash: candidate.candidateHash })) }));

export function validateCandidateReviewResult(input: unknown, job: CandidateReviewJob): CandidateReviewResult {
  const result = candidateReviewResultSchema.parse(input); const expected = new Set(job.candidates.map((candidate) => candidate.candidateId));
  const ranking = new Set(result.rankedCandidateIds); const assessments = new Set(result.assessments.map((assessment) => assessment.candidateId));
  if (result.jobId !== job.jobId || result.semantic !== job.semantic || result.sourceHash !== job.sourceHash || result.candidateSetHash !== job.candidateSetHash) throw new Error("Stale or mismatched candidate review result");
  if (ranking.size !== expected.size || [...expected].some((candidateId) => !ranking.has(candidateId))) throw new Error("Ranking must contain every submitted candidate exactly once");
  if (assessments.size !== expected.size || [...expected].some((candidateId) => !assessments.has(candidateId))) throw new Error("Assessments must contain every submitted candidate exactly once");
  if (result.decision === "SELECT") { if (!result.acceptedCandidateId || !expected.has(result.acceptedCandidateId)) throw new Error("SELECT must reference one submitted candidate"); }
  else if (result.acceptedCandidateId !== null) throw new Error("Reject-all decisions cannot select a candidate");
  return result;
}
