import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodexLocalAgentReviewProvider, VisionReviewQueue, VisionReviewService } from "../../mcp/vision-review";

const root = process.cwd(); const stamp = new Date().toISOString().replace(/[:.]/g, "-"); const output = path.join(root, ".rigging-studio", "diagnostics", "vision-review", stamp); await mkdir(output, { recursive: true });
const service = new VisionReviewService({ queue: new VisionReviewQueue({ cwd: root }), policy: { policy: "local-first", maxAttempts: 3 } });
const providers = [];
for (const provider of service.providers) {
  const started = Date.now();
  try { const capability = await provider.capabilities(); providers.push({ ...capability, latencyMs: Date.now() - started, smokeTest: "not invoked" }); }
  catch (error: unknown) { providers.push({ providerId: provider.id, available: false, latencyMs: Date.now() - started, smokeTest: "failed", failureReason: error instanceof Error ? error.message : "Capability discovery failed" }); }
}
let smoke: unknown = { requested: false };
if (process.argv.includes("--smoke")) {
  const imagePath = path.join(root, "public", "assets", "generated", "void-ranger-sprite.png"); const image = await readFile(imagePath);
  const queue = new VisionReviewQueue({ root: path.join(output, "fixture-queue") }); const codex = new CodexLocalAgentReviewProvider(); const smokeService = new VisionReviewService({ queue, providers: [codex], policy: { policy: "codex-first", maxAttempts: 2 } });
  const job = await smokeService.createJob({ type: "RIG_POSE_REVIEW", subject: "Void Ranger source-image transport fixture", deterministicFindings: ["PNG signature, dimensions, and source SHA-256 were verified before semantic review"], artifacts: [{ name: "void-ranger.png", role: "source", mimeType: "image/png", bytes: image }] });
  const started = Date.now();
  try { const result = await smokeService.review(job.jobId); const codexPassed = result.provenance.providerId === codex.id && result.provenance.classification === "account-backed-cloud"; smoke = { requested: true, passed: codexPassed, latencyMs: Date.now() - started, jobId: job.jobId, decision: result.result.decision, confidence: result.result.confidence, provider: result.provenance.providerId, authenticatedViaExistingSession: result.provenance.authenticatedViaExistingSession, ...(codexPassed ? {} : { failureReason: "Codex did not produce the persisted verdict; manual fallback was used", attempts: (await queue.loadStatus(job.jobId)).providerAttempts }) }; }
  catch (error: unknown) { smoke = { requested: true, passed: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : "Smoke review failed" }; }
}
const report = { generatedAt: new Date().toISOString(), policy: service.policy, providers, smoke, security: { apiKeysRead: false, credentialFilesRead: false, browserScraping: false, guiAutomation: false } };
await writeFile(path.join(output, "capability-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"); process.stdout.write(`${JSON.stringify({ output, ...report }, null, 2)}\n`);
