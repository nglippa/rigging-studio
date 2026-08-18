import type { CharacterAppearanceDefinition } from "./types";

export type ResolvedCharacterAnimation = { readonly clipId: string; readonly fellBack: boolean };

export const resolveMappedAnimation = (action: string, appearance: CharacterAppearanceDefinition, loadedClipIds: ReadonlySet<string>): ResolvedCharacterAnimation | null => {
  const requestedId = appearance.animationMapping[action];
  if (requestedId && loadedClipIds.has(requestedId)) return { clipId: requestedId, fellBack: false };
  const assetFallback = requestedId ? appearance.animations[requestedId]?.fallbackClipId : undefined;
  if (assetFallback && loadedClipIds.has(assetFallback)) return { clipId: assetFallback, fellBack: true };
  const defaultId = appearance.animationMapping[appearance.fallbackAnimation];
  if (defaultId && loadedClipIds.has(defaultId)) return { clipId: defaultId, fellBack: true };
  const first = Object.keys(appearance.animations).find((clipId) => loadedClipIds.has(clipId));
  return first ? { clipId: first, fellBack: true } : null;
};
