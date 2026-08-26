import { VISION_REVIEW_JOB_TYPES, type VisionReviewCapabilities, type VisionReviewInvocation, type VisionReviewJob, type VisionReviewProvider } from "../../src/vision-review";

export class ManualReviewProvider implements VisionReviewProvider {
  readonly id = "manual";
  async capabilities(): Promise<VisionReviewCapabilities> { return { providerId: this.id, label: "Manual agent queue", state: "AVAILABLE_AND_MULTIMODAL", available: true, multimodal: true, supportsSourceImage: true, supportsMaskImage: true, supportsRenderedPose: true, supportsAnimationFrames: true, structuredOutput: true, localOnly: true, usesExistingAccountSession: false, supportsIterativeReview: true, supportsRelativeRanking: true, supportedJobTypes: [...VISION_REVIEW_JOB_TYPES], transport: "validated result.json or MCP submission", version: null, model: null, failureReason: null }; }
  async isAvailable(): Promise<boolean> { return true; }
  async review(job: VisionReviewJob, artifactPaths: Readonly<Record<string, string>>): Promise<VisionReviewInvocation> {
    void job; void artifactPaths;
    return { result: { decision: "HUMAN_REVIEW", confidence: 0, semanticCorrectness: 0, foreignPixelRisk: 0, missingAnatomyRisk: 0, jointRisk: 0, occlusionRisk: 0, issues: [], recommendedAction: "Inspect the persisted review packet and submit a validated result.json or MCP verdict.", notes: "Automatic providers did not produce a valid verdict.", ranking: null }, providerVersion: null, model: null, classification: "manual", authenticatedViaExistingSession: false };
  }
}
