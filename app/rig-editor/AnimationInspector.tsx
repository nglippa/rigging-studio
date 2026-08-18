"use client";

import type { AnimationDefinition, Easing, Keyframe } from "@/src/rigging/schema/types";
import { EASING_TYPES } from "@/src/rigging/schema/types";
import type { KeyframeSelection } from "@/src/tools/rig-editor/animation/types";

type Props = {
  readonly animation: AnimationDefinition;
  readonly selections: readonly KeyframeSelection[];
  readonly onChange: (selection: KeyframeSelection, patch: Partial<Keyframe>) => void;
};

export function AnimationInspector({ animation, selections, onChange }: Props) {
  const selection = selections.length === 1 ? selections[0] : null;
  const track = selection ? animation.tracks.find((candidate) => candidate.boneId === selection.boneId && candidate.property === selection.property) : null;
  const frameIndex = selection && track ? track.keyframes.findIndex((frame) => Math.abs(frame.time - selection.time) <= .0001) : -1;
  const frame = frameIndex >= 0 ? track?.keyframes[frameIndex] : null;
  if (!selection || !track || !frame) return <div className="animation-inspector-empty"><strong>{selections.length ? `${selections.length} keys selected` : "No key selected"}</strong><p>Select one keyframe to edit its timing, value, and interpolation.</p></div>;
  const previous = track.keyframes[frameIndex - 1];
  const next = track.keyframes[frameIndex + 1];
  return <div className="animation-inspector">
    <header className="inspector-heading"><span>Keyframe</span><strong>{selection.boneId} · {selection.property}</strong></header>
    <fieldset>
      <ReadField label="Bone" value={selection.boneId} />
      <ReadField label="Property" value={selection.property} />
      <NumberField label="Time" value={frame.time} step={.001} min={0} max={animation.duration} onCommit={(value) => onChange(selection, { time: value })} />
      <NumberField label="Value" value={frame.value} step={selection.property.startsWith("scale") ? .01 : .1} onCommit={(value) => onChange(selection, { value })} />
      <label className="inspector-field"><span>Easing</span><select value={frame.easing} onChange={(event) => onChange(selection, { easing: event.target.value as Easing })}>{EASING_TYPES.map((easing) => <option key={easing}>{easing}</option>)}</select></label>
      <div className="inspector-subsection"><h3>Neighbors</h3>
        <ReadField label="Previous Δ" value={previous ? `${(frame.time - previous.time).toFixed(3)}s / ${(frame.value - previous.value).toFixed(3)}` : "—"} />
        <ReadField label="Next Δ" value={next ? `${(next.time - frame.time).toFixed(3)}s / ${(next.value - frame.value).toFixed(3)}` : "—"} />
      </div>
    </fieldset>
  </div>;
}

function ReadField({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="inspector-field read-field"><span>{label}</span><output>{value}</output></div>;
}

function NumberField({ label, value, step, min, max, onCommit }: { readonly label: string; readonly value: number; readonly step: number; readonly min?: number; readonly max?: number; readonly onCommit: (value: number) => void }) {
  return <label className="inspector-field"><span>{label}</span><input key={value} type="number" defaultValue={Number(value.toFixed(5))} step={step} min={min} max={max} onBlur={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onCommit(next); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}
