"use client";

import { useEffect, useRef } from "react";

export type ContextMenuItem = { readonly label: string; readonly shortcut?: string; readonly disabled?: boolean; readonly onSelect: () => void };
type Props = { readonly title: string; readonly x: number; readonly y: number; readonly items: readonly ContextMenuItem[]; readonly onClose: () => void };

/** Short right-click menu for the thing under the cursor. Arrow keys move, Escape or a click away closes. */
export function CanvasContextMenu({ title, x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const away = (event: PointerEvent): void => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    };
    document.addEventListener("pointerdown", away, true); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", key, true); };
  }, [onClose]);
  const left = typeof window === "undefined" ? x : Math.min(x, window.innerWidth - 228);
  const top = typeof window === "undefined" ? y : Math.min(y, window.innerHeight - (items.length * 34 + 44));
  return <div ref={ref} className="canvas-context-menu" role="menu" aria-label={title} style={{ left, top }}>
    <header>{title}</header>
    {items.map((item) => <button key={item.label} type="button" role="menuitem" disabled={item.disabled} onClick={() => { onClose(); item.onSelect(); }}><span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>)}
  </div>;
}
