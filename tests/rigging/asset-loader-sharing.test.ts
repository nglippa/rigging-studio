import { beforeEach, describe, expect, it, vi } from "vitest";

const unloaded: string[] = [];
const events: string[] = [];
let unloadDelay = 0;
vi.mock("pixi.js", () => ({
  Assets: {
    load: vi.fn(async (url: string) => { events.push(`load ${url}`); return { url, source: { scaleMode: "linear", alphaMode: "premultiply-alpha-on-upload" } }; }),
    unload: vi.fn(async (url: string) => { events.push(`unload start ${url}`); if (unloadDelay) await new Promise((resolve) => setTimeout(resolve, unloadDelay)); unloaded.push(url); events.push(`unload done ${url}`); }),
  },
}));

const { RigAssetLoader } = await import("../../src/rigging/assets/RigAssetLoader");

describe("RigAssetLoader sharing Pixi's texture cache", () => {
  beforeEach(() => { unloaded.length = 0; events.length = 0; unloadDelay = 0; });

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

  it("waits for a texture still being unloaded before loading it again, so the new viewport never gets the dying one", async () => {
    unloadDelay = 30;
    const leaving = new RigAssetLoader("/");
    await leaving.loadPath("parts/head.png");
    const unloading = leaving.destroy();
    const arriving = new RigAssetLoader("/");
    const result = await arriving.loadPath("parts/head.png");
    await unloading;
    expect(result.success).toBe(true);
    expect(events).toEqual(["load /parts/head.png", "unload start /parts/head.png", "unload done /parts/head.png", "load /parts/head.png"]);
  });
});
