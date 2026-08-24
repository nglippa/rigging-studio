import { describe, expect, it } from "vitest";
import { createGeneratedCharacterProject, parseGeneratedCharacterProject, serializeGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { extractPartPixels } from "../../src/character-generation/segmentation/partImageProcessor";
import { buildRigProposal } from "../../src/character-generation/rigging/rigProposalBuilder";
import { MockCharacterPipelineProvider } from "../../src/character-generation/providers/mockCharacterPipelineProvider";
import { RiggingCommandService } from "../../src/agent-control/commands/RiggingCommandService";
import { parseToolInput } from "../../src/agent-control/validation/toolSchemas";
import {
  SnapshotCommandHistory, acceptProposal, analyzeCoverage, createManualPart, createPartCutterState, evaluateRotationTest,
  applyMaskSelection, changedMaskPixels, diffPartCutProposals, mergeParts, paintMask, partCutProposalSchema, partCutToSegmentation, proposalFromSegmentation, reviseProposal, splitPart,
  anatomicalGuidePrompt, buildAnatomicalPartitionGuide, deriveRiggingExtraction, ensureOwnershipPartition, guidedProposalFromSegmentation, ownershipSummary, reshapeRegionEdge, riggingPaddingFor, setRiggingPadding,
  validatePrepare, validateReassembly, validateReconstructionAsset, validateReconstructionConsistency, viewportPointToSource,
} from "../../src/part-cutter";

const stateWithParts = () => {
  const initial = createPartCutterState("source-1", 16, 16);
  const head = createManualPart(initial, "head", { x: 4, y: 1, width: 6, height: 5 });
  const torso = createManualPart({ ...initial, parts: [head] }, "torso", { x: 3, y: 6, width: 8, height: 7 });
  return { ...initial, parts: [head, torso] };
};

const ownershipFixture = (parts: readonly { readonly semantic: Parameters<typeof createManualPart>[1]; readonly bounds: Parameters<typeof createManualPart>[2] }[], width = 12, height = 12) => {
  const initial = createPartCutterState("ownership-fixture", width, height, "auto", "2026-08-22T00:00:00.000Z");
  const records = parts.reduce<ReturnType<typeof createManualPart>[]>((current, spec) => [...current, createManualPart({ ...initial, parts: current }, spec.semantic, spec.bounds)], []);
  return ensureOwnershipPartition({ ...initial, parts: records });
};

describe("semantic Part Cutter", () => {
  it("creates manual parts with semantic hierarchy, pivots, masks, and source coordinates", () => {
    const state = stateWithParts(); const head = state.parts[0];
    expect(head.label).toBe("Head"); expect(head.suggestedParent).toBe("torso"); expect(head.mask.alpha).toHaveLength(30);
    expect(head.sourceBoundingBox).toEqual(head.boundingBox); expect(head.sourceCanvasSize).toEqual({ width: 16, height: 16 });
  });

  it("lets AI refine predetermined landmark zones but rejects invented regions and geometry", () => {
    const initial = createPartCutterState("guided", 100, 120, "auto", "2026-08-22T00:00:00.000Z");
    const guide = buildAnatomicalPartitionGuide(initial, "humanoid", "2026-08-22T00:00:00.000Z"); const headZone = guide.zones.find((zone) => zone.semanticType === "head")!;
    const response = { segmentationId: "segment-guided", imageWidth: 100, imageHeight: 120, warnings: [], providerMetadata: { provider: "test", imageConditioned: true }, parts: [
      { id: "provider-head", name: "Whatever Head", semanticType: "head" as const, confidence: .93, confidenceSource: "provider" as const, bounds: { x: 0, y: 0, width: 100, height: 60 }, mask: { width: 100, height: 60, alpha: new Array<number>(6_000).fill(255) }, sourceImageRegion: { x: 0, y: 0, width: 100, height: 60 }, suggestedBoneId: "provider-parent", suggestedSlotId: "provider-slot", suggestedZIndex: 99, pivotHint: { x: 99, y: 59 }, warnings: [], accepted: false, provenance: "generated" as const },
      { id: "provider-invented", name: "Invented Blob", semanticType: "accessory" as const, confidence: .99, confidenceSource: "provider" as const, bounds: { x: 0, y: 0, width: 10, height: 10 }, mask: { width: 10, height: 10, alpha: new Array<number>(100).fill(255) }, sourceImageRegion: { x: 0, y: 0, width: 10, height: 10 }, suggestedBoneId: "root", suggestedSlotId: "blob", suggestedZIndex: 99, pivotHint: { x: 0, y: 0 }, warnings: [], accepted: false, provenance: "generated" as const },
    ] };
    const proposal = guidedProposalFromSegmentation(response, guide, "refine zones", undefined, "2026-08-22T00:00:00.000Z");
    expect(proposal.parts.map((part) => part.proposedPartId)).toEqual(["head"]); expect(proposal.warnings.join(" ")).toContain("provider-invented");
    expect(proposal.parts[0]).toMatchObject({ semanticType: "head", suggestedParent: "torso", suggestedSlot: "head-slot", zOrder: 0 });
    expect(proposal.parts[0].boundingBox.x).toBeGreaterThanOrEqual(headZone.bounds.x - headZone.refinementMargin); expect(proposal.parts[0].boundingBox.width).toBeLessThan(100);
    expect(proposal.parts[0].pivot).not.toEqual({ x: 99, y: 59 }); expect(proposal.providerMetadata).toMatchObject({ partitionStrategy: "landmark-guided-hierarchical", guideVersion: 1 });
  });

  it("persists a stable hierarchical guide and sends only its zones to the provider", () => {
    const state = stateWithParts(); const guide = buildAnatomicalPartitionGuide(state, "humanoid", "2026-08-22T00:00:00.000Z");
    expect(guide.landmarks.find((landmark) => landmark.landmarkId === "leftElbow")?.parentLandmarkId).toBe("leftShoulder");
    expect(guide.zones.find((zone) => zone.semanticType === "leftForearm")?.parentZoneId).toBe("leftUpperArm"); expect(guide.zones.find((zone) => zone.semanticType === "head")?.bounds).toEqual(state.parts[0].boundingBox);
    const prompt = anatomicalGuidePrompt(guide, "keep pixels crisp"); expect(prompt).toContain("head=head; parent=torso"); expect(prompt).toContain("do not invent, split, merge, rename, or reposition parts");
    const project = { ...createGeneratedCharacterProject("Guided", ""), partCutterState: { ...state, anatomicalGuide: guide } }; const parsed = parseGeneratedCharacterProject(JSON.parse(serializeGeneratedCharacterProject(project)) as unknown); expect(parsed.success).toBe(true); if (parsed.success) expect(parsed.data.partCutterState?.anatomicalGuide).toEqual(guide);
  });

  it("adds and removes mask pixels as one immutable operation", () => {
    const part = stateWithParts().parts[0]; const removed = paintMask(part, 5, 2, 1, "remove"); const added = paintMask(removed, 5, 2, 1, "add");
    expect(removed.mask.alpha.filter(Boolean).length).toBeLessThan(part.mask.alpha.length); expect(added.mask.alpha.filter(Boolean).length).toBe(part.mask.alpha.length); expect(part.mask.alpha.every((value) => value === 255)).toBe(true);
  });

  it("merges and splits parts without changing source scale", () => {
    const state = stateWithParts(); const merged = mergeParts(state, state.parts.map((part) => part.partId), "Body");
    expect(merged.parts).toHaveLength(1); expect(merged.parts[0].sourceCanvasSize).toEqual({ width: 16, height: 16 });
    const split = splitPart(merged, merged.parts[0].partId, "vertical"); expect(split.parts).toHaveLength(2); expect(split.parts[0].boundingBox.width + split.parts[1].boundingBox.width).toBe(merged.parts[0].boundingBox.width);
  });

  it("validates, revises, and explicitly accepts AI proposals", async () => {
    const provider = new MockCharacterPipelineProvider(); const response = await provider.segmentCharacter({ generationId: "mock", image: "/rig-test/body-base.png", width: 256, height: 320, expectedEquipment: [] });
    const proposal = proposalFromSegmentation(response, "Cut a riggable character"); expect(partCutProposalSchema.safeParse(proposal).success).toBe(true);
    const revised = reviseProposal(proposal, "Put the shield behind the torso"); const shield = revised.parts.find((part) => part.semanticType === "offHandEquipment"); expect(shield?.layer).toBe("back"); expect(revised.parts).toHaveLength(proposal.parts.length);
    const initial = { ...createPartCutterState("mock", 256, 320, "auto"), proposals: [revised], activeProposalId: revised.proposalId }; const accepted = acceptProposal(initial, revised.proposalId, [shield!.proposedPartId]); expect(accepted.parts).toHaveLength(1); expect(accepted.proposals[0].status).toBe("pending"); expect(accepted.proposals[0].parts.length).toBe(revised.parts.length - 1); expect(accepted.activeProposalId).toBe(revised.proposalId); expect("proposedPartId" in accepted.parts[0]).toBe(false); expect("selected" in accepted.parts[0]).toBe(false);
    const preservedShield = accepted.parts[0]; const nextId = accepted.proposals[0].parts[0].proposedPartId; const acceptedNext = acceptProposal(accepted, revised.proposalId, [nextId]); expect(acceptedNext.parts.find((part) => part.partId === preservedShield.partId)).toEqual(preservedShield);
    const manualHead = createManualPart(createPartCutterState("mock", 256, 320), "head", { x: 90, y: 20, width: 70, height: 70 }); const colliding = { ...createPartCutterState("mock", 256, 320, "auto"), parts: [manualHead], proposals: [proposal], activeProposalId: proposal.proposalId }; const coexist = acceptProposal(colliding, proposal.proposalId, ["head"]); expect(coexist.parts.map((part) => [part.partId, part.provenance])).toEqual(expect.arrayContaining([[manualHead.partId, "manual"], ["head-ai", "ai"]]));
  });

  it("reports gaps, canonicalizes legacy overlap, pivot problems, and reconstruction drift", () => {
    const state = stateWithParts(); const foreground = new Array<number>(256).fill(0); for (let y = 1; y < 13; y += 1) for (let x = 3; x < 11; x += 1) foreground[y * 16 + x] = 255;
    const coverage = analyzeCoverage(state, foreground); expect(coverage.unassignedPixels).toBeGreaterThan(0); expect(coverage.unassignedRegions.length).toBeGreaterThan(0);
    const overlapped = { ...state, parts: [...state.parts, { ...state.parts[0], partId: "head-copy" }] }; expect(validateReassembly(overlapped, foreground).duplicatePixels).toBe(0); expect(ensureOwnershipPartition(overlapped).ownership?.audit[0]?.action).toBe("migrate");
    expect(evaluateRotationTest({ ...state.parts[0], occlusionState: "likely-incomplete" }, -20).passed).toBe(false);
    expect(validateReconstructionConsistency(state.parts[0], { boundingBox: { x: 0, y: 0, width: 20, height: 20 }, sourceBoundingBox: { x: 0, y: 0, width: 20, height: 20 }, pivot: { x: 20, y: 20 } }).passed).toBe(false);
  });

  it("preserves extraction alpha and original part dimensions in rig handoff", () => {
    const source = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 255, 255]) };
    const extracted = extractPartPixels({ source, bounds: { x: 0, y: 0, width: 2, height: 2 }, mask: { width: 2, height: 2, alpha: [255, 0, 128, 255] } }); expect([...extracted.data.filter((_, index) => index % 4 === 3)]).toEqual([255, 0, 128, 255]);
    const state = stateWithParts(); const segmentation = partCutToSegmentation(state); const rig = buildRigProposal({ name: "Manual Cut", parts: segmentation.parts, imageWidth: 16, imageHeight: 16 }).rig; const head = rig.attachments.find((attachment) => attachment.id === state.parts[0].partId)!; expect([head.width, head.height]).toEqual([6, 5]); expect(rig.canvas).toEqual({ width: 16, height: 16 });
  });

  it("uses shared snapshot history for compound acceptance and exact undo/redo", () => {
    const initial = createPartCutterState("source", 16, 16); const history = new SnapshotCommandHistory(initial); const part = createManualPart(initial, "head", { x: 2, y: 2, width: 4, height: 4 }); history.execute("Cut Head", (current) => ({ ...current, parts: [part] })); expect(history.present.parts).toHaveLength(1); expect(history.undo().parts).toHaveLength(0); expect(history.redo().parts[0].semanticType).toBe("head");
  });

  it("applies a lasso-shaped selection as one undoable mask edit and reports its pixel delta", () => {
    const initial = stateWithParts(); const head = initial.parts[0]; const selection = { width: 2, height: 2, alpha: [255, 255, 255, 0] };
    const result = applyMaskSelection(head, { x: 4, y: 1, width: 2, height: 2 }, selection, "remove");
    expect(result.changedPixels).toBe(3); expect(changedMaskPixels(head.mask, result.part.mask)).toBe(3);
    const history = new SnapshotCommandHistory(initial); history.execute("Lasso remove 3 pixels", (state) => ({ ...state, parts: state.parts.map((part) => part.partId === head.partId ? result.part : part) }));
    expect(history.present.parts[0].mask.alpha.filter(Boolean).length).toBe(head.mask.alpha.length - 3);
    expect(history.undo().parts[0].mask.alpha).toEqual(head.mask.alpha);
  });

  it("maps viewport coordinates to source pixels at different rendered zoom sizes", () => {
    expect(viewportPointToSource(150, 100, { left: 50, top: 20, width: 200, height: 160 }, 1000, 800)).toEqual({ x: 500, y: 400 });
    expect(viewportPointToSource(250, 180, { left: 50, top: 20, width: 400, height: 320 }, 1000, 800)).toEqual({ x: 500, y: 400 });
  });

  it("rejects a full-character reconstruction for a small part and makes accepted repair undoable", () => {
    const initial = stateWithParts(); const head = initial.parts[0]; expect(validateReconstructionAsset(head, 16, 16)).toMatchObject({ passed: false, status: "REJECT" });
    expect(validateReconstructionAsset(head, 12, 10).status).toBe("REJECT");
    expect(validateReconstructionAsset(head, 6, 5, { pivot: { x: head.pivot.x + 1, y: head.pivot.y + 1 } }).status).toBe("WARNING");
    const history = new SnapshotCommandHistory(initial); history.execute("Use reconstructed head", (state) => ({ ...state, parts: state.parts.map((part) => part.partId === head.partId ? { ...part, reconstructionImage: "data:image/png;base64,repair", provenance: "reconstructed" as const, occlusionState: "reconstructed" as const } : part) }));
    expect(history.present.parts[0].provenance).toBe("reconstructed"); expect(history.undo().parts[0].reconstructionImage).toBeUndefined();
  });

  it("calculates refinement diffs in stable source coordinates when the bounding box changes", () => {
    const mask = { width: 2, height: 2, alpha: [255, 255, 255, 255] }; const base = proposalFromSegmentation({ segmentationId: "source", imageWidth: 8, imageHeight: 8, warnings: [], providerMetadata: { provider: "test", imageConditioned: true }, parts: [{ id: "head", name: "Head", semanticType: "head", confidence: null, confidenceSource: "unavailable", bounds: { x: 2, y: 2, width: 2, height: 2 }, mask, sourceImageRegion: { x: 2, y: 2, width: 2, height: 2 }, suggestedBoneId: "torso", suggestedSlotId: "head-slot", suggestedZIndex: 1, pivotHint: { x: 3, y: 3 }, warnings: [], accepted: false, provenance: "generated" }] }, "initial");
    const revised = { ...base, proposalId: "revised", parentProposalId: base.proposalId, parts: base.parts.map((part) => ({ ...part, boundingBox: { x: 1, y: 2, width: 3, height: 2 }, sourceBoundingBox: { x: 1, y: 2, width: 3, height: 2 }, mask: { width: 3, height: 2, alpha: [255, 255, 255, 0, 255, 255] } })) };
    expect(diffPartCutProposals(base, revised)).toMatchObject({ pixelsAdded: 1, pixelsRemoved: 0, boundingBoxesChanged: 1 });
  });

  it("blocks missing humanoid chains but permits an explicit incomplete override", () => {
    const state = stateWithParts(); const blocked = validatePrepare(state, { profile: "humanoid" });
    expect(blocked.canBuild).toBe(false); expect(blocked.issues.find((issue) => issue.id === "prepare-missing-leftUpperArm")?.mode).toBe("prepare");
    expect(validatePrepare(state, { profile: "humanoid", allowIncomplete: true }).canBuild).toBe(true);
  });

  it("serializes Part Cutter state inside GeneratedCharacterProject", () => {
    const project = { ...createGeneratedCharacterProject("Cut", ""), partCutterState: stateWithParts() }; const parsed = parseGeneratedCharacterProject(JSON.parse(serializeGeneratedCharacterProject(project)) as unknown); expect(parsed.success).toBe(true); if (parsed.success) expect(parsed.data.partCutterState?.parts[1].semanticType).toBe("torso");
  });

  it("pushes shared Head boundaries into Hair, Neck, and Torso with exclusive ownership", () => {
    const initial = ownershipFixture([
      { semantic: "hair", bounds: { x: 2, y: 0, width: 8, height: 2 } },
      { semantic: "head", bounds: { x: 2, y: 2, width: 8, height: 3 } },
      { semantic: "custom", bounds: { x: 4, y: 5, width: 4, height: 2 } },
      { semantic: "torso", bounds: { x: 2, y: 7, width: 8, height: 4 } },
    ]);
    const head = initial.parts.find((part) => part.semanticType === "head")!; const hair = initial.parts.find((part) => part.semanticType === "hair")!; const neck = initial.parts.find((part) => part.semanticType === "custom")!;
    const hairBefore = hair.mask.alpha.filter(Boolean).length; const upward = reshapeRegionEdge(initial, head.partId, "top", 1);
    expect(upward.yieldedRegionIds).toContain(hair.partId); expect(upward.state.parts.find((part) => part.partId === hair.partId)!.mask.alpha.filter(Boolean).length).toBeLessThan(hairBefore);
    const downward = reshapeRegionEdge(upward.state, head.partId, "bottom", 8);
    expect(downward.yieldedRegionIds).toEqual(expect.arrayContaining([neck.partId, initial.parts.find((part) => part.semanticType === "torso")!.partId]));
    expect(ownershipSummary(downward.state).exclusive).toBe(true); expect(analyzeCoverage(downward.state).overlappingPixels).toBe(0);
  });

  it("keeps an arm boundary transfer local and one undo restores the exact partition", () => {
    const initial = ownershipFixture([
      { semantic: "leftUpperArm", bounds: { x: 0, y: 3, width: 3, height: 5 } },
      { semantic: "torso", bounds: { x: 3, y: 2, width: 5, height: 7 } },
      { semantic: "rightUpperArm", bounds: { x: 8, y: 3, width: 3, height: 5 } },
    ]);
    const left = initial.parts.find((part) => part.semanticType === "leftUpperArm")!; const right = initial.parts.find((part) => part.semanticType === "rightUpperArm")!; const rightBefore = right.mask.alpha;
    const history = new SnapshotCommandHistory(initial); history.execute("Expand left upper arm", (state) => reshapeRegionEdge(state, left.partId, "right", 5).state);
    expect(history.present.parts.find((part) => part.partId === right.partId)!.mask.alpha).toEqual(rightBefore); expect(analyzeCoverage(history.present).overlappingPixels).toBe(0);
    expect(history.undo().ownership?.runs).toEqual(initial.ownership?.runs);
  });

  it("keeps Hand/Sword source ownership exclusive while rig padding remains derived", () => {
    const initial = ownershipFixture([
      { semantic: "rightHand", bounds: { x: 1, y: 3, width: 3, height: 4 } },
      { semantic: "mainHandEquipment", bounds: { x: 4, y: 2, width: 6, height: 6 } },
    ]);
    const hand = initial.parts.find((part) => part.semanticType === "rightHand")!; const sword = initial.parts.find((part) => part.semanticType === "mainHandEquipment")!; const swordBefore = sword.mask.alpha.filter(Boolean).length;
    const expanded = reshapeRegionEdge(initial, hand.partId, "right", 6).state; expect(expanded.parts.find((part) => part.partId === sword.partId)!.mask.alpha.filter(Boolean).length).toBeLessThan(swordBefore); expect(analyzeCoverage(expanded).overlappingPixels).toBe(0);
    const padded = setRiggingPadding(expanded, hand.partId, 6); expect(riggingPaddingFor(padded, hand.partId)).toBe(6); expect(padded.ownership?.runs).toEqual(expanded.ownership?.runs); const derived = deriveRiggingExtraction(padded, hand.partId); expect(derived.mask.alpha.filter(Boolean).length).toBeGreaterThan(padded.parts.find((part) => part.partId === hand.partId)!.mask.alpha.filter(Boolean).length);
  });

  it("splits and merges exclusive regions without losing foreground", () => {
    const initial = ownershipFixture([{ semantic: "cape", bounds: { x: 2, y: 2, width: 8, height: 8 } }]); const assigned = ownershipSummary(initial).assignedPixels;
    const split = splitPart(initial, initial.parts[0].partId, "vertical"); expect(split.parts).toHaveLength(2); expect(ownershipSummary(split).assignedPixels).toBe(assigned); expect(analyzeCoverage(split).overlappingPixels).toBe(0);
    const merged = mergeParts(split, split.parts.map((part) => part.partId), "Cape"); expect(merged.parts).toHaveLength(1); expect(ownershipSummary(merged).assignedPixels).toBe(assigned); expect(analyzeCoverage(merged).overlappingPixels).toBe(0);
  });
});

describe("Part Cutter MCP boundary", () => {
  it("validates semantic tools and rejects arbitrary file fields", () => {
    expect(parseToolInput("parts_set_mask", { partId: "head", mask: { width: 1, height: 1, alpha: [255] } }).success).toBe(true);
    expect(parseToolInput("parts_set_mask", { partId: "head", path: "/tmp/image.png", mask: { width: 1, height: 1, alpha: [255] } }).success).toBe(false);
    expect(parseToolInput("parts_accept_proposal", { proposalId: "proposal", confirm: true }).success).toBe(true);
    expect(parseToolInput("part_approve_reconstruction", { partId: "head" }).success).toBe(false);
    expect(parseToolInput("part_approve_reconstruction", { partId: "head", confirm: true }).success).toBe(true);
    expect(parseToolInput("character_ai_cut", { instruction: "cut", workflow: { arbitrary: true } }).success).toBe(false);
    expect(parseToolInput("part_region_transfer_boundary", { partId: "head", edge: "bottom", coordinate: 42 }).success).toBe(true);
    expect(parseToolInput("part_region_assign_polygon", { partId: "head", points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 3, y: 5 }], path: "/tmp/mask.png" }).success).toBe(false);
  });

  it("creates a reviewable AI proposal and accepts only an explicit selection", async () => {
    const service = new RiggingCommandService({ characterProvider: new MockCharacterPipelineProvider() }); const project = createGeneratedCharacterProject("Agent Cut", "knight"); service.activateProjectFromUi(project);
    await service.executeTool("character_generate_image", { mode: "generate" }); const proposal = await service.executeTool("parts_auto_cut", { instruction: "Cut this sprite into riggable parts" }); expect(proposal.success).toBe(true); if (!proposal.success) throw new Error("Proposal failed"); expect(proposal.requiresReview).toBe(true); expect(proposal.productionReady).toBe(false); expect(proposal.provider).toMatchObject({ mock: true, imageConditioned: false });
    const proposalId = String(proposal.proposalId); const accepted = await service.executeTool("parts_accept_proposal", { proposalId, partIds: ["head"], confirm: true }); expect(accepted.success).toBe(true); const status = await service.executeTool("parts_get_status", { includeParts: true }); expect(status.success).toBe(true); if (!status.success) throw new Error("Status failed"); expect(status.partCount).toBe(1);
    const revision = await service.executeTool("parts_prompt_cut", { instruction: "Remove torso pixels from the forearm", proposalId }); expect(revision.success).toBe(false); if (revision.success) throw new Error("Expected refinement failure"); expect(revision.errors[0]?.message).toMatch(/image-conditioned mask refinement/i);
  });

  it("exposes agent region edits through the same exclusive ownership engine", async () => {
    const state = ownershipFixture([
      { semantic: "leftUpperArm", bounds: { x: 0, y: 3, width: 3, height: 5 } },
      { semantic: "torso", bounds: { x: 3, y: 2, width: 5, height: 7 } },
      { semantic: "rightUpperArm", bounds: { x: 8, y: 3, width: 3, height: 5 } },
    ]);
    const base = createGeneratedCharacterProject("Agent Ownership", ""); const project = { ...base, stage: "prepare" as const, sourceImage: { generationId: "ownership-fixture", image: "data:image/png;base64,AAAA", width: 12, height: 12, generationPrompt: "fixture", generationSettings: {}, providerMetadata: {}, warnings: [], generationMode: "imported_external" as const, novelArtwork: true, provider: "test", sourceArtifact: "fixture.png" }, generationHistory: [], partCutterState: state };
    const service = new RiggingCommandService(); service.activateProjectFromUi(project); const arm = state.parts.find((part) => part.semanticType === "leftUpperArm")!; const right = state.parts.find((part) => part.semanticType === "rightUpperArm")!;
    const transferred = await service.executeTool("part_region_transfer_boundary", { partId: arm.partId, edge: "right", coordinate: 5 }); expect(transferred).toMatchObject({ success: true, exclusive: true, undoable: true });
    const relabeled = await service.executeTool("part_region_relabel", { partId: right.partId, semanticType: "rightShoulderArmor" }); expect(relabeled).toMatchObject({ success: true, semanticType: "rightShoulderArmor", pixelsChanged: 0 });
    const status = await service.executeTool("part_region_get", {}); expect(status).toMatchObject({ success: true, exclusive: true, regionCount: 3 });
  });

  it("installs reconstruction as a proposal and rejection preserves the accepted source part", async () => {
    const service = new RiggingCommandService({ characterProvider: new MockCharacterPipelineProvider() });
    await service.executeTool("project_create", { name: "Repair", prompt: "knight" }); await service.executeTool("character_generate_image", { mode: "generate" });
    const cut = await service.executeTool("parts_auto_cut", { instruction: "Cut parts" }); if (!cut.success) throw new Error("Cut proposal failed");
    await service.executeTool("parts_accept_proposal", { proposalId: String(cut.proposalId), partIds: ["head"], confirm: true });
    const status = await service.executeTool("parts_get_status", { includeParts: true }); if (!status.success) throw new Error("Part status failed"); const head = (status.parts as readonly { readonly partId: string; readonly boundingBox: { readonly width: number; readonly height: number }; readonly reconstructionImage?: string }[])[0];
    const installed = await service.executeTool("part_install_reconstruction_proposal", { partId: head.partId, result: { reconstructionId: "repair-1", partId: head.partId, image: "data:image/png;base64,AAAA", width: head.boundingBox.width, height: head.boundingBox.height, providerMetadata: { provider: "fake-image-conditioned", scaleLocked: true }, warnings: [], runtimeMs: 12 } });
    expect(installed).toMatchObject({ success: true, requiresVisualInspection: true, requiresApproval: true });
    const rejected = await service.executeTool("part_reject_reconstruction", { partId: head.partId, reason: "attachment edge is inconsistent", confirm: true }); expect(rejected).toMatchObject({ success: true, originalPreserved: true });
    const after = await service.executeTool("parts_get_status", { includeParts: true }); if (!after.success) throw new Error("Part status failed"); expect((after.parts as readonly { readonly reconstructionImage?: string }[])[0]?.reconstructionImage).toBeUndefined();
  });
});
