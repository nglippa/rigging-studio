"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { StudioModeNav, type StudioMode } from "./StudioModeNav";
import { useDismissibleMenus } from "./useDismissibleMenus";
import { ProjectStorageMenu } from "./ProjectStorageMenu";

export type StudioConnection = {
  readonly id: string;
  readonly label: string;
  readonly state: "ready" | "degraded" | "offline" | "disabled";
  readonly title: string;
};

type Props = {
  readonly active: StudioMode;
  readonly projectName: string;
  readonly dirty?: boolean;
  readonly editingName?: boolean;
  readonly onEditingName?: (editing: boolean) => void;
  readonly onCommitName?: (name: string) => void;
  readonly onSelect: (mode: StudioMode) => void;
  readonly onCommand: () => void;
  readonly onUndo?: () => void;
  readonly onRedo?: () => void;
  readonly canUndo?: boolean;
  readonly canRedo?: boolean;
  readonly undoTitle?: string;
  readonly redoTitle?: string;
  readonly onExport?: () => void;
  readonly exportDisabled?: boolean;
  readonly validity?: { readonly count: number; readonly onOpen: () => void };
  readonly connections?: readonly StudioConnection[];
  readonly onConnections?: () => void;
  readonly focus?: { readonly active: boolean; readonly onToggle: () => void };
  readonly overflow?: ReactNode;
  readonly children?: ReactNode;
};

export function TopCommandRail(props: Props) {
  useDismissibleMenus();
  const readySystems = props.connections?.filter((item) => item.state === "ready").length ?? 0;
  const totalSystems = props.connections?.length ?? 0;
  const systemsState = readySystems === totalSystems ? "ready" : props.connections?.some((item) => item.state === "offline") ? "offline" : "degraded";
  return <header className="studio-command-rail" data-stage={props.active}>
    <div className="studio-brand-cluster">
      <Link href="/" className="studio-mark" aria-label="Rig Studio home"><b>RS</b><span>Rig Studio</span></Link>
      <div className="studio-project-identity">
        {props.editingName && props.onCommitName ? <input autoFocus defaultValue={props.projectName} aria-label="Character name" onBlur={(event) => { props.onCommitName?.(event.currentTarget.value); props.onEditingName?.(false); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") props.onEditingName?.(false); }} /> : <><span className={props.dirty ? "is-dirty" : ""}>{props.projectName}</span>{props.onEditingName && <button type="button" className="rail-icon-button" onClick={() => props.onEditingName?.(true)} aria-label="Rename character" title="Rename character">✎</button>}</>}
      </div>
      {(props.onUndo || props.onRedo) && <div className="rail-history" aria-label="History">
        <button type="button" className="rail-icon-button" onClick={props.onUndo} disabled={!props.canUndo} aria-label="Undo" title={props.undoTitle ?? "Undo"}>↶</button>
        <button type="button" className="rail-icon-button" onClick={props.onRedo} disabled={!props.canRedo} aria-label="Redo" title={props.redoTitle ?? "Redo"}>↷</button>
      </div>}
    </div>
    <StudioModeNav active={props.active} onSelect={props.onSelect} />
    <div className="studio-rail-actions">
      <ProjectStorageMenu />
      {props.validity && <button type="button" data-ux-role="status" className={`rail-validity ${props.validity.count ? "has-issues" : "is-valid"}`} onClick={props.validity.onOpen}><i />{props.validity.count ? `${props.validity.count} Issues` : "Valid"}</button>}
      {props.connections?.length ? <details className="connection-cluster" data-state={systemsState} data-dismissible-menu>
        <summary aria-label={`${readySystems} of ${totalSystems} systems ready`} title={props.connections.map((item) => `${item.label}: ${item.title}`).join("\n")}><i />{readySystems === totalSystems ? "Systems" : `${readySystems}/${totalSystems} Systems`}<b>⌄</b></summary>
        <div className="systems-popover"><header><strong>System status</strong><span>{readySystems}/{totalSystems} ready</span></header>{props.connections.map((item) => <div className="system-status-row" key={item.id} data-state={item.state}><i /><span><b>{item.label}</b><small>{item.title}</small></span><em>{item.state}</em></div>)}{props.children}<button type="button" className="systems-diagnostics" onClick={props.onConnections}>Open diagnostics</button></div>
      </details> : props.children}
      <button type="button" data-ux-role="tool" className="rail-icon-button command-search-button" onClick={props.onCommand} aria-label="Search commands" title="Search commands (⌘K)">⌕<kbd>⌘K</kbd></button>
      {props.onExport && <button type="button" data-ux-role="secondary-action" className="rail-export" onClick={props.onExport} disabled={props.exportDisabled}>Export</button>}
      {props.focus && <button type="button" className={`rail-icon-button ${props.focus.active ? "is-active" : ""}`} onClick={props.focus.onToggle} aria-label={props.focus.active ? "Exit focus mode" : "Enter focus mode"} title={props.focus.active ? "Exit focus mode" : "Focus canvas"}>{props.focus.active ? "↙" : "↗"}</button>}
      {props.overflow && <details className="rail-overflow" data-dismissible-menu><summary aria-label="More project actions">•••</summary><div>{props.overflow}</div></details>}
    </div>
  </header>;
}
