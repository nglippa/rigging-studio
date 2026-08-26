import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildCandidateReviewPrompt, CANDIDATE_REVIEW_RESULT_JSON_SCHEMA, candidateReviewResultSchema, validateCandidateReviewResult, type CandidateReviewInvocation, type CandidateReviewJob, type CandidateReviewProvider } from "../../src/vision-arbitration";
import type { VisionReviewCapabilities } from "../../src/vision-review";
import { CodexLocalAgentReviewProvider } from "../vision-review/CodexLocalAgentReviewProvider";
import { authenticatedCliEnvironment, runProcess, type ProcessRunner } from "../vision-review/processRunner";

type Options = { readonly command?: string; readonly model?: string | null; readonly timeoutMs?: number; readonly runner?: ProcessRunner; readonly capabilityProvider?: CodexLocalAgentReviewProvider };
export class CodexCandidateReviewProvider implements CandidateReviewProvider {
  readonly id = "codex-local-agent"; private readonly command: string; private readonly model: string | null; private readonly timeoutMs: number; private readonly runner: ProcessRunner; private readonly capabilityProvider: CodexLocalAgentReviewProvider;
  constructor(options: Options = {}) { this.command = options.command ?? "codex"; this.model = options.model ?? process.env.RIGGING_STUDIO_CODEX_REVIEW_MODEL ?? null; this.timeoutMs = options.timeoutMs ?? 180_000; this.runner = options.runner ?? runProcess; this.capabilityProvider = options.capabilityProvider ?? new CodexLocalAgentReviewProvider({ command: this.command, model: this.model, runner: this.runner }); }
  capabilities(): Promise<VisionReviewCapabilities> { return this.capabilityProvider.capabilities(); }
  async review(job: CandidateReviewJob, artifactPaths: Readonly<Record<string, string>>): Promise<CandidateReviewInvocation> {
    const capabilities = await this.capabilities(); if (!capabilities.available || !capabilities.multimodal) throw new Error(capabilities.failureReason ?? "Codex candidate review is unavailable");
    const expectedNames = ["source.png", ...job.candidates.map((candidate) => `candidate-${candidate.candidateId}.png`)]; const images = expectedNames.map((name) => artifactPaths[name]); if (images.some((file) => !file)) throw new Error("Candidate review packet is missing source or overlay artifacts");
    const directory = path.dirname(images[0]); const schemaPath = path.join(directory, "candidate-result-schema.json"); const outputPath = path.join(directory, "candidate-result.json"); await writeFile(schemaPath, `${JSON.stringify(CANDIDATE_REVIEW_RESULT_JSON_SCHEMA, null, 2)}\n`, "utf8");
    const started = Date.now(); const execution = await this.runner(this.command, ["-a", "never", ...(this.model ? ["-m", this.model] : []), "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--skip-git-repo-check", "-C", directory, ...images.flatMap((file) => ["-i", file]), "--output-schema", schemaPath, "--output-last-message", outputPath, buildCandidateReviewPrompt(job)], { cwd: directory, timeoutMs: this.timeoutMs, env: authenticatedCliEnvironment() });
    const output = await readFile(outputPath, "utf8").catch(() => { throw new Error(`Codex did not write a candidate result: ${(execution.stderr || execution.stdout).slice(-1200)}`); });
    const response = JSON.parse(output) as Record<string, unknown>;
    const parsed = candidateReviewResultSchema.parse({ ...response, reviewerProvider: this.id, model: this.model ?? capabilities.model, sourceHash: job.sourceHash, candidateSetHash: job.candidateSetHash });
    const result = validateCandidateReviewResult(parsed, job);
    return { result, providerVersion: capabilities.version, model: this.model ?? capabilities.model, latencyMs: Date.now() - started };
  }
}
