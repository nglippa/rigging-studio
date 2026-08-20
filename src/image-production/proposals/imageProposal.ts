import { z } from "zod";
import { suitabilityReviewSchema } from "../../character-generation/providers/characterPipelineProvider";

export const IMAGE_PRODUCTION_CAPABILITIES = [
  "CHARACTER_SEGMENTATION",
  "MASK_REFINEMENT",
  "CHARACTER_GENERATION",
  "CHARACTER_VARIANT",
  "OCCLUSION_RECONSTRUCTION",
  "PART_REPAIR",
  "BACKGROUND_REMOVAL",
  "ALPHA_EDGE_CLEANUP",
  "EQUIPMENT_VARIANT",
  "HAND_REPAIR",
] as const;
export type ImageProductionCapability = (typeof IMAGE_PRODUCTION_CAPABILITIES)[number];

export const IMAGE_PROPOSAL_STATUSES = ["generating", "awaiting_review", "approved", "rejected", "failed"] as const;
export type ImageProposalStatus = (typeof IMAGE_PROPOSAL_STATUSES)[number];
export const IMAGE_CANDIDATE_STATUSES = ["generated", "recommended", "approved", "rejected"] as const;
export type ImageCandidateStatus = (typeof IMAGE_CANDIDATE_STATUSES)[number];
export const IMAGE_APPROVAL_POLICIES = ["manual", "agent_recommendation"] as const;
export type ImageApprovalPolicy = (typeof IMAGE_APPROVAL_POLICIES)[number];

const jsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const imageProductionJsonSchema: z.ZodType<ImageProductionJson> = z.lazy(() => z.union([
  jsonPrimitiveSchema,
  z.array(imageProductionJsonSchema),
  z.record(z.string(), imageProductionJsonSchema),
]));
export type ImageProductionJson = string | number | boolean | null | readonly ImageProductionJson[] | { readonly [key: string]: ImageProductionJson };

export type CandidateDiagnostics = {
  readonly suitability?: z.infer<typeof suitabilityReviewSchema>;
  readonly warnings: readonly string[];
};

export type ImageCandidate = {
  readonly candidateId: string;
  readonly imageAssetId: string;
  readonly imageFileName: string;
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  readonly providerMetadata: Readonly<Record<string, ImageProductionJson>>;
  readonly diagnostics: CandidateDiagnostics;
  readonly status: ImageCandidateStatus;
};

export type ImageCandidateReview = {
  readonly candidateId: string;
  readonly decision: "recommend" | "reject" | "acceptable";
  readonly reasons: readonly string[];
};

export type ImageAgentReview = {
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly recommendedCandidateId?: string;
  readonly candidateReviews: readonly ImageCandidateReview[];
};

export type ImageInspectionEvidence = {
  readonly resourceId: string;
  readonly candidateIds: readonly string[];
  readonly sessionId: string;
  readonly inspectedAt: string;
};

export type ImageHumanReview = {
  readonly reviewer: "human";
  readonly reviewedAt: string;
  readonly decision: "approved" | "rejected";
  readonly candidateId?: string;
};

export type ImageProposalProgress = {
  readonly phase: "queued" | "sampling" | "decoding" | "collecting" | "ready" | "failed";
  readonly candidateIndex: number;
  readonly candidateCount: number;
  readonly percent?: number;
  readonly message: string;
};

export type ImageProposal = {
  readonly proposalVersion: 1;
  readonly proposalId: string;
  readonly projectId: string;
  readonly operationType: ImageProductionCapability;
  readonly provider: "comfyui";
  readonly workflowId: string;
  readonly status: ImageProposalStatus;
  readonly approvalPolicy: ImageApprovalPolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sourcePrompt: string;
  readonly negativePrompt: string;
  readonly generationParameters: Readonly<Record<string, ImageProductionJson>>;
  readonly targetPartId?: string;
  readonly parentProposalId?: string;
  readonly proposalRound: number;
  readonly candidateIds: readonly string[];
  readonly candidates: readonly ImageCandidate[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly progress: ImageProposalProgress;
  readonly agentReview?: ImageAgentReview;
  readonly humanReview?: ImageHumanReview;
  readonly inspectionEvidence: readonly ImageInspectionEvidence[];
  readonly approvedCandidateId?: string;
  readonly contactSheetFileName?: string;
};

const candidateDiagnosticsSchema: z.ZodType<CandidateDiagnostics> = z.object({
  suitability: suitabilityReviewSchema.optional(),
  warnings: z.array(z.string()),
}).strict();

export const imageCandidateSchema: z.ZodType<ImageCandidate> = z.object({
  candidateId: z.string().min(1),
  imageAssetId: z.string().min(1),
  imageFileName: z.string().regex(/^[a-zA-Z0-9._-]+\.(png|jpg|jpeg)$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  seed: z.number().int().nonnegative(),
  providerMetadata: z.record(z.string(), imageProductionJsonSchema),
  diagnostics: candidateDiagnosticsSchema,
  status: z.enum(IMAGE_CANDIDATE_STATUSES),
}).strict();

const candidateReviewSchema: z.ZodType<ImageCandidateReview> = z.object({
  candidateId: z.string().min(1),
  decision: z.enum(["recommend", "reject", "acceptable"]),
  reasons: z.array(z.string().trim().min(1).max(500)).min(1),
}).strict();

const agentReviewSchema: z.ZodType<ImageAgentReview> = z.object({
  reviewer: z.string().min(1),
  reviewedAt: z.string().datetime(),
  recommendedCandidateId: z.string().min(1).optional(),
  candidateReviews: z.array(candidateReviewSchema).min(1),
}).strict();

const inspectionEvidenceSchema: z.ZodType<ImageInspectionEvidence> = z.object({
  resourceId: z.string().min(1), candidateIds: z.array(z.string().min(1)).min(1), sessionId: z.string().min(1), inspectedAt: z.string().datetime(),
}).strict();

const humanReviewSchema: z.ZodType<ImageHumanReview> = z.object({
  reviewer: z.literal("human"), reviewedAt: z.string().datetime(), decision: z.enum(["approved", "rejected"]), candidateId: z.string().min(1).optional(),
}).strict();

const progressSchema: z.ZodType<ImageProposalProgress> = z.object({
  phase: z.enum(["queued", "sampling", "decoding", "collecting", "ready", "failed"]),
  candidateIndex: z.number().int().nonnegative(), candidateCount: z.number().int().positive(), percent: z.number().min(0).max(100).optional(), message: z.string(),
}).strict();

export const imageProposalSchema: z.ZodType<ImageProposal> = z.object({
  proposalVersion: z.literal(1), proposalId: z.string().min(1), projectId: z.string().min(1), operationType: z.enum(IMAGE_PRODUCTION_CAPABILITIES),
  provider: z.literal("comfyui"), workflowId: z.string().min(1), status: z.enum(IMAGE_PROPOSAL_STATUSES), approvalPolicy: z.enum(IMAGE_APPROVAL_POLICIES),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), sourcePrompt: z.string(), negativePrompt: z.string(),
  generationParameters: z.record(z.string(), imageProductionJsonSchema), targetPartId: z.string().min(1).optional(), parentProposalId: z.string().min(1).optional(), proposalRound: z.number().int().min(1).max(100),
  candidateIds: z.array(z.string().min(1)), candidates: z.array(imageCandidateSchema), warnings: z.array(z.string()), errors: z.array(z.string()), progress: progressSchema,
  agentReview: agentReviewSchema.optional(), humanReview: humanReviewSchema.optional(), inspectionEvidence: z.array(inspectionEvidenceSchema),
  approvedCandidateId: z.string().min(1).optional(), contactSheetFileName: z.string().regex(/^[a-zA-Z0-9._-]+\.png$/).optional(),
}).strict();

export const imageProposalReviewInputSchema = z.object({
  proposalId: z.string().min(1), recommendedCandidateId: z.string().min(1).optional(), candidateReviews: z.array(candidateReviewSchema).min(1),
}).strict();

export type ImageProposalReviewInput = z.infer<typeof imageProposalReviewInputSchema>;

export function parseImageProposal(input: unknown): ImageProposal {
  const parsed = imageProposalSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid image proposal: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}
