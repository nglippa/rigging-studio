"use client";
/* eslint-disable @next/next/no-img-element -- managed local project thumbnails are served by the trusted bridge */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRiggingCommandService } from "@/src/agent-control";
import { LocalProjectStorageClient, type ProjectStorageStatus } from "@/src/project-storage/client";
import { projectSaveFailureState, type LocalProjectSummary, type ProjectSaveState } from "@/src/project-storage/types";
import type { DurableSaveRequest, ProjectSwitchTransaction } from "@/src/project-storage/projectLifecycle";
import { StudioDialog } from "./StudioDialog";
import "./project-storage.css";

const ACTIVE_DISK_PROJECT_KEY = "rig-studio:active-disk-project:v1";
const stateLabel: Record<ProjectSaveState, string> = { unsaved: "UNSAVED", saving: "SAVING…", opening: "OPENING…", validating: "VALIDATING…", saved: "SAVED TO DISK", "cache-only": "LOCAL CACHE ONLY", failed: "SAVE FAILED" };

export function ProjectStorageMenu() {
  const router = useRouter();
  const service = useMemo(() => getRiggingCommandService(), []); const client = useMemo(() => new LocalProjectStorageClient(), []);
  const [status, setStatus] = useState<ProjectStorageStatus | null>(null); const [projects, setProjects] = useState<readonly LocalProjectSummary[]>([]);
  const [active, setActive] = useState<LocalProjectSummary | null>(null); const [saveState, setSaveState] = useState<ProjectSaveState>("unsaved");
  const [message, setMessage] = useState<string | null>(null); const [saveAsOpen, setSaveAsOpen] = useState(false); const [saveAsName, setSaveAsName] = useState("");
  const [archiveTarget, setArchiveTarget] = useState<LocalProjectSummary | null>(null); const mounted = useRef(true); const saveTimer = useRef<number | null>(null);
  const suppressAutosave = useRef(false); const importInput = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef<LocalProjectSummary | null>(null); const projectsRef = useRef<readonly LocalProjectSummary[]>([]);
  const saveQueuesRef = useRef(new Map<string, Promise<boolean>>());
  const startupOpenAttempted = useRef(false);
  const [pendingOpen, setPendingOpen] = useState<LocalProjectSummary | null>(null);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { projectsRef.current = projects; }, [projects]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextStatus, nextProjects] = await Promise.all([client.status(), client.list()]); if (!mounted.current) return;
      setStatus(nextStatus); setProjects(nextProjects);
      try { const snapshot = service.getDurableSnapshot(); const currentId = snapshot.localProjectId ?? null; const nextActive = currentId ? nextProjects.find((project) => project.projectId === currentId) ?? null : null; setActive(nextActive); setSaveState(nextActive ? "saved" : "cache-only"); }
      catch { setSaveState(nextProjects.length ? "unsaved" : "cache-only"); }
    } catch { if (mounted.current) { setStatus(null); setProjects([]); setActive(null); setSaveState("cache-only"); } }
  }, [client, service]);

  const performSave = useCallback(async (request: DurableSaveRequest, background = false): Promise<boolean> => {
    const queueKey = request.projectId ?? "browser-only"; const previous = saveQueuesRef.current.get(queueKey) ?? Promise.resolve(true);
    const queued = previous.catch(() => false).then(async () => {
      try {
        setSaveState("saving");
        const expected = request.projectId ? projectsRef.current.find((project) => project.projectId === request.projectId)?.modifiedAt : undefined;
        const saved = await client.save(request.snapshot, expected); if (!mounted.current) return false;
        if (!service.completeDurableSave(request, saved.projectId)) return false;
        projectsRef.current = [saved, ...projectsRef.current.filter((project) => project.projectId !== saved.projectId)]; activeRef.current = saved;
        window.localStorage.setItem(ACTIVE_DISK_PROJECT_KEY, saved.projectId); setActive(saved); setSaveState("saved"); if (!background) setMessage(`Saved · ${saved.relativePath}`); await refresh(); return true;
      } catch (error: unknown) {
        if (mounted.current) { setSaveState(projectSaveFailureState(Boolean(activeRef.current))); setMessage(error instanceof Error ? error.message : "Disk save failed"); }
        return false;
      }
    });
    saveQueuesRef.current.set(queueKey, queued); void queued.finally(() => { if (saveQueuesRef.current.get(queueKey) === queued) saveQueuesRef.current.delete(queueKey); });
    return queued;
  }, [client, refresh, service]);
  const save = useCallback(async (background = false): Promise<boolean> => {
    try { return await performSave(service.createDurableSaveRequest(background ? "autosave" : "save"), background); }
    catch (error: unknown) { if (mounted.current) { setSaveState(projectSaveFailureState(Boolean(activeRef.current))); setMessage(error instanceof Error ? error.message : "Disk save failed"); } return false; }
  }, [performSave, service]);

  useEffect(() => { mounted.current = true; const timer = window.setTimeout(() => void refresh(), 0); return () => { mounted.current = false; window.clearTimeout(timer); if (saveTimer.current) window.clearTimeout(saveTimer.current); }; }, [refresh]);
  useEffect(() => service.subscribeDurableSnapshot(() => {
    if (suppressAutosave.current) return;
    if (!active) { setSaveState("cache-only"); return; } setSaveState("unsaved"); if (saveTimer.current) window.clearTimeout(saveTimer.current);
    let request: DurableSaveRequest;
    try { request = service.createDurableSaveRequest("autosave"); }
    catch { return; }
    saveTimer.current = window.setTimeout(() => void performSave(request, true), 900);
  }), [active, performSave, service]);

  const installLoaded = useCallback((transaction: ProjectSwitchTransaction, snapshot: Parameters<typeof service.installDurableSnapshot>[0]): boolean => {
    let committed = false;
    suppressAutosave.current = true; try { committed = service.commitDurableProjectOpen(transaction, snapshot); } finally { suppressAutosave.current = false; }
    if (!committed) return false;
    const mode = snapshot.rig ? snapshot.animations?.animations.length ? "animate" : "setup" : "prepare";
    const destination = mode === "animate" ? "/?mode=animate" : mode === "setup" ? "/?mode=setup"
      : snapshot.project?.stage === "describe" || snapshot.project?.stage === "generate" ? "/create-character" : "/part-cutter";
    window.dispatchEvent(new CustomEvent("rig-studio:durable-project-opened", { detail: { mode, projectId: transaction.targetProjectId, projectSessionToken: transaction.projectSessionToken } }));
    if (`${window.location.pathname}${window.location.search}` !== destination) router.push(destination);
    return true;
  }, [router, service]);

  const performOpen = useCallback(async (project: LocalProjectSummary): Promise<void> => {
    const transaction = service.beginDurableProjectOpen(project.projectId, project.relativePath);
    try {
      setSaveState("opening"); setMessage(`Opening · ${project.relativePath}`);
      const loaded = await client.load(project.projectId); setSaveState("validating");
      if (!installLoaded(transaction, loaded.snapshot)) return;
      window.localStorage.setItem(ACTIVE_DISK_PROJECT_KEY, project.projectId); activeRef.current = loaded.summary; setActive(loaded.summary); setSaveState("saved"); setMessage(`Opened · ${project.relativePath}`);
    } catch (error: unknown) { service.abortDurableProjectOpen(transaction); setSaveState(activeRef.current ? "failed" : "cache-only"); setMessage(error instanceof Error ? error.message : "Project could not be opened"); }
  }, [client, installLoaded, service]);
  useEffect(() => {
    if (startupOpenAttempted.current || active || !status?.available || !projects.length) return;
    const persistedProjectId = window.localStorage.getItem(ACTIVE_DISK_PROJECT_KEY);
    const target = persistedProjectId ? projects.find((project) => project.projectId === persistedProjectId) : null;
    if (!target) return;
    startupOpenAttempted.current = true;
    const timer = window.setTimeout(() => void performOpen(target), 0);
    return () => window.clearTimeout(timer);
  }, [active, performOpen, projects, status?.available]);
  const openProject = async (project: LocalProjectSummary): Promise<void> => {
    if (activeRef.current && activeRef.current.projectId !== project.projectId && saveState === "unsaved") {
      if (!await save(false)) { setPendingOpen(project); return; }
    }
    await performOpen(project);
  };
  const saveAs = async (): Promise<void> => {
    let transaction: ProjectSwitchTransaction | null = null;
    try { const saved = await client.saveAs(structuredClone(service.getDurableSnapshot()), saveAsName.trim()); transaction = service.beginDurableProjectOpen(saved.projectId, saved.relativePath); const loaded = await client.load(saved.projectId); if (!installLoaded(transaction, loaded.snapshot)) return; window.localStorage.setItem(ACTIVE_DISK_PROJECT_KEY, saved.projectId); setActive(loaded.summary); setSaveState("saved"); setSaveAsOpen(false); setMessage(`Saved as · ${saved.relativePath}`); await refresh(); }
    catch (error: unknown) { if (transaction) service.abortDurableProjectOpen(transaction); setSaveState("failed"); setMessage(error instanceof Error ? error.message : "Save As failed"); }
  };
  const importProject = async (file: File): Promise<void> => {
    let transaction: ProjectSwitchTransaction | null = null;
    try {
      setSaveState("saving"); const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error ?? new Error("Import could not be read")); reader.readAsDataURL(file); });
      const saved = await client.importZip(dataUrl.slice(dataUrl.indexOf(",") + 1), file.name.replace(/\.project\.zip$/i, "")); transaction = service.beginDurableProjectOpen(saved.projectId, saved.relativePath); const loaded = await client.load(saved.projectId); if (!installLoaded(transaction, loaded.snapshot)) return;
      window.localStorage.setItem(ACTIVE_DISK_PROJECT_KEY, saved.projectId); setActive(loaded.summary); setSaveState("saved"); setMessage(`Imported · ${saved.relativePath}`); await refresh();
    } catch (error: unknown) { if (transaction) service.abortDurableProjectOpen(transaction); setSaveState("failed"); setMessage(error instanceof Error ? error.message : "Import failed"); }
  };
  const chooseRoot = async (): Promise<void> => {
    try { const next = await client.chooseRoot(); window.localStorage.removeItem(ACTIVE_DISK_PROJECT_KEY); setActive(null); setMessage(`Project storage · ${next.root}`); await refresh(); }
    catch (error: unknown) { setMessage(error instanceof Error ? error.message : "Storage folder could not be selected"); }
  };
  const archive = async (): Promise<void> => {
    if (!archiveTarget) return; try { await client.archive(archiveTarget.projectId); if (active?.projectId === archiveTarget.projectId) { window.localStorage.removeItem(ACTIVE_DISK_PROJECT_KEY); setActive(null); setSaveState("cache-only"); } setMessage(`${archiveTarget.name} moved to .rigging-studio/trash`); setArchiveTarget(null); await refresh(); }
    catch (error: unknown) { setMessage(error instanceof Error ? error.message : "Archive failed"); }
  };

  const available = Boolean(status?.available && status.writable);
  return <>
    <details className="project-storage-menu" data-dismissible-menu data-state={saveState}>
      <summary title={active ? `Saved · ${active.relativePath}` : available ? "Browser draft is not yet durable" : "Local bridge is unavailable"}><i />{stateLabel[saveState]}<b>⌄</b></summary>
      <div className="project-storage-popover">
        <header><span><strong>Project storage</strong><small title={status?.root}>{status?.relativeRoot ?? ".rigging-studio/projects"}</small></span><button type="button" onClick={() => void chooseRoot()} disabled={!available}>Choose Folder</button><em data-state={available ? "ready" : "offline"}>{available ? "DISK READY" : "BRIDGE OFFLINE"}</em></header>
        {message && <p className="project-storage-message">{message}</p>}
        {!active && <div className="cache-migration"><b>Browser-only work detected</b><span>Persist it before this browser profile disappears.</span><button type="button" onClick={() => void save()} disabled={!available}>Persist to Disk</button></div>}
        <div className="recent-projects"><div className="recent-projects-title"><strong>Recent projects</strong><button type="button" onClick={() => void refresh()}>↻</button></div>
          {projects.length ? projects.slice(0, 8).map((project) => <article key={project.projectId} className={active?.projectId === project.projectId ? "is-active" : ""}>
            {project.sourceThumbnail ? <img src={client.assetUrl(project.projectId, project.sourceThumbnail)} alt="" /> : <i>RS</i>}
            <span><b>{project.name}</b><small>{project.stage} · {project.partCount} parts · {project.animationCount} animations</small><time>{new Date(project.modifiedAt).toLocaleString()}</time></span>
            <button type="button" onClick={() => void openProject(project)}>Open</button>
          </article>) : <p className="no-projects">No disk projects yet.</p>}
        </div>
        <footer>
          <button type="button" onClick={() => void save()} disabled={!available}>Save</button>
          <button type="button" onClick={() => { setSaveAsName(active ? `${active.name} Copy` : "Project Copy"); setSaveAsOpen(true); }} disabled={!available}>Save As</button>
          <button type="button" onClick={() => importInput.current?.click()} disabled={!available}>Import</button>
          <button type="button" onClick={() => active && void client.exportSnapshot(active.projectId).then((result) => setMessage(`Snapshot · ${result.exportPath}`)).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Snapshot failed"))} disabled={!active}>Export Snapshot</button>
          <button type="button" onClick={() => active && void client.reveal(active.projectId).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Reveal failed"))} disabled={!active}>Reveal</button>
          <button type="button" onClick={() => active && setArchiveTarget(active)} disabled={!active}>Archive</button>
          <Link href="/create-character">New project</Link>
        </footer>
      </div>
    </details>
    <input ref={importInput} className="project-storage-file-input" type="file" accept=".project.zip,application/zip" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void importProject(file); }} />
    <StudioDialog open={saveAsOpen} title="Save project as" description="Creates a separate managed project directory with copied rig, animations, and assets." confirmLabel="Save As" confirmDisabled={!saveAsName.trim()} onCancel={() => setSaveAsOpen(false)} onConfirm={() => void saveAs()}><label>Project name<input value={saveAsName} autoFocus onChange={(event) => setSaveAsName(event.target.value)} /></label></StudioDialog>
    <StudioDialog open={pendingOpen !== null} title="Save failed before switching" description="The current project is still active. Retry the save, switch without saving, or cancel." confirmLabel="Retry Save" onCancel={() => setPendingOpen(null)} onConfirm={() => { const target = pendingOpen; if (!target) return; void save(false).then((saved) => { if (saved) { setPendingOpen(null); return performOpen(target); } }); }}><button type="button" className="danger" onClick={() => { const target = pendingOpen; setPendingOpen(null); if (target) void performOpen(target); }}>Switch without saving</button></StudioDialog>
    <StudioDialog open={archiveTarget !== null} title={`Archive ${archiveTarget?.name ?? "project"}?`} description="The project is moved to .rigging-studio/trash. It is not permanently deleted." confirmLabel="Archive project" danger onCancel={() => setArchiveTarget(null)} onConfirm={() => void archive()} />
  </>;
}
