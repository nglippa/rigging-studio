import { describe, expect, it } from "vitest";
import { parseDraft, serializeDraft } from "../../src/tools/rig-editor/draft";
import { RigEditorPreview } from "../../src/tools/rig-editor/preview";
import { validAnimation, validRig } from "./fixtures";

describe("rig editor persistence and preview", () => {
  it("serializes and validates a versioned local draft", () => {
    const rig = validRig();
    const source = serializeDraft(rig, "2026-08-17T00:00:00.000Z");
    const result = parseDraft(source);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.savedAt).toBe("2026-08-17T00:00:00.000Z");
      expect(result.data.rig).toEqual(rig);
    }
    expect(parseDraft('{"draftVersion":2}').success).toBe(false);
  });

  it("restores the authored setup pose after animation preview", () => {
    const preview = new RigEditorPreview(validRig());
    const setup = preview.runtime.getSetupPose();
    preview.enter(validAnimation());
    preview.update(0.5);
    expect(preview.runtime.getPose()).not.toEqual(setup);
    expect(preview.leave()).toEqual(setup);
    expect(preview.isActive).toBe(false);
  });
});
