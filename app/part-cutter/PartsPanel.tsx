"use client";

export type PartGroup = {
  readonly id: string;
  readonly label: string;
  readonly status: "ready" | "check" | "missing";
  /** "Ready", "Check", or how many are still to cut. */
  readonly detail: string;
  /** The part to open in the expanded cutter when the row is clicked. */
  readonly partId: string | null;
};

/** Parts' guided panel: the character's parts by body region, each ready or not, with the way into the full cutter. */
export function PartsPanel({ groups, ready, total, onOpen, onExpand }: {
  readonly groups: readonly PartGroup[]; readonly ready: number; readonly total: number;
  readonly onOpen: (partId: string | null) => void; readonly onExpand: () => void;
}) {
  return <>
    <p className="panel-label">Parts · <span className="num">{ready}</span> of <span className="num">{total}</span> ready</p>
    {groups.map((group) => <button key={group.id} type="button" className="panel-row" onClick={() => onOpen(group.partId)}
      title={`Open ${group.label} in the cutter`}>
      <span>{group.label}</span>
      <span className={group.status === "ready" ? "is-ok" : group.status === "check" ? "is-warn" : "is-muted"}>{group.detail}</span>
    </button>)}
    <button type="button" className="panel-link" onClick={onExpand}>Edit parts manually →</button>
  </>;
}
