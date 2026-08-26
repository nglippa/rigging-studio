import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectSupportedImage } from "../storage/managedGenerationStorage";
import { buildVisionReviewPrompt, persistedVisionReviewResultSchema, validateVisionReviewResult, visionReviewJobSchema, type PersistedVisionReviewResult, type VisionReviewArtifact, type VisionReviewInvocation, type VisionReviewJob, type VisionReviewProvenance } from "../../src/vision-review";

export type VisionReviewArtifactInput = {
  readonly name: string;
  readonly role: VisionReviewArtifact["role"];
  readonly mimeType: VisionReviewArtifact["mimeType"];
  readonly bytes: Uint8Array;
  readonly candidateId?: string;
};
export type CreateVisionReviewJobInput = {
  readonly type: VisionReviewJob["type"];
  readonly mode?: VisionReviewJob["mode"];
  readonly subject: string;
  readonly expectedSemantic?: string | null;
  readonly deterministicFindings?: readonly string[];
  readonly candidateIds?: readonly string[];
  readonly artifacts: readonly VisionReviewArtifactInput[];
  readonly parentJobId?: string | null;
  readonly maxAttempts?: number;
  readonly repairApplied?: string | null;
};
export type VisionReviewQueueStatus = {
  readonly jobId: string;
  readonly status: "PENDING" | "IN_REVIEW" | "COMPLETED" | "RERENDER_REQUESTED" | "FAILED";
  readonly updatedAt: string;
  readonly providerAttempts: readonly { readonly providerId: string; readonly outcome: "unavailable" | "failed" | "invalid" | "completed"; readonly message: string; readonly latencyMs: number }[];
  readonly resultFile: string | null;
  readonly rerenderReason: string | null;
};
type QueueOptions = { readonly cwd?: string; readonly root?: string; readonly now?: () => Date; readonly idFactory?: () => string };

const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const within = (candidate: string, root: string): boolean => { const relative = path.relative(root, candidate); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
const sha = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const secretPattern = /(?:sk-[a-z0-9_-]{16,}|bearer\s+[a-z0-9._-]{12,}|(?:api[_-]?key|cookie|auth(?:orization)?[_-]?token)\s*[:=]\s*\S+)/i;
const assertNoSecrets = (value: unknown): void => { if (secretPattern.test(JSON.stringify(value))) throw new Error("Review metadata appears to contain authentication material"); };

export class VisionReviewQueue {
  readonly root: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: QueueOptions = {}) {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    this.root = path.resolve(options.root ?? path.join(cwd, ".rigging-studio", "review-queue"));
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `review-${this.now().toISOString().replace(/[:.]/g, "-")}-${randomBytes(5).toString("hex")}`);
  }

  async create(input: CreateVisionReviewJobInput): Promise<VisionReviewJob> {
    assertNoSecrets(input);
    if (!input.artifacts.length || input.artifacts.length > 40) throw new Error("Review jobs require 1-40 explicit image artifacts");
    let attempt = 1; let maxAttempts = input.maxAttempts ?? 3;
    if (input.parentJobId) {
      const parent = await this.loadJob(input.parentJobId); attempt = parent.attempt + 1; maxAttempts = input.maxAttempts ?? parent.maxAttempts;
      if (attempt > maxAttempts) throw new Error(`Review max attempts reached for ${parent.jobId}`);
    }
    const names = new Set<string>(); const prepared: { readonly input: VisionReviewArtifactInput; readonly record: VisionReviewArtifact }[] = [];
    for (const artifact of input.artifacts) {
      this.assertArtifactName(artifact.name); if (names.has(artifact.name)) throw new Error(`Duplicate review artifact ${artifact.name}`); names.add(artifact.name);
      if (!artifact.bytes.length || artifact.bytes.length > MAX_ARTIFACT_BYTES) throw new Error(`Review artifact ${artifact.name} is empty or too large`);
      const inspected = inspectSupportedImage(artifact.bytes); if (inspected.mimeType !== artifact.mimeType) throw new Error(`Review artifact ${artifact.name} MIME type does not match its bytes`);
      prepared.push({ input: artifact, record: { name: artifact.name, role: artifact.role, mimeType: artifact.mimeType, sha256: sha(artifact.bytes), bytes: artifact.bytes.byteLength, ...(artifact.candidateId ? { candidateId: artifact.candidateId } : {}) } });
    }
    const jobId = this.idFactory(); this.assertId(jobId); const directory = this.jobDirectory(jobId);
    const job = visionReviewJobSchema.parse({
      schemaVersion: 1, jobId, parentJobId: input.parentJobId ?? null, attempt, maxAttempts,
      type: input.type, mode: input.mode ?? "SINGLE", subject: input.subject, expectedSemantic: input.expectedSemantic ?? null,
      deterministicFindings: input.deterministicFindings ?? [], candidateIds: input.candidateIds ?? [], artifacts: prepared.map((item) => item.record),
      promptSchemaVersion: "vision-review-prompt-v1", createdAt: this.now().toISOString(), repairApplied: input.repairApplied ?? null,
    });
    await mkdir(this.root, { recursive: true }); await mkdir(directory); await mkdir(path.join(directory, "artifacts"));
    await Promise.all(prepared.map(({ input: artifact }) => this.atomicWrite(this.contained(path.join(directory, "artifacts", artifact.name), directory), artifact.bytes)));
    await Promise.all([
      this.atomicWrite(path.join(directory, "request.json"), json(job)),
      this.atomicWrite(path.join(directory, "prompt.txt"), `${buildVisionReviewPrompt(job)}\n`),
      this.atomicWrite(path.join(directory, "status.json"), json(this.initialStatus(jobId))),
    ]);
    return job;
  }

  async loadJob(jobId: string): Promise<VisionReviewJob> { const directory = await this.existingJobDirectory(jobId); return visionReviewJobSchema.parse(JSON.parse(await readFile(path.join(directory, "request.json"), "utf8")) as unknown); }
  async loadStatus(jobId: string): Promise<VisionReviewQueueStatus> { const directory = await this.existingJobDirectory(jobId); return JSON.parse(await readFile(path.join(directory, "status.json"), "utf8")) as VisionReviewQueueStatus; }
  async openPacket(jobId: string): Promise<{ readonly job: VisionReviewJob; readonly status: VisionReviewQueueStatus; readonly prompt: string; readonly artifactResources: readonly { readonly name: string; readonly mimeType: string; readonly uri: string; readonly sha256: string }[] }> {
    const [job, status, prompt] = await Promise.all([this.loadJob(jobId), this.loadStatus(jobId), readFile(path.join(this.jobDirectory(jobId), "prompt.txt"), "utf8")]);
    return { job, status, prompt, artifactResources: job.artifacts.map((artifact) => ({ name: artifact.name, mimeType: artifact.mimeType, sha256: artifact.sha256, uri: `rigging://review-queue/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifact.name)}` })) };
  }

  async listPending(): Promise<readonly { readonly job: VisionReviewJob; readonly status: VisionReviewQueueStatus }[]> {
    await mkdir(this.root, { recursive: true }); const entries = await readdir(this.root, { withFileTypes: true }); const jobs: { job: VisionReviewJob; status: VisionReviewQueueStatus }[] = [];
    for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      try { const job = await this.loadJob(entry.name); const status = await this.loadStatus(entry.name); if (status.status === "PENDING" || status.status === "RERENDER_REQUESTED") jobs.push({ job, status }); } catch { /* malformed directories are not queue jobs */ }
    }
    return jobs;
  }

  async artifactPaths(jobId: string): Promise<Readonly<Record<string, string>>> {
    const job = await this.loadJob(jobId); return Object.fromEntries(job.artifacts.map((artifact) => [artifact.name, this.contained(path.join(this.jobDirectory(jobId), "artifacts", artifact.name), this.jobDirectory(jobId))]));
  }

  async readArtifact(jobId: string, artifactName: string): Promise<{ readonly bytes: Uint8Array; readonly artifact: VisionReviewArtifact }> {
    const job = await this.loadJob(jobId); const artifact = job.artifacts.find((item) => item.name === artifactName); if (!artifact) throw new Error("Artifact is not attached to this review job");
    const target = this.contained(path.join(this.jobDirectory(jobId), "artifacts", artifact.name), this.jobDirectory(jobId));
    const canonical = await realpath(target); const canonicalRoot = await realpath(this.jobDirectory(jobId)); if (!within(canonical, canonicalRoot)) throw new Error("Review artifact escaped its job directory");
    const fileStat = await stat(canonical); if (!fileStat.isFile() || fileStat.size !== artifact.bytes) throw new Error("Review artifact size no longer matches its manifest");
    const bytes = await readFile(canonical); if (sha(bytes) !== artifact.sha256) throw new Error("Review artifact hash no longer matches its manifest"); return { bytes, artifact };
  }

  async recordAttempt(jobId: string, attempt: VisionReviewQueueStatus["providerAttempts"][number]): Promise<void> {
    const status = await this.loadStatus(jobId); await this.writeStatus({ ...status, status: attempt.outcome === "completed" ? "COMPLETED" : status.status, updatedAt: this.now().toISOString(), providerAttempts: [...status.providerAttempts, attempt] });
  }

  async markInReview(jobId: string): Promise<void> { const status = await this.loadStatus(jobId); await this.writeStatus({ ...status, status: "IN_REVIEW", updatedAt: this.now().toISOString() }); }

  async persistResult(jobId: string, invocation: VisionReviewInvocation, latencyMs: number, deterministicVetoes: readonly string[] = []): Promise<PersistedVisionReviewResult> {
    const job = await this.loadJob(jobId); let result = validateVisionReviewResult(invocation.result, job);
    if (result.decision === "ACCEPT" && deterministicVetoes.length) result = { ...result, decision: "HUMAN_REVIEW", recommendedAction: `Deterministic veto: ${deterministicVetoes.join("; ")}` };
    assertNoSecrets(result); const resultSha256 = sha(JSON.stringify(result));
    const provenance: VisionReviewProvenance = {
      providerId: invocation.classification === "manual" ? "manual" : (await this.loadStatus(jobId)).providerAttempts.at(-1)?.providerId ?? "unknown",
      providerVersion: invocation.providerVersion, model: invocation.model, classification: invocation.classification,
      authenticatedViaExistingSession: invocation.authenticatedViaExistingSession, timestamp: this.now().toISOString(),
      sourceArtifactHashes: Object.fromEntries(job.artifacts.map((artifact) => [artifact.name, artifact.sha256])), promptSchemaVersion: "vision-review-prompt-v1", resultSchemaVersion: "vision-review-result-v1", resultSha256, latencyMs, deterministicVetoes: [...deterministicVetoes],
    };
    const persisted = persistedVisionReviewResultSchema.parse({ schemaVersion: 1, jobId, result, provenance });
    await this.atomicWrite(path.join(this.jobDirectory(jobId), "provider-result.json"), json(persisted));
    const status = await this.loadStatus(jobId); await this.writeStatus({ ...status, status: "COMPLETED", updatedAt: this.now().toISOString(), resultFile: "provider-result.json" }); return persisted;
  }

  async submitManualResult(jobId: string, input: unknown): Promise<PersistedVisionReviewResult> {
    const job = await this.loadJob(jobId); const result = validateVisionReviewResult(input, job); await this.atomicWrite(path.join(this.jobDirectory(jobId), "result.json"), json(result));
    await this.recordAttempt(jobId, { providerId: "manual", outcome: "completed", message: "Validated manual/MCP result", latencyMs: 0 });
    return this.persistResult(jobId, { result, providerVersion: null, model: null, classification: "manual", authenticatedViaExistingSession: false }, 0);
  }

  async consumeManualResult(jobId: string): Promise<PersistedVisionReviewResult> {
    const input = JSON.parse(await readFile(path.join(this.jobDirectory(jobId), "result.json"), "utf8")) as unknown; return this.submitManualResult(jobId, input);
  }

  async requestRerender(jobId: string, reason: string): Promise<VisionReviewQueueStatus> {
    const job = await this.loadJob(jobId); if (job.attempt >= job.maxAttempts) throw new Error(`Review max attempts reached for ${jobId}`);
    const status = await this.loadStatus(jobId); const next = { ...status, status: "RERENDER_REQUESTED" as const, updatedAt: this.now().toISOString(), rerenderReason: reason };
    await Promise.all([this.writeStatus(next), this.atomicWrite(path.join(this.jobDirectory(jobId), "rerender-request.json"), json({ jobId, reason, requestedAt: next.updatedAt }))]); return next;
  }

  private initialStatus(jobId: string): VisionReviewQueueStatus { return { jobId, status: "PENDING", updatedAt: this.now().toISOString(), providerAttempts: [], resultFile: null, rerenderReason: null }; }
  private async writeStatus(status: VisionReviewQueueStatus): Promise<void> { await this.atomicWrite(path.join(this.jobDirectory(status.jobId), "status.json"), json(status)); }
  private jobDirectory(jobId: string): string { this.assertId(jobId); return this.contained(path.join(this.root, jobId), this.root); }
  private async existingJobDirectory(jobId: string): Promise<string> { const directory = this.jobDirectory(jobId); const [canonicalRoot, canonicalDirectory] = await Promise.all([realpath(this.root), realpath(directory)]); if (!within(canonicalDirectory, canonicalRoot)) throw new Error("Review job escaped its fixed queue directory"); const fileStat = await stat(canonicalDirectory); if (!fileStat.isDirectory()) throw new Error("Review job is not a directory"); return canonicalDirectory; }
  private assertId(value: string): void { if (!idPattern.test(value)) throw new Error("Invalid contained review identifier"); }
  private assertArtifactName(value: string): void { this.assertId(value); if (!/\.(png|jpg|jpeg)$/i.test(value)) throw new Error("Review artifacts must be named PNG or JPEG files"); }
  private contained(candidate: string, root: string): string { const resolved = path.resolve(candidate); if (!within(resolved, path.resolve(root))) throw new Error("Review path escaped its fixed queue directory"); return resolved; }
  private async atomicWrite(target: string, value: string | Uint8Array): Promise<void> { const temp = `${target}.${randomBytes(5).toString("hex")}.tmp`; await writeFile(temp, value); await rename(temp, target); }
}
