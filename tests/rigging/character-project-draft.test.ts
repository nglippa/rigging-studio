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
        parts: [{ partId: "torso", label: "Torso", semanticType: "torso" as const, mask: { width: 120, height: 100, alpha: mask }, boundingBox: { x: 0, y: 0, width: 120, height: 100 }, sourceBoundingBox: { x: 0, y: 0, width: 120, height: 100 }, sourceCanvasSize: { width: 120, height: 100 }, pivot: { x: 60, y: 20 }, suggestedParent: "root", suggestedSlot: "torso-slot", zOrder: 0, layer: "body" as const, confidence: 1, confidenceSource: "heuristic" as const, articulated: true, equipment: false, occlusionState: "complete" as const, provenance: "manual" as const, accepted: true, notes: [] }],
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

  it("rolls back newly written asset objects when the project record fails", async () => {
    const pointers = new MemoryStorage(); const objects = new MemoryGeneratedCharacterObjectStore();
    objects.putProject = async () => { throw new Error("project record quota"); };
    const storage = new GeneratedCharacterStorage(pointers, objects);
    const image = `data:image/png;base64,${"Q".repeat(20_000)}`;
    const project = { ...createGeneratedCharacterProject("Rollback", "quota"), sourceImage: { generationId: "rollback", image, width: 10, height: 10, generationPrompt: "Imported", generationSettings: {}, providerMetadata: {}, warnings: [], generationMode: "imported_external" as const, novelArtwork: true, provider: "local-import", sourceArtifact: "rollback.png" }, generationHistory: [] };
    const result = await storage.save(project);
    expect(result.success).toBe(false); expect(objects.assets.size).toBe(0); expect(pointers.entries()).toHaveLength(0);
  });

  it("reports local metadata quota failure without mutating the in-memory project", async () => {
    const pointers = new QuotaPointerStorage(); const objects = new MemoryGeneratedCharacterObjectStore(); const storage = new GeneratedCharacterStorage(pointers, objects);
    const project = createGeneratedCharacterProject("Still open", "memory remains authoritative"); const before = structuredClone(project);
    const result = await storage.save(project); expect(result.success).toBe(false); if (result.success) throw new Error("Expected quota failure"); expect(result.layer).toBe("localstorage-pointer"); expect(project).toEqual(before); expect(objects.projects.size).toBe(1);
  });

  it("measures and round-trips a deterministic high-asset torture project without localStorage payloads", async () => {
    const pointers = new MemoryStorage(); const objects = new MemoryGeneratedCharacterObjectStore(); const storage = new GeneratedCharacterStorage(pointers, objects);
    const sourceImage = `data:image/png;base64,${"S".repeat(600_000)}`;
    const partImages = Array.from({ length: 3 }, (_, index) => `data:image/png;base64,${String.fromCharCode(65 + index).repeat(120_000)}`);
    const parts = Array.from({ length: 24 }, (_, index) => {
      const x = index % 6 * 84; const y = Math.floor(index / 6) * 104;
      return {
        partId: `torture-part-${index}`, label: `Torture Part ${index}`, semanticType: "custom" as const,
        mask: { width: 80, height: 96, alpha: Array.from({ length: 80 * 96 }, (_, pixel) => (pixel + index * 17) % 13 < 8 ? 255 : 0) },
        boundingBox: { x, y, width: 80, height: 96 }, sourceBoundingBox: { x, y, width: 80, height: 96 }, sourceCanvasSize: { width: 512, height: 512 }, pivot: { x: x + 40, y: y + 48 },
        suggestedParent: "root", suggestedSlot: `torture-part-${index}-slot`, zOrder: index, layer: "body" as const, confidence: 1, confidenceSource: "heuristic" as const,
        articulated: false, equipment: index % 6 === 0, occlusionState: "complete" as const, provenance: "manual" as const, accepted: true, notes: [],
      };
    });
    const generated = {
      ...createGeneratedCharacterProject("Storage torture", "deterministic high-asset fixture", "2026-01-01T00:00:00.000Z"), stage: "prepare" as const,
      sourceImage: { generationId: "torture-source", image: sourceImage, width: 512, height: 512, generationPrompt: "Imported", generationSettings: {}, providerMetadata: {}, warnings: [], generationMode: "imported_external" as const, novelArtwork: true, provider: "local-import", sourceArtifact: "torture.png" },
      generationHistory: [],
      partCutterState: { stateVersion: 1 as const, sourceImageId: "torture-source", sourceCanvasSize: { width: 512, height: 512 }, mode: "manual" as const, parts, proposals: [], ignoredRegions: [], finalized: false, updatedAt: "2026-01-01T00:00:00.000Z" },
      extractedParts: parts.map((part, index) => ({ partId: part.partId, image: partImages[index % partImages.length], width: 80, height: 96, padding: 0, status: "manual" as const })),
    };
    const saved = await storage.save(generated);
    expect(saved.success).toBe(true);
    if (!saved.success) throw new Error(saved.message);
    expect(saved.approximateBytes).toBeGreaterThan(6_000_000);
    expect(saved.uniqueAssetBytes).toBeLessThan(saved.approximateBytes);
    expect(saved.metadataBytes).toBeLessThan(400_000);
    expect(saved.assetCount).toBe(17); // 13 unique masks + source + 3 deduplicated part images
    const pointer = pointers.getItem(GENERATED_CHARACTER_POINTER_KEY)!;
    expect(pointer.length).toBeLessThan(500); expect(pointer).not.toContain("data:image");
    const reloaded = await storage.load(); expect(reloaded?.success).toBe(true);
    if (!reloaded?.success) throw new Error("Torture project did not reload");
    expect(reloaded.data.extractedParts).toHaveLength(24);
    expect(reloaded.data.partCutterState?.parts[17].mask.alpha).toEqual(parts[17].mask.alpha);
  });
});
