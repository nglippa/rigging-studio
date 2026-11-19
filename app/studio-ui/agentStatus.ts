import type { StudioSessionState } from "@/src/agent-control/session/StudioSession";

export type AgentStatusPresentation = {
  readonly state: "ready" | "bridge" | "no-tools" | "disconnected";
  readonly label: string;
  readonly ready: boolean;
};

export function presentAgentStatus(session: StudioSessionState): AgentStatusPresentation {
  if (session.mcpConnected && session.toolCount > 0) {
    return { state: "ready", label: `Agent · Ready · ${session.toolCount} tools`, ready: true };
  }
  if (session.mcpConnected) return { state: "no-tools", label: "AI agent · starting", ready: false };
  if (session.bridgeConnected) return { state: "bridge", label: "Studio connected", ready: false };
  return { state: "disconnected", label: "Studio offline · run npm run studio:up", ready: false };
}
