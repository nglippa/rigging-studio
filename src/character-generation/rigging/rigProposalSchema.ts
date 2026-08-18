import { z } from "zod";
import { rigDefinitionSchema } from "../../rigging/schema/schemas";
import type { RigDefinition } from "../../rigging/schema/types";

export type RigProposal = { readonly proposalVersion: 1; readonly rig: RigDefinition; readonly confidence: Readonly<Record<string, number>>; readonly warnings: readonly string[] };
export const rigProposalSchema: z.ZodType<RigProposal> = z.object({
  proposalVersion: z.literal(1), rig: rigDefinitionSchema, confidence: z.record(z.string(), z.number().min(0).max(1)), warnings: z.array(z.string()),
}).strict();
