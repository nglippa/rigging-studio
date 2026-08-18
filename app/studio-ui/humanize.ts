export function humanizeTechnicalId(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b(lower arm|lower-arm)\b/gi, "forearm")
    .trim();
  return spaced.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function semanticGroup(value: string): "head" | "torso" | "left" | "right" | "equipment" | "other" {
  const lower = value.toLowerCase();
  if (/head|face|hair|helmet|beard|neck/.test(lower)) return "head";
  if (/torso|pelvis|root|body|chest/.test(lower)) return "torso";
  if (/equipment|weapon|sword|shield|cape|tail|accessory|armor/.test(lower)) return "equipment";
  if (/left/.test(lower)) return "left";
  if (/right/.test(lower)) return "right";
  return "other";
}
