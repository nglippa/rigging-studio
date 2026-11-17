"use client";

export type StudioMode = "prepare" | "setup" | "test" | "animate";
export type StageStatus = "done" | "todo" | "attention";
export type StageStatuses = Readonly<Partial<Record<StudioMode, StageStatus>>>;

export const STUDIO_STAGES: readonly { readonly mode: StudioMode; readonly label: string; readonly meaning: string }[] = [
  { mode: "prepare", label: "Parts", meaning: "Define the pieces of your character that can move" },
  { mode: "setup", label: "Rig", meaning: "Connect those pieces with bones and pivots" },
  { mode: "test", label: "Test", meaning: "Pose the character and confirm the rig behaves" },
  { mode: "animate", label: "Animate", meaning: "Create and edit motion" },
];

const statusWord: Readonly<Record<StageStatus, string>> = { done: "done", todo: "not started", attention: "needs attention" };
const statusGlyph: Readonly<Record<StageStatus, string>> = { done: "✓", todo: "○", attention: "!" };

export function StudioModeNav({ active, statuses, onSelect }: { readonly active: StudioMode; readonly statuses?: StageStatuses; readonly onSelect: (mode: StudioMode) => void }) {
  return <nav className="studio-mode-nav" aria-label="Workflow stage">
    {STUDIO_STAGES.map(({ mode, label, meaning }, index) => {
      const current = active === mode;
      const status: StageStatus = statuses?.[mode] ?? "todo";
      return <button key={mode} type="button" className={current ? "is-active" : status === "done" ? "is-complete" : status === "attention" ? "needs-attention" : ""} data-mode={mode} data-status={current ? "current" : status} data-ux-role="navigation" aria-current={current ? "step" : undefined} aria-label={`${label}, ${current ? "current stage" : statusWord[status]}`} title={`${label} — ${meaning}  (${index + 1})`} onClick={() => onSelect(mode)}><i aria-hidden="true">{current ? "●" : statusGlyph[status]}</i><span>{label}</span></button>;
    })}
  </nav>;
}
