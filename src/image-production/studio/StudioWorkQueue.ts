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
 *   5. Command Center's queue goes first between units of work: when it has jobs waiting (its queueDepth), a long job hands
 *      the Studio over at its next checkpoint (every job boundary, and `yieldIfWanted` inside long jobs such as a bake):
 *      the engine is stopped, the lease released, and the job waits, however long that takes, until Command Center has
 *      taken its work, then reloads and carries on. If Command Center leaves the lease untouched for `handoverMs` (work
 *      scheduled for later), the job takes the Studio back and does not hand over again until that queue changes.
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
  /** How many jobs Command Center has waiting for the lease (its queueDepth total pending); null when it cannot be read. */
  readonly demand?: () => Promise<number | null>;
  /** How long a handed-over lease may sit untaken while Command Center still reports work, before the job takes it back. */
  readonly handoverMs?: number;
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
  /** The Command Center queue size the last hand-over left untaken; not handed over for again until it changes. */
  private ignoredDemand: number | null = null;

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
        if (this.engine === "running") await this.yieldIfWanted(label, onWait);
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

  /**
   * A checkpoint for long jobs, called between units of work while the job holds the Studio: when Command Center has jobs
   * waiting, hands the Studio over (engine stopped, lease released), waits for Command Center to take its work, and loads
   * the engine again before returning. Resolves true when it handed over.
   */
  async yieldIfWanted(label: string, onWait?: (reason: string) => void): Promise<boolean> {
    if (!this.options.lease || !this.options.demand || !this.leaseHeld) return false;
    const wanted = await this.demand();
    if (!wanted) { this.ignoredDemand = null; return false; }
    if (wanted === this.ignoredDemand) return false;
    await this.handOver(label, wanted, onWait);
    return true;
  }

  /** Unloads now (bridge shutdown). */
  async shutdown(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    await this.unload();
  }

  private async demand(): Promise<number> {
    try { const pending = await this.options.demand!(); return typeof pending === "number" && pending > 0 ? pending : 0; }
    catch { return 0; }
  }

  private async handOver(label: string, wanted: number, onWait?: (reason: string) => void): Promise<void> {
    const reason = `Command Center has ${wanted} job${wanted === 1 ? "" : "s"} waiting; the Mac Studio is handed over until it has taken them`;
    this.waiting = label; onWait?.(reason); this.options.log?.(`Studio queue: ${label}: ${reason}`);
    await this.unload();
    const lease = this.options.lease!;
    const handoverMs = this.options.handoverMs ?? 15_000;
    let seen = wanted; let freeSince: number | null = null;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 5_000));
      const pending = await this.demand();
      if (!pending) { this.ignoredDemand = null; break; }
      if (pending !== seen) { seen = pending; freeSince = null; } // Command Center is working through its queue
      if (await lease.tryAcquire()) {
        // Free while work is still reported: Command Center is between passes, or the work is not due yet.
        freeSince ??= Date.now();
        if (Date.now() - freeSince >= handoverMs) { this.leaseHeld = true; this.ignoredDemand = pending; break; }
        await lease.release();
      } else freeSince = null;
    }
    this.waiting = null;
    // Taken back mid-job: waiting for the Studio now must not fail the job at the entry deadline.
    await this.open(label, onWait, Number.POSITIVE_INFINITY);
  }

  private async open(label: string, onWait?: (reason: string) => void, maxWaitMs = this.options.maxWaitMs ?? 20 * 60_000): Promise<void> {
    if (this.engine === "running" && (this.leaseHeld || !this.options.lease)) return;
    const deadline = Date.now() + maxWaitMs;
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
