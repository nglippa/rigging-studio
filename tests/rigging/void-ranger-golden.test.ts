import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";
import { parseGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { AnimationPlayer } from "../../src/rigging/animation/AnimationPlayer";
import { RigRuntime } from "../../src/rigging/runtime/RigRuntime";
import { computeWorldTransforms } from "../../src/rigging/runtime/worldTransforms";
import { safeParseRigDefinition } from "../../src/rigging/schema/parsing";
import type { RigDefinition } from "../../src/rigging/schema/types";
import { validateRigDefinition } from "../../src/rigging/validation/rig";
import { parseAnimationLibraryJson } from "../../src/tools/rig-editor/animation/library";
import type { AnimationLibrary } from "../../src/tools/rig-editor/animation/types";
import { LOCAL_PROJECT_STORAGE_VERSION, type LocalProjectSnapshot } from "../../src/project-storage/types";

const FIXTURE = new URL("../fixtures/golden/void-ranger/", import.meta.url);
const parseJson = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIXTURE), "utf8")) as unknown;
const contract = parseJson("expected-contract.json") as {
  readonly source: { readonly path: string; readonly width: number; readonly height: number; readonly sha256: string; readonly requiresTransparentAlpha: boolean };
  readonly project: { readonly name: string; readonly valid: boolean; readonly partCount: number; readonly cuttingMode: string };
  readonly requiredSemanticTypes: readonly string[];
  readonly requiredBones: readonly string[];
  readonly equipment: { readonly cape: { readonly attachmentId: string; readonly boneId: string }; readonly energyBlade: { readonly attachmentId: string; readonly boneId: string } };
  readonly animations: readonly string[];
  readonly rotationChecksDegrees: readonly number[];
};

const loadGolden = () => {
  const project = parseGeneratedCharacterProject(parseJson("project.json"));
  expect(project.success).toBe(true);
  if (!project.success) throw new Error(project.message);
  const rig = safeParseRigDefinition(parseJson("rig.json"));
  expect(rig.success).toBe(true);
  if (!rig.success) throw new Error(rig.message);
  const animations = parseAnimationLibraryJson(JSON.stringify(parseJson("animations.json")), rig.data);
  expect(animations.success).toBe(true);
  if (!animations.success) throw new Error(animations.message);
  return { project: project.data, rig: rig.data, animations: animations.data };
};

const assertSemanticContract = (project: ReturnType<typeof loadGolden>["project"], rig: RigDefinition, animations: AnimationLibrary): void => {
  expect(project.name).toBe(contract.project.name);
  expect(project.partCutterState?.mode).toBe(contract.project.cuttingMode);
  expect(project.partCutterState?.parts).toHaveLength(contract.project.partCount);
  const semantics = new Set(project.partCutterState?.parts.map((part) => part.semanticType));
  contract.requiredSemanticTypes.forEach((semantic) => expect(semantics.has(semantic as never), semantic).toBe(true));
  project.partCutterState?.parts.forEach((part) => {
    expect(part.accepted, part.label).toBe(true);
    expect(part.mask.alpha.some((alpha) => alpha > 0), part.label).toBe(true);
    expect(part.sourceBoundingBox).toEqual(part.boundingBox);
    expect(part.pivot.x).toBeGreaterThanOrEqual(part.boundingBox.x);
    expect(part.pivot.y).toBeGreaterThanOrEqual(part.boundingBox.y);
    expect(part.pivot.x).toBeLessThanOrEqual(part.boundingBox.x + part.boundingBox.width);
    expect(part.pivot.y).toBeLessThanOrEqual(part.boundingBox.y + part.boundingBox.height);
  });
  expect(validateRigDefinition(rig)).toEqual([]);
  const boneIds = new Set(rig.bones.map((bone) => bone.id));
  contract.requiredBones.forEach((boneId) => expect(boneIds.has(boneId), boneId).toBe(true));
  rig.bones.filter((bone) => bone.id !== rig.rootBoneId).forEach((bone) => expect(bone.length, bone.id).toBeGreaterThan(0));
  const attachmentIds = new Set(rig.attachments.map((attachment) => attachment.id));
  rig.slots.forEach((slot) => {
    expect(boneIds.has(slot.boneId), slot.id).toBe(true);
    if (slot.attachmentId) expect(attachmentIds.has(slot.attachmentId), slot.id).toBe(true);
  });
  const cape = rig.slots.find((slot) => slot.attachmentId === contract.equipment.cape.attachmentId);
  const blade = rig.slots.find((slot) => slot.attachmentId === contract.equipment.energyBlade.attachmentId);
  expect(cape?.boneId).toBe(contract.equipment.cape.boneId);
  expect(blade?.boneId).toBe(contract.equipment.energyBlade.boneId);
  expect(blade?.zIndex).toBeGreaterThan(cape?.zIndex ?? 0);
  expect(animations.animations.map((animation) => animation.name)).toEqual(contract.animations);
};

const assertSourceAlignedRotations = (rig: RigDefinition): void => {
  const majorBones = ["left-upper-arm", "right-upper-arm", "left-upper-leg", "right-upper-leg"];
  majorBones.forEach((boneId) => expect(rig.bones.find((bone) => bone.id === boneId)?.rotation).toBe(0));
  for (const boneId of majorBones) {
    const child = rig.bones.find((bone) => bone.parentId === boneId);
    expect(child, `${boneId} child`).toBeDefined();
    const baseRuntime = new RigRuntime(rig);
    const base = computeWorldTransforms(rig, baseRuntime.getPose());
    const baseDistance = Math.hypot(base[child!.id].x - base[boneId].x, base[child!.id].y - base[boneId].y);
    expect(baseDistance).toBeGreaterThan(0);
    for (const angle of contract.rotationChecksDegrees) {
      const runtime = new RigRuntime(rig);
      runtime.updateBonePose(boneId, { rotation: angle });
      const world = computeWorldTransforms(rig, runtime.getPose());
      expect(world[boneId].x).toBeCloseTo(base[boneId].x, 6);
      expect(world[boneId].y).toBeCloseTo(base[boneId].y, 6);
      expect(Math.hypot(world[child!.id].x - world[boneId].x, world[child!.id].y - world[boneId].y)).toBeCloseTo(baseDistance, 6);
    }
  }
};

const assertPlayback = (rig: RigDefinition, animations: AnimationLibrary): void => {
  const boneIds = new Set(rig.bones.map((bone) => bone.id));
  animations.animations.forEach((animation) => {
    animation.tracks.forEach((track) => expect(boneIds.has(track.boneId), `${animation.name}:${track.boneId}`).toBe(true));
    const runtime = new RigRuntime(rig);
    const player = new AnimationPlayer(runtime);
    player.play(animation);
    expect(player.isPlaying).toBe(true);
    player.update(Math.min(.2, animation.duration / 3));
    expect(player.currentTime).toBeGreaterThan(0);
    expect(Object.values(runtime.getPose().bones).every((bone) => Object.values(bone).every(Number.isFinite))).toBe(true);
  });
};

const snapshotFromGolden = (): LocalProjectSnapshot => {
  const { project, rig, animations } = loadGolden();
  return { storageVersion: LOCAL_PROJECT_STORAGE_VERSION, localProjectId: "golden-void-ranger-save-load", project, rig, animations, selectedSkinId: rig.defaultSkinId };
};

describe("Void Ranger golden end-to-end fixture", () => {
  it("loads offline, validates source/parts/rig, preserves source-aligned rotations, and plays four animations", () => {
    const { project, rig, animations } = loadGolden();
    const source = PNG.sync.read(readFileSync(new URL(`../../../../${contract.source.path}`, FIXTURE)));
    expect([source.width, source.height]).toEqual([contract.source.width, contract.source.height]);
    const alpha = Array.from({ length: source.width * source.height }, (_, index) => source.data[index * 4 + 3]);
    expect(alpha.some((value) => value === 0)).toBe(contract.source.requiresTransparentAlpha);
    expect(alpha.some((value) => value > 0)).toBe(true);
    assertSemanticContract(project, rig, animations);
    assertSourceAlignedRotations(rig);
    assertPlayback(rig, animations);
  });

  it("survives a LocalProjectStore save, destroyed memory, and fresh disk load", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "void-ranger-golden-save-load-"));
    const store = new LocalProjectStore({ cwd: root, root: path.join(root, "projects"), trashRoot: path.join(root, "trash") });
    const saved = await store.save(snapshotFromGolden());
    const restarted = new LocalProjectStore({ cwd: root, root: path.join(root, "projects"), trashRoot: path.join(root, "trash") });
    const loaded = await restarted.load(saved.projectId);
    expect(loaded.summary).toMatchObject({ valid: true, partCount: 16, rigPresent: true, animationCount: 4 });
    if (!loaded.snapshot.project || !loaded.snapshot.rig || !loaded.snapshot.animations) throw new Error("Reloaded golden snapshot is incomplete");
    assertSemanticContract(loaded.snapshot.project, loaded.snapshot.rig, loaded.snapshot.animations);
    assertPlayback(loaded.snapshot.rig, loaded.snapshot.animations);
  });

  it("exports a Project ZIP, imports it separately, and preserves the semantic contract", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "void-ranger-golden-export-"));
    const sourceStore = new LocalProjectStore({ cwd: root, root: path.join(root, "projects"), trashRoot: path.join(root, "trash") });
    const saved = await sourceStore.save(snapshotFromGolden());
    const exported = await sourceStore.exportSnapshot(saved.projectId);
    const zipPath = path.join(exported.exportPath, "void-ranger.project.zip");
    expect(readFileSync(zipPath).byteLength).toBeGreaterThan(0);
    const importRoot = mkdtempSync(path.join(tmpdir(), "void-ranger-golden-import-"));
    const targetStore = new LocalProjectStore({ cwd: importRoot, root: path.join(importRoot, "projects"), trashRoot: path.join(importRoot, "trash") });
    const imported = await targetStore.importPortableZip(readFileSync(zipPath));
    const loaded = await targetStore.load(imported.projectId);
    if (!loaded.snapshot.project || !loaded.snapshot.rig || !loaded.snapshot.animations) throw new Error("Imported golden snapshot is incomplete");
    assertSemanticContract(loaded.snapshot.project, loaded.snapshot.rig, loaded.snapshot.animations);
    expect(loaded.summary).toMatchObject({ valid: true, partCount: 16, rigPresent: true, animationCount: 4 });
  });
});
