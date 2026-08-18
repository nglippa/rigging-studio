import type { RigDefinition } from "../../rigging/schema/types";
import { safeParseRigDefinition } from "../../rigging/schema/parsing";
import type { ValidationResult } from "../../rigging/validation/issues";

export const RIG_EDITOR_DRAFT_KEY = "rig-studio:editor-draft:v1";

export type RigEditorDraft = {
  readonly draftVersion: 1;
  readonly savedAt: string;
  readonly rig: RigDefinition;
};

export function serializeDraft(rig: RigDefinition, savedAt = new Date().toISOString()): string {
  const draft: RigEditorDraft = { draftVersion: 1, savedAt, rig };
  return JSON.stringify(draft);
}

export function parseDraft(source: string): ValidationResult<RigEditorDraft> {
  let input: unknown;
  try { input = JSON.parse(source) as unknown; }
  catch (reason: unknown) {
    return { success: false, message: reason instanceof Error ? reason.message : "Draft JSON is invalid", issues: [{ code: "invalid_json", path: [], message: "Draft JSON is invalid" }] };
  }
  if (!input || typeof input !== "object") {
    return { success: false, message: "Draft must be an object", issues: [{ code: "invalid_draft", path: [], message: "Draft must be an object" }] };
  }
  const record = input as Record<string, unknown>;
  if (record.draftVersion !== 1 || typeof record.savedAt !== "string") {
    return { success: false, message: "Unsupported editor draft", issues: [{ code: "unsupported_draft", path: [], message: "Unsupported editor draft" }] };
  }
  const rig = safeParseRigDefinition(record.rig);
  if (!rig.success) return rig;
  return { success: true, data: { draftVersion: 1, savedAt: record.savedAt, rig: rig.data } };
}
