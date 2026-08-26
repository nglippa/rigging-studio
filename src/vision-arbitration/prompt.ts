import type { CandidateReviewJob } from "./schema";

export function buildCandidateReviewPrompt(job: CandidateReviewJob): string {
  const side = job.characterLeftScreenSide === "right" ? "Character-left appears on the right side of the image." : "Character-left appears on the left side of the image.";
  return [
    "You are ranking deterministic pixel-mask candidates for one visible anatomical part in a flattened 2D character sprite.",
    `Target semantic: ${job.semantic}. ${side}`,
    `Candidate IDs: ${job.candidates.map((candidate) => candidate.candidateId).join(", ")}. Each candidate is a separate attached full-sprite overlay named with its ID.`,
    "Each overlay has its candidate ID printed in the dark header. Green pixels are selected, dim pixels are excluded context, yellow marks the mask boundary, and cyan crosses mark required target/joint anchors.",
    `Identity fields to echo exactly: sourceHash=${job.sourceHash}; candidateSetHash=${job.candidateSetHash}.`,
    `The semantic label is character-relative: use ${job.semantic.startsWith("left") ? "CHARACTER_LEFT" : job.semantic.startsWith("right") ? "CHARACTER_RIGHT" : "NOT_APPLICABLE"} for a candidate on the requested side, regardless of its screen position.`,
    "Rank every supplied ID exactly once from best to worst. Select only an ID supplied by Rig Studio, or choose NONE_OF_THE_ABOVE / NEEDS_ALTERNATIVE.",
    "Judge correct visible anatomy, foreign body/equipment contamination, character side, joint coverage, and whether rotation would drag unrelated mass.",
    "Do not invent coordinates, masks, polygons, candidates, or edit instructions. Do not judge style, attractiveness, or general art quality.",
    "Require the full visible target part and its cyan joint/part anchors. Do not prefer a cleaner narrow fragment when it omits visible target pixels. A broad mask containing torso, opposite limb, or equipment is not acceptable.",
    "Use the bounded reason codes only. For SELECT, acceptedCandidateId must equal your best valid ranked candidate. For reject-all, it must be null.",
    "Return only strict JSON matching the supplied schema. Do not use tools, browse, or inspect files other than the attached source and overlays.",
  ].join("\n");
}
