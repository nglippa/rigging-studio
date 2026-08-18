import { describe, expect, it } from "vitest";
import type { AnimationProposal } from "../../src/rigging/ai/animationProposalSchema";
import { validateAnimationProposal } from "../../src/rigging/ai/animationProposalValidator";
import { createDiagnosticCapturePlan } from "../../src/rigging/ai-vision/diagnosticCapturePlan";
import { sampleDiagnosticFrames } from "../../src/rigging/ai-vision/diagnosticFrameRenderer";
import { buildDiagnosticPackageFiles, createDiagnosticZip } from "../../src/rigging/ai-vision/diagnosticPackage";
import { issueSeekTime, visualReviewToTimelineMarkers } from "../../src/rigging/ai-vision/visualReviewDiff";
import { buildVisualReviewContext, buildVisualReviewPrompt } from "../../src/rigging/ai-vision/visualReviewPromptBuilder";
import { createVisualReviewPassState, runVisualReviewPass, type VisualReviewProvider } from "../../src/rigging/ai-vision/visualReviewProvider";
import { validateVisualReview, type VisualReview } from "../../src/rigging/ai-vision/visualReviewSchema";
import { validAnimation, validRig } from "./fixtures";

const reviewFixture = (correctedAnimationProposal?: AnimationProposal): VisualReview => ({
  reviewVersion: 1,
  summary: "One visible timing issue",
  detectedIssues: [{
    id: "issue-1", issueType: "uneven timing", severity: "medium", timeRange: { start: .2, end: .4 },
    affectedBones: ["child"], explanation: "Animation problem: the child motion accelerates abruptly.",
    suggestedCorrection: "Ease the middle of the motion.", confidence: .8,
  }],
  ...(correctedAnimationProposal ? { correctedAnimationProposal } : {}),
});

const proposalFixture = (): AnimationProposal => ({
  proposalVersion: 1, summary: "Validated correction", animation: validAnimation(), warnings: [], assumptions: [], affectedBones: ["child"], confidenceNotes: [],
});

const contextFixture = () => {
  const rig = validRig(); const animation = validAnimation(); const plan = createDiagnosticCapturePlan(animation, { frameCount: 4 });
  return buildVisualReviewContext(rig, animation, {
    animationGoal: "Review the idle", groundPlaneY: 90, feet: { leftFootBoneId: null, rightFootBoneId: null, contactIntervals: [] },
    constraints: { duration: 1, loop: true, intensity: .5, weight: .5, exaggeration: .4, rootMovementAllowance: 20, preserveTiming: true, preserveContactFrames: true, styleNotes: "" },
    knownWarnings: [], capture: { frameCount: plan.frameCount, imageWidth: plan.contactSheetWidth, imageHeight: plan.contactSheetHeight, times: plan.times, overlays: plan.overlays },
  });
};

describe("AI visual review workflow", () => {
  it("generates deterministic capture plans with action and locomotion defaults", () => {
    const action = { ...validAnimation(), id: "attack", name: "Attack", loop: false };
    const locomotion = { ...validAnimation(), id: "walk", name: "Walk", loop: true };
    expect(createDiagnosticCapturePlan(action)).toEqual(createDiagnosticCapturePlan(action));
    expect(createDiagnosticCapturePlan(action).frameCount).toBe(8);
    const walkPlan = createDiagnosticCapturePlan(locomotion);
    expect(walkPlan.frameCount).toBe(12);
    expect(walkPlan.times.at(-1)).toBeLessThan(locomotion.duration);
  });

  it("samples an animation deterministically at planned times", () => {
    const animation = { ...validAnimation(), loop: false, tracks: [{ boneId: "child", property: "x" as const, keyframes: [
      { time: 0, value: 10, easing: "linear" as const }, { time: 1, value: 30, easing: "linear" as const },
    ] }] };
    const plan = createDiagnosticCapturePlan(animation, { frameCount: 3 });
    const first = sampleDiagnosticFrames(validRig(), animation, plan);
    const second = sampleDiagnosticFrames(validRig(), animation, plan);
    expect(first.map((sample) => sample.time)).toEqual([0, .5, 1]);
    expect(first[1].pose.bones.child.x).toBe(20);
    expect(first).toEqual(second);
  });

  it("validates structured review responses and rejects unknown bones", () => {
    const valid = validateVisualReview(reviewFixture(), 1, new Set(["root", "child"]));
    expect(valid.success).toBe(true);
    const invalid = validateVisualReview({ ...reviewFixture(), detectedIssues: [{ ...reviewFixture().detectedIssues[0], affectedBones: ["invented"] }] }, 1, new Set(["root", "child"]));
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(invalid.message).toContain("Unknown bone");
  });

  it("converts issues into seekable timeline markers", () => {
    const review = reviewFixture(); const markers = visualReviewToTimelineMarkers(review);
    expect(markers).toEqual([{ id: "issue-1", start: .2, end: .4, severity: "medium", label: "uneven timing", affectedBones: ["child"] }]);
    expect(issueSeekTime(review.detectedIssues[0])).toBeCloseTo(.3);
  });

  it("routes corrected review proposals through the normal proposal validator", () => {
    const review = reviewFixture(proposalFixture());
    const validatedReview = validateVisualReview(review, 1, new Set(["root", "child"]));
    expect(validatedReview.success).toBe(true);
    if (validatedReview.success) expect(validateAnimationProposal(validatedReview.review.correctedAnimationProposal, validRig()).success).toBe(true);
  });

  it("enforces the configured pass limit", async () => {
    let calls = 0;
    const provider: VisualReviewProvider = { id: "test", name: "Test provider", async reviewAnimation() { calls += 1; return reviewFixture(); } };
    const context = contextFixture(); const input = { prompt: buildVisualReviewPrompt(context), context, contactSheet: new Blob(["png"], { type: "image/png" }) };
    const first = await runVisualReviewPass(createVisualReviewPassState(1), provider, input);
    await expect(runVisualReviewPass(first.state, provider, input)).rejects.toThrow("pass limit");
    expect(calls).toBe(1);
  });

  it("does not retry a failed provider request automatically", async () => {
    let calls = 0;
    const provider: VisualReviewProvider = { id: "failing", name: "Failing provider", async reviewAnimation() { calls += 1; throw new Error("network failed"); } };
    const context = contextFixture();
    await expect(runVisualReviewPass(createVisualReviewPassState(3), provider, { prompt: buildVisualReviewPrompt(context), context, contactSheet: new Blob(["png"]) })).rejects.toThrow("network failed");
    expect(calls).toBe(1);
  });

  it("exports the expected manual diagnostic package files", async () => {
    const context = contextFixture(); const review = reviewFixture();
    const files = await buildDiagnosticPackageFiles({ contactSheet: new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), context, animation: validAnimation(), reviewRequest: buildVisualReviewPrompt(context), reviewResponse: review });
    expect(files.map((file) => file.name)).toEqual(["contact-sheet.png", "rig-context.json", "animation.json", "review-request.txt", "review-response.json"]);
    const archiveText = new TextDecoder().decode(new Uint8Array(await createDiagnosticZip(files).arrayBuffer()));
    files.forEach((file) => expect(archiveText).toContain(file.name));
  });
});
