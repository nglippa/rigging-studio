import type { StudioEvent } from "../events/StudioEventBus";

export type StudioValidationState = {
  readonly valid: boolean;
  readonly errorCount: number;
  readonly checkedAt: string;
};

export type StudioSessionState = {
  readonly sessionId: string;
  readonly activeProjectId: string | null;
  readonly activeStage: string | null;
  readonly selectedRigId: string | null;
  readonly selectedAnimationId: string | null;
  readonly selectedBoneId: string | null;
  readonly dirtyState: boolean;
  readonly validationState: StudioValidationState;
  readonly lastRenderId: string | null;
  readonly lastOperation: string | null;
  readonly warnings: readonly string[];
  readonly bridgeConnected: boolean;
  readonly mcpConnected: boolean;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly resourcesAvailable: boolean;
  readonly lastHandshake: string | null;
  readonly lastAgentError: string | null;
  readonly activity: readonly StudioEvent[];
};

type Listener = () => void;

const sessionId = (): string => typeof crypto !== "undefined" && "randomUUID" in crypto
  ? crypto.randomUUID()
  : `studio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class StudioSession {
  private listeners = new Set<Listener>();
  private state: StudioSessionState = {
    sessionId: sessionId(), activeProjectId: null, activeStage: null, selectedRigId: null, selectedAnimationId: null,
    selectedBoneId: null, dirtyState: false, validationState: { valid: true, errorCount: 0, checkedAt: new Date(0).toISOString() },
    lastRenderId: null, lastOperation: null, warnings: [], bridgeConnected: false, mcpConnected: false,
    toolCount: 0, toolNames: [], resourcesAvailable: false, lastHandshake: null, lastAgentError: null, activity: [],
  };

  get snapshot(): StudioSessionState { return this.state; }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: Partial<Omit<StudioSessionState, "sessionId">>): StudioSessionState {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
    return this.state;
  }

  record(event: StudioEvent): void {
    this.update({
      lastOperation: event.summary,
      activity: [event, ...this.state.activity].slice(0, 40),
    });
  }
}
