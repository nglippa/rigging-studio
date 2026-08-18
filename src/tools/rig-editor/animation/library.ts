import { safeParseAnimationDefinition } from "../../../rigging/schema/parsing";
import type { AnimationDefinition, JsonValue, RigDefinition } from "../../../rigging/schema/types";
import type { ValidationResult } from "../../../rigging/validation/issues";
import { ANIMATION_LIBRARY_FORMAT, type AnimationLibrary } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const createAnimationLibrary = (rigId: string, animations: readonly AnimationDefinition[]): AnimationLibrary => ({
  format: ANIMATION_LIBRARY_FORMAT, formatVersion: 1, rigId, animations, metadata: {}, extensions: {},
});

export const animationById = (library: AnimationLibrary, id: string): AnimationDefinition | undefined =>
  library.animations.find((animation) => animation.id === id);

export const replaceAnimation = (library: AnimationLibrary, animation: AnimationDefinition): AnimationLibrary => ({
  ...library,
  animations: library.animations.map((candidate) => candidate.id === animation.id ? animation : candidate),
});

export const uniqueAnimationId = (library: AnimationLibrary, desired: string): string => {
  const base = desired.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "animation";
  if (!library.animations.some((animation) => animation.id === base)) return base;
  let suffix = 2;
  while (library.animations.some((animation) => animation.id === `${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
};

export const addAnimation = (library: AnimationLibrary, name = "New animation"): { library: AnimationLibrary; animationId: string } => {
  const id = uniqueAnimationId(library, name);
  const animation: AnimationDefinition = { schemaVersion: 1, id, name, duration: 1, loop: true, tracks: [] };
  return { library: { ...library, animations: [...library.animations, animation] }, animationId: id };
};

export const duplicateAnimation = (library: AnimationLibrary, sourceId: string): { library: AnimationLibrary; animationId: string } => {
  const source = animationById(library, sourceId);
  if (!source) return { library, animationId: sourceId };
  const id = uniqueAnimationId(library, `${source.id}_copy`);
  const copy: AnimationDefinition = { ...structuredClone(source), id, name: `${source.name} copy` };
  return { library: { ...library, animations: [...library.animations, copy] }, animationId: id };
};

export const deleteAnimation = (library: AnimationLibrary, id: string): AnimationLibrary =>
  library.animations.length <= 1 ? library : { ...library, animations: library.animations.filter((animation) => animation.id !== id) };

export const parseAnimationLibraryJson = (source: string, rig: RigDefinition): ValidationResult<AnimationLibrary> => {
  let input: unknown;
  try { input = JSON.parse(source) as unknown; }
  catch (error: unknown) {
    return { success: false, message: `Animation JSON: ${error instanceof Error ? error.message : "Invalid JSON"}`, issues: [] };
  }
  const single = safeParseAnimationDefinition(input, rig);
  if (single.success) return { success: true, data: createAnimationLibrary(rig.id, [single.data]) };
  if (!isRecord(input) || input.format !== ANIMATION_LIBRARY_FORMAT || input.formatVersion !== 1 || !Array.isArray(input.animations)) {
    return { success: false, message: "Animation file must contain one animation or a Rig Studio animation library", issues: single.issues };
  }
  const parsed: AnimationDefinition[] = [];
  for (const candidate of input.animations) {
    const result = safeParseAnimationDefinition(candidate, rig);
    if (!result.success) return result;
    parsed.push(result.data);
  }
  if (parsed.length === 0) return { success: false, message: "Animation library must contain at least one animation", issues: [] };
  const known = new Set(["format", "formatVersion", "rigId", "animations", "metadata", "extensions"]);
  const extras: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) if (!known.has(key)) extras[key] = value as JsonValue;
  return { success: true, data: {
    format: ANIMATION_LIBRARY_FORMAT,
    formatVersion: 1,
    rigId: typeof input.rigId === "string" ? input.rigId : rig.id,
    animations: parsed,
    metadata: isRecord(input.metadata) ? input.metadata as Record<string, JsonValue> : {},
    extensions: { ...(isRecord(input.extensions) ? input.extensions as Record<string, JsonValue> : {}), ...extras },
  } };
};

export const serializeAnimationLibrary = (library: AnimationLibrary): string => JSON.stringify({
  ...library.extensions,
  format: library.format,
  formatVersion: library.formatVersion,
  rigId: library.rigId,
  animations: library.animations,
  metadata: library.metadata,
  extensions: library.extensions,
}, null, 2);
