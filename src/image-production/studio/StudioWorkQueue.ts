/**
 * Every job Rigging Studio runs on the Mac Studio's ComfyUI goes through this queue, following Command Center's rules for
 * the Studio's memory (basic-qwen-bonsai/tools/research/studio_3d.py, publishing_media.py):
 *
 *   1. Jobs run one at a time, in order. A job that cannot start yet waits (and says why); it does not fail.
 *   2. Before the engine loads, Command Center's exclusive heavy-model lease is taken without blocking, and the Studio
 *      media service must report no busy job, no resident Ollama model and no critical memory pressure. If either check
 *      refuses, the lease is given straight back so Command Center is never held up by a job that is only waiting.
 *   3. The engine is started for the work and nothing earlier: no model is loaded just because the app is open.
 *   4. When the queue is empty for a short grace period (so "Cut all parts" loads once, not once per part), the engine is
 *      stopped, the stop confirmed, and only then is the lease released.
 */

/** Command Center's heavy-model lease: a non-blocking exclusive lock. */
export type StudioLease = {
  /** True when now held, false when someone else holds it. */
  readonly tryAcquire: () => Promise<boolean>;
  readonly release: () => Promise<void>;
};

export type StudioWorkQueueOptions = {
  readonly lease: StudioLease | null;
  /** Null when the Studio may take work, otherwise why not (busy job, resident Ollama model, memory pressure). */
  readonly admit: () => Promise<string | null>;
  /** Loads the engine and resolves once it answers. */
  readonly start: () => Promise<void>;
  /** Unloads the engine and resolves once it is confirmed stopped (throws when that cannot be confirmed). */
  readonly stop: () => Promise<void>;
  readonly graceMs?: number;
  readonly pollMs?: number;
  /** The longest a job waits for the Studio before it is refused. */
  readonly maxWaitMs?: number;
  readonly log?: (message: string) => void;
};

export type StudioQueueState = {
  readonly engine: "stopped" | "starting" | "running" | "stopping";
  readonly leaseHeld: boolean;
  readonly running: string | null;
  readonly waiting: string | null;
  readonly queued: number;
  readonly lastStopError: string | null;
};

const LEASE_BUSY = "Command Center is using the Mac Studio (it holds the heavy-model lease); waiting for it to finish";

export class StudioWorkQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private engine: StudioQueueState["engine"] = "stopped";
  private leaseHeld = false;
  private running: string | null = null;
  private waiting: string | null = null;
  private queued = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private lastStopError: string | null = null;

  constructor(private readonly options: StudioWorkQueueOptions) {}

  state(): StudioQueueState {
    return { engine: this.engine, leaseHeld: this.leaseHeld, running: this.running, waiting: this.waiting, queued: this.queued, lastStopError: this.lastStopError };
  }

  /** Runs one job on the Studio once it may, and schedules the unload when no more work follows. */
  run<T>(label: string, job: () => Promise<T>, onWait?: (reason: string) => void): Promise<T> {
    this.queued += 1;
    const result = this.tail.then(async () => {
      this.queued -= 1;
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      if (this.stopping) await this.stopping.catch(() => undefined);
      try {
        await this.open(label, onWait);
        this.running = label;
        return await job();
      } finally {
        this.running = null;
        this.scheduleUnload();
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Unloads now (bridge shutdown). */
  async shutdown(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    await this.unload();
  }

  private async open(label: string, onWait?: (reason: string) => void): Promise<void> {
    if (this.engine === "running" && (this.leaseHeld || !this.options.lease)) return;
    const deadline = Date.now() + (this.options.maxWaitMs ?? 20 * 60_000);
    let lastReason: string | null = null;
    for (;;) {
      let reason: string | null = null;
      if (this.options.lease && !this.leaseHeld) {
        if (await this.options.lease.tryAcquire()) this.leaseHeld = true; else reason = LEASE_BUSY;
      }
      if (!reason) {
        reason = await this.options.admit();
        // Waiting must not keep Command Center out: hand the lease back until the Studio is free.
        if (reason && this.leaseHeld) { await this.options.lease!.release(); this.leaseHeld = false; }
      }
      if (!reason) break;
      this.waiting = label;
      if (reason !== lastReason) { onWait?.(reason); this.options.log?.(`Studio queue: ${label} waits: ${reason}`); lastReason = reason; }
      if (Date.now() >= deadline) { this.waiting = null; throw new Error(`The Mac Studio did not become free in time. ${reason}`); }
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 5_000));
    }
    this.waiting = null;
    this.engine = "starting";
    try { await this.options.start(); this.engine = "running"; }
    catch (error: unknown) { await this.unload(); throw error; }
  }

  private scheduleUnload(): void {
    if (this.queued > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; if (this.queued === 0 && !this.running) void this.unload(); }, this.options.graceMs ?? 20_000);
  }

  private unload(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.engine === "stopped" && !this.leaseHeld) return Promise.resolve();
    this.stopping = (async () => {
      if (this.engine !== "stopped") {
        this.engine = "stopping";
        try { await this.options.stop(); this.lastStopError = null; }
        catch (error: unknown) {
          // Recorded, and the lease is still released: the gate's own watchdog stops an idle engine, and holding the lease
          // would block Command Center indefinitely.
          this.lastStopError = error instanceof Error ? error.message : String(error);
          this.options.log?.(`Studio queue: unload not confirmed: ${this.lastStopError}`);
        }
        this.engine = "stopped";
      }
      if (this.leaseHeld) { await this.options.lease!.release().catch(() => undefined); this.leaseHeld = false; }
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }
}
