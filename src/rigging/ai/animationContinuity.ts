import type { AnimationDefinition } from "../schema/types";

const PRESET_IDS = ["walk", "run", "idle", "melee", "ranged", "cast", "hurt", "death", "celebrate", "interact"] as const;

export const animationPresetId = (animation: Pick<AnimationDefinition, "id" | "name">): string => {
  const source = `${animation.id} ${animation.name}`.toLowerCase();
  return PRESET_IDS.find((preset) => source.includes(preset)) ?? "walk";
};

export const visualReviewGoal = (animation: Pick<AnimationDefinition, "name">): string => `Review ${animation.name} for readable posing, clean attachments, stable contacts, and convincing weight.`;
