import { z } from "zod";
import { animationProposalSchema, type AnimationProposal } from "../ai/animationProposalSchema";

export const VISUAL_REVIEW_VERSION = 1 as const;
export const VISUAL_ISSUE_CATEGORIES = [
  "foot sliding", "joint popping", "limb inversion", "excessive rotation", "weak anticipation", "weak follow-through",
  "uneven timing", "broken loop seam", "silhouette collision", "weapon detachment", "shield detachment",
  "body-part separation", "clipping", "bad draw order", "unnatural root movement", "excessive bobbing",
  "insufficient weight", "asymmetry", "unclear pose", "possible art/rig limitation",
] as const;
export type VisualIssueCategory = (typeof VISUAL_ISSUE_CATEGORIES)[number];
export const VISUAL_ISSUE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type VisualIssueSeverity = (typeof VISUAL_ISSUE_SEVERITIES)[number];

export type VisualReviewIssue = {
  readonly id: string;
  readonly issueType: VisualIssueCategory;
  readonly severity: VisualIssueSeverity;
  readonly timeRange: { readonly start: number; readonly end: number };
  readonly affectedBones: readonly string[];
  readonly explanation: string;
  readonly suggestedCorrection: string;
  readonly confidence: number;
};

export type VisualReview = {
  readonly reviewVersion: typeof VISUAL_REVIEW_VERSION;
  readonly summary: string;
  readonly detectedIssues: readonly VisualReviewIssue[];
  readonly correctedAnimationProposal?: AnimationProposal;
};

const text = z.string().trim().min(1);
export const visualReviewIssueSchema: z.ZodType<VisualReviewIssue> = z.object({
  id: text,
  issueType: z.enum(VISUAL_ISSUE_CATEGORIES),
  severity: z.enum(VISUAL_ISSUE_SEVERITIES),
  timeRange: z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative() }).strict(),
  affectedBones: z.array(text),
  explanation: text,
  suggestedCorrection: text,
  confidence: z.number().finite().min(0).max(1),
}).strict();

export const visualReviewSchema: z.ZodType<VisualReview> = z.object({
  reviewVersion: z.literal(VISUAL_REVIEW_VERSION),
  summary: text,
  detectedIssues: z.array(visualReviewIssueSchema),
  correctedAnimationProposal: animationProposalSchema.optional(),
}).strict();

export type VisualReviewValidationResult =
  | { readonly success: true; readonly review: VisualReview }
  | { readonly success: false; readonly message: string; readonly issues: readonly { readonly path: string; readonly message: string }[] };

export const validateVisualReview = (input: unknown, duration: number, boneIds: ReadonlySet<string>): VisualReviewValidationResult => {
  const parsed = visualReviewSchema.safeParse(input);
  if (!parsed.success) return { success: false, message: "Vision provider returned a malformed review", issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) };
  const issues: { path: string; message: string }[] = [];
  const ids = new Set<string>();
  parsed.data.detectedIssues.forEach((issue, index) => {
    if (ids.has(issue.id)) issues.push({ path: `detectedIssues.${index}.id`, message: `Duplicate issue ID "${issue.id}"` });
    ids.add(issue.id);
    if (issue.timeRange.end < issue.timeRange.start) issues.push({ path: `detectedIssues.${index}.timeRange`, message: "Issue end time must be at or after its start time" });
    if (issue.timeRange.end > duration) issues.push({ path: `detectedIssues.${index}.timeRange.end`, message: `Issue time exceeds animation duration ${duration}` });
    issue.affectedBones.forEach((boneId) => { if (!boneIds.has(boneId)) issues.push({ path: `detectedIssues.${index}.affectedBones`, message: `Unknown bone "${boneId}"` }); });
  });
  return issues.length ? { success: false, message: `Visual review rejected: ${issues.map((issue) => issue.message).join("; ")}`, issues } : { success: true, review: parsed.data };
};
