import { safeParseRigDefinition } from "../../rigging/schema/parsing";
import type { ValidationResult } from "../../rigging/validation/issues";
import { rigProposalSchema, type RigProposal } from "./rigProposalSchema";

export function validateRigProposal(input: unknown): ValidationResult<RigProposal> {
  const parsed = rigProposalSchema.safeParse(input);
  if (!parsed.success) return { success: false, message: `Rig proposal is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`, issues: parsed.error.issues.map((issue) => ({ code: "invalid_rig_proposal", path: issue.path.map(String), message: issue.message })) };
  const rig = safeParseRigDefinition(parsed.data.rig);
  return rig.success ? { success: true, data: parsed.data } : rig;
}
