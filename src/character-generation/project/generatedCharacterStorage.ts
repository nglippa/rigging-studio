import { parseGeneratedCharacterProject, type GeneratedCharacterProject } from "./generatedCharacterProject";
import {
  GENERATED_CHARACTER_ACTIVE_DRAFT_KEY,
  GENERATED_CHARACTER_DRAFT_KEY,
  generatedCharacterDraftKey,
  loadGeneratedCharacterDraft,
} from "./projectDraft";

export const GENERATED_CHARACTER_POINTER_KEY = "rig-studio:generated-character-draft-pointer:v2";
const DATABASE_NAME = "rigging-studio-generated-characters";
const DATABASE_VERSION = 1;
const PROJECT_STORE = "projects";
const ASSET_STORE = "assets";

export type GeneratedCharacterStorageLayer = "indexeddb" | "localstorage-pointer" | "migration";
export type GeneratedCharacterStorageFailure = {
  readonly success: false;
  readonly layer: GeneratedCharacterStorageLayer;
  readonly message: string;
  readonly retryable: true;
  readonly approximateBytes: number;
};
export type GeneratedCharacterStorageSuccess = {
  readonly success: true;
  readonly projectId: string;
  readonly approximateBytes: number;
  readonly assetCount: number;
  readonly migrated?: boolean;
};
export type GeneratedCharacterStorageResult = GeneratedCharacterStorageSuccess | GeneratedCharacterStorageFailure;

type StoredAssetKind = "data-url" | "uint8-array";
type StoredAsset = {
  readonly id: string;
  readonly projectId: string;
  readonly kind: StoredAssetKind;
  readonly value: string | Uint8Array;
  readonly byteLength: number;
};
type AssetReference = {
  readonly __riggingStudioAsset: true;
  readonly id: string;
  readonly kind: StoredAssetKind;
};
type StoredProject = {
  readonly storageVersion: 2;
  readonly projectId: string;
  readonly savedAt: string;
  readonly project: unknown;
  readonly assetIds: readonly string[];
  readonly approximateBytes: number;
};
type DraftPointer = {
  readonly storageVersion: 2;
  readonly projectId: string;
  readonly projectVersion: number;
  readonly currentStage: string;
  readonly savedAt: string;
  readonly approximateBytes: number;
};

export interface GeneratedCharacterObjectStore {
  putProject(project: StoredProject): Promise<void>;
  getProject(projectId: string): Promise<StoredProject | undefined>;
  deleteProject(projectId: string): Promise<void>;
  putAsset(asset: StoredAsset): Promise<void>;
  getAsset(assetId: string): Promise<StoredAsset | undefined>;
  listAssetIds(projectId: string): Promise<readonly string[]>;
  deleteAsset(assetId: string): Promise<void>;
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.addEventListener("success", () => resolve(request.result));
  request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")));
});

export class IndexedDbGeneratedCharacterObjectStore implements GeneratedCharacterObjectStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  private database(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable in this browser context"));
    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(PROJECT_STORE)) database.createObjectStore(PROJECT_STORE, { keyPath: "projectId" });
        if (!database.objectStoreNames.contains(ASSET_STORE)) {
          const assets = database.createObjectStore(ASSET_STORE, { keyPath: "id" });
          assets.createIndex("projectId", "projectId", { unique: false });
        }
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB could not be opened")));
      request.addEventListener("blocked", () => reject(new Error("IndexedDB upgrade is blocked by another Rigging Studio tab")));
    });
    return this.databasePromise;
  }

  private async store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.database()).transaction(name, mode).objectStore(name);
  }

  async putProject(project: StoredProject): Promise<void> { await requestResult((await this.store(PROJECT_STORE, "readwrite")).put(project)); }
  async getProject(projectId: string): Promise<StoredProject | undefined> { return requestResult((await this.store(PROJECT_STORE, "readonly")).get(projectId)) as Promise<StoredProject | undefined>; }
  async deleteProject(projectId: string): Promise<void> { await requestResult((await this.store(PROJECT_STORE, "readwrite")).delete(projectId)); }
  async putAsset(asset: StoredAsset): Promise<void> { await requestResult((await this.store(ASSET_STORE, "readwrite")).put(asset)); }
  async getAsset(assetId: string): Promise<StoredAsset | undefined> { return requestResult((await this.store(ASSET_STORE, "readonly")).get(assetId)) as Promise<StoredAsset | undefined>; }
  async listAssetIds(projectId: string): Promise<readonly string[]> {
    const store = await this.store(ASSET_STORE, "readonly");
    return (await requestResult(store.index("projectId").getAllKeys(IDBKeyRange.only(projectId)))).map(String);
  }
  async deleteAsset(assetId: string): Promise<void> { await requestResult((await this.store(ASSET_STORE, "readwrite")).delete(assetId)); }
}

export class MemoryGeneratedCharacterObjectStore implements GeneratedCharacterObjectStore {
  readonly projects = new Map<string, StoredProject>();
  readonly assets = new Map<string, StoredAsset>();
  async putProject(project: StoredProject): Promise<void> { this.projects.set(project.projectId, structuredClone(project)); }
  async getProject(projectId: string): Promise<StoredProject | undefined> { const value = this.projects.get(projectId); return value ? structuredClone(value) : undefined; }
  async deleteProject(projectId: string): Promise<void> { this.projects.delete(projectId); }
  async putAsset(asset: StoredAsset): Promise<void> { this.assets.set(asset.id, structuredClone(asset)); }
  async getAsset(assetId: string): Promise<StoredAsset | undefined> { const value = this.assets.get(assetId); return value ? structuredClone(value) : undefined; }
  async listAssetIds(projectId: string): Promise<readonly string[]> { return [...this.assets.values()].filter((asset) => asset.projectId === projectId).map((asset) => asset.id); }
  async deleteAsset(assetId: string): Promise<void> { this.assets.delete(assetId); }
}

const dataUrl = (value: string): boolean => /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
const approximateStringBytes = (value: string): number => value.length * 2;
const hashBytes = (values: Iterable<number>): string => {
  let hash = 0x811c9dc5;
  for (const value of values) { hash ^= value & 0xff; hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(36);
};
const hashString = (value: string): string => hashBytes(Array.from(value, (character) => character.charCodeAt(0)));
const assetReference = (id: string, kind: StoredAssetKind): AssetReference => ({ __riggingStudioAsset: true, id, kind });
const isAssetReference = (value: unknown): value is AssetReference => Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Partial<AssetReference>).__riggingStudioAsset === true && typeof (value as Partial<AssetReference>).id === "string");
const isByteArray = (value: unknown): value is readonly number[] => Array.isArray(value) && value.length >= 4096 && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255);

const dehydrateProject = (project: GeneratedCharacterProject): { readonly project: unknown; readonly assets: readonly StoredAsset[]; readonly approximateBytes: number } => {
  const assets = new Map<string, StoredAsset>();
  let approximateBytes = 0;
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      approximateBytes += approximateStringBytes(value);
      if (!dataUrl(value)) return value;
      const id = `asset-data-${hashString(value)}-${value.length}`;
      assets.set(id, { id, projectId: project.id, kind: "data-url", value, byteLength: approximateStringBytes(value) });
      return assetReference(id, "data-url");
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
    if (isByteArray(value)) {
      const bytes = Uint8Array.from(value);
      const id = `asset-mask-${hashBytes(bytes)}-${bytes.byteLength}`;
      assets.set(id, { id, projectId: project.id, kind: "uint8-array", value: bytes, byteLength: bytes.byteLength });
      approximateBytes += bytes.byteLength;
      return assetReference(id, "uint8-array");
    }
    if (Array.isArray(value)) return value.map(visit);
    if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, visit(entry)]));
    return value;
  };
  return { project: visit(project), assets: [...assets.values()], approximateBytes };
};

const hydrateProject = async (value: unknown, store: GeneratedCharacterObjectStore): Promise<unknown> => {
  const visit = async (entry: unknown): Promise<unknown> => {
    if (isAssetReference(entry)) {
      const asset = await store.getAsset(entry.id);
      if (!asset) throw new Error(`Stored generated-character asset ${entry.id} is missing`);
      if (asset.kind !== entry.kind) throw new Error(`Stored generated-character asset ${entry.id} has an unexpected type`);
      return asset.kind === "uint8-array" ? Array.from(asset.value as Uint8Array) : asset.value;
    }
    if (Array.isArray(entry)) return Promise.all(entry.map(visit));
    if (entry && typeof entry === "object") {
      const pairs = await Promise.all(Object.entries(entry as Record<string, unknown>).map(async ([key, child]) => [key, await visit(child)] as const));
      return Object.fromEntries(pairs);
    }
    return entry;
  };
  return visit(value);
};

const storageMessage = (reason: unknown): string => reason instanceof Error ? reason.message : "Generated-character storage failed";

export class GeneratedCharacterStorage {
  constructor(
    private readonly pointerStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    private readonly objects: GeneratedCharacterObjectStore = new IndexedDbGeneratedCharacterObjectStore(),
  ) {}

  async save(project: GeneratedCharacterProject): Promise<GeneratedCharacterStorageResult> {
    const parsed = parseGeneratedCharacterProject(project);
    if (!parsed.success) return { success: false, layer: "indexeddb", message: parsed.message, retryable: true, approximateBytes: 0 };
    const dehydrated = dehydrateProject(parsed.data);
    const savedAt = new Date().toISOString();
    try {
      for (const asset of dehydrated.assets) await this.objects.putAsset(asset);
      const activeAssets = new Set(dehydrated.assets.map((asset) => asset.id));
      const priorAssets = await this.objects.listAssetIds(project.id);
      await this.objects.putProject({ storageVersion: 2, projectId: project.id, savedAt, project: dehydrated.project, assetIds: [...activeAssets], approximateBytes: dehydrated.approximateBytes });
      await Promise.all(priorAssets.filter((id) => !activeAssets.has(id)).map((id) => this.objects.deleteAsset(id)));
    } catch (reason: unknown) {
      return { success: false, layer: "indexeddb", message: storageMessage(reason), retryable: true, approximateBytes: dehydrated.approximateBytes };
    }
    const pointer: DraftPointer = { storageVersion: 2, projectId: project.id, projectVersion: project.projectVersion, currentStage: project.stage, savedAt, approximateBytes: dehydrated.approximateBytes };
    try {
      this.pointerStorage.setItem(GENERATED_CHARACTER_POINTER_KEY, JSON.stringify(pointer));
    } catch (reason: unknown) {
      return { success: false, layer: "localstorage-pointer", message: storageMessage(reason), retryable: true, approximateBytes: dehydrated.approximateBytes };
    }
    return { success: true, projectId: project.id, approximateBytes: dehydrated.approximateBytes, assetCount: dehydrated.assets.length };
  }

  async load(): Promise<ReturnType<typeof parseGeneratedCharacterProject> | null> {
    const pointerSource = this.pointerStorage.getItem(GENERATED_CHARACTER_POINTER_KEY);
    if (pointerSource) {
      try {
        const pointer = JSON.parse(pointerSource) as Partial<DraftPointer>;
        if (pointer.storageVersion !== 2 || typeof pointer.projectId !== "string") return { success: false, message: "Generated-character draft pointer is invalid" };
        const stored = await this.objects.getProject(pointer.projectId);
        if (!stored) return { success: false, message: `Generated-character draft ${pointer.projectId} is missing from IndexedDB` };
        return parseGeneratedCharacterProject(await hydrateProject(stored.project, this.objects));
      } catch (reason: unknown) {
        return { success: false, message: storageMessage(reason) };
      }
    }
    return this.migrateLegacyDraft();
  }

  async migrateLegacyDraft(): Promise<ReturnType<typeof parseGeneratedCharacterProject> | null> {
    const legacy = loadGeneratedCharacterDraft(this.pointerStorage);
    if (!legacy) return null;
    if (!legacy.success) return legacy;
    const result = await this.save(legacy.data);
    if (!result.success) return { success: false, message: `Legacy draft migration failed in ${result.layer}: ${result.message}. The old draft was left untouched.` };
    this.pointerStorage.removeItem(generatedCharacterDraftKey(legacy.data.id));
    this.pointerStorage.removeItem(GENERATED_CHARACTER_DRAFT_KEY);
    this.pointerStorage.removeItem(GENERATED_CHARACTER_ACTIVE_DRAFT_KEY);
    return { success: true, data: legacy.data };
  }

  async discard(projectId?: string): Promise<void> {
    let target = projectId;
    if (!target) {
      try { target = (JSON.parse(this.pointerStorage.getItem(GENERATED_CHARACTER_POINTER_KEY) ?? "null") as Partial<DraftPointer> | null)?.projectId; }
      catch { target = undefined; }
    }
    if (target) {
      const assetIds = await this.objects.listAssetIds(target);
      await Promise.all(assetIds.map((id) => this.objects.deleteAsset(id)));
      await this.objects.deleteProject(target);
    }
    this.pointerStorage.removeItem(GENERATED_CHARACTER_POINTER_KEY);
  }
}

let browserStorage: GeneratedCharacterStorage | null = null;
const serverStorage = new GeneratedCharacterStorage(
  { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  new MemoryGeneratedCharacterObjectStore(),
);
export const getGeneratedCharacterStorage = (): GeneratedCharacterStorage => {
  if (typeof window === "undefined") return serverStorage;
  browserStorage ??= new GeneratedCharacterStorage(window.localStorage);
  return browserStorage;
};
