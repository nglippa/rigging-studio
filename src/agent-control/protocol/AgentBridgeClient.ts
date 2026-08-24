import type { RiggingCommandService } from "../commands/RiggingCommandService";
import { BRIDGE_PROTOCOL_VERSION, bridgeActivitySchema, bridgeRequestSchema, type BridgeResponse } from "./messages";
import { TOOL_NAMES } from "../validation/toolSchemas";
import { OptionalServiceRetryBackoff } from "../../local-services/retryBackoff";

export type AgentBridgeClientOptions = {
  readonly url?: string;
  readonly reconnectDelayMs?: number;
};

export class AgentBridgeClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private polling = false;
  private readonly url: string;
  private readonly httpUrl: string;
  private readonly reconnectDelayMs: number;
  private readonly reconnectBackoff = new OptionalServiceRetryBackoff();

  constructor(private readonly service: RiggingCommandService, options: AgentBridgeClientOptions = {}) {
    this.url = options.url ?? "ws://127.0.0.1:47831";
    this.httpUrl = this.url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1200;
  }

  start(): void { this.stopped = false; this.connect(); }

  stop(): void {
    this.stopped = true;
    this.polling = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.service.setBridgeConnected(false);
  }

  private connect(): void {
    if (this.stopped) return;
    if (typeof WebSocket === "undefined") { this.startPolling(); return; }
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectBackoff.reset();
      this.service.setBridgeConnected(true);
      this.polling = false;
      socket.send(JSON.stringify({ type: "hello", protocolVersion: BRIDGE_PROTOCOL_VERSION, sessionId: this.service.session.snapshot.sessionId, client: "rigging-studio-browser" }));
    });
    socket.addEventListener("message", (event) => { void this.onMessage(event.data); });
    socket.addEventListener("error", () => socket.close());
    socket.addEventListener("close", (event) => {
      if (this.socket === socket) this.socket = null;
      this.service.setBridgeConnected(false);
      if (event.code === 4001) { this.stopped = true; return; }
      if (!this.stopped) {
        const delay = Math.max(this.reconnectDelayMs, this.reconnectBackoff.nextDelay(false));
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    });
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "string") return;
    let input: unknown;
    try { input = JSON.parse(raw) as unknown; } catch { return; }
    const activity = bridgeActivitySchema.safeParse(input);
    if (activity.success) { this.service.recordExternalActivity(activity.data.eventType, activity.data.actor, activity.data.summary, activity.data.entityId); return; }
    const parsed = bridgeRequestSchema.safeParse(input);
    if (!parsed.success) return;
    this.service.setAgentCapabilities(TOOL_NAMES, false);
    const result = await this.service.executeTool(parsed.data.tool, parsed.data.input, parsed.data.actor);
    const response: BridgeResponse = { type: "response", protocolVersion: BRIDGE_PROTOCOL_VERSION, id: parsed.data.id, result };
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(response));
  }

  private startPolling(): void {
    if (this.stopped || this.polling || typeof fetch === "undefined") return;
    this.polling = true;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    try {
      await fetch(`${this.httpUrl}/hello`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "hello", protocolVersion: BRIDGE_PROTOCOL_VERSION, sessionId: this.service.session.snapshot.sessionId, client: "rigging-studio-browser" }) });
      while (!this.stopped && this.polling) {
        const response = await fetch(`${this.httpUrl}/poll?sessionId=${encodeURIComponent(this.service.session.snapshot.sessionId)}`, { cache: "no-store" });
        if (response.status === 200) {
          const input = await response.json() as unknown;
          const parsed = bridgeRequestSchema.safeParse(input);
          if (parsed.success) {
            this.service.setAgentCapabilities(TOOL_NAMES, false);
            const result = await this.service.executeTool(parsed.data.tool, parsed.data.input, parsed.data.actor);
            const bridgeResponse: BridgeResponse = { type: "response", protocolVersion: BRIDGE_PROTOCOL_VERSION, id: parsed.data.id, result };
            await fetch(`${this.httpUrl}/response`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bridgeResponse) });
          } else {
            const activity = bridgeActivitySchema.safeParse(input);
            if (activity.success) this.service.recordExternalActivity(activity.data.eventType, activity.data.actor, activity.data.summary, activity.data.entityId);
          }
        }
        this.service.setBridgeConnected(true);
        this.reconnectBackoff.reset();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    } catch (reason: unknown) {
      this.service.setAgentConnectionError(reason instanceof Error ? reason.message : "Agent bridge polling failed");
      this.service.setBridgeConnected(false);
      this.polling = false;
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.startPolling(), Math.max(this.reconnectDelayMs, this.reconnectBackoff.nextDelay(false)));
    }
  }
}
