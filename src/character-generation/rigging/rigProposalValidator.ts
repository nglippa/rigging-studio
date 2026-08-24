import { safeParseRigDefinition } from "../../rigging/schema/parsing";
import type { RigDefinition } from "../../rigging/schema/types";
import type { ValidationResult } from "../../rigging/validation/issues";
import { blockingRigProjectProblems, validateRigProject } from "../../rigging/validation/project";
import type { GeneratedCharacterProject } from "../project/generatedCharacterProject";
import type { AnimationLibrary } from "../../tools/rig-editor/animation/types";
import { rigProposalSchema, type RigProposal } from "./rigProposalSchema";

export function validateRigProposal(input: unknown): ValidationResult<RigProposal> {
  const parsed = rigProposalSchema.safeParse(input);
  if (!parsed.success) return { success: false, message: `Rig proposal is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`, issues: parsed.error.issues.map((issue) => ({ code: "invalid_rig_proposal", path: issue.path.map(String), message: issue.message })) };
  const rig = safeParseRigDefinition(parsed.data.rig);
  return rig.success ? { success: true, data: parsed.data } : rig;
}

export function validateAutoRigCandidate(project: GeneratedCharacterProject, rig: RigDefinition, animations: AnimationLibrary | null = null) {
  const candidate = { ...project, rigDefinition: rig, skins: rig.skins };
  return blockingRigProjectProblems(validateRigProject({ storageVersion: 1, localProjectId: project.id, project: candidate, rig, animations, selectedSkinId: rig.defaultSkinId }));
}
