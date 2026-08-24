import type { Rect, SegmentationMask } from "../character-generation/segmentation/segmentationSchema";
import { createManualPart } from "./operations";
import { buildAdjacency, decodeOwnership, deriveMasksFromOwnership, encodeOwnership, ensureOwnershipPartition } from "./ownership";
import type { OwnershipAuditEvent, OwnershipPartition, PartCutterState } from "./schema";
import type { PartSemanticType } from "./semanticTaxonomy";

export type ManualSelectionMode = "new" | "add" | "remove";

const timestamp = (): string => new Date().toISOString();
const auditId = (): string => `ownership-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function intersectSelectionWithForeground(
  bounds: Rect,
  selection: SegmentationMask,
  foreground: readonly number[],
  canvas: { readonly width: number; readonly height: number },
): SegmentationMask {
  const left = Math.round(bounds.x); const top = Math.round(bounds.y);
  return {
    width: selection.width,
    height: selection.height,
    alpha: selection.alpha.map((alpha, index) => {
      if (alpha <= 0) return 0;
      const x = left + index % selection.width; const y = top + Math.floor(index / selection.width);
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return 0;
      return (foreground[y * canvas.width + x] ?? 0) > 0 ? alpha : 0;
    }),
  };
}

/** Adds one semantic region while retaining every existing owner outside the selection. */
export function createManualRegionFromSelection(
  state: PartCutterState,
  semanticType: PartSemanticType,
  bounds: Rect,
  mask: SegmentationMask,
  label?: string,
  actor: OwnershipAuditEvent["actor"] = "human",
): { readonly state: PartCutterState; readonly partId: string; readonly changedPixels: number; readonly previousOwnerIds: readonly string[] } {
  if (!mask.alpha.some(Boolean)) throw new Error("The selection contains no foreground pixels");
  const canonical = ensureOwnershipPartition(state, actor); const prior = canonical.ownership!;
  const part = createManualPart(canonical, semanticType, bounds, mask, label);
  const regionIds = [...prior.regionIds, part.partId]; const target = regionIds.length;
  const labels = decodeOwnership(prior); const previous = new Set<string>(); let changedPixels = 0;
  const left = Math.round(bounds.x); const top = Math.round(bounds.y);
  for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) {
    if ((mask.alpha[y * mask.width + x] ?? 0) <= 0) continue;
    const sourceX = left + x; const sourceY = top + y;
    if (sourceX < 0 || sourceY < 0 || sourceX >= prior.width || sourceY >= prior.height) continue;
    const index = sourceY * prior.width + sourceX; const owner = labels[index];
    if (owner > 0) previous.add(prior.regionIds[owner - 1]);
    if (owner !== target) { labels[index] = target; changedPixels += 1; }
  }
  const at = timestamp();
  const audit: OwnershipAuditEvent = { eventId: auditId(), action: "assign", regionIds: [part.partId, ...previous], changedPixels, actor, timestamp: at, detail: "Manual foreground-aware region created" };
  const base: OwnershipPartition = { ...prior, regionIds, runs: encodeOwnership(labels), adjacency: {}, reviewStatus: "review", audit: [...prior.audit, audit].slice(-500) };
  const ownership = { ...base, adjacency: buildAdjacency(base, labels) };
  return { state: deriveMasksFromOwnership({ ...canonical, mode: "manual", parts: [...canonical.parts, part], ownership, finalized: false, updatedAt: at }), partId: part.partId, changedPixels, previousOwnerIds: [...previous] };
}
