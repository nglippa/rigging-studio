import type { VisionReviewCapabilities } from "../vision-review";
import type { CandidateReviewJob, CandidateReviewResult } from "./schema";

export type CandidateReviewInvocation = { readonly result: CandidateReviewResult; readonly providerVersion: string | null; readonly model: string | null; readonly latencyMs: number };
export interface CandidateReviewProvider {
  readonly id: string;
  capabilities(): Promise<VisionReviewCapabilities>;
  review(job: CandidateReviewJob, artifactPaths: Readonly<Record<string, string>>): Promise<CandidateReviewInvocation>;
}
