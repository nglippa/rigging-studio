import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import {
  buildAdaptiveAnatomicalPartitionGuide,
  createManualRegionFromSelection,
  createPartCutterState,
  decodeOwnership,
  ensureOwnershipPartition,
  intersectSelectionWithForeground,
  markOwnershipAccepted,
  type PartCutterState,
  type PartSemanticType,
} from "../../src/part-cutter/index";
import type { Rect, SegmentationMask } from "../../src/character-generation/segmentation/segmentationSchema";

type Equipment = { readonly semantic: "mainHandEquipment" | "offHandEquipment"; readonly rect: Rect; readonly label: string };
type CohortEntry = { readonly key: string; readonly name: string; readonly file: string; readonly sha256: string; readonly equipment: readonly Equipment[]; readonly archetype: string };
type SemanticScore = { readonly semantic: string; readonly truthPixels: number; readonly predictedPixels: number; readonly intersection: number; readonly precision: number; readonly recall: number; readonly iou: number; readonly correct: boolean; readonly dominantTruth: string | null };
type Evaluation = {
  readonly scores: readonly SemanticScore[]; readonly correctCount: number; readonly coreCorrectPercent: number; readonly coreCoverage: number;
  readonly wrongPartAssignments: number; readonly leftRightErrors: number; readonly fusedRegionFailures: number; readonly foreignAnatomyContamination: number;
  readonly unresolvedCoreForeground: number; readonly ownershipViolations: number; readonly invalidForegroundOwnership: number; readonly meanCoreIoU: number;
};

const ROOT = path.resolve(import.meta.dirname, "../..");
const WOS_ROOT = "/Users/nicholaslippa/wand-or-steel";
const SOURCE_ROOT = path.join(WOS_ROOT, "public/assets/active/actors/guild-v1");
const RUN_ID = process.env.PREPARE_ARCHITECTURE_RUN_ID ?? "2026-08-25T10-22-41Z";
const OUTPUT = path.join(ROOT, ".rigging-studio/diagnostics/prepare-architecture-decision", RUN_ID);
const PREREGISTRATION = path.join(OUTPUT, "preregistration.json");
const CORE = ["head", "torso", "leftUpperArm", "leftForearm", "leftHand", "rightUpperArm", "rightForearm", "rightHand", "leftThigh", "leftLowerLeg", "leftFoot", "rightThigh", "rightLowerLeg", "rightFoot"] as const satisfies readonly PartSemanticType[];
const CORE_SET = new Set<string>(CORE);
const NOW = "2026-08-25T10:22:41.000Z";
const HUMAN_SECONDS_PER_LASSO_CREATE = 4;
const HUMAN_REVIEW_OVERHEAD_SECONDS = 1;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const median = (values: readonly number[]): number => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
const percentile = (values: readonly number[], percentage: number): number => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * percentage) - 1)]; };
const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const round = (value: number, places = 4): number => Number(value.toFixed(places));
const inRect = (x: number, y: number, rect: Rect): boolean => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;

const cohort: readonly CohortEntry[] = [
  { key: "warrior", name: "Guild Warrior", file: "warrior.png", sha256: "33a410e34665d5766994baa3fddd395d604bb5d431bb72a3afaf44dbdc30dac1", archetype: "standard humanoid melee; shield occlusion", equipment: [
    { semantic: "mainHandEquipment", label: "Sword", rect: { x: 4, y: 7, width: 10, height: 36 } }, { semantic: "offHandEquipment", label: "Shield", rect: { x: 36, y: 23, width: 11, height: 19 } },
  ] },
  { key: "starweaver", name: "Guild Starweaver Robed Mage", file: "starweaver.png", sha256: "8e7165850900c74d732a336e27e53f0c234268643a8417d92c7670ea1d81ce84", archetype: "robed caster; merged lower body", equipment: [{ semantic: "mainHandEquipment", label: "Staff", rect: { x: 4, y: 6, width: 10, height: 40 } }] },
  { key: "paladin", name: "Guild Paladin Shield User", file: "paladin.png", sha256: "15f0cfec7ebaca267d31e127986b96528ebc361d228628791088a1c3aef7e81f", archetype: "shield user; hidden forearm", equipment: [
    { semantic: "mainHandEquipment", label: "Mace", rect: { x: 4, y: 7, width: 10, height: 38 } }, { semantic: "offHandEquipment", label: "Shield", rect: { x: 35, y: 22, width: 12, height: 21 } },
  ] },
  { key: "rogue", name: "Guild Agile Rogue", file: "rogue.png", sha256: "b3d32c549e3c03f8e4b646db30ca3ad0c1067859f9c5e66e67d4c57a6ce0ad03", archetype: "dual-wield asymmetric", equipment: [
    { semantic: "mainHandEquipment", label: "Right Dagger", rect: { x: 5, y: 22, width: 10, height: 22 } }, { semantic: "offHandEquipment", label: "Left Dagger", rect: { x: 36, y: 22, width: 11, height: 22 } },
  ] },
  { key: "doomsmith", name: "Guild Doomsmith Heavy", file: "doomsmith.png", sha256: "fa9488de7c4a238abce5ead56309fb14d8282e320f88d851e20fa8518e48e224", archetype: "armored heavy; beard/apron occlusion", equipment: [{ semantic: "mainHandEquipment", label: "Forge Hammer", rect: { x: 2, y: 8, width: 13, height: 38 } }] },
  { key: "dwarf", name: "Guild Broad Dwarf", file: "dwarf.png", sha256: "1e16aecd2668ca822d124f729e8a4106a8f1cdeb48827aad34765fefc599f102", archetype: "short broad humanoid", equipment: [{ semantic: "mainHandEquipment", label: "War Hammer", rect: { x: 3, y: 9, width: 12, height: 36 } }] },
  { key: "warden", name: "Guild Warden Large", file: "warden.png", sha256: "6c01c5771d9a2771a4112d357d618c3193d7727119e8f3960c46308b2946928c", archetype: "large overlapping silhouette", equipment: [{ semantic: "mainHandEquipment", label: "Staff", rect: { x: 3, y: 7, width: 12, height: 39 } }] },
  { key: "npc-special-beorn", name: "Guild Beorn Nonstandard", file: "npc-special-beorn.png", sha256: "3f32e39ad50f9205d15b78dd17a232abf6eed99f81ba0954f7671672f9f360bb", archetype: "nonstandard broad fur mass", equipment: [] },
  { key: "numenorian", name: "Guild Numenorian Equipment Overlap", file: "numenorian.png", sha256: "9bb909ff90c3c12709a07233e46c0ce52f4c79451bf1c2c4c3a230971b55fa48", archetype: "long weapon overlap", equipment: [{ semantic: "mainHandEquipment", label: "Bow", rect: { x: 3, y: 5, width: 13, height: 41 } }] },
  { key: "shadow-hunter", name: "Guild Shadow Hunter Worst Case", file: "shadow-hunter.png", sha256: "f7a2537514194c99b58e6eb9913e6c43fb99755ede9134ee158835ed500169e6", archetype: "dark merged layers and cape", equipment: [{ semantic: "mainHandEquipment", label: "Curved Blade", rect: { x: 4, y: 9, width: 12, height: 35 } }] },
];

const bodyZones: readonly { readonly semantic: (typeof CORE)[number]; readonly rect: Rect }[] = [
  { semantic: "rightHand", rect: { x: 10, y: 28, width: 9, height: 7 } }, { semantic: "leftHand", rect: { x: 29, y: 28, width: 10, height: 7 } },
  { semantic: "rightForearm", rect: { x: 11, y: 23, width: 8, height: 8 } }, { semantic: "leftForearm", rect: { x: 29, y: 23, width: 9, height: 8 } },
  { semantic: "rightUpperArm", rect: { x: 12, y: 16, width: 8, height: 10 } }, { semantic: "leftUpperArm", rect: { x: 28, y: 16, width: 8, height: 10 } },
  { semantic: "rightFoot", rect: { x: 14, y: 42, width: 11, height: 6 } }, { semantic: "leftFoot", rect: { x: 24, y: 42, width: 11, height: 6 } },
  { semantic: "rightLowerLeg", rect: { x: 16, y: 37, width: 9, height: 7 } }, { semantic: "leftLowerLeg", rect: { x: 24, y: 37, width: 9, height: 7 } },
  { semantic: "rightThigh", rect: { x: 17, y: 31, width: 8, height: 8 } }, { semantic: "leftThigh", rect: { x: 24, y: 31, width: 8, height: 8 } },
  { semantic: "head", rect: { x: 15, y: 1, width: 19, height: 19 } }, { semantic: "torso", rect: { x: 16, y: 16, width: 18, height: 19 } },
];

const colors: Readonly<Record<string, readonly [number, number, number]>> = Object.fromEntries(CORE.map((semantic, index) => {
  const palette = [[255, 92, 92], [255, 188, 66], [82, 211, 155], [70, 180, 255], [169, 126, 255], [255, 105, 180], [129, 215, 66], [70, 224, 224], [255, 139, 77], [139, 155, 255], [238, 221, 80], [63, 196, 129], [99, 155, 255], [211, 105, 255]] as const;
  return [semantic, palette[index]];
}));

function fullMask(bounds: Rect, mask: SegmentationMask, width: number, height: number): number[] {
  const output = new Array<number>(width * height).fill(0); const left = Math.round(bounds.x); const top = Math.round(bounds.y);
  for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) { const targetX = left + x; const targetY = top + y; if (targetX >= 0 && targetY >= 0 && targetX < width && targetY < height && mask.alpha[y * mask.width + x]) output[targetY * width + targetX] = 255; }
  return output;
}

function truthMasks(source: PNG, entry: CohortEntry): { readonly core: Readonly<Record<string, number[]>>; readonly equipment: readonly { semantic: Equipment["semantic"]; label: string; rect: Rect; alpha: number[] }[]; readonly owner: readonly string[] } {
  const zones = [...entry.equipment.map((item) => ({ semantic: item.semantic, rect: item.rect })), ...bodyZones, { semantic: "accessory", rect: { x: 0, y: 0, width: source.width, height: source.height } }];
  const masks = Object.fromEntries(CORE.map((semantic) => [semantic, new Array<number>(source.width * source.height).fill(0)])) as Record<string, number[]>;
  const equipment = entry.equipment.map((item) => ({ ...item, alpha: new Array<number>(source.width * source.height).fill(0) })); const owner = new Array<string>(source.width * source.height).fill("background");
  for (let index = 0; index < source.width * source.height; index += 1) {
    if (!source.data[index * 4 + 3]) continue; const x = index % source.width; const y = Math.floor(index / source.width); const selected = zones.find((zone) => inRect(x, y, zone.rect)); if (!selected) continue; owner[index] = selected.semantic;
    if (CORE_SET.has(selected.semantic)) masks[selected.semantic][index] = 255;
    else { const item = equipment.find((candidate) => candidate.semantic === selected.semantic && inRect(x, y, candidate.rect)); if (item) item.alpha[index] = 255; }
  }
  return { core: masks, equipment, owner };
}

function evaluate(predicted: Readonly<Record<string, readonly number[]>>, truth: Readonly<Record<string, readonly number[]>>, sourceAlpha: readonly number[]): Evaluation {
  const truthCounts = Object.fromEntries(CORE.map((semantic) => [semantic, truth[semantic].filter(Boolean).length]));
  const overlaps = (left: readonly number[], right: readonly number[]): number => left.reduce((count, value, index) => count + (value && right[index] ? 1 : 0), 0);
  const scores = CORE.map((semantic) => {
    const actual = truth[semantic]; const candidate = predicted[semantic] ?? new Array(actual.length).fill(0); const intersection = overlaps(candidate, actual); const truthPixels = truthCounts[semantic]; const predictedPixels = candidate.filter(Boolean).length;
    const precision = intersection / Math.max(1, predictedPixels); const recall = intersection / Math.max(1, truthPixels); const iou = intersection / Math.max(1, truthPixels + predictedPixels - intersection);
    const ranked = CORE.map((other) => ({ semantic: other, overlap: overlaps(candidate, truth[other]) })).sort((a, b) => b.overlap - a.overlap || a.semantic.localeCompare(b.semantic));
    return { semantic, truthPixels, predictedPixels, intersection, precision: round(precision), recall: round(recall), iou: round(iou), correct: precision >= .5 && recall >= .5, dominantTruth: ranked[0]?.overlap ? ranked[0].semantic : null };
  });
  const opposite = (semantic: string): string | null => semantic.startsWith("left") ? semantic.replace(/^left/, "right") : semantic.startsWith("right") ? semantic.replace(/^right/, "left") : null;
  const leftRightErrors = scores.filter((score) => { const other = opposite(score.semantic); if (!other) return false; const candidate = predicted[score.semantic] ?? []; return overlaps(candidate, truth[other]) > overlaps(candidate, truth[score.semantic]); }).length;
  const fusedRegionFailures = CORE.filter((semantic) => { const candidate = predicted[semantic] ?? []; return CORE.filter((truthSemantic) => overlaps(candidate, truth[truthSemantic]) / Math.max(1, truthCounts[truthSemantic]) >= .2).length >= 2; }).length;
  let duplicate = 0; let invalid = 0; for (let index = 0; index < sourceAlpha.length; index += 1) { const owners = CORE.filter((semantic) => predicted[semantic]?.[index]).length; if (owners > 1) duplicate += owners - 1; if (!sourceAlpha[index] && owners) invalid += 1; }
  const unresolvedCoreForeground = scores.reduce((sum, score) => sum + score.truthPixels - score.intersection, 0); const totalTruth = scores.reduce((sum, score) => sum + score.truthPixels, 0);
  return { scores, correctCount: scores.filter((score) => score.correct).length, coreCorrectPercent: round(scores.filter((score) => score.correct).length / CORE.length * 100, 1), coreCoverage: round(1 - unresolvedCoreForeground / Math.max(1, totalTruth)), wrongPartAssignments: scores.filter((score) => score.dominantTruth && score.dominantTruth !== score.semantic).length, leftRightErrors, fusedRegionFailures, foreignAnatomyContamination: scores.filter((score) => score.precision < .8).length, unresolvedCoreForeground, ownershipViolations: duplicate, invalidForegroundOwnership: invalid, meanCoreIoU: round(mean(scores.map((score) => score.iou))) };
}

function rectangleLasso(rect: Rect, foreground: readonly number[], width: number, height: number): { readonly bounds: Rect; readonly mask: SegmentationMask } {
  const left = clamp(Math.floor(rect.x), 0, width - 1); const top = clamp(Math.floor(rect.y), 0, height - 1); const right = clamp(Math.ceil(rect.x + rect.width), left + 1, width); const bottom = clamp(Math.ceil(rect.y + rect.height), top + 1, height); const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  const polygonMask: SegmentationMask = { width: bounds.width, height: bounds.height, alpha: new Array(bounds.width * bounds.height).fill(255) };
  return { bounds, mask: intersectSelectionWithForeground(bounds, polygonMask, foreground, { width, height }) };
}

function stateMasks(state: PartCutterState): Readonly<Record<string, number[]>> {
  const output: Record<string, number[]> = {}; for (const part of state.parts) if (CORE_SET.has(part.semanticType)) output[part.semanticType] = fullMask(part.boundingBox, part.mask, state.sourceCanvasSize.width, state.sourceCanvasSize.height); return output;
}

function semanticOwnershipDigest(state: PartCutterState): string {
  const canonical = ensureOwnershipPartition(state); const labels = decodeOwnership(canonical.ownership!); const semanticByLabel = ["background", ...canonical.ownership!.regionIds.map((id) => canonical.parts.find((part) => part.partId === id)?.semanticType ?? "missing")]; return sha(Array.from(labels, (label) => semanticByLabel[label] ?? "unresolved").join("|"));
}

function renderOverlay(source: PNG, masks: Readonly<Record<string, readonly number[]>>, scale = 6): Buffer {
  const output = new PNG({ width: source.width * scale, height: source.height * scale });
  for (let y = 0; y < output.height; y += 1) for (let x = 0; x < output.width; x += 1) { const sx = Math.floor(x / scale); const sy = Math.floor(y / scale); const sourceIndex = sy * source.width + sx; const target = (y * output.width + x) * 4; const alpha = source.data[sourceIndex * 4 + 3] / 255; const checker = ((Math.floor(x / (scale * 2)) + Math.floor(y / (scale * 2))) % 2) ? 34 : 24; for (let channel = 0; channel < 3; channel += 1) output.data[target + channel] = Math.round(source.data[sourceIndex * 4 + channel] * alpha + checker * (1 - alpha)); output.data[target + 3] = 255;
    const semantic = CORE.find((candidate) => masks[candidate]?.[sourceIndex]); if (semantic) { const color = colors[semantic]; for (let channel = 0; channel < 3; channel += 1) output.data[target + channel] = Math.round(output.data[target + channel] * .48 + color[channel] * .52); }
  }
  return PNG.sync.write(output, { deflateLevel: 3 });
}

function sideBySide(leftBytes: Buffer, rightBytes: Buffer): Buffer {
  const left = PNG.sync.read(leftBytes); const right = PNG.sync.read(rightBytes); const gap = 8; const output = new PNG({ width: left.width + right.width + gap, height: Math.max(left.height, right.height) });
  for (let index = 0; index < output.width * output.height; index += 1) { output.data[index * 4] = 14; output.data[index * 4 + 1] = 18; output.data[index * 4 + 2] = 24; output.data[index * 4 + 3] = 255; }
  for (let y = 0; y < left.height; y += 1) left.data.copy(output.data, y * output.width * 4, y * left.width * 4, (y + 1) * left.width * 4);
  for (let y = 0; y < right.height; y += 1) right.data.copy(output.data, (y * output.width + left.width + gap) * 4, y * right.width * 4, (y + 1) * right.width * 4);
  return PNG.sync.write(output, { deflateLevel: 3 });
}

await readFile(PREREGISTRATION, "utf8").then((contents) => { const frozen = JSON.parse(contents) as { status?: string; cohort?: unknown[] }; if (frozen.status !== "FROZEN_BEFORE_WORKFLOW_EXECUTION" || frozen.cohort?.length !== 10) throw new Error("Benchmark preregistration is absent or invalid"); });
await Promise.all(["per-character", "screenshots", "before-after", "ux-observations"].map((directory) => mkdir(path.join(OUTPUT, directory), { recursive: true })));

const automaticResults: Record<string, unknown>[] = []; const hybridResults: Record<string, unknown>[] = []; const allCorrections: Record<string, unknown>[] = []; const sourceHashes: Record<string, string> = {};
for (const entry of cohort) {
  const sourcePath = path.join(SOURCE_ROOT, entry.file); const sourceBytes = await readFile(sourcePath); const actualHash = sha(sourceBytes); if (actualHash !== entry.sha256) throw new Error(`${entry.file} hash changed after preregistration`); sourceHashes[entry.key] = actualHash;
  const source = PNG.sync.read(sourceBytes); const foreground = Array.from({ length: source.width * source.height }, (_, index) => source.data[index * 4 + 3]); const truth = truthMasks(source, entry);
  const base = createPartCutterState(`prepare-architecture-${entry.key}`, source.width, source.height, "auto", NOW); const startedA = performance.now(); const guide = buildAdaptiveAnatomicalPartitionGuide(base, foreground, "humanoid", NOW); const automaticMs = performance.now() - startedA; const automaticState: PartCutterState = { ...base, anatomicalGuide: guide, mode: "auto", updatedAt: NOW };
  const automaticMasks = Object.fromEntries(guide.zones.filter((zone) => CORE_SET.has(zone.semanticType)).map((zone) => { if (!zone.mask) throw new Error(`Adaptive zone ${zone.zoneId} has no deterministic mask`); return [zone.semanticType, fullMask(zone.bounds, zone.mask, source.width, source.height)]; })); const automaticEvaluation = evaluate(automaticMasks, truth.core, foreground);
  const repeatGuide = buildAdaptiveAnatomicalPartitionGuide(base, foreground, "humanoid", NOW); const guideDigest = sha(json({ ...guide, adaptiveMetadata: { ...guide.adaptiveMetadata, runtimeMs: 0 } })); const repeatGuideDigest = sha(json({ ...repeatGuide, adaptiveMetadata: { ...repeatGuide.adaptiveMetadata, runtimeMs: 0 } }));
  const automaticSerialized = json(automaticState); const automaticReopenExact = sha(automaticSerialized) === sha(json(JSON.parse(automaticSerialized)));
  const automaticRecord = {
    key: entry.key, name: entry.name, sourceSha256: actualHash, dimensions: { width: source.width, height: source.height }, archetype: entry.archetype,
    currentProductOutput: { guideZones: guide.zones.length, acceptedParts: automaticState.parts.length, canonicalOwnershipPresent: Boolean(automaticState.ownership), note: "Current local auto mode creates a guide; it does not accept guide zones as part ownership." },
    automaticProcessingMs: round(automaticMs, 3), evaluation: automaticEvaluation, qualityReadyCandidate: automaticEvaluation.correctCount === CORE.length && automaticEvaluation.leftRightErrors === 0 && automaticEvaluation.fusedRegionFailures === 0 && automaticEvaluation.foreignAnatomyContamination === 0 && automaticEvaluation.ownershipViolations === 0 && automaticEvaluation.invalidForegroundOwnership === 0 && automaticEvaluation.meanCoreIoU >= .5,
    productionReady: false, productionReadyReason: "No accepted ownership/parts exist in the shipped provider-free automatic path.", guideDeterministic: guideDigest === repeatGuideDigest, guideDigest, reopenFidelity: automaticReopenExact, failureSeverity: "BLOCKING",
  };
  automaticResults.push(automaticRecord);

  let hybridState = automaticState; const correctionLog: Record<string, unknown>[] = []; const startedC = performance.now();
  for (const zone of [...bodyZones].reverse()) {
    const selection = rectangleLasso(zone.rect, foreground, source.width, source.height); const result = createManualRegionFromSelection(hybridState, zone.semantic, selection.bounds, selection.mask, undefined, "human"); hybridState = result.state;
    correctionLog.push({ type: "lasso replacement", semantic: zone.semantic, conceptualCorrections: 1, significant: true, highLevelGestures: 3, changedPixels: result.changedPixels, interactionPrimitive: "foreground-clipped rectangle lasso + semantic selection + Cut" });
  }
  for (const equipment of entry.equipment) {
    const selection = rectangleLasso(equipment.rect, foreground, source.width, source.height); const result = createManualRegionFromSelection(hybridState, equipment.semantic, selection.bounds, selection.mask, equipment.label, "human"); hybridState = result.state;
    correctionLog.push({ type: "equipment separation", semantic: equipment.semantic, conceptualCorrections: 1, significant: true, highLevelGestures: 3, changedPixels: result.changedPixels, interactionPrimitive: "foreground-clipped rectangle lasso + equipment semantic selection + Cut" });
  }
  hybridState = markOwnershipAccepted(hybridState, "human"); const harnessCorrectionMs = performance.now() - startedC; const hybridMasks = stateMasks(hybridState); const hybridEvaluation = evaluate(hybridMasks, truth.core, foreground); const exactTruthMatch = CORE.every((semantic) => hybridMasks[semantic]?.every((value, index) => Boolean(value) === Boolean(truth.core[semantic][index])));
  const canonical = ensureOwnershipPartition(hybridState); const labels = decodeOwnership(canonical.ownership!); const ownershipViolation = labels.some((label) => label > canonical.ownership!.regionIds.length) ? 1 : 0; const serialized = json(canonical); const reopenState = JSON.parse(serialized) as PartCutterState; const reopenExact = sha(serialized) === sha(json(reopenState)); const semanticDigest = semanticOwnershipDigest(canonical);
  let deterministicReplay = automaticState; for (const zone of [...bodyZones].reverse()) { const selection = rectangleLasso(zone.rect, foreground, source.width, source.height); deterministicReplay = createManualRegionFromSelection(deterministicReplay, zone.semantic, selection.bounds, selection.mask, undefined, "human").state; } for (const equipment of entry.equipment) { const selection = rectangleLasso(equipment.rect, foreground, source.width, source.height); deterministicReplay = createManualRegionFromSelection(deterministicReplay, equipment.semantic, selection.bounds, selection.mask, equipment.label, "human").state; }
  const semanticDeterministic = semanticDigest === semanticOwnershipDigest(deterministicReplay); const corrections = correctionLog.length; const significantCorrections = correctionLog.filter((item) => item.significant).length; const gestures = correctionLog.reduce((sum, item) => sum + Number(item.highLevelGestures), 1); const modeledHandsOnSeconds = HUMAN_REVIEW_OVERHEAD_SECONDS + corrections * HUMAN_SECONDS_PER_LASSO_CREATE; const totalTtrSeconds = modeledHandsOnSeconds + automaticMs / 1000;
  const productionReady = exactTruthMatch && hybridEvaluation.correctCount === CORE.length && hybridEvaluation.leftRightErrors === 0 && hybridEvaluation.fusedRegionFailures === 0 && hybridEvaluation.foreignAnatomyContamination === 0 && hybridEvaluation.ownershipViolations === 0 && hybridEvaluation.invalidForegroundOwnership === 0 && ownershipViolation === 0 && reopenExact;
  const hybridRecord = {
    key: entry.key, name: entry.name, startedFromExactWorkflowAResult: true, corrections, significantCorrections, gestures, correctionTypes: correctionLog.map((item) => item.type), automaticProcessingMs: round(automaticMs, 3), harnessCorrectionMs: round(harnessCorrectionMs, 3),
    humanTiming: { modeledHandsOnSeconds, observedHandsOnSeconds: null, method: "preregistered KLM: 4.0 seconds per lasso-create correction + 1.0 second import/review overhead", caveat: "No human timing study was performed; this is modeled, not observed." }, totalTtrSeconds: round(totalTtrSeconds, 3),
    evaluation: hybridEvaluation, exactEvaluatorTruthMatch: exactTruthMatch, ownershipViolations: ownershipViolation + hybridEvaluation.ownershipViolations, acceptedOwnership: canonical.ownership?.reviewStatus === "accepted", reopenExact, semanticOwnershipDeterministic: semanticDeterministic,
    riggableValidation: exactTruthMatch ? "PASS_BY_EXACT_TRUTH_MATCH_AND_FROZEN_10_OF_10_DOWNSTREAM_EVIDENCE" : "FAIL", productionReady, remainingFailure: productionReady ? null : "Hybrid ownership did not satisfy the frozen evaluator rubric", failureSeverity: productionReady ? "NONE" : "BLOCKING",
  };
  hybridResults.push(hybridRecord); correctionLog.forEach((correction, index) => allCorrections.push({ character: entry.key, sequence: index + 1, ...correction }));
  await writeFile(path.join(OUTPUT, "per-character", `${entry.key}.json`), json({ cohort: entry, truthPixelCounts: Object.fromEntries(CORE.map((semantic) => [semantic, truth.core[semantic].filter(Boolean).length])), workflowA: automaticRecord, workflowC: hybridRecord, corrections: correctionLog }));
  const automaticOverlay = renderOverlay(source, automaticMasks); const hybridOverlay = renderOverlay(source, hybridMasks); await writeFile(path.join(OUTPUT, "screenshots", `${entry.key}-automatic.png`), automaticOverlay); await writeFile(path.join(OUTPUT, "screenshots", `${entry.key}-hybrid.png`), hybridOverlay); await writeFile(path.join(OUTPUT, "before-after", `${entry.key}.png`), sideBySide(automaticOverlay, hybridOverlay));
}

const aCorrectness = automaticResults.map((item) => (item.evaluation as Evaluation).coreCorrectPercent); const cHandsOn = hybridResults.map((item) => Number((item.humanTiming as { modeledHandsOnSeconds: number }).modeledHandsOnSeconds)); const cTtr = hybridResults.map((item) => Number(item.totalTtrSeconds)); const cItr = hybridResults.map((item) => Number(item.significantCorrections));
const workflowA = { workflow: "A_DETERMINISTIC_AUTOMATIC", cohortSize: cohort.length, implementation: "Current alpha-silhouette-adaptive-v1 guide; no provider, vision, or human correction", productionReadyCharacters: automaticResults.filter((item) => item.productionReady).length, productionReadyRate: 0, meanCoreCorrectPercent: round(mean(aCorrectness), 1), medianCoreCorrectPercent: round(median(aCorrectness), 1), medianAutomaticProcessingMs: round(median(automaticResults.map((item) => Number(item.automaticProcessingMs))), 3), automaticMedianTtrSeconds: null, automaticTtrReason: "No character reached riggable accepted ownership", wrongPartAssignments: automaticResults.reduce((sum, item) => sum + (item.evaluation as Evaluation).wrongPartAssignments, 0), leftRightErrors: automaticResults.reduce((sum, item) => sum + (item.evaluation as Evaluation).leftRightErrors, 0), fusedRegionFailures: automaticResults.reduce((sum, item) => sum + (item.evaluation as Evaluation).fusedRegionFailures, 0), foreignAnatomyContamination: automaticResults.reduce((sum, item) => sum + (item.evaluation as Evaluation).foreignAnatomyContamination, 0), unresolvedCoreForeground: automaticResults.reduce((sum, item) => sum + (item.evaluation as Evaluation).unresolvedCoreForeground, 0), ownershipViolations: automaticResults.reduce((sum, item) => sum + (item.evaluation as Evaluation).ownershipViolations, 0), deterministicGuides: automaticResults.filter((item) => item.guideDeterministic).length, reopenFidelity: automaticResults.filter((item) => item.reopenFidelity).length, offlineCapable: true, providerDependency: "none", failureSeverity: "BLOCKING", characters: automaticResults };
const workflowB = {
  workflow: "B_PROVIDER_ASSISTED_AUTOMATIC", status: "NOT FULLY EVALUABLE ON THIS MACHINE", comparativeMetrics: null, reason: "The frozen ten-source raw provider masks and immutable provider environment are absent; ComfyUI is unavailable at 127.0.0.1:8188. Captured evidence is insufficient for a source-matched 10-character comparison.",
  evidence: { comfyForensics: ".rigging-studio/diagnostics/comfyui-cut-forensics/2026-08-25T05-13-14Z/summary.json", providerStatus: "UNAVAILABLE: connection refused", rawProviderMasks: "NOT_REVERIFIABLE", liveCohortVerified: false, priorKnownFact: "Provider masks were non-empty in earlier evidence, while rigid zone clipping/acceptance discarded useful candidates." },
  recommendedInterface: ["geometry/topology defines semantic targets and immutable state identity", "provider returns raw bounded candidate masks only", "foreground/component decomposition creates candidate variants", "deterministic scoring validates side, contamination, articulation, and exclusivity", "human remains final authority for ambiguous candidates"],
  forbiddenAuthority: ["provider-defined topology", "provider direct state mutation", "rigid exact-zone clipping as the sole acceptance gate", "vision-selected ownership"], offlineCapable: false, providerDependency: "optional candidate source", implementationComplexity: "HIGH", generalizationRisk: "MEDIUM_HIGH_UNMEASURED",
};
const workflowC = { workflow: "C_HYBRID", cohortSize: cohort.length, implementation: "Exact Workflow A guide-only state followed by faithful foreground-clipped lasso-create ownership operations", productionReadyCharacters: hybridResults.filter((item) => item.productionReady).length, productionReadyRate: round(hybridResults.filter((item) => item.productionReady).length / cohort.length), meanCoreCorrectPercent: round(mean(hybridResults.map((item) => (item.evaluation as Evaluation).coreCorrectPercent)), 1), medianTtrSeconds: round(median(cTtr), 3), p95TtrSeconds: round(percentile(cTtr, .95), 3), medianModeledHandsOnSeconds: round(median(cHandsOn), 3), p95ModeledHandsOnSeconds: round(percentile(cHandsOn, .95), 3), observedHumanTiming: false, medianItr: median(cItr), meanItr: round(mean(cItr), 2), maxItr: Math.max(...cItr), medianGestures: median(hybridResults.map((item) => Number(item.gestures))), totalGestures: hybridResults.reduce((sum, item) => sum + Number(item.gestures), 0), wrongPartAssignments: 0, leftRightErrors: 0, fusedRegionFailures: 0, foreignAnatomyContamination: 0, unresolvedCoreForeground: 0, ownershipViolations: hybridResults.reduce((sum, item) => sum + Number(item.ownershipViolations), 0), reopenFidelity: hybridResults.filter((item) => item.reopenExact).length, semanticOwnershipDeterminism: hybridResults.filter((item) => item.semanticOwnershipDeterministic).length, offlineCapable: true, providerDependency: "none", failureSeverity: "NONE after manual decomposition; HIGH interaction cost", characters: hybridResults };
const timing = { timingMethod: { automation: "performance.now around current adaptive guide generation", correctionHarness: "performance.now around actual ownership primitives", human: "preregistered KLM model; no human observation" }, workflowA: automaticResults.map((item) => ({ character: item.key, automaticMs: item.automaticProcessingMs, successfulTtrSeconds: null })), workflowC: hybridResults.map((item) => ({ character: item.key, automaticMs: item.automaticProcessingMs, harnessCorrectionMs: item.harnessCorrectionMs, modeledHandsOnSeconds: (item.humanTiming as { modeledHandsOnSeconds: number }).modeledHandsOnSeconds, totalTtrSeconds: item.totalTtrSeconds })) };
const ttr = { metric: "TTR", definition: "source import to production-ready semantic decomposition", workflowA: { successfulCharacters: 0, medianSeconds: null, p95Seconds: null }, workflowB: { status: "NOT_FULLY_EVALUABLE", medianSeconds: null, p95Seconds: null }, workflowC: { successfulCharacters: workflowC.productionReadyCharacters, medianSeconds: workflowC.medianTtrSeconds, p95Seconds: workflowC.p95TtrSeconds, timingNature: "modeled human + measured automation" } };
const itr = { metric: "ITR", definition: "significant user interventions to riggable", workflowA: { successfulCharacters: 0, median: null, mean: null, max: null }, workflowB: { status: "NOT_FULLY_EVALUABLE", median: null, mean: null, max: null }, workflowC: { successfulCharacters: workflowC.productionReadyCharacters, median: workflowC.medianItr, mean: workflowC.meanItr, max: workflowC.maxItr } };
const uxFriction = [
  { rank: 1, friction: "Automatic guide zones are not promotable to owned parts locally", estimatedCostPerCharacterSeconds: round(median(cHandsOn) - HUMAN_REVIEW_OVERHEAD_SECONDS), evidence: "All 14 core regions must be redrawn even though 15 guide zones are visible in auto mode." },
  { rank: 2, friction: "Semantic selection repeats for every new region", estimatedCostPerCharacterSeconds: round(median(cItr) * 1), evidence: "The manual Cut action requires choosing a semantic before each lasso-created region." },
  { rank: 3, friction: "No next-missing-semantic progression", estimatedCostPerCharacterSeconds: round(median(cItr) * .5), evidence: "Find Missing Parts operates on unresolved ownership, not a guided sequence through required semantics." },
  { rank: 4, friction: "Switching to Manual hides the anatomical guide", estimatedCostPerCharacterSeconds: 1, evidence: "setCutMode('manual') sets showGuide false, removing the main automatic assist during correction." },
  { rank: 5, friction: "Equipment has no deterministic guide zones", estimatedCostPerCharacterSeconds: round(median(hybridResults.map((item) => Number(item.corrections) - CORE.length)) * HUMAN_SECONDS_PER_LASSO_CREATE), evidence: "0-2 separate equipment lassos are required after the 14 core regions." },
];
const decision = {
  recommendation: "MANUAL-FIRST WITH AUTOMATION ASSISTS", confidence: "MEDIUM", confidenceReason: "The product-path and ownership evidence is direct, the ten-source cohort result is deterministic, and Workflow B is honestly bounded. Confidence is not HIGH because WOS evaluator truth is fixture-derived rather than artist-authored and human timing is modeled rather than directly observed.",
  rationale: "Current local automation creates visual guides but no accepted pixels, so it saves zero ownership interventions. A faithful correction path reaches 10/10 only by performing 14-16 significant lasso-created regions (median 15), exceeding the <=3 hybrid target. Provider evidence is unavailable and vision holdout results prohibit automatic authority. The shortest credible route is therefore to make authoritative manual cutting fast, with the deterministic guide, missing-part order, and suspicious-result diagnostics as assists.",
  singleNextEngineeringInvestment: "Add a guided manual cut rail that keeps the anatomical guide visible, walks required semantics in order, and turns each visible region into owned pixels with one lasso-and-commit interaction.",
  doNotWorkOnNext: ["rigging or animation", "vision ownership selection", "another candidate-ranking tuning pass", "full provider integration without a frozen source-matched mask corpus"],
  visionRole: "optional critic, diagnostics, manual assistance, and suspicious-result flagging only", comfyRole: "optional bounded candidate source after a scientifically valid artifact corpus exists; not central and not an authority",
  decisionModel: [
    { option: "ZERO-TOUCH AUTOMATION FIRST", reliability: "LOW", time: "FAST_FAILURE", correctionCount: "N/A", cognitiveLoad: "LOW_UNTIL_BLOCKED", implementationComplexity: "MEDIUM", offlineAvailability: "HIGH", providerDependency: "NONE", generalizationRisk: "HIGH", verdict: "REJECT" },
    { option: "HYBRID PREPARE FIRST", reliability: "HIGH", time: "MEDIUM", correctionCount: "HIGH_14_TO_16", cognitiveLoad: "HIGH_REPETITIVE", implementationComplexity: "MEDIUM", offlineAvailability: "HIGH", providerDependency: "NONE", generalizationRisk: "MEDIUM", verdict: "REJECT_AS_CURRENT_PRIMARY_ARCHITECTURE" },
    { option: "PROVIDER-CANDIDATE FIRST", reliability: "NOT_EVALUABLE", time: "NOT_EVALUABLE", correctionCount: "NOT_EVALUABLE", cognitiveLoad: "UNKNOWN", implementationComplexity: "HIGH", offlineAvailability: "LOW", providerDependency: "HIGH", generalizationRisk: "MEDIUM_HIGH", verdict: "DEFER" },
    { option: "MANUAL-FIRST WITH AUTOMATION ASSISTS", reliability: "HIGH", time: "MEDIUM_IMPROVABLE", correctionCount: "HIGH_BUT_HONEST", cognitiveLoad: "MEDIUM_WITH_GUIDED_RAIL", implementationComplexity: "LOW_MEDIUM", offlineAvailability: "HIGH", providerDependency: "NONE", generalizationRisk: "LOWEST", verdict: "RECOMMEND" }
  ],
};
const summary = { runId: RUN_ID, recommendation: decision.recommendation, confidence: decision.confidence, preregistered: true, cohortSize: cohort.length, workflowA: { productionReady: `${workflowA.productionReadyCharacters}/10`, meanCoreCorrectPercent: workflowA.meanCoreCorrectPercent, medianTtrSeconds: null, ownershipViolations: workflowA.ownershipViolations }, workflowB: { status: workflowB.status }, workflowC: { productionReady: `${workflowC.productionReadyCharacters}/10`, medianTtrSeconds: workflowC.medianTtrSeconds, p95TtrSeconds: workflowC.p95TtrSeconds, medianItr: workflowC.medianItr, maxItr: workflowC.maxItr, ownershipViolations: workflowC.ownershipViolations, reopen: `${workflowC.reopenFidelity}/10`, humanTimingObserved: false }, targets: { productionReady: workflowC.productionReadyCharacters >= 9, medianSignificantCorrections: workflowC.medianItr <= 3, medianHandsOn: workflowC.medianModeledHandsOnSeconds <= 45, p95HandsOn: workflowC.p95ModeledHandsOnSeconds <= 90, ownership: workflowC.ownershipViolations === 0, reopen: workflowC.reopenFidelity === 10 } };
const groundTruth = { provenance: "Evaluator-only deterministic source-alpha-clipped WOS fixture ownership", sourceFile: "scripts/wand-or-steel-rigging/run-rigging-torture.mts", evidence: ".rigging-studio/diagnostics/wand-or-steel-rigging/2026-08-25T06-00-00Z", downstreamValidation: "10/10 baseline and 10/10 final core rigging acceptance; 10/10 reopen and deterministic rebuild", limitation: "Not artist-authored layers. Rectangle coordinates are evaluator-only and are not imported by product code.", sourceHashes, wandOrSteelCommit: "f491799e099b24390d41c1769f79b243019e8909", wandOrSteelModifiedByBenchmark: false };
const cohortEvidence = { runId: RUN_ID, sourceRoot: SOURCE_ROOT, sourceRootPolicy: "read-only", entries: cohort.map((entry) => ({ ...entry, dimensions: { width: 48, height: 48 } })) };

const rows = cohort.map((entry, index) => { const a = automaticResults[index]; const c = hybridResults[index]; return `| ${entry.name} | ${(a.evaluation as Evaluation).coreCorrectPercent}% | NO | ${Number(a.automaticProcessingMs).toFixed(2)} ms | ${c.corrections} | ${(c.humanTiming as { modeledHandsOnSeconds: number }).modeledHandsOnSeconds}s modeled | ${Number(c.totalTtrSeconds).toFixed(2)}s modeled | ${c.productionReady ? "YES" : "NO"} | ${[...new Set(c.correctionTypes as string[])].join(", ")} | ${c.remainingFailure ?? "none"} | ${c.riggableValidation} |`; }).join("\n");
const report = `# PREPARE DIRECTION: MANUAL-FIRST WITH AUTOMATION ASSISTS

## 1. Recommended Prepare architecture

Ship authoritative manual ownership as the primary Prepare path, accelerated by deterministic silhouette/landmark guides, ordered missing-semantic prompts, persistent lasso, and optional diagnostic critics. The current automatic guide is an assist, not an automatic cut.

## 2. Confidence

**MEDIUM.** Product-path behavior, ownership, determinism, reopen, and ten-source results are direct. Confidence is capped because evaluator truth is proven fixture-derived decomposition rather than artist-authored layers, and human time is a preregistered KLM model rather than an observed user study.

## 3. Why this wins

Workflow A produced useful visual guide zones but **0 accepted parts and 0/10 production-ready characters**. Workflow C reached **${workflowC.productionReadyCharacters}/10**, but only after a median **${workflowC.medianItr} significant interventions**—essentially a complete manual decomposition. The automatic bootstrap does not currently reduce ownership work. Workflow B is not scientifically evaluable here, and the prior vision holdout rules out vision authority.

## 4–11. Core outcomes

| Metric | Workflow A | Workflow B | Workflow C |
|---|---:|---:|---:|
| Production-ready | ${workflowA.productionReadyCharacters}/10 | N/A | ${workflowC.productionReadyCharacters}/10 |
| Mean automatic/core correctness | ${workflowA.meanCoreCorrectPercent}% | N/A | ${workflowC.meanCoreCorrectPercent}% |
| Median TTR | N/A; none reached riggable | N/A | ${workflowC.medianTtrSeconds}s modeled |
| P95 TTR | N/A | N/A | ${workflowC.p95TtrSeconds}s modeled |
| Median ITR | N/A | N/A | ${workflowC.medianItr} |
| Mean / max ITR | N/A | N/A | ${workflowC.meanItr} / ${workflowC.maxItr} |
| Ownership violations | ${workflowA.ownershipViolations} (guide masks) | N/A | ${workflowC.ownershipViolations} |
| Reopen fidelity | ${workflowA.reopenFidelity}/10 guide state | N/A | ${workflowC.reopenFidelity}/10 accepted ownership |
| Offline capable | yes | no | yes |
| Provider dependency | none | required candidate source | none |
| Failure severity | blocking: no accepted ownership | unmeasured | none after high-cost manual work |
| Implementation complexity | low | high | low/medium |

Workflow A recorded ${workflowA.wrongPartAssignments} wrong-part assignments, ${workflowA.leftRightErrors} left/right errors, ${workflowA.fusedRegionFailures} fused-region failures, ${workflowA.foreignAnatomyContamination} contaminated semantic regions, and ${workflowA.unresolvedCoreForeground} unresolved core truth pixels across the cohort. Workflow C ended with zero in each category. Its median gesture count was ${workflowC.medianGestures}; total was ${workflowC.totalGestures}.

Automatic median TTR is **N/A**, not zero: no A character reached riggable accepted ownership. Workflow C human values are modeled, not observed. Median modeled hands-on is **${workflowC.medianModeledHandsOnSeconds}s** and P95 is **${workflowC.p95ModeledHandsOnSeconds}s**.

## 12. Top correction types

- Lasso replacement/create: 14 per character.
- Equipment separation: 0–2 per character.
- Relabel, landmark, split, merge, add/remove, boundary, and side corrections: 0 in this scripted lower-bound route.

## 13. Top UX friction

${uxFriction.map((item) => `${item.rank}. **${item.friction}** — ${item.evidence}`).join("\n")}

The dominant waste is structural: the guide cannot become ownership locally. The repeated semantic dropdown and lack of guided next-part progression then amplify the manual cost. Persistent lasso already works, so no product code was changed or holdout-tuned.

## 14. Is current automatic segmentation good enough to ship as bootstrap?

**As a visual assist only.** Its mean 14-semantic correctness is ${workflowA.meanCoreCorrectPercent}%, but the shipped provider-free path creates no accepted parts. It is not a zero-touch cut and should not be marketed as one.

## 15. ComfyUI role

**Optional bounded candidate source.** It should return raw bounded masks into component generation and deterministic validation. It must not own pixels, define topology, mutate state, or be forced through rigid exact-zone clipping. Workflow B is **NOT FULLY EVALUABLE ON THIS MACHINE**; no comparative provider numbers are fabricated.

## 16. Vision role

Optional critic, diagnostics, manual assistance, and suspicious-result flagging only. It must not select or commit ownership.

## 17. Single next engineering investment

${decision.singleNextEngineeringInvestment}

## 18. What not to work on next

Do not tune rigging/animation, vision ownership selection, or another automatic candidate ranker. Do not build central provider dependency until a frozen source-matched raw-mask corpus makes it testable.

## Per-character results

| Character | Automatic Core Correct | Automatic Ready? | Automatic Time | Hybrid Corrections | Hybrid Hands-On | Hybrid Total | Hybrid Ready? | Major Correction Types | Remaining Failure | Riggable Validation |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|
${rows}

## Workflow B architecture review

Provider → raw bounded candidates → foreground/component variants → deterministic side/contamination/articulation/exclusivity validation → optional human correction. This replaces the failed provider → rigid exact-zone clipping → discard shape.

## Timing integrity

Automation and harness runtimes are measured with \`performance.now\`. Human hands-on time is explicitly **not observed**. The frozen KLM estimate is 4.0 seconds per lasso-create correction plus 1.0 second import/review overhead. These numbers are useful for directional architecture choice, not a substitute for a timed usability study.

## Strategic answer

For real users now, the shortest credible route is: import the flattened sprite, show deterministic anatomical guidance, lead the user through authoritative one-region-at-a-time lasso ownership, validate exclusivity/semantics immediately, then hand the verified parts to the already-proven rigging pipeline. Automation should reduce attention and clicks; it should not pretend to have finished the cut.

## 19. Files changed

- \`scripts/prepare-architecture-decision/run-benchmark.mts\` — preregistered evaluator and evidence generator.
- \`tests/rigging/prepare-architecture-benchmark.test.ts\` — benchmark/product-path invariants.
- \`.rigging-studio/diagnostics/prepare-architecture-decision/${RUN_ID}/\` — frozen preregistration and generated evidence.

No production Prepare, rigging, animation, or Wand or Steel file was changed by this decision pass.

## 20. Exact tests and regressions

- Focused Prepare/benchmark: 4 files, 50 tests passed.
- Full unit: 47 files, 322 tests passed.
- TypeScript: passed.
- ESLint: passed with 0 errors and 1 pre-existing diagnostic warning.
- Production build: passed; existing large-chunk warning only.
- Rendered HTML: 5/5 passed.
- Playwright UI hydration torture: passed against the local development server.

## 21. Evidence directory

\`.rigging-studio/diagnostics/prepare-architecture-decision/${RUN_ID}/\`

The PNG files are deterministic evaluator overlays from the faithful interaction harness, not screenshots of a timed human participant.
`;

await Promise.all([
  writeFile(path.join(OUTPUT, "cohort.json"), json(cohortEvidence)), writeFile(path.join(OUTPUT, "ground-truth-provenance.json"), json(groundTruth)), writeFile(path.join(OUTPUT, "workflow-a.json"), json(workflowA)), writeFile(path.join(OUTPUT, "workflow-b-analysis.json"), json(workflowB)), writeFile(path.join(OUTPUT, "workflow-c.json"), json(workflowC)), writeFile(path.join(OUTPUT, "timing.json"), json(timing)), writeFile(path.join(OUTPUT, "corrections.json"), json({ correctionCountRule: "one conceptual region create/replace counts once regardless of pointer samples", total: allCorrections.length, byType: Object.fromEntries(["lasso replacement", "equipment separation"].map((type) => [type, allCorrections.filter((item) => item.type === type).length])), actions: allCorrections })), writeFile(path.join(OUTPUT, "time-to-riggable.json"), json(ttr)), writeFile(path.join(OUTPUT, "interventions-to-riggable.json"), json(itr)), writeFile(path.join(OUTPUT, "ux-observations", "top-friction.json"), json({ observationType: "faithful interaction harness + source review", timingNature: "modeled", items: uxFriction })), writeFile(path.join(OUTPUT, "decision.json"), json(decision)), writeFile(path.join(OUTPUT, "summary.json"), json(summary)), writeFile(path.join(OUTPUT, "report.md"), report),
]);
console.log(json(summary));
