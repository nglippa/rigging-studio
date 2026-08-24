"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getRiggingCommandService } from "@/src/agent-control";
import type { ProjectHydrationSnapshot } from "@/src/project-storage/projectLifecycle";

type Props = {
  readonly children: ReactNode;
};

const ProjectHydrationContext = createContext<ProjectHydrationSnapshot | null>(null);

export function useProjectHydrationIdentity(): ProjectHydrationSnapshot {
  const identity = useContext(ProjectHydrationContext);
  if (!identity) throw new Error("Project UI must be mounted inside ProjectHydrationBoundary");
  return identity;
}

/**
 * Project-global services stay mounted outside this boundary. The complete
 * project UI subtree is replaced by a neutral shell while a candidate snapshot
 * loads, then remounted under the committed project/session identity.
 */
export function ProjectHydrationBoundary({ children }: Props) {
  const service = useMemo(() => getRiggingCommandService(), []);
  const [identity, setIdentity] = useState(() => service.getProjectLifecycleSnapshot());

  useEffect(() => service.subscribeProjectLifecycle(() => setIdentity(service.getProjectLifecycleSnapshot())), [service]);

  if (identity.switching) {
    return <main
      className="project-hydration-shell"
      aria-busy="true"
      aria-live="polite"
      data-project-hydrating="true"
      data-target-project-id={identity.targetProjectId ?? ""}
      data-project-session-token={identity.projectSessionToken}
      data-hydration-token={identity.hydrationToken}
      data-requested-stage={identity.requestedStage ?? ""}
    >
      <div><span>Rig Studio</span><strong>Opening project…</strong><small>Validating an isolated project snapshot</small></div>
    </main>;
  }

  const key = `${identity.activeProjectId ?? "browser-draft"}:${identity.projectSessionToken}`;
  return <ProjectHydrationContext.Provider value={identity}><div
      key={key}
      className="project-hydration-root"
      data-project-id={identity.activeProjectId ?? "browser-draft"}
      data-canvas-project-id={identity.activeProjectId ?? "browser-draft"}
      data-timeline-project-id={identity.activeProjectId ?? "browser-draft"}
      data-inspector-project-id={identity.activeProjectId ?? "browser-draft"}
      data-project-session-token={identity.projectSessionToken}
      data-hydration-token={identity.hydrationToken}
      data-requested-stage={identity.requestedStage ?? ""}
    >{children}</div></ProjectHydrationContext.Provider>;
}
