import type { AnimationLibrary } from "./types";

function freezeDeep(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  Object.freeze(value);
}

export function immutableAnimationLibrary(library: AnimationLibrary): AnimationLibrary {
  const snapshot = structuredClone(library);
  freezeDeep(snapshot);
  return snapshot;
}

export const animationLibrariesEqual = (left: AnimationLibrary, right: AnimationLibrary): boolean => JSON.stringify(left) === JSON.stringify(right);
