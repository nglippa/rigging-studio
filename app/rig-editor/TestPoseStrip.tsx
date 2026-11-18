"use client";

import { POSE_TESTS, type PoseTestId } from "@/src/tools/rig-editor/poseTests";

type Props = {
  readonly available: Readonly<Record<PoseTestId, boolean>>;
  readonly activeTest: PoseTestId | null;
  readonly posed: boolean;
  readonly onTest: (test: PoseTestId | null) => void;
  readonly onReset: () => void;
  readonly onFix: () => void;
  readonly onNext: () => void;
};

/** Bottom strip of the Test stage: quick sweeps, reset, and the two honest exits. */
export function TestPoseStrip(props: Props) {
  return <div className="stage-strip test-pose-strip" aria-label="Pose tests">
    <div className="stage-strip-title"><strong>Pose test</strong><small>Drag any bone. The rig is not changed.</small></div>
    <div className="pose-tests" role="group" aria-label="Quick tests">
      {POSE_TESTS.map((test) => <button key={test.id} type="button" className={`strip-tool ${props.activeTest === test.id ? "is-active" : ""}`} aria-pressed={props.activeTest === test.id} disabled={!props.available[test.id]} title={props.available[test.id] ? test.hint : test.id === "equipment" ? "No equipment was cut for this character. Cut a weapon or shield in Parts to test it." : "This rig has no bones for this test"} onClick={() => props.onTest(props.activeTest === test.id ? null : test.id)}>{props.activeTest === test.id ? "■ " : "▶ "}{test.label}</button>)}
    </div>
    <button type="button" className="strip-tool" disabled={!props.posed && !props.activeTest} title="Return every bone to its rest pose  (0)" onClick={props.onReset}>Reset pose<kbd>0</kbd></button>
    <button type="button" className="strip-tool" title="Go back to Rig with the same bone selected  (2)" onClick={props.onFix}>Fix in Rig</button>
    <button type="button" className="stage-next-action" title="The rig behaves. Start animating  (4)" onClick={props.onNext}>Looks right<span aria-hidden="true">→</span></button>
  </div>;
}
