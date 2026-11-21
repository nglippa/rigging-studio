"use client";

import type { RigFacing } from "@/src/rigging/motion/rigMotion";
import type { RigDefinition } from "@/src/rigging/schema/types";
import { POSE_TESTS, type PoseTestId } from "@/src/tools/rig-editor/poseTests";
import type { ChainReview, RigChainId } from "@/src/tools/rig-editor/rigReview";
import { useDetectedFacing } from "./RigNotices";

const JOINT_GROUPS: readonly { readonly label: string; readonly chains: readonly RigChainId[] }[] = [
  { label: "Body and head", chains: ["torso", "other"] },
  { label: "Arms", chains: ["left-arm", "right-arm"] },
  { label: "Legs", chains: ["left-leg", "right-leg"] },
  { label: "Equipment", chains: ["equipment"] },
];

const POSE_WORDS: Readonly<Record<PoseTestId, string>> = { arm: "Swing arms", leg: "Swing legs", full: "Every joint", equipment: "Equipment" };

/**
 * The Rig step's guided panel: which way the character faces (asked once, here only), each body region's joints OK or
 * how many need a look, quick pose tests that play on the stage without changing the rig, and the way into the full
 * rig editor.
 */
export function RigGuidedPanel(props: {
  readonly rig: RigDefinition;
  readonly review: readonly ChainReview[];
  readonly available: Readonly<Record<PoseTestId, boolean>>;
  readonly activeTest: PoseTestId | null;
  readonly posed: boolean;
  readonly problems: number;
  readonly onFacing: (facing: RigFacing) => void;
  readonly onChain: (id: RigChainId) => void;
  readonly onTest: (id: PoseTestId | null) => void;
  readonly onRest: () => void;
  readonly onProblems: () => void;
  readonly onExpand: () => void;
}) {
  const detected = useDetectedFacing(props.rig);
  const declared = props.rig.metadata.facing === "left" || props.rig.metadata.facing === "right" || props.rig.metadata.facing === "front" ? props.rig.metadata.facing : null;
  const facing = declared ?? detected.facing;
  const groups = JOINT_GROUPS.map((group) => {
    const chains = props.review.filter((chain) => group.chains.includes(chain.id));
    const flagged = chains.flatMap((chain) => chain.joints.filter((joint) => joint.problem).map(() => chain.id));
    return { ...group, chains, flagged };
  }).filter((group) => group.chains.some((chain) => chain.joints.length));
  return <>
    <p className="panel-label">Facing</p>
    <div className="seg" role="group" aria-label="Which way the character faces">
      {(["left", "front", "right"] as const).map((option) => <button key={option} type="button" aria-pressed={facing === option} title={declared ? undefined : option === detected.facing ? "Detected from the art; click to confirm" : undefined} onClick={() => props.onFacing(option)}>{option === "left" ? "Left" : option === "right" ? "Right" : "Front"}</button>)}
    </div>
    <p className="panel-note">{declared ? "Walk, run and the other clips move toward it." : detected.unsure ? "Not sure from the art. Pick the way it faces." : "Detected from the art."}</p>

    <p className="panel-label">Joints</p>
    {groups.map((group) => <button key={group.label} type="button" className="panel-row" title={group.flagged.length ? `Open the ${group.label.toLowerCase()} joints that need a look` : `Open the ${group.label.toLowerCase()} joints`} onClick={() => props.onChain(group.flagged[0] ?? group.chains[0].id)}>
      <span>{group.label}</span><span className={group.flagged.length ? "is-warn" : "is-ok"}>{group.flagged.length ? `${group.flagged.length} to check` : "OK"}</span>
    </button>)}
    {props.problems > 0 && <button type="button" className="panel-row" onClick={props.onProblems}><span>Rig problems</span><span className="is-warn">{props.problems}</span></button>}

    <p className="panel-label">Try a pose</p>
    <div className="pose-grid">
      {POSE_TESTS.map((test) => <button key={test.id} type="button" className="panel-button" aria-pressed={props.activeTest === test.id} disabled={!props.available[test.id]} title={props.available[test.id] ? `${test.hint}. The rig is not changed.` : "This character has nothing to swing for this test"} onClick={() => props.onTest(props.activeTest === test.id ? null : test.id)}>{POSE_WORDS[test.id]}</button>)}
      <button type="button" className="panel-button" disabled={!props.activeTest && !props.posed} title={props.activeTest || props.posed ? "Back to the rest pose" : "Already at rest"} onClick={props.onRest}>Rest</button>
    </div>

    <button type="button" className="panel-link" onClick={props.onExpand}>Edit bones manually →</button>
  </>;
}
