"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type StudioCommand = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly group: string;
  readonly shortcut?: string;
  readonly keywords?: string;
  readonly disabled?: boolean;
  readonly run: () => void;
};

export function StudioCommandPalette({ commands, mode, selection, open, onOpenChange }: { readonly commands: readonly StudioCommand[]; readonly mode: string; readonly selection: string; readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return commands.filter((command) => !needle || `${command.label} ${command.description} ${command.group} ${command.keywords ?? ""}`.toLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); onOpenChange(!open); return; }
      if (!open) return;
      if (event.key === "Escape") { event.preventDefault(); onOpenChange(false); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => Math.max(0, Math.min(filtered.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))); return; }
      if (event.key === "Enter") { const command = filtered[activeIndex]; if (command && !command.disabled) { event.preventDefault(); command.run(); onOpenChange(false); } }
    };
    window.addEventListener("keydown", keyDown); return () => window.removeEventListener("keydown", keyDown);
  }, [activeIndex, filtered, onOpenChange, open]);

  useEffect(() => { if (!open) return; const frame = window.requestAnimationFrame(() => { setQuery(""); setActiveIndex(0); inputRef.current?.focus(); }); return () => window.cancelAnimationFrame(frame); }, [open]);
  if (!open) return null;
  const run = (command: StudioCommand) => { if (command.disabled) return; command.run(); onOpenChange(false); };
  return <div className="command-palette-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onOpenChange(false); }}>
    <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <header><span>Command palette</span><div><b>{mode}</b><i />{selection}</div><kbd>Esc</kbd></header>
      <label><span aria-hidden="true">⌘</span><input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} placeholder={`Search ${mode} actions`} aria-label="Search commands" /></label>
      <div className="command-results">{filtered.length ? filtered.map((command, index) => <button type="button" key={command.id} className={index === activeIndex ? "is-active" : ""} disabled={command.disabled} onPointerMove={() => setActiveIndex(index)} onClick={() => run(command)}><span><strong>{command.label}</strong><small>{command.description}</small></span><em>{command.group}</em>{command.shortcut && <kbd>{command.shortcut}</kbd>}</button>) : <p>No matching commands in this context.</p>}</div>
      <footer><span>↑↓ navigate</span><span>↵ run</span><span>Commands adapt to the current mode and selection.</span></footer>
    </section>
  </div>;
}
