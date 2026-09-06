import { canonicalProjectStateDigest } from "../project-storage/digest";
import type { LocalProjectSnapshot } from "../project-storage/types";
import { blockingRigProjectProblems, validateRigProject } from "../rigging/validation/project";
import { replaceAnimation } from "../tools/rig-editor/animation/library";
import { DOCTOR_LIMITS, doctorProposalSchema, type DoctorIdentity } from "./schema";

export function assertDoctorIdentity(expected: DoctorIdentity, actual: DoctorIdentity): void {
  if (expected.projectId !== actual.projectId || expected.projectSessionToken !== actual.projectSessionToken || expected.revision !== actual.revision || expected.clipId !== actual.clipId || expected.beforeDigest !== actual.beforeDigest) throw new Error("Stale motion review: project, session, revision, or source changed");
}

export function validateDoctorSnapshot(snapshot: LocalProjectSnapshot): void {
  const errors = blockingRigProjectProblems(validateRigProject(snapshot));
  if (errors.length) throw new Error(`Motion change vetoed: ${errors.map((error) => error.code).join(", ")}`);
}

/** Pure candidate construction. No source mutation, history write, or persistence. */
export function applyDoctorProposal(snapshot: LocalProjectSnapshot, input: unknown, currentIdentity: DoctorIdentity): LocalProjectSnapshot {
  const proposal = doctorProposalSchema.parse(input);
  assertDoctorIdentity(proposal.identity, currentIdentity);
  if (canonicalProjectStateDigest(snapshot) !== currentIdentity.beforeDigest) throw new Error("Motion review source digest mismatch");
  if ((snapshot.localProjectId ?? snapshot.project?.id ?? `editor:${snapshot.rig?.id}`) !== currentIdentity.projectId) throw new Error("Motion review project identity mismatch");
  validateDoctorSnapshot(snapshot);
  const rig = snapshot.rig; const library = snapshot.animations;
  const clip = library?.animations.find((animation) => animation.id === proposal.identity.clipId);
  if (!rig || !library || !clip) throw new Error("Motion review clip is missing");
  const seen = new Set<string>(); const ids = new Set<string>();
  for (const edit of proposal.edits) {
    const target = JSON.stringify([edit.boneId, edit.property, edit.time]);
    if (seen.has(target) || ids.has(edit.id)) throw new Error("Duplicate motion edit target or ID");
    seen.add(target); ids.add(edit.id);
    if (!rig.bones.some((bone) => bone.id === edit.boneId)) throw new Error("Motion edit targets a missing bone");
    const track = clip.tracks.find((track) => track.boneId === edit.boneId && track.property === edit.property);
    const key = track?.keyframes.find((key) => key.time === edit.time);
    if (!key) throw new Error("Motion edits require an existing channel and exact key time");
    if (key.value !== edit.currentValue) throw new Error("Motion edit current value is stale");
    const bound = edit.property === "rotation" ? DOCTOR_LIMITS.rotationDelta : Math.min(DOCTOR_LIMITS.translationDelta, Math.min(rig.canvas.width, rig.canvas.height) * .025);
    if (Math.abs(edit.proposedValue - edit.currentValue) > bound) throw new Error("Motion edit exceeds its bounded range");
    if (edit.proposedValue === edit.currentValue) throw new Error("Motion edit does not change its target");
  }
  const animation = { ...clip, tracks: clip.tracks.map((track) => ({ ...track, keyframes: track.keyframes.map((key) => {
    const edit = proposal.edits.find((edit) => edit.boneId === track.boneId && edit.property === track.property && edit.time === key.time);
    return edit ? { ...key, value: edit.proposedValue } : { ...key };
  }) })) };
  const candidate = { ...structuredClone(snapshot), animations: replaceAnimation(library, animation) };
  validateDoctorSnapshot(candidate);
  return candidate;
}
