"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ProjectStorageMenu } from "./ProjectStorageMenu";
import { STEPS, stepAvailability, type StepId, type StepState } from "./steps";
import { useDismissibleMenus } from "./useDismissibleMenus";

export type StepPrimary = {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** Shown as the button's tooltip and accessible description while it is disabled. */
  readonly disabledReason?: string;
  readonly busy?: boolean;
};

export type StepShellProps = {
  readonly step: StepId;
  readonly state: StepState;
  readonly projectName: string;
  readonly saved: "saved" | "unsaved" | "not-saved";
  /** When given, the project name can be clicked and renamed in place. */
  readonly onRename?: (name: string) => void;
  readonly onUndo?: () => void;
  readonly onRedo?: () => void;
  readonly canUndo?: boolean;
  readonly canRedo?: boolean;
  readonly stage: ReactNode;
  readonly panel: ReactNode;
  /** The one-line instruction; notices and errors go here too, never over the stage. */
  readonly instruction: ReactNode;
  readonly tone?: "info" | "warning" | "error";
  readonly primary: StepPrimary;
  /** Left of the instruction: Back, Reset, a secondary action. */
  readonly secondary?: ReactNode;
  /** The step's expert view; when present it replaces the stage and the panel. */
  readonly expanded?: ReactNode;
};

const SAVED_LABEL = { saved: "Saved", unsaved: "Unsaved changes", "not-saved": "Not saved yet" } as const;

function ProjectName({ name, onRename }: { readonly name: string; readonly onRename?: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (!onRename) return <strong>{name}</strong>;
  if (!editing) return <button type="button" className="step-project-name" title="Rename" onClick={() => setEditing(true)}><strong>{name}</strong></button>;
  const commit = (value: string) => { setEditing(false); if (value.trim() && value.trim() !== name) onRename(value.trim()); };
  return <input className="step-project-input" aria-label="Project name" defaultValue={name} autoFocus
    onBlur={(event) => commit(event.currentTarget.value)}
    onKeyDown={(event) => { if (event.key === "Enter") commit(event.currentTarget.value); if (event.key === "Escape") setEditing(false); }} />;
}

/** The five steps, each a button: done, current or ahead; a locked step is disabled and says why. */
export function StepNav({ step, state }: { readonly step: StepId; readonly state: StepState }) {
  const open = stepAvailability(state);
  const currentIndex = STEPS.findIndex((item) => item.id === step);
  return <nav className="step-nav" aria-label="Steps">
    {STEPS.map((item, index) => {
      const current = item.id === step; const lock = open[item.id];
      const done = index < currentIndex && lock.available;
      return <button key={item.id} type="button" className={current ? "is-current" : done ? "is-done" : ""}
        aria-current={current ? "step" : undefined} disabled={current || !lock.available}
        title={current ? "You are on this step" : lock.available ? undefined : lock.reason} aria-description={current ? "You are on this step" : lock.available ? undefined : lock.reason}
        onClick={() => { if (!current) window.location.assign(item.href); }}>
        <b aria-hidden="true">{done ? "✓" : index + 1}</b>{item.label}
      </button>;
    })}
  </nav>;
}

/**
 * The frame every step renders through (docs/superpowers/specs/2026-11-20-guided-studio-ui-design.md): the top bar with
 * the project and the step bar, the stage with a narrow panel, and the action bar with the step's main button centred.
 */
export function StepShell(props: StepShellProps) {
  // Menus and popovers anywhere in the step (the project menu, View and Snap) close on click-away and Escape.
  useDismissibleMenus();
  const { step, state, primary, expanded } = props;
  const label = STEPS.find((item) => item.id === step)?.label ?? "";
  return <div className={`step-shell${expanded ? " is-expanded" : ""}`} data-step={step}>
    <header className="step-top">
      <Link href="/create-character" className="step-mark" aria-label="Rig Studio home">RS</Link>
      <div className="step-project"><ProjectName name={props.projectName} onRename={props.onRename} /><small>{SAVED_LABEL[props.saved]}{expanded ? ` · ${label}, expanded` : ""}</small></div>
      <StepNav step={step} state={state} />
      <div className="step-tools">
        {props.onUndo && <button type="button" onClick={props.onUndo} disabled={!props.canUndo} title={props.canUndo ? "Undo" : "Nothing to undo"} aria-description={props.canUndo ? undefined : "Nothing to undo"}>↶ Undo</button>}
        {props.onRedo && <button type="button" onClick={props.onRedo} disabled={!props.canRedo} title={props.canRedo ? "Redo" : "Nothing to redo"} aria-description={props.canRedo ? undefined : "Nothing to redo"}>↷ Redo</button>}
        <ProjectStorageMenu projectName={props.projectName} dirty={props.saved === "unsaved"} />
      </div>
    </header>
    {expanded ?? <div className="step-body"><section className="step-stage" aria-label={`${label} stage`}>{props.stage}</section><aside className="step-panel" aria-label={`${label} options`}>{props.panel}</aside></div>}
    <footer className="step-bar">
      <div className="step-secondary">{props.secondary}</div>
      <p className={`step-instruction tone-${props.tone ?? "info"}`} role="status" aria-live="polite">{props.instruction}</p>
      <button type="button" className="step-primary" onClick={primary.onClick} disabled={primary.disabled || primary.busy}
        title={primary.disabled ? primary.disabledReason : undefined} aria-description={primary.disabled ? primary.disabledReason : undefined} aria-busy={primary.busy || undefined}>
        {primary.busy ? "Working…" : primary.label}
      </button>
    </footer>
  </div>;
}
