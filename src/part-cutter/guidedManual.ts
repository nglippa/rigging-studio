import type { Rect, SegmentationMask } from "../character-generation/segmentation/segmentationSchema";
import { createManualRegionFromSelection, intersectSelectionWithForeground } from "./manualPartition";
import { adoptStrayArtwork, assignOwnershipSelection, decodeOwnership, ensureOwnershipPartition, reassignDetachedFragments, removeOwnershipRegion, snapBoundariesToOutlines } from "./ownership";
import type { GuidedManualIntent, GuidedManualProgress, PartCutterState } from "./schema";
import { SEMANTIC_TAXONOMY, type PartSemanticType } from "./semanticTaxonomy";

export const GUIDED_BODY_ORDER = [
  "head", "torso", "leftUpperArm", "leftForearm", "leftHand", "rightUpperArm", "rightForearm", "rightHand",
  "leftThigh", "leftLowerLeg", "leftFoot", "rightThigh", "rightLowerLeg", "rightFoot",
] as const satisfies readonly PartSemanticType[];

export const GUIDED_EQUIPMENT_ORDER = [
  "mainHandEquipment", "offHandEquipment", "cape", "helmet", "hair", "custom",
] as const satisfies readonly PartSemanticType[];

export type GuidedSelection = { readonly bounds: Rect; readonly mask: SegmentationMask };
export type GuidedCommitResult = {
  readonly ok: boolean;
  readonly state: PartCutterState;
  readonly partId?: string;
  readonly changedPixels: number;
  readonly message: string;
};

const unique = <T,>(values: readonly T[]): readonly T[] => [...new Set(values)];
const stamp = (at?: string): string => at ?? new Date().toISOString();
const orderFor = (phase: GuidedManualProgress["phase"]): readonly PartSemanticType[] => phase === "body" ? GUIDED_BODY_ORDER : GUIDED_EQUIPMENT_ORDER;

export function initializeGuidedManual(state: PartCutterState, at?: string): PartCutterState {
  if (state.guidedManual) return state;
  const completed = unique(state.parts.map((part) => part.semanticType).filter((semantic): semantic is PartSemanticType => GUIDED_BODY_ORDER.includes(semantic as typeof GUIDED_BODY_ORDER[number])));
  const current = GUIDED_BODY_ORDER.find((semantic) => !completed.includes(semantic)) ?? GUIDED_BODY_ORDER[0];
  return {
    ...state,
    mode: "manual",
    guidedManual: { guidedManualVersion: 1, phase: "body", currentSemantic: current, completedSemantics: completed, skippedSemantics: [], intent: "replace", updatedAt: stamp(at) },
    updatedAt: stamp(at),
  };
}

export function setGuidedIntent(state: PartCutterState, intent: GuidedManualIntent, at?: string): PartCutterState {
  const initialized = initializeGuidedManual(state, at);
  return { ...initialized, guidedManual: { ...initialized.guidedManual!, intent, updatedAt: stamp(at) }, updatedAt: stamp(at) };
}

function nextSemantic(progress: GuidedManualProgress): { readonly phase: GuidedManualProgress["phase"]; readonly semantic: PartSemanticType } {
  const order = orderFor(progress.phase);
  const pending = order.find((semantic) => !progress.completedSemantics.includes(semantic) && !progress.skippedSemantics.includes(semantic));
  if (pending) return { phase: progress.phase, semantic: pending };
  if (progress.phase === "body") return { phase: "equipment", semantic: GUIDED_EQUIPMENT_ORDER[0] };
  return { phase: "review", semantic: progress.skippedSemantics[0] ?? progress.currentSemantic };
}

export function skipGuidedSemantic(state: PartCutterState, at?: string): PartCutterState {
  const initialized = initializeGuidedManual(state, at); const progress = initialized.guidedManual!;
  const skippedSemantics = unique([...progress.skippedSemantics, progress.currentSemantic]);
  const next = nextSemantic({ ...progress, skippedSemantics });
  return { ...initialized, guidedManual: { ...progress, phase: next.phase, currentSemantic: next.semantic, skippedSemantics, intent: "replace", updatedAt: stamp(at) }, updatedAt: stamp(at) };
}

export function backGuidedSemantic(state: PartCutterState, at?: string): PartCutterState {
  const initialized = initializeGuidedManual(state, at); const progress = initialized.guidedManual!;
  const order = orderFor(progress.phase === "review" ? "equipment" : progress.phase);
  const index = Math.max(0, order.indexOf(progress.currentSemantic));
  const semantic = order[Math.max(0, index - 1)] ?? order[0];
  const phase = progress.phase === "review" ? "equipment" : progress.phase;
  return { ...initialized, guidedManual: { ...progress, phase, currentSemantic: semantic, intent: "replace", updatedAt: stamp(at) }, updatedAt: stamp(at) };
}

export function finishGuidedBody(state: PartCutterState, at?: string): PartCutterState {
  const initialized = initializeGuidedManual(state, at); const progress = initialized.guidedManual!;
  return { ...initialized, guidedManual: { ...progress, phase: "equipment", currentSemantic: GUIDED_EQUIPMENT_ORDER[0], intent: "replace", updatedAt: stamp(at) }, updatedAt: stamp(at) };
}

export function finishGuidedEquipment(state: PartCutterState, at?: string): PartCutterState {
  const initialized = initializeGuidedManual(state, at); const progress = initialized.guidedManual!;
  return { ...initialized, guidedManual: { ...progress, phase: "review", currentSemantic: progress.skippedSemantics[0] ?? progress.currentSemantic, intent: "replace", updatedAt: stamp(at) }, updatedAt: stamp(at) };
}

function safeMask(state: PartCutterState, targetPartId: string | null, selection: GuidedSelection): SegmentationMask {
  const canonical = ensureOwnershipPartition(state); const ownership = canonical.ownership!; const labels = decodeOwnership(ownership);
  const targetOwner = targetPartId ? ownership.regionIds.indexOf(targetPartId) + 1 : 0;
  const left = Math.round(selection.bounds.x); const top = Math.round(selection.bounds.y);
  return { ...selection.mask, alpha: selection.mask.alpha.map((alpha, index) => {
    if (alpha <= 0) return 0;
    const x = left + index % selection.mask.width; const y = top + Math.floor(index / selection.mask.width);
    if (x < 0 || y < 0 || x >= ownership.width || y >= ownership.height) return 0;
    const owner = labels[y * ownership.width + x] ?? -1;
    return owner <= 0 || owner === targetOwner ? alpha : 0;
  }) };
}

/**
 * Pixels a loop may claim. Normally a loop only takes pixels nobody owns, so the slight overlap at a seam never nibbles
 * the neighbouring part. A loop drawn mostly on top of existing parts is different: the user is cutting out something
 * that lies in front (a hand over the torso), so it carves those pixels out. Returns null when carving would erase a part.
 */
function claimableMask(state: PartCutterState, targetPartId: string | null, selection: GuidedSelection, clipped: SegmentationMask, claimAll = false): { readonly mask: SegmentationMask; readonly carved: boolean } | null {
  const free = safeMask(state, targetPartId, { bounds: selection.bounds, mask: clipped });
  const wanted = clipped.alpha.reduce((count, alpha) => count + (alpha > 0 ? 1 : 0), 0);
  const available = free.alpha.reduce((count, alpha) => count + (alpha > 0 ? 1 : 0), 0);
  if (!wanted || (!claimAll && available * 2 >= wanted)) return { mask: free, carved: false };
  const ownership = ensureOwnershipPartition(state).ownership!; const labels = decodeOwnership(ownership);
  const targetOwner = targetPartId ? ownership.regionIds.indexOf(targetPartId) + 1 : -1;
  const left = Math.round(selection.bounds.x); const top = Math.round(selection.bounds.y);
  const taken = new Map<number, number>();
  clipped.alpha.forEach((alpha, index) => {
    if (alpha <= 0) return;
    const x = left + index % clipped.width; const y = top + Math.floor(index / clipped.width);
    if (x < 0 || y < 0 || x >= ownership.width || y >= ownership.height) return;
    const owner = labels[y * ownership.width + x] ?? -1;
    if (owner > 0 && owner !== targetOwner) taken.set(owner, (taken.get(owner) ?? 0) + 1);
  });
  const erased = new Set<number>();
  for (const [owner, count] of taken) {
    const part = state.parts.find((candidate) => candidate.partId === ownership.regionIds[owner - 1]);
    if (part && part.mask.alpha.reduce((total, alpha) => total + (alpha > 0 ? 1 : 0), 0) <= count) erased.add(owner);
  }
  if (!erased.size) return { mask: clipped, carved: taken.size > 0 };
  // An object segmented whole may still not wipe out a part: it takes everything but that part's pixels (a small sprite's
  // hand lying entirely inside the shield it holds keeps its few pixels).
  if (!claimAll) return null;
  return { mask: { ...clipped, alpha: clipped.alpha.map((alpha, index) => {
    if (alpha <= 0) return 0;
    const x = left + index % clipped.width; const y = top + Math.floor(index / clipped.width);
    return x >= 0 && y >= 0 && x < ownership.width && y < ownership.height && erased.has(labels[y * ownership.width + x]) ? 0 : alpha;
  }) }, carved: true };
}

function targetFor(state: PartCutterState, semantic: PartSemanticType) {
  return state.parts.find((part) => part.semanticType === semantic);
}

/** `claimAll`: take every pixel of the selection, carving it out of other parts (an object a model segmented whole). */
export function commitGuidedSelection(state: PartCutterState, selection: GuidedSelection, foreground: readonly number[], at?: string, claimAll = false): GuidedCommitResult {
  const initialized = initializeGuidedManual(state, at); const progress = initialized.guidedManual!; const semantic = progress.currentSemantic;
  const clipped = intersectSelectionWithForeground(selection.bounds, selection.mask, foreground, initialized.sourceCanvasSize);
  if (!clipped.alpha.some(Boolean)) return { ok: false, state, changedPixels: 0, message: "No foreground inside the gesture. Draw around visible character pixels." };
  const target = targetFor(initialized, semantic);
  if ((progress.intent === "add" || progress.intent === "remove") && !target) return { ok: false, state, changedPixels: 0, message: `${SEMANTIC_TAXONOMY[semantic].label} has no region to ${progress.intent}. Use Replace first.` };

  let resultState = initialized; let partId = target?.partId; let changedPixels = 0;
  if (progress.intent === "remove") {
    const ownership = ensureOwnershipPartition(initialized).ownership!; const labels = decodeOwnership(ownership); const owner = ownership.regionIds.indexOf(target!.partId) + 1;
    const left = Math.round(selection.bounds.x); const top = Math.round(selection.bounds.y);
    const ownedOnly = { ...clipped, alpha: clipped.alpha.map((alpha, index) => {
      const x = left + index % clipped.width; const y = top + Math.floor(index / clipped.width);
      return alpha > 0 && x >= 0 && y >= 0 && x < ownership.width && y < ownership.height && labels[y * ownership.width + x] === owner ? alpha : 0;
    }) };
    if (!ownedOnly.alpha.some(Boolean)) return { ok: false, state, changedPixels: 0, message: "The gesture does not overlap the current region." };
    const remaining = target!.mask.alpha.filter(Boolean).length - ownedOnly.alpha.filter(Boolean).length;
    if (remaining <= 0) return { ok: false, state, changedPixels: 0, message: "Remove would empty the region. Use Replace or Skip instead." };
    const result = assignOwnershipSelection(initialized, null, selection.bounds, ownedOnly, { actor: "human" });
    resultState = result.state; changedPixels = result.changedPixels;
  } else if (progress.intent === "add") {
    const claim = claimableMask(initialized, target!.partId, selection, clipped);
    if (!claim) return { ok: false, state, changedPixels: 0, message: "That loop would erase another part completely. Draw a smaller loop." };
    const mask = claim.mask;
    if (!mask.alpha.some(Boolean)) return { ok: false, state, changedPixels: 0, message: "Those pixels already belong to another manual region." };
    const result = assignOwnershipSelection(initialized, target!.partId, selection.bounds, mask, { actor: "human", includeBackground: true });
    if (!result.changedPixels) return { ok: false, state, changedPixels: 0, message: "No ownership changed." };
    resultState = result.state; changedPixels = result.changedPixels;
  } else {
    const claim = claimableMask(initialized, target?.partId ?? null, selection, clipped, claimAll);
    if (!claim) return { ok: false, state, changedPixels: 0, message: "That loop would erase another part completely. Draw a smaller loop." };
    const mask = claim.mask;
    if (!mask.alpha.some(Boolean)) return { ok: false, state, changedPixels: 0, message: "Those pixels already belong to another manual region." };
    const withoutTarget = target ? removeOwnershipRegion(initialized, target.partId, "human") : initialized;
    const result = createManualRegionFromSelection(withoutTarget, semantic, selection.bounds, mask, undefined, "human");
    resultState = result.state; partId = result.partId; changedPixels = result.changedPixels;
  }

  const completedSemantics = unique([...progress.completedSemantics, semantic]);
  const skippedSemantics = progress.skippedSemantics.filter((item) => item !== semantic);
  const shouldAdvance = progress.intent === "replace";
  const next = shouldAdvance ? nextSemantic({ ...progress, completedSemantics, skippedSemantics }) : { phase: progress.phase, semantic };
  resultState = { ...resultState, guidedManual: { ...progress, phase: next.phase, currentSemantic: next.semantic, completedSemantics, skippedSemantics, intent: "replace", updatedAt: stamp(at) }, updatedAt: stamp(at) };
  return { ok: true, state: resultState, partId, changedPixels, message: `${SEMANTIC_TAXONOMY[semantic].label} assigned · ${changedPixels.toLocaleString()} px${shouldAdvance ? ` · next ${SEMANTIC_TAXONOMY[next.semantic].label}` : ""}` };
}

export function guideSelectionForCurrent(state: PartCutterState, foreground: readonly number[]): GuidedSelection | null {
  const initialized = initializeGuidedManual(state); const semantic = initialized.guidedManual!.currentSemantic;
  const zone = initialized.anatomicalGuide?.zones.find((candidate) => candidate.semanticType === semantic);
  if (!zone) return null;
  const mask = zone.mask ?? { width: Math.round(zone.bounds.width), height: Math.round(zone.bounds.height), alpha: new Array(Math.round(zone.bounds.width) * Math.round(zone.bounds.height)).fill(255) };
  const clipped = intersectSelectionWithForeground(zone.bounds, mask, foreground, initialized.sourceCanvasSize);
  return clipped.alpha.some(Boolean) ? { bounds: zone.bounds, mask: clipped } : null;
}

export function unresolvedComponents(state: PartCutterState, foreground: readonly number[]): readonly GuidedSelection[] {
  const canonical = ensureOwnershipPartition(state); const ownership = canonical.ownership!; const labels = decodeOwnership(ownership);
  const candidate = new Uint8Array(labels.length);
  for (let index = 0; index < candidate.length; index += 1) if ((foreground[index] ?? 0) > 0 && labels[index] <= 0) candidate[index] = 1;
  const seen = new Uint8Array(candidate.length); const components: Array<{ pixels: number[]; count: number }> = [];
  for (let start = 0; start < candidate.length; start += 1) {
    if (!candidate[start] || seen[start]) continue;
    const queue = [start]; seen[start] = 1; const pixels: number[] = [];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]; pixels.push(index); const x = index % ownership.width; const y = Math.floor(index / ownership.width);
      for (const next of [x > 0 ? index - 1 : -1, x + 1 < ownership.width ? index + 1 : -1, y > 0 ? index - ownership.width : -1, y + 1 < ownership.height ? index + ownership.width : -1]) if (next >= 0 && candidate[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
    }
    components.push({ pixels, count: pixels.length });
  }
  return components.sort((a, b) => b.count - a.count).map(({ pixels }) => {
    // A component can hold every pixel of a large sprite, so bounds are folded in a loop rather than spread into Math.min/max.
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const index of pixels) { const x = index % ownership.width; const y = Math.floor(index / ownership.width); if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const bounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    const alpha = new Array<number>(bounds.width * bounds.height).fill(0);
    pixels.forEach((index) => { const x = index % ownership.width; const y = Math.floor(index / ownership.width); alpha[(y - bounds.y) * bounds.width + x - bounds.x] = 255; });
    return { bounds, mask: { width: bounds.width, height: bounds.height, alpha } };
  });
}

/** `hidden`: parts the guide found behind others (the far leg in a side view); they get no art, and the rig draws them from their twin. */
export type GuideAllResult = { readonly state: PartCutterState; readonly cut: readonly PartSemanticType[]; readonly missed: readonly PartSemanticType[]; readonly hidden: readonly PartSemanticType[] };

/**
 * Cuts every body part that is not done yet from the suggested outline, in the usual order, as if Use Guide had been
 * pressed on each one. Parts already cut are left alone, so it is safe after some hand cutting. A part with no outline,
 * or whose outline is already taken by other parts, is reported as missed and left for the user.
 */
export function guideAllBodyParts(state: PartCutterState, foreground: readonly number[], at?: string, colours?: ArrayLike<number>): GuideAllResult {
  let current = initializeGuidedManual(state, at);
  const cut: PartSemanticType[] = []; const missed: PartSemanticType[] = []; const hidden: PartSemanticType[] = [];
  for (const semantic of GUIDED_BODY_ORDER) {
    if (current.guidedManual!.completedSemantics.includes(semantic) && targetFor(current, semantic)) continue;
    const zone = current.anatomicalGuide?.zones.find((candidate) => candidate.semanticType === semantic);
    if (zone?.optional && !zone.mask?.alpha.some(Boolean) && !targetFor(current, semantic)) {
      hidden.push(semantic);
      const progress = current.guidedManual!;
      current = { ...current, guidedManual: { ...progress, skippedSemantics: [...new Set([...progress.skippedSemantics, semantic])] } };
      continue;
    }
    const positioned: PartCutterState = { ...current, guidedManual: { ...current.guidedManual!, phase: "body", currentSemantic: semantic, intent: "replace" } };
    const selection = guideSelectionForCurrent(positioned, foreground);
    const result = selection ? commitGuidedSelection(positioned, selection, foreground, at) : null;
    if (result?.ok) { current = result.state; cut.push(semantic); } else missed.push(semantic);
  }
  // The outlines do not quite meet, so slivers of artwork fall between them. When every part came from the outlines,
  // give each sliver to the nearest part now, so the result is complete when the user looks at it. After hand cutting
  // this is skipped, because it would grow the hand-cut parts; Build rig still adopts slivers then, with a smaller reach.
  if (cut.length + hidden.length === GUIDED_BODY_ORDER.length) {
    const { width, height } = current.sourceCanvasSize;
    current = adoptStrayArtwork(current, foreground, Math.max(2, Math.round(Math.hypot(width, height) * .15))).state;
    // Then each boundary moves onto the outline the artist drew next to it (see snapBoundariesToOutlines), up to 3% of
    // the figure's height. Only here, where every part came from the outlines: hand-cut edges are left as drawn.
    let top = height; let bottom = -1;
    for (let index = 0; index < foreground.length; index += 1) if (foreground[index]) { const y = Math.floor(index / width); if (y < top) top = y; if (y > bottom) bottom = y; }
    if (colours && bottom >= top) current = snapBoundariesToOutlines(current, colours, Math.max(2, Math.round((bottom - top + 1) * .03))).state;
  }
  if (cut.length + hidden.length === GUIDED_BODY_ORDER.length) current = reassignDetachedFragments(current).state;
  return { state: current, cut, missed, hidden };
}

/**
 * Re-cuts the given body parts from the current guide, replacing what they own now. Used after a joint is moved, for the
 * parts that came from the guide and whose zone changed; parts the user edited by hand are not passed in, so they are
 * never touched. A part whose zone no longer has any artwork keeps what it had.
 */
export function recutFromGuide(state: PartCutterState, semantics: readonly PartSemanticType[], foreground: readonly number[], at?: string): { readonly state: PartCutterState; readonly recut: readonly PartSemanticType[] } {
  let current = initializeGuidedManual(state, at); const recut: PartSemanticType[] = [];
  const progress = current.guidedManual!;
  for (const semantic of semantics) {
    const target = targetFor(current, semantic);
    const withoutPart = target ? removeOwnershipRegion(current, target.partId, "human") : current;
    const positioned: PartCutterState = { ...withoutPart, guidedManual: { ...withoutPart.guidedManual!, currentSemantic: semantic, intent: "replace" } };
    const selection = guideSelectionForCurrent(positioned, foreground);
    const result = selection ? commitGuidedSelection(positioned, selection, foreground, at) : null;
    if (result?.ok) { current = result.state; recut.push(semantic); }
  }
  // Re-cutting must not move the user along the guided steps.
  return { state: { ...current, guidedManual: { ...current.guidedManual!, phase: progress.phase, currentSemantic: progress.currentSemantic, intent: progress.intent } }, recut };
}

/** Body parts whose guide zone differs between two guides (a moved joint changes only its neighbours' zones). */
export function changedZoneSemantics(before: PartCutterState["anatomicalGuide"], after: PartCutterState["anatomicalGuide"]): readonly PartSemanticType[] {
  if (!before || !after) return [];
  const key = (zone: NonNullable<PartCutterState["anatomicalGuide"]>["zones"][number]) => JSON.stringify([zone.bounds, zone.mask?.alpha.length ?? 0, zone.mask ? zone.mask.alpha.reduce((sum: number, value: number, index: number) => value ? (sum + index) % 2_147_483_647 : sum, 0) : 0]);
  const old = new Map(before.zones.map((zone) => [zone.semanticType, key(zone)]));
  return after.zones.filter((zone) => old.get(zone.semanticType) !== key(zone)).map((zone) => zone.semanticType);
}

/**
 * A full-canvas mask from a click-to-select model, cropped to the connected piece under `seed` (or the largest piece when
 * the seed misses the mask). Models scatter small stray components around an object (body-segmentation skill ch02);
 * only the object that was pointed at is kept. Null when the mask is empty.
 */
export function selectionFromCanvasMask(alpha: ArrayLike<number>, width: number, height: number, seed?: { readonly x: number; readonly y: number }): GuidedSelection | null {
  const seen = new Uint8Array(width * height); let best: number[] | null = null; let seeded: number[] | null = null;
  const seedIndex = seed ? Math.round(seed.y) * width + Math.round(seed.x) : -1;
  for (let start = 0; start < width * height; start += 1) {
    if (!(alpha[start] > 0) || seen[start]) continue;
    const queue = [start]; seen[start] = 1;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]; const x = index % width; const y = Math.floor(index / width);
      for (const next of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) if (next >= 0 && alpha[next] > 0 && !seen[next]) { seen[next] = 1; queue.push(next); }
    }
    if (queue.includes(seedIndex)) seeded = queue;
    if (!best || queue.length > best.length) best = queue;
  }
  const pixels = seeded ?? best; if (!pixels) return null;
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (const index of pixels) { const x = index % width; const y = Math.floor(index / width); if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const bounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const cropped = new Array<number>(bounds.width * bounds.height).fill(0);
  for (const index of pixels) cropped[(Math.floor(index / width) - minY) * bounds.width + index % width - minX] = 255;
  return { bounds, mask: { width: bounds.width, height: bounds.height, alpha: cropped } };
}

/**
 * The selection grown by one pixel onto neighbouring artwork. A model's mask stops just inside an object's drawn outline,
 * which otherwise stays with whatever part lies next to it (a chibi's head kept the dark edge of the sword beside it, and
 * its hidden-area fill then painted the sword's whole shape as head).
 */
/**
 * The selection plus the outline drawn around it. A segmentation model's mask stops at the object's colour and leaves its
 * dark outline behind, and that outline is one art pixel thick: one screen pixel for small sprites, several for pixel art
 * drawn larger. So the mask grows through connected outline-dark pixels (up to OUTLINE_REACH), and by one pixel of any
 * colour when no colours are given.
 */
const OUTLINE_REACH = 12;
function withOutline(selection: GuidedSelection, foreground: readonly number[], width: number, height: number, colours?: ArrayLike<number>): GuidedSelection {
  const reach = colours ? OUTLINE_REACH : 1;
  const left = Math.max(0, selection.bounds.x - reach); const top = Math.max(0, selection.bounds.y - reach);
  const right = Math.min(width, selection.bounds.x + selection.bounds.width + reach); const bottom = Math.min(height, selection.bounds.y + selection.bounds.height + reach);
  const bounds = { x: left, y: top, width: right - left, height: bottom - top }; const alpha = new Array<number>(bounds.width * bounds.height).fill(0);
  const inside = (x: number, y: number) => { const lx = x - selection.bounds.x; const ly = y - selection.bounds.y; return lx >= 0 && ly >= 0 && lx < selection.mask.width && ly < selection.mask.height && selection.mask.alpha[ly * selection.mask.width + lx] > 0; };
  const local = (x: number, y: number) => (y - top) * bounds.width + x - left;
  const dark = (x: number, y: number) => { if (!colours) return false; const i = (y * width + x) * 4; return 0.299 * colours[i] + 0.587 * colours[i + 1] + 0.114 * colours[i + 2] < 72; };
  const queue: [number, number, number][] = [];
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) if (inside(x, y)) { alpha[local(x, y)] = 255; queue.push([x, y, 0]); }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const [x, y, depth] = queue[cursor];
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      if (nx < left || ny < top || nx >= right || ny >= bottom || alpha[local(nx, ny)] || !((foreground[ny * width + nx] ?? 0) > 0)) continue;
      // Outline pixels are taken however thick the outline is; anything else only as the one-pixel ring.
      if (depth === 0 || (dark(nx, ny) && depth < reach)) { if (!colours && depth > 0) continue; alpha[local(nx, ny)] = 255; if (dark(nx, ny)) queue.push([nx, ny, depth + 1]); }
    }
  }
  // Closing (grow then shrink by CLOSE_RADIUS, within the figure): fills the nibbles a model's mask leaves along an object's
  // edge, such as a lighter rim, without reaching as far as a separate shape like the hand holding it.
  if (colours) close(alpha, bounds, foreground, width);
  return { bounds, mask: { width: bounds.width, height: bounds.height, alpha } };
}

/** Clothing that hangs over the legs as one piece of cloth, named in a character's description. */
export const SKIRT_WORDS = /\b(robes?|gown|dress|long skirt|cassock|kimono|frock|habit)\b/i;

/**
 * A character in a long robe or dress: the cloth over the legs is one piece, and cutting it into thighs and lower legs
 * tears it apart as soon as the legs move. When the legs show no gap between them for most of their height, the thigh and
 * lower-leg pixels join the torso (the cloth moves with the body) and only the feet stay as leg parts, peeking out under
 * the hem as the hidden leg bones walk. That is how a hand animator treats a robe.
 */
export function foldLegsIntoSkirt(state: PartCutterState, foreground: readonly number[], colours?: ArrayLike<number>): { readonly state: PartCutterState; readonly folded: readonly PartSemanticType[] } {
  const torso = state.parts.find((part) => part.semanticType === "torso");
  const legs = state.parts.filter((part) => /^(left|right)(Thigh|LowerLeg)$/.test(part.semanticType));
  if (!torso || legs.length < 2) return { state, folded: [] };
  const { width, height } = state.sourceCanvasSize; const pixels = new Uint8Array(width * height);
  for (const part of legs) for (let y = 0; y < part.mask.height; y += 1) for (let x = 0; x < part.mask.width; x += 1) {
    if (!(part.mask.alpha[y * part.mask.width + x] > 0)) continue;
    const gx = Math.round(part.boundingBox.x) + x; const gy = Math.round(part.boundingBox.y) + y; if (gx >= 0 && gy >= 0 && gx < width && gy < height) pixels[gy * width + gx] = 1;
  }
  let rows = 0; let gapRows = 0; let top = height; let bottom = -1; let left = width; let right = -1;
  for (let y = 0; y < height; y += 1) {
    let first = -1; let last = -1;
    for (let x = 0; x < width; x += 1) if (pixels[y * width + x]) { if (first < 0) first = x; last = x; }
    if (first < 0) continue;
    rows += 1; top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, first); right = Math.max(right, last);
    for (let x = first; x <= last; x += 1) if (!((foreground[y * width + x] ?? 0) > 0)) { gapRows += 1; break; }
  }
  if (!rows || gapRows / rows >= .4) return { state, folded: [] };
  // The hem: pixels of the feet in the robe's own colours belong to the cloth, not to the boots, or they tear off with the
  // feet when the hidden legs step.
  if (colours) {
    const key = (index: number) => ((colours[index * 4] >> 3) << 10) | ((colours[index * 4 + 1] >> 3) << 5) | (colours[index * 4 + 2] >> 3);
    const robe = new Map<number, number>(); let robePixels = 0;
    for (let i = 0; i < pixels.length; i += 1) if (pixels[i]) { robe.set(key(i), (robe.get(key(i)) ?? 0) + 1); robePixels += 1; }
    // Robe colours: common in the folded cloth (3% or more) and not the dark outline every shape shares.
    const dark = (index: number) => colours[index * 4] * .299 + colours[index * 4 + 1] * .587 + colours[index * 4 + 2] * .114 < 60;
    for (const part of state.parts.filter((candidate) => /^(left|right)Foot$/.test(candidate.semanticType))) {
      const hem: number[] = []; let footPixels = 0;
      for (let y = 0; y < part.mask.height; y += 1) for (let x = 0; x < part.mask.width; x += 1) {
        if (!(part.mask.alpha[y * part.mask.width + x] > 0)) continue;
        const gx = Math.round(part.boundingBox.x) + x; const gy = Math.round(part.boundingBox.y) + y; if (gx < 0 || gy < 0 || gx >= width || gy >= height) continue;
        footPixels += 1; const index = gy * width + gx;
        if (!dark(index) && (robe.get(key(index)) ?? 0) >= robePixels * .03) hem.push(index);
      }
      // The boot stays a foot: a "foot" that is mostly robe colour is left alone rather than emptied.
      if (hem.length > footPixels * .6) continue;
      for (const index of hem) { const gx = index % width; const gy = (index - gx) / width; pixels[index] = 1; top = Math.min(top, gy); bottom = Math.max(bottom, gy); left = Math.min(left, gx); right = Math.max(right, gx); }
    }
  }
  const bounds = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  const alpha = new Array<number>(bounds.width * bounds.height).fill(0);
  for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) if (pixels[y * width + x]) alpha[(y - top) * bounds.width + x - left] = 255;
  let current = assignOwnershipSelection(state, torso.partId, bounds, { width: bounds.width, height: bounds.height, alpha }, { actor: "ai", action: "assign" }).state;
  const folded = legs.map((part) => part.semanticType);
  for (const part of legs) if (current.parts.some((candidate) => candidate.partId === part.partId)) current = removeOwnershipRegion(current, part.partId, "ai");
  const progress = current.guidedManual;
  if (progress) current = { ...current, guidedManual: { ...progress, completedSemantics: progress.completedSemantics.filter((semantic) => !folded.includes(semantic)), skippedSemantics: [...new Set([...progress.skippedSemantics, ...folded])] } };
  return { state: current, folded };
}

/**
 * An arm hidden behind the item it holds (the shield arm of a character facing the viewer): its cut parts are slivers of
 * outline, a small fraction of its twin's, and rotating slivers draws debris. Such an arm is treated as hidden: its
 * slivers go to the nearest part (the item they outline), and the rig draws it from its twin, behind the body, as it does
 * a side view's far arm. Only an arm whose hand holds one of the items just cut is considered.
 */
const HIDDEN_ARM_SHARE = .2;
function hideCoveredArms(state: PartCutterState, holdingSides: readonly ("left" | "right")[], foreground: readonly number[]): { readonly state: PartCutterState; readonly hidden: readonly PartSemanticType[] } {
  const area = (part: PartCutterState["parts"][number]) => { let n = 0; for (const value of part.mask.alpha) if (value > 0) n += 1; return n; };
  const armOf = (side: "left" | "right") => (["UpperArm", "Forearm", "Hand"] as const).map((piece) => `${side}${piece}` as PartSemanticType);
  let current = state; const hidden: PartSemanticType[] = [];
  for (const side of holdingSides) {
    const twin = side === "left" ? "right" : "left";
    const mine = current.parts.filter((part) => armOf(side).includes(part.semanticType));
    const theirs = current.parts.filter((part) => armOf(twin).includes(part.semanticType));
    const twinArea = theirs.reduce((sum, part) => sum + area(part), 0);
    if (!mine.length || !twinArea || mine.reduce((sum, part) => sum + area(part), 0) >= twinArea * HIDDEN_ARM_SHARE) continue;
    for (const part of mine) current = removeOwnershipRegion(current, part.partId, "ai");
    hidden.push(...mine.map((part) => part.semanticType));
  }
  if (!hidden.length) return { state: current, hidden };
  const { width, height } = current.sourceCanvasSize;
  current = adoptStrayArtwork(current, foreground, Math.max(2, Math.round(Math.hypot(width, height) * .05))).state;
  const progress = current.guidedManual;
  if (progress) current = { ...current, guidedManual: { ...progress, completedSemantics: progress.completedSemantics.filter((semantic) => !hidden.includes(semantic)), skippedSemantics: [...new Set([...progress.skippedSemantics, ...hidden])] } };
  return { state: current, hidden };
}

/**
 * A blade, spear or axe completed along its own axis: a segmentation model often stops at the grip and guard where they
 * cross the body, and the body part then keeps them, so they stay behind (a grey ghost) when the weapon swings. Every drawn
 * pixel in a narrow corridor around the item's long axis, up to a third past its ends, joins it unless an arm owns it (the
 * hand around the grip stays the hand's). Items that are not elongated, such as a round shield, are left as they are.
 */
function alongBlade(selection: GuidedSelection, state: PartCutterState, foreground: readonly number[], width: number, height: number): GuidedSelection {
  const { bounds, mask } = selection; let n = 0; let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
  for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) if (mask.alpha[y * mask.width + x] > 0) { const gx = x + bounds.x; const gy = y + bounds.y; n += 1; sx += gx; sy += gy; sxx += gx * gx; syy += gy * gy; sxy += gx * gy; }
  if (n < 16) return selection;
  const mx = sx / n; const my = sy / n; const vxx = sxx / n - mx * mx; const vyy = syy / n - my * my; const vxy = sxy / n - mx * my;
  const spread = Math.sqrt(((vxx - vyy) / 2) ** 2 + vxy ** 2); const major = (vxx + vyy) / 2 + spread; const minor = Math.max(1e-6, (vxx + vyy) / 2 - spread);
  if (Math.sqrt(major / minor) < 2.5) return selection;
  const angle = .5 * Math.atan2(2 * vxy, vxx - vyy); const ux = Math.cos(angle); const uy = Math.sin(angle);
  let lo = Infinity; let hi = -Infinity; let across = 0;
  for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) if (mask.alpha[y * mask.width + x] > 0) {
    const dx = x + bounds.x - mx; const dy = y + bounds.y - my; const along = dx * ux + dy * uy; lo = Math.min(lo, along); hi = Math.max(hi, along);
    across = Math.max(across, Math.abs(-dx * uy + dy * ux));
  }
  // Only the grip end extends: the end nearer the body's centre (the tip points away from the body).
  let bx = 0; let by = 0; let bn = 0; for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) if ((foreground[y * width + x] ?? 0) > 0) { bx += x; by += y; bn += 1; }
  const towardBody = bn ? ((bx / bn - mx) * ux + (by / bn - my) * uy) : 0;
  const length = hi - lo; if (towardBody < 0) lo -= length / 3; else hi += length / 3; const halfWidth = Math.max(2, across * .6);
  const ownership = ensureOwnershipPartition(state).ownership; if (!ownership) return selection;
  const labels = decodeOwnership(ownership);
  const armOwned = (index: number) => { const regionId = ownership.regionIds[labels[index] - 1]; const part = state.parts.find((candidate) => candidate.partId === regionId); return Boolean(part && /Arm|Forearm|Hand/.test(part.semanticType)); };
  const ends = [[mx + ux * lo, my + uy * lo], [mx + ux * hi, my + uy * hi]];
  const left = Math.max(0, Math.floor(Math.min(bounds.x, ...ends.map((p) => p[0])) - halfWidth)); const top = Math.max(0, Math.floor(Math.min(bounds.y, ...ends.map((p) => p[1])) - halfWidth));
  const right = Math.min(width, Math.ceil(Math.max(bounds.x + bounds.width, ...ends.map((p) => p[0])) + halfWidth)); const bottom = Math.min(height, Math.ceil(Math.max(bounds.y + bounds.height, ...ends.map((p) => p[1])) + halfWidth));
  const out = { x: left, y: top, width: right - left, height: bottom - top }; const alpha = new Array<number>(out.width * out.height).fill(0);
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const lx = x - bounds.x; const ly = y - bounds.y;
    if (lx >= 0 && ly >= 0 && lx < mask.width && ly < mask.height && mask.alpha[ly * mask.width + lx] > 0) { alpha[(y - top) * out.width + x - left] = 255; continue; }
    const index = y * width + x; if (!((foreground[index] ?? 0) > 0) || armOwned(index)) continue;
    const dx = x - mx; const dy = y - my; const along = dx * ux + dy * uy;
    if (along >= lo && along <= hi && Math.abs(-dx * uy + dy * ux) <= halfWidth) alpha[(y - top) * out.width + x - left] = 255;
  }
  return { bounds: out, mask: { width: out.width, height: out.height, alpha } };
}

const CLOSE_RADIUS = 6;
function close(alpha: number[], bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, foreground: readonly number[], width: number): void {
  const w = bounds.width; const h = bounds.height; const r = CLOSE_RADIUS;
  const sweep = (from: Uint8Array, grow: boolean) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      let hit = !grow;
      for (let dy = -r; dy <= r && hit !== grow; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
        if (dx * dx + dy * dy > r * r) continue;
        const nx = x + dx; const ny = y + dy; const on = nx >= 0 && ny >= 0 && nx < w && ny < h && from[ny * w + nx] === 1;
        if (grow ? on : !on) { hit = grow; break; }
      }
      out[y * w + x] = hit ? 1 : 0;
    }
    return out;
  };
  const mask = Uint8Array.from(alpha, (value) => value > 0 ? 1 : 0);
  const closed = sweep(sweep(mask, true), false);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x; if (closed[i] && !mask[i] && (foreground[(bounds.y + y) * width + bounds.x + x] ?? 0) > 0) alpha[i] = 255;
  }
}

/**
 * Cuts held objects as equipment for the hand holding them: the screen-right hand's as main-hand equipment, the
 * screen-left hand's as off-hand (the rig attaches those to the right-hand and left-hand bones). Pixels other parts own
 * are carved out of them, as a loop drawn over existing parts is. The guided step the user is on does not move.
 */
export function commitHeldObjects(state: PartCutterState, items: readonly (GuidedSelection & { readonly hand: "left" | "right" })[], foreground: readonly number[], at?: string, colours?: ArrayLike<number>): { readonly state: PartCutterState; readonly cut: readonly PartSemanticType[]; readonly hidden: readonly PartSemanticType[] } {
  let current = initializeGuidedManual(state, at); const progress = current.guidedManual!; const cut: PartSemanticType[] = [];
  const { width, height } = state.sourceCanvasSize;
  for (const item of items) {
    const semantic: PartSemanticType = item.hand === "right" ? "mainHandEquipment" : "offHandEquipment";
    if (cut.includes(semantic)) continue;
    const positioned: PartCutterState = { ...current, guidedManual: { ...current.guidedManual!, phase: "equipment", currentSemantic: semantic, intent: "replace" } };
    const outlined = withOutline(item, foreground, width, height, colours);
    const selection = colours ? alongBlade(outlined, current, foreground, width, height) : outlined;
    const result = commitGuidedSelection(positioned, selection, foreground, at, true);
    if (result.ok) { current = result.state; cut.push(semantic); }
  }
  const sides = cut.map((semantic) => semantic === "mainHandEquipment" ? "right" as const : "left" as const);
  const covered = colours ? hideCoveredArms(current, sides, foreground) : { state: current, hidden: [] as PartSemanticType[] };
  current = covered.state;
  if (colours) current = reassignDetachedFragments(current).state;
  return { state: { ...current, guidedManual: { ...current.guidedManual!, phase: progress.phase, currentSemantic: progress.currentSemantic, intent: progress.intent } }, cut, hidden: covered.hidden };
}

/**
 * Pieces of one held object that a click-to-select model returned separately (the rope and the claw of a grappling hook)
 * are joined: items for the same hand whose masks touch, or nearly (within `gap` pixels), become one item.
 */
export function mergeHeldPieces<T extends GuidedSelection & { readonly hand: "left" | "right" }>(items: readonly T[], gap = 2): (GuidedSelection & { readonly hand: "left" | "right" })[] {
  const merged: (GuidedSelection & { readonly hand: "left" | "right" })[] = [];
  const has = (item: GuidedSelection, x: number, y: number) => { const lx = x - item.bounds.x; const ly = y - item.bounds.y; return lx >= 0 && ly >= 0 && lx < item.mask.width && ly < item.mask.height && item.mask.alpha[ly * item.mask.width + lx] > 0; };
  const touches = (a: GuidedSelection, b: GuidedSelection) => {
    if (a.bounds.x > b.bounds.x + b.bounds.width + gap || b.bounds.x > a.bounds.x + a.bounds.width + gap || a.bounds.y > b.bounds.y + b.bounds.height + gap || b.bounds.y > a.bounds.y + a.bounds.height + gap) return false;
    for (let y = 0; y < a.mask.height; y += 1) for (let x = 0; x < a.mask.width; x += 1) if (a.mask.alpha[y * a.mask.width + x]) for (let dy = -gap; dy <= gap; dy += 1) for (let dx = -gap; dx <= gap; dx += 1) if (has(b, a.bounds.x + x + dx, a.bounds.y + y + dy)) return true;
    return false;
  };
  for (const item of items) {
    const joined = merged.findIndex((other) => other.hand === item.hand && touches(other, item));
    if (joined < 0) { merged.push(item); continue; }
    const other = merged[joined];
    const left = Math.min(other.bounds.x, item.bounds.x); const top = Math.min(other.bounds.y, item.bounds.y);
    const right = Math.max(other.bounds.x + other.bounds.width, item.bounds.x + item.bounds.width); const bottom = Math.max(other.bounds.y + other.bounds.height, item.bounds.y + item.bounds.height);
    const bounds = { x: left, y: top, width: right - left, height: bottom - top }; const alpha = new Array<number>(bounds.width * bounds.height).fill(0);
    for (let y = 0; y < bounds.height; y += 1) for (let x = 0; x < bounds.width; x += 1) if (has(other, left + x, top + y) || has(item, left + x, top + y)) alpha[y * bounds.width + x] = 255;
    merged[joined] = { bounds, mask: { width: bounds.width, height: bounds.height, alpha }, hand: item.hand };
  }
  return merged;
}

/**
 * The held objects to cut, one per hand: pieces in the same hand that touch are joined first (`mergeHeldPieces`), and an
 * object found from the hand itself (`fromHand`) is used only when the silhouette found nothing for that hand, since a
 * mask grown from a hand can be the arm. Of what is left, the largest object in each hand.
 */
export function chooseHeldObjects(items: readonly (GuidedSelection & { readonly hand: "left" | "right"; readonly fromHand?: boolean })[]): (GuidedSelection & { readonly hand: "left" | "right" })[] {
  const silhouetteHands = new Set(items.filter((item) => !item.fromHand).map((item) => item.hand));
  const usable = items.filter((item) => !item.fromHand || !silhouetteHands.has(item.hand));
  const size = (item: GuidedSelection) => item.mask.alpha.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0);
  const merged = mergeHeldPieces(usable, 12).sort((a, b) => size(b) - size(a)); // 12 px: three art pixels of 4x pixel art
  return merged.filter((item, index) => merged.findIndex((other) => other.hand === item.hand) === index);
}
