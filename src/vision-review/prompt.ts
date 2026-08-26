import type { VisionReviewJob } from "./schema";

const criteria: Record<VisionReviewJob["type"], string> = {
  CUT_MASK_REVIEW: "Judge semantic ownership, missing visible anatomy, foreign pixels, joint continuity, and whether the mask is usable for rigging.",
  OCCLUSION_RECONSTRUCTION_REVIEW: "Judge whether hidden anatomy plausibly continues the visible part without stealing neighboring anatomy or changing source style/scale.",
  CANONICAL_OWNERSHIP_REVIEW: "Judge whether visible pixels belong to the correct semantic owners, focusing on ambiguous boundaries and foreign-pixel transfers.",
  RIG_POSE_REVIEW: "Judge gaps, detached limbs, impossible joint transitions, z-order failures, equipment detachment, and anatomical discontinuity.",
  ANIMATION_REVIEW: "Judge attachment continuity, joints, z-order, equipment, pivot drift, teleporting, and accumulated transform errors across the supplied frames.",
};

export function buildVisionReviewPrompt(job: VisionReviewJob): string {
  const ranking = job.mode === "RANK_CANDIDATES"
    ? `Rank every candidate exactly once. Candidate ids: ${job.candidateIds.join(", ")}. Return the ordered ids, preferred id, confidence gap, and one candidateDefects entry per candidate.`
    : "Review the supplied evidence as one candidate.";
  return [
    "You are a semantic visual QA reviewer for modular 2D character rigging.",
    "Inspect only the explicitly attached images. Do not use tools, browse, or inspect other files.",
    "DO NOT judge artistic style, attractiveness, or overall design quality.",
    `Job type: ${job.type}. Subject: ${job.subject}`,
    job.expectedSemantic ? `Expected semantic part: ${job.expectedSemantic}.` : "",
    criteria[job.type], ranking,
    job.deterministicFindings.length ? `Deterministic checks already established: ${job.deterministicFindings.join(" | ")}` : "Deterministic checks supplied no additional findings.",
    "Return only JSON matching the supplied schema. Never return ACCEPT when evidence is missing or unreadable; use HUMAN_REVIEW or ESCALATE.",
  ].filter(Boolean).join("\n");
}
