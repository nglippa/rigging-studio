import type { Point, Rect } from "../../src/character-generation/segmentation/segmentationSchema";
import type { PartSemanticType } from "../../src/part-cutter";

export type ArbitrationCohortEntry = { readonly key: string; readonly name: string; readonly file: string; readonly challenge: string; readonly equipment: readonly Rect[] };
export type ArbitrationTarget = { readonly characterKey: string; readonly semantic: PartSemanticType; readonly negativeControl: false };
export const WOS_ROOT = "/Users/nicholaslippa/wand-or-steel";
export const WOS_ACTORS = `${WOS_ROOT}/public/assets/active/actors/guild-v1`;
export const cohort: readonly ArbitrationCohortEntry[] = [
  { key: "warrior", name: "Guild Warrior", file: "warrior.png", challenge: "shield overlap and weapon", equipment: [{ x: 4, y: 7, width: 10, height: 36 }, { x: 36, y: 23, width: 11, height: 19 }] },
  { key: "starweaver", name: "Guild Starweaver", file: "starweaver.png", challenge: "robe merges lower body", equipment: [{ x: 4, y: 6, width: 10, height: 40 }] },
  { key: "paladin", name: "Guild Paladin", file: "paladin.png", challenge: "shield hides forearm", equipment: [{ x: 4, y: 7, width: 10, height: 38 }, { x: 35, y: 22, width: 12, height: 21 }] },
  { key: "rogue", name: "Guild Rogue", file: "rogue.png", challenge: "crossed dual weapons", equipment: [{ x: 5, y: 22, width: 10, height: 22 }, { x: 36, y: 22, width: 11, height: 22 }] },
  { key: "doomsmith", name: "Guild Doomsmith", file: "doomsmith.png", challenge: "broad armor, beard, apron", equipment: [{ x: 2, y: 8, width: 13, height: 38 }] },
  { key: "dwarf", name: "Guild Broad Dwarf", file: "dwarf.png", challenge: "squat proportions and beard", equipment: [{ x: 3, y: 9, width: 12, height: 36 }] },
  { key: "warden", name: "Guild Warden", file: "warden.png", challenge: "large silhouette and staff", equipment: [{ x: 3, y: 7, width: 12, height: 39 }] },
  { key: "npc-special-beorn", name: "Guild Beorn", file: "npc-special-beorn.png", challenge: "fur mass obscures seams", equipment: [] },
  { key: "numenorian", name: "Guild Numenorian", file: "numenorian.png", challenge: "long bow over body", equipment: [{ x: 3, y: 5, width: 13, height: 41 }] },
  { key: "shadow-hunter", name: "Guild Shadow Hunter", file: "shadow-hunter.png", challenge: "dark cape and weapon overlap", equipment: [{ x: 4, y: 9, width: 12, height: 35 }] },
];

export const bodyZones: readonly { readonly semantic: PartSemanticType; readonly rect: Rect; readonly pivot: Point }[] = [
  { semantic: "rightHand", rect: { x: 10, y: 28, width: 9, height: 7 }, pivot: { x: 17, y: 30 } }, { semantic: "leftHand", rect: { x: 29, y: 28, width: 10, height: 7 }, pivot: { x: 31, y: 30 } },
  { semantic: "rightForearm", rect: { x: 11, y: 23, width: 8, height: 8 }, pivot: { x: 17, y: 24 } }, { semantic: "leftForearm", rect: { x: 29, y: 23, width: 9, height: 8 }, pivot: { x: 31, y: 24 } },
  { semantic: "rightUpperArm", rect: { x: 12, y: 16, width: 8, height: 10 }, pivot: { x: 18, y: 19 } }, { semantic: "leftUpperArm", rect: { x: 28, y: 16, width: 8, height: 10 }, pivot: { x: 30, y: 19 } },
  { semantic: "rightFoot", rect: { x: 14, y: 42, width: 11, height: 6 }, pivot: { x: 21, y: 43 } }, { semantic: "leftFoot", rect: { x: 24, y: 42, width: 11, height: 6 }, pivot: { x: 27, y: 43 } },
  { semantic: "rightLowerLeg", rect: { x: 16, y: 37, width: 9, height: 7 }, pivot: { x: 21, y: 38 } }, { semantic: "leftLowerLeg", rect: { x: 24, y: 37, width: 9, height: 7 }, pivot: { x: 27, y: 38 } },
  { semantic: "rightThigh", rect: { x: 17, y: 31, width: 8, height: 8 }, pivot: { x: 21, y: 33 } }, { semantic: "leftThigh", rect: { x: 24, y: 31, width: 8, height: 8 }, pivot: { x: 27, y: 33 } },
  { semantic: "head", rect: { x: 15, y: 1, width: 19, height: 19 }, pivot: { x: 24, y: 18 } }, { semantic: "torso", rect: { x: 16, y: 16, width: 18, height: 19 }, pivot: { x: 24, y: 23 } },
];

export const targets: readonly ArbitrationTarget[] = [
  { characterKey: "warrior", semantic: "leftForearm", negativeControl: false }, { characterKey: "warrior", semantic: "rightHand", negativeControl: false },
  { characterKey: "starweaver", semantic: "leftLowerLeg", negativeControl: false }, { characterKey: "starweaver", semantic: "torso", negativeControl: false },
  { characterKey: "paladin", semantic: "leftForearm", negativeControl: false }, { characterKey: "paladin", semantic: "head", negativeControl: false },
  { characterKey: "rogue", semantic: "leftHand", negativeControl: false }, { characterKey: "rogue", semantic: "rightForearm", negativeControl: false },
  { characterKey: "doomsmith", semantic: "torso", negativeControl: false }, { characterKey: "doomsmith", semantic: "leftThigh", negativeControl: false },
  { characterKey: "dwarf", semantic: "head", negativeControl: false }, { characterKey: "dwarf", semantic: "rightLowerLeg", negativeControl: false },
  { characterKey: "warden", semantic: "leftUpperArm", negativeControl: false }, { characterKey: "warden", semantic: "rightFoot", negativeControl: false },
  { characterKey: "npc-special-beorn", semantic: "rightUpperArm", negativeControl: false }, { characterKey: "npc-special-beorn", semantic: "leftLowerLeg", negativeControl: false },
  { characterKey: "numenorian", semantic: "rightForearm", negativeControl: false }, { characterKey: "numenorian", semantic: "leftHand", negativeControl: false },
  { characterKey: "shadow-hunter", semantic: "leftUpperArm", negativeControl: false }, { characterKey: "shadow-hunter", semantic: "rightThigh", negativeControl: false },
];

export const inRect = (x: number, y: number, rect: Rect): boolean => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
export const anchorsFor = (semantic: PartSemanticType): readonly Point[] => { const zone = bodyZones.find((entry) => entry.semantic === semantic); if (!zone) throw new Error(`No core-anatomy zone for ${semantic}`); const center = { x: zone.rect.x + (zone.rect.width - 1) / 2, y: zone.rect.y + (zone.rect.height - 1) / 2 }; return [zone.pivot, center.x === zone.pivot.x && center.y === zone.pivot.y ? { x: center.x, y: Math.max(zone.rect.y, center.y - 2) } : center]; };
