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
