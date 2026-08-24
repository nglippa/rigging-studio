export type BodyMajor = "head" | "torso" | "arms" | "legs" | "other";

export function semanticBodyPath(id: string): { readonly major: BodyMajor; readonly side?: "left" | "right" } {
  const value = id.toLowerCase();
  if (/head|neck|face|hair/.test(value)) return { major: "head" };
  if (/arm|hand|wrist|elbow|shoulder/.test(value)) return { major: "arms", side: /(^|[-_])l(eft)?([-_]|$)/.test(value) ? "left" : "right" };
  if (/leg|foot|ankle|knee|thigh/.test(value)) return { major: "legs", side: /(^|[-_])l(eft)?([-_]|$)/.test(value) ? "left" : "right" };
  if (/root|torso|chest|spine|waist|hip|pelvis/.test(value)) return { major: "torso" };
  return { major: "other" };
}
