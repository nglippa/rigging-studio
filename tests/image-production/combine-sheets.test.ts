import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { BakeService } from "../../src/image-production/bake/BakeService";
import type { ImageProductionService } from "../../src/image-production/service/ImageProductionService";

type Frame = { x: number; y: number; w: number; h: number; durationMs: number };
const pixel = (png: PNG, x: number, y: number): number[] => { const at = (y * png.width + x) * 4; return [...png.data.subarray(at, at + 4)]; };

/** A one-clip sheet: `count` cells of w×h, each filled with its own colour, with the pivot where the bake put it. */
async function sheet(root: string, jobId: string, clipId: string, cell: { w: number; h: number }, pivot: { x: number; y: number }, count: number, tint: number): Promise<void> {
  const png = new PNG({ width: cell.w * count, height: cell.h });
  for (let i = 0; i < count; i += 1) for (let y = 0; y < cell.h; y += 1) for (let x = 0; x < cell.w; x += 1) { const at = (y * png.width + i * cell.w + x) * 4; png.data.set([tint, i * 40, (x + y) % 256, 255], at); }
  const frames: Frame[] = Array.from({ length: count }, (_, i) => ({ x: i * cell.w, y: 0, w: cell.w, h: cell.h, durationMs: 100 + i }));
  await mkdir(path.join(root, jobId), { recursive: true });
  await writeFile(path.join(root, jobId, "sheet.png"), PNG.sync.write(png));
  await writeFile(path.join(root, jobId, "sheet.json"), JSON.stringify({ format: "rigging-studio-sheet/1", character: "Test", mode: "redraw", pixelScale: 1, cell, pivot, clips: [{ id: clipId, name: clipId, loop: true, frames }] }));
}

describe("combining redrawn sheets", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("gives one sheet with every clip, each frame's pixels unchanged and every pivot in the same place", async () => {
    root = await mkdtemp(path.join(tmpdir(), "combine-"));
    const a = "bake-00000000-0000-0000-0000-00000000000a"; const b = "bake-00000000-0000-0000-0000-00000000000b";
    await sheet(root, a, "idle", { w: 10, h: 12 }, { x: 5, y: 12 }, 2, 200);
    await sheet(root, b, "walk", { w: 14, h: 9 }, { x: 4, y: 10 }, 3, 90);
    const bake = new BakeService({} as ImageProductionService, root);
    const job = await bake.combine([a, b], ["idle", "walk"]);
    expect(job.status).toBe("completed");
    const json = JSON.parse((await bake.asset(job.jobId, "sheet.json")).toString()) as { cell: { w: number; h: number }; pivot: { x: number; y: number }; clips: { id: string; frames: Frame[] }[] };
    const out = PNG.sync.read(await bake.asset(job.jobId, "sheet.png"));
    expect(json.clips.map((clip) => clip.id)).toEqual(["idle", "walk"]);
    expect(json.clips[1].frames.map((frame) => frame.durationMs)).toEqual([100, 101, 102]);
    // Every frame is one whole combined cell, so the single pivot holds for all of them.
    for (const clip of json.clips) for (const frame of clip.frames) expect([frame.w, frame.h]).toEqual([json.cell.w, json.cell.h]);
    for (const [jobId, clipIndex, cell, pivot] of [[a, 0, { w: 10, h: 12 }, { x: 5, y: 12 }], [b, 1, { w: 14, h: 9 }, { x: 4, y: 10 }]] as const) {
      const source = PNG.sync.read(await readFile(path.join(root, jobId, "sheet.png")));
      json.clips[clipIndex].frames.forEach((frame, index) => {
        // The source cell sits in the combined cell so its pivot lands on the combined pivot.
        const offset = { x: json.pivot.x - pivot.x, y: json.pivot.y - pivot.y };
        for (const [x, y] of [[0, 0], [cell.w - 1, cell.h - 1], [3, 4]] as const) expect(pixel(out, frame.x + offset.x + x, frame.y + offset.y + y)).toEqual(pixel(source, index * cell.w + x, y));
      });
    }
  });

  it("refuses a clip none of the jobs holds", async () => {
    root = await mkdtemp(path.join(tmpdir(), "combine-"));
    const a = "bake-00000000-0000-0000-0000-00000000000a";
    await sheet(root, a, "idle", { w: 4, h: 4 }, { x: 2, y: 4 }, 1, 10);
    await expect(new BakeService({} as ImageProductionService, root).combine([a], ["idle", "run"])).rejects.toThrow(/run/);
  });
});
