import { z } from "zod";
import { PART_SEMANTIC_TYPES } from "../part-cutter/semanticTaxonomy";

export const INTELLIGENCE_CAPABILITIES = ["TEXT", "VISION", "UNKNOWN"] as const;
export type IntelligenceCapability = (typeof INTELLIGENCE_CAPABILITIES)[number];

export type IntelligenceModel = {
  readonly name: string;
  readonly size: number | null;
  readonly family: string | null;
  readonly capabilities: readonly IntelligenceCapability[];
};

export type IntelligenceProviderStatus = {
  readonly provider: string;
  readonly label: string;
  readonly local: true;
  readonly reachable: boolean;
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly selectedModel: string | null;
  readonly models: readonly IntelligenceModel[];
  readonly message: string;
};

export const assistantProposalSchema = z.object({
  proposalId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  action: z.enum(["suggest_semantic", "explain_region", "check_partition", "suggest_topology", "refine_edge"]),
  summary: z.string().min(1).max(2000),
  semanticType: z.enum(PART_SEMANTIC_TYPES).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable(),
  rationale: z.string().max(2000),
  targetPartId: z.string().min(1).nullable().optional(),
  requiresAcceptance: z.literal(true),
  inspectedImage: z.boolean(),
  createdAt: z.string(),
}).strict();
export type AssistantProposal = z.infer<typeof assistantProposalSchema>;

export type AssistantProposalRequest = {
  readonly action: AssistantProposal["action"];
  readonly prompt: string;
  readonly selectedModel?: string;
  readonly imageBase64?: string;
  readonly existingRegionNames?: readonly string[];
  readonly targetPartId?: string;
};

export interface IntelligenceProvider {
  readonly id: string;
  readonly label: string;
  status(): Promise<IntelligenceProviderStatus>;
  listModels(): Promise<readonly IntelligenceModel[]>;
  selectModel(model: string): void;
  propose(request: AssistantProposalRequest): Promise<AssistantProposal>;
}

export function validateAssistantProposal(input: unknown): AssistantProposal {
  return assistantProposalSchema.parse(input);
}
