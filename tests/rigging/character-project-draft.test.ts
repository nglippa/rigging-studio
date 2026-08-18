import { describe, expect, it } from "vitest";
import { createGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { GeneratedCharacterStorage, GENERATED_CHARACTER_POINTER_KEY, MemoryGeneratedCharacterObjectStore } from "../../src/character-generation/project/generatedCharacterStorage";
import { GENERATED_CHARACTER_ACTIVE_DRAFT_KEY, generatedCharacterDraftKey, loadGeneratedCharacterDraft, saveGeneratedCharacterDraft } from "../../src/character-generation/project/projectDraft";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  entries(): readonly (readonly [string, string])[] { return [...this.values.entries()]; }
}

class QuotaPointerStorage extends MemoryStorage {
  override setItem(key: string, value: string): void {
    if (key === GENERATED_CHARACTER_POINTER_KEY) throw new DOMException("quota", "QuotaExceededError");
    super.setItem(key, value);
  }
}

describe("generated character drafts", () => {
  it("stores drafts per project and tracks the active pointer separately", () => {
    const storage = new MemoryStorage();
    const first = createGeneratedCharacterProject("First", "one", "2026-01-01T00:00:00.000Z");
    const second = createGeneratedCharacterProject("Second", "two", "2026-01-02T00:00:00.000Z");
    saveGeneratedCharacterDraft(storage, first);
    saveGeneratedCharacterDraft(storage, second);
    expect(storage.getItem(generatedCharacterDraftKey(first.id))).toContain('"name": "First"');
    expect(storage.getItem(generatedCharacterDraftKey(second.id))).toContain('"name": "Second"');
    expect(storage.getItem(GENERATED_CHARACTER_ACTIVE_DRAFT_KEY)).toBe(second.id);
    const restored = loadGeneratedCharacterDraft(storage);
    expect(restored?.success && restored.data.id).toBe(second.id);
  });

  it("keeps image and mask payloads out of localStorage while restoring them from object storage", async () => {
    const pointers = new MemoryStorage();
    const objects = new MemoryGeneratedCharacterObjectStore();
    const storage = new GeneratedCharacterStorage(pointers, objects);
    const image = `data:image/png;base64,${"A".repeat(200_000)}`;
    const mask = new Array<number>(12_000).fill(255);
    const project = {
      ...createGeneratedCharacterProject("Large", "large source", "2026-01-01T00:00:00.000Z"),
      stage: "prepare" as const,
      sourceImage: {
        generationId: "large-source", image, width: 120, height: 100, generationPrompt: "Imported sprite", generationSettings: { imported: true },
        providerMetadata: { provider: "local-import" }, warnings: [], generationMode: "imported_external" as const, novelArtwork: true, provider: "local-import", sourceArtifact: "large.png",
      },
      generationHistory: [],
      partCutterState: {
        stateVersion: 1 as const, sourceImageId: "large-source", sourceCanvasSize: { width: 120, height: 100 }, mode: "manual" as const,
        parts: [{ partId: "torso", label: "Torso", semanticType: "torso" as const, mask: { width: 120, height: 100, alpha: mask }, boundingBox: { x: 0, y: 0, width: 120, height: 100 }, sourceBoundingBox: { x: 0, y: 0, width: 120, height: 100 }, sourceCanvasSize: { width: 120, height: 100 }, pivot: { x: 60, y: 20 }, suggestedParent: "root", suggestedSlot: "torso-slot", zOrder: 0, layer: "body" as const, confidence: 1, articulated: true, equipment: false, occlusionState: "complete" as const, provenance: "manual" as const, accepted: true, notes: [] }],
        proposals: [], ignoredRegions: [], finalized: false, updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const saved = await storage.save(project);
    expect(saved.success).toBe(true);
    expect(pointers.entries()).toHaveLength(1);
    const pointer = pointers.getItem(GENERATED_CHARACTER_POINTER_KEY)!;
    expect(pointer.length).toBeLessThan(500);
    expect(pointer).not.toContain("data:image");
    expect(objects.assets.size).toBe(2);
    const restored = await storage.load();
    expect(restored?.success).toBe(true);
    if (!restored?.success) throw new Error("Draft did not restore");
    expect(restored.data.sourceImage?.image).toBe(image);
    expect(restored.data.partCutterState?.parts[0].mask.alpha).toHaveLength(mask.length);
  });

  it("leaves legacy data untouched when migration cannot persist", async () => {
    const pointers = new MemoryStorage();
    const legacy = createGeneratedCharacterProject("Legacy", "old", "2026-01-01T00:00:00.000Z");
    saveGeneratedCharacterDraft(pointers, legacy);
    const failingObjects: MemoryGeneratedCharacterObjectStore = new MemoryGeneratedCharacterObjectStore();
    failingObjects.putProject = async () => { throw new Error("quota unavailable"); };
    const storage = new GeneratedCharacterStorage(pointers, failingObjects);
    const result = await storage.load();
    expect(result?.success).toBe(false);
    expect(pointers.getItem(generatedCharacterDraftKey(legacy.id))).toContain("Legacy");
  });

  it("reports local metadata quota failure without mutating the in-memory project", async () => {
    const pointers = new QuotaPointerStorage(); const objects = new MemoryGeneratedCharacterObjectStore(); const storage = new GeneratedCharacterStorage(pointers, objects);
    const project = createGeneratedCharacterProject("Still open", "memory remains authoritative"); const before = structuredClone(project);
    const result = await storage.save(project); expect(result.success).toBe(false); if (result.success) throw new Error("Expected quota failure"); expect(result.layer).toBe("localstorage-pointer"); expect(project).toEqual(before); expect(objects.projects.size).toBe(1);
  });
});
