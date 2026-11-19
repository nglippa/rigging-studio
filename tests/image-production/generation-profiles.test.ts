import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { bindProfile, coerceParam, DEFAULT_PROFILE_ID, findProfile, importProfile, listAllProfiles, listProfiles, profilePrompt, tunableParams } from "../../src/image-production/profiles/ccMediaProfile";
import { removePlainBackground } from "../../src/image-production/profiles/plainBackground";

const builtIn = { studioDir: null, importedDir: "/nonexistent" } as const;

describe("generation profiles (Command Center cc-media-profile/1)", () => {
  it("offers the built-in sprite benchmark winners, best first, and keeps image-input profiles (the cut-out) out of the generator list", async () => {
    const ids = (await listProfiles(builtIn)).map((item) => item.profile.id);
    expect(ids[0]).toBe(DEFAULT_PROFILE_ID);
    expect(ids.slice(0, 4)).toEqual(["klein2-4b-pixel-art", "zimage-pixel-art", "klein2-4b", "qwen-image-2512-pixel-art"]);
    expect(ids).not.toContain("cutout-rmbg2");
    expect((await listAllProfiles(builtIn)).map((item) => item.profile.id)).toContain("cutout-rmbg2");
  });

  it("writes each param into every node input it targets, clamped to its limits and rounded to its step", async () => {
    const { profile } = await findProfile("klein2-4b-pixel-art", builtIn);
    const graph = bindProfile(profile, { prompt: "a goblin", seed: 7, width: 3000, height: 1000, lora_pixel_art: 5 }) as Record<string, { inputs: Record<string, unknown> }>;
    for (const [nodeId, field] of profile.params.width.targets) expect(graph[nodeId].inputs[field]).toBe(2048);
    for (const [nodeId, field] of profile.params.height.targets) expect(graph[nodeId].inputs[field]).toBe(1008); // multiple of 16
    for (const [nodeId, field] of profile.params.lora_pixel_art.targets) expect(graph[nodeId].inputs[field]).toBe(2);
    for (const [nodeId, field] of profile.params.prompt.targets) expect(graph[nodeId].inputs[field]).toBe("a goblin");
    // The profile itself is never changed.
    expect(profile.graph).not.toBe(graph);
    expect(coerceParam(profile.params.lora_walk_cycle, "nonsense")).toBe(0);
    // The settings offered to the user: everything but the prompt.
    expect(tunableParams(profile).map((param) => param.name)).toEqual(["seed", "width", "height", "lora_pixel_art", "lora_walk_cycle"]);
  });

  it("imports a valid profile and refuses anything that cannot generate a character", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "profiles-"));
    const valid = JSON.parse(await readFile(path.join(process.cwd(), "comfy-workflows/profiles/klein2-4b.json"), "utf8"));
    const saved = await importProfile({ ...valid, id: "my-profile", label: "Mine" }, directory);
    expect(saved.id).toBe("my-profile");
    expect((await listProfiles({ studioDir: null, importedDir: directory })).some((item) => item.profile.id === "my-profile" && item.source === "imported")).toBe(true);
    await expect(importProfile({ ...valid, schema: "other/1" }, directory)).rejects.toThrow(/cc-media-profile/);
    const cutout = JSON.parse(await readFile(path.join(process.cwd(), "comfy-workflows/profiles/cutout-rmbg2.json"), "utf8"));
    await expect(importProfile(cutout, directory)).rejects.toThrow(/text-to-image/);
  });

  it("asks image models for a plain white background instead of transparency (which they paint as a checkerboard)", () => {
    const prompt = profilePrompt("Knight. Output one pose only on a genuinely transparent background when supported; otherwise use one flat colour. Clean edges suitable for transparent extraction.");
    expect(prompt).not.toMatch(/transparent/i);
    expect(prompt).toMatch(/plain white background/);
  });
});

describe("plain-background cut-out", () => {
  const image = (draw: (x: number, y: number) => readonly [number, number, number]) => {
    const png = new PNG({ width: 40, height: 40 });
    for (let y = 0; y < 40; y += 1) for (let x = 0; x < 40; x += 1) { const [r, g, b] = draw(x, y); png.data.set([r, g, b, 255], (y * 40 + x) * 4); }
    return PNG.sync.write(png);
  };
  const alphaAt = (bytes: Uint8Array, x: number, y: number) => PNG.sync.read(Buffer.from(bytes)).data[(y * 40 + x) * 4 + 3];

  it("clears the background, large enclosed pockets of it, and keeps the figure and small highlights", () => {
    // A dark ring (figure) with a big white hole in the middle and one white pixel (an eye shine) inside the ring wall.
    const bytes = image((x, y) => {
      const d = Math.hypot(x - 20, y - 20);
      if (x === 20 && y === 8) return [250, 250, 250];
      return d >= 6 && d <= 14 ? [40, 30, 20] : [252, 252, 252];
    });
    const result = removePlainBackground(bytes);
    expect(result.removed).toBe(true);
    expect(alphaAt(result.bytes, 1, 1)).toBe(0);     // background
    expect(alphaAt(result.bytes, 20, 20)).toBe(0);   // enclosed pocket
    expect(alphaAt(result.bytes, 20, 30)).toBe(255); // figure
    expect(alphaAt(result.bytes, 20, 8)).toBe(255);  // eye shine kept
  });

  it("keeps a near-white highlight enclosed by the outline (a sword blade's bevel), unlike a flat background gap", () => {
    // Ring as above; its hole is a light but varied highlight, as generated metal is, not the generator's flat white.
    const bytes = image((x, y) => {
      const d = Math.hypot(x - 20, y - 20);
      if (d < 6) return [238 + ((x * 7 + y * 3) % 12), 240 + ((x * 5 + y) % 10), 236 + ((x + y * 7) % 14)];
      return d <= 14 ? [40, 30, 20] : [254, 254, 254];
    });
    expect(alphaAt(removePlainBackground(bytes).bytes, 20, 20)).toBe(255);
  });

  it("removes the pale halo where the white background met the dark outline", () => {
    // Background, a one-pixel light-grey ring (the anti-aliased edge), then the dark outline.
    const bytes = image((x, y) => {
      const d = Math.hypot(x - 20, y - 20);
      if (d <= 10) return [30, 25, 20];
      return d <= 11.2 ? [205, 205, 205] : [254, 254, 254];
    });
    const result = removePlainBackground(bytes);
    expect(alphaAt(result.bytes, 31, 20)).toBe(0);   // halo pixel just outside the outline
    expect(alphaAt(result.bytes, 30, 20)).toBe(255); // the outline itself
  });

  it("removes a floor shadow under the feet but keeps grey boots inside their outline", () => {
    // A brown body (rows 4-31), a dark-outlined grey boot (rows 32-35, x 14-25) and a flat grey shadow (rows 34-37) wider than it.
    const bytes = image((x, y) => {
      if (y >= 4 && y < 32 && x >= 14 && x < 26) return [110, 70, 40];
      if (y >= 32 && y < 36 && x >= 14 && x < 26) return x === 14 || x === 25 || y === 35 ? [20, 20, 24] : [150, 150, 156];
      if (y >= 34 && y < 38 && x >= 8 && x < 32) return [170, 170, 176];
      return [254, 254, 254];
    });
    const result = removePlainBackground(bytes);
    expect(alphaAt(result.bytes, 10, 36)).toBe(0);   // shadow
    expect(alphaAt(result.bytes, 30, 35)).toBe(0);   // shadow
    expect(alphaAt(result.bytes, 18, 33)).toBe(255); // grey boot inside its outline
    expect(alphaAt(result.bytes, 20, 20)).toBe(255); // body
  });

  it("leaves an image alone when its border is not one plain colour", () => {
    const bytes = image((x, y) => [(x * 37) % 255, (y * 53) % 255, 90]);
    expect(removePlainBackground(bytes).removed).toBe(false);
  });
});
