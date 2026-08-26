import { describe, expect, it } from "vitest";
import { validateVisionReviewResult, visionReviewResultSchema } from "../../src/vision-review";
import { acceptedReview } from "./vision-review-fixtures";

describe("vision review structured output", () => {
  it("accepts every supported action decision", () => {
    for (const decision of ["ACCEPT", "REPAIR", "RECUT", "ESCALATE", "HUMAN_REVIEW"] as const) expect(visionReviewResultSchema.parse(acceptedReview({ decision })).decision).toBe(decision);
  });
  it("rejects malformed JSON shapes, invalid enums, out-of-range confidence, and oversized text", () => {
    expect(visionReviewResultSchema.safeParse({}).success).toBe(false);
    expect(visionReviewResultSchema.safeParse(acceptedReview({ decision: "ACCEPT" as never, confidence: 2 })).success).toBe(false);
    expect(visionReviewResultSchema.safeParse({ ...acceptedReview(), decision: "PASS" }).success).toBe(false);
    expect(visionReviewResultSchema.safeParse({ ...acceptedReview(), notes: "x".repeat(4001) }).success).toBe(false);
  });
  it("requires an exact complete ranking for relative review", () => {
    const job = { schemaVersion: 1 as const, jobId: "rank", parentJobId: null, attempt: 1, maxAttempts: 3, type: "CUT_MASK_REVIEW" as const, mode: "RANK_CANDIDATES" as const, subject: "rank", expectedSemantic: "leftForearm", deterministicFindings: [], candidateIds: ["a", "b"], artifacts: [], promptSchemaVersion: "vision-review-prompt-v1" as const, createdAt: "2026-08-25T00:00:00.000Z", repairApplied: null };
    expect(() => validateVisionReviewResult(acceptedReview(), job)).toThrow(/omitted ranking/);
    expect(() => validateVisionReviewResult(acceptedReview({ ranking: { orderedCandidateIds: ["a", "c"], preferredCandidateId: "a", confidenceGap: .2, candidateDefects: [{ candidateId: "a", defects: [] }, { candidateId: "c", defects: [] }] } }), job)).toThrow(/every attached candidate/);
    expect(validateVisionReviewResult(acceptedReview({ ranking: { orderedCandidateIds: ["b", "a"], preferredCandidateId: "b", confidenceGap: .2, candidateDefects: [{ candidateId: "a", defects: ["edge"] }, { candidateId: "b", defects: [] }] } }), job).ranking?.preferredCandidateId).toBe("b");
  });
});
