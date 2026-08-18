import type { AnimationDefinition } from "../schema/types";
import { diffAnimations, type AnimationDiff } from "../ai/animationDiff";
import type { VisualReview, VisualReviewIssue, VisualIssueSeverity } from "./visualReviewSchema";

export type TimelineIssueMarker = {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly severity: VisualIssueSeverity;
  readonly label: string;
  readonly affectedBones: readonly string[];
};

export const visualReviewToTimelineMarkers = (review: VisualReview): readonly TimelineIssueMarker[] => review.detectedIssues.map((issue) => ({
  id: issue.id,
  start: issue.timeRange.start,
  end: issue.timeRange.end,
  severity: issue.severity,
  label: issue.issueType,
  affectedBones: issue.affectedBones,
}));

export const issueSeekTime = (issue: VisualReviewIssue): number => (issue.timeRange.start + issue.timeRange.end) / 2;

export const correctedAnimationDiff = (current: AnimationDefinition, review: VisualReview): AnimationDiff | null =>
  review.correctedAnimationProposal ? diffAnimations(current, review.correctedAnimationProposal.animation) : null;
