import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { RiggingCommandService } from "../../src/agent-control/commands/RiggingCommandService";
import { applyDoctorProposal, assertDoctorIdentity } from "../../src/animation-doctor/commands";
import { compareDoctorMetrics, measureDoctorMotion } from "../../src/animation-doctor/metrics";
import { doctorReviewSchema, type DoctorEdit, type DoctorReview } from "../../src/animation-doctor/schema";
import { doctorEditsForVersion, runAnimationDoctor } from "../../src/animation-doctor/session";
import { canonicalProjectStateDigest } from "../../src/project-storage/digest";
import type { LocalProjectSnapshot } from "../../src/project-storage/types";
import { AnimationCommandHistory } from "../../src/tools/rig-editor/animation/history";
import type { AnimationLibrary } from "../../src/tools/rig-editor/animation/types";
import type { RigDefinition } from "../../src/rigging/schema/types";

const json = (file: string) => JSON.parse(readFileSync(new URL(`../fixtures/golden/void-ranger/${file}`, import.meta.url), "utf8"));
const doctorFixture = (): LocalProjectSnapshot => { const rig = json("rig.json") as RigDefinition; return { storageVersion: 1, localProjectId: "doctor-copy", project: null, rig, animations: json("animations.json") as AnimationLibrary, selectedSkinId: rig.defaultSkinId }; };
const fixture = () => {
  const snapshot = doctorFixture();
  const clip = snapshot.animations!.animations[1];
  const track = clip.tracks.find((track) => track.property === "rotation" && track.boneId === "head") ?? clip.tracks.find((track) => track.property === "rotation")!;
  const key = track.keyframes.at(-1)!;
  const edit: DoctorEdit = { id: "repair", boneId: track.boneId, property: "rotation", time: key.time, currentValue: key.value, proposedValue: key.value + 8, reasonCode: "loop_pop", expectedVisualEffect: "Return to the first pose", confidence: .9, evidence: ["metrics"] };
  const identity = { projectId: "doctor-copy", projectSessionToken: "test-session", revision: 0, clipId: clip.id, beforeDigest: canonicalProjectStateDigest(snapshot) };
  return { snapshot, clip, identity, edit };
};
const review = (edits: DoctorEdit[] = [], visualScore = .5): DoctorReview => ({ issues: [], edits, visualScore, expectedImprovement: "Preserve motion and improve the seam", rerenderRequired: edits.length > 0, requests: [] });
const render = vi.fn(async (_snapshot: LocalProjectSnapshot, _clipId: string, version: number) => [{ id: `v${version}-frame-0`, time: 0, sha256: "a".repeat(64), dataUrl: "data:image/png;base64,fixture" }]);
const renderSource = async () => (await render(doctorFixture(), "unused", 0))[0];
const constraints = { contacts: [], grips: [] };

describe("Animation Doctor command boundary", () => {
  it("applies deterministically to copies and preserves every other clip, rig, and key", () => {
    const { snapshot, identity, edit } = fixture(); const before = structuredClone(snapshot);
    const candidate = applyDoctorProposal(snapshot, { identity, edits: [edit] }, identity);
    expect(snapshot).toEqual(before); expect(candidate.rig).toEqual(snapshot.rig);
    expect(candidate.animations!.animations[0]).toEqual(snapshot.animations!.animations[0]);
    expect(candidate).toEqual(applyDoctorProposal(snapshot, { identity, edits: [edit] }, identity));
    expect(canonicalProjectStateDigest(candidate)).not.toBe(identity.beforeDigest);
  });
  it.each(["projectId", "projectSessionToken", "revision", "clipId", "beforeDigest"] as const)("vetoes mismatched %s", (key) => {
    const { snapshot, identity, edit } = fixture(); const stale = { ...identity, [key]: key === "revision" ? 1 : "another" };
    expect(() => applyDoctorProposal(snapshot, { identity: stale, edits: [edit] }, identity)).toThrow(/Stale/);
  });
  it.each([
    { boneId: "zombie" }, { property: "scaleX" }, { time: .123456 }, { currentValue: 1234 }, { proposedValue: NaN }, { proposedValue: Infinity }, { proposedValue: 999 }, { arbitraryJson: true },
  ])("vetoes invalid or unsafe edit %j", (patch) => {
    const { snapshot, identity, edit } = fixture(); expect(() => applyDoctorProposal(snapshot, { identity, edits: [{ ...edit, ...patch }] }, identity)).toThrow();
  });
  it("rejects duplicates, empty changes, and oversized batches", () => {
    const { snapshot, identity, edit } = fixture();
    for (const edits of [[], [edit, edit], Array.from({ length: 25 }, () => edit), [{ ...edit, proposedValue: edit.currentValue }]]) expect(() => applyDoctorProposal(snapshot, { identity, edits }, identity)).toThrow();
  });
  it("vetoes a source changed outside revision tracking", () => {
    const { snapshot, identity, edit } = fixture(); const changed = { ...snapshot, selectedSkinId: "different" };
    expect(() => applyDoctorProposal(changed, { identity, edits: [edit] }, identity)).toThrow(/digest/);
  });
  it("vetoes a valid digest bound to another project's identity", () => {
    const { snapshot, identity, edit } = fixture(); const forged = { ...identity, projectId: "other" };
    expect(() => applyDoctorProposal(snapshot, { identity: forged, edits: [edit] }, forged)).toThrow(/project identity/);
  });
  it("canonical validation vetoes broken hierarchy and attachment references", () => {
    for (const defect of ["hierarchy", "attachment"]) {
      const { snapshot, identity, edit } = fixture(); const rig = snapshot.rig!;
      const broken = { ...snapshot, rig: defect === "hierarchy" ? { ...rig, bones: rig.bones.map((bone, i) => i === 0 ? { ...bone, parentId: "missing" } : bone) } : { ...rig, slots: rig.slots.map((slot, i) => i === 0 ? { ...slot, attachmentId: "missing" } : slot) } };
      const current = { ...identity, beforeDigest: canonicalProjectStateDigest(broken) };
      expect(() => applyDoctorProposal(broken, { identity: current, edits: [edit] }, current)).toThrow(/vetoed/);
    }
  });
  it("uses existing history for exact undo and blocks replay after commit or switch", () => {
    const { snapshot, edit, clip } = fixture(); const service = new RiggingCommandService(); service.installDurableSnapshot(snapshot);
    const history = new AnimationCommandHistory(snapshot.animations!);
    service.attachAnimationEditor({ getLibrary: () => history.present, getActiveAnimationId: () => clip.id, execute: (label, transform) => history.execute(label, transform), setActiveAnimation: () => {}, setPlayback: () => {} });
    const identity = service.captureMotionReviewIdentity(clip.id); const before = canonicalProjectStateDigest(service.getDurableSnapshot());
    service.applyMotionReview({ identity, edits: [edit] }); expect(history.undoCount).toBe(1);
    expect(() => service.applyMotionReview({ identity, edits: [edit] })).toThrow(/Stale/);
    history.undo(); expect(canonicalProjectStateDigest(service.getDurableSnapshot())).toBe(before);
    service.installDurableSnapshot({ ...snapshot, localProjectId: "another-copy" });
    expect(() => service.applyMotionReview({ identity, edits: [edit] })).toThrow(/Stale/);
  });
});

describe("Animation Doctor objective gates and loop", () => {
  it("measures a literal endpoint rotation defect without playback wrapping", () => {
    const { snapshot, identity, edit, clip } = fixture(); const broken = applyDoctorProposal(snapshot, { identity, edits: [edit] }, identity);
    const before = measureDoctorMotion(snapshot.rig!, clip, constraints); const after = measureDoctorMotion(broken.rig!, broken.animations!.animations[1], constraints);
    expect(before.loopContinuity).toBeLessThan(.001); expect(after.loopContinuity).toBeGreaterThan(1);
    expect(after.footDrift).toBeNull(); expect(after.gripError).toBeNull();
    expect(compareDoctorMetrics(before, after)).toContain("loopContinuity regressed");
  });
  it("measures authored contacts and rejects invalid contact references", () => {
    const { snapshot, clip } = fixture();
    const metrics = measureDoctorMotion(snapshot.rig!, clip, { contacts: [{ boneId: "left-foot", start: 0, end: clip.duration / 4 }], grips: [] });
    expect(metrics.footDrift).toBeGreaterThanOrEqual(0);
    expect(() => measureDoctorMotion(snapshot.rig!, clip, { contacts: [{ boneId: "missing", start: 0, end: 1 }], grips: [] })).toThrow();
  });
  it("vetoes frozen motion even when endpoint metrics are perfect", () => {
    const { snapshot, clip } = fixture(); const before = measureDoctorMotion(snapshot.rig!, clip, constraints);
    expect(compareDoctorMetrics(before, { ...before, motionTravel: 0 })).toContain("Motion collapsed: possible metric gaming");
  });
  it("retains baseline when an otherwise valid candidate regresses", async () => {
    const { snapshot, identity, edit } = fixture(); const provider = { id: "fixture-only", model: "fixture", review: vi.fn(async () => review([edit])) };
    const result = await runAnimationDoctor({ snapshot, identity, provider, measurements: constraints, assertCurrent: () => {}, signal: new AbortController().signal, render, renderSource });
    expect(result.bestVersion).toBe(0); expect(result.versions).toHaveLength(2); expect(result.versions[1].scorecard.vetoes).toContain("loopContinuity regressed");
    expect(snapshot).toEqual(result.versions[0].snapshot); expect(provider.review).toHaveBeenCalledTimes(1);
  });
  it("repairs a planted seam in a copy, rerenders, compares, and produces a bounded acceptance", async () => {
    const { snapshot, identity, edit } = fixture(); const broken = applyDoctorProposal(snapshot, { identity, edits: [edit] }, identity); const brokenIdentity = { ...identity, beforeDigest: canonicalProjectStateDigest(broken) };
    const repair = { ...edit, currentValue: edit.proposedValue, proposedValue: edit.currentValue };
    const provider = { id: "fixture-only", model: "fixture", review: vi.fn().mockResolvedValueOnce(review([repair])).mockResolvedValueOnce(review([], .8)) };
    const result = await runAnimationDoctor({ snapshot: broken, identity: brokenIdentity, provider, measurements: constraints, assertCurrent: () => {}, signal: new AbortController().signal, render, renderSource });
    expect(result.bestVersion).toBe(1); expect(result.versions[1].snapshot).toEqual(snapshot);
    expect(applyDoctorProposal(broken, { identity: brokenIdentity, edits: doctorEditsForVersion(result, 1) }, brokenIdentity)).toEqual(snapshot);
    expect(result.toolCalls).toBeLessThanOrEqual(12); expect(result.renderRequests).toBe(3);
  });
  it("discards results when project changes during provider work", async () => {
    const { snapshot, identity } = fixture(); let current = identity;
    await expect(runAnimationDoctor({ snapshot, identity, measurements: constraints, signal: new AbortController().signal, render, renderSource, assertCurrent: () => assertDoctorIdentity(identity, current), provider: { id: "fixture", model: "fixture", review: async () => { current = { ...identity, revision: 1 }; return review(); } } })).rejects.toThrow(/Stale/);
  });
  it("bounds repeated evidence requests and does not mutate the source", async () => {
    const { snapshot, identity } = fixture(); const before = structuredClone(snapshot);
    const provider = { id: "fixture", model: "fixture", review: vi.fn(async () => ({ ...review(), requests: [{ tool: "inspect_bone" as const, boneId: "head", time: null }] })) };
    await expect(runAnimationDoctor({ snapshot, identity, measurements: constraints, signal: new AbortController().signal, render, renderSource, assertCurrent: () => {}, provider })).rejects.toThrow(/request limit/);
    expect(provider.review).toHaveBeenCalledTimes(3); expect(snapshot).toEqual(before);
  });
  it("rejects fabricated evidence and arbitrary result fields", async () => {
    expect(doctorReviewSchema.safeParse({ ...review(), project: {} }).success).toBe(false);
    const { snapshot, identity, edit } = fixture();
    await expect(runAnimationDoctor({ snapshot, identity, measurements: constraints, signal: new AbortController().signal, render, renderSource, assertCurrent: () => {}, provider: { id: "fixture", model: "fixture", review: async () => review([{ ...edit, evidence: ["invented-frame"] }]) } })).rejects.toThrow(/unknown evidence/);
  });
  it("cancelled reviews stop before invoking a provider", async () => {
    const { snapshot, identity } = fixture(); const controller = new AbortController(); controller.abort(); const provider = { id: "fixture", model: "fixture", review: vi.fn() };
    await expect(runAnimationDoctor({ snapshot, identity, measurements: constraints, signal: controller.signal, render, renderSource, assertCurrent: () => {}, provider })).rejects.toThrow(); expect(provider.review).not.toHaveBeenCalled();
  });
  it("stops after three improving mutation iterations and retains every version", async () => {
    const { snapshot, identity, clip } = fixture();
    const track = clip.tracks.find((track) => track.property === "rotation")!; const time = track.keyframes[1].time;
    const provider = { id: "fixture", model: "fixture", review: vi.fn(async (packet: import("../../src/animation-doctor/evidence").DoctorPacket) => {
      const current = packet.clip.tracks.find((item) => item.boneId === track.boneId && item.property === "rotation")!.keyframes.find((key) => key.time === time)!.value;
      return review([{ id: "interior", boneId: track.boneId, property: "rotation", time, currentValue: current, proposedValue: current - .1, reasonCode: "weight_transfer", expectedVisualEffect: "Stronger interior motion", confidence: .8, evidence: ["channels"] }], .5 + packet.version * .1);
    }) };
    const result = await runAnimationDoctor({ snapshot, identity, measurements: constraints, signal: new AbortController().signal, render, renderSource, assertCurrent: () => {}, provider });
    expect(result.bestVersion).toBe(3); expect(result.versions.map((item) => item.version)).toEqual([0, 1, 2, 3]); expect(provider.review).toHaveBeenCalledTimes(4);
    expect(result.toolCalls).toBe(9); expect(result.renderRequests).toBe(5);
  });
  it("a visual regression cannot replace a better deterministic repair", async () => {
    const { snapshot, identity, edit } = fixture(); const broken = applyDoctorProposal(snapshot, { identity, edits: [edit] }, identity); const current = { ...identity, beforeDigest: canonicalProjectStateDigest(broken) };
    const provider = { id: "fixture", model: "fixture", review: vi.fn().mockResolvedValueOnce(review([{ ...edit, currentValue: edit.proposedValue, proposedValue: edit.currentValue }], .8)).mockResolvedValueOnce(review([], .2)) };
    const result = await runAnimationDoctor({ snapshot: broken, identity: current, measurements: constraints, signal: new AbortController().signal, render, renderSource, assertCurrent: () => {}, provider });
    expect(result.bestVersion).toBe(0); expect(result.versions[1].scorecard.vetoes).toContain("Visual review regressed");
  });
  it("cancellation interrupts a provider that never resolves", async () => {
    const { snapshot, identity } = fixture(); const controller = new AbortController();
    const provider = { id: "fixture", model: "fixture", review: async () => { controller.abort(new Error("User cancelled")); return new Promise<DoctorReview>(() => {}); } };
    await expect(runAnimationDoctor({ snapshot, identity, measurements: constraints, signal: controller.signal, render, renderSource, assertCurrent: () => {}, provider })).rejects.toThrow("User cancelled");
  });
});
