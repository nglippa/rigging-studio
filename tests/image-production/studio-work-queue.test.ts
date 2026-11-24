import { describe, expect, it } from "vitest";
import { StudioWorkQueue, type StudioLease } from "../../src/image-production/studio/StudioWorkQueue";
import { commandCenterPending } from "../../src/image-production/studio/studioSession";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A recording fake of the Studio: the lease, Command Center's admission check, and the engine. */
function fakeStudio(options: { leaseBusyFor?: number; admitBusyFor?: number } = {}) {
  const log: string[] = [];
  let leaseRefusals = options.leaseBusyFor ?? 0; let admitRefusals = options.admitBusyFor ?? 0;
  let held = false;
  const lease: StudioLease = {
    async tryAcquire() { if (leaseRefusals > 0) { leaseRefusals -= 1; log.push("lease busy"); return false; } held = true; log.push("lease"); return true; },
    async release() { held = false; log.push("unlease"); },
  };
  const queue = new StudioWorkQueue({
    lease,
    admit: async () => { if (admitRefusals > 0) { admitRefusals -= 1; log.push("admit busy"); return "An Ollama model is loaded on the Studio"; } return null; },
    start: async () => { log.push("start"); },
    stop: async () => { log.push("stop"); },
    graceMs: 30, pollMs: 5, maxWaitMs: 2_000,
  });
  return { queue, log, held: () => held };
}

describe("Studio work queue (Command Center lease, load on call, unload after)", () => {
  it("takes the lease, starts the engine for the job, then stops it and releases the lease once idle", async () => {
    const { queue, log, held } = fakeStudio();
    await expect(queue.run("generate", async () => { log.push("job"); return 7; })).resolves.toBe(7);
    expect(log).toEqual(["lease", "start", "job"]);
    expect(held()).toBe(true); // kept through the grace period, in case more work follows
    await tick(80);
    expect(log).toEqual(["lease", "start", "job", "stop", "unlease"]);
    expect(held()).toBe(false);
    expect(queue.state().engine).toBe("stopped");
  });

  it("runs jobs one at a time and keeps one load for a burst of work", async () => {
    const { queue, log } = fakeStudio();
    const order: string[] = [];
    await Promise.all([1, 2, 3].map((n) => queue.run(`cut ${n}`, async () => { order.push(`begin ${n}`); await tick(5); order.push(`end ${n}`); })));
    expect(order).toEqual(["begin 1", "end 1", "begin 2", "end 2", "begin 3", "end 3"]);
    await tick(80);
    expect(log.filter((entry) => entry === "start")).toHaveLength(1);
    expect(log.filter((entry) => entry === "stop")).toHaveLength(1);
  });

  it("waits while Command Center holds the lease or the Studio is busy, and says why", async () => {
    const { queue, log } = fakeStudio({ leaseBusyFor: 2, admitBusyFor: 1 });
    const reasons: string[] = [];
    await queue.run("generate", async () => { log.push("job"); }, (reason) => reasons.push(reason));
    expect(log.indexOf("job")).toBeGreaterThan(log.lastIndexOf("lease busy"));
    expect(reasons.some((reason) => /Command Center/.test(reason))).toBe(true);
    expect(reasons.some((reason) => /Ollama/.test(reason))).toBe(true);
    // A refused admission gives the lease back, so Command Center is never blocked by a job that is only waiting.
    expect(log.slice(0, log.indexOf("admit busy") + 2)).toContain("unlease");
  });

  it("still unloads and releases the lease when the job fails", async () => {
    const { queue, log, held } = fakeStudio();
    await expect(queue.run("generate", async () => { throw new Error("model missing"); })).rejects.toThrow("model missing");
    await tick(80);
    expect(log.slice(-2)).toEqual(["stop", "unlease"]);
    expect(held()).toBe(false);
  });

  it("gives up after the longest wait instead of queueing forever", async () => {
    const queue = new StudioWorkQueue({
      lease: { tryAcquire: async () => false, release: async () => undefined },
      admit: async () => null, start: async () => undefined, stop: async () => undefined, graceMs: 10, pollMs: 5, maxWaitMs: 40,
    });
    await expect(queue.run("generate", async () => 1)).rejects.toThrow(/Command Center/);
  });
});

/**
 * A fake Studio plus a fake Command Center: `pending` is its queue (queueDepth total pending), and once it is handed the
 * lease it holds it for `busyProbes` lease checks, runs its work (pending -> 0) and lets go.
 */
function sharedStudio(options: { maxWaitMs?: number } = {}) {
  const log: string[] = [];
  const cc = { pending: 0 as number | null, busyProbes: 0, consumes: true };
  let held = false;
  const lease: StudioLease = {
    async tryAcquire() {
      if (cc.busyProbes > 0) { cc.busyProbes -= 1; if (cc.busyProbes === 0 && cc.consumes) cc.pending = 0; log.push("lease busy"); return false; }
      held = true; log.push("lease"); return true;
    },
    async release() { held = false; log.push("unlease"); },
  };
  const queue = new StudioWorkQueue({
    lease,
    demand: async () => cc.pending,
    admit: async () => null,
    start: async () => { log.push("start"); },
    stop: async () => { log.push("stop"); },
    graceMs: 30, pollMs: 5, handoverMs: 25, maxWaitMs: options.maxWaitMs ?? 2_000,
  });
  return { queue, log, cc, held: () => held };
}

describe("Studio work queue hand-over (Command Center's queued work gets the Studio between units)", () => {
  it("hands the Studio to Command Center between units of one long job, then takes it back and carries on", async () => {
    const { queue, log, cc } = sharedStudio();
    const reasons: string[] = [];
    await queue.run("bake", async () => {
      log.push("unit 1");
      cc.pending = 1; cc.busyProbes = 3; // Command Center queued a job while unit 1 ran
      await expect(queue.yieldIfWanted("bake", (reason) => reasons.push(reason))).resolves.toBe(true);
      log.push("unit 2");
    });
    expect(log.slice(0, 5)).toEqual(["lease", "start", "unit 1", "stop", "unlease"]);
    // Command Center held the lease, ran its job, let go; the bake took the Studio back and loaded the engine again.
    expect(log.slice(log.lastIndexOf("lease busy") + 1)).toEqual(["lease", "start", "unit 2"]);
    expect(reasons.some((reason) => /Command Center has 1 job waiting/.test(reason))).toBe(true);
  });

  it("does not hand over when Command Center has nothing waiting (or cannot be read)", async () => {
    const { queue, log, cc } = sharedStudio();
    await queue.run("bake", async () => {
      cc.pending = 0; await expect(queue.yieldIfWanted("bake")).resolves.toBe(false);
      cc.pending = null; await expect(queue.yieldIfWanted("bake")).resolves.toBe(false);
      log.push("done");
    });
    expect(log).toEqual(["lease", "start", "done"]);
  });

  it("takes the Studio back when Command Center leaves the lease untouched, and does not hand over again for the same queue", async () => {
    const { queue, log, cc } = sharedStudio();
    cc.consumes = false;
    await queue.run("bake", async () => {
      cc.pending = 2; // e.g. work scheduled for later: pending, but the worker never takes the lease for it
      await expect(queue.yieldIfWanted("bake")).resolves.toBe(true);
      await expect(queue.yieldIfWanted("bake")).resolves.toBe(false);
      cc.pending = 3; // the queue changed: hand over again
      await expect(queue.yieldIfWanted("bake")).resolves.toBe(true);
    });
    expect(log.filter((entry) => entry === "stop")).toHaveLength(2);
  });

  it("hands over at a job boundary inside a burst instead of keeping the engine for the whole burst", async () => {
    const { queue, log, cc } = sharedStudio();
    await Promise.all([1, 2].map((n) => queue.run(`clip ${n}`, async () => { log.push(`clip ${n}`); if (n === 1) { cc.pending = 1; cc.busyProbes = 2; } })));
    expect(log.slice(0, 5)).toEqual(["lease", "start", "clip 1", "stop", "unlease"]);
    expect(log.slice(log.lastIndexOf("lease busy") + 1)).toEqual(["lease", "start", "clip 2"]);
  });

  it("a job that handed over waits for Command Center as long as it takes instead of failing at the entry deadline", async () => {
    const { queue, log, cc } = sharedStudio({ maxWaitMs: 20 });
    await queue.run("bake", async () => {
      cc.pending = 1; cc.busyProbes = 12; // about 60 ms of Command Center work at a 5 ms poll: past maxWaitMs
      await queue.yieldIfWanted("bake");
      log.push("unit 2");
    });
    expect(log.at(-1)).toBe("unit 2");
  });
});

describe("Command Center demand (operational-state v2 queueDepth)", () => {
  const state = (items: unknown, status = "complete") => ({ schemaVersion: "command-center.operational-state/2", sections: { queueDepth: { status, items } } });
  it("reads the total pending from the live shape", () => {
    expect(commandCenterPending(state([{ kind: "task", pending: 2, running: 1 }, { kind: "collaboration", pending: 1, running: 0 }, { kind: "total", pending: 3, running: 1, waiting: 0, outstanding: 4 }]))).toBe(3);
    expect(commandCenterPending(state([{ kind: "total", pending: 0 }]))).toBe(0);
  });
  it("is null when the section is unavailable, the total unknown, or the payload is not Command Center's", () => {
    expect(commandCenterPending(state([{ kind: "total", pending: null }]))).toBeNull();
    expect(commandCenterPending(state([], "unavailable"))).toBeNull();
    expect(commandCenterPending({ error: "Route not found." })).toBeNull();
    expect(commandCenterPending(null)).toBeNull();
  });
});
