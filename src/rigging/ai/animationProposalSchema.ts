import { z } from "zod";
import { animationDefinitionSchema } from "../schema/schemas";
import type { AnimationDefinition } from "../schema/types";

export const ANIMATION_PROPOSAL_VERSION = 1 as const;

export type RecommendedRigChange = {
  readonly summary: string;
  readonly rationale: string;
};

export type AnimationProposal = {
  readonly proposalVersion: typeof ANIMATION_PROPOSAL_VERSION;
  readonly summary: string;
  readonly animation: AnimationDefinition;
  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
  readonly affectedBones: readonly string[];
  readonly confidenceNotes: readonly string[];
  readonly recommendedRigChanges?: readonly RecommendedRigChange[];
};

const nonEmptyText = z.string().trim().min(1);

export const animationProposalSchema: z.ZodType<AnimationProposal> = z.object({
  proposalVersion: z.literal(ANIMATION_PROPOSAL_VERSION),
  summary: nonEmptyText,
  animation: animationDefinitionSchema,
  warnings: z.array(nonEmptyText),
  assumptions: z.array(nonEmptyText),
  affectedBones: z.array(nonEmptyText),
  confidenceNotes: z.array(nonEmptyText),
  recommendedRigChanges: z.array(z.object({ summary: nonEmptyText, rationale: nonEmptyText }).strict()).optional(),
}).strict();

export const safeParseAnimationProposal = (input: unknown) => animationProposalSchema.safeParse(input);
