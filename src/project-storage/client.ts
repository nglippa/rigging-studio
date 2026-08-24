import type { LocalProjectSaveResult, LocalProjectSnapshot, LocalProjectSummary } from "./types";

const BRIDGE_URL = process.env.NEXT_PUBLIC_RIGGING_STUDIO_BRIDGE_URL ?? "http://127.0.0.1:47831";

export type ProjectStorageStatus = { readonly available: boolean; readonly root: string; readonly relativeRoot: string; readonly projectCount: number; readonly writable: boolean };

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${BRIDGE_URL}${path}`, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const payload = await response.json() as T & { readonly error?: string }; if (!response.ok) throw new Error(payload.error ?? `Project storage request failed (${response.status})`); return payload;
};
const post = <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export class LocalProjectStorageClient {
  status(): Promise<ProjectStorageStatus> { return request("/project-storage/status"); }
  async list(): Promise<readonly LocalProjectSummary[]> { return (await request<{ readonly projects: readonly LocalProjectSummary[] }>("/project-storage/projects")).projects; }
  save(snapshot: LocalProjectSnapshot, expectedModifiedAt?: string): Promise<LocalProjectSaveResult> { return post("/project-storage/save", { snapshot, ...(expectedModifiedAt ? { expectedModifiedAt } : {}) }); }
  saveAs(snapshot: LocalProjectSnapshot, name: string): Promise<LocalProjectSaveResult> { return post("/project-storage/save-as", { snapshot, name }); }
  load(projectId: string): Promise<{ readonly snapshot: LocalProjectSnapshot; readonly summary: LocalProjectSummary }> { return post("/project-storage/load", { projectId }); }
  import(snapshot: LocalProjectSnapshot, name?: string): Promise<LocalProjectSaveResult> { return post("/project-storage/import", { snapshot, ...(name ? { name } : {}) }); }
  importZip(zipBase64: string, name?: string): Promise<LocalProjectSaveResult> { return post("/project-storage/import", { zipBase64, ...(name ? { name } : {}) }); }
  chooseRoot(): Promise<ProjectStorageStatus> { return post("/project-storage/choose-root", {}); }
  archive(projectId: string): Promise<{ readonly archived: true }> { return post("/project-storage/archive", { projectId, confirm: true }); }
  exportSnapshot(projectId: string): Promise<{ readonly exportPath: string; readonly files: readonly string[] }> { return post("/project-storage/export-snapshot", { projectId }); }
  reveal(projectId: string): Promise<{ readonly revealed: true }> { return post("/project-storage/reveal", { projectId }); }
  assetUrl(projectId: string, relativePath: string): string { return `${BRIDGE_URL}/project-storage/assets/${encodeURIComponent(projectId)}/${relativePath.split("/").map(encodeURIComponent).join("/")}`; }
}
