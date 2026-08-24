import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";
import { parseGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { buildRigProposal } from "../../src/character-generation/rigging/rigProposalBuilder";
import { sharedBoundaryCentroid } from "../../src/character-generation/rigging/pivotResolver";
import { runRotationContinuitySmoke } from "../../src/character-generation/testing/rigSmokeTest";
import { partCutToSegmentation } from "../../src/part-cutter/operations";
import { stableProjectJson } from "../../src/project-storage/digest";
import type { LocalProjectSnapshot } from "../../src/project-storage/types";
import { blockingRigProjectProblems, validateRigProject } from "../../src/rigging/validation/project";
import { parseAnimationLibraryJson } from "../../src/tools/rig-editor/animation/library";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RUN_ID = "2026-08-23T08-30-00Z";
const OUTPUT = path.join(ROOT, ".rigging-studio/diagnostics/auto-rig-reliability", RUN_ID);
const PROJECTS = [
  ["A", "Standard swordsman", "character-torture-a-clean-swordsman-v1"],
  ["B", "Plague doctor", "character-torture-b-plague-doctor-v1"],
  ["C", "Broad dwarf", "character-torture-c-dwarf-heavy-fighter-v1"],
  ["D", "Digitigrade beastman", "character-torture-d-digitigrade-beastman-v1"],
  ["E", "Robed mage", "character-torture-e-robed-mage-v1"],
  ["F", "Bulky marine", "character-torture-f-bulky-sci-fi-marine-v1"],
  ["G", "Thin rogue", "character-torture-g-agile-rogue-v1"],
  ["H", "Extreme chibi fighter", "character-torture-h-extreme-chibi-fighter-v1"],
] as const;

type DiskAsset = { readonly __rigStudioDiskAsset: 1; readonly path: string; readonly encoding: "data-url" | "uint8-array"; readonly mimeType?: string };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const isAsset = (value: unknown): value is DiskAsset => isRecord(value) && value.__rigStudioDiskAsset === 1 && typeof value.path === "string";
const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const rigDigest = (value: unknown): string => hash(stableProjectJson(value));
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
type PostResult = Record<string, unknown> & { readonly key: string; readonly character: string; readonly validatorPass: boolean; readonly setupCorrections: number; readonly idempotent: boolean; readonly rotation: { readonly passed: boolean }; readonly topology: unknown; readonly rigClass: unknown; readonly rigDigest: unknown };

async function hydrate(value: unknown, directory: string): Promise<unknown> {
  if (isAsset(value)) {
    const bytes = await readFile(path.resolve(directory, value.path));
    return value.encoding === "uint8-array" ? [...bytes] : `data:${value.mimeType ?? "application/octet-stream"};base64,${bytes.toString("base64")}`;
  }
  if (Array.isArray(value)) return Promise.all(value.map((entry) => hydrate(entry, directory)));
  if (isRecord(value)) return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await hydrate(entry, directory)])));
  return value;
}

const color = (key: string): readonly [number, number, number, number] => key.includes("left") ? [76, 201, 240, 220] : key.includes("right") ? [255, 138, 101, 220] : [247, 205, 86, 220];
const pixel = (png: PNG, x: number, y: number, rgba: readonly number[]): void => {
  const px = Math.round(x); const py = Math.round(y); if (px < 0 || py < 0 || px >= png.width || py >= png.height) return;
  const offset = (py * png.width + px) * 4; png.data[offset] = rgba[0]; png.data[offset + 1] = rgba[1]; png.data[offset + 2] = rgba[2]; png.data[offset + 3] = rgba[3];
};
const dot = (png: PNG, x: number, y: number, rgba: readonly number[], radius = 4): void => { for (let py = -radius; py <= radius; py += 1) for (let px = -radius; px <= radius; px += 1) if (px * px + py * py <= radius * radius) pixel(png, x + px, y + py, rgba); };
const line = (png: PNG, from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }, rgba: readonly number[]): void => {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)));
  for (let index = 0; index <= steps; index += 1) { const ratio = index / steps; pixel(png, from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio, rgba); }
};

const store = new LocalProjectStore({ cwd: ROOT, now: () => "2026-08-23T08:30:00.000Z" });
const summaries = await store.list();
const frozen = JSON.parse(await readFile(path.join(OUTPUT, "frozen-inputs.json"), "utf8")) as readonly Record<string, unknown>[];
const pre = JSON.parse(await readFile(path.join(OUTPUT, "pre-fix-baseline.json"), "utf8")) as { readonly characters: readonly { readonly key: string; readonly validatorPass: boolean; readonly issueCount: number; readonly issueCategories: Record<string, number> }[] };
const candidates: { readonly key: string; readonly character: string; readonly snapshot: LocalProjectSnapshot; readonly prepareDigests: { sourceHash: string; ownershipDigest: string; semanticRegionDigest: string }; readonly result: PostResult; readonly overlay: Uint8Array }[] = [];

for (const [key, character, projectId] of PROJECTS) {
  const summary = summaries.find((candidate) => candidate.projectId === projectId); if (!summary) throw new Error(`${character}: persisted project not found`);
  const directory = path.join(store.root, summary.directoryName);
  const manifest = JSON.parse(await readFile(path.join(directory, "project.json"), "utf8")) as Record<string, unknown>;
  const rawProject = manifest.projectState as Record<string, unknown>;
  const parsed = parseGeneratedCharacterProject(await hydrate(rawProject, directory));
  if (!parsed.success) throw new Error(`${character}: frozen Prepare state is invalid: ${parsed.message}`);
  const project = parsed.data; const state = project.partCutterState;
  if (!state) throw new Error(`${character}: frozen Prepare state is missing`);
  const segmentation = partCutToSegmentation(state);
  const resolvedImages = Object.fromEntries(project.extractedParts.map((part) => [part.partId, part.image]));
  const proposal = buildRigProposal({ name: project.name, parts: segmentation.parts, imageWidth: segmentation.imageWidth, imageHeight: segmentation.imageHeight, resolvedImages, partCutterState: state });
  const duplicate = buildRigProposal({ name: project.name, parts: segmentation.parts, imageWidth: segmentation.imageWidth, imageHeight: segmentation.imageHeight, resolvedImages, partCutterState: state });
  const nextProject = { ...project, stage: "rig" as const, rigDefinition: proposal.rig, skins: proposal.rig.skins };
  const animationInput = JSON.parse(await readFile(path.join(directory, "animations.json"), "utf8")) as unknown;
  const parsedAnimations = animationInput === null ? null : parseAnimationLibraryJson(json({ ...(animationInput as Record<string, unknown>), rigId: proposal.rig.id }), proposal.rig);
  if (parsedAnimations && !parsedAnimations.success) throw new Error(`${character}: existing clip compatibility failed: ${parsedAnimations.message}`);
  const snapshot: LocalProjectSnapshot = { storageVersion: 1, localProjectId: project.id, project: nextProject, rig: proposal.rig, animations: parsedAnimations?.success ? parsedAnimations.data : null, selectedSkinId: proposal.rig.defaultSkinId };
  const problems = validateRigProject(snapshot); const blocking = blockingRigProjectProblems(problems); const rotation = runRotationContinuitySmoke(proposal.rig);
  const sourceRef = (rawProject.sourceImage as Record<string, unknown>).image as DiskAsset; const sourceBytes = await readFile(path.resolve(directory, sourceRef.path));
  const ownershipDigest = hash(stableProjectJson((rawProject.partCutterState as Record<string, unknown>).ownership ?? null));
  const semanticRegionDigest = hash(stableProjectJson(((rawProject.partCutterState as Record<string, unknown>).parts as readonly Record<string, unknown>[]).map((part) => ({ partId: part.partId, semanticType: part.semanticType, bounds: part.boundingBox, pivot: part.pivot, mask: hash(stableProjectJson(part.mask)) }))));
  const prepareDigests = { sourceHash: hash(sourceBytes), ownershipDigest, semanticRegionDigest };
  const expectedFrozen = frozen.find((item) => item.key === key); if (!expectedFrozen || expectedFrozen.sourceHash !== prepareDigests.sourceHash || expectedFrozen.ownershipDigest !== ownershipDigest) throw new Error(`${character}: frozen input digest changed before rigging`);
  const bindingFixes = proposal.rig.slots.filter((slot) => slot.attachmentId && segmentation.parts.find((part) => part.id === slot.attachmentId)?.suggestedBoneId !== slot.boneId).length;
  const invalidPivots = proposal.rig.slots.filter((slot) => { const attachment = proposal.rig.attachments.find((item) => item.id === slot.attachmentId); return attachment && (slot.pivotX < 0 || slot.pivotY < 0 || slot.pivotX > attachment.width || slot.pivotY > attachment.height); }).length;
  const parentMap = Object.fromEntries(proposal.rig.bones.map((bone) => [bone.id, bone.parentId]));
  const hierarchyValid = parentMap.head === "neck" && parentMap.neck === "torso" && (proposal.rig.metadata.anatomyProfile !== "digitigrade" || (parentMap["left-foot"] === "left-hock" && parentMap["right-foot"] === "right-hock"));
  const result: PostResult = {
    key, character, projectId, topology: proposal.rig.metadata.anatomyProfile, topologySource: proposal.rig.metadata.topologySource,
    validatorPass: blocking.length === 0, issueCount: problems.length, blockingIssueCount: blocking.length, issueCategories: Object.fromEntries([...new Set(problems.map((problem) => problem.code))].sort().map((code) => [code, problems.filter((problem) => problem.code === code).length])),
    rigDigest: rigDigest(proposal.rig), idempotent: stableProjectJson(proposal.rig) === stableProjectJson(duplicate.rig), invalidPivots, bindingFixes,
    hierarchyFixes: hierarchyValid ? 0 : 1, layerFixes: 0, setupCorrections: 0, rotation, hiddenAnatomy: proposal.rig.metadata.hiddenAnatomy,
    expectedAnimationTargets: proposal.rig.metadata.expectedAnimationTargets, pivotSources: proposal.rig.metadata.pivotSources, bindingSources: proposal.rig.metadata.bindingSources,
    rigClass: blocking.length || !rotation.passed ? "FAIL" : "EXCELLENT", primaryFailure: blocking[0]?.code ?? "none",
  };
  if (blocking.length) throw new Error(`${character}: post-fix candidate invalid: ${blocking.map((problem) => problem.message).join("; ")}`);

  const png = PNG.sync.read(sourceBytes); const points = proposal.rig.metadata.pivotSources as Record<string, { readonly point: { readonly x: number; readonly y: number } }>;
  proposal.rig.bones.forEach((bone) => { const point = points[bone.id]?.point; const parent = bone.parentId ? points[bone.parentId]?.point : undefined; if (point && parent) line(png, parent, point, color(bone.id)); if (point) dot(png, point.x, point.y, [255, 62, 99, 255], 4); });
  state.anatomicalGuide?.landmarks.forEach((landmark) => dot(png, landmark.point.x, landmark.point.y, [255, 234, 94, 255], 3));
  const semanticPairs = [["torso", "leftUpperArm"], ["leftUpperArm", "leftForearm"], ["leftThigh", "leftLowerLeg"], ["leftLowerLeg", "leftFoot"], ["torso", "rightUpperArm"], ["rightUpperArm", "rightForearm"], ["rightThigh", "rightLowerLeg"], ["rightLowerLeg", "rightFoot"]] as const;
  semanticPairs.forEach(([a, b]) => { const left = state.parts.find((part) => part.semanticType === a); const right = state.parts.find((part) => part.semanticType === b); const boundary = left && right ? sharedBoundaryCentroid(state, left.partId, right.partId) : null; if (boundary) dot(png, boundary.x, boundary.y, [61, 255, 185, 255], 2); });
  candidates.push({ key, character, snapshot, prepareDigests, result, overlay: PNG.sync.write(png) });
}

await mkdir(path.join(OUTPUT, "overlays"), { recursive: true });
for (const candidate of candidates) await writeFile(path.join(OUTPUT, "overlays", `${candidate.key.toLowerCase()}-${candidate.character.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`), candidate.overlay);

const persistence = [];
for (const candidate of candidates) {
  const saved = await store.save(candidate.snapshot); const reopened = await store.load(candidate.snapshot.localProjectId!);
  const afterManifest = JSON.parse(await readFile(path.join(saved.diskPath, "project.json"), "utf8")) as Record<string, unknown>;
  const afterProject = afterManifest.projectState as Record<string, unknown>; const afterState = afterProject.partCutterState as Record<string, unknown>;
  const afterOwnership = hash(stableProjectJson(afterState.ownership ?? null));
  const afterSemantic = hash(stableProjectJson((afterState.parts as readonly Record<string, unknown>[]).map((part) => ({ partId: part.partId, semanticType: part.semanticType, bounds: part.boundingBox, pivot: part.pivot, mask: hash(stableProjectJson(part.mask)) }))));
  const afterSourceRef = (afterProject.sourceImage as Record<string, unknown>).image as DiskAsset; const afterSourceHash = hash(await readFile(path.resolve(saved.diskPath, afterSourceRef.path)));
  const sameRig = rigDigest(reopened.snapshot.rig) === rigDigest(candidate.snapshot.rig);
  const samePrepare = afterOwnership === candidate.prepareDigests.ownershipDigest && afterSemantic === candidate.prepareDigests.semanticRegionDigest && afterSourceHash === candidate.prepareDigests.sourceHash;
  if (!sameRig || !samePrepare || blockingRigProjectProblems(validateRigProject(reopened.snapshot)).length) throw new Error(`${candidate.character}: reopen verification failed`);
  persistence.push({ key: candidate.key, projectId: saved.projectId, path: saved.relativePath, rigDigest: rigDigest(reopened.snapshot.rig), sameRig, samePrepare, sourceHashPreserved: afterSourceHash === candidate.prepareDigests.sourceHash, ownershipDigestPreserved: afterOwnership === candidate.prepareDigests.ownershipDigest, semanticRegionDigestPreserved: afterSemantic === candidate.prepareDigests.semanticRegionDigest, pivotMetadataPreserved: stableProjectJson(reopened.snapshot.rig?.metadata.pivotSources) === stableProjectJson(candidate.snapshot.rig?.metadata.pivotSources), bindingsPreserved: stableProjectJson(reopened.snapshot.rig?.slots) === stableProjectJson(candidate.snapshot.rig?.slots) });
}

const zipRoot = await mkdtemp(path.join(os.tmpdir(), "rig-studio-auto-rig-zip-")); const zipStore = new LocalProjectStore({ cwd: ROOT, root: path.join(zipRoot, "projects"), trashRoot: path.join(zipRoot, "trash"), now: () => "2026-08-23T08:31:00.000Z" });
const zipResults = [];
for (const key of ["A", "D", "F"]) {
  const candidate = candidates.find((item) => item.key === key)!; const exported = await store.exportSnapshot(candidate.snapshot.localProjectId!); const summary = (await store.list()).find((item) => item.projectId === candidate.snapshot.localProjectId)!;
  const zipPath = path.join(exported.exportPath, `${summary.slug}.project.zip`); const imported = await zipStore.importPortableZip(await readFile(zipPath), `${candidate.character} rig round trip`); const reopened = await zipStore.load(imported.projectId);
  const exactRigDigest = rigDigest(reopened.snapshot.rig); const sourceRigDigest = rigDigest(candidate.snapshot.rig); if (exactRigDigest !== sourceRigDigest) throw new Error(`${candidate.character}: ZIP rig digest mismatch`);
  zipResults.push({ key, character: candidate.character, zipPath, importedPath: imported.relativePath, sourceRigDigest, importedRigDigest: exactRigDigest, passed: true });
}

const results = candidates.map((candidate) => candidate.result);
const output = { runId: RUN_ID, phase: "post-fix", prepareMutationCount: 0, aggregate: { validatorPasses: results.filter((result) => result.validatorPass).length, zeroCorrectionPasses: results.filter((result) => result.validatorPass && result.setupCorrections === 0).length, withinThreeCorrectionPasses: results.filter((result) => result.validatorPass && result.setupCorrections <= 3).length, idempotent: results.filter((result) => result.idempotent).length, rotationPasses: results.filter((result) => result.rotation.passed).length, reopenPasses: persistence.filter((result) => result.sameRig && result.samePrepare).length, zipPasses: zipResults.length }, characters: results, persistence, zipResults, preFix: pre.characters };
await writeFile(path.join(OUTPUT, "post-fix-results.json"), json(output));
await writeFile(path.join(OUTPUT, "persistence-results.json"), json(persistence));
await writeFile(path.join(OUTPUT, "zip-results.json"), json(zipResults));
console.log(JSON.stringify(output.aggregate));
results.forEach((result) => console.log(`${result.key}\t${result.character}\t${result.validatorPass ? "PASS" : "FAIL"}\t${result.topology}\t${result.rigClass}\t${result.rigDigest}`));
