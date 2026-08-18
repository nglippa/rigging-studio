import type { Easing } from "../schema/types";

export function applyEasing(easing: Easing, progress: number): number {
  const value = Math.min(1, Math.max(0, progress));
  switch (easing) {
    case "linear": return value;
    case "easeIn": return value * value;
    case "easeOut": return 1 - (1 - value) * (1 - value);
    case "easeInOut": return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
    case "stepped": return 0;
  }
}
