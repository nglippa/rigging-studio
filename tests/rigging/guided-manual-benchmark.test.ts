import { describe, expect, it } from "vitest";
import {
  GUIDED_BENCHMARK_IDLE_THRESHOLD_MS, activeInteractionTime, createGuidedBenchmarkRun, finishGuidedBenchmarkCharacter,
  nextGuidedBenchmarkCharacter, parseGuidedBenchmarkRun, recordGuidedBenchmarkEvent, serializeGuidedBenchmarkRun, startGuidedBenchmarkCharacter,
} from "../../src/part-cutter";

const started = () => startGuidedBenchmarkCharacter(createGuidedBenchmarkRun(), "warrior");
const event = (eventId: string, action: "lasso" | "validation", at: number) => ({ eventId, action, at });

describe("Guided Manual human benchmark harness", () => {
  it("starts timing on the first meaningful workflow event and ends at validation", () => {
    const active = recordGuidedBenchmarkEvent(started(), event("one", "lasso", 1_000));
    const finished = finishGuidedBenchmarkCharacter(active, 3_500, true); const result = finished.results[0];
    expect(result.firstActionAt).toBe(1_000); expect(result.completedAt).toBe(3_500); expect(result.rawElapsedMs).toBe(2_500);
  });

  it("records each gesture once and keeps source identity", () => {
    const once = recordGuidedBenchmarkEvent(started(), event("same", "lasso", 1_000));
    const twice = recordGuidedBenchmarkEvent(once, event("same", "lasso", 1_000));
    expect(twice.activeEvents).toHaveLength(1); expect(finishGuidedBenchmarkCharacter(twice, 2_000, true).results[0].sourceId).toBe("warrior");
  });

  it("hides truth until completion and advances only after a result", () => {
    const active = recordGuidedBenchmarkEvent(started(), event("one", "lasso", 1_000)); expect(active.truthVisible).toBe(false);
    const finished = finishGuidedBenchmarkCharacter(active, 2_000, true); expect(finished.truthVisible).toBe(true); expect(finished.results[0].truthAvailable).toBe(true);
    expect(nextGuidedBenchmarkCharacter(finished).currentIndex).toBe(1);
  });

  it("documents and applies the five-second inactivity threshold without changing raw time", () => {
    const events = [event("one", "lasso", 1_000), event("two", "validation", 21_000)];
    expect(GUIDED_BENCHMARK_IDLE_THRESHOLD_MS).toBe(5_000); expect(activeInteractionTime(events, 22_000)).toBe(6_000);
  });

  it("persists safely and exports deterministically", () => {
    const run = recordGuidedBenchmarkEvent(started(), event("b", "lasso", 2_000));
    const withEarlier = recordGuidedBenchmarkEvent(run, event("a", "validation", 1_000));
    const exported = serializeGuidedBenchmarkRun(withEarlier); expect(serializeGuidedBenchmarkRun(parseGuidedBenchmarkRun(exported))).toBe(exported);
    expect(parseGuidedBenchmarkRun("not-json").results).toEqual([]);
  });
});
