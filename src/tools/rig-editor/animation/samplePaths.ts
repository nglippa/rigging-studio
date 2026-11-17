import type { AnimationDefinition } from "../../../rigging/schema/types";
import type { AnimationLibrary } from "./types";

export const SAMPLE_ANIMATION_PATHS = ["idle", "walk", "run", "melee_attack", "hurt", "death"].map((id) => `/rig-test/animations/${id}.json`);
/** The rig the bundled sample clips were authored for. Their angles are only meaningful on that rig. */
export const SAMPLE_RIG_ID = "rig-lab-knight";

const fingerprint = (clip: AnimationDefinition): string => {
  let hash = 5381;
  const source = JSON.stringify(clip);
  for (let index = 0; index < source.length; index += 1) hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  return `${source.length}:${hash}`;
};
const STANDARD_KEY = "standardClipFingerprints";

/**
 * Brings a library's standard clips up to date with the rig. A clip is replaced only while nobody has edited it:
 * it is still exactly a bundled knight sample, or exactly what was last built for this rig (recorded by fingerprint,
 * so the clips follow the rig when a joint moves). Clips the user has changed are left exactly as they are.
 * Standard clips the library lacks are added.
 */
export function refreshStandardClips(library: AnimationLibrary, samples: readonly AnimationDefinition[], standard: readonly AnimationDefinition[]): AnimationLibrary {
  const sampleById = new Map(samples.map((sample) => [sample.id, fingerprint(sample)]));
  const standardById = new Map(standard.map((clip) => [clip.id, clip]));
  const recorded = library.metadata[STANDARD_KEY];
  const built: Record<string, string> = recorded && typeof recorded === "object" && !Array.isArray(recorded) ? Object.fromEntries(Object.entries(recorded).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  const hadRecord = Object.keys(built).length > 0;
  const next: Record<string, string> = {};
  const animations = library.animations.map((animation) => {
    const replacement = standardById.get(animation.id);
    if (!replacement) return animation;
    const current = fingerprint(animation);
    next[animation.id] = fingerprint(replacement);
    if (current !== sampleById.get(animation.id) && current !== built[animation.id] && current !== next[animation.id]) return animation;
    return replacement;
  });
  // A library that predates per-rig clips gets the whole set; later, a clip the user deleted stays deleted.
  const missing = standard.filter((clip) => !animations.some((animation) => animation.id === clip.id) && (!hadRecord || !(clip.id in built)));
  for (const clip of missing) next[clip.id] = fingerprint(clip);
  for (const clip of standard) if (!(clip.id in next)) next[clip.id] = built[clip.id];
  return { ...library, animations: [...animations, ...missing], metadata: { ...library.metadata, [STANDARD_KEY]: next } };
}
