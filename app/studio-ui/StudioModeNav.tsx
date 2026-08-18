"use client";

export type StudioMode = "prepare" | "setup" | "animate";

export function StudioModeNav({ active, onSelect }: { readonly active: StudioMode; readonly onSelect: (mode: StudioMode) => void }) {
  return <nav className="studio-mode-nav" aria-label="Workspace mode">
    {(["prepare", "setup", "animate"] as const).map((mode, index) => <button key={mode} type="button" className={active === mode ? "is-active" : ""} data-mode={mode} aria-current={active === mode ? "page" : undefined} onClick={() => onSelect(mode)}><kbd>{index + 1}</kbd><span>{mode}</span></button>)}
  </nav>;
}
