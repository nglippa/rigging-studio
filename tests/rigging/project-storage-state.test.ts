import { describe, expect, it } from "vitest";
import { projectSaveFailureState } from "../../src/project-storage/types";

describe("project storage save state", () => {
  it("keeps an unpersisted browser project explicitly cache-only when disk save is unavailable", () => {
    expect(projectSaveFailureState(false)).toBe("cache-only");
  });

  it("reports a failed overwrite separately for an existing disk project", () => {
    expect(projectSaveFailureState(true)).toBe("failed");
  });
});
