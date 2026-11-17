"use client";

import type { ChainReview, RigChainId } from "@/src/tools/rig-editor/rigReview";
import { humanizeTechnicalId } from "@/app/studio-ui/humanize";

type Props = {
  readonly chains: readonly ChainReview[];
  readonly activeChainId: RigChainId | null;
  readonly selectedBoneId: string | null;
  readonly testing: boolean;
  readonly blockingCount: number;
  readonly onChain: (id: RigChainId | null) => void;
  readonly onJoint: (boneId: string) => void;
  readonly onRotateTest: () => void;
  readonly onShowProblems: () => void;
  readonly onNext: () => void;
};

/** Bottom strip of the Rig stage: one chain at a time, each joint ✓ or a plain reason, one next action. */
export function RigReviewStrip(props: Props) {
  const active = props.chains.find((chain) => chain.id === props.activeChainId) ?? null;
  const flagged = props.chains.reduce((count, chain) => count + chain.joints.filter((joint) => joint.problem).length, 0);
  const ready = flagged === 0 && props.blockingCount === 0;
  return <div className={`stage-strip rig-review-strip ${ready ? "is-ready" : "needs-attention"}`} aria-label="Rig review">
    <div className="stage-strip-title"><strong>Rig review</strong><small>{ready ? "Every joint checks out" : `${flagged || props.blockingCount} to look at`}</small></div>
    <div className="review-chains" role="tablist" aria-label="Chains">
      {props.chains.map((chain) => <button key={chain.id} type="button" role="tab" aria-selected={chain.id === props.activeChainId} className={`${chain.id === props.activeChainId ? "is-active" : ""} ${chain.ok ? "is-ok" : "has-problem"}`} title={chain.ok ? `${chain.label}: every joint checks out` : `${chain.label}: needs attention`} onClick={() => props.onChain(chain.id === props.activeChainId ? null : chain.id)}><i aria-hidden="true">{chain.ok ? "✓" : "!"}</i>{chain.label}</button>)}
    </div>
    {active ? <div className="review-joints" aria-label={`${active.label} joints`}>
      {active.joints.map((joint) => <button key={joint.boneId} type="button" className={`${joint.problem ? "has-problem" : "is-ok"} ${joint.boneId === props.selectedBoneId ? "is-selected" : ""}`} title={joint.problem ? "Select this joint on the canvas" : humanizeTechnicalId(joint.boneId)} onClick={() => props.onJoint(joint.boneId)}><i aria-hidden="true">{joint.problem ? "!" : "✓"}</i>{joint.problem ? joint.reason : joint.joint ?? humanizeTechnicalId(joint.boneId)}</button>)}
      <button type="button" className={`strip-tool ${props.testing ? "is-active" : ""}`} aria-pressed={props.testing} title="Swing this chain to see how it bends. The rig is not changed." onClick={props.onRotateTest}>{props.testing ? "■ Stop" : "↻ Rotate test"}</button>
    </div> : <p className="stage-strip-hint">Pick a chain to check its joints. Drag a joint to move its pivot.</p>}
    {props.blockingCount > 0 ? <button type="button" className="stage-next-action is-blocked" onClick={props.onShowProblems}>Show {props.blockingCount} {props.blockingCount === 1 ? "problem" : "problems"}</button> : <button type="button" className="stage-next-action" title="Pose the character to confirm the rig works  (3)" onClick={props.onNext}>Test rig<span aria-hidden="true">→</span></button>}
  </div>;
}
