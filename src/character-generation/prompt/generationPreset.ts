export const CHARACTER_GENERATION_PRESETS = ["MODULAR_2D_RIG_CHARACTER"] as const;
export type CharacterGenerationPreset = (typeof CHARACTER_GENERATION_PRESETS)[number];

export const CHARACTER_STYLES = ["chibi-pixel-art"] as const;
export const VIEW_DIRECTIONS = ["left", "right"] as const;

export type CharacterPromptControls = {
  readonly style?: (typeof CHARACTER_STYLES)[number];
  readonly bodyProportions?: string;
  readonly viewDirection?: (typeof VIEW_DIRECTIONS)[number];
  readonly genderPresentation?: string;
  readonly species?: string;
  readonly clothingStyle?: string;
  readonly mainHandEquipment?: string;
  readonly offHandEquipment?: string;
  readonly hair?: string;
  readonly headwear?: string;
  readonly cape?: string;
  readonly tail?: string;
  readonly characterScale?: "small" | "medium" | "large";
  readonly artResolution?: "256" | "512" | "1024";
  readonly background?: "transparent" | "flat-contrast";
};

export type CharacterPromptInput = {
  readonly description: string;
  readonly preset?: CharacterGenerationPreset;
  readonly controls?: CharacterPromptControls;
};
