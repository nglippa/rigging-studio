import type { VisionReviewCapabilities, VisionReviewJob, VisionReviewResult } from "./schema";

export type VisionReviewInvocation = {
  readonly result: VisionReviewResult;
  readonly providerVersion: string | null;
  readonly model: string | null;
  readonly classification: "local" | "account-backed-cloud" | "manual";
  readonly authenticatedViaExistingSession: boolean;
};

export interface VisionReviewProvider {
  readonly id: string;
  capabilities(): Promise<VisionReviewCapabilities>;
  isAvailable(): Promise<boolean>;
  review(job: VisionReviewJob, artifactPaths: Readonly<Record<string, string>>): Promise<VisionReviewInvocation>;
}

export type DeterministicReviewCheck = (job: VisionReviewJob, result?: VisionReviewResult) => Promise<readonly string[]> | readonly string[];
