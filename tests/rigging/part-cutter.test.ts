import { describe, expect, it } from "vitest";
import { createGeneratedCharacterProject, parseGeneratedCharacterProject, serializeGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { extractPartPixels } from "../../src/character-generation/segmentation/partImageProcessor";
import { buildRigProposal } from "../../src/character-generation/rigging/rigProposalBuilder";
import { MockCharacterPipelineProvider } from "../../src/character-generation/providers/mockCharacterPipelineProvider";
import { RiggingCommandService } from "../../src/agent-control/commands/RiggingCommandService";
import { parseToolInput } from "../../src/agent-control/validation/toolSchemas";
import {
  SnapshotCommandHistory, acceptProposal, analyzeCoverage, createManualPart, createPartCutterState, evaluateRotationTest,
  applyMaskSelection, changedMaskPixels, mergeParts, paintMask, partCutProposalSchema, partCutToSegmentation, proposalFromSegmentation, reviseProposal, splitPart,
  validatePrepare, validateReassembly, validateReconstructionAsset, validateReconstructionConsistency, viewportPointToSource,
} from "../../src/part-cutter";

const stateWithParts = () => {
  const initial = createPartCutterState("source-1", 16, 16);
  const head = createManualPart(initial, "head", { x: 4, y: 1, width: 6, height: 5 });
  const torso = createManualPart({ ...initial, parts: [head] }, "torso", { x: 3, y: 6, width: 8, height: 7 });
  return { ...initial, parts: [head, torso] };
};

describe("semantic Part Cutter", () => {
  it("creates manual parts with semantic hierarchy, pivots, masks, and source coordinates", () => {
    const state = stateWithParts(); const head = state.parts[0];
    expect(head.label).toBe("Head"); expect(head.suggestedParent).toBe("torso"); expect(head.mask.alpha).toHaveLength(30);
    expect(head.sourceBoundingBox).toEqual(head.boundingBox); expect(head.sourceCanvasSize).toEqual({ width: 16, height: 16 });
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
    const manualHead = createManualPart(createPartCutterState("mock", 256, 320), "head", { x: 90, y: 20, width: 70, height: 70 }); const colliding = { ...createPartCutterState("mock", 256, 320, "auto"), parts: [manualHead], proposals: [proposal], activeProposalId: proposal.proposalId }; const coexist = acceptProposal(colliding, proposal.proposalId, ["head"]); expect(coexist.parts.map((part) => [part.partId, part.provenance])).toEqual(expect.arrayContaining([[manualHead.partId, "manual"], ["head-ai", "ai"]]));
  });

  it("reports gaps, overlap, pivot problems, and reconstruction drift", () => {
    const state = stateWithParts(); const foreground = new Array<number>(256).fill(0); for (let y = 1; y < 13; y += 1) for (let x = 3; x < 11; x += 1) foreground[y * 16 + x] = 255;
    const coverage = analyzeCoverage(state, foreground); expect(coverage.unassignedPixels).toBeGreaterThan(0); expect(coverage.unassignedRegions.length).toBeGreaterThan(0);
    const overlapped = { ...state, parts: [...state.parts, { ...state.parts[0], partId: "head-copy" }] }; expect(validateReassembly(overlapped, foreground).duplicatePixels).toBeGreaterThan(0);
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
    const initial = stateWithParts(); const head = initial.parts[0]; expect(validateReconstructionAsset(head, 16, 16).passed).toBe(false);
    const history = new SnapshotCommandHistory(initial); history.execute("Use reconstructed head", (state) => ({ ...state, parts: state.parts.map((part) => part.partId === head.partId ? { ...part, reconstructionImage: "data:image/png;base64,repair", provenance: "reconstructed" as const, occlusionState: "reconstructed" as const } : part) }));
    expect(history.present.parts[0].provenance).toBe("reconstructed"); expect(history.undo().parts[0].reconstructionImage).toBeUndefined();
  });

  it("blocks missing humanoid chains but permits an explicit incomplete override", () => {
    const state = stateWithParts(); const blocked = validatePrepare(state, { profile: "humanoid" });
    expect(blocked.canBuild).toBe(false); expect(blocked.issues.find((issue) => issue.id === "prepare-missing-leftUpperArm")?.mode).toBe("prepare");
    expect(validatePrepare(state, { profile: "humanoid", allowIncomplete: true }).canBuild).toBe(true);
  });

  it("serializes Part Cutter state inside GeneratedCharacterProject", () => {
    const project = { ...createGeneratedCharacterProject("Cut", ""), partCutterState: stateWithParts() }; const parsed = parseGeneratedCharacterProject(JSON.parse(serializeGeneratedCharacterProject(project)) as unknown); expect(parsed.success).toBe(true); if (parsed.success) expect(parsed.data.partCutterState?.parts[1].semanticType).toBe("torso");
  });
});

describe("Part Cutter MCP boundary", () => {
  it("validates semantic tools and rejects arbitrary file fields", () => {
    expect(parseToolInput("parts_set_mask", { partId: "head", mask: { width: 1, height: 1, alpha: [255] } }).success).toBe(true);
    expect(parseToolInput("parts_set_mask", { partId: "head", path: "/tmp/image.png", mask: { width: 1, height: 1, alpha: [255] } }).success).toBe(false);
    expect(parseToolInput("parts_accept_proposal", { proposalId: "proposal", confirm: true }).success).toBe(true);
  });

  it("creates a reviewable AI proposal and accepts only an explicit selection", async () => {
    const service = new RiggingCommandService({ characterProvider: new MockCharacterPipelineProvider() }); const project = createGeneratedCharacterProject("Agent Cut", "knight"); service.activateProjectFromUi(project);
    await service.executeTool("character_generate_image", { mode: "generate" }); const proposal = await service.executeTool("parts_auto_cut", { instruction: "Cut this sprite into riggable parts" }); expect(proposal.success).toBe(true); if (!proposal.success) throw new Error("Proposal failed"); expect(proposal.requiresReview).toBe(true); expect(proposal.productionReady).toBe(false); expect(proposal.provider).toMatchObject({ mock: true, imageConditioned: false });
    const proposalId = String(proposal.proposalId); const accepted = await service.executeTool("parts_accept_proposal", { proposalId, partIds: ["head"], confirm: true }); expect(accepted.success).toBe(true); const status = await service.executeTool("parts_get_status", { includeParts: true }); expect(status.success).toBe(true); if (!status.success) throw new Error("Status failed"); expect(status.partCount).toBe(1);
    const revision = await service.executeTool("parts_prompt_cut", { instruction: "Remove torso pixels from the forearm", proposalId }); expect(revision.success).toBe(false); if (revision.success) throw new Error("Expected refinement failure"); expect(revision.errors[0]?.message).toMatch(/image-conditioned mask refinement/i);
  });
});
