import type { ImageProposal } from "../proposals/imageProposal";
import type { GenerateImageCandidatesRequest } from "./ImageProductionService";
import { ImageProductionService } from "./ImageProductionService";

export const IMAGE_GENERATION_JOB_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type ImageGenerationJobStatus = (typeof IMAGE_GENERATION_JOB_STATUSES)[number];
export type ImageGenerationJob = {
  readonly jobId: string;
  readonly status: ImageGenerationJobStatus;
  readonly provider: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly proposalId?: string;
  readonly error?: string;
};

export class ImageGenerationJobService {
  private readonly jobs = new Map<string, ImageGenerationJob>();
  private readonly activeProposalIds = new Map<string, string>();
  constructor(private readonly imageProduction: ImageProductionService, private readonly now: () => Date = () => new Date()) {}

  start(request: GenerateImageCandidatesRequest): ImageGenerationJob {
    const timestamp = this.now().toISOString();
    const job: ImageGenerationJob = { jobId: `image-job-${crypto.randomUUID()}`, status: "queued", provider: request.provider ?? "comfyui", projectId: request.projectId, createdAt: timestamp, updatedAt: timestamp };
    this.jobs.set(job.jobId, job);
    void this.run(job.jobId, request);
    return job;
  }

  get(jobId: string): ImageGenerationJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Image generation job ${jobId} does not exist`);
    return job;
  }

  async cancel(jobId: string): Promise<ImageGenerationJob> {
    const job = this.get(jobId);
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job;
    const proposalId = this.activeProposalIds.get(jobId);
    if (proposalId) await this.imageProduction.cancel(proposalId);
    const next = { ...job, status: "cancelled" as const, updatedAt: this.now().toISOString() };
    this.jobs.set(jobId, next); return next;
  }

  private async run(jobId: string, request: GenerateImageCandidatesRequest): Promise<void> {
    const current = this.get(jobId);
    this.jobs.set(jobId, { ...current, status: "running", updatedAt: this.now().toISOString() });
    try {
      const proposal = await this.imageProduction.generateCandidates({ ...request, onProposalCreated: (proposalId) => {
        this.activeProposalIds.set(jobId, proposalId);
        const latest = this.get(jobId); this.jobs.set(jobId, { ...latest, proposalId, updatedAt: this.now().toISOString() });
      } });
      const latest = this.get(jobId);
      if (latest.status === "cancelled") return;
      this.jobs.set(jobId, proposal.status === "failed"
        ? { ...latest, status: "failed", proposalId: proposal.proposalId, error: proposal.errors.join("; ") || proposal.progress.message, updatedAt: this.now().toISOString() }
        : { ...latest, status: "completed", proposalId: proposal.proposalId, updatedAt: this.now().toISOString() });
    } catch (error: unknown) {
      const latest = this.get(jobId);
      if (latest.status !== "cancelled") this.jobs.set(jobId, { ...latest, status: "failed", error: error instanceof Error ? error.message : "Image generation failed", updatedAt: this.now().toISOString() });
    } finally { this.activeProposalIds.delete(jobId); }
  }
}

export function jobWithProposal(job: ImageGenerationJob, proposal?: ImageProposal): ImageGenerationJob & { readonly proposal?: ImageProposal } {
  return proposal ? { ...job, proposal } : job;
}
