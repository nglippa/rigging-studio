"use client";

export type StudioMode = "prepare" | "setup" | "animate";

export function StudioModeNav({ active, onSelect }: { readonly active: StudioMode; readonly onSelect: (mode: StudioMode) => void }) {
  const activeIndex = (["prepare", "setup", "animate"] as const).indexOf(active);
  return <nav className="studio-mode-nav" aria-label="Workspace mode">
    {(["prepare", "setup", "animate"] as const).map((mode, index) => <button key={mode} type="button" className={active === mode ? "is-active" : index < activeIndex ? "is-complete" : ""} data-mode={mode} data-ux-role="navigation" aria-current={active === mode ? "step" : undefined} aria-label={`${index + 1}. ${mode}${index < activeIndex ? ", complete" : active === mode ? ", current stage" : ""}`} onClick={() => onSelect(mode)}><i aria-hidden="true">{index < activeIndex ? "✓" : index + 1}</i><span>{mode}</span></button>)}
  </nav>;
}
