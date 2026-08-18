import { partTypeToBoneId, partTypeToSlotId, type PartType } from "../character-generation/segmentation/partTaxonomy";
import type { CharacterSegmentationResponse, ProposedCharacterPart, Rect, SegmentationMask } from "../character-generation/segmentation/segmentationSchema";
import { SEMANTIC_TAXONOMY, type PartLayerGroup, type PartSemanticType } from "./semanticTaxonomy";
import { partCutProposalSchema, type PartCutProposal, type PartCutRecord, type PartCutterState, type ProposedPartCut } from "./schema";

const now = (): string => new Date().toISOString();
const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "part";
export const safePartId = (label: string, existing: readonly string[]): string => {
  const base = slug(label); const used = new Set(existing); let id = base; let suffix = 2;
  while (used.has(id)) { id = `${base}-${suffix}`; suffix += 1; }
  return id;
};

export const fullMask = (bounds: Rect): SegmentationMask => {
  const width = Math.max(1, Math.round(bounds.width)); const height = Math.max(1, Math.round(bounds.height));
  return { width, height, alpha: new Array<number>(width * height).fill(255) };
};

const layerOrder: Readonly<Record<PartLayerGroup, number>> = { back: -10, body: 0, front: 10 };
export const estimateSemanticPivot = (semanticType: PartSemanticType, bounds: Rect): { x: number; y: number } => {
  const horizontal = semanticType.includes("Left") ? .72 : semanticType.includes("Right") ? .28 : .5;
  const vertical = /head|helmet|hair|face|beard/i.test(semanticType) ? .86 : /Foot|Equipment/i.test(semanticType) ? .35 : .18;
  return { x: bounds.x + bounds.width * horizontal, y: bounds.y + bounds.height * vertical };
};

export function createManualPart(state: PartCutterState, semanticType: PartSemanticType, bounds: Rect, mask = fullMask(bounds), label = SEMANTIC_TAXONOMY[semanticType].label): PartCutRecord {
  const defaults = SEMANTIC_TAXONOMY[semanticType]; const partId = safePartId(label, state.parts.map((part) => part.partId));
  return { partId, label, semanticType, mask, boundingBox: bounds, sourceBoundingBox: bounds, sourceCanvasSize: state.sourceCanvasSize,
    pivot: estimateSemanticPivot(semanticType, bounds), suggestedParent: defaults.suggestedParentBone, suggestedSlot: `${partId}-slot`, zOrder: layerOrder[defaults.defaultLayerGroup],
    layer: defaults.defaultLayerGroup, confidence: 1, articulated: defaults.articulated, equipment: defaults.equipment, occlusionState: "unknown", provenance: "manual", accepted: true, notes: [], };
}

const partSemanticToLegacy = (type: PartSemanticType): PartType => ({
  root: "rootReference", pelvis: "torso", beard: "hair", leftShoulderArmor: "shoulderLeft", rightShoulderArmor: "shoulderRight", custom: "accessory",
} as Partial<Record<PartSemanticType, PartType>>)[type] ?? type as PartType;

export function partCutToSegmentation(state: PartCutterState): CharacterSegmentationResponse {
  const parts: ProposedCharacterPart[] = state.parts.filter((part) => part.accepted).map((part) => {
    const semanticType = partSemanticToLegacy(part.semanticType);
    return { id: part.partId, name: part.label, semanticType, confidence: part.confidence, bounds: part.boundingBox, mask: part.mask,
      sourceImageRegion: part.sourceBoundingBox, suggestedBoneId: part.suggestedParent || partTypeToBoneId(semanticType), suggestedSlotId: part.suggestedSlot || partTypeToSlotId(semanticType),
      suggestedZIndex: part.zOrder, pivotHint: part.pivot, warnings: part.notes, accepted: true, provenance: part.provenance === "ai" ? "accepted" : part.provenance === "reconstructed" ? "reconstructed" : "manual", };
  });
  return { segmentationId: `cut-${state.sourceImageId}`, imageWidth: state.sourceCanvasSize.width, imageHeight: state.sourceCanvasSize.height, parts, warnings: [], providerMetadata: { provider: "part-cutter", semantic: true } };
}

export function proposalFromSegmentation(response: CharacterSegmentationResponse, instruction: string, parentProposalId?: string, createdAt = now()): PartCutProposal {
  const parts: ProposedPartCut[] = response.parts.map((part) => {
    const semanticType = (part.semanticType === "rootReference" ? "root" : part.semanticType === "shoulderLeft" ? "leftShoulderArmor" : part.semanticType === "shoulderRight" ? "rightShoulderArmor" : part.semanticType) as PartSemanticType;
    const defaults = SEMANTIC_TAXONOMY[semanticType] ?? SEMANTIC_TAXONOMY.custom;
    return { proposedPartId: part.id, label: part.name, semanticType, mask: part.mask ?? fullMask(part.bounds), boundingBox: part.bounds, sourceBoundingBox: part.sourceImageRegion,
      sourceCanvasSize: { width: response.imageWidth, height: response.imageHeight }, pivot: part.pivotHint, suggestedParent: part.suggestedBoneId || defaults.suggestedParentBone,
      suggestedSlot: part.suggestedSlotId, zOrder: part.suggestedZIndex, layer: part.suggestedZIndex < -1 ? "back" : part.suggestedZIndex > 1 ? "front" : "body",
      confidence: part.confidence, articulated: defaults.articulated, equipment: defaults.equipment, occlusionState: part.warnings.some((warning) => /hidden|occluded|beneath|overlap/i.test(warning)) ? "likely-incomplete" : "complete",
      provenance: "ai", selected: true, notes: part.warnings,
    };
  });
  return partCutProposalSchema.parse({ proposalId: `cut-proposal-${Date.now().toString(36)}`, sourceImageId: response.segmentationId.replace(/^segment-/, ""), instruction, parts, warnings: response.warnings, assumptions: ["Source scale and canvas coordinates remain unchanged", "No proposed cut is accepted automatically"], status: "pending", providerMetadata: response.providerMetadata, ...(parentProposalId ? { parentProposalId } : {}), createdAt });
}

export function acceptProposal(state: PartCutterState, proposalId: string, selectedIds?: readonly string[]): PartCutterState {
  const proposal = state.proposals.find((item) => item.proposalId === proposalId); if (!proposal || proposal.status !== "pending") throw new Error(`Pending proposal ${proposalId} was not found`);
  const chosen = new Set(selectedIds ?? proposal.parts.filter((part) => part.selected).map((part) => part.proposedPartId));
  const existing = new Map(state.parts.map((part) => [part.partId, part]));
  proposal.parts.filter((part) => chosen.has(part.proposedPartId)).forEach(({ proposedPartId, selected, ...part }) => { void selected; let partId = proposedPartId; const collision = existing.get(partId); if (collision && collision.provenance !== "ai") { const base = `${proposedPartId}-ai`; partId = base; let suffix = 2; while (existing.has(partId)) { partId = `${base}-${suffix}`; suffix += 1; } } existing.set(partId, { ...part, partId, accepted: true }); });
  const remaining = proposal.parts.filter((part) => !chosen.has(part.proposedPartId));
  return {
    ...state,
    parts: [...existing.values()],
    proposals: state.proposals.map((item) => item.proposalId === proposalId ? { ...item, parts: remaining, status: remaining.length ? "pending" : "accepted" } : item),
    activeProposalId: remaining.length ? proposalId : undefined,
    finalized: false,
    updatedAt: now(),
  };
}

export function proposalToSegmentation(proposal: PartCutProposal): CharacterSegmentationResponse {
  const width = proposal.parts[0]?.sourceCanvasSize.width ?? 1;
  const height = proposal.parts[0]?.sourceCanvasSize.height ?? 1;
  return {
    segmentationId: `segment-${proposal.sourceImageId}`,
    imageWidth: width,
    imageHeight: height,
    parts: proposal.parts.map((part) => ({
      id: part.proposedPartId,
      name: part.label,
      semanticType: partSemanticToLegacy(part.semanticType),
      confidence: part.confidence,
      bounds: part.boundingBox,
      mask: part.mask,
      sourceImageRegion: part.sourceBoundingBox,
      suggestedBoneId: part.suggestedParent ?? partTypeToBoneId(partSemanticToLegacy(part.semanticType)),
      suggestedSlotId: part.suggestedSlot,
      suggestedZIndex: part.zOrder,
      pivotHint: part.pivot,
      warnings: part.notes,
      accepted: false,
      provenance: "generated",
    })),
    warnings: proposal.warnings,
    providerMetadata: proposal.providerMetadata ?? {},
  };
}

export type ProposalDiff = {
  readonly pixelsAdded: number;
  readonly pixelsRemoved: number;
  readonly boundingBoxesChanged: number;
  readonly semanticsChanged: number;
  readonly layersChanged: number;
};

export function diffPartCutProposals(before: PartCutProposal, after: PartCutProposal): ProposalDiff {
  const prior = new Map(before.parts.map((part) => [part.proposedPartId, part]));
  let pixelsAdded = 0; let pixelsRemoved = 0; let boundingBoxesChanged = 0; let semanticsChanged = 0; let layersChanged = 0;
  after.parts.forEach((part) => {
    const original = prior.get(part.proposedPartId);
    if (!original) { pixelsAdded += part.mask.alpha.filter(Boolean).length; boundingBoxesChanged += 1; semanticsChanged += 1; return; }
    const length = Math.max(original.mask.alpha.length, part.mask.alpha.length);
    for (let index = 0; index < length; index += 1) {
      const was = (original.mask.alpha[index] ?? 0) > 0; const next = (part.mask.alpha[index] ?? 0) > 0;
      if (!was && next) pixelsAdded += 1; else if (was && !next) pixelsRemoved += 1;
    }
    if (JSON.stringify(original.boundingBox) !== JSON.stringify(part.boundingBox)) boundingBoxesChanged += 1;
    if (original.semanticType !== part.semanticType) semanticsChanged += 1;
    if (original.layer !== part.layer) layersChanged += 1;
  });
  before.parts.filter((part) => !after.parts.some((candidate) => candidate.proposedPartId === part.proposedPartId)).forEach((part) => { pixelsRemoved += part.mask.alpha.filter(Boolean).length; boundingBoxesChanged += 1; });
  return { pixelsAdded, pixelsRemoved, boundingBoxesChanged, semanticsChanged, layersChanged };
}

export const rejectProposal = (state: PartCutterState, proposalId: string): PartCutterState => ({ ...state, proposals: state.proposals.map((proposal) => proposal.proposalId === proposalId ? { ...proposal, status: "rejected" } : proposal), activeProposalId: state.activeProposalId === proposalId ? undefined : state.activeProposalId, updatedAt: now() });

export function mergeParts(state: PartCutterState, ids: readonly string[], label?: string): PartCutterState {
  if (ids.length < 2) throw new Error("Select at least two parts to merge"); const selected = state.parts.filter((part) => ids.includes(part.partId));
  if (selected.length !== ids.length) throw new Error("One or more merge parts do not exist");
  const x = Math.min(...selected.map((part) => part.boundingBox.x)); const y = Math.min(...selected.map((part) => part.boundingBox.y));
  const right = Math.max(...selected.map((part) => part.boundingBox.x + part.boundingBox.width)); const bottom = Math.max(...selected.map((part) => part.boundingBox.y + part.boundingBox.height));
  const bounds = { x, y, width: right - x, height: bottom - y }; const base = selected[0]; const alpha = new Array<number>(Math.round(bounds.width) * Math.round(bounds.height)).fill(0);
  selected.forEach((part) => { const ox = Math.round(part.boundingBox.x - x); const oy = Math.round(part.boundingBox.y - y); for (let py = 0; py < part.mask.height; py += 1) for (let px = 0; px < part.mask.width; px += 1) alpha[(oy + py) * Math.round(bounds.width) + ox + px] = Math.max(alpha[(oy + py) * Math.round(bounds.width) + ox + px] ?? 0, part.mask.alpha[py * part.mask.width + px] ?? 0); });
  const merged = { ...base, partId: safePartId(label ?? base.label, state.parts.filter((part) => !ids.includes(part.partId)).map((part) => part.partId)), label: label ?? base.label, mask: { width: Math.round(bounds.width), height: Math.round(bounds.height), alpha }, boundingBox: bounds, sourceBoundingBox: bounds, pivot: estimateSemanticPivot(base.semanticType, bounds), provenance: "manual" as const, notes: [...new Set(selected.flatMap((part) => part.notes))] };
  return { ...state, parts: [...state.parts.filter((part) => !ids.includes(part.partId)), merged], finalized: false, updatedAt: now() };
}

export function splitPart(state: PartCutterState, partId: string, axis: "horizontal" | "vertical" = "vertical"): PartCutterState {
  const part = state.parts.find((item) => item.partId === partId); if (!part) throw new Error(`Part ${partId} does not exist`);
  const vertical = axis === "vertical"; const firstWidth = vertical ? Math.max(1, Math.floor(part.mask.width / 2)) : part.mask.width; const firstHeight = vertical ? part.mask.height : Math.max(1, Math.floor(part.mask.height / 2));
  const make = (second: boolean): PartCutRecord => { const width = vertical ? (second ? part.mask.width - firstWidth : firstWidth) : part.mask.width; const height = vertical ? part.mask.height : (second ? part.mask.height - firstHeight : firstHeight); const sx = vertical && second ? firstWidth : 0; const sy = !vertical && second ? firstHeight : 0; const alpha: number[] = [];
    for (let py = 0; py < height; py += 1) for (let px = 0; px < width; px += 1) alpha.push(part.mask.alpha[(sy + py) * part.mask.width + sx + px] ?? 0);
    const bounds = { x: part.boundingBox.x + sx, y: part.boundingBox.y + sy, width, height }; return { ...part, partId: `${part.partId}-${second ? "b" : "a"}`, label: `${part.label} ${second ? "B" : "A"}`, mask: { width, height, alpha }, boundingBox: bounds, sourceBoundingBox: bounds, pivot: estimateSemanticPivot(part.semanticType, bounds), provenance: "manual" };
  };
  return { ...state, parts: state.parts.flatMap((item) => item.partId === partId ? [make(false), make(true)] : [item]), finalized: false, updatedAt: now() };
}

export function paintMask(part: PartCutRecord, x: number, y: number, radius: number, mode: "add" | "remove"): PartCutRecord {
  const alpha = [...part.mask.alpha]; const localX = Math.round(x - part.boundingBox.x); const localY = Math.round(y - part.boundingBox.y); const value = mode === "add" ? 255 : 0;
  for (let py = Math.max(0, localY - radius); py < Math.min(part.mask.height, localY + radius + 1); py += 1) for (let px = Math.max(0, localX - radius); px < Math.min(part.mask.width, localX + radius + 1); px += 1) if (Math.hypot(px - localX, py - localY) <= radius) alpha[py * part.mask.width + px] = value;
  return { ...part, mask: { ...part.mask, alpha }, provenance: "manual" };
}

export const changedMaskPixels = (before: SegmentationMask, after: SegmentationMask): number => {
  const length = Math.max(before.alpha.length, after.alpha.length); let changed = 0;
  for (let index = 0; index < length; index += 1) if ((before.alpha[index] ?? 0) !== (after.alpha[index] ?? 0)) changed += 1;
  return changed;
};

export function applyMaskSelection(part: PartCutRecord, bounds: Rect, selection: SegmentationMask, mode: "add" | "remove"): { readonly part: PartCutRecord; readonly changedPixels: number } {
  const left = mode === "add" ? Math.min(part.boundingBox.x, bounds.x) : part.boundingBox.x;
  const top = mode === "add" ? Math.min(part.boundingBox.y, bounds.y) : part.boundingBox.y;
  const right = mode === "add" ? Math.max(part.boundingBox.x + part.mask.width, bounds.x + selection.width) : part.boundingBox.x + part.mask.width;
  const bottom = mode === "add" ? Math.max(part.boundingBox.y + part.mask.height, bounds.y + selection.height) : part.boundingBox.y + part.mask.height;
  const width = Math.max(1, Math.round(right - left)); const height = Math.max(1, Math.round(bottom - top));
  const alpha = new Array<number>(width * height).fill(0);
  const copy = (source: SegmentationMask, sourceX: number, sourceY: number, operation: "max" | "remove"): void => {
    const offsetX = Math.round(sourceX - left); const offsetY = Math.round(sourceY - top);
    for (let y = 0; y < source.height; y += 1) for (let x = 0; x < source.width; x += 1) {
      const targetX = offsetX + x; const targetY = offsetY + y;
      if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) continue;
      const index = targetY * width + targetX; const value = source.alpha[y * source.width + x] ?? 0;
      if (operation === "max") alpha[index] = Math.max(alpha[index], value);
      else if (value > 0) alpha[index] = 0;
    }
  };
  copy(part.mask, part.boundingBox.x, part.boundingBox.y, "max");
  copy(selection, bounds.x, bounds.y, mode === "add" ? "max" : "remove");
  const beforeOpaque = part.mask.alpha.filter(Boolean).length; const afterOpaque = alpha.filter(Boolean).length;
  const nextBounds = { x: left, y: top, width, height };
  return {
    part: { ...part, mask: { width, height, alpha }, boundingBox: nextBounds, sourceBoundingBox: nextBounds, provenance: "manual" },
    changedPixels: Math.abs(afterOpaque - beforeOpaque),
  };
}

export type CoverageSummary = { readonly assignedPixels: number; readonly unassignedPixels: number; readonly overlappingPixels: number; readonly foregroundPixels: number; readonly percentAssigned: number; readonly unassignedRegions: readonly Rect[] };
export function analyzeCoverage(state: PartCutterState, foreground?: readonly number[]): CoverageSummary {
  const { width, height } = state.sourceCanvasSize; const counts = new Uint8Array(width * height); let foregroundPixels = 0; let assignedPixels = 0; let overlappingPixels = 0; let unassignedPixels = 0;
  state.parts.filter((part) => part.accepted).forEach((part) => { const left = Math.round(part.boundingBox.x); const top = Math.round(part.boundingBox.y); for (let y = 0; y < part.mask.height; y += 1) for (let x = 0; x < part.mask.width; x += 1) if ((part.mask.alpha[y * part.mask.width + x] ?? 0) > 0) { const index = (top + y) * width + left + x; if (index >= 0 && index < counts.length && counts[index] < 255) counts[index] += 1; } });
  const missing = new Uint8Array(counts.length);
  for (let index = 0; index < counts.length; index += 1) { const isForeground = foreground ? (foreground[index] ?? 0) > 0 : counts[index] > 0; if (!isForeground) continue; foregroundPixels += 1; if (counts[index] === 0) { unassignedPixels += 1; missing[index] = 1; } else { assignedPixels += 1; if (counts[index] > 1) overlappingPixels += 1; } }
  const unassignedRegions: Rect[] = []; const visited = new Uint8Array(missing.length);
  for (let seed = 0; seed < missing.length && unassignedRegions.length < 50; seed += 1) { if (!missing[seed] || visited[seed]) continue; const queue = [seed]; let cursor = 0; let left = seed % width; let right = left; let top = Math.floor(seed / width); let bottom = top; let pixels = 0; while (cursor < queue.length) { const index = queue[cursor++]; if (visited[index] || !missing[index]) continue; visited[index] = 1; pixels += 1; const x = index % width; const y = Math.floor(index / width); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); if (x > 0) queue.push(index - 1); if (x + 1 < width) queue.push(index + 1); if (y > 0) queue.push(index - width); if (y + 1 < height) queue.push(index + width); } if (pixels >= 4) unassignedRegions.push({ x: left, y: top, width: right - left + 1, height: bottom - top + 1 }); }
  return { assignedPixels, unassignedPixels, overlappingPixels, foregroundPixels, percentAssigned: foregroundPixels ? assignedPixels / foregroundPixels : 1, unassignedRegions };
}

export type RotationTestResult = { readonly angle: number; readonly passed: boolean; readonly warnings: readonly string[] };
export function evaluateRotationTest(part: PartCutRecord, angle: -20 | 0 | 20): RotationTestResult {
  const warnings: string[] = []; const localPivot = { x: part.pivot.x - part.boundingBox.x, y: part.pivot.y - part.boundingBox.y };
  if (localPivot.x < 0 || localPivot.y < 0 || localPivot.x > part.boundingBox.width || localPivot.y > part.boundingBox.height) warnings.push("Pivot leaves the part bounds");
  if (angle !== 0 && part.occlusionState === "likely-incomplete") warnings.push(`Potential hidden area exposed at ${angle} degrees`);
  const opaque = part.mask.alpha.filter((alpha) => alpha > 0).length; if (opaque === 0) warnings.push("Part mask is empty");
  if (opaque > 0 && opaque < part.mask.alpha.length * .02) warnings.push("Part mask contains only a small detached region");
  return { angle, passed: warnings.length === 0, warnings };
}

export type ReassemblyValidation = { readonly passed: boolean; readonly gapPixels: number; readonly duplicatePixels: number; readonly coordinateDriftPartIds: readonly string[]; readonly diagnostics: readonly string[] };
export function validateReassembly(state: PartCutterState, foreground?: readonly number[]): ReassemblyValidation {
  const coverage = analyzeCoverage(state, foreground); const drift = state.parts.filter((part) => part.sourceCanvasSize.width !== state.sourceCanvasSize.width || part.sourceCanvasSize.height !== state.sourceCanvasSize.height || part.sourceBoundingBox.x !== part.boundingBox.x || part.sourceBoundingBox.y !== part.boundingBox.y).map((part) => part.partId); const diagnostics: string[] = [];
  if (coverage.unassignedPixels) diagnostics.push(`${coverage.unassignedPixels} foreground pixels are not assigned`); if (coverage.overlappingPixels) diagnostics.push(`${coverage.overlappingPixels} pixels appear in multiple parts`); if (drift.length) diagnostics.push(`${drift.length} parts no longer match their source coordinates`);
  return { passed: diagnostics.length === 0, gapPixels: coverage.unassignedPixels, duplicatePixels: coverage.overlappingPixels, coordinateDriftPartIds: drift, diagnostics };
}

export type ReconstructionConsistency = { readonly passed: boolean; readonly checks: Readonly<Record<"boundingBoxRatio" | "pivotDisplacement" | "sourceRegionOverlap" | "attachmentPointProximity", number>>; readonly warnings: readonly string[] };
export function validateReconstructionConsistency(original: PartCutRecord, replacement: Pick<PartCutRecord, "boundingBox" | "pivot" | "sourceBoundingBox">): ReconstructionConsistency {
  const originalArea = original.boundingBox.width * original.boundingBox.height; const replacementArea = replacement.boundingBox.width * replacement.boundingBox.height; const boundingBoxRatio = originalArea ? replacementArea / originalArea : 0; const pivotDisplacement = Math.hypot(replacement.pivot.x - original.pivot.x, replacement.pivot.y - original.pivot.y); const left = Math.max(original.sourceBoundingBox.x, replacement.sourceBoundingBox.x); const top = Math.max(original.sourceBoundingBox.y, replacement.sourceBoundingBox.y); const right = Math.min(original.sourceBoundingBox.x + original.sourceBoundingBox.width, replacement.sourceBoundingBox.x + replacement.sourceBoundingBox.width); const bottom = Math.min(original.sourceBoundingBox.y + original.sourceBoundingBox.height, replacement.sourceBoundingBox.y + replacement.sourceBoundingBox.height); const overlap = Math.max(0, right - left) * Math.max(0, bottom - top); const sourceRegionOverlap = originalArea ? overlap / originalArea : 0; const attachmentPointProximity = 1 - Math.min(1, pivotDisplacement / Math.max(1, Math.hypot(original.boundingBox.width, original.boundingBox.height))); const warnings: string[] = [];
  if (boundingBoxRatio < .65 || boundingBoxRatio > 1.5) warnings.push("Reconstruction scale differs substantially from the source part"); if (sourceRegionOverlap < .6) warnings.push("Reconstruction moved away from the original source region"); if (attachmentPointProximity < .7) warnings.push("Reconstruction pivot drifted away from its attachment point");
  return { passed: warnings.length === 0, checks: { boundingBoxRatio, pivotDisplacement, sourceRegionOverlap, attachmentPointProximity }, warnings };
}

export type ReconstructionAssetConsistency = {
  readonly passed: boolean;
  readonly sizeRatio: number;
  readonly canvasFootprintRatio: number;
  readonly aspectRatioDrift: number;
  readonly warnings: readonly string[];
};

export function validateReconstructionAsset(original: PartCutRecord, width: number, height: number): ReconstructionAssetConsistency {
  const expectedArea = Math.max(1, original.boundingBox.width * original.boundingBox.height);
  const sourceArea = Math.max(1, original.sourceCanvasSize.width * original.sourceCanvasSize.height);
  const sizeRatio = width * height / expectedArea;
  const canvasFootprintRatio = width * height / sourceArea;
  const originalAspect = original.boundingBox.width / Math.max(1, original.boundingBox.height);
  const replacementAspect = width / Math.max(1, height);
  const aspectRatioDrift = Math.max(originalAspect, replacementAspect) / Math.max(.0001, Math.min(originalAspect, replacementAspect));
  const warnings: string[] = [];
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) warnings.push("Reconstruction has invalid image dimensions");
  if (sizeRatio < .45 || sizeRatio > 2.25) warnings.push("Reconstruction dimensions do not match the selected part");
  if (canvasFootprintRatio > .5 && expectedArea / sourceArea < .3) warnings.push("Reconstruction resembles a full-character canvas rather than one part");
  if (aspectRatioDrift > 2) warnings.push("Reconstruction aspect ratio drifted too far from the source part");
  return { passed: warnings.length === 0, sizeRatio, canvasFootprintRatio, aspectRatioDrift, warnings };
}

export function reviseProposal(proposal: PartCutProposal, instruction: string): PartCutProposal {
  let parts = proposal.parts.map((part) => ({ ...part })); const lower = instruction.toLowerCase();
  const alias: Readonly<Record<string, PartSemanticType>> = { shield: "offHandEquipment", sword: "mainHandEquipment", weapon: "mainHandEquipment", "left boot": "leftFoot", "right boot": "rightFoot", robe: "custom" };
  const findType = (text: string): PartSemanticType | undefined => Object.entries(alias).find(([word]) => text.includes(word))?.[1] ?? (Object.keys(SEMANTIC_TAXONOMY) as PartSemanticType[]).find((type) => text.includes(type.toLowerCase()) || text.includes(SEMANTIC_TAXONOMY[type].label.toLowerCase()));
  if (lower.includes("behind")) { const target = findType(lower); if (target) parts = parts.map((part) => part.semanticType === target ? { ...part, layer: "back" as const, zOrder: -10 } : part); }
  if (lower.includes("front")) { const target = findType(lower); if (target) parts = parts.map((part) => part.semanticType === target ? { ...part, layer: "front" as const, zOrder: 10 } : part); }
  if (lower.includes("merge") || lower.includes("one piece")) { const matches = parts.filter((part) => lower.includes(part.label.toLowerCase()) || lower.includes(SEMANTIC_TAXONOMY[part.semanticType].label.toLowerCase())); if (matches.length > 1) parts = parts.map((part) => matches.slice(1).some((match) => match.proposedPartId === part.proposedPartId) ? { ...part, selected: false } : part); }
  return partCutProposalSchema.parse({ ...proposal, proposalId: `cut-proposal-${Date.now().toString(36)}`, instruction, parts, parentProposalId: proposal.proposalId, status: "pending", createdAt: now(), assumptions: [...proposal.assumptions, "Unmentioned proposed parts were preserved"] });
}

export function renderProposalSvg(proposal: PartCutProposal, width: number, height: number): string {
  const colors = ["#59d8f0", "#f4c966", "#63dab5", "#f08b7e", "#a8c7ff", "#d7a6ff"];
  const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${proposal.parts.map((part, index) => `<g><rect x="${part.boundingBox.x}" y="${part.boundingBox.y}" width="${part.boundingBox.width}" height="${part.boundingBox.height}" fill="${colors[index % colors.length]}33" stroke="${colors[index % colors.length]}"/><text x="${part.boundingBox.x + 3}" y="${part.boundingBox.y + 12}" fill="#fff" stroke="#091013" paint-order="stroke">${escape(part.label)}</text></g>`).join("")}</svg>`;
}
