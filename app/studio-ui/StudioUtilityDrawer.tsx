"use client";

export type StudioProblem = { readonly id: string; readonly severity: "info" | "warning" | "error"; readonly title: string; readonly detail: string; readonly context: string; readonly onSelect?: () => void };
export type StudioActivity = { readonly id: string; readonly actor: string; readonly summary: string; readonly timestamp: string };

export function StudioUtilityDrawer({ open, tab, problems, activity, onTab, onClose }: { readonly open: boolean; readonly tab: "problems" | "activity"; readonly problems: readonly StudioProblem[]; readonly activity: readonly StudioActivity[]; readonly onTab: (tab: "problems" | "activity") => void; readonly onClose: () => void }) {
  if (!open) return null;
  return <section className="studio-utility-drawer" aria-label={tab === "problems" ? "Problems" : "Activity"}>
    <header><div><button type="button" className={tab === "problems" ? "is-active" : ""} onClick={() => onTab("problems")}>Problems <b>{problems.length}</b></button><button type="button" className={tab === "activity" ? "is-active" : ""} onClick={() => onTab("activity")}>Activity <b>{activity.length}</b></button></div><button type="button" aria-label="Close utility panel" onClick={onClose}>×</button></header>
    {tab === "problems" ? <div className="problem-list">{problems.length ? problems.map((problem) => <button type="button" key={problem.id} data-severity={problem.severity} onClick={problem.onSelect} disabled={!problem.onSelect}><i /><span><strong>{problem.title}</strong><small>{problem.detail}</small></span><em>{problem.context}</em></button>) : <div className="utility-empty"><strong>No problems detected</strong><span>The current rig passes structural validation.</span></div>}</div> : <div className="activity-list">{activity.length ? activity.map((event) => <article key={event.id}><i /><b>{event.actor}</b><span>{event.summary}</span><time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></article>) : <div className="utility-empty"><strong>No agent activity yet</strong><span>Human edits remain local and immediately undoable.</span></div>}</div>}
  </section>;
}
