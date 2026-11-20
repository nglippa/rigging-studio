/**
 * Bakes a rigged character's clips into a sprite sheet, the asset a game loads frame by frame. Two paths, the user's choice:
 *
 *   "rig"     the drawings exactly as the rig draws them (no Studio time; the same frames the live rig shows).
 *   "polish"  each drawing redrawn by the Studio's image model and made the character's pixel art again (polishDrawing):
 *             reads as hand-drawn, at about 10 s of Studio time a drawing. Runs as one Studio job per clip, under Command
 *             Center's lease like every other Studio job.
 *
 * Output (in .rigging-studio/bakes/<job>/): sheet.png (one row per clip, one cell per drawing, at the art's own resolution)
 * and sheet.json (cells, durations in ms, loop, the pivot the game places at the character's position, the scale to draw).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { evaluateAnimationAtTime } from "../../rigging/animation/evaluate";
import { framesWindow, pixelScaleOf, renderPixelFrame, smearOrigin, type PartPixels } from "../../rigging/export/pixelFrames";
import type { RgbaImage } from "../../rigging/rendering/rotsprite";
import { createRestPose } from "../../rigging/runtime/pose";
import { computeWorldTransforms } from "../../rigging/runtime/worldTransforms";
import type { AnimationDefinition, RigDefinition } from "../../rigging/schema/types";
import { bindProfile, findProfile } from "../profiles/ccMediaProfile";
import type { ImageProductionService } from "../service/ImageProductionService";
import { characterPalette, POLISH_PROMPT, polishInput, snapPolished } from "./polishDrawing";
import { poseJoints, renderPoseSkeleton } from "./poseSkeleton";

export type BakeMode = "rig" | "polish" | "redraw";
export type BakeRequest = { readonly rig: RigDefinition; readonly animations: readonly AnimationDefinition[]; readonly mode: BakeMode; readonly seed?: number; readonly profileId?: string; readonly prompt?: string };
export type BakeJob = {
  readonly jobId: string; readonly mode: BakeMode; readonly status: "queued" | "running" | "completed" | "failed";
  readonly progress: { readonly done: number; readonly total: number; readonly clip: string | null };
  readonly waiting?: string; readonly error?: string; readonly kept?: number;
  readonly result?: { readonly sheet: string; readonly json: string; readonly drawings: number; readonly polished: number; readonly keptFromRig: number };
};

export const POLISH_PROFILE_ID = "klein2-4b-consistency";
/** "redraw": the character drawn afresh in each pose from an OpenPose skeleton of the rig (Klein 4B base + RefControl pose LoRA). */
export const REDRAW_PROFILE_ID = "klein2-4b-base-pose";
const REDRAW_PROMPT = "apply pose from image 1 with reference from image 2";
const decode = (bytes: Buffer): RgbaImage => { const png = PNG.sync.read(bytes); return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) }; };

/** The smear pixels of a drawing (in `smeared` but not in the clean `plain`) laid over its polished version. */
function withSmear(polished: RgbaImage, smeared: RgbaImage, plain: RgbaImage): RgbaImage {
  if (smeared === plain) return polished;
  const data = new Uint8ClampedArray(polished.data);
  for (let i = 0; i < data.length; i += 4) {
    const added = smeared.data[i + 3] >= 128 && (plain.data[i + 3] < 128 || smeared.data[i] !== plain.data[i] || smeared.data[i + 1] !== plain.data[i + 1] || smeared.data[i + 2] !== plain.data[i + 2]);
    if (added && polished.data[i + 3] < 128) data.set(smeared.data.subarray(i, i + 4), i);
  }
  return { width: polished.width, height: polished.height, data };
}

/**
 * The pose redraw on the distilled Klein 4B at 4 steps without CFG, as the pose LoRA's own card runs it, instead of the
 * profile's base model at 28 steps with CFG 4 (two passes a step): about 5 minutes a drawing becomes well under one.
 */
function fastRedraw(graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>): void {
  for (const node of Object.values(graph)) {
    if (node.class_type === "UNETLoader" && node.inputs.unet_name === "flux-2-klein-base-4b.safetensors") node.inputs.unet_name = "flux-2-klein-4b.safetensors";
    if (node.class_type === "Flux2Scheduler") node.inputs.steps = 4;
    if (node.class_type === "CFGGuider") node.inputs.cfg = 1;
  }
}

/** When each clip is drawn: its drawing chart, or 12 drawings a second for a clip without one (one made by hand). */
const drawingTimes = (clip: AnimationDefinition): number[] => clip.drawings?.length ? [...clip.drawings] : Array.from({ length: Math.max(1, Math.round(clip.duration * 12)) }, (_, index) => index / 12);

export class BakeService {
  private readonly jobs = new Map<string, BakeJob>();
  constructor(private readonly production: ImageProductionService, private readonly root = path.join(process.cwd(), ".rigging-studio", "bakes")) {}

  start(request: BakeRequest): BakeJob {
    if (!request.animations.length) throw new Error("Choose at least one animation to bake");
    const job: BakeJob = { jobId: `bake-${crypto.randomUUID()}`, mode: request.mode, status: "queued", progress: { done: 0, total: request.animations.reduce((sum, clip) => sum + drawingTimes(clip).length, 0), clip: null } };
    this.jobs.set(job.jobId, job);
    void this.run(job.jobId, request).catch((error: unknown) => this.update(job.jobId, { status: "failed", error: error instanceof Error ? error.message : String(error) }));
    return job;
  }

  get(jobId: string): BakeJob { const job = this.jobs.get(jobId); if (!job) throw new Error(`Bake ${jobId} does not exist`); return job; }

  async asset(jobId: string, file: string): Promise<Buffer> {
    if (!/^bake-[0-9a-f-]+$/.test(jobId) || !/^sheet\.(png|json)$/.test(file)) throw new Error("Unknown bake asset");
    return readFile(path.join(this.root, jobId, file));
  }

  private update(jobId: string, patch: Partial<BakeJob>): void { const job = this.get(jobId); this.jobs.set(jobId, { ...job, ...patch }); }

  private async run(jobId: string, request: BakeRequest): Promise<void> {
    const { rig } = request; const k = pixelScaleOf(rig);
    const pixels: Record<string, RgbaImage> = {};
    for (const attachment of rig.attachments) { const match = /^data:image\/png;base64,([^#]+)/.exec(attachment.imagePath); if (match) pixels[attachment.id] = decode(Buffer.from(match[1], "base64")); }
    if (!Object.keys(pixels).length) throw new Error("The rig's part images could not be read");
    const palette = characterPalette(Object.values(pixels));
    // One cell size for every drawing: the figure at rest with room to swing (half its size on every side).
    const canvas = { x: 0, y: 0, width: rig.canvas?.width ?? 256, height: rig.canvas?.height ?? 256 };
    const rest = renderPixelFrame(rig, createRestPose(rig), pixels as PartPixels, canvas);
    const figure = framesWindow([rest], { x: 0, y: 0, width: rest.width, height: rest.height }, 0);
    const window = { x: (figure.x - Math.round(figure.width / 2)) * k, y: (figure.y - Math.round(figure.height / 2)) * k, width: figure.width * 2 * k, height: figure.height * 2 * k };
    const rootId = rig.rootBoneId; const rootWorld = computeWorldTransforms(rig, createRestPose(rig))[rootId];
    const pivot = { x: Math.round((rootWorld?.x ?? 0) / k - window.x / k), y: Math.round((rootWorld?.y ?? 0) / k - window.y / k) };
    const cache = new Map<string, { image: RgbaImage; pivot: { x: number; y: number } }>();
    const profile = request.mode === "rig" ? null : (await findProfile(request.profileId ?? (request.mode === "redraw" ? REDRAW_PROFILE_ID : POLISH_PROFILE_ID))).profile;
    const redraw = request.mode === "redraw";
    // The reference for a redraw is the rig's own drawing of that pose (uploaded per drawing as `name`): the rest art alone
    // does not say where a held sword is, and the skeleton carries only the body, so the model dropped weapons.
    // The rest art is still uploaded as a fallback reference for profiles that want one.
    let referenceName: string | null = null;
    if (redraw) {
      const restDrawing = renderPixelFrame(rig, createRestPose(rig), pixels as PartPixels, window, cache);
      referenceName = await this.production.studio.run("Upload the reference", () => this.production.provider.uploadImage!(`rigging-redraw-${jobId}-reference.png`, polishInput(restDrawing, k).png, "image/png"));
    }
    const seed = request.seed ?? 20261119;
    const rows: { readonly clip: AnimationDefinition; readonly frames: RgbaImage[]; readonly durations: number[] }[] = [];
    let done = 0; let polished = 0; let kept = 0;
    this.update(jobId, { status: "running" });
    for (const clip of request.animations) {
      this.update(jobId, { progress: { done, total: this.get(jobId).progress.total, clip: clip.name } });
      const base = createRestPose(rig); const times = drawingTimes(clip);
      const smeared = times.map((time) => renderPixelFrame(rig, evaluateAnimationAtTime(clip, base, time), pixels as PartPixels, window, cache, smearOrigin(clip, base, time)));
      // The model would erase a smear as a mistake, so it redraws the figure without it and the smear is laid back on after.
      const drawings = profile ? times.map((time, index) => smearOrigin(clip, base, time) ? renderPixelFrame(rig, evaluateAnimationAtTime(clip, base, time), pixels as PartPixels, window, cache) : smeared[index]) : smeared;
      const durations = times.map((time, index) => Math.round(((index + 1 < times.length ? times[index + 1] : clip.duration) - time) * 1000));
      let frames = drawings;
      if (profile) {
        frames = await this.production.studio.run(`Polish ${clip.name}`, async () => {
          const out: RgbaImage[] = []; this.update(jobId, { waiting: undefined });
          for (const drawing of drawings) {
            const input = polishInput(drawing, k);
            const name = await this.production.provider.uploadImage!(`rigging-polish-${jobId}-${clip.id}-${out.length}.png`, input.png, "image/png");
            // The result is only sampled down to the art grid, so the model needs a few pixels per art pixel, not the full
            // enlarged size: a redraw (28 steps, two references) is about 5 minutes at 2 megapixels and far less at 0.6.
            const megapixels = redraw ? .6 : Math.min(2, Math.max(.25, Math.round((input.crop.width * k * input.crop.height * k) / 1048576 * 1000) / 1000));
            const values = redraw
              ? { prompt: request.prompt ?? REDRAW_PROMPT, seed, megapixels, image2: name, image: await this.production.provider.uploadImage!(`rigging-redraw-${jobId}-${clip.id}-${out.length}-pose.png`, renderPoseSkeleton(poseJoints(rig, evaluateAnimationAtTime(clip, base, times[out.length])), input.crop.width * k, input.crop.height * k, { x: window.x + input.crop.x * k, y: window.y + input.crop.y * k }, 1), "image/png") }
              : { prompt: request.prompt ?? POLISH_PROMPT, seed, image: name, megapixels };
            const graph = bindProfile(profile, values);
            if (redraw) fastRedraw(graph as unknown as Record<string, { class_type: string; inputs: Record<string, unknown> }>);
            const submitted = await this.production.provider.submit(graph);
            const result = await this.production.provider.waitForCompletion(submitted.promptId, profile.output.node);
            const output = result.outputs[0];
            // Each finished drawing is kept as it lands, so a long bake can be checked while it runs.
            if (output) { await mkdir(path.join(this.root, jobId, "drawings"), { recursive: true }); await writeFile(path.join(this.root, jobId, "drawings", `${clip.id}-${out.length}.png`), output.bytes); }
            // A redraw is a new drawing of the pose, so it may differ more from the rig's drawing than a polish.
            const outcome = output ? snapPolished(output.bytes, input.crop, drawing, palette, redraw ? .6 : .8) : { image: drawing, accepted: false };
            if (outcome.accepted) polished += 1; else kept += 1;
            out.push(withSmear(outcome.image, smeared[out.length], drawing)); done += 1;
            this.update(jobId, { progress: { done, total: this.get(jobId).progress.total, clip: clip.name }, kept });
          }
          return out;
        }, (waiting) => this.update(jobId, { waiting }));
        this.update(jobId, { waiting: undefined });
      } else done += drawings.length;
      rows.push({ clip, frames, durations });
    }
    // Cells trimmed to the area any drawing uses (plus a pixel), the same for every drawing so the pivot holds still.
    let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1;
    for (const row of rows) for (const frame of row.frames) for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) if (frame.data[(y * frame.width + x) * 4 + 3] >= 128) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    if (maxX >= 0) {
      const trim = { x: Math.max(0, minX - 1), y: Math.max(0, minY - 1), width: Math.min(rows[0].frames[0].width, maxX + 2) - Math.max(0, minX - 1), height: Math.min(rows[0].frames[0].height, maxY + 2) - Math.max(0, minY - 1) };
      for (const row of rows) row.frames.forEach((frame, index) => {
        const data = new Uint8ClampedArray(trim.width * trim.height * 4);
        for (let y = 0; y < trim.height; y += 1) data.set(frame.data.subarray(((trim.y + y) * frame.width + trim.x) * 4, ((trim.y + y) * frame.width + trim.x + trim.width) * 4), y * trim.width * 4);
        row.frames[index] = { width: trim.width, height: trim.height, data };
      });
      pivot.x -= trim.x; pivot.y -= trim.y;
    }
    // The sheet: one row per clip, one cell per drawing, all cells the same size.
    const cellWidth = rows[0].frames[0].width; const cellHeight = rows[0].frames[0].height;
    const columns = Math.max(...rows.map((row) => row.frames.length));
    const sheet = new PNG({ width: cellWidth * columns, height: cellHeight * rows.length });
    const clips = rows.map((row, rowIndex) => ({
      id: row.clip.id, name: row.clip.name, loop: row.clip.loop,
      frames: row.frames.map((frame, column) => {
        for (let y = 0; y < frame.height; y += 1) sheet.data.set(frame.data.subarray(y * frame.width * 4, (y + 1) * frame.width * 4), ((rowIndex * cellHeight + y) * sheet.width + column * cellWidth) * 4);
        return { x: column * cellWidth, y: rowIndex * cellHeight, w: cellWidth, h: cellHeight, durationMs: row.durations[column] };
      }),
    }));
    const directory = path.join(this.root, jobId); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "sheet.png"), PNG.sync.write(sheet));
    const json = { format: "rigging-studio-sheet/1", character: rig.metadata?.name ?? rig.id, mode: request.mode, pixelScale: k, cell: { w: cellWidth, h: cellHeight }, pivot, clips };
    await writeFile(path.join(directory, "sheet.json"), `${JSON.stringify(json, null, 2)}\n`);
    this.update(jobId, { status: "completed", progress: { done, total: done, clip: null }, result: { sheet: `/bake/assets/${jobId}/sheet.png`, json: `/bake/assets/${jobId}/sheet.json`, drawings: done, polished, keptFromRig: kept } });
  }
}
