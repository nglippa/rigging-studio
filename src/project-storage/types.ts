import type { GeneratedCharacterProject } from "../character-generation/project/generatedCharacterProject";
import type { RigDefinition } from "../rigging/schema/types";
import type { AnimationLibrary } from "../tools/rig-editor/animation/types";

export const LOCAL_PROJECT_STORAGE_VERSION = 1 as const;

export type LocalProjectSnapshot = {
  readonly storageVersion: typeof LOCAL_PROJECT_STORAGE_VERSION;
  readonly localProjectId?: string | null;
  readonly project: GeneratedCharacterProject | null;
  readonly rig: RigDefinition | null;
  readonly animations: AnimationLibrary | null;
  readonly selectedSkinId: string | null;
};

export type LocalProjectSummary = {
  readonly storageVersion: typeof LOCAL_PROJECT_STORAGE_VERSION;
  readonly projectId: string;
  readonly name: string;
  readonly slug: string;
  readonly directoryName: string;
  readonly relativePath: string;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly stage: string;
  readonly valid: boolean;
  readonly sourceThumbnail: string | null;
  readonly partCount: number;
  readonly rigPresent: boolean;
  readonly animationCount: number;
  readonly generationProvider: string | null;
};

export type LocalProjectSaveResult = LocalProjectSummary & {
  readonly saved: true;
  readonly diskPath: string;
  readonly backupWritten: boolean;
};

export type ProjectSaveState = "unsaved" | "saving" | "opening" | "validating" | "saved" | "cache-only" | "failed";
export const projectSaveFailureState = (hasDiskProject: boolean): ProjectSaveState => hasDiskProject ? "failed" : "cache-only";
