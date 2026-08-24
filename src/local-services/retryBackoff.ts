export const OPTIONAL_SERVICE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000] as const;

export class OptionalServiceRetryBackoff {
  private failureCount = 0;

  nextDelay(succeeded: boolean): number {
    if (succeeded) {
      this.failureCount = 0;
      return OPTIONAL_SERVICE_RETRY_DELAYS_MS[0];
    }
    const delay = OPTIONAL_SERVICE_RETRY_DELAYS_MS[Math.min(this.failureCount, OPTIONAL_SERVICE_RETRY_DELAYS_MS.length - 1)];
    this.failureCount += 1;
    return delay;
  }

  reset(): void { this.failureCount = 0; }
}
