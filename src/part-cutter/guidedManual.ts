import type { Rect, SegmentationMask } from "../character-generation/segmentation/segmentationSchema";
import { createManualRegionFromSelection, intersectSelectionWithForeground } from "./manualPartition";
import { assignOwnershipSelection, decodeOwnership, ensureOwnershipPartition, removeOwnershipRegion } from "./ownership";
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

function targetFor(state: PartCutterState, semantic: PartSemanticType) {
  return state.parts.find((part) => part.semanticType === semantic);
}

export function commitGuidedSelection(state: PartCutterState, selection: GuidedSelection, foreground: readonly number[], at?: string): GuidedCommitResult {
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
    const mask = safeMask(initialized, target!.partId, { bounds: selection.bounds, mask: clipped });
    if (!mask.alpha.some(Boolean)) return { ok: false, state, changedPixels: 0, message: "Those pixels already belong to another manual region." };
    const result = assignOwnershipSelection(initialized, target!.partId, selection.bounds, mask, { actor: "human", includeBackground: true });
    if (!result.changedPixels) return { ok: false, state, changedPixels: 0, message: "No ownership changed." };
    resultState = result.state; changedPixels = result.changedPixels;
  } else {
    const mask = safeMask(initialized, target?.partId ?? null, { bounds: selection.bounds, mask: clipped });
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
    const xs = pixels.map((index) => index % ownership.width); const ys = pixels.map((index) => Math.floor(index / ownership.width));
    const bounds = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs) + 1, height: Math.max(...ys) - Math.min(...ys) + 1 };
    const alpha = new Array<number>(bounds.width * bounds.height).fill(0);
    pixels.forEach((index) => { const x = index % ownership.width; const y = Math.floor(index / ownership.width); alpha[(y - bounds.y) * bounds.width + x - bounds.x] = 255; });
    return { bounds, mask: { width: bounds.width, height: bounds.height, alpha } };
  });
}
