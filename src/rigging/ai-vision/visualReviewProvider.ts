import type { AnimationTrack } from "../schema/types";
import type { AnimationProposal } from "../ai/animationProposalSchema";
import type { VisualReviewContext } from "./visualReviewPromptBuilder";
import type { VisualReview, VisualReviewIssue } from "./visualReviewSchema";

export type VisualReviewProviderInput = {
  readonly prompt: string;
  readonly context: VisualReviewContext;
  readonly contactSheet: Blob;
  readonly individualFrames?: readonly Blob[];
  readonly previousReviews?: readonly VisualReview[];
};

export interface VisualReviewProvider {
  readonly id: string;
  readonly name: string;
  reviewAnimation(input: VisualReviewProviderInput): Promise<VisualReview>;
}

export class HttpVisualReviewProvider implements VisualReviewProvider {
  readonly id = "http-vision";
  readonly name = "Configured vision provider";

  constructor(private readonly endpoint: string) {}

  async reviewAnimation(input: VisualReviewProviderInput): Promise<VisualReview> {
    const form = new FormData();
    form.set("prompt", input.prompt);
    form.set("context", JSON.stringify(input.context));
    form.set("contactSheet", input.contactSheet, "contact-sheet.png");
    input.individualFrames?.forEach((frame, index) => form.append("frames", frame, `frame-${String(index + 1).padStart(2, "0")}.png`));
    if (input.previousReviews?.length) form.set("previousReviews", JSON.stringify(input.previousReviews));
    const response = await fetch(this.endpoint, { method: "POST", body: form });
    if (!response.ok) throw new Error(`Vision provider failed with HTTP ${response.status}`);
    return response.json() as Promise<VisualReview>;
  }
}

const seamlessTracks = (tracks: readonly AnimationTrack[], duration: number): readonly AnimationTrack[] => tracks.map((track) => {
  const first = track.keyframes[0]; if (!first) return track;
  return { ...track, keyframes: [...track.keyframes.filter((frame) => Math.abs(frame.time - duration) > .0001), { ...first, time: duration }] };
});

export class MockVisualReviewProvider implements VisualReviewProvider {
  readonly id = "mock-vision";
  readonly name = "Local mock vision provider";

  async reviewAnimation(input: VisualReviewProviderInput): Promise<VisualReview> {
    const issues: VisualReviewIssue[] = [];
    const animation = input.context.animation;
    const footWarning = input.context.knownWarnings.find((warning) => /foot|drift|slid/i.test(warning));
    if (footWarning) issues.push({
      id: "foot-contact-drift",
      issueType: "foot sliding",
      severity: "medium",
      timeRange: { start: 0, end: Math.min(animation.duration, animation.duration / 2) },
      affectedBones: [input.context.feet.leftFootBoneId, input.context.feet.rightFootBoneId].filter((id): id is string => Boolean(id)),
      explanation: `Animation problem likely: ${footWarning}`,
      suggestedCorrection: "Counter-animate the planted foot or reduce upstream root/leg translation during contact.",
      confidence: .72,
    });
    const seamTracks = animation.loop ? animation.tracks.filter((track) => {
      const first = track.keyframes[0]; const last = track.keyframes.at(-1);
      return first && last && (Math.abs(first.value - last.value) > .001 || Math.abs(last.time - animation.duration) > .0001);
    }) : [];
    if (seamTracks.length) issues.push({
      id: "loop-seam",
      issueType: "broken loop seam",
      severity: "high",
      timeRange: { start: Math.max(0, animation.duration - animation.duration * .08), end: animation.duration },
      affectedBones: [...new Set(seamTracks.map((track) => track.boneId))],
      explanation: "Animation problem: one or more final track values do not match the first pose.",
      suggestedCorrection: "Match each affected track's final key to its first key while preserving the interior timing.",
      confidence: .96,
    });
    let correctedAnimationProposal: AnimationProposal | undefined;
    if (seamTracks.length) {
      const corrected = { ...structuredClone(animation), tracks: seamlessTracks(animation.tracks, animation.duration) };
      correctedAnimationProposal = {
        proposalVersion: 1,
        summary: "Match the loop end pose to the first pose",
        animation: corrected,
        warnings: footWarning ? ["Foot contact drift still requires manual review."] : [],
        assumptions: ["The loop should return exactly to its first local pose."],
        affectedBones: [...new Set(seamTracks.map((track) => track.boneId))],
        confidenceNotes: ["High confidence in seam correction; visual rhythm still requires preview."],
      };
    }
    return {
      reviewVersion: 1,
      summary: issues.length ? `Mock visual review found ${issues.length} potential issue(s).` : "Mock visual review found no structural warnings in the supplied context.",
      detectedIssues: issues,
      ...(correctedAnimationProposal ? { correctedAnimationProposal } : {}),
    };
  }
}

export type VisualReviewPassState = { readonly completedPasses: number; readonly maximumPasses: number };
export const createVisualReviewPassState = (maximumPasses = 1): VisualReviewPassState => ({ completedPasses: 0, maximumPasses: Math.max(1, Math.min(3, Math.round(maximumPasses))) });

export const runVisualReviewPass = async (state: VisualReviewPassState, provider: VisualReviewProvider, input: VisualReviewProviderInput): Promise<{ readonly state: VisualReviewPassState; readonly review: VisualReview }> => {
  if (state.completedPasses >= state.maximumPasses) throw new Error(`Visual review pass limit of ${state.maximumPasses} reached`);
  const review = await provider.reviewAnimation(input);
  return { review, state: { ...state, completedPasses: state.completedPasses + 1 } };
};
