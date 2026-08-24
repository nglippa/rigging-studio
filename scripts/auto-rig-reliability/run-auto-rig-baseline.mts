import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildRigProposal } from "../../src/character-generation/rigging/rigProposalBuilder";
import { partCutToSegmentation } from "../../src/part-cutter/operations";
import { parseGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { blockingRigProjectProblems, validateRigProject } from "../../src/rigging/validation/project";
import type { LocalProjectSnapshot } from "../../src/project-storage/types";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUTPUT = path.join(ROOT, ".rigging-studio/diagnostics/auto-rig-reliability/2026-08-23T08-30-00Z");
const PROJECTS = [
  ["A", "Standard swordsman", "clean-swordsman--character-torture-a-clean-swordsman-v1", "humanoid"],
  ["B", "Plague doctor", "plague-doctor--character-torture-b-plague-doctor-v1", "humanoid"],
  ["C", "Broad dwarf", "dwarf-heavy-fighter--character-torture-c-dwarf-heavy-fighter-v1", "humanoid"],
  ["D", "Digitigrade beastman", "digitigrade-beastman--character-torture-d-digitigrade-beastman-v1", "digitigrade"],
  ["E", "Robed mage", "robed-mage--character-torture-e-robed-mage-v1", "humanoid"],
  ["F", "Bulky marine", "bulky-sci-fi-marine--character-torture-f-bulky-sci-fi-marine-v1", "humanoid"],
  ["G", "Thin rogue", "agile-rogue--character-torture-g-agile-rogue-v1", "humanoid"],
  ["H", "Extreme chibi fighter", "extreme-chibi-fighter--character-torture-h-extreme-chibi-fighter-v1", "humanoid"],
] as const;

type DiskAsset = { readonly __rigStudioDiskAsset: 1; readonly path: string; readonly encoding: "data-url" | "uint8-array"; readonly mimeType?: string };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const isAsset = (value: unknown): value is DiskAsset => isRecord(value) && value.__rigStudioDiskAsset === 1 && typeof value.path === "string";
const sha = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => isRecord(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
  : entry);

async function hydrate(value: unknown, directory: string): Promise<unknown> {
  if (isAsset(value)) {
    const bytes = await readFile(path.resolve(directory, value.path));
    return value.encoding === "uint8-array" ? [...bytes] : `data:${value.mimeType ?? "application/octet-stream"};base64,${bytes.toString("base64")}`;
  }
  if (Array.isArray(value)) return Promise.all(value.map((entry) => hydrate(entry, directory)));
  if (isRecord(value)) return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await hydrate(entry, directory)])));
  return value;
}

const expectedBone = (semantic: string): string => ({
  leftForearm: "left-lower-arm", rightForearm: "right-lower-arm", leftThigh: "left-upper-leg", rightThigh: "right-upper-leg",
  mainHandEquipment: "right-hand", offHandEquipment: "left-hand", backEquipment: "torso", cape: "torso", hair: "head", beard: "head", helmet: "head", face: "head",
  shoulderLeft: "left-upper-arm", shoulderRight: "right-upper-arm", accessory: "torso", tail: "pelvis",
} as Record<string, string>)[semantic] ?? semantic.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();

const expectedParent: Readonly<Record<string, string | null>> = {
  root: null, pelvis: "root", torso: "pelvis", neck: "torso", head: "neck",
  "left-upper-arm": "torso", "left-lower-arm": "left-upper-arm", "left-hand": "left-lower-arm",
  "right-upper-arm": "torso", "right-lower-arm": "right-upper-arm", "right-hand": "right-lower-arm",
  "left-upper-leg": "pelvis", "left-lower-leg": "left-upper-leg", "left-hock": "left-lower-leg", "left-foot": "left-lower-leg",
  "right-upper-leg": "pelvis", "right-lower-leg": "right-upper-leg", "right-hock": "right-lower-leg", "right-foot": "right-lower-leg",
};

const semanticDigestInput = (parts: readonly Record<string, unknown>[]): unknown => parts.map((part) => ({
  partId: part.partId, semanticType: part.semanticType, boundingBox: part.boundingBox, pivot: part.pivot, suggestedParent: part.suggestedParent,
  suggestedSlot: part.suggestedSlot, zOrder: part.zOrder, layer: part.layer, accepted: part.accepted, equipment: part.equipment,
  maskDigest: sha(JSON.stringify(part.mask)),
}));

const results = [];
for (const [key, character, directoryName, declaredTopology] of PROJECTS) {
  const directory = path.join(ROOT, ".rigging-studio/projects", directoryName);
  const manifest = JSON.parse(await readFile(path.join(directory, "project.json"), "utf8")) as Record<string, unknown>;
  const rawProject = (manifest.projectState as Record<string, unknown>);
  const rawState = rawProject.partCutterState as Record<string, unknown>;
  const hydrated = await hydrate(rawProject, directory);
  const parsed = parseGeneratedCharacterProject(hydrated);
  if (!parsed.success) throw new Error(`${character}: frozen project could not be parsed: ${parsed.message}`);
  const project = parsed.data;
  const state = project.partCutterState;
  if (!state) throw new Error(`${character}: frozen project is missing cuts`);
  const segmentation = partCutToSegmentation(state);
  const resolvedImages = Object.fromEntries(project.extractedParts.map((part) => [part.partId, part.image]));
  const input = { name: project.name, parts: segmentation.parts, imageWidth: segmentation.imageWidth, imageHeight: segmentation.imageHeight, resolvedImages };
  const proposal = buildRigProposal(input);
  const second = buildRigProposal(input);
  const candidateProject = { ...project, rigDefinition: proposal.rig, skins: proposal.rig.skins };
  const snapshot: LocalProjectSnapshot = { storageVersion: 1, localProjectId: project.id, project: candidateProject, rig: proposal.rig, animations: null, selectedSkinId: proposal.rig.defaultSkinId };
  const issues = validateRigProject(snapshot);
  const blocking = blockingRigProjectProblems(issues);
  const boneIds = new Set(proposal.rig.bones.map((bone) => bone.id));
  const topology = state.anatomicalGuide?.adaptiveMetadata?.topology ?? state.anatomicalGuide?.profile ?? declaredTopology;
  const requiredBones = Object.keys(expectedParent).filter((id) => !id.includes("hock") || topology === "digitigrade");
  const allowedBones = new Set(requiredBones);
  const badBindings = segmentation.parts.filter((part) => part.accepted && part.semanticType !== "rootReference").flatMap((part) => {
    const slot = proposal.rig.slots.find((candidate) => candidate.attachmentId === part.id);
    const expected = expectedBone(part.semanticType);
    return slot?.boneId === expected ? [] : [{ partId: part.id, semanticType: part.semanticType, expected, actual: slot?.boneId ?? null }];
  });
  const badParents = proposal.rig.bones.flatMap((bone) => {
    const expected = expectedParent[bone.id];
    if (expected === undefined) return [];
    const actualExpected = bone.id === "head" && !boneIds.has("neck") ? "torso" : bone.id.includes("foot") && topology === "digitigrade" ? bone.id.replace("foot", "hock") : expected;
    return bone.parentId === actualExpected ? [] : [{ boneId: bone.id, expected: actualExpected, actual: bone.parentId }];
  });
  const missingBones = requiredBones.filter((id) => !boneIds.has(id));
  const extraBones = proposal.rig.bones.filter((bone) => !allowedBones.has(bone.id)).map((bone) => bone.id);
  const zeroOrInvalidLengths = proposal.rig.bones.filter((bone) => !Number.isFinite(bone.length) || bone.length <= 0).map((bone) => bone.id);
  const sourceRef = (rawProject.sourceImage as Record<string, unknown>).image as DiskAsset;
  const sourceBytes = await readFile(path.resolve(directory, sourceRef.path));
  const rawParts = rawState.parts as Record<string, unknown>[];
  const equipment = rawParts.filter((part) => part.accepted === true && (part.equipment === true || !part.articulated)).map((part) => ({ partId: part.partId, semanticType: part.semanticType, layer: part.layer }));
  const categoryCounts = Object.fromEntries([...new Set(issues.map((issue) => issue.code))].sort().map((code) => [code, issues.filter((issue) => issue.code === code).length]));
  results.push({
    key, character, projectId: project.id, sourceHash: sha(sourceBytes), ownershipDigest: sha(stable(rawState.ownership ?? null)),
    semanticRegionDigest: sha(stable(semanticDigestInput(rawParts))), topology, topologySource: state.anatomicalGuide ? "prepare-metadata" : `frozen-suite-declaration:${declaredTopology}`,
    equipmentDetails: equipment, frozenPrepareValid: state.finalized && rawParts.filter((part) => part.accepted).length > 0,
    validatorPass: blocking.length === 0, issueCount: issues.length, blockingIssueCount: blocking.length, issueCategories: categoryCounts,
    badPivots: [], badParents, badBindings, badZOrder: [], missingBones, extraBones,
    topologyMismatch: topology === "digitigrade" && (!boneIds.has("left-hock") || !boneIds.has("right-hock")), zeroOrInvalidLengths,
    canonicalRigDigest: sha(stable(proposal.rig)), secondCanonicalRigDigest: sha(stable(second.rig)), idempotent: stable(proposal.rig) === stable(second.rig),
  });
}

const output = {
  runId: path.basename(OUTPUT), phase: "pre-fix", prepareMutationCount: 0, characterCount: results.length,
  aggregate: { validatorPasses: results.filter((result) => result.validatorPass).length, idempotent: results.filter((result) => result.idempotent).length },
  characters: results,
};
await mkdir(OUTPUT, { recursive: true });
await writeFile(path.join(OUTPUT, "pre-fix-baseline.json"), `${JSON.stringify(output, null, 2)}\n`);
await writeFile(path.join(OUTPUT, "frozen-inputs.json"), `${JSON.stringify(results.map((result) => ({
  key: result.key, character: result.character, projectId: result.projectId, sourceHash: result.sourceHash, ownershipDigest: result.ownershipDigest,
  semanticRegionDigest: result.semanticRegionDigest, topology: result.topology, topologySource: result.topologySource,
  equipmentDetails: result.equipmentDetails, frozenPrepareValid: result.frozenPrepareValid,
})), null, 2)}\n`);
console.log(JSON.stringify(output.aggregate));
results.forEach((result) => console.log(`${result.key}\t${result.character}\t${result.validatorPass ? "PASS" : "FAIL"}\t${result.issueCount}\tbindings=${result.badBindings.length}\tmissing=${result.missingBones.join(",") || "none"}`));
