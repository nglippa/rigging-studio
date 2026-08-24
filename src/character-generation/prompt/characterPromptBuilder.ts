import { MODULAR_ART_RULES } from "./modularArtRules";
import { NEGATIVE_PROMPT_RULES } from "./negativePromptRules";
import type { CharacterPromptControls, CharacterPromptInput } from "./generationPreset";

const controlLabels: Readonly<Record<keyof CharacterPromptControls, string>> = {
  style: "Art style",
  bodyProportions: "Body proportions",
  viewDirection: "View direction",
  genderPresentation: "Gender presentation",
  species: "Species",
  clothingStyle: "Armor or clothing",
  mainHandEquipment: "Main-hand equipment",
  offHandEquipment: "Off-hand equipment",
  hair: "Hair",
  headwear: "Headwear",
  cape: "Cape",
  tail: "Tail",
  characterScale: "Character scale",
  artResolution: "Target resolution",
  background: "Background",
};

export type BuiltCharacterPrompt = {
  readonly preset: "MODULAR_2D_RIG_CHARACTER";
  readonly prompt: string;
  readonly negativePrompt: string;
};

export function buildCharacterGenerationPrompt(input: CharacterPromptInput): BuiltCharacterPrompt {
  const description = input.description.trim();
  if (!description) throw new Error("A character description is required");
  const controls = Object.entries({
    ...(input.controls ?? {}),
    style: "chibi-pixel-art" as const,
    bodyProportions: "oversized head, compact torso, short separated limbs",
    background: "transparent",
  })
    .filter((entry): entry is [keyof CharacterPromptControls, NonNullable<CharacterPromptControls[keyof CharacterPromptControls]>] => entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => `${controlLabels[key]}: ${value}.`);
  const prompt = [
    "Use case: stylized-concept.",
    "Asset type: production-ready chibi pixel-art game character sprite for skeletal rigging.",
    "Create exactly one original, game-production-ready modular 2D character sprite.",
    `Character brief: ${description}`,
    ...controls,
    "Style lock: chibi pixel art only. Use an oversized head, compact torso, short readable limbs, expressive silhouette, and deliberately simplified game-scale detail.",
    "Pixel craft: crisp hard-edged pixel clusters, limited coherent palette, one consistent pixel density, no anti-aliasing, no painterly softness, no smooth vector edges, and no 3D rendering.",
    "Production readiness: the complete body must remain readable at small gameplay scale; use clean color separation, controlled highlights, and no noisy single-pixel detail.",
    ...MODULAR_ART_RULES,
    "Output one pose only on a genuinely transparent background when supported; otherwise use one flat high-contrast background color for deterministic extraction.",
  ].join("\n");
  return { preset: "MODULAR_2D_RIG_CHARACTER", prompt, negativePrompt: NEGATIVE_PROMPT_RULES.join(", ") };
}
