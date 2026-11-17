"use client";

import type { AnimatedProperty, AnimationDefinition, Easing, Keyframe } from "@/src/rigging/schema/types";
import { EASING_TYPES } from "@/src/rigging/schema/types";
import type { KeyframeSelection } from "@/src/tools/rig-editor/animation/types";
import { humanizeTechnicalId } from "@/app/studio-ui/humanize";

type Props = {
  readonly animation: AnimationDefinition;
  readonly selections: readonly KeyframeSelection[];
  readonly fps: number;
  readonly onChange: (selection: KeyframeSelection, patch: Partial<Keyframe>) => void;
};

export const PROPERTY_LABELS: Readonly<Record<AnimatedProperty, string>> = { x: "Position X", y: "Position Y", rotation: "Rotation", scaleX: "Scale X", scaleY: "Scale Y" };
const PROPERTY_UNITS: Readonly<Record<AnimatedProperty, string>> = { x: "px", y: "px", rotation: "°", scaleX: "×", scaleY: "×" };
const EASING_LABELS: Readonly<Record<Easing, string>> = { linear: "Linear", easeIn: "Ease in", easeOut: "Ease out", easeInOut: "Ease in and out", stepped: "Stepped (hold)" };

/** One selected keyframe, stated as what object, what property, what frame, what value. */
export function AnimationInspector({ animation, selections, fps, onChange }: Props) {
  const selection = selections.length === 1 ? selections[0] : null;
  const track = selection ? animation.tracks.find((candidate) => candidate.boneId === selection.boneId && candidate.property === selection.property) : null;
  const frameIndex = selection && track ? track.keyframes.findIndex((frame) => Math.abs(frame.time - selection.time) <= .0001) : -1;
  const frame = frameIndex >= 0 ? track?.keyframes[frameIndex] : null;
  if (!selection || !track || !frame) return <div className="animation-inspector-empty"><strong>{selections.length ? `${selections.length} keys selected` : "No key selected"}</strong><p>{selections.length ? "Drag to move them together, or press Delete to remove them." : "Click a diamond in the timeline to edit that keyframe."}</p></div>;
  const previous = track.keyframes[frameIndex - 1];
  const next = track.keyframes[frameIndex + 1];
  const unit = PROPERTY_UNITS[selection.property];
  return <div className="animation-inspector">
    <header className="inspector-heading" title={`${selection.boneId} · ${selection.property}`}><span>Keyframe</span><strong>{humanizeTechnicalId(selection.boneId)}</strong></header>
    <dl className="keyframe-facts">
      <div><dt>Property</dt><dd>{PROPERTY_LABELS[selection.property]}</dd></div>
      <div><dt>Frame</dt><dd>{Math.round(frame.time * fps)}<small>{frame.time.toFixed(3)} s</small></dd></div>
    </dl>
    <fieldset>
      <NumberField label={`Value (${unit})`} value={frame.value} step={selection.property.startsWith("scale") ? .01 : .1} onCommit={(value) => onChange(selection, { value })} />
      <NumberField label="Time (s)" value={frame.time} step={.001} min={0} max={animation.duration} onCommit={(value) => onChange(selection, { time: value })} />
      <label className="inspector-field"><span>Easing</span><select value={frame.easing} onChange={(event) => onChange(selection, { easing: event.target.value as Easing })}>{EASING_TYPES.map((easing) => <option key={easing} value={easing}>{EASING_LABELS[easing]}</option>)}</select></label>
    </fieldset>
    <details className="inspector-advanced"><summary>Neighbouring keys</summary>
      <ReadField label="Previous" value={previous ? `${(frame.time - previous.time).toFixed(3)} s earlier · ${previous.value.toFixed(2)} ${unit}` : "None"} />
      <ReadField label="Next" value={next ? `${(next.time - frame.time).toFixed(3)} s later · ${next.value.toFixed(2)} ${unit}` : "None"} />
    </details>
  </div>;
}

function ReadField({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="inspector-field read-field"><span>{label}</span><output>{value}</output></div>;
}

function NumberField({ label, value, step, min, max, onCommit }: { readonly label: string; readonly value: number; readonly step: number; readonly min?: number; readonly max?: number; readonly onCommit: (value: number) => void }) {
  return <label className="inspector-field"><span>{label}</span><input key={value} type="number" defaultValue={Number(value.toFixed(5))} step={step} min={min} max={max} onBlur={(event) => { const next = Number(event.target.value); if (Number.isFinite(next) && next !== Number(value.toFixed(5))) onCommit(next); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}
