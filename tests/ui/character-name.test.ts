import { describe, expect, it } from "vitest";
import { nameFromDescription } from "../../src/character-generation/project/characterName";

describe("naming a character from its description", () => {
  it("takes the subject, not what it wears or holds", () => {
    expect(nameFromDescription("A small fox rogue in a green hooded cloak and brown leather vest, holding a short dagger.")).toBe("Small Fox Rogue");
    expect(nameFromDescription("A green goblin warrior with a spiked wooden club.")).toBe("Green Goblin Warrior");
    expect(nameFromDescription("the stout dwarf, horned helmet")).toBe("Stout Dwarf");
  });
  it("keeps at most four words and gives nothing for an empty description", () => {
    expect(nameFromDescription("Very tall old wise grey wizard")).toBe("Very Tall Old Wise");
    expect(nameFromDescription("   ")).toBeNull();
  });
});
