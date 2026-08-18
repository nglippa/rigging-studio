import { parseGeneratedCharacterProject, serializeGeneratedCharacterProject, type GeneratedCharacterProject } from "./generatedCharacterProject";

export const GENERATED_CHARACTER_DRAFT_KEY = "rig-studio:generated-character-draft:v1";
export const GENERATED_CHARACTER_ACTIVE_DRAFT_KEY = "rig-studio:generated-character-active:v1";
export const generatedCharacterDraftKey = (projectId: string): string => `${GENERATED_CHARACTER_DRAFT_KEY}:${projectId}`;

export const saveGeneratedCharacterDraft = (storage: Pick<Storage, "setItem">, project: GeneratedCharacterProject): void => {
  storage.setItem(generatedCharacterDraftKey(project.id), serializeGeneratedCharacterProject(project));
  storage.setItem(GENERATED_CHARACTER_ACTIVE_DRAFT_KEY, project.id);
};
export const loadGeneratedCharacterDraft = (storage: Pick<Storage, "getItem">): ReturnType<typeof parseGeneratedCharacterProject> | null => {
  const activeProjectId = storage.getItem(GENERATED_CHARACTER_ACTIVE_DRAFT_KEY);
  const source = activeProjectId
    ? storage.getItem(generatedCharacterDraftKey(activeProjectId))
    : storage.getItem(GENERATED_CHARACTER_DRAFT_KEY);
  if (!source) return null;
  try { return parseGeneratedCharacterProject(JSON.parse(source) as unknown); } catch { return { success: false, message: "Generated-character draft contains invalid JSON" }; }
};
export const discardGeneratedCharacterDraft = (storage: Pick<Storage, "removeItem">, projectId?: string): void => {
  if (projectId) storage.removeItem(generatedCharacterDraftKey(projectId));
  storage.removeItem(GENERATED_CHARACTER_ACTIVE_DRAFT_KEY);
  storage.removeItem(GENERATED_CHARACTER_DRAFT_KEY);
};
