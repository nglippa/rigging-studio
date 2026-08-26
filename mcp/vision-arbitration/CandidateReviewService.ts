import type { CandidateReviewJob, CandidateReviewProvider } from "../../src/vision-arbitration";

export type CandidateReviewAttempt = { readonly providerId: string; readonly outcome: "unavailable" | "failed" | "completed"; readonly latencyMs: number; readonly message: string };
export class CandidateReviewService {
  constructor(readonly providers: readonly CandidateReviewProvider[]) {}
  async review(job: CandidateReviewJob, artifacts: Readonly<Record<string, string>>): Promise<{ readonly invocation: Awaited<ReturnType<CandidateReviewProvider["review"]>> | null; readonly attempts: readonly CandidateReviewAttempt[] }> {
    const attempts: CandidateReviewAttempt[] = [];
    for (const provider of this.providers) { const started = Date.now(); try { const capability = await provider.capabilities(); if (!capability.available || !capability.multimodal || !capability.structuredOutput) { attempts.push({ providerId: provider.id, outcome: "unavailable", latencyMs: Date.now() - started, message: capability.failureReason ?? "Multimodal structured review unavailable" }); continue; } const invocation = await provider.review(job, artifacts); attempts.push({ providerId: provider.id, outcome: "completed", latencyMs: Date.now() - started, message: invocation.result.decision }); return { invocation, attempts }; } catch (error: unknown) { attempts.push({ providerId: provider.id, outcome: "failed", latencyMs: Date.now() - started, message: error instanceof Error ? error.message.slice(0, 1000) : "Candidate review failed" }); } }
    return { invocation: null, attempts };
  }
}
