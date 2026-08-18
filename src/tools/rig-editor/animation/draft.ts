import type { AnimationLibrary } from "./types";
import { parseAnimationLibraryJson, serializeAnimationLibrary } from "./library";
import type { RigDefinition } from "../../../rigging/schema/types";

export const animationDraftKey = (rigId: string): string => `rig-studio.animation-draft.${rigId}`;

export const saveAnimationDraft = (storage: Pick<Storage, "setItem">, library: AnimationLibrary): void =>
  storage.setItem(animationDraftKey(library.rigId), serializeAnimationLibrary(library));

export const loadAnimationDraft = (storage: Pick<Storage, "getItem">, rig: RigDefinition) => {
  const source = storage.getItem(animationDraftKey(rig.id));
  return source ? parseAnimationLibraryJson(source, rig) : null;
};

export const discardAnimationDraft = (storage: Pick<Storage, "removeItem">, rigId: string): void =>
  storage.removeItem(animationDraftKey(rigId));
