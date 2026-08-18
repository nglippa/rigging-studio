import { serializeDraft, RIG_EDITOR_DRAFT_KEY } from "../../tools/rig-editor/draft";
import { safeParseRigDefinition } from "../../rigging/schema/parsing";
import type { GeneratedCharacterProject } from "./generatedCharacterProject";

export const RIG_EDITOR_HANDOFF_KEY = "rig-studio:editor-handoff:v1";
export type RigEditorHandoff = { readonly projectId: string; readonly showBones: true; readonly centerView: true; readonly validationMessage: string };

export function createRigEditorHandoff(project: GeneratedCharacterProject): { readonly draftKey: string; readonly draftValue: string; readonly handoffKey: string; readonly handoffValue: string } {
  if (!project.rigDefinition) throw new Error("Generate and validate a rig before opening the editor");
  const parsed = safeParseRigDefinition(project.rigDefinition); if (!parsed.success) throw new Error(parsed.message);
  const handoff: RigEditorHandoff = { projectId: project.id, showBones: true, centerView: true, validationMessage: "Generated character loaded · rig valid" };
  return { draftKey: RIG_EDITOR_DRAFT_KEY, draftValue: serializeDraft(parsed.data), handoffKey: RIG_EDITOR_HANDOFF_KEY, handoffValue: JSON.stringify(handoff) };
}

export function writeRigEditorHandoff(storage: Pick<Storage, "setItem">, project: GeneratedCharacterProject): void {
  const handoff = createRigEditorHandoff(project); storage.setItem(handoff.draftKey, handoff.draftValue); storage.setItem(handoff.handoffKey, handoff.handoffValue);
}

/**
 * Generated-character rigs keep their image-heavy document in IndexedDB. The
 * handoff in localStorage is deliberately only a lightweight navigation hint.
 */
export function writeRigEditorHandoffPointer(storage: Pick<Storage, "setItem">, project: GeneratedCharacterProject): void {
  const handoff = createRigEditorHandoff(project);
  storage.setItem(handoff.handoffKey, handoff.handoffValue);
}
