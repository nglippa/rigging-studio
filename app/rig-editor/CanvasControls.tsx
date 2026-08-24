"use client";

type Props = {
  readonly tool: "select" | "pan";
  readonly onTool: (tool: "select" | "pan") => void;
  readonly showBones: boolean;
  readonly showGrid: boolean;
  readonly showBounds: boolean;
  readonly snapToGrid: boolean;
  readonly wholePixelSnap: boolean;
  readonly rotationSnap: boolean;
  readonly onShowBones: () => void;
  readonly onShowGrid: () => void;
  readonly onShowBounds: () => void;
  readonly onSnapToGrid: () => void;
  readonly onWholePixelSnap: () => void;
  readonly onRotationSnap: () => void;
  readonly onFit: () => void;
};

function Toggle({ label, checked, onChange }: { readonly label: string; readonly checked: boolean; readonly onChange: () => void }) {
  return <button type="button" className={checked ? "is-on" : ""} aria-pressed={checked} onClick={onChange}><i /> <span>{label}</span><b>{checked ? "On" : "Off"}</b></button>;
}

export function CanvasControls(props: Props) {
  return <div className="canvas-controls" aria-label="Canvas controls">
    <div className="canvas-tool-group"><button type="button" className={props.tool === "select" ? "is-active" : ""} onClick={() => props.onTool("select")} aria-pressed={props.tool === "select"}>⌁ <span>Select</span></button><button type="button" className={props.tool === "pan" ? "is-active" : ""} onClick={() => props.onTool("pan")} aria-pressed={props.tool === "pan"}>✥ <span>Pan</span></button></div>
    <details className="canvas-popover" data-dismissible-menu><summary>View <i>⌄</i></summary><div><Toggle label="Bones & pivots" checked={props.showBones} onChange={props.onShowBones} /><Toggle label="Grid" checked={props.showGrid} onChange={props.onShowGrid} /><Toggle label="Part bounds" checked={props.showBounds} onChange={props.onShowBounds} /></div></details>
    <details className="canvas-popover" data-dismissible-menu><summary>Snap <i>⌄</i></summary><div><Toggle label="Pixel snap" checked={props.wholePixelSnap} onChange={props.onWholePixelSnap} /><Toggle label="Grid snap" checked={props.snapToGrid} onChange={props.onSnapToGrid} /><Toggle label="Angle snap · 15°" checked={props.rotationSnap} onChange={props.onRotationSnap} /></div></details>
    <button type="button" className="canvas-fit" onClick={props.onFit} title="Fit character (F)">⌗ <span>Fit</span></button>
  </div>;
}
