import { VisionReviewQueue } from "../../mcp/vision-review";

const queue = new VisionReviewQueue({ cwd: process.cwd() });
const consumeIndex = process.argv.indexOf("--consume");
if (consumeIndex >= 0) {
  const jobId = process.argv[consumeIndex + 1]; if (!jobId) throw new Error("Usage: npm run review:next -- --consume <job-id>");
  const result = await queue.consumeManualResult(jobId); process.stdout.write(`${JSON.stringify({ consumed: true, jobId, decision: result.result.decision, provenance: result.provenance }, null, 2)}\n`); process.exit(0);
}
const pending = await queue.listPending();
if (!pending.length) { process.stdout.write(`${JSON.stringify({ pending: 0, message: "No pending visual-review jobs" }, null, 2)}\n`); process.exit(0); }
const packet = await queue.openPacket(pending[0].job.jobId); process.stdout.write(`${JSON.stringify({ pending: pending.length, next: packet, instruction: `Inspect only the artifacts listed in this packet. Write strict result JSON to .rigging-studio/review-queue/${packet.job.jobId}/result.json, then run npm run review:next -- --consume ${packet.job.jobId}` }, null, 2)}\n`);
