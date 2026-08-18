import { characterAppearanceSaveSchema } from "./appearanceSchema";
import type { CharacterAppearanceSave } from "./types";

export interface CharacterAppearanceStore {
  load(characterId: string): CharacterAppearanceSave | null;
  save(state: CharacterAppearanceSave): void;
  remove(characterId: string): void;
}

export class BrowserCharacterAppearanceStore implements CharacterAppearanceStore {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, private readonly prefix = "rig-studio:game-appearance:") {}
  load(characterId: string): CharacterAppearanceSave | null {
    const source = this.storage.getItem(`${this.prefix}${characterId}`); if (!source) return null;
    try { const result = characterAppearanceSaveSchema.safeParse(JSON.parse(source) as unknown); return result.success && result.data.characterId === characterId ? result.data : null; }
    catch { return null; }
  }
  save(state: CharacterAppearanceSave): void { this.storage.setItem(`${this.prefix}${state.characterId}`, JSON.stringify(state)); }
  remove(characterId: string): void { this.storage.removeItem(`${this.prefix}${characterId}`); }
}
