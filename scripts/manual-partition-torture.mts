import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createManualRegionFromSelection, createPartCutterState, ownershipSummary } from "../src/part-cutter/index";
import { partCutterStateSchema, type PartCutterState } from "../src/part-cutter/schema";

const root = process.cwd();
const fixturePath = path.join(root, ".rigging-studio/projects/extreme-chibi-fighter--character-torture-h-extreme-chibi-fighter-v1/project.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { projectState: { partCutterState: PartCutterState } };
const persisted = fixture.projectState.partCutterState as unknown as PartCutterState & { readonly parts: readonly (PartCutterState["parts"][number] & { readonly mask: { readonly width: number; readonly height: number; readonly alpha: readonly number[] | { readonly path: string } } })[] };
const fixtureDirectory = path.dirname(fixturePath);
const materializedParts = await Promise.all(persisted.parts.map(async (part) => { const alpha = part.mask.alpha; return { ...part, mask: { ...part.mask, alpha: Array.isArray(alpha) ? alpha : Array.from(await readFile(path.join(fixtureDirectory, (alpha as unknown as { readonly path: string }).path))) } }; }));
const reference = { ...persisted, parts: materializedParts } as PartCutterState;
const required = ["head", "torso", "leftUpperArm", "leftForearm", "leftHand", "rightUpperArm", "rightForearm", "rightHand", "leftThigh", "leftLowerLeg", "leftFoot", "rightThigh", "rightLowerLeg", "rightFoot", "hair", "mainHandEquipment"] as const;
let state = createPartCutterState(`${reference.sourceImageId}-manual-disposable`, reference.sourceCanvasSize.width, reference.sourceCanvasSize.height, "manual", "2026-08-22T00:00:00.000Z");
const started = performance.now(); const operations: { semantic: string; label: string; pixels: number; yielded: readonly string[] }[] = [];
for (const semantic of required) {
  const source = reference.parts.find((part) => part.semanticType === semantic);
  if (!source) throw new Error(`Missing torture reference region ${semantic}`);
  const result = createManualRegionFromSelection(state, source.semanticType, source.boundingBox, source.mask, source.label);
  state = result.state;
  operations.push({ semantic, label: source.label, pixels: result.changedPixels, yielded: result.previousOwnerIds });
}
const elapsedMs = performance.now() - started; const ownership = ownershipSummary(state);
const roundTrip = partCutterStateSchema.parse(JSON.parse(JSON.stringify(state)));
const result = {
  run: "extreme-chibi-manual-lasso-partition",
  source: path.relative(root, fixturePath),
  anatomicalGuideRegenerated: false,
  disposable: true,
  partsCreated: state.parts.length,
  requiredParts: required.length,
  lassoOperations: required.length,
  polygonOperations: 0,
  brushOperations: 0,
  undoOperations: 0,
  totalTimeMs: Number(elapsedMs.toFixed(2)),
  oneLassoPerPart: operations.every((operation) => operation.pixels > 0),
  ownership,
  exclusive: ownership.exclusive,
  persistenceRoundTrip: JSON.stringify(roundTrip.ownership?.runs) === JSON.stringify(state.ownership?.runs),
  operations,
};
const outputDirectory = path.join(root, ".rigging-studio/diagnostics/manual-partition-runs/2026-08-22");
await mkdir(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, "extreme-chibi-lasso-result.json");
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...result, operations: `${operations.length} recorded`, output: path.relative(root, output) }, null, 2));
