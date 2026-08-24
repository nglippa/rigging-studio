import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";
import { createGeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { createAnimationLibrary } from "../../src/tools/rig-editor/animation/library";
import { LOCAL_PROJECT_STORAGE_VERSION, type LocalProjectSnapshot } from "../../src/project-storage/types";
import type { AnimationDefinition, RigDefinition } from "../../src/rigging/schema/types";
import { readStoredZip } from "../../src/character-generation/project/projectArchive";
import { createDiagnosticZip } from "../../src/rigging/ai-vision/diagnosticPackage";
import { assignOwnershipSelection, ensureOwnershipPartition } from "../../src/part-cutter";
import { canonicalProjectStateDigest } from "../../src/project-storage/digest";
import { buildAnimationGenerationContext } from "../../src/rigging/ai/animationContextBuilder";
import { MockAnimationGenerationProvider } from "../../src/rigging/ai/mockAnimationGenerationProvider";
import { validateAnimationProposal } from "../../src/rigging/ai/animationProposalValidator";

const roots: string[] = [];
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xf6S9QAAAABJRU5ErkJggg==";

async function fixture(): Promise<LocalProjectSnapshot> {
  const rig = JSON.parse(await readFile(path.resolve("public/rig-test/minimal-rig.json"), "utf8")) as RigDefinition;
  const animation = JSON.parse(await readFile(path.resolve("public/rig-test/idle-animation.json"), "utf8")) as AnimationDefinition;
  const base = createGeneratedCharacterProject("Durable Knight", "test", "2026-01-01T00:00:00.000Z");
  const project = {
    ...base, stage: "edit" as const, sourceImage: {
      generationId: "source-a", image: pixel, width: 1, height: 1, generationPrompt: "test", generationSettings: {},
      providerMetadata: {}, warnings: [], generationMode: "imported_external" as const, novelArtwork: true, provider: "test", sourceArtifact: "pixel.png",
    },
    extractedParts: [{ partId: "body", image: pixel, width: 1, height: 1, padding: 0, status: "accepted" as const }],
    partCutterState: {
      stateVersion: 1 as const, sourceImageId: "source-a", sourceCanvasSize: { width: 32, height: 32 }, mode: "manual" as const,
      parts: [{ partId: "body", label: "Body", semanticType: "torso" as const, mask: { width: 32, height: 32, alpha: Array(1024).fill(255) }, boundingBox: { x: 0, y: 0, width: 32, height: 32 }, sourceBoundingBox: { x: 0, y: 0, width: 32, height: 32 }, sourceCanvasSize: { width: 32, height: 32 }, pivot: { x: 16, y: 16 }, suggestedParent: "pelvis", suggestedSlot: "body", zOrder: 0, layer: "body" as const, confidence: 1, confidenceSource: "heuristic" as const, articulated: true, equipment: false, occlusionState: "complete" as const, provenance: "manual" as const, accepted: true, notes: [] }],
      proposals: [], ignoredRegions: [], finalized: true, updatedAt: "2026-01-01T00:00:00.000Z",
    },
    rigDefinition: rig, skins: rig.skins,
  };
  return { storageVersion: LOCAL_PROJECT_STORAGE_VERSION, project, rig, animations: createAnimationLibrary(rig.id, [animation]), selectedSkinId: rig.defaultSkinId };
}

async function createStore(): Promise<{ readonly root: string; readonly store: LocalProjectStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "rig-studio-project-store-")); roots.push(root);
  return { root, store: new LocalProjectStore({ cwd: root, root: path.join(root, ".rigging-studio/projects"), trashRoot: path.join(root, ".rigging-studio/trash") }) };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("LocalProjectStore", () => {
  it("creates, lists, and reopens a complete project after a store restart", async () => {
    const { root, store: first } = await createStore(); const snapshot = await fixture(); const saved = await first.save(snapshot);
    expect(saved.saved).toBe(true); expect(saved.relativePath).toContain(".rigging-studio/projects");
    expect((await first.list()).map((project) => project.name)).toEqual(["Durable Knight"]);
    const restarted = new LocalProjectStore({ cwd: root, root: path.join(root, ".rigging-studio/projects"), trashRoot: path.join(root, ".rigging-studio/trash") });
    const loaded = await restarted.load(saved.projectId);
    expect(loaded.snapshot.project?.sourceImage?.image).toBe(pixel); expect(loaded.snapshot.project?.extractedParts[0].image).toBe(pixel);
    expect(loaded.snapshot.rig).toEqual(snapshot.rig); expect(loaded.snapshot.animations).toEqual(snapshot.animations);
  });

  it("keeps large assets outside canonical JSON and writes atomic backups", async () => {
    const { store } = await createStore(); const snapshot = await fixture(); const first = await store.save(snapshot); const directory = first.diskPath;
    const manifest = await readFile(path.join(directory, "project.json"), "utf8"); expect(manifest).not.toContain("iVBORw0KGgo");
    expect(await readdir(path.join(directory, "source"))).not.toHaveLength(0); expect(await readdir(path.join(directory, "parts"))).not.toHaveLength(0);
    expect(await readdir(path.join(directory, "masks"))).not.toHaveLength(0);
    const second = await store.save(snapshot, { expectedModifiedAt: first.modifiedAt }); expect(second.backupWritten).toBe(true);
    expect(await readFile(path.join(directory, "project.json.bak"), "utf8")).toContain(first.projectId);
  });

  it("rejects stale writes and serializes concurrent saves", async () => {
    let tick = 0; const { root } = await createStore();
    const local = new LocalProjectStore({ cwd: root, root: path.join(root, ".rigging-studio/projects"), now: () => `2026-01-01T00:00:0${tick++}.000Z` });
    const snapshot = await fixture(); const first = await local.save(snapshot);
    await expect(local.save(snapshot, { expectedModifiedAt: "2025-01-01T00:00:00.000Z" })).rejects.toThrow("changed on disk");
    const [left, right] = await Promise.all([local.save(snapshot), local.save(snapshot)]); expect(left.modifiedAt).not.toBe(right.modifiedAt);
    expect((await local.load(first.projectId)).snapshot.animations?.animations).toHaveLength(1);
  });

  it("supports Save As, snapshot export, and recoverable archive", async () => {
    const { store } = await createStore(); const snapshot = await fixture(); const original = await store.save(snapshot); const copy = await store.saveAs(snapshot, "Durable Knight Copy");
    expect(copy.projectId).not.toBe(original.projectId); expect((await store.list())).toHaveLength(2);
    const exported = await store.exportSnapshot(copy.projectId); expect(exported.files).toEqual(["rig.json", "animations.json", "durable-knight-copy.project.zip"]);
    for (const file of exported.files) expect((await readFile(path.join(exported.exportPath, file))).byteLength).toBeGreaterThan(0);
    const archiveFiles = readStoredZip(await readFile(path.join(exported.exportPath, "durable-knight-copy.project.zip")));
    expect([...archiveFiles.keys()]).toEqual(expect.arrayContaining(["project.json", "rig.json", "animations.json", expect.stringMatching(/^source\//), expect.stringMatching(/^parts\//)]));
    const imported = await store.importPortableZip(await readFile(path.join(exported.exportPath, "durable-knight-copy.project.zip")), "Imported Knight");
    expect((await store.load(imported.projectId)).snapshot).toMatchObject({ project: { name: "Imported Knight", extractedParts: [{ image: pixel }] }, rig: { id: expect.any(String) }, animations: { animations: [{ id: expect.any(String) }] } });
    const archived = await store.archive(copy.projectId); expect(archived.archived).toBe(true); expect((await store.list())).toHaveLength(2);
  });

  it("preserves the exact ownership partition through restart and Project ZIP round-trip", async () => {
    const { root, store } = await createStore(); const snapshot = await fixture(); if (!snapshot.project?.partCutterState) throw new Error("Part fixture is unavailable");
    const canonical = ensureOwnershipPartition(snapshot.project.partCutterState); const selection = { width: 4, height: 4, alpha: Array(16).fill(255) };
    const edited = assignOwnershipSelection(canonical, null, { x: 10, y: 10, width: 4, height: 4 }, selection).state;
    const durable = { ...snapshot, project: { ...snapshot.project, partCutterState: edited } }; const saved = await store.save(durable);
    const restarted = new LocalProjectStore({ cwd: root, root: path.join(root, ".rigging-studio/projects"), trashRoot: path.join(root, ".rigging-studio/trash") }); const loaded = await restarted.load(saved.projectId);
    expect(loaded.snapshot.project?.partCutterState?.ownership?.runs).toEqual(edited.ownership?.runs);
    const exported = await restarted.exportSnapshot(saved.projectId); const zip = await readFile(path.join(exported.exportPath, "durable-knight.project.zip")); const target = await createStore(); const imported = await target.store.importPortableZip(zip, "Ownership Copy"); const roundTripped = await target.store.load(imported.projectId);
    expect(roundTripped.snapshot.project?.partCutterState?.ownership?.runs).toEqual(edited.ownership?.runs);
  });

  it("reports missing assets, invalid manifests, unsupported versions, and write failure", async () => {
    const { root, store } = await createStore(); const saved = await store.save(await fixture()); const source = (await readdir(path.join(saved.diskPath, "source")))[0];
    await rm(path.join(saved.diskPath, "source", source)); await expect(store.load(saved.projectId)).rejects.toThrow("asset missing");
    const invalidDirectory = path.join(root, ".rigging-studio/projects/invalid--project"); await writeFile(path.join(root, "blocking-file"), "x");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(invalidDirectory, { recursive: true }));
    await writeFile(path.join(invalidDirectory, "project.json"), JSON.stringify({ storageVersion: 999, projectId: "bad" }));
    expect((await store.list()).some((project) => project.projectId === "bad")).toBe(false);
    const blocked = new LocalProjectStore({ cwd: root, root: path.join(root, "blocking-file") }); expect((await blocked.status()).available).toBe(false);
    await expect(blocked.save(await fixture())).rejects.toThrow();
  });

  it("rejects corrupted or incomplete ZIPs transactionally without mutating the existing project", async () => {
    const { store } = await createStore(); const original = await store.save(await fixture()); const before = canonicalProjectStateDigest((await store.load(original.projectId)).snapshot);
    const exported = await store.exportSnapshot(original.projectId); const archivePath = path.join(exported.exportPath, "durable-knight.project.zip"); const archive = readStoredZip(await readFile(archivePath));
    const rebuild = async (entries: readonly (readonly [string, Uint8Array])[]): Promise<Uint8Array> => new Uint8Array(await (await createDiagnosticZip(entries.map(([name, data]) => ({ name, data })))).arrayBuffer());
    const cases: { readonly name: string; readonly bytes: Uint8Array }[] = [];
    cases.push({ name: "missing rig", bytes: await rebuild([...archive.entries()].filter(([name]) => name !== "rig.json")) });
    const modifiedMask = [...archive.entries()].map(([name, data]) => [name, name.startsWith("masks/") ? Uint8Array.from([...data.slice(0, Math.max(0, data.length - 1)), 7]) : data] as const);
    cases.push({ name: "modified mask", bytes: await rebuild(modifiedMask) });
    const truncatedAnimations = [...archive.entries()].map(([name, data]) => [name, name === "animations.json" ? data.slice(0, Math.max(1, Math.floor(data.length / 2))) : data] as const);
    cases.push({ name: "truncated animations", bytes: await rebuild(truncatedAnimations) });
    cases.push({ name: "invalid manifest", bytes: await rebuild([...archive.entries()].map(([name, data]) => [name, name === "integrity.json" ? new TextEncoder().encode("{bad") : data] as const)) });
    cases.push({ name: "missing source", bytes: await rebuild([...archive.entries()].filter(([name]) => !name.startsWith("source/"))) });
    const duplicateEntries = [...archive.entries(), ["project.json", archive.get("project.json")!] as const];
    cases.push({ name: "duplicate path", bytes: await rebuild(duplicateEntries) });
    for (const candidate of cases) await expect(store.importPortableZip(candidate.bytes, candidate.name)).rejects.toThrow();
    expect(canonicalProjectStateDigest((await store.load(original.projectId)).snapshot)).toBe(before);
    expect(await store.list()).toHaveLength(1);
  });

  it("preserves the normalized canonical digest through 20 import-as-copy round trips", async () => {
    const { store } = await createStore(); const saved = await store.save(await fixture()); const source = await store.load(saved.projectId); const expected = canonicalProjectStateDigest(source.snapshot, true);
    const exported = await store.exportSnapshot(saved.projectId); const zip = await readFile(path.join(exported.exportPath, "durable-knight.project.zip"));
    for (let index = 0; index < 20; index += 1) {
      const imported = await store.importPortableZip(zip, `Round Trip ${index + 1}`); const loaded = await store.load(imported.projectId);
      expect(canonicalProjectStateDigest(loaded.snapshot, true)).toBe(expected);
    }
  }, 60_000);

  it("preserves deterministic Idle/Walk/Run/Attack clips through reopen and portable ZIP import", async () => {
    const { store } = await createStore(); const source = await fixture(); if (!source.rig || !source.project) throw new Error("Fixture rig missing");
    const root = source.rig.bones.find((bone) => bone.id === source.rig!.rootBoneId)!;
    const pelvis = { ...root, id: "pelvis", parentId: root.id, x: 0, y: 0 };
    const rig: RigDefinition = { ...source.rig, metadata: { ...source.rig.metadata, name: "Locomotion Persistence" }, bones: [
      root, pelvis, ...source.rig.bones.filter((bone) => bone.id !== root.id).map((bone) => /torso|left-upper-leg|right-upper-leg/.test(bone.id) && bone.parentId === root.id ? { ...bone, parentId: pelvis.id } : bone),
    ] };
    const provider = new MockAnimationGenerationProvider(); const clips: AnimationDefinition[] = [];
    for (const target of [{ id: "idle", duration: 2, loop: true }, { id: "walk", duration: .96, loop: true }, { id: "run", duration: .64, loop: true }, { id: "attack", duration: .85, loop: false }] as const) {
      const context = buildAnimationGenerationContext(rig, { request: target.id, mode: "create", selectedBoneIds: [], leftRightMappings: [], groundPlaneY: 90, leftFootBoneId: "left-foot", rightFootBoneId: "right-foot", contactIntervals: [], constraints: { duration: target.duration, loop: target.loop, intensity: .65, weight: .6, exaggeration: .45, rootMovementAllowance: 40, preserveTiming: false, preserveContactFrames: true, styleNotes: "persistence" } });
      const proposal = await provider.generateAnimationProposal({ prompt: target.id, context }); const validation = validateAnimationProposal(proposal, rig);
      if (!validation.success) throw new Error(validation.message); clips.push(validation.proposal.animation);
    }
    const project = { ...source.project, rigDefinition: rig, skins: rig.skins };
    const snapshot = { ...source, project, rig, animations: createAnimationLibrary(rig.id, [...source.animations!.animations.filter((candidate) => !clips.some((clip) => clip.id === candidate.id)), ...clips]) };
    const saved = await store.save(snapshot); const reopened = await new LocalProjectStore({ cwd: store.cwd, root: store.root, trashRoot: store.trashRoot }).load(saved.projectId);
    expect(reopened.snapshot.animations?.animations.filter((clip) => /^(idle|walk|run|attack)$/.test(clip.id))).toEqual(clips);
    const exported = await store.exportSnapshot(saved.projectId); const zipName = exported.files.find((file) => file.endsWith(".project.zip")); if (!zipName) throw new Error("ZIP missing");
    const imported = await store.importPortableZip(await readFile(path.join(exported.exportPath, zipName)), "Locomotion ZIP Copy"); const roundTrip = await store.load(imported.projectId);
    expect(roundTrip.snapshot.animations?.animations.filter((clip) => /^(idle|walk|run|attack)$/.test(clip.id))).toEqual(clips);
  });

  it("serializes archive behind a pending save and rejects stale recreation afterward", async () => {
    const gate = deferred<void>(); let block = false;
    const root = await mkdtemp(path.join(tmpdir(), "rig-studio-project-store-")); roots.push(root);
    const store = new LocalProjectStore({ cwd: root, root: path.join(root, ".rigging-studio/projects"), trashRoot: path.join(root, ".rigging-studio/trash"), beforeSave: async () => { if (block) await gate.promise; } });
    const project = await fixture(); const saved = await store.save(project); block = true;
    const pendingSave = store.save(project); const archive = store.archive(saved.projectId); expect(store.pendingQueueCount).toBe(1);
    gate.resolve(); await pendingSave; await archive; expect((await store.list()).some((entry) => entry.projectId === saved.projectId)).toBe(false);
    await expect(store.save(project)).rejects.toThrow("archived");
  });

  it("recovers a project-local rig backup without consulting another project", async () => {
    const { store } = await createStore(); const project = await fixture(); const saved = await store.save(project); await store.save(project);
    await writeFile(path.join(saved.diskPath, "rig.json"), "{truncated", "utf8");
    const recovered = await store.load(saved.projectId); expect(recovered.snapshot.rig).toEqual(project.rig);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
