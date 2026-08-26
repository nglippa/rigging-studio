import { VISION_REVIEW_JOB_TYPES, type VisionReviewCapabilities, type VisionReviewInvocation, type VisionReviewJob, type VisionReviewProvider } from "../../src/vision-review";
import { authenticatedCliEnvironment, runProcess, type ProcessRunner } from "./processRunner";

export class ClaudeLocalAgentReviewProvider implements VisionReviewProvider {
  readonly id = "claude-local-agent"; private cached: VisionReviewCapabilities | null = null;
  constructor(private readonly runner: ProcessRunner = runProcess, private readonly command = "claude") {}
  async capabilities(): Promise<VisionReviewCapabilities> {
    if (this.cached) return this.cached;
    let version: string | null = null;
    try { version = (await this.runner(this.command, ["--version"], { timeoutMs: 5000, env: authenticatedCliEnvironment() })).stdout.trim() || null; }
    catch (error: unknown) { return this.cached = this.state("UNAVAILABLE", error instanceof Error ? error.message : "Claude CLI unavailable", null); }
    try {
      const help = await this.runner(this.command, ["--help"], { timeoutMs: 10_000, env: authenticatedCliEnvironment() }); const text = `${help.stdout}\n${help.stderr}`;
      const noninteractive = /(?:--print|-p)\b/.test(text); const image = /(?:--image|image attachment|attach)/i.test(text); const structured = /(?:json-schema|output-schema|json output)/i.test(text);
      if (!noninteractive || !image || !structured) return this.cached = this.state(image ? "UNSUPPORTED_TRANSPORT" : "AVAILABLE_TEXT_ONLY", "Installed Claude tooling does not expose a proven noninteractive multimodal strict-JSON transport", version, noninteractive);
      return this.cached = { ...this.state("UNSUPPORTED_TRANSPORT", "Claude multimodal transport requires an explicit implementation and smoke proof before enablement", version), supportedJobTypes: [...VISION_REVIEW_JOB_TYPES] };
    } catch (error: unknown) { return this.cached = this.state("UNSUPPORTED_TRANSPORT", error instanceof Error ? error.message : "Claude capability discovery failed", version); }
  }
  async isAvailable(): Promise<boolean> { return false; }
  async review(job: VisionReviewJob, artifactPaths: Readonly<Record<string, string>>): Promise<VisionReviewInvocation> { void job; void artifactPaths; throw new Error((await this.capabilities()).failureReason ?? "Claude local agent review is unavailable"); }
  private state(state: VisionReviewCapabilities["state"], reason: string, version: string | null, textAvailable = false): VisionReviewCapabilities {
    return { providerId: this.id, label: "Claude local agent", state, available: false, multimodal: false, supportsSourceImage: false, supportsMaskImage: false, supportsRenderedPose: false, supportsAnimationFrames: false, structuredOutput: false, localOnly: false, usesExistingAccountSession: false, supportsIterativeReview: false, supportsRelativeRanking: false, supportedJobTypes: [], transport: textAvailable ? "claude CLI (insufficient for image review)" : "no supported CLI transport", version, model: null, failureReason: reason };
  }
}
