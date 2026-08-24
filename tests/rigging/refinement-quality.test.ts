import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpCharacterPipelineProvider } from "../../src/character-generation/providers/httpCharacterPipelineProvider";
import type { ProposedCharacterPart } from "../../src/character-generation/segmentation/segmentationSchema";
import { createGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";
import {
  SnapshotCommandHistory,
  constrainProviderMaskToZone,
  createManualPart,
  createPartCutterState,
  deriveOwnershipEditHeatmap,
  ensureOwnershipPartition,
  evaluateRawAdaptiveZones,
  guidedProposalFromSegmentation,
  markOwnershipAccepted,
  ownershipSummary,
  reshapeRegionEdge,
  summarizeManualCorrectionActions,
  type AnatomicalPartitionGuide,
  type AnatomicalZone,
} from "../../src/part-cutter";
import { LOCAL_PROJECT_STORAGE_VERSION } from "../../src/project-storage/types";

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const zone: AnatomicalZone = {
  zoneId: "head", semanticType: "head", label: "Head", parentZoneId: "torso", anchorLandmarkIds: ["neck", "head"],
  bounds: { x: 1, y: 1, width: 2, height: 2 }, mask: { width: 2, height: 2, alpha: [255, 255, 0, 0] },
  geometry: { kind: "silhouette-region", centerline: [{ x: 2, y: 1 }, { x: 2, y: 2 }], polygon: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 }] },
  optional: false, refinementMargin: 1,
};
const guide: AnatomicalPartitionGuide = {
  guideVersion: 1, profile: "humanoid", sourceCanvasSize: { width: 6, height: 6 },
  landmarks: [{ landmarkId: "head", point: { x: 2, y: 1 }, parentLandmarkId: "neck" }, { landmarkId: "neck", point: { x: 2, y: 3 }, parentLandmarkId: "chest" }, { landmarkId: "chest", point: { x: 2, y: 4 }, parentLandmarkId: "pelvis" }, { landmarkId: "pelvis", point: { x: 2, y: 5 }, parentLandmarkId: "root" }, { landmarkId: "root", point: { x: 2, y: 5 }, parentLandmarkId: null }],
  zones: [zone], status: "seeded", createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
};
const providerPart = (patch: Partial<ProposedCharacterPart> = {}): ProposedCharacterPart => ({
  id: "head", name: "Provider Head", semanticType: "head", confidence: .9, confidenceSource: "provider",
  bounds: { x: 0, y: 0, width: 4, height: 4 }, mask: { width: 4, height: 4, alpha: new Array<number>(16).fill(255) },
  sourceImageRegion: { x: 0, y: 0, width: 4, height: 4 }, suggestedBoneId: "provider-root", suggestedSlotId: "provider-slot",
  suggestedZIndex: 99, pivotHint: { x: 0, y: 0 }, warnings: [], accepted: false, provenance: "generated", ...patch,
});

describe("refinement quality and correction-cost safety", () => {
  it("clips every provider pixel outside the exact adaptive zone and reports clip-fight metrics", () => {
    const constrained = constrainProviderMaskToZone(providerPart(), zone, 6, 6)!;
    expect(constrained).toMatchObject({ proposedPixelCount: 16, acceptedPixelCount: 2, clippedPixelCount: 14, clippedPercentage: .875 });
    expect(constrained.mask.alpha.filter(Boolean)).toHaveLength(2);
  });

  it("keeps one mask per zone and prevents provider semantic, pivot, and hierarchy changes", () => {
    const response = {
      segmentationId: "segment-controlled", imageWidth: 6, imageHeight: 6, warnings: [],
      providerMetadata: { provider: "test", workflow: "mask-refinement", imageConditioned: true },
      parts: [
        providerPart({ semanticType: "head", pivotHint: { x: 5, y: 5 }, suggestedBoneId: "evil-parent" }),
        providerPart({ id: "duplicate", semanticType: "head" }),
        providerPart({ id: "invented", semanticType: "accessory" }),
      ],
    };
    const proposal = guidedProposalFromSegmentation(response, guide, "controlled refine", undefined, "2026-08-22T00:00:00.000Z");
    expect(proposal.parts).toHaveLength(1);
    expect(proposal.parts[0]).toMatchObject({ proposedPartId: "head", semanticType: "head", pivot: { x: 2, y: 2 }, suggestedParent: "torso", suggestedSlot: "head-slot" });
    expect(proposal.providerMetadata).toMatchObject({ proposedPixels: 16, acceptedPixels: 2, clippedPixels: 14, clipFightZoneCount: 1 });
    expect(proposal.warnings.join(" ")).toMatch(/duplicate|invented/);
  });

  it("keeps ownership exclusive and reviewable after a local boundary transfer", () => {
    const initial = createPartCutterState("refine", 8, 6, "auto", "2026-08-22T00:00:00.000Z");
    const head = createManualPart(initial, "head", { x: 1, y: 1, width: 3, height: 4 });
    const torso = createManualPart({ ...initial, parts: [head] }, "torso", { x: 4, y: 1, width: 3, height: 4 });
    const canonical = ensureOwnershipPartition({ ...initial, parts: [head, torso] });
    const refined = reshapeRegionEdge(canonical, head.partId, "right", 5, "ai").state;
    expect(ownershipSummary(refined)).toMatchObject({ exclusive: true, unresolvedPixels: 0 });
    expect(refined.ownership?.reviewStatus).toBe("review");
    expect(markOwnershipAccepted(refined).ownership?.reviewStatus).toBe("accepted");
  });

  it("derives an exact edit heatmap and separates significant from fallback correction cost", () => {
    const initial = createPartCutterState("heat", 8, 6, "auto", "2026-08-22T00:00:00.000Z");
    const head = createManualPart(initial, "head", { x: 1, y: 1, width: 3, height: 4 });
    const torso = createManualPart({ ...initial, parts: [head] }, "torso", { x: 4, y: 1, width: 3, height: 4 });
    const before = ensureOwnershipPartition({ ...initial, parts: [head, torso] }); const after = reshapeRegionEdge(before, head.partId, "right", 5).state;
    const heatmap = deriveOwnershipEditHeatmap(before.ownership!, after.ownership!);
    expect(heatmap.changedPixels).toBeGreaterThan(0); expect(heatmap.changedRegionIds).toEqual(expect.arrayContaining([head.partId, torso.partId]));
    expect(summarizeManualCorrectionActions([
      { tool: "region-selection", significance: "minor", regionIds: [head.partId], changedPixels: 0, elapsedMs: 150 },
      { tool: "boundary-drag", significance: "significant", regionIds: [head.partId, torso.partId], changedPixels: heatmap.changedPixels, elapsedMs: 700 },
    ])).toMatchObject({ regionSelections: 1, boundaryDrags: 1, significantCorrections: 1, minorCorrections: 0, fallbackPaintingUsed: false, approximateCorrectionTimeMs: 850 });
  });

  it("grades raw exact zones without inventing semantic confidence", () => {
    const foreground = new Array<number>(36).fill(0); foreground[7] = 255; foreground[8] = 255;
    const result = evaluateRawAdaptiveZones(guide, foreground);
    expect(result[0]).toMatchObject({ area: 2, sourceForegroundPixels: 2, sourceForegroundCoverage: 1, structuralContaminationPixels: 0, readiness: "READY" });
  });

  it("marks provider timeout and unavailable paths honestly without returning mock refinement", async () => {
    const timeout = new HttpCharacterPipelineProvider("http://127.0.0.1:1", async () => { throw new Error("provider timeout"); });
    const status = await timeout.refreshCapabilities();
    expect(status.maskRefinement).toMatchObject({ available: false, mode: "unavailable", confidenceSource: "unavailable", reason: "provider timeout" });
  });

  it("makes refinement plus boundary correction exactly undoable and redoable", () => {
    const initial = createPartCutterState("undo-refine", 8, 6, "auto", "2026-08-22T00:00:00.000Z");
    const head = createManualPart(initial, "head", { x: 1, y: 1, width: 3, height: 4 }); const torso = createManualPart({ ...initial, parts: [head] }, "torso", { x: 4, y: 1, width: 3, height: 4 });
    const ai = ensureOwnershipPartition({ ...initial, parts: [head, torso], anatomicalGuide: guide }); const history = new SnapshotCommandHistory(ai);
    history.execute("Boundary correction", (state) => reshapeRegionEdge(state, head.partId, "right", 5).state); const corrected = structuredClone(history.present);
    expect(history.undo().ownership?.runs).toEqual(ai.ownership?.runs); expect(history.redo().ownership?.runs).toEqual(corrected.ownership?.runs);
  });

  it("persists refinement provenance and exact ownership through reopen and portable ZIP", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rig-refinement-")); temporaryRoots.push(root);
    const initial = createPartCutterState("persist-refine", 6, 6, "auto", "2026-08-22T00:00:00.000Z");
    const head = { ...createManualPart(initial, "head", zone.bounds, zone.mask), notes: ["Refinement provenance: provider=test; workflow=mask-refinement; clipped=14"] };
    const state = markOwnershipAccepted(ensureOwnershipPartition({ ...initial, parts: [head], anatomicalGuide: guide }));
    const project = {
      ...createGeneratedCharacterProject("Refinement persistence", "", "2026-08-22T00:00:00.000Z"),
      id: "refinement-persist",
      sourceImage: {
        generationId: "persist-refine",
        image: "data:image/png;base64,iVBORw0KGgo=",
        width: 6,
        height: 6,
        generationPrompt: "refinement persistence fixture",
        generationSettings: {},
        providerMetadata: {},
        warnings: [],
        generationMode: "fixture" as const,
        novelArtwork: false,
        provider: "test-fixture",
        sourceArtifact: "inline-test-source",
      },
      partCutterState: state,
    };
    const store = new LocalProjectStore({ cwd: root, now: () => "2026-08-22T00:00:00.000Z" });
    await store.save({ storageVersion: LOCAL_PROJECT_STORAGE_VERSION, localProjectId: project.id, project, rig: null, animations: null, selectedSkinId: null });
    const reopened = await store.load(project.id); expect(reopened.snapshot.project?.partCutterState?.ownership?.runs).toEqual(state.ownership?.runs); expect(reopened.snapshot.project?.partCutterState?.parts[0].notes[0]).toContain("provider=test");
    const exported = await store.exportSnapshot(project.id); const zipName = exported.files.find((file) => file.endsWith(".project.zip"))!; const imported = await store.importPortableZip(await readFile(path.join(exported.exportPath, zipName)), "Refinement imported");
    const roundTrip = await store.load(imported.projectId); expect(roundTrip.snapshot.project?.partCutterState?.ownership?.runs).toEqual(state.ownership?.runs); expect(roundTrip.snapshot.project?.partCutterState?.parts[0].notes[0]).toContain("workflow=mask-refinement");
  });
});
