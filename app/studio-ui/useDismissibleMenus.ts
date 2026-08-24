"use client";

import { useEffect } from "react";

const menuSelector = "details[data-dismissible-menu]";

function closeMenu(menu: HTMLDetailsElement) {
  menu.removeAttribute("open");
  menu.querySelectorAll<HTMLDetailsElement>(`${menuSelector}[open]`).forEach((child) => child.removeAttribute("open"));
}

/** Coordinates the native details elements used as transient menus. */
export function useDismissibleMenus() {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      document.querySelectorAll<HTMLDetailsElement>(`${menuSelector}[open]`).forEach((menu) => {
        if (!menu.contains(target)) closeMenu(menu);
      });
    };

    const onToggle = (event: Event) => {
      const menu = event.target;
      if (!(menu instanceof HTMLDetailsElement) || !menu.matches(menuSelector)) return;
      if (!menu.open) {
        menu.querySelectorAll<HTMLDetailsElement>(`${menuSelector}[open]`).forEach(closeMenu);
        return;
      }
      document.querySelectorAll<HTMLDetailsElement>(`${menuSelector}[open]`).forEach((other) => {
        if (other !== menu && !other.contains(menu) && !menu.contains(other)) closeMenu(other);
      });
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const action = target.closest("button, a");
      if (!action || action.closest("summary")) return;
      document.querySelectorAll<HTMLDetailsElement>(`${menuSelector}[open]`).forEach((menu) => {
        if (menu.contains(action)) closeMenu(menu);
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const openMenus = [...document.querySelectorAll<HTMLDetailsElement>(`${menuSelector}[open]`)];
      if (!openMenus.length) return;
      openMenus.forEach(closeMenu);
      openMenus[0]?.querySelector<HTMLElement>(":scope > summary")?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("toggle", onToggle, true);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("toggle", onToggle, true);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
