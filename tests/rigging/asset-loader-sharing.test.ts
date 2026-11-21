import { beforeEach, describe, expect, it, vi } from "vitest";

const unloaded: string[] = [];
vi.mock("pixi.js", () => ({
  Assets: {
    load: vi.fn(async (url: string) => ({ url, source: { scaleMode: "linear", alphaMode: "premultiply-alpha-on-upload" } })),
    unload: vi.fn(async (url: string) => { unloaded.push(url); }),
  },
}));

const { RigAssetLoader } = await import("../../src/rigging/assets/RigAssetLoader");

describe("RigAssetLoader sharing Pixi's texture cache", () => {
  beforeEach(() => { unloaded.length = 0; });

  it("keeps a texture loaded while another loader still uses it", async () => {
    const leaving = new RigAssetLoader("/"); const arriving = new RigAssetLoader("/");
    await leaving.loadPath("parts/arm.png"); await arriving.loadPath("parts/arm.png");
    await leaving.destroy();
    expect(unloaded).toEqual([]);
    await arriving.destroy();
    expect(unloaded).toEqual(["/parts/arm.png"]);
  });

  it("unloads a texture only one loader used", async () => {
    const only = new RigAssetLoader("/");
    await only.loadPath("parts/leg.png"); await only.loadPath("parts/leg.png");
    await only.destroy(); await only.destroy();
    expect(unloaded).toEqual(["/parts/leg.png"]);
  });
});
