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
  const controls = Object.entries(input.controls ?? {})
    .filter((entry): entry is [keyof CharacterPromptControls, NonNullable<CharacterPromptControls[keyof CharacterPromptControls]>] => entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => `${controlLabels[key]}: ${value}.`);
  const prompt = [
    "Create production-ready modular 2D character source art.",
    `Character brief: ${description}`,
    ...controls,
    ...MODULAR_ART_RULES,
    "Use a transparent background when supported; otherwise use one flat, high-contrast background color.",
  ].join("\n");
  return { preset: "MODULAR_2D_RIG_CHARACTER", prompt, negativePrompt: NEGATIVE_PROMPT_RULES.join(", ") };
}
