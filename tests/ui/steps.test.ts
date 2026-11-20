import { describe, expect, it } from "vitest";
import { resolveStep, stepAvailability, stepForLocation, STEPS, type StepState } from "../../app/studio-ui/steps";

const none: StepState = { hasArt: false, partsCut: false, hasRig: false, rigValid: false };

describe("the five guided steps", () => {
  it("lists Create, Parts, Rig, Animate and Export at their addresses", () => {
    expect(STEPS.map((step) => [step.label, step.href])).toEqual([
      ["Create", "/create-character"], ["Parts", "/part-cutter"], ["Rig", "/?mode=setup"], ["Animate", "/?mode=animate"], ["Export", "/?mode=export"],
    ]);
  });

  it("opens only Create before there is art, and says why Parts is locked", () => {
    const steps = stepAvailability(none);
    expect(Object.entries(steps).filter(([, value]) => value.available).map(([id]) => id)).toEqual(["create"]);
    expect(steps.parts.reason).toBe("Choose art first");
  });

  it("unlocks each step in turn, with the next one's reason", () => {
    expect(stepAvailability({ ...none, hasArt: true }).parts.available).toBe(true);
    expect(stepAvailability({ ...none, hasArt: true }).rig.reason).toBe("Cut the parts first");
    expect(stepAvailability({ ...none, hasArt: true, partsCut: true }).rig.available).toBe(true);
    expect(stepAvailability({ ...none, hasArt: true, partsCut: true }).animate.reason).toBe("Build the rig first");
  });

  it("locks Animate and Export behind rig problems", () => {
    const steps = stepAvailability({ hasArt: true, partsCut: true, hasRig: true, rigValid: false });
    expect(steps.animate.reason).toBe("Fix the rig problems first");
    expect(steps.export.reason).toBe("Fix the rig problems first");
    expect(stepAvailability({ hasArt: true, partsCut: true, hasRig: true, rigValid: true }).export.available).toBe(true);
  });

  it("maps every address to its step, folding Test into Rig", () => {
    expect(stepForLocation("/create-character", null)).toBe("create");
    expect(stepForLocation("/part-cutter", null)).toBe("parts");
    expect(stepForLocation("/", "setup")).toBe("rig");
    expect(stepForLocation("/", "test")).toBe("rig");
    expect(stepForLocation("/", "animate")).toBe("animate");
    expect(stepForLocation("/", "export")).toBe("export");
  });

  it("sends a locked step to the furthest open step before it, with the reason", () => {
    expect(resolveStep("animate", { ...none, hasArt: true, partsCut: true })).toEqual({ step: "rig", reason: "Build the rig first" });
    expect(resolveStep("export", none)).toEqual({ step: "create", reason: "Choose art first" });
    expect(resolveStep("parts", { ...none, hasArt: true })).toEqual({ step: "parts" });
  });
});
