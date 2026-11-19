import type { Rect, SegmentationMask } from "../character-generation/segmentation/segmentationSchema";
import { createManualRegionFromSelection, intersectSelectionWithForeground } from "./manualPartition";
import { adoptStrayArtwork, assignOwnershipSelection, decodeOwnership, ensureOwnershipPartition, removeOwnershipRegion } from "./ownership";
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
export function guideAllBodyParts(state: PartCutterState, foreground: readonly number[], at?: string): GuideAllResult {
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
  }
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
function withOutline(selection: GuidedSelection, foreground: readonly number[], width: number, height: number): GuidedSelection {
  const left = Math.max(0, selection.bounds.x - 1); const top = Math.max(0, selection.bounds.y - 1);
  const right = Math.min(width, selection.bounds.x + selection.bounds.width + 1); const bottom = Math.min(height, selection.bounds.y + selection.bounds.height + 1);
  const bounds = { x: left, y: top, width: right - left, height: bottom - top }; const alpha = new Array<number>(bounds.width * bounds.height).fill(0);
  const inside = (x: number, y: number) => { const lx = x - selection.bounds.x; const ly = y - selection.bounds.y; return lx >= 0 && ly >= 0 && lx < selection.mask.width && ly < selection.mask.height && selection.mask.alpha[ly * selection.mask.width + lx] > 0; };
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    if (inside(x, y) || ((foreground[y * width + x] ?? 0) > 0 && (inside(x - 1, y) || inside(x + 1, y) || inside(x, y - 1) || inside(x, y + 1)))) alpha[(y - top) * bounds.width + x - left] = 255;
  }
  return { bounds, mask: { width: bounds.width, height: bounds.height, alpha } };
}

/**
 * Cuts held objects as equipment for the hand holding them: the screen-right hand's as main-hand equipment, the
 * screen-left hand's as off-hand (the rig attaches those to the right-hand and left-hand bones). Pixels other parts own
 * are carved out of them, as a loop drawn over existing parts is. The guided step the user is on does not move.
 */
export function commitHeldObjects(state: PartCutterState, items: readonly (GuidedSelection & { readonly hand: "left" | "right" })[], foreground: readonly number[], at?: string): { readonly state: PartCutterState; readonly cut: readonly PartSemanticType[] } {
  let current = initializeGuidedManual(state, at); const progress = current.guidedManual!; const cut: PartSemanticType[] = [];
  const { width, height } = state.sourceCanvasSize;
  for (const item of items) {
    const semantic: PartSemanticType = item.hand === "right" ? "mainHandEquipment" : "offHandEquipment";
    if (cut.includes(semantic)) continue;
    const positioned: PartCutterState = { ...current, guidedManual: { ...current.guidedManual!, phase: "equipment", currentSemantic: semantic, intent: "replace" } };
    const result = commitGuidedSelection(positioned, withOutline(item, foreground, width, height), foreground, at, true);
    if (result.ok) { current = result.state; cut.push(semantic); }
  }
  return { state: { ...current, guidedManual: { ...current.guidedManual!, phase: progress.phase, currentSemantic: progress.currentSemantic, intent: progress.intent } }, cut };
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
  const merged = mergeHeldPieces(usable).sort((a, b) => size(b) - size(a));
  return merged.filter((item, index) => merged.findIndex((other) => other.hand === item.hand) === index);
}
