import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildVisionReviewPrompt, validateVisionReviewResult, VISION_REVIEW_JOB_TYPES, VISION_REVIEW_RESULT_JSON_SCHEMA, type VisionReviewCapabilities, type VisionReviewInvocation, type VisionReviewJob, type VisionReviewProvider } from "../../src/vision-review";
import { authenticatedCliEnvironment, runProcess, type ProcessRunner } from "./processRunner";

type Options = { readonly command?: string; readonly timeoutMs?: number; readonly runner?: ProcessRunner; readonly model?: string | null };

export class CodexLocalAgentReviewProvider implements VisionReviewProvider {
  readonly id = "codex-local-agent";
  private readonly command: string; private readonly timeoutMs: number; private readonly runner: ProcessRunner; private readonly model: string | null; private cached: VisionReviewCapabilities | null = null;
  constructor(options: Options = {}) { this.command = options.command ?? "codex"; this.timeoutMs = options.timeoutMs ?? 180_000; this.runner = options.runner ?? runProcess; this.model = options.model ?? process.env.RIGGING_STUDIO_CODEX_REVIEW_MODEL ?? null; }

  async capabilities(): Promise<VisionReviewCapabilities> {
    if (this.cached) return this.cached;
    let version: string | null = null;
    try { version = (await this.runner(this.command, ["--version"], { timeoutMs: 5000, env: authenticatedCliEnvironment() })).stdout.trim().replace(/^codex-cli\s*/i, "") || null; }
    catch (error: unknown) { return this.cached = this.unavailable("UNAVAILABLE", error instanceof Error ? error.message : "Codex CLI unavailable", null); }
    try {
      const [auth, help] = await Promise.all([
        this.runner(this.command, ["login", "status"], { timeoutMs: 10_000, env: authenticatedCliEnvironment() }),
        this.runner(this.command, ["exec", "--help"], { timeoutMs: 10_000, env: authenticatedCliEnvironment() }),
      ]);
      const authenticated = /logged in using chatgpt/i.test(`${auth.stdout}\n${auth.stderr}`);
      if (!authenticated) return this.cached = this.unavailable(/not logged|auth/i.test(`${auth.stdout}\n${auth.stderr}`) ? "AUTH_REQUIRED" : "UNSUPPORTED_TRANSPORT", "Codex CLI is not authenticated through an existing ChatGPT session", version);
      const helpText = `${help.stdout}\n${help.stderr}`; const multimodal = /--image\s+<FILE>/i.test(helpText); const structured = /--output-schema\s+<FILE>/i.test(helpText) && /--output-last-message\s+<FILE>/i.test(helpText);
      if (!multimodal || !structured) return this.cached = this.unavailable("AVAILABLE_TEXT_ONLY", "Codex CLI lacks proven image attachment or structured-output flags", version, true);
      return this.cached = {
        providerId: this.id, label: "Codex local agent", state: "AVAILABLE_AND_MULTIMODAL", available: true, multimodal: true,
        supportsSourceImage: true, supportsMaskImage: true, supportsRenderedPose: true, supportsAnimationFrames: true, structuredOutput: true,
        localOnly: false, usesExistingAccountSession: true, supportsIterativeReview: true, supportsRelativeRanking: true, supportedJobTypes: [...VISION_REVIEW_JOB_TYPES],
        transport: "codex exec -i --output-schema (existing ChatGPT login)", version, model: this.model, failureReason: null,
      };
    } catch (error: unknown) { return this.cached = this.unavailable("UNSUPPORTED_TRANSPORT", error instanceof Error ? error.message : "Codex capability discovery failed", version); }
  }

  async isAvailable(): Promise<boolean> { return (await this.capabilities()).available; }

  async review(job: VisionReviewJob, artifactPaths: Readonly<Record<string, string>>): Promise<VisionReviewInvocation> {
    const capabilities = await this.capabilities(); if (!capabilities.available || !capabilities.multimodal) throw new Error(capabilities.failureReason ?? "Codex local vision transport unavailable");
    const paths = job.artifacts.map((artifact) => artifactPaths[artifact.name]); if (paths.some((file) => !file)) throw new Error("Codex review packet is missing an attached artifact path");
    const directory = path.dirname(path.dirname(paths[0])); const schemaPath = path.join(directory, "codex-result-schema.json"); const outputPath = path.join(directory, "codex-result.json");
    await writeFile(schemaPath, `${JSON.stringify(VISION_REVIEW_RESULT_JSON_SCHEMA, null, 2)}\n`, "utf8");
    const imageArgs = paths.flatMap((file) => ["-i", file]);
    const execution = await this.runner(this.command, [
      "-a", "never", ...(this.model ? ["-m", this.model] : []), "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--skip-git-repo-check", "-C", directory,
      ...imageArgs, "--output-schema", schemaPath, "--output-last-message", outputPath, buildVisionReviewPrompt(job),
    ], { cwd: directory, timeoutMs: this.timeoutMs, env: authenticatedCliEnvironment() });
    const output = await readFile(outputPath, "utf8").catch(() => { throw new Error(`Codex exited without a structured result: ${(execution.stderr || execution.stdout).trim().slice(-1500) || "no diagnostic output"}`); });
    const raw = JSON.parse(output) as unknown; const result = validateVisionReviewResult(raw, job);
    return { result, providerVersion: capabilities.version, model: capabilities.model, classification: "account-backed-cloud", authenticatedViaExistingSession: true };
  }

  private unavailable(state: VisionReviewCapabilities["state"], reason: string, version: string | null, available = false): VisionReviewCapabilities {
    return { providerId: this.id, label: "Codex local agent", state, available, multimodal: false, supportsSourceImage: false, supportsMaskImage: false, supportsRenderedPose: false, supportsAnimationFrames: false, structuredOutput: false, localOnly: false, usesExistingAccountSession: state !== "AUTH_REQUIRED" && available, supportsIterativeReview: false, supportsRelativeRanking: false, supportedJobTypes: [], transport: "codex CLI", version, model: this.model, failureReason: reason };
  }
}
