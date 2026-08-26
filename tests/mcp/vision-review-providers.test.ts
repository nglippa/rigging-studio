import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeLocalAgentReviewProvider, CodexLocalAgentReviewProvider, OllamaVisionReviewProvider, VisionReviewQueue, authenticatedCliEnvironment, runProcess, type ProcessRunner } from "../../mcp/vision-review";
import { acceptedReview, artifact } from "./vision-review-fixtures";

const codexRunner = (mode: "valid" | "invalid" | "timeout" | "nonzero" = "valid"): ProcessRunner => async (_command, args) => {
  if (args.includes("--version")) return { stdout: "codex-cli 0.147.0\n", stderr: "", exitCode: 0 };
  if (args[0] === "login") return { stdout: "Logged in using ChatGPT\n", stderr: "", exitCode: 0 };
  if (args[0] === "exec" && args.includes("--help")) return { stdout: "-i, --image <FILE> --output-schema <FILE> --output-last-message <FILE>", stderr: "", exitCode: 0 };
  if (mode === "timeout") throw new Error("Process timed out: codex"); if (mode === "nonzero") throw new Error("Process exited nonzero (1): failed");
  const output = args[args.indexOf("--output-last-message") + 1]; const { writeFile } = await import("node:fs/promises"); await writeFile(output, JSON.stringify(mode === "invalid" ? { decision: "PASS" } : acceptedReview()));
  return { stdout: "", stderr: "", exitCode: 0 };
};

const queued = async () => { const root = await mkdtemp(path.join(tmpdir(), "vision-provider-")); const queue = new VisionReviewQueue({ root, idFactory: () => "job" }); const job = await queue.create({ type: "CUT_MASK_REVIEW", subject: "left forearm", expectedSemantic: "leftForearm", artifacts: [artifact()] }); return { queue, job, paths: await queue.artifactPaths(job.jobId) }; };

describe("local vision review providers", () => {
  it("discovers Codex existing-session, noninteractive, multimodal, structured output and validates a child-process result", async () => {
    const provider = new CodexLocalAgentReviewProvider({ runner: codexRunner() }); const capability = await provider.capabilities();
    expect(capability).toMatchObject({ state: "AVAILABLE_AND_MULTIMODAL", available: true, multimodal: true, structuredOutput: true, usesExistingAccountSession: true, version: "0.147.0" });
    const { job, paths } = await queued(); expect((await provider.review(job, paths)).result.decision).toBe("ACCEPT");
  });
  it("reports missing Claude transport honestly", async () => {
    const provider = new ClaudeLocalAgentReviewProvider(async () => { throw new Error("Executable not found: claude"); });
    expect(await provider.capabilities()).toMatchObject({ state: "UNAVAILABLE", available: false, multimodal: false }); await expect(provider.review({} as never, {})).rejects.toThrow(/claude/i);
  });
  it("rejects Codex malformed output, timeout, and nonzero exit", async () => {
    for (const mode of ["invalid", "timeout", "nonzero"] as const) { const provider = new CodexLocalAgentReviewProvider({ runner: codexRunner(mode) }); const { job, paths } = await queued(); await expect(provider.review(job, paths)).rejects.toThrow(); }
  });
  it("kills a genuinely timed-out child and reports a genuine nonzero exit", async () => {
    await expect(runProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    await expect(runProcess(process.execPath, ["-e", "process.stderr.write('fixture failure'); process.exit(7)"], { timeoutMs: 1000 })).rejects.toThrow(/nonzero \(7\).*fixture failure/);
  });
  it("preserves local CLI runtime state while stripping credential environment variables", () => {
    const previousSession = process.env.CODEX_SESSION_ID; const previousKey = process.env.OPENAI_API_KEY;
    process.env.CODEX_SESSION_ID = "fixture-session"; process.env.OPENAI_API_KEY = "sk-fixture-secret";
    const environment = authenticatedCliEnvironment({ ANTHROPIC_API_KEY: "fixture", RIGGING_STUDIO_SAFE_FLAG: "yes" });
    expect(environment.CODEX_SESSION_ID).toBe("fixture-session"); expect(environment.RIGGING_STUDIO_SAFE_FLAG).toBe("yes"); expect(environment.OPENAI_API_KEY).toBeUndefined(); expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    if (previousSession === undefined) delete process.env.CODEX_SESSION_ID; else process.env.CODEX_SESSION_ID = previousSession; if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  });
  it("reports Ollama unavailable when no service responds", async () => {
    const provider = new OllamaVisionReviewProvider({ fetcher: async () => { throw new TypeError("fetch failed"); } }); expect(await provider.capabilities()).toMatchObject({ available: false, state: "UNAVAILABLE", model: null });
  });
  it("uses only a model with verified vision capability and validates Ollama JSON", async () => {
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "text" }, { name: "vision" }] }));
      if (url.endsWith("/api/show")) { const model = JSON.parse(String(init?.body)).model; return new Response(JSON.stringify({ capabilities: model === "vision" ? ["chat", "vision"] : ["chat"] })); }
      return new Response(JSON.stringify({ message: { content: JSON.stringify(acceptedReview()) } }));
    };
    const provider = new OllamaVisionReviewProvider({ fetcher: fetcher as typeof fetch }); expect(await provider.capabilities()).toMatchObject({ available: true, model: "vision", localOnly: true });
    const { job, paths } = await queued(); expect((await provider.review(job, paths)).result.decision).toBe("ACCEPT");
  });
});
