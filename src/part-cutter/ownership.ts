import type { Rect, SegmentationMask } from "../character-generation/segmentation/segmentationSchema";
import {
  OWNERSHIP_BACKGROUND,
  OWNERSHIP_UNRESOLVED,
  type OwnershipAuditEvent,
  type OwnershipPartition,
  type PartCutRecord,
  type PartCutterState,
} from "./schema";

export type RegionEdge = "top" | "right" | "bottom" | "left";
export type OwnershipActor = OwnershipAuditEvent["actor"];

const stamp = (): string => new Date().toISOString();
const eventId = (): string => `ownership-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

export function encodeOwnership(labels: ArrayLike<number>): readonly number[] {
  if (!labels.length) return [];
  const runs: number[] = [];
  let owner = labels[0] ?? OWNERSHIP_BACKGROUND;
  let length = 1;
  for (let index = 1; index < labels.length; index += 1) {
    const next = labels[index] ?? OWNERSHIP_BACKGROUND;
    if (next === owner) length += 1;
    else { runs.push(owner, length); owner = next; length = 1; }
  }
  runs.push(owner, length);
  return runs;
}

export function decodeOwnership(partition: OwnershipPartition): Int16Array {
  const expected = partition.width * partition.height;
  const labels = new Int16Array(expected);
  labels.fill(OWNERSHIP_BACKGROUND);
  let cursor = 0;
  for (let index = 0; index + 1 < partition.runs.length && cursor < expected; index += 2) {
    const owner = partition.runs[index] ?? OWNERSHIP_BACKGROUND;
    const length = Math.max(0, partition.runs[index + 1] ?? 0);
    labels.fill(owner, cursor, Math.min(expected, cursor + length));
    cursor += length;
  }
  return labels;
}

export function changedOwnershipPixels(before: OwnershipPartition, after: OwnershipPartition): number {
  const left = decodeOwnership(before); const right = decodeOwnership(after); const length = Math.max(left.length, right.length); let changed = 0;
  for (let index = 0; index < length; index += 1) if ((left[index] ?? OWNERSHIP_BACKGROUND) !== (right[index] ?? OWNERSHIP_BACKGROUND)) changed += 1;
  return changed;
}

const ownerScore = (part: PartCutRecord, index: number): number => {
  const provenance = part.provenance === "manual" ? 3000 : part.provenance === "reconstructed" ? 2500 : 2000;
  const accepted = part.accepted ? 500 : 0;
  const confidence = (part.confidence ?? 0) * 100;
  const semantic = part.equipment ? 8 : part.articulated ? 4 : 0;
  return provenance + accepted + confidence + semantic + index / 1000;
};

function partitionFromMasks(state: PartCutterState, actor: OwnershipActor = "migration"): OwnershipPartition {
  const { width, height } = state.sourceCanvasSize;
  const labels = new Int16Array(width * height);
  labels.fill(OWNERSHIP_BACKGROUND);
  const scores = new Float64Array(labels.length);
  scores.fill(Number.NEGATIVE_INFINITY);
  const regionIds = state.parts.map((part) => part.partId);
  state.parts.forEach((part, partIndex) => {
    const owner = partIndex + 1;
    const score = ownerScore(part, partIndex);
    const left = Math.round(part.boundingBox.x); const top = Math.round(part.boundingBox.y);
    for (let y = 0; y < part.mask.height; y += 1) for (let x = 0; x < part.mask.width; x += 1) {
      if ((part.mask.alpha[y * part.mask.width + x] ?? 0) <= 0) continue;
      const sourceX = left + x; const sourceY = top + y;
      if (sourceX < 0 || sourceY < 0 || sourceX >= width || sourceY >= height) continue;
      const pixel = sourceY * width + sourceX;
      if (score > scores[pixel]) { labels[pixel] = owner; scores[pixel] = score; }
      else if (score === scores[pixel] && labels[pixel] !== owner) labels[pixel] = OWNERSHIP_UNRESOLVED;
    }
  });
  const partition: OwnershipPartition = {
    ownershipVersion: 1, width, height, regionIds, runs: encodeOwnership(labels), adjacency: {}, reviewStatus: "review",
    audit: [{ eventId: eventId(), action: "migrate", regionIds, changedPixels: labels.filter((owner) => owner >= 0).length, actor, timestamp: stamp(), detail: "Existing accepted masks migrated to exclusive source ownership" }],
    riggingPadding: {},
  };
  return { ...partition, adjacency: buildAdjacency(partition, labels) };
}

const sameRegionSet = (partition: OwnershipPartition, parts: readonly PartCutRecord[]): boolean =>
  partition.regionIds.length === parts.length && partition.regionIds.every((id) => parts.some((part) => part.partId === id));

export function ensureOwnershipPartition(state: PartCutterState, actor: OwnershipActor = "migration"): PartCutterState {
  const ownership = state.ownership;
  const valid = ownership?.width === state.sourceCanvasSize.width && ownership.height === state.sourceCanvasSize.height && sameRegionSet(ownership, state.parts);
  const partition = valid ? ownership : partitionFromMasks(state, actor);
  return deriveMasksFromOwnership({ ...state, ownership: partition });
}

export function deriveMasksFromOwnership(state: PartCutterState): PartCutterState {
  if (!state.ownership) return state;
  const labels = decodeOwnership(state.ownership); const { width, height, regionIds } = state.ownership; const count = regionIds.length;
  const left = new Int32Array(count); left.fill(width); const top = new Int32Array(count); top.fill(height); const right = new Int32Array(count); right.fill(-1); const bottom = new Int32Array(count); bottom.fill(-1);
  for (let index = 0; index < labels.length; index += 1) { const ownerIndex = labels[index] - 1; if (ownerIndex < 0 || ownerIndex >= count) continue; const x = index % width; const y = Math.floor(index / width); left[ownerIndex] = Math.min(left[ownerIndex], x); top[ownerIndex] = Math.min(top[ownerIndex], y); right[ownerIndex] = Math.max(right[ownerIndex], x); bottom[ownerIndex] = Math.max(bottom[ownerIndex], y); }
  const masks = regionIds.map((_, index) => right[index] < left[index] || bottom[index] < top[index] ? { width: 1, height: 1, alpha: [0] } : { width: right[index] - left[index] + 1, height: bottom[index] - top[index] + 1, alpha: new Array<number>((right[index] - left[index] + 1) * (bottom[index] - top[index] + 1)).fill(0) });
  for (let index = 0; index < labels.length; index += 1) { const ownerIndex = labels[index] - 1; if (ownerIndex < 0 || ownerIndex >= count || right[ownerIndex] < 0) continue; const x = index % width; const y = Math.floor(index / width); masks[ownerIndex].alpha[(y - top[ownerIndex]) * masks[ownerIndex].width + x - left[ownerIndex]] = 255; }
  const parts = state.parts.map((part) => { const ownerIndex = regionIds.indexOf(part.partId); if (ownerIndex < 0) return part; const x = right[ownerIndex] < 0 ? clamp(Math.round(part.boundingBox.x), 0, Math.max(0, width - 1)) : left[ownerIndex]; const y = bottom[ownerIndex] < 0 ? clamp(Math.round(part.boundingBox.y), 0, Math.max(0, height - 1)) : top[ownerIndex]; const mask = masks[ownerIndex]; const bounds = { x, y, width: mask.width, height: mask.height }; return { ...part, mask, boundingBox: bounds, sourceBoundingBox: bounds, pivot: { x: clamp(part.pivot.x, x, x + mask.width), y: clamp(part.pivot.y, y, y + mask.height) } }; });
  return { ...state, parts };
}

export function buildAdjacency(partition: OwnershipPartition, provided?: Int16Array): Readonly<Record<string, readonly string[]>> {
  const labels = provided ?? decodeOwnership(partition);
  const neighbors = new Map<string, Set<string>>(partition.regionIds.map((id) => [id, new Set()]));
  const connect = (a: number, b: number): void => {
    if (a <= 0 || b <= 0 || a === b) return;
    const left = partition.regionIds[a - 1]; const right = partition.regionIds[b - 1];
    if (!left || !right) return;
    neighbors.get(left)?.add(right); neighbors.get(right)?.add(left);
  };
  for (let y = 0; y < partition.height; y += 1) for (let x = 0; x < partition.width; x += 1) {
    const index = y * partition.width + x;
    if (x + 1 < partition.width) connect(labels[index], labels[index + 1]);
    if (y + 1 < partition.height) connect(labels[index], labels[index + partition.width]);
  }
  return Object.fromEntries([...neighbors].map(([id, values]) => [id, [...values].sort()]));
}

function commitOwnership(
  state: PartCutterState,
  labels: Int16Array,
  action: OwnershipAuditEvent["action"],
  regionIds: readonly string[],
  changedPixels: number,
  actor: OwnershipActor,
  detail?: string,
): PartCutterState {
  const current = state.ownership ?? partitionFromMasks(state, actor);
  const base: OwnershipPartition = {
    ...current,
    runs: encodeOwnership(labels),
    reviewStatus: action === "accept" ? "accepted" : "review",
    audit: [...current.audit, { eventId: eventId(), action, regionIds, changedPixels, actor, timestamp: stamp(), ...(detail ? { detail } : {}) }].slice(-500),
  };
  const ownership = { ...base, adjacency: buildAdjacency(base, labels) };
  return deriveMasksFromOwnership({ ...state, ownership, finalized: false, updatedAt: stamp() });
}

export function ownerAt(state: PartCutterState, x: number, y: number): string | "unresolved" | null {
  const canonical = ensureOwnershipPartition(state);
  const partition = canonical.ownership!;
  const sourceX = Math.floor(x); const sourceY = Math.floor(y);
  if (sourceX < 0 || sourceY < 0 || sourceX >= partition.width || sourceY >= partition.height) return null;
  const owner = decodeOwnership(partition)[sourceY * partition.width + sourceX];
  return owner === OWNERSHIP_UNRESOLVED ? "unresolved" : owner > 0 ? partition.regionIds[owner - 1] ?? null : null;
}

export function assignOwnershipSelection(
  state: PartCutterState,
  targetPartId: string | null,
  bounds: Rect,
  selection: SegmentationMask,
  options: { readonly actor?: OwnershipActor; readonly includeBackground?: boolean; readonly action?: OwnershipAuditEvent["action"] } = {},
): { readonly state: PartCutterState; readonly changedPixels: number; readonly previousOwnerIds: readonly string[] } {
  const canonical = ensureOwnershipPartition(state, options.actor);
  const partition = canonical.ownership!;
  const labels = decodeOwnership(partition);
  const target = targetPartId === null ? OWNERSHIP_UNRESOLVED : partition.regionIds.indexOf(targetPartId) + 1;
  if (targetPartId !== null && target <= 0) throw new Error(`Region ${targetPartId} does not exist in the ownership partition`);
  const previous = new Set<string>(); let changedPixels = 0;
  const left = Math.round(bounds.x); const top = Math.round(bounds.y);
  for (let y = 0; y < selection.height; y += 1) for (let x = 0; x < selection.width; x += 1) {
    if ((selection.alpha[y * selection.width + x] ?? 0) <= 0) continue;
    const sourceX = left + x; const sourceY = top + y;
    if (sourceX < 0 || sourceY < 0 || sourceX >= partition.width || sourceY >= partition.height) continue;
    const index = sourceY * partition.width + sourceX; const current = labels[index];
    if (current === OWNERSHIP_BACKGROUND && !options.includeBackground) continue;
    if (current === target) continue;
    if (current > 0) previous.add(partition.regionIds[current - 1]);
    labels[index] = target; changedPixels += 1;
  }
  const action = options.action ?? (targetPartId === null ? "unresolved" : "assign");
  return { state: commitOwnership(canonical, labels, action, targetPartId ? [targetPartId, ...previous] : [...previous], changedPixels, options.actor ?? "human"), changedPixels, previousOwnerIds: [...previous] };
}

function nearestNeighborOwner(labels: Int16Array, width: number, height: number, x: number, y: number, excluded: number, radius = 8): number {
  for (let distance = 1; distance <= radius; distance += 1) {
    for (let offset = -distance; offset <= distance; offset += 1) {
      const points = [[x + offset, y - distance], [x + offset, y + distance], [x - distance, y + offset], [x + distance, y + offset]];
      for (const [candidateX, candidateY] of points) {
        if (candidateX < 0 || candidateY < 0 || candidateX >= width || candidateY >= height) continue;
        const owner = labels[candidateY * width + candidateX];
        if (owner > 0 && owner !== excluded) return owner;
      }
    }
  }
  return OWNERSHIP_UNRESOLVED;
}

export function reshapeRegionEdge(
  state: PartCutterState,
  partId: string,
  edge: RegionEdge,
  coordinate: number,
  actor: OwnershipActor = "human",
): { readonly state: PartCutterState; readonly changedPixels: number; readonly yieldedRegionIds: readonly string[] } {
  const canonical = ensureOwnershipPartition(state, actor);
  const partition = canonical.ownership!; const labels = decodeOwnership(partition); const source = labels.slice();
  const part = canonical.parts.find((candidate) => candidate.partId === partId);
  const owner = partition.regionIds.indexOf(partId) + 1;
  if (!part || owner <= 0) throw new Error(`Region ${partId} does not exist`);
  const bounds = part.boundingBox;
  const oldCoordinate = edge === "top" ? bounds.y : edge === "bottom" ? bounds.y + bounds.height : edge === "left" ? bounds.x : bounds.x + bounds.width;
  const nextCoordinate = edge === "top" || edge === "left" ? Math.floor(coordinate) : Math.ceil(coordinate);
  const expanding = edge === "top" || edge === "left" ? nextCoordinate < oldCoordinate : nextCoordinate > oldCoordinate;
  const minX = edge === "left" || edge === "right" ? Math.min(oldCoordinate, nextCoordinate) : bounds.x;
  const maxX = edge === "left" || edge === "right" ? Math.max(oldCoordinate, nextCoordinate) : bounds.x + bounds.width;
  const minY = edge === "top" || edge === "bottom" ? Math.min(oldCoordinate, nextCoordinate) : bounds.y;
  const maxY = edge === "top" || edge === "bottom" ? Math.max(oldCoordinate, nextCoordinate) : bounds.y + bounds.height;
  const yielded = new Set<string>(); let changedPixels = 0;
  for (let y = clamp(Math.floor(minY), 0, partition.height); y < clamp(Math.ceil(maxY), 0, partition.height); y += 1) for (let x = clamp(Math.floor(minX), 0, partition.width); x < clamp(Math.ceil(maxX), 0, partition.width); x += 1) {
    const index = y * partition.width + x; const current = labels[index];
    if (expanding) {
      if (current === OWNERSHIP_BACKGROUND || current === owner) continue;
      if (current > 0) yielded.add(partition.regionIds[current - 1]);
      labels[index] = owner; changedPixels += 1;
    } else if (current === owner) {
      const replacement = nearestNeighborOwner(source, partition.width, partition.height, x, y, owner);
      if (replacement > 0) yielded.add(partition.regionIds[replacement - 1]);
      labels[index] = replacement; changedPixels += 1;
    }
  }
  return { state: commitOwnership(canonical, labels, "reshape", [partId, ...yielded], changedPixels, actor, `${edge} boundary moved from ${Math.round(oldCoordinate)} to ${Math.round(nextCoordinate)}`), changedPixels, yieldedRegionIds: [...yielded] };
}

export function markOwnershipAccepted(state: PartCutterState, actor: OwnershipActor = "human"): PartCutterState {
  const canonical = ensureOwnershipPartition(state, actor);
  const accepted = commitOwnership(canonical, decodeOwnership(canonical.ownership!), "accept", canonical.ownership!.regionIds, 0, actor, "Reviewed ownership partition accepted");
  return accepted.anatomicalGuide ? { ...accepted, anatomicalGuide: { ...accepted.anatomicalGuide, status: "reviewed", updatedAt: new Date().toISOString() } } : accepted;
}

export function recordOwnershipRelabel(state: PartCutterState, partId: string, detail: string, actor: OwnershipActor = "human"): PartCutterState {
  const canonical = ensureOwnershipPartition(state, actor);
  return commitOwnership(canonical, decodeOwnership(canonical.ownership!), "relabel", [partId], 0, actor, detail);
}

export function rebuildOwnershipAfterStructuralChange(state: PartCutterState, action: "split" | "merge", regionIds: readonly string[], actor: OwnershipActor = "human"): PartCutterState {
  const prior = state.ownership && state.ownership.width === state.sourceCanvasSize.width && state.ownership.height === state.sourceCanvasSize.height ? decodeOwnership(state.ownership) : null;
  const withoutStale = { ...state, ownership: undefined };
  const canonical = ensureOwnershipPartition(withoutStale, actor);
  const labels = decodeOwnership(canonical.ownership!);
  if (prior) for (let index = 0; index < labels.length; index += 1) if (prior[index] === OWNERSHIP_UNRESOLVED) labels[index] = OWNERSHIP_UNRESOLVED;
  return commitOwnership(canonical, labels, action, regionIds, 0, actor);
}

export function removeOwnershipRegion(state: PartCutterState, partId: string, actor: OwnershipActor = "human"): PartCutterState {
  const canonical = ensureOwnershipPartition(state, actor); const partition = canonical.ownership!; const oldLabels = decodeOwnership(partition); const owner = partition.regionIds.indexOf(partId) + 1;
  if (owner <= 0) throw new Error(`Region ${partId} does not exist`);
  const parts = canonical.parts.filter((part) => part.partId !== partId); const regionIds = parts.map((part) => part.partId); const newOwnerById = new Map(regionIds.map((id, index) => [id, index + 1])); const labels = new Int16Array(oldLabels.length); let changed = 0;
  for (let index = 0; index < oldLabels.length; index += 1) { const current = oldLabels[index]; if (current === owner) { labels[index] = OWNERSHIP_UNRESOLVED; changed += 1; } else if (current > 0) labels[index] = newOwnerById.get(partition.regionIds[current - 1]) ?? OWNERSHIP_UNRESOLVED; else labels[index] = current; }
  const auditEvent: OwnershipAuditEvent = { eventId: eventId(), action: "unresolved", regionIds: [partId], changedPixels: changed, actor, timestamp: stamp(), detail: "Deleted region pixels marked unresolved" };
  const base: OwnershipPartition = { ...partition, regionIds, runs: encodeOwnership(labels), adjacency: {}, reviewStatus: "review", riggingPadding: Object.fromEntries(Object.entries(partition.riggingPadding).filter(([id]) => id !== partId)), audit: [...partition.audit, auditEvent].slice(-500) };
  const ownership = { ...base, adjacency: buildAdjacency(base, labels) };
  return deriveMasksFromOwnership({ ...canonical, parts, ownership, finalized: false, updatedAt: stamp() });
}

export function setRiggingPadding(state: PartCutterState, partId: string, padding: number): PartCutterState {
  const canonical = ensureOwnershipPartition(state);
  if (!canonical.parts.some((part) => part.partId === partId)) throw new Error(`Region ${partId} does not exist`);
  return { ...canonical, ownership: { ...canonical.ownership!, riggingPadding: { ...canonical.ownership!.riggingPadding, [partId]: clamp(Math.round(padding), 0, 64) } }, updatedAt: stamp() };
}

export const riggingPaddingFor = (state: PartCutterState, partId: string): number => state.ownership?.riggingPadding[partId] ?? 0;

export function deriveRiggingExtraction(state: PartCutterState, partId: string, requestedPadding = riggingPaddingFor(state, partId)): { readonly bounds: Rect; readonly mask: SegmentationMask; readonly padding: number } {
  const canonical = ensureOwnershipPartition(state); const partition = canonical.ownership!; const labels = decodeOwnership(partition); const part = canonical.parts.find((candidate) => candidate.partId === partId); const owner = partition.regionIds.indexOf(partId) + 1;
  if (!part || owner <= 0) throw new Error(`Region ${partId} does not exist`);
  const padding = clamp(Math.round(requestedPadding), 0, 64); if (!padding) return { bounds: part.boundingBox, mask: part.mask, padding: 0 };
  const left = Math.max(0, Math.floor(part.boundingBox.x) - padding); const top = Math.max(0, Math.floor(part.boundingBox.y) - padding); const right = Math.min(partition.width, Math.ceil(part.boundingBox.x + part.boundingBox.width) + padding); const bottom = Math.min(partition.height, Math.ceil(part.boundingBox.y + part.boundingBox.height) + padding); const width = Math.max(1, right - left); const height = Math.max(1, bottom - top); const alpha = new Array<number>(width * height).fill(0);
  for (let y = Math.max(0, Math.floor(part.boundingBox.y)); y < Math.min(partition.height, Math.ceil(part.boundingBox.y + part.boundingBox.height)); y += 1) for (let x = Math.max(0, Math.floor(part.boundingBox.x)); x < Math.min(partition.width, Math.ceil(part.boundingBox.x + part.boundingBox.width)); x += 1) {
    if (labels[y * partition.width + x] !== owner) continue;
    for (let dy = -padding; dy <= padding; dy += 1) for (let dx = -padding; dx <= padding; dx += 1) { const sourceX = x + dx; const sourceY = y + dy; if (sourceX < left || sourceY < top || sourceX >= right || sourceY >= bottom || labels[sourceY * partition.width + sourceX] === OWNERSHIP_BACKGROUND) continue; alpha[(sourceY - top) * width + sourceX - left] = 255; }
  }
  return { bounds: { x: left, y: top, width, height }, mask: { width, height, alpha }, padding };
}

export function unresolvedMask(state: PartCutterState): SegmentationMask {
  const canonical = ensureOwnershipPartition(state); const partition = canonical.ownership!; const labels = decodeOwnership(partition);
  return { width: partition.width, height: partition.height, alpha: Array.from(labels, (owner) => owner === OWNERSHIP_UNRESOLVED ? 255 : 0) };
}

export function simplifiedRegionContour(state: PartCutterState, partId: string, maximumPoints = 16): readonly { readonly x: number; readonly y: number }[] {
  const canonical = ensureOwnershipPartition(state); const part = canonical.parts.find((candidate) => candidate.partId === partId); if (!part) return []; const { mask } = part;
  const boundary: { x: number; y: number }[] = [];
  for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) {
    const index = y * mask.width + x; if ((mask.alpha[index] ?? 0) <= 0) continue;
    if (x === 0 || y === 0 || x + 1 === mask.width || y + 1 === mask.height || (mask.alpha[index - 1] ?? 0) <= 0 || (mask.alpha[index + 1] ?? 0) <= 0 || (mask.alpha[index - mask.width] ?? 0) <= 0 || (mask.alpha[index + mask.width] ?? 0) <= 0) boundary.push({ x: part.boundingBox.x + x + .5, y: part.boundingBox.y + y + .5 });
  }
  if (boundary.length <= maximumPoints) return boundary;
  const center = boundary.reduce((result, point) => ({ x: result.x + point.x / boundary.length, y: result.y + point.y / boundary.length }), { x: 0, y: 0 });
  boundary.sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
  return Array.from({ length: maximumPoints }, (_, index) => boundary[Math.floor(index * boundary.length / maximumPoints)]);
}

export function ownershipSummary(state: PartCutterState): { readonly assignedPixels: number; readonly unresolvedPixels: number; readonly backgroundPixels: number; readonly exclusive: true } {
  const canonical = ensureOwnershipPartition(state); const labels = decodeOwnership(canonical.ownership!);
  let assignedPixels = 0; let unresolvedPixels = 0; let backgroundPixels = 0;
  labels.forEach((owner) => { if (owner > 0) assignedPixels += 1; else if (owner === OWNERSHIP_UNRESOLVED) unresolvedPixels += 1; else backgroundPixels += 1; });
  return { assignedPixels, unresolvedPixels, backgroundPixels, exclusive: true };
}
