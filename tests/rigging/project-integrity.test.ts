import { describe, expect, it } from "vitest";
import { RiggingCommandService } from "../../src/agent-control/commands/RiggingCommandService";
import { createGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { LOCAL_PROJECT_STORAGE_VERSION, type LocalProjectSnapshot } from "../../src/project-storage/types";
import { createManualPart, createPartCutterState, ensureOwnershipPartition, partCutToSegmentation } from "../../src/part-cutter";
import { ANIMATION_LIBRARY_FORMAT, type AnimationLibrary } from "../../src/tools/rig-editor/animation/types";
import { blockingRigProjectProblems, validateRigProject } from "../../src/rigging/validation/project";
import { validAnimation, validRig } from "./fixtures";
import { RigRuntime } from "../../src/rigging/runtime/RigRuntime";
import { AnimationPlayer } from "../../src/rigging/animation/AnimationPlayer";

const library = (): AnimationLibrary => ({
  format: ANIMATION_LIBRARY_FORMAT,
  formatVersion: 1,
  rigId: "unit-rig",
  animations: [validAnimation()],
  metadata: {},
  extensions: {},
});

const snapshot = (patch: Partial<LocalProjectSnapshot> = {}): LocalProjectSnapshot => ({
  storageVersion: LOCAL_PROJECT_STORAGE_VERSION,
  localProjectId: "test-project",
  project: null,
  rig: validRig(),
  animations: library(),
  selectedSkinId: "base",
  ...patch,
});

const codes = (value: LocalProjectSnapshot): string[] => validateRigProject(value).map((problem) => problem.code);

describe("canonical rig project integrity", () => {
  it("accepts a coherent durable rig and animation library", () => {
    expect(blockingRigProjectProblems(validateRigProject(snapshot()))).toEqual([]);
  });

  it("reports structural, transform, animation, and stale-selection failures together", () => {
    const rig = validRig();
    const brokenRig = {
      ...rig,
      bones: [...rig.bones, { ...rig.bones[1], x: Number.NaN }],
      attachments: [...rig.attachments, { ...rig.attachments[0], id: "unused", imagePath: "parts/unused.png" }],
    };
    const brokenAnimations: AnimationLibrary = {
      ...library(),
      animations: [{
        ...validAnimation(),
        tracks: [{ boneId: "missing-bone", property: "rotation", keyframes: [
          { time: 0.5, value: 1, easing: "linear" },
          { time: 0.5, value: 2, easing: "linear" },
        ] }],
      }],
    };
    const problems = validateRigProject(snapshot({ rig: brokenRig, animations: brokenAnimations, selectedSkinId: "deleted" }), {
      boneIds: ["deleted-bone"], animationId: "deleted-animation", keyframes: [{ boneId: "child", property: "rotation", time: 0.25 }],
    });
    expect(problems.map((problem) => problem.code)).toEqual(expect.arrayContaining([
      "duplicate_bone_id", "non_finite_value", "orphan_attachment", "missing_animation_bone",
      "duplicate_keyframe_identity", "stale_selected_skin", "stale_selected_bone", "stale_selected_animation", "stale_selected_keyframe",
    ]));
  });

  it("preserves a non-rectangular accepted mask through the complete Prepare-to-Setup contract", () => {
    const baseState = createPartCutterState("source-1", 2, 2, "manual", "2026-08-22T00:00:00.000Z");
    const part = createManualPart(baseState, "torso", { x: 0, y: 0, width: 2, height: 2 }, { width: 2, height: 2, alpha: [255, 0, 0, 255] }, "Torso");
    const state = ensureOwnershipPartition({ ...baseState, parts: [part], finalized: true });
    const segmentation = partCutToSegmentation(state);
    const rig = {
      ...validRig(),
      slots: [{ ...validRig().slots[0], id: "torso-slot", attachmentId: "torso" }],
      attachments: [{ ...validRig().attachments[0], id: "torso", imagePath: "data:image/png;base64,cGFydA==" }],
      skins: [{ id: "base", name: "Base", slotAttachments: { "torso-slot": "torso" } }],
    };
    const sourceImage = {
      generationId: "source-1", image: "data:image/png;base64,c291cmNl", width: 2, height: 2,
      generationPrompt: "manual", generationSettings: {}, providerMetadata: {}, warnings: [],
      generationMode: "imported_external" as const, novelArtwork: true, provider: "local-import", sourceArtifact: "source.png",
    };
    const project = {
      ...createGeneratedCharacterProject("Mask fixture", "", "2026-08-22T00:00:00.000Z"),
      stage: "rig" as const, sourceImage, generationHistory: [sourceImage], partCutterState: state, segmentationData: segmentation,
      extractedParts: [{ partId: "torso", image: "data:image/png;base64,cGFydA==", width: 2, height: 2, padding: 0, status: "manual" as const }],
      rigDefinition: rig, skins: rig.skins,
    };
    const reloaded = JSON.parse(JSON.stringify(snapshot({ project, rig, animations: null }))) as LocalProjectSnapshot;
    expect(reloaded.project?.partCutterState?.parts[0].mask.alpha).toEqual([255, 0, 0, 255]);
    expect(codes(reloaded)).not.toEqual(expect.arrayContaining(["accepted_part_not_extracted", "accepted_part_missing_attachment", "accepted_part_missing_slot"]));
    expect(blockingRigProjectProblems(validateRigProject(reloaded))).toEqual([]);
  });

  it("rejects a bone deletion before it can strand an animation track", () => {
    const service = new RiggingCommandService();
    service.syncRigFromUi(validRig());
    service.syncAnimationsFromUi(library(), "idle");
    expect(() => service.executeHumanRigMutation("Delete animated bone", (rig) => ({
      ...rig,
      bones: rig.bones.filter((bone) => bone.id !== "child"),
      slots: rig.slots.map((slot) => ({ ...slot, boneId: "root" })),
    }))).toThrow(/Mutation rejected.*missing bone "child"/);
    expect(service.getDurableSnapshot().rig?.bones.map((bone) => bone.id)).toContain("child");
  });

  it("keeps authored rig and keyframes immutable during playback", () => {
    const rig = validRig(); const animation = validAnimation(); const before = JSON.stringify({ rig, animation });
    const runtime = new RigRuntime(rig); const player = new AnimationPlayer(runtime);
    player.play(animation); player.update(0.25); player.update(0.25); player.seek(0.875); player.pause();
    expect(JSON.stringify({ rig, animation })).toBe(before);
    expect(runtime.getPose().bones.child.rotation).toBeTypeOf("number");
  });
});
