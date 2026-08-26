import { validateVisionReviewResult, visionReviewProviderPolicySchema, type DeterministicReviewCheck, type PersistedVisionReviewResult, type VisionReviewCapabilities, type VisionReviewJob, type VisionReviewProvider, type VisionReviewProviderPolicy } from "../../src/vision-review";
import { ClaudeLocalAgentReviewProvider } from "./ClaudeLocalAgentReviewProvider";
import { CodexLocalAgentReviewProvider } from "./CodexLocalAgentReviewProvider";
import { ManualReviewProvider } from "./ManualReviewProvider";
import { OllamaVisionReviewProvider } from "./OllamaVisionReviewProvider";
import { VisionReviewQueue, type CreateVisionReviewJobInput } from "./VisionReviewQueue";

type Options = {
  readonly queue?: VisionReviewQueue;
  readonly providers?: readonly VisionReviewProvider[];
  readonly policy?: Partial<VisionReviewProviderPolicy>;
  readonly now?: () => number;
};

const policyOrders: Record<VisionReviewProviderPolicy["policy"], readonly string[]> = {
  "local-first": ["ollama-vision", "claude-local-agent", "codex-local-agent", "manual"],
  "claude-first": ["claude-local-agent", "ollama-vision", "codex-local-agent", "manual"],
  "codex-first": ["codex-local-agent", "ollama-vision", "claude-local-agent", "manual"],
  "manual-only": ["manual"],
};

export class VisionReviewService {
  readonly queue: VisionReviewQueue; readonly providers: readonly VisionReviewProvider[]; readonly policy: VisionReviewProviderPolicy; private readonly now: () => number;
  constructor(options: Options = {}) {
    this.queue = options.queue ?? new VisionReviewQueue();
    this.providers = options.providers ?? [new OllamaVisionReviewProvider(), new ClaudeLocalAgentReviewProvider(), new CodexLocalAgentReviewProvider(), new ManualReviewProvider()];
    this.policy = visionReviewProviderPolicySchema.parse({ policy: options.policy?.policy ?? process.env.RIGGING_STUDIO_VISION_REVIEW_POLICY ?? "local-first", maxAttempts: options.policy?.maxAttempts ?? 3 });
    this.now = options.now ?? Date.now;
  }

  createJob(input: CreateVisionReviewJobInput): Promise<VisionReviewJob> { return this.queue.create({ ...input, maxAttempts: input.maxAttempts ?? this.policy.maxAttempts }); }
  listPending() { return this.queue.listPending(); }
  capabilities(): Promise<readonly VisionReviewCapabilities[]> { return Promise.all(this.orderedProviders().map((provider) => provider.capabilities())); }

  async review(jobId: string, checks: { readonly precheck?: DeterministicReviewCheck; readonly postcheck?: DeterministicReviewCheck } = {}): Promise<PersistedVisionReviewResult> {
    const job = await this.queue.loadJob(jobId); const paths = await this.queue.artifactPaths(jobId); await this.queue.markInReview(jobId);
    const precheckVetoes = checks.precheck ? await checks.precheck(job) : [];
    if (precheckVetoes.length) {
      const manual = this.providers.find((provider) => provider.id === "manual") ?? new ManualReviewProvider(); const started = this.now(); const invocation = await manual.review(job, paths);
      await this.queue.recordAttempt(jobId, { providerId: manual.id, outcome: "completed", message: "Deterministic precheck vetoed automatic review", latencyMs: this.now() - started });
      return this.queue.persistResult(jobId, invocation, this.now() - started, precheckVetoes);
    }
    for (const provider of this.orderedProviders()) {
      const started = this.now();
      try {
        const capabilities = await provider.capabilities();
        if (!capabilities.available || !capabilities.multimodal || !capabilities.supportedJobTypes.includes(job.type)) {
          await this.queue.recordAttempt(jobId, { providerId: provider.id, outcome: "unavailable", message: capabilities.failureReason ?? "Provider does not support this review job", latencyMs: this.now() - started }); continue;
        }
        const rawInvocation = await provider.review(job, paths); const invocation = { ...rawInvocation, result: validateVisionReviewResult(rawInvocation.result, job) }; const postcheckVetoes = checks.postcheck ? await checks.postcheck(job, invocation.result) : [];
        await this.queue.recordAttempt(jobId, { providerId: provider.id, outcome: "completed", message: invocation.result.decision, latencyMs: this.now() - started });
        return this.queue.persistResult(jobId, invocation, this.now() - started, postcheckVetoes);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Review provider failed"; const invalid = /invalid|schema|json|enum|range|ranking/i.test(message);
        await this.queue.recordAttempt(jobId, { providerId: provider.id, outcome: invalid ? "invalid" : "failed", message: message.slice(0, 1000), latencyMs: this.now() - started });
      }
    }
    const manual = new ManualReviewProvider(); const invocation = await manual.review(job, paths); await this.queue.recordAttempt(jobId, { providerId: manual.id, outcome: "completed", message: "All configured providers failed", latencyMs: 0 }); return this.queue.persistResult(jobId, invocation, 0);
  }

  private orderedProviders(): readonly VisionReviewProvider[] {
    const byId = new Map(this.providers.map((provider) => [provider.id, provider])); const ordered = policyOrders[this.policy.policy].map((id) => byId.get(id)).filter((provider): provider is VisionReviewProvider => Boolean(provider));
    this.providers.forEach((provider) => { if (!ordered.includes(provider)) ordered.push(provider); }); return ordered;
  }
}
