import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createDiagnosticZip, type DiagnosticPackageFile } from "../../src/rigging/ai-vision/diagnosticPackage";
import { readStoredZip } from "../../src/character-generation/project/projectArchive";
import { parseGeneratedCharacterProject, type GeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";
import { safeParseRigDefinition } from "../../src/rigging/schema/parsing";
import { parseAnimationLibraryJson } from "../../src/tools/rig-editor/animation/library";
import { blockingRigProjectProblems, validateRigProject } from "../../src/rigging/validation/project";
import { canonicalProjectStateDigest } from "../../src/project-storage/digest";
import {
  LOCAL_PROJECT_STORAGE_VERSION,
  type LocalProjectSaveResult,
  type LocalProjectSnapshot,
  type LocalProjectSummary,
} from "../../src/project-storage/types";

const STORAGE_DIRECTORY = ".rigging-studio/projects";
const TRASH_DIRECTORY = ".rigging-studio/trash";
const ASSET_MARKER = "__rigStudioDiskAsset";

type AssetReference = {
  readonly [ASSET_MARKER]: 1;
  readonly path: string;
  readonly encoding: "data-url" | "uint8-array";
  readonly mimeType?: string;
};

type StoredProjectManifest = LocalProjectSummary & {
  readonly canonical: { readonly project: "project.json"; readonly rig: "rig.json"; readonly animations: "animations.json" };
  readonly selectedSkinId: string | null;
  readonly projectState: unknown;
};

const PORTABLE_INTEGRITY_FILE = "integrity.json";
type PortableIntegrityManifest = {
  readonly manifestVersion: 1;
  readonly projectId: string;
  readonly projectSchemaVersion: number;
  readonly storageVersion: number;
  readonly rigSchemaVersion: number | null;
  readonly animationSchemaVersion: number | null;
  readonly exportTimestamp: string;
  readonly sourceHash: string | null;
  readonly canonicalStateDigest: string;
  readonly projectRevision: number | null;
  readonly assets: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
};

export type LocalProjectStoreOptions = {
  readonly cwd?: string;
  readonly root?: string;
  readonly trashRoot?: string;
  readonly now?: () => string;
  readonly beforeSave?: (projectId: string) => Promise<void>;
  readonly beforeLoad?: (projectId: string) => Promise<void>;
};

export type SaveProjectOptions = {
  readonly expectedModifiedAt?: string;
  readonly saveAs?: { readonly name: string; readonly projectId?: string };
};

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const slugify = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "project";
const safeId = (value: string): string => value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || randomUUID();
const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex").slice(0, 20);
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const isAssetReference = (value: unknown): value is AssetReference => isObject(value) && value[ASSET_MARKER] === 1 && typeof value.path === "string" && (value.encoding === "data-url" || value.encoding === "uint8-array");
const isLargeByteArray = (value: unknown): value is readonly number[] => Array.isArray(value) && value.length >= 1024 && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255);
const dataUrlParts = (value: string): { readonly mimeType: string; readonly bytes: Buffer; readonly extension: string } | null => {
  const match = value.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/); if (!match) return null;
  const mimeType = match[1]; const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
  const extension = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : mimeType.includes("json") ? "json" : "png";
  return { mimeType, bytes, extension };
};

export class LocalProjectStore {
  readonly cwd: string;
  readonly root: string;
  readonly trashRoot: string;
  private readonly now: () => string;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly archivedProjectIds = new Set<string>();
  private readonly beforeSave?: (projectId: string) => Promise<void>;
  private readonly beforeLoad?: (projectId: string) => Promise<void>;

  constructor(options: LocalProjectStoreOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.root = path.resolve(options.root ?? process.env.RIGGING_STUDIO_PROJECTS_ROOT ?? path.join(this.cwd, STORAGE_DIRECTORY));
    this.trashRoot = path.resolve(options.trashRoot ?? path.join(this.cwd, TRASH_DIRECTORY));
    this.now = options.now ?? (() => new Date().toISOString());
    this.beforeSave = options.beforeSave;
    this.beforeLoad = options.beforeLoad;
  }

  get pendingQueueCount(): number { return this.queues.size; }

  async status(): Promise<{ readonly available: boolean; readonly root: string; readonly relativeRoot: string; readonly projectCount: number; readonly writable: boolean }> {
    try { await mkdir(this.root, { recursive: true }); await access(this.root, constants.R_OK | constants.W_OK); }
    catch { return { available: false, root: this.root, relativeRoot: this.relative(this.root), projectCount: 0, writable: false }; }
    return { available: true, root: this.root, relativeRoot: this.relative(this.root), projectCount: (await this.list()).length, writable: true };
  }

  async list(): Promise<readonly LocalProjectSummary[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const projects = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try { return this.parseManifest(await this.readJsonWithBackup(path.join(this.root, entry.name, "project.json")), entry.name); }
      catch { return null; }
    }));
    return projects.filter((entry): entry is LocalProjectSummary => entry !== null).sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  async save(snapshot: LocalProjectSnapshot, options: SaveProjectOptions = {}): Promise<LocalProjectSaveResult> {
    const validated = this.validateSnapshot(snapshot);
    const originalId = validated.localProjectId ?? validated.project?.id ?? `project-${validated.rig?.id ?? randomUUID()}`;
    const targetId = options.saveAs?.projectId ?? (options.saveAs ? `${safeId(originalId)}-${randomUUID().slice(0, 8)}` : originalId);
    return this.enqueue(targetId, async () => {
      if (!options.saveAs && this.archivedProjectIds.has(targetId)) throw new Error(`Project ${targetId} was archived and cannot be recreated by a stale save`);
      await this.beforeSave?.(targetId);
      const existing = options.saveAs ? null : await this.findById(targetId);
      if (existing && options.expectedModifiedAt && existing.summary.modifiedAt !== options.expectedModifiedAt) throw new Error("Project changed on disk after it was opened. Reload it before saving again.");
      const name = options.saveAs?.name.trim() || validated.project?.name || validated.rig?.id || "Untitled project";
      const slug = slugify(name); const directoryName = existing?.summary.directoryName ?? `${slug}--${safeId(targetId)}`;
      const directory = this.managedDirectory(directoryName);
      const workDirectory = existing ? directory : this.managedDirectory(`.${directoryName}.${randomUUID()}.tmp-project`);
      await this.ensureLayout(workDirectory);
      const createdAt = existing?.summary.createdAt ?? validated.project?.createdAt ?? this.now(); const modifiedAt = this.now();
      const projectValue = validated.project ? this.cloneProjectIdentity(validated.project, targetId, name, options.saveAs !== undefined, createdAt, modifiedAt) : null;
      const assetWrites = new Map<string, Buffer>();
      const projectState = await this.externalize(projectValue ? { ...projectValue, rigDefinition: undefined } : null, workDirectory, assetWrites, ["project"]);
      const rigValue = validated.rig ? structuredClone(validated.rig) : null;
      const rigState = await this.externalize(rigValue, workDirectory, assetWrites, ["rig"]);
      for (const [relativePath, bytes] of assetWrites) await this.atomicWrite(path.join(workDirectory, relativePath), bytes, false);
      const hydratedRig = rigState ? await this.hydrate(rigState, workDirectory) : null; const rig = hydratedRig ? safeParseRigDefinition(hydratedRig) : null;
      const animations = validated.animations && rig?.success ? { ...validated.animations, rigId: rig.data.id } : null;
      const valid = Boolean(validated.project || rig?.success) && (!animations || Boolean(rig?.success && parseAnimationLibraryJson(json(animations), rig.data).success));
      const sourceThumbnail = this.firstAssetReference(projectState, "source/");
      const summary: LocalProjectSummary = {
        storageVersion: LOCAL_PROJECT_STORAGE_VERSION, projectId: targetId, name, slug, directoryName,
        relativePath: this.relative(directory), createdAt, modifiedAt, stage: projectValue?.stage ?? "edit", valid,
        sourceThumbnail, partCount: projectValue?.partCutterState?.parts.filter((part) => part.accepted).length ?? projectValue?.extractedParts.length ?? validated.rig?.attachments.length ?? 0,
        rigPresent: Boolean(rig?.success), animationCount: animations?.animations.length ?? 0, generationProvider: projectValue?.sourceImage?.provider ?? null,
      };
      const manifest: StoredProjectManifest = { ...summary, canonical: { project: "project.json", rig: "rig.json", animations: "animations.json" }, selectedSkinId: validated.selectedSkinId, projectState };
      try {
        const backupWritten = await this.atomicWrite(path.join(workDirectory, "rig.json"), json(rigState), Boolean(existing));
        await this.atomicWrite(path.join(workDirectory, "animations.json"), json(animations), Boolean(existing));
        await this.atomicWrite(path.join(workDirectory, "project.json"), json(manifest), Boolean(existing));
        if (!existing) await rename(workDirectory, directory);
        return { ...summary, saved: true, diskPath: directory, backupWritten };
      } catch (error) {
        if (!existing) await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async load(projectId: string): Promise<{ readonly snapshot: LocalProjectSnapshot; readonly summary: LocalProjectSummary }> {
    await this.beforeLoad?.(projectId);
    const found = await this.findById(projectId); if (!found) throw new Error(`Managed project ${projectId} does not exist`);
    const directory = this.managedDirectory(found.summary.directoryName);
    const rawRig = await this.readJsonWithBackup(path.join(directory, "rig.json"));
    const rigInput = rawRig === null ? null : await this.hydrate(rawRig, directory); const rig = rigInput === null ? null : safeParseRigDefinition(rigInput); if (rig && !rig.success) throw new Error(`rig invalid: ${rig.message}`);
    const animationsInput = await this.readJsonWithBackup(path.join(directory, "animations.json"));
    const animations = animationsInput === null ? null : rig?.success ? parseAnimationLibraryJson(json(animationsInput), rig.data) : null; if (animationsInput !== null && (!animations || !animations.success)) throw new Error(`animations invalid: ${animations && !animations.success ? animations.message : "rig is missing"}`);
    const projectInput = await this.hydrate(found.manifest.projectState, directory);
    let project: GeneratedCharacterProject | null = null;
    if (projectInput !== null) {
      const parsed = parseGeneratedCharacterProject(rig?.success ? { ...(projectInput as Record<string, unknown>), rigDefinition: rig.data, skins: rig.data.skins } : projectInput);
      if (!parsed.success) throw new Error(`project manifest invalid: ${parsed.message}`); project = parsed.data;
    }
    const snapshot = { storageVersion: LOCAL_PROJECT_STORAGE_VERSION, localProjectId: found.summary.projectId, project, rig: rig?.success ? rig.data : null, animations: animations?.success ? animations.data : null, selectedSkinId: found.manifest.selectedSkinId } satisfies LocalProjectSnapshot;
    const blocking = blockingRigProjectProblems(validateRigProject(snapshot));
    if (blocking.length) throw new Error(`stored-project-invalid: ${blocking.map((problem) => problem.message).join("; ")}`);
    return { snapshot, summary: found.summary };
  }

  async saveAs(snapshot: LocalProjectSnapshot, name: string): Promise<LocalProjectSaveResult> { return this.save(snapshot, { saveAs: { name } }); }

  async importPortableZip(bytes: Uint8Array, name?: string): Promise<LocalProjectSaveResult> {
    const files = readStoredZip(bytes);
    const parseJson = (data: Uint8Array, label: string): unknown => { try { return JSON.parse(Buffer.from(data).toString("utf8")) as unknown; } catch { throw new Error(`${label} is invalid JSON`); } };
    const integrityFile = files.get(PORTABLE_INTEGRITY_FILE); if (!integrityFile) throw new Error(`Project ZIP is missing ${PORTABLE_INTEGRITY_FILE}`);
    const integrityInput = parseJson(integrityFile, PORTABLE_INTEGRITY_FILE);
    if (!isObject(integrityInput) || integrityInput.manifestVersion !== 1 || !Array.isArray(integrityInput.assets) || typeof integrityInput.canonicalStateDigest !== "string") throw new Error("Project ZIP integrity manifest is invalid");
    const integrity = integrityInput as unknown as PortableIntegrityManifest;
    const archivePaths = [...files.keys()].filter((file) => file !== PORTABLE_INTEGRITY_FILE).sort();
    const listedPaths = integrity.assets.map((asset) => asset.path).sort();
    if (new Set(listedPaths).size !== listedPaths.length || JSON.stringify(archivePaths) !== JSON.stringify(listedPaths)) throw new Error("Project ZIP asset manifest does not match archive contents");
    for (const asset of integrity.assets) {
      if (!asset || typeof asset.path !== "string" || typeof asset.bytes !== "number" || typeof asset.sha256 !== "string") throw new Error("Project ZIP integrity asset entry is invalid");
      const file = files.get(asset.path); if (!file) throw new Error(`Project ZIP asset is missing: ${asset.path}`);
      if (file.byteLength !== asset.bytes) throw new Error(`Project ZIP integrity size mismatch: ${asset.path}`);
      const actual = createHash("sha256").update(file).digest("hex"); if (actual !== asset.sha256) throw new Error(`Project ZIP integrity hash mismatch: ${asset.path}`);
    }
    const projectFile = files.get("project.json"); const rigFile = files.get("rig.json"); const animationsFile = files.get("animations.json");
    if (!projectFile || !rigFile || !animationsFile) throw new Error("Project ZIP must contain project.json, rig.json, and animations.json");
    const manifestInput = parseJson(projectFile, "project.json"); if (!isObject(manifestInput) || !("projectState" in manifestInput)) throw new Error("Project ZIP manifest is invalid");
    const rigState = parseJson(rigFile, "rig.json"); const animationsState = parseJson(animationsFile, "animations.json");
    const projectInput = await this.hydrateArchive(manifestInput.projectState, files); const rigInput = rigState === null ? null : await this.hydrateArchive(rigState, files);
    const rig = rigInput === null ? null : safeParseRigDefinition(rigInput); if (rig && !rig.success) throw new Error(`rig.json is invalid: ${rig.message}`);
    const animations = animationsState === null ? null : rig?.success ? parseAnimationLibraryJson(json(animationsState), rig.data) : null;
    if (animationsState !== null && (!animations || !animations.success)) throw new Error(`animations.json is invalid: ${animations && !animations.success ? animations.message : "rig is missing"}`);
    let project: GeneratedCharacterProject | null = null;
    if (projectInput !== null) { const parsed = parseGeneratedCharacterProject(rig?.success ? { ...(projectInput as Record<string, unknown>), rigDefinition: rig.data, skins: rig.data.skins } : projectInput); if (!parsed.success) throw new Error(`project.json is invalid: ${parsed.message}`); project = parsed.data; }
    const snapshot = this.validateSnapshot({ storageVersion: LOCAL_PROJECT_STORAGE_VERSION, localProjectId: null, project, rig: rig?.success ? rig.data : null, animations: animations?.success ? animations.data : null, selectedSkinId: typeof manifestInput.selectedSkinId === "string" ? manifestInput.selectedSkinId : null });
    const digest = canonicalProjectStateDigest(snapshot, true); if (digest !== integrity.canonicalStateDigest) throw new Error(`Project ZIP canonical digest mismatch: expected ${integrity.canonicalStateDigest}, received ${digest}`);
    const sourceHash = snapshot.project?.sourceImage?.image ? createHash("sha256").update(snapshot.project.sourceImage.image).digest("hex") : null;
    if (sourceHash !== integrity.sourceHash) throw new Error("Project ZIP source hash mismatch");
    return this.save(snapshot, { saveAs: { name: name?.trim() || (typeof manifestInput.name === "string" ? manifestInput.name : project?.name ?? "Imported project") } });
  }

  async archive(projectId: string): Promise<{ readonly archived: true; readonly projectId: string; readonly archivedPath: string }> {
    return this.enqueue(projectId, async () => {
      const found = await this.findById(projectId); if (!found) throw new Error(`Managed project ${projectId} does not exist`);
      await mkdir(this.trashRoot, { recursive: true }); const suffix = this.now().replace(/[:.]/g, "-");
      const destination = path.join(this.trashRoot, `${found.summary.directoryName}--${suffix}`); await rename(this.managedDirectory(found.summary.directoryName), destination);
      this.archivedProjectIds.add(projectId);
      return { archived: true as const, projectId, archivedPath: destination };
    });
  }

  async exportSnapshot(projectId: string): Promise<{ readonly projectId: string; readonly exportPath: string; readonly files: readonly string[] }> {
    return this.enqueue(projectId, async () => {
      const found = await this.findById(projectId); if (!found) throw new Error(`Managed project ${projectId} does not exist`);
      const directory = this.managedDirectory(found.summary.directoryName); const loaded = await this.load(projectId);
      const stamp = this.now().replace(/[:.]/g, "-"); const exportDirectory = path.join(directory, "exports", stamp); await mkdir(exportDirectory, { recursive: true });
      const rigJson = json(loaded.snapshot.rig); const animationsJson = json(loaded.snapshot.animations);
      await this.atomicWrite(path.join(exportDirectory, "rig.json"), rigJson, false); await this.atomicWrite(path.join(exportDirectory, "animations.json"), animationsJson, false);
      const files = [...await this.collectPortableFiles(directory)].sort((left, right) => left.name.localeCompare(right.name));
      const integrity: PortableIntegrityManifest = {
        manifestVersion: 1, projectId, projectSchemaVersion: loaded.snapshot.project?.projectVersion ?? 1, storageVersion: LOCAL_PROJECT_STORAGE_VERSION,
        rigSchemaVersion: loaded.snapshot.rig?.schemaVersion ?? null, animationSchemaVersion: loaded.snapshot.animations?.formatVersion ?? null,
        exportTimestamp: this.now(), sourceHash: loaded.snapshot.project?.sourceImage?.image ? createHash("sha256").update(loaded.snapshot.project.sourceImage.image).digest("hex") : null,
        canonicalStateDigest: canonicalProjectStateDigest(loaded.snapshot, true), projectRevision: null,
        assets: files.map((file) => ({ path: file.name, bytes: file.data.byteLength, sha256: createHash("sha256").update(file.data).digest("hex") })),
      };
      files.push({ name: PORTABLE_INTEGRITY_FILE, data: Buffer.from(json(integrity)) });
      const zip = createDiagnosticZip(files); await this.atomicWrite(path.join(exportDirectory, `${found.summary.slug}.project.zip`), Buffer.from(await zip.arrayBuffer()), false);
      return { projectId, exportPath: exportDirectory, files: ["rig.json", "animations.json", `${found.summary.slug}.project.zip`] };
    });
  }

  async reveal(projectId: string): Promise<{ readonly revealed: true; readonly projectId: string }> {
    const found = await this.findById(projectId); if (!found) throw new Error(`Managed project ${projectId} does not exist`);
    const directory = this.managedDirectory(found.summary.directoryName);
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    const child = spawn(command, [directory], { detached: true, stdio: "ignore" }); child.unref();
    return { revealed: true, projectId };
  }

  async readAsset(projectId: string, relativePath: string): Promise<{ readonly bytes: Buffer; readonly mimeType: string }> {
    const found = await this.findById(projectId); if (!found) throw new Error(`Managed project ${projectId} does not exist`);
    const filePath = this.resolveManagedAsset(this.managedDirectory(found.summary.directoryName), relativePath);
    const bytes = await readFile(filePath); const extension = path.extname(filePath).toLowerCase();
    const mimeType = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : extension === ".png" ? "image/png" : "application/octet-stream";
    return { bytes, mimeType };
  }

  async savePreview(projectId: string, renderId: string, bytes: Uint8Array): Promise<string | null> {
    const found = await this.findById(projectId); if (!found) return null; const safeRenderId = safeId(renderId);
    const filePath = path.join(this.managedDirectory(found.summary.directoryName), "previews", `${safeRenderId}.png`); await this.atomicWrite(filePath, bytes, false); return filePath;
  }

  private validateSnapshot(snapshot: LocalProjectSnapshot): LocalProjectSnapshot {
    if (snapshot.storageVersion !== LOCAL_PROJECT_STORAGE_VERSION) throw new Error(`Unsupported project storage version ${String(snapshot.storageVersion)}`);
    const rig = snapshot.rig ? safeParseRigDefinition(snapshot.rig) : null; if (rig && !rig.success) throw new Error(`rig invalid: ${rig.message}`);
    if (snapshot.animations && !rig?.success) throw new Error("animations require a valid rig");
    const animations = snapshot.animations && rig?.success ? parseAnimationLibraryJson(json(snapshot.animations), rig.data) : null; if (animations && !animations.success) throw new Error(`animations invalid: ${animations.message}`);
    let project: GeneratedCharacterProject | null = null;
    if (snapshot.project) { const parsed = parseGeneratedCharacterProject(rig?.success ? { ...snapshot.project, rigDefinition: rig.data, skins: rig.data.skins } : snapshot.project); if (!parsed.success) throw new Error(`project invalid: ${parsed.message}`); project = parsed.data; }
    if (!project && !rig?.success) throw new Error("A project or rig is required");
    const normalized = { storageVersion: LOCAL_PROJECT_STORAGE_VERSION, localProjectId: snapshot.localProjectId ?? null, project, rig: rig?.success ? rig.data : null, animations: animations?.success ? animations.data : null, selectedSkinId: snapshot.selectedSkinId } satisfies LocalProjectSnapshot;
    const blocking = blockingRigProjectProblems(validateRigProject(normalized));
    if (blocking.length) throw new Error(`Project integrity validation failed: ${blocking.map((problem) => problem.message).join("; ")}`);
    return normalized;
  }

  private cloneProjectIdentity(project: GeneratedCharacterProject, id: string, name: string, saveAs: boolean, createdAt: string, modifiedAt: string): GeneratedCharacterProject {
    return { ...structuredClone(project), id, name, createdAt: saveAs ? createdAt : project.createdAt, updatedAt: modifiedAt };
  }

  private async externalize(value: unknown, directory: string, writes: Map<string, Buffer>, segments: readonly string[]): Promise<unknown> {
    if (typeof value === "string") {
      const decoded = dataUrlParts(value); if (!decoded) return value;
      const category = segments.some((segment) => /mask|alpha/i.test(segment)) ? "masks" : segments.some((segment) => /part|attachment/i.test(segment)) ? "parts" : "source";
      const relativePath = `${category}/${slugify(segments.at(-2) ?? category)}-${hash(decoded.bytes)}.${decoded.extension}`;
      writes.set(relativePath, decoded.bytes); return { [ASSET_MARKER]: 1, path: relativePath, encoding: "data-url", mimeType: decoded.mimeType } satisfies AssetReference;
    }
    if (isLargeByteArray(value)) {
      const bytes = Buffer.from(value); const relativePath = `masks/mask-${hash(bytes)}.bin`; writes.set(relativePath, bytes);
      return { [ASSET_MARKER]: 1, path: relativePath, encoding: "uint8-array" } satisfies AssetReference;
    }
    if (Array.isArray(value)) return Promise.all(value.map((entry, index) => this.externalize(entry, directory, writes, [...segments, String(index)])));
    if (isObject(value)) {
      const pairs = await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await this.externalize(entry, directory, writes, [...segments, key])] as const)); return Object.fromEntries(pairs);
    }
    return value;
  }

  private async hydrate(value: unknown, directory: string): Promise<unknown> {
    if (isAssetReference(value)) {
      const assetPath = this.resolveManagedAsset(directory, value.path); const bytes = await readFile(assetPath).catch(() => { throw new Error(`asset missing: ${value.path}`); });
      return value.encoding === "uint8-array" ? Array.from(bytes) : `data:${value.mimeType ?? "application/octet-stream"};base64,${bytes.toString("base64")}`;
    }
    if (Array.isArray(value)) return Promise.all(value.map((entry) => this.hydrate(entry, directory)));
    if (isObject(value)) { const pairs = await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await this.hydrate(entry, directory)] as const)); return Object.fromEntries(pairs); }
    return value;
  }

  private async hydrateArchive(value: unknown, files: ReadonlyMap<string, Uint8Array>): Promise<unknown> {
    if (isAssetReference(value)) {
      const bytes = files.get(value.path); if (!bytes) throw new Error(`Project ZIP asset is missing: ${value.path}`);
      return value.encoding === "uint8-array" ? Array.from(bytes) : `data:${value.mimeType ?? "application/octet-stream"};base64,${Buffer.from(bytes).toString("base64")}`;
    }
    if (Array.isArray(value)) return Promise.all(value.map((entry) => this.hydrateArchive(entry, files)));
    if (isObject(value)) { const pairs = await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await this.hydrateArchive(entry, files)] as const)); return Object.fromEntries(pairs); }
    return value;
  }

  private async collectPortableFiles(directory: string): Promise<DiagnosticPackageFile[]> {
    const roots = ["project.json", "rig.json", "animations.json", "source", "parts", "masks", "previews", "diagnostics"];
    const files: DiagnosticPackageFile[] = [];
    const visit = async (relativePath: string): Promise<void> => {
      const absolutePath = this.resolveManagedAsset(directory, relativePath);
      const entry = await stat(absolutePath).catch(() => null); if (!entry) return;
      if (entry.isFile()) { files.push({ name: relativePath, data: await readFile(absolutePath) }); return; }
      if (!entry.isDirectory()) return;
      const children = await readdir(absolutePath, { withFileTypes: true });
      for (const child of children) {
        if (child.isSymbolicLink() || child.name.endsWith(".bak") || child.name.includes(".tmp-")) continue;
        await visit(path.posix.join(relativePath, child.name));
      }
    };
    for (const root of roots) await visit(root);
    return files;
  }

  private firstAssetReference(value: unknown, prefix: string): string | null {
    if (isAssetReference(value) && value.path.startsWith(prefix)) return value.path;
    if (Array.isArray(value)) { for (const entry of value) { const found = this.firstAssetReference(entry, prefix); if (found) return found; } }
    else if (isObject(value)) { for (const entry of Object.values(value)) { const found = this.firstAssetReference(entry, prefix); if (found) return found; } }
    return null;
  }

  private async findById(projectId: string): Promise<{ readonly summary: LocalProjectSummary; readonly manifest: StoredProjectManifest } | null> {
    await mkdir(this.root, { recursive: true }); const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try { const manifest = await this.readJsonWithBackup(path.join(this.root, entry.name, "project.json")); const summary = this.parseManifest(manifest, entry.name); if (summary.projectId === projectId) return { summary, manifest: manifest as StoredProjectManifest }; }
      catch { /* invalid projects remain visible only through diagnostics */ }
    }
    return null;
  }

  private parseManifest(value: unknown, directoryName: string): LocalProjectSummary {
    if (!isObject(value) || value.storageVersion !== LOCAL_PROJECT_STORAGE_VERSION) throw new Error("project manifest invalid");
    for (const key of ["projectId", "name", "slug", "createdAt", "modifiedAt", "stage"] as const) if (typeof value[key] !== "string") throw new Error(`project manifest invalid: ${key}`);
    if (value.directoryName !== directoryName) throw new Error("project manifest directory mismatch");
    return {
      storageVersion: LOCAL_PROJECT_STORAGE_VERSION, projectId: value.projectId as string, name: value.name as string, slug: value.slug as string,
      directoryName, relativePath: typeof value.relativePath === "string" ? value.relativePath : this.relative(path.join(this.root, directoryName)),
      createdAt: value.createdAt as string, modifiedAt: value.modifiedAt as string, stage: value.stage as string, valid: value.valid === true,
      sourceThumbnail: typeof value.sourceThumbnail === "string" ? value.sourceThumbnail : null, partCount: Number(value.partCount) || 0,
      rigPresent: value.rigPresent === true, animationCount: Number(value.animationCount) || 0, generationProvider: typeof value.generationProvider === "string" ? value.generationProvider : null,
    };
  }

  private managedDirectory(directoryName: string): string { const resolved = path.resolve(this.root, directoryName); if (!resolved.startsWith(`${this.root}${path.sep}`)) throw new Error("Project path escaped the managed storage root"); return resolved; }
  private resolveManagedAsset(directory: string, relativePath: string): string { const resolved = path.resolve(directory, relativePath); if (!resolved.startsWith(`${directory}${path.sep}`)) throw new Error("Asset path escaped its managed project directory"); return resolved; }
  private relative(value: string): string { const relative = path.relative(this.cwd, value); return relative && !relative.startsWith("..") ? relative : value; }
  private async ensureLayout(directory: string): Promise<void> { await Promise.all(["source", "parts", "masks", "previews", "exports", "diagnostics"].map((name) => mkdir(path.join(directory, name), { recursive: true }))); }

  private async atomicWrite(filePath: string, data: string | Uint8Array, backup: boolean): Promise<boolean> {
    await mkdir(path.dirname(filePath), { recursive: true }); const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    let backupWritten = false;
    if (backup) { try { await stat(filePath); await copyFile(filePath, `${filePath}.bak`); backupWritten = true; } catch { /* first save */ } }
    await rename(temporary, filePath); return backupWritten;
  }

  private async readJsonWithBackup(filePath: string): Promise<unknown> {
    const parse = async (candidate: string): Promise<unknown> => JSON.parse(await readFile(candidate, "utf8")) as unknown;
    try { return await parse(filePath); }
    catch (primaryError) {
      try { return await parse(`${filePath}.bak`); }
      catch { throw primaryError; }
    }
  }

  private enqueue<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve(); const next = previous.catch(() => undefined).then(operation);
    this.queues.set(projectId, next); void next.finally(() => { if (this.queues.get(projectId) === next) this.queues.delete(projectId); }).catch(() => undefined); return next;
  }
}
