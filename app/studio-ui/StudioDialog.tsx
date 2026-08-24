"use client";

import type { ReactNode } from "react";

export function StudioDialog({ open, title, description, children, confirmLabel, cancelLabel = "Cancel", danger = false, confirmDisabled = false, onConfirm, onCancel }: {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
  readonly confirmDisabled?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  if (!open) return null;
  return <div className="studio-dialog-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="studio-dialog" role="dialog" aria-modal="true" aria-labelledby="studio-dialog-title">
      <header><span>Confirm action</span><button type="button" aria-label="Close dialog" onClick={onCancel}>×</button></header>
      <div className="studio-dialog-body"><h2 id="studio-dialog-title">{title}</h2><p>{description}</p>{children}</div>
      <footer><button type="button" onClick={onCancel}>{cancelLabel}</button><button type="button" className={danger ? "danger" : "primary"} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</button></footer>
    </section>
  </div>;
}
