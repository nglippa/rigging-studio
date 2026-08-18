"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { RiggingCommandService } from "../commands/RiggingCommandService";
import { AgentBridgeClient } from "./AgentBridgeClient";
import type { StudioSessionState } from "../session/StudioSession";

export const useAgentBridge = (service: RiggingCommandService): StudioSessionState => {
  useEffect(() => {
    const client = new AgentBridgeClient(service);
    client.start();
    return () => client.stop();
  }, [service]);
  return useSyncExternalStore(
    (listener) => service.session.subscribe(listener),
    () => service.session.snapshot,
    () => service.session.snapshot,
  );
};

