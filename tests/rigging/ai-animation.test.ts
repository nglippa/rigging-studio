import { describe, expect, it } from "vitest";
import { buildAnimationGenerationContext } from "../../src/rigging/ai/animationContextBuilder";
import { applyAnimationProposal, createProposalPreview, rejectAnimationProposal } from "../../src/rigging/ai/animationProposalApplier";
import type { AnimationProposal } from "../../src/rigging/ai/animationProposalSchema";
import { validateAnimationProposal } from "../../src/rigging/ai/animationProposalValidator";
import { diagnoseFootSliding } from "../../src/rigging/ai/footSlideDiagnostic";
import { AnimationCommandHistory } from "../../src/tools/rig-editor/animation/history";
import { animationById, createAnimationLibrary } from "../../src/tools/rig-editor/animation/library";
import { validAnimation, validRig } from "./fixtures";
import { animationPresetId, visualReviewGoal } from "../../src/rigging/ai/animationContinuity";
import { mockAnimationName } from "../../src/rigging/ai/mockAnimationGenerationProvider";

const proposal = (): AnimationProposal => ({
  proposalVersion: 1,
  summary: "Safe revision",
  animation: validAnimation(),
  warnings: [],
  assumptions: ["Unit fixture"],
  affectedBones: ["child"],
  confidenceNotes: ["Validated fixture"],
});

describe("AI animation proposal safety", () => {
  it("preserves current animation context in preset, name, and review goal", () => {
    expect(animationPresetId({ id: "idle", name: "Idle" })).toBe("idle");
    expect(mockAnimationName("Create a grounded walk cycle")).toBe("Walk");
    expect(visualReviewGoal({ name: "Idle" })).toContain("Review Idle"); expect(visualReviewGoal({ name: "Walk" })).not.toContain("Loading");
  });
  it("rejects malformed provider responses", () => {
    const result = validateAnimationProposal({ proposalVersion: 1, summary: "Missing animation" }, validRig());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.message).toContain("malformed");
  });

  it("rejects unknown bone references", () => {
    const input = proposal();
    const result = validateAnimationProposal({ ...input, animation: { ...input.animation, tracks: [{ ...input.animation.tracks[0], boneId: "invented" }] }, affectedBones: ["invented"] }, validRig());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.message).toContain("missing bone");
  });

  it("rejects unsafe transform values", () => {
    const input = proposal();
    const result = validateAnimationProposal({ ...input, animation: { ...input.animation, tracks: [{ ...input.animation.tracks[0], keyframes: [{ time: 0, value: 900, easing: "linear" }] }] } }, validRig());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.message).toContain("Rotation differs");
  });

  it("keeps proposal preview isolated from source documents", () => {
    const source = proposal();
    const library = createAnimationLibrary("unit-rig", [validAnimation()]);
    const before = JSON.stringify(library);
    const preview = createProposalPreview(source);
    expect(preview).not.toBe(source.animation);
    expect(JSON.stringify(library)).toBe(before);
  });

  it("applies only selected proposal tracks", () => {
    const source = proposal();
    const proposed = { ...source, animation: { ...source.animation, tracks: [
      { boneId: "child", property: "rotation" as const, keyframes: [{ time: 0, value: 44, easing: "linear" as const }] },
      { boneId: "child", property: "x" as const, keyframes: [{ time: 0, value: 7, easing: "linear" as const }] },
    ] } };
    const library = createAnimationLibrary("unit-rig", [validAnimation()]);
    const result = applyAnimationProposal(library, proposed, { mode: "revise", currentAnimationId: "idle", selectedTrackKeys: ["child:x"] });
    const animation = animationById(result.document, "idle")!;
    expect(animation.tracks.find((track) => track.property === "rotation")?.keyframes[0].value).toBe(0);
    expect(animation.tracks.find((track) => track.property === "x")?.keyframes[0].value).toBe(7);
  });

  it("accepts a proposal as one undoable editor command", () => {
    const library = createAnimationLibrary("unit-rig", [validAnimation()]);
    const history = new AnimationCommandHistory(library);
    const source = proposal();
    history.execute("Accept AI animation proposal", (current) => applyAnimationProposal(current, { ...source, animation: { ...source.animation, name: "Revised" } }, { mode: "revise", currentAnimationId: "idle" }).document);
    expect(history.undoCount).toBe(1);
    expect(animationById(history.present, "idle")?.name).toBe("Revised");
    expect(animationById(history.undo(), "idle")?.name).toBe("Idle");
  });

  it("rejects without mutating the animation document", () => {
    const library = createAnimationLibrary("unit-rig", [validAnimation()]);
    expect(rejectAnimationProposal(library)).toBe(library);
  });

  it("builds a minimal prompt context without asset paths or unrelated metadata", () => {
    const rig = validRig();
    const context = buildAnimationGenerationContext(rig, {
      request: "Create a walk", mode: "create", selectedBoneIds: [], leftRightMappings: [], groundPlaneY: 90,
      leftFootBoneId: null, rightFootBoneId: null, contactIntervals: [], constraints: {
        duration: 1, loop: true, intensity: .5, weight: .5, exaggeration: .5, rootMovementAllowance: 20,
        preserveTiming: false, preserveContactFrames: true, styleNotes: "",
      },
    });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("imagePath");
    expect(serialized).not.toContain("parts/body.png");
    expect(serialized).not.toContain("attachments");
    expect(context.currentAnimation).toBeUndefined();
  });

  it("warns about likely world-position drift during foot contact", () => {
    const rig = validRig();
    const animation = { ...validAnimation(), tracks: [{ boneId: "root", property: "x" as const, keyframes: [
      { time: 0, value: 0, easing: "linear" as const }, { time: 1, value: 20, easing: "linear" as const },
    ] }] };
    const result = diagnoseFootSliding(rig, animation, { leftFootBoneId: "child", rightFootBoneId: null }, [{ foot: "leftFoot", start: 0, end: 1 }], 3);
    expect(result).toHaveLength(1);
    expect(result[0].likelySliding).toBe(true);
    expect(result[0].drift).toBeGreaterThan(15);
  });
});
