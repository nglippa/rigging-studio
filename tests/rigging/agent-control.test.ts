import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RiggingCommandService } from "../../src/agent-control/commands/RiggingCommandService";
import { parseToolInput, TOOL_NAMES } from "../../src/agent-control/validation/toolSchemas";
import { safeParseAnimationJson, safeParseRigJson } from "../../src/rigging/schema/parsing";
import type { RigDefinition } from "../../src/rigging/schema/types";
import { RigCommandHistory } from "../../src/tools/rig-editor/history";
import { AnimationCommandHistory } from "../../src/tools/rig-editor/animation/history";
import { createAnimationLibrary } from "../../src/tools/rig-editor/animation/library";
import { createGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { presentAgentStatus } from "../../app/studio-ui/agentStatus";

const fixtureRig = (): RigDefinition => {
  const result = safeParseRigJson(readFileSync(new URL("../../public/rig-test/minimal-rig.json", import.meta.url), "utf8"));
  if (!result.success) throw new Error(result.message);
  return result.data;
};

const createHarness = () => {
  const service = new RiggingCommandService();
  const rigHistory = new RigCommandHistory(fixtureRig());
  let selectedBone: string | null = null;
  service.attachRigEditor({
    getRig: () => rigHistory.present,
    execute: (label, transform) => rigHistory.execute(label, transform),
    beginTransaction: (label) => rigHistory.beginTransaction(label),
    updateTransaction: (transform) => rigHistory.updateTransaction(transform(rigHistory.present)),
    commitTransaction: () => rigHistory.commitTransaction(),
    rollbackTransaction: () => rigHistory.cancelTransaction(),
    undo: () => rigHistory.undo(),
    redo: () => rigHistory.redo(),
    setSelectedBone: (boneId) => { selectedBone = boneId; },
  });
  const animationResult = safeParseAnimationJson(readFileSync(new URL("../../public/rig-test/idle-animation.json", import.meta.url), "utf8"), rigHistory.present);
  if (!animationResult.success) throw new Error(animationResult.message);
  const animationHistory = new AnimationCommandHistory(createAnimationLibrary(rigHistory.present.id, [animationResult.data]));
  let activeId = animationResult.data.id;
  service.attachAnimationEditor({
    getLibrary: () => animationHistory.present,
    getActiveAnimationId: () => activeId,
    execute: (label, transform) => animationHistory.execute(label, transform),
    setActiveAnimation: (animationId) => { activeId = animationId; },
    setPlayback: () => undefined,
  });
  return { service, rigHistory, animationHistory, selectedBone: () => selectedBone };
};

describe("agent-control validation and synchronization", () => {
  it("distinguishes bridge-only from a ready, tool-discovered agent", async () => {
    const service = new RiggingCommandService(); service.setBridgeConnected(true);
    expect(presentAgentStatus(service.session.snapshot)).toMatchObject({ state: "bridge", ready: false });
    let capabilities = await service.executeTool("studio_get_agent_capabilities", { includeToolNames: true });
    expect(capabilities.success && capabilities.ready).toBe(false); expect(capabilities.success && capabilities.toolCount).toBe(0);
    service.setAgentCapabilities(["studio_get_status", "rig_get_summary"], true);
    expect(presentAgentStatus(service.session.snapshot)).toMatchObject({ state: "ready", ready: true, label: "Agent · Ready · 2 tools" });
    capabilities = await service.executeTool("studio_get_agent_capabilities", { includeToolNames: true });
    expect(capabilities.success && capabilities.toolCount).toBe(2); expect(capabilities.success && capabilities.resourcesAvailable).toBe(true);
  });
  it("rejects malformed and extra tool input", () => {
    expect(parseToolInput("rig_move_bone", { boneId: "root", x: 2, y: Number.NaN }).success).toBe(false);
    expect(parseToolInput("studio_get_status", { runShell: "rm" }).success).toBe(false);
    expect(TOOL_NAMES.some((name) => /shell|eval|javascript|write_arbitrary/i.test(name))).toBe(false);
  });

  it("reflects UI selection and agent mutations bidirectionally", async () => {
    const { service, rigHistory, selectedBone } = createHarness();
    service.syncBoneSelectionFromUi("head");
    const status = await service.executeTool("studio_get_status", { includeActivity: false }, "Codex");
    expect(status.success && status.selectedBoneId).toBe("head");
    const bone = rigHistory.present.bones.find((candidate) => candidate.id === "head");
    expect(bone).toBeDefined();
    const moved = await service.executeTool("rig_move_bone", { boneId: "head", x: 12, y: 34, coordinateSpace: "rig" }, "Codex");
    expect(moved.success).toBe(true);
    expect(rigHistory.present.bones.find((candidate) => candidate.id === "head")?.x).toBe(12);
    expect(selectedBone()).toBe("head");
    expect(service.session.snapshot.lastOperation).toBe("Move bone head");
  });

  it("keeps queries read-only while exposing focused Studio summaries", () => {
    const { service, rigHistory, animationHistory } = createHarness();
    const rigBefore = structuredClone(rigHistory.present);
    const animationsBefore = structuredClone(animationHistory.present);
    expect(service.queries.getBoneHierarchy().length).toBe(rigBefore.bones.length);
    expect(service.queries.getSlotSummary().length).toBe(rigBefore.slots.length);
    expect(service.queries.getAnimationList()).toHaveLength(animationsBefore.animations.length);
    expect(service.queries.getValidationErrors()).toEqual([]);
    expect(service.queries.getEquipmentState().skinId).toBe(rigBefore.defaultSkinId);
    expect(rigHistory.present).toEqual(rigBefore);
    expect(animationHistory.present).toEqual(animationsBefore);
    expect(rigHistory.undoCount).toBe(0);
    expect(animationHistory.undoCount).toBe(0);
  });

  it("makes agent rig edits undoable through the normal history", async () => {
    const { service, rigHistory } = createHarness();
    const before = rigHistory.present.bones.find((bone) => bone.id === "head")?.rotation;
    await service.executeTool("rig_rotate_bone", { boneId: "head", rotation: 25, unit: "degrees" }, "Claude Code");
    expect(rigHistory.canUndo).toBe(true);
    service.undoRig("Human");
    expect(rigHistory.present.bones.find((bone) => bone.id === "head")?.rotation).toBe(before);
  });

  it("rolls back a compound transaction without leaving history entries", async () => {
    const { service, rigHistory } = createHarness();
    const before = rigHistory.present;
    const begun = await service.executeTool("transaction_begin", { label: "Adjust head" }, "Codex");
    if (!begun.success) throw new Error("transaction did not begin");
    const transactionId = begun.transactionId as string;
    await service.executeTool("rig_move_bone", { boneId: "head", x: 44, y: 55, coordinateSpace: "rig" }, "Codex");
    const rolledBack = await service.executeTool("transaction_rollback", { transactionId }, "Codex");
    expect(rolledBack.success).toBe(true);
    expect(rigHistory.present).toEqual(before);
    expect(rigHistory.undoCount).toBe(0);
  });

  it("rejects hierarchy cycles and invalid keyframe times without mutation", async () => {
    const { service, rigHistory, animationHistory } = createHarness();
    const rootBefore = rigHistory.present;
    const childOfHead = rigHistory.present.bones.find((bone) => bone.parentId === "head");
    if (childOfHead) {
      const invalid = await service.executeTool("rig_set_parent", { boneId: "head", parentId: childOfHead.id }, "Codex");
      expect(invalid.success).toBe(false);
      expect(rigHistory.present).toEqual(rootBefore);
    }
    const beforeAnimations = animationHistory.present;
    const animationId = beforeAnimations.animations[0].id;
    const invalidKey = await service.executeTool("animation_set_keyframe", { animationId, boneId: "head", property: "rotation", time: 99, value: 10, easing: "linear" }, "Codex");
    expect(invalidKey.success).toBe(false);
    expect(animationHistory.present).toEqual(beforeAnimations);
  });

  it("supports multiple sequential animation calls with concise queries", async () => {
    const { service } = createHarness();
    const created = await service.executeTool("animation_create", { name: "Agent test", duration: 1.5, loop: true }, "Codex");
    expect(created.success).toBe(true);
    const listed = await service.executeTool("animation_list", {}, "Codex");
    expect(listed.success && Array.isArray(listed.animations)).toBe(true);
    const generated = await service.executeTool("animation_generate", { request: "heavy walk", name: "heavy_walk", duration: 1.2, loop: true }, "Codex");
    expect(generated.success).toBe(true);
    const validation = await service.executeTool("validation_get", { includeDetails: true }, "Codex");
    expect(validation.success && validation.valid).toBe(true);
  });

  it("replays off-tab agent animation edits into normal UI history", async () => {
    const service = new RiggingCommandService();
    const rig = fixtureRig();
    const rigHistory = new RigCommandHistory(rig);
    service.attachRigEditor({
      getRig: () => rigHistory.present,
      execute: (label, transform) => rigHistory.execute(label, transform),
      beginTransaction: (label) => rigHistory.beginTransaction(label),
      updateTransaction: (transform) => rigHistory.updateTransaction(transform(rigHistory.present)),
      commitTransaction: () => rigHistory.commitTransaction(),
      rollbackTransaction: () => rigHistory.cancelTransaction(),
      undo: () => rigHistory.undo(), redo: () => rigHistory.redo(), setSelectedBone: () => undefined,
    });
    const parsed = safeParseAnimationJson(readFileSync(new URL("../../public/rig-test/idle-animation.json", import.meta.url), "utf8"), rig);
    if (!parsed.success) throw new Error(parsed.message);
    const baseline = createAnimationLibrary("previous-rig-library-id", [parsed.data]);
    service.syncAnimationsFromUi(baseline, parsed.data.id);
    const created = await service.executeTool("animation_create", { name: "Queued", duration: 1, loop: true }, "Codex");
    expect(created.success).toBe(true);

    const mountedBaseline = { ...baseline, rigId: rig.id };
    const mountedHistory = new AnimationCommandHistory(mountedBaseline);
    let activeId = parsed.data.id;
    service.attachAnimationEditor({
      getLibrary: () => mountedHistory.present,
      getActiveAnimationId: () => activeId,
      execute: (label, transform) => mountedHistory.execute(label, transform),
      setActiveAnimation: (animationId) => { activeId = animationId; },
      setPlayback: () => undefined,
    });
    expect(mountedHistory.present.animations.some((animation) => animation.name === "Queued")).toBe(true);
    expect(mountedHistory.undoCount).toBe(1);
    mountedHistory.undo();
    expect(mountedHistory.present).toEqual(mountedBaseline);
  });

  it("rejects a mismatched explicit project id", async () => {
    const { service, rigHistory } = createHarness();
    const before = rigHistory.present;
    const result = await service.executeTool("rig_rotate_bone", { projectId: "not-the-active-project", boneId: "head", rotation: 10, unit: "degrees" }, "Codex");
    expect(result.success).toBe(false);
    expect(rigHistory.present).toEqual(before);
  });

  it("keeps high-level creation at a human review boundary", async () => {
    const service = new RiggingCommandService();
    const result = await service.executeTool("character_create_from_prompt", { name: "Goblin", prompt: "Chunky goblin blacksmith with a huge hammer", preset: "MODULAR_2D_RIG_CHARACTER", autoAcceptSafeSteps: false }, "Claude Code");
    expect(result.success && result.stageReached).toBe("generation_review");
    expect(result.success && result.requiresReview).toBe(true);
  });

  it("keeps explicit project activation authoritative over stale adapters and drafts", async () => {
    const service = new RiggingCommandService();
    const oldProject = createGeneratedCharacterProject("Old draft", "old", "2026-01-01T00:00:00.000Z");
    let uiProject = oldProject;
    service.attachCharacterProject({ getProject: () => uiProject, replaceProject: (next) => { uiProject = next; } });
    expect(service.restoreProjectFromDraft(createGeneratedCharacterProject("Cold draft", "draft"))).toBe(true);
    const created = await service.executeTool("project_create", { name: "New MCP project", prompt: "new" }, "Codex");
    if (!created.success) throw new Error("project_create failed");
    const projectId = (created.project as { readonly id: string }).id;
    expect(uiProject.id).toBe(projectId);
    expect(service.session.snapshot.activeProjectId).toBe(projectId);
    expect(service.syncProjectFromUi(oldProject)).toBe(false);
    expect(uiProject.id).toBe(projectId);
    expect(service.restoreProjectFromDraft(oldProject)).toBe(false);
    const saved = await service.executeTool("project_save", { projectId }, "Codex");
    expect(saved).toMatchObject({ success: true, projectId });

    const openedProject = createGeneratedCharacterProject("Opened", "open", "2026-01-02T00:00:00.000Z");
    const opened = await service.executeTool("project_open", { project: openedProject }, "Codex");
    expect(opened.success).toBe(true);
    expect(uiProject.id).toBe(openedProject.id);
    expect(service.session.snapshot.activeProjectId).toBe(openedProject.id);
  });

  it("imports managed external artwork into normal suitability and segmentation flow", async () => {
    const service = new RiggingCommandService();
    const created = await service.executeTool("project_create", { name: "Ingress", prompt: "novel mage" }, "Codex");
    if (!created.success) throw new Error("project_create failed");
    const projectId = (created.project as { readonly id: string }).id;
    const imported = await service.executeTool("character_import_generation", {
      projectId, generationId: "imagegen-novel-1", provider: "imagegen", prompt: "novel mage", accepted: false,
      metadata: { model: "imagegen" }, ingressToken: "a".repeat(48),
      managedImage: { image: "http://127.0.0.1:47831/generations/novel.png", sourceArtifact: "/managed/novel.png", width: 1024, height: 1536, mimeType: "image/png" },
    }, "Codex");
    expect(imported).toMatchObject({ success: true, generationMode: "imported_external", novelArtwork: true, width: 1024, height: 1536 });
    const generation = await service.executeTool("character_get_generation", { projectId }, "Codex");
    expect(generation.success && generation.generation).toMatchObject({ generationId: "imagegen-novel-1", provider: "imagegen", novelArtwork: true });
    expect(generation.success && generation.generationHistory).toHaveLength(1);
    expect((await service.executeTool("character_run_suitability_check", { projectId }, "Codex")).success).toBe(true);
    expect((await service.executeTool("character_segment", { projectId }, "Codex")).success).toBe(true);
  });

  it("refuses fixture fallback when novel artwork is explicitly required", async () => {
    const service = new RiggingCommandService();
    const result = await service.executeTool("character_create_from_prompt", {
      name: "Novel only", prompt: "novel character", preset: "MODULAR_2D_RIG_CHARACTER", autoAcceptSafeSteps: false, requireNovelArtwork: true,
    }, "Codex");
    expect(result).toMatchObject({ success: true, stageReached: "awaiting_generation", requiresExternalGeneration: true, novelArtwork: false, provider: "local-mock" });
    const generation = await service.executeTool("character_get_generation", {}, "Codex");
    expect(generation.success && generation.generation).toBeNull();
  });
});
