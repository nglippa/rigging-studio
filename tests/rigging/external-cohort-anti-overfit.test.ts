import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const productionRoots = ["app", "mcp", "src"] as const;
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const forbiddenCohortTokens = [
  "/wand-or-steel",
  "guild-v1",
  "npc-special-beorn.png",
  "shadow-hunter.png",
] as const;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return sourceExtensions.has(path.extname(entry.name)) ? [absolute] : [];
  }));
  return nested.flat();
}

describe("external validation cohort isolation", () => {
  it("keeps Wand or Steel fixture identity out of production code", async () => {
    const files = (await Promise.all(productionRoots.map(sourceFiles))).flat().sort();
    const contents = await Promise.all(files.map(async (file) => ({ file, text: (await readFile(file, "utf8")).toLowerCase() })));

    for (const token of forbiddenCohortTokens) {
      const matches = contents.filter(({ text }) => text.includes(token));
      expect(matches.map(({ file }) => file), token).toEqual([]);
    }
  });
});
