import { describe, expect, it } from "vitest";
import { StudioWorkQueue, type StudioLease } from "../../src/image-production/studio/StudioWorkQueue";

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
