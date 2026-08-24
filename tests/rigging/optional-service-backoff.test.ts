import { describe, expect, it } from "vitest";
import { OPTIONAL_SERVICE_RETRY_DELAYS_MS, OptionalServiceRetryBackoff } from "../../src/local-services/retryBackoff";

describe("optional localhost service retry backoff", () => {
  it("backs off failed probes and caps at a low-frequency interval", () => {
    const backoff = new OptionalServiceRetryBackoff();
    expect(OPTIONAL_SERVICE_RETRY_DELAYS_MS).toEqual([5_000, 15_000, 30_000, 60_000, 120_000]);
    expect(Array.from({ length: 7 }, () => backoff.nextDelay(false))).toEqual([5_000, 15_000, 30_000, 60_000, 120_000, 120_000, 120_000]);
  });

  it("resets immediately after a successful probe", () => {
    const backoff = new OptionalServiceRetryBackoff();
    backoff.nextDelay(false);
    backoff.nextDelay(false);
    expect(backoff.nextDelay(true)).toBe(5_000);
    expect(backoff.nextDelay(false)).toBe(5_000);
  });
});
