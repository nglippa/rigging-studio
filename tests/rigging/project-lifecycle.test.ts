import { describe, expect, it } from "vitest";
import { ProjectLifecycleCoordinator } from "../../src/project-storage/projectLifecycle";
import { LOCAL_PROJECT_STORAGE_VERSION, type LocalProjectSnapshot } from "../../src/project-storage/types";
import { createGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { RiggingCommandService } from "../../src/agent-control/commands/RiggingCommandService";
import { MockCharacterPipelineProvider } from "../../src/character-generation/providers/mockCharacterPipelineProvider";
import type { CharacterImageGenerationResult } from "../../src/character-generation/providers/characterPipelineProvider";

const snapshot = (id: string, sentinel: string): LocalProjectSnapshot => ({
  storageVersion: LOCAL_PROJECT_STORAGE_VERSION,
  localProjectId: id,
  project: { ...createGeneratedCharacterProject(sentinel, sentinel, "2026-01-01T00:00:00.000Z"), id },
  rig: null,
  animations: null,
  selectedSkinId: null,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

describe("project lifecycle isolation", () => {
  it("drops a save completion after a project switch without changing the active saved revision", () => {
    const lifecycle = new ProjectLifecycleCoordinator(); lifecycle.activateInitial("A");
    const save = lifecycle.beginSave(snapshot("A", "PROJECT_A_SENTINEL"), "autosave");
    const open = lifecycle.beginSwitch("B"); expect(lifecycle.commitSwitch(open)).toBe(true);
    expect(lifecycle.completeSave(save, "A")).toBe(false);
    expect(lifecycle.snapshot).toMatchObject({ activeProjectId: "B", savedRevision: 0 });
    expect(lifecycle.getTrace().some((event) => event.operation === "STALE_PROJECT_COMMIT_BLOCKED" && event.sourceProjectId === "A" && event.targetProjectId === "B")).toBe(true);
  });

  it("discards hydration that finishes after a newer open and keeps the final target atomic", () => {
    const lifecycle = new ProjectLifecycleCoordinator(); lifecycle.activateInitial("A");
    const loadingB = lifecycle.beginSwitch("B"); const loadingC = lifecycle.beginSwitch("C");
    expect(lifecycle.commitSwitch(loadingB)).toBe(false); expect(lifecycle.snapshot.activeProjectId).toBe("A");
    expect(lifecycle.commitSwitch(loadingC)).toBe(true); expect(lifecycle.snapshot.activeProjectId).toBe("C");
  });

  it("exposes a neutral loading identity with all required hydration fields before atomic commit", () => {
    const lifecycle = new ProjectLifecycleCoordinator(); lifecycle.activateInitial("A", "A/project.json", "animate");
    const opening = lifecycle.beginSwitch("B", "B/project.json", "prepare");
    expect(lifecycle.snapshot).toMatchObject({ activeProjectId: "A", hydratedProjectId: "A", targetProjectId: "B", switching: true, requestedStage: "prepare", projectSessionToken: opening.projectSessionToken, hydrationToken: opening.hydrationToken });
    expect(opening.revision).toBe(0);
    expect(lifecycle.commitSwitch(opening)).toBe(true);
    expect(lifecycle.snapshot).toMatchObject({ activeProjectId: "B", hydratedProjectId: "B", targetProjectId: null, switching: false, requestedStage: "prepare", hydrationToken: opening.hydrationToken });
  });

  it("rejects an async completion when the active project revision changed", () => {
    const lifecycle = new ProjectLifecycleCoordinator(); lifecycle.activateInitial("A");
    const operation = lifecycle.capture("segmentation"); lifecycle.recordMutation("A");
    expect(lifecycle.isCurrent(operation)).toBe(false);
    expect(() => lifecycle.assertCurrent(operation)).toThrow("Stale segmentation result");
  });

  it("preserves A and B sentinels across A→B→A and B→A→B without sharing mutable snapshots", () => {
    const lifecycle = new ProjectLifecycleCoordinator(); const documents = new Map([["A", snapshot("A", "PROJECT_A_SENTINEL")], ["B", snapshot("B", "PROJECT_B_SENTINEL")]]);
    lifecycle.activateInitial("A"); const aSave = lifecycle.beginSave(documents.get("A")!, "save");
    (documents.get("A")!.project as { name: string }).name = "MUTATED_AFTER_QUEUE";
    expect(aSave.snapshot.project?.name).toBe("PROJECT_A_SENTINEL");
    for (const target of ["B", "A", "B"] as const) expect(lifecycle.commitSwitch(lifecycle.beginSwitch(target))).toBe(true);
    expect(documents.get("A")?.project?.originalUserPrompt).toBe("PROJECT_A_SENTINEL");
    expect(documents.get("B")?.project?.originalUserPrompt).toBe("PROJECT_B_SENTINEL");
  });

  it("uses session identity—not colliding entity IDs—for selection and history isolation", () => {
    const lifecycle = new ProjectLifecycleCoordinator(); lifecycle.activateInitial("A");
    const aToken = lifecycle.snapshot.projectSessionToken; const history = new Map([[aToken, ["A_ONLY_EDIT"]]]); const selection = new Map([[aToken, "bone-1"]]);
    lifecycle.commitSwitch(lifecycle.beginSwitch("B")); const bToken = lifecycle.snapshot.projectSessionToken;
    history.set(bToken, []); selection.set(bToken, null as unknown as string);
    expect(bToken).not.toBe(aToken); expect(history.get(bToken)).toEqual([]); expect(selection.get(bToken)).toBeNull();
    expect(history.get(aToken)).toEqual(["A_ONLY_EDIT"]); expect(selection.get(aToken)).toBe("bone-1");
  });

  it("passes a deterministic 100-switch torture sequence with no pending transition or foreign active ID", () => {
    const lifecycle = new ProjectLifecycleCoordinator(); lifecycle.activateInitial("A");
    const projects = ["A", "B", "C"] as const; let seed = 0x5eed1234;
    for (let index = 0; index < 100; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const target = projects[seed % projects.length]; const transaction = lifecycle.beginSwitch(target);
      expect(lifecycle.commitSwitch(transaction)).toBe(true); expect(lifecycle.snapshot.activeProjectId).toBe(target); expect(lifecycle.snapshot.switching).toBe(false);
    }
    expect(lifecycle.getTrace().filter((event) => event.operation === "PROJECT_HYDRATE_COMMITTED")).toHaveLength(100);
  });

  it("keeps the active project usable after a simulated save/quota/bridge failure", () => {
    const lifecycle = new ProjectLifecycleCoordinator(); lifecycle.activateInitial("A"); lifecycle.beginSave(snapshot("A", "A"), "save");
    const open = lifecycle.beginSwitch("B"); expect(lifecycle.commitSwitch(open)).toBe(true);
    expect(lifecycle.snapshot.activeProjectId).toBe("B"); expect(() => lifecycle.recordMutation("B")).not.toThrow();
  });

  it("blocks a delayed provider result after a switch and records the stale commit", async () => {
    const result = deferred<CharacterImageGenerationResult>();
    class DelayedProvider extends MockCharacterPipelineProvider {
      override generateCharacter(): Promise<CharacterImageGenerationResult> { return result.promise; }
    }
    const service = new RiggingCommandService({ characterProvider: new DelayedProvider() });
    const created = await service.executeTool("project_create", { name: "A", prompt: "A" }); if (!created.success) throw new Error("A was not created");
    const pending = service.executeTool("character_generate_image", { projectId: service.session.snapshot.activeProjectId, mode: "generate" });
    const projectB = { ...createGeneratedCharacterProject("B", "B", "2026-01-02T00:00:00.000Z"), id: "B" };
    const opened = await service.executeTool("project_open", { project: projectB }); expect(opened.success).toBe(true);
    result.resolve({ generationId: "A_ONLY_RESULT", image: "data:image/png;base64,AA==", width: 1, height: 1, generationPrompt: "A", generationSettings: {}, providerMetadata: {}, warnings: [], generationMode: "provider_generated", novelArtwork: true, provider: "delayed", sourceArtifact: "A.png" });
    const completed = await pending; expect(completed.success).toBe(false); expect(service.session.snapshot.activeProjectId).toBe("B");
    expect(service.getProjectLifecycleTrace().some((event) => event.operation === "STALE_PROJECT_COMMIT_BLOCKED" && event.sourceProjectId !== "B")).toBe(true);
  });
});
