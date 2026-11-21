"use client";
/* eslint-disable @next/next/no-img-element -- generated data/blob URLs and fixture images must remain provider-controlled */

import type { ReactNode } from "react";

export type ArtCandidate = { readonly id: string; readonly image: string; readonly width: number; readonly height: number; readonly rejected?: boolean };

/** Create's first view: what the character is, in the person's words, or their own art. */
export function DescribeCanvas({ description, onDescription, onUpload, disabled }: {
  readonly description: string; readonly onDescription: (value: string) => void; readonly onUpload: () => void; readonly disabled?: boolean;
}) {
  return <div className="create-describe">
    <label className="create-describe-box">
      <span className="sr-only">Describe your character</span>
      <textarea value={description} onChange={(event) => onDescription(event.target.value)} disabled={disabled} rows={6}
        placeholder={'Describe your character… e.g. "a goblin warrior with a short sword and a round blue shield"'} />
    </label>
    <p className="create-describe-or">or <button type="button" className="create-link" onClick={onUpload} disabled={disabled}>upload your own art</button></p>
  </div>;
}

/** Create's second view: the generated options to pick from, or the art already chosen. */
export function ChooseArt({ candidates, selectedId, onSelect, chosen }: {
  readonly candidates: readonly ArtCandidate[]; readonly selectedId: string | null; readonly onSelect: (id: string) => void;
  readonly chosen?: { readonly image: string; readonly width: number; readonly height: number } | null;
}) {
  if (!candidates.length && chosen) return <figure className="create-chosen">
    <img src={chosen.image} alt="The character's art" />
    <figcaption className="num">{chosen.width} × {chosen.height}</figcaption>
  </figure>;
  return <div className="create-candidates" role="radiogroup" aria-label="Generated art">
    {candidates.map((candidate, index) => <button key={candidate.id} type="button" role="radio" aria-checked={candidate.id === selectedId}
      className="create-candidate" disabled={candidate.rejected} title={candidate.rejected ? "Rejected" : `Option ${index + 1}`}
      onClick={() => onSelect(candidate.id)}>
      <img src={candidate.image} alt={`Option ${index + 1}`} />
      <span>Option {index + 1}</span>
    </button>)}
  </div>;
}

/** The panel beside Create's stage: the model, facing, and what to do with the current options. */
export function CreatePanel({ models, facing, onFacing, actions, onExpand }: {
  readonly models: ReactNode; readonly facing: "left" | "right" | undefined; readonly onFacing: (facing: "left" | "right" | undefined) => void;
  readonly actions?: ReactNode; readonly onExpand: () => void;
}) {
  return <>
    <p className="panel-label">Model · on the Mac Studio</p>
    {models}
    <p className="panel-label">Facing</p>
    <div className="seg" role="group" aria-label="Facing">
      <button type="button" aria-pressed={facing === "left"} onClick={() => onFacing("left")}>Left</button>
      <button type="button" aria-pressed={facing === undefined} onClick={() => onFacing(undefined)}>Any</button>
      <button type="button" aria-pressed={facing === "right"} onClick={() => onFacing("right")}>Right</button>
    </div>
    {actions}
    <button type="button" className="panel-link" onClick={onExpand}>Tune this model&apos;s settings · Add a model file →</button>
  </>;
}

export type ArtEntry = { readonly key: string; readonly image: string; readonly width: number; readonly height: number; readonly group: string; readonly label: string };

/**
 * Create's expanded view: every option and every earlier generation on the left (grouped by the description that made
 * them), the selected art in the centre (side by side with the current art when comparing, zoomable), and the model's
 * settings on the right. Rendered inside the shared ExpandedView by the workspace.
 */
export function CreateArtList({ entries, selectedKey, onSelect }: { readonly entries: readonly ArtEntry[]; readonly selectedKey: string | null; readonly onSelect: (key: string) => void }) {
  const groups = [...new Set(entries.map((entry) => entry.group))];
  return <>
    <div className="ex-head"><strong>Art</strong><span className="num">{entries.length}</span></div>
    {!entries.length && <p className="panel-note ex-empty">Nothing generated yet.</p>}
    {groups.map((group) => <div key={group}>
      <div className="ex-group"><span title={group}>{group.length > 30 ? `${group.slice(0, 30)}…` : group}</span></div>
      {entries.filter((entry) => entry.group === group).map((entry) => <button key={entry.key} type="button" className="ex-item" aria-pressed={entry.key === selectedKey} onClick={() => onSelect(entry.key)}>
        <img className="ex-thumb" src={entry.image} alt="" />{entry.label}</button>)}
    </div>)}
  </>;
}

export function CreateArtView({ selected, current, compare, zoom }: { readonly selected: ArtEntry | null; readonly current: ArtEntry | null; readonly compare: boolean; readonly zoom: number }) {
  const shown = compare && current && selected && selected.key !== current.key ? [current, selected] : selected ? [selected] : current ? [current] : [];
  if (!shown.length) return <p className="panel-note">Generate to see the art here.</p>;
  return <div className="create-art-view" data-count={shown.length}>
    {shown.map((entry, index) => <figure key={entry.key}>
      <img src={entry.image} alt={entry.label} style={{ transform: `scale(${zoom})` }} />
      <figcaption>{shown.length > 1 ? (index === 0 ? "Current art" : entry.label) : entry.label} · <span className="num">{entry.width} × {entry.height}</span></figcaption>
    </figure>)}
  </div>;
}
