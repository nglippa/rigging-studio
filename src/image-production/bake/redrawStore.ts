import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AnimationDefinition, RigDefinition } from "../../rigging/schema/types";

export type RedrawMode = "redraw" | "polish";

/**
 * What a redrawn clip depends on: the rig's bones, slots and art (image data included), the clip's motion, drawings and
 * smears, and the redraw mode. Equal fingerprints mean a stored redraw still matches; any edit makes a new one, so a
 * redraw of an older rig or clip is never shown as current. Names and other metadata are left out.
 */
export function fingerprint(rig: RigDefinition, clip: AnimationDefinition, mode: RedrawMode): string {
  const subject = {
    bones: rig.bones, slots: rig.slots, attachments: rig.attachments,
    clip: { duration: clip.duration, loop: clip.loop, tracks: clip.tracks, drawings: clip.drawings ?? null, smears: clip.smears ?? null },
    mode,
  };
  return createHash("sha256").update(JSON.stringify(subject)).digest("hex");
}

type Records = Record<string, Record<string, { readonly fingerprint: string; readonly jobId: string; readonly at: string }>>;

/**
 * Which bake job holds each project's redrawn clips, in <root>/redraws.json, so Animate and Export share them and
 * nothing is redrawn twice. Writes are serialised within the process and land atomically (write, then rename).
 */
export class RedrawStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) { this.file = path.join(root, "redraws.json"); }

  async record(projectId: string, clipId: string, print: string, jobId: string): Promise<void> {
    const write = this.queue.then(async () => {
      const records = await this.read();
      records[projectId] = { ...records[projectId], [clipId]: { fingerprint: print, jobId, at: new Date().toISOString() } };
      await mkdir(this.root, { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`);
      await rename(temporary, this.file);
    });
    this.queue = write.catch(() => undefined);
    return write;
  }

  async lookup(projectId: string, clipId: string, print: string): Promise<{ readonly jobId: string } | null> {
    await this.queue;
    const entry = (await this.read())[projectId]?.[clipId];
    return entry && entry.fingerprint === print ? { jobId: entry.jobId } : null;
  }

  private async read(): Promise<Records> {
    try { const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown; return parsed && typeof parsed === "object" ? parsed as Records : {}; }
    catch { return {}; }
  }
}
