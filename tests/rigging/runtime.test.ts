import { describe, expect, it } from "vitest";
import { AnimationPlayer } from "../../src/rigging/animation/AnimationPlayer";
import { RigRuntime } from "../../src/rigging/runtime/RigRuntime";
import type { RigDefinition } from "../../src/rigging/schema/types";
import { validAnimation, validRig } from "./fixtures";

describe("RigRuntime equipment state", () => {
  it("preserves slot replacement while animation keeps playing", () => {
    const base = validRig();
    const rig: RigDefinition = {
      ...base,
      attachments: [...base.attachments, { ...base.attachments[0], id: "alternate-body", imagePath: "parts/alternate.png" }],
    };
    const runtime = new RigRuntime(rig);
    const player = new AnimationPlayer(runtime);
    player.play(validAnimation());
    player.update(0.25);
    const timeBeforeSwap = player.currentTime;
    runtime.replaceSlotAttachment("body", "alternate-body");
    player.update(0.25);
    expect(player.currentTime).toBeGreaterThan(timeBeforeSwap);
    expect(player.isPlaying).toBe(true);
    expect(runtime.getResolvedSlots().find(({ slot }) => slot.id === "body")?.attachment?.id).toBe("alternate-body");
  });
});
