/** Names a new character from its description: "A small fox rogue in a green cloak, …" becomes "Small Fox Rogue". */
const ARTICLE = /^(a|an|the)\s+/i;
/** Where the subject ends and what it wears, holds or looks like begins. */
const DETAIL = /\s+(in|with|holding|wearing|carrying|and|who|that|on|from|of)\s+/i;

export const DEFAULT_CHARACTER_NAMES: readonly string[] = ["Fantasy Knight", "Untitled Character"];

export function nameFromDescription(description: string): string | null {
  const first = description.trim().split(/[.,;:!?\n]/)[0]?.trim() ?? "";
  const subject = first.replace(ARTICLE, "").split(DETAIL)[0]?.trim() ?? "";
  const words = subject.split(/\s+/).filter((word) => /[a-z]/i.test(word)).slice(0, 4);
  if (!words.length) return null;
  return words.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}
