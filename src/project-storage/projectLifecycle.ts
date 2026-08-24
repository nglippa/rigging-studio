import type { LocalProjectSnapshot } from "./types";

export type ProjectLifecycleOperation =
  | "PROJECT_OPEN_REQUESTED"
  | "PROJECT_SWITCH_STARTED"
  | "PROJECT_STATE_CLEARED"
  | "PROJECT_HYDRATE_STARTED"
  | "PROJECT_HYDRATE_COMMITTED"
  | "PROJECT_SWITCH_ABORTED"
  | "PROJECT_SAVE_STARTED"
  | "PROJECT_SAVE_COMMITTED"
  | "AUTOSAVE_QUEUED"
  | "AUTOSAVE_DROPPED_STALE"
  | "ZIP_EXPORT_STARTED"
  | "ZIP_IMPORT_STARTED"
  | "STALE_PROJECT_COMMIT_BLOCKED";

export type ProjectOperationContext = {
  readonly operation: string;
  readonly projectId: string | null;
  readonly projectSessionToken: string;
  readonly revision: number;
  readonly storagePath: string | null;
};

export type ProjectSwitchTransaction = {
  readonly sourceProjectId: string | null;
  readonly targetProjectId: string;
  readonly projectSessionToken: string;
  readonly hydrationRevision: number;
  readonly storagePath: string | null;
};

export type ProjectLifecycleTraceEvent = {
  readonly timestamp: string;
  readonly operation: ProjectLifecycleOperation;
  readonly activeProjectId: string | null;
  readonly sourceProjectId: string | null;
  readonly targetProjectId: string | null;
  readonly projectSessionToken: string;
  readonly storagePath: string | null;
  readonly saveRevision: number;
  readonly hydrationRevision: number;
  readonly componentSource: string;
  readonly result: string;
};

export type DurableSaveRequest = ProjectOperationContext & {
  readonly snapshot: LocalProjectSnapshot;
  readonly snapshotHash: string;
};

type Options = {
  readonly now?: () => string;
  readonly digest?: (snapshot: LocalProjectSnapshot) => string;
};

const defaultDigest = (snapshot: LocalProjectSnapshot): string => {
  const source = JSON.stringify(snapshot);
  let value = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    value ^= source.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return `fnv1a32:${(value >>> 0).toString(16).padStart(8, "0")}`;
};

/**
 * Owns the single authoritative browser-session identity for the active project.
 * Disk queues remain project-keyed; this guard controls which async completions
 * are allowed to mutate the currently mounted editor.
 */
export class ProjectLifecycleCoordinator {
  private readonly now: () => string;
  private readonly digest: (snapshot: LocalProjectSnapshot) => string;
  private sequence = 0;
  private token = "project-session-0";
  private activeProjectId: string | null = null;
  private storagePath: string | null = null;
  private revision = 0;
  private savedRevision = 0;
  private hydrationRevision = 0;
  private pendingSwitch: ProjectSwitchTransaction | null = null;
  private readonly trace: ProjectLifecycleTraceEvent[] = [];

  constructor(options: Options = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.digest = options.digest ?? defaultDigest;
  }

  get snapshot(): Readonly<{
    activeProjectId: string | null;
    projectSessionToken: string;
    revision: number;
    savedRevision: number;
    hydrationRevision: number;
    storagePath: string | null;
    switching: boolean;
  }> {
    return {
      activeProjectId: this.activeProjectId,
      projectSessionToken: this.token,
      revision: this.revision,
      savedRevision: this.savedRevision,
      hydrationRevision: this.hydrationRevision,
      storagePath: this.storagePath,
      switching: this.pendingSwitch !== null,
    };
  }

  activateInitial(projectId: string, storagePath: string | null = null): void {
    if (this.activeProjectId === projectId && !this.pendingSwitch) return;
    this.sequence += 1;
    this.token = `project-session-${this.sequence}`;
    this.activeProjectId = projectId;
    this.storagePath = storagePath;
    this.revision = 0;
    this.savedRevision = 0;
    this.pendingSwitch = null;
  }

  beginSwitch(targetProjectId: string, storagePath: string | null = null, componentSource = "project-storage-menu"): ProjectSwitchTransaction {
    const sourceProjectId = this.activeProjectId;
    this.sequence += 1;
    this.token = `project-session-${this.sequence}`;
    this.hydrationRevision += 1;
    const transaction = { sourceProjectId, targetProjectId, projectSessionToken: this.token, hydrationRevision: this.hydrationRevision, storagePath } satisfies ProjectSwitchTransaction;
    this.pendingSwitch = transaction;
    this.emit("PROJECT_OPEN_REQUESTED", componentSource, "requested", sourceProjectId, targetProjectId, storagePath);
    this.emit("PROJECT_SWITCH_STARTED", componentSource, "mutations-blocked", sourceProjectId, targetProjectId, storagePath);
    this.emit("PROJECT_HYDRATE_STARTED", componentSource, "isolated-load", sourceProjectId, targetProjectId, storagePath);
    return transaction;
  }

  commitSwitch(transaction: ProjectSwitchTransaction, componentSource = "project-storage-menu"): boolean {
    if (!this.isPending(transaction)) {
      this.stale("hydrate", transaction.targetProjectId, transaction.projectSessionToken, transaction.hydrationRevision, componentSource);
      return false;
    }
    this.emit("PROJECT_STATE_CLEARED", componentSource, "transient-state-reset", transaction.sourceProjectId, transaction.targetProjectId, transaction.storagePath);
    this.activeProjectId = transaction.targetProjectId;
    this.storagePath = transaction.storagePath;
    this.revision = 0;
    this.savedRevision = 0;
    this.pendingSwitch = null;
    this.emit("PROJECT_HYDRATE_COMMITTED", componentSource, "committed", transaction.sourceProjectId, transaction.targetProjectId, transaction.storagePath);
    return true;
  }

  abortSwitch(transaction: ProjectSwitchTransaction, componentSource = "project-storage-menu"): void {
    if (!this.isPending(transaction)) return;
    this.pendingSwitch = null;
    this.sequence += 1;
    this.token = `project-session-${this.sequence}`;
    this.emit("PROJECT_SWITCH_ABORTED", componentSource, "active-project-preserved", transaction.sourceProjectId, transaction.targetProjectId, transaction.storagePath);
  }

  capture(operation: string): ProjectOperationContext {
    return { operation, projectId: this.activeProjectId, projectSessionToken: this.token, revision: this.revision, storagePath: this.storagePath };
  }

  assertMutationsAllowed(projectId: string | null = this.activeProjectId): void {
    if (this.pendingSwitch) throw new Error(`Project switch to ${this.pendingSwitch.targetProjectId} is still in progress`);
    if (projectId !== this.activeProjectId) throw new Error(`Mutation project ${projectId ?? "none"} is not active project ${this.activeProjectId ?? "none"}`);
  }

  recordMutation(projectId: string | null = this.activeProjectId): number {
    this.assertMutationsAllowed(projectId);
    this.revision += 1;
    return this.revision;
  }

  beginSave(snapshot: LocalProjectSnapshot, operation: "save" | "autosave", componentSource = "project-storage-menu"): DurableSaveRequest {
    this.assertMutationsAllowed(snapshot.localProjectId ?? this.activeProjectId);
    const context = this.capture(operation);
    const request = { ...context, snapshot: structuredClone(snapshot), snapshotHash: this.digest(snapshot) } satisfies DurableSaveRequest;
    this.emit(operation === "autosave" ? "AUTOSAVE_QUEUED" : "PROJECT_SAVE_STARTED", componentSource, request.snapshotHash, context.projectId, context.projectId, context.storagePath);
    return request;
  }

  completeSave(request: DurableSaveRequest, destinationProjectId: string, componentSource = "project-storage-menu"): boolean {
    if (!this.isCurrent(request) || destinationProjectId !== request.projectId) {
      this.emit("AUTOSAVE_DROPPED_STALE", componentSource, `destination=${destinationProjectId};revision=${request.revision}`, request.projectId, this.activeProjectId, request.storagePath);
      this.stale(request.operation, request.projectId, request.projectSessionToken, request.revision, componentSource);
      return false;
    }
    this.savedRevision = Math.max(this.savedRevision, request.revision);
    this.emit("PROJECT_SAVE_COMMITTED", componentSource, request.snapshotHash, request.projectId, destinationProjectId, request.storagePath);
    return true;
  }

  isCurrent(context: ProjectOperationContext): boolean {
    return !this.pendingSwitch && context.projectId === this.activeProjectId && context.projectSessionToken === this.token;
  }

  assertCurrent(context: ProjectOperationContext, componentSource = "async-operation"): void {
    if (this.isCurrent(context)) return;
    this.stale(context.operation, context.projectId, context.projectSessionToken, context.revision, componentSource);
    throw new Error(`Stale ${context.operation} result for ${context.projectId ?? "no project"} was discarded`);
  }

  getTrace(): readonly ProjectLifecycleTraceEvent[] { return structuredClone(this.trace); }

  private isPending(transaction: ProjectSwitchTransaction): boolean {
    return this.pendingSwitch?.projectSessionToken === transaction.projectSessionToken
      && this.pendingSwitch.targetProjectId === transaction.targetProjectId
      && this.pendingSwitch.hydrationRevision === transaction.hydrationRevision;
  }

  private stale(operation: string, sourceProjectId: string | null, token: string, revision: number, componentSource: string): void {
    this.emit("STALE_PROJECT_COMMIT_BLOCKED", componentSource, `${operation};token=${token};revision=${revision}`, sourceProjectId, this.activeProjectId, this.storagePath);
  }

  private emit(operation: ProjectLifecycleOperation, componentSource: string, result: string, sourceProjectId: string | null, targetProjectId: string | null, storagePath: string | null): void {
    const event: ProjectLifecycleTraceEvent = {
      timestamp: this.now(), operation, activeProjectId: this.activeProjectId, sourceProjectId, targetProjectId,
      projectSessionToken: this.token, storagePath, saveRevision: this.revision, hydrationRevision: this.hydrationRevision,
      componentSource, result,
    };
    this.trace.push(event);
    if (this.trace.length > 500) this.trace.splice(0, this.trace.length - 500);
    if (typeof window !== "undefined") {
      (window as Window & { __RIG_STUDIO_PROJECT_TRACE__?: readonly ProjectLifecycleTraceEvent[] }).__RIG_STUDIO_PROJECT_TRACE__ = this.getTrace();
    }
  }
}
