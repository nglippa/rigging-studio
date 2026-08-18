import type { RigDefinition } from "../../rigging/schema/types";
import type { AnimationLibrary } from "../../tools/rig-editor/animation/types";
import type { GeneratedCharacterProject } from "../../character-generation/project/generatedCharacterProject";

export interface RigEditorAdapter {
  getRig(): RigDefinition;
  execute(label: string, transform: (rig: RigDefinition) => RigDefinition): RigDefinition;
  beginTransaction(label: string): void;
  updateTransaction(transform: (rig: RigDefinition) => RigDefinition): RigDefinition;
  commitTransaction(): RigDefinition;
  rollbackTransaction(): RigDefinition;
  undo(): RigDefinition;
  redo(): RigDefinition;
  setSelectedBone(boneId: string | null): void;
}

export interface AnimationEditorAdapter {
  getLibrary(): AnimationLibrary;
  getActiveAnimationId(): string | null;
  execute(label: string, transform: (library: AnimationLibrary) => AnimationLibrary): AnimationLibrary;
  setActiveAnimation(animationId: string): void;
  setPlayback(action: "play" | "pause" | "stop" | "seek", time?: number): void;
}

export interface CharacterProjectAdapter {
  getProject(): GeneratedCharacterProject;
  replaceProject(project: GeneratedCharacterProject): void;
}

