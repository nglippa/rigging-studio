import type { AnimationAuthoringConstraints, FootContactInterval } from "../ai/animationContextBuilder";
import type { AnimationDefinition, RigDefinition } from "../schema/types";
import type { DiagnosticCapturePlan } from "./diagnosticCapturePlan";
import { VISUAL_ISSUE_CATEGORIES } from "./visualReviewSchema";

export type VisualReviewContext = {
  readonly animationGoal: string;
  readonly rig: {
    readonly schemaVersion: number;
    readonly bones: readonly { readonly id: string; readonly parentId: string | null; readonly length: number; readonly setup: { readonly x: number; readonly y: number; readonly rotation: number; readonly scaleX: number; readonly scaleY: number } }[];
  };
  readonly animation: AnimationDefinition;
  readonly groundPlaneY: number;
  readonly feet: { readonly leftFootBoneId: string | null; readonly rightFootBoneId: string | null; readonly contactIntervals: readonly FootContactInterval[] };
  readonly constraints: AnimationAuthoringConstraints;
  readonly knownWarnings: readonly string[];
  readonly capture: { readonly frameCount: number; readonly imageWidth: number; readonly imageHeight: number; readonly times: readonly number[]; readonly overlays: DiagnosticCapturePlan["overlays"] };
};

export const buildVisualReviewContext = (
  rig: RigDefinition,
  animation: AnimationDefinition,
  input: Omit<VisualReviewContext, "rig" | "animation">,
): VisualReviewContext => ({
  ...input,
  rig: { schemaVersion: rig.schemaVersion, bones: rig.bones.map((bone) => ({ id: bone.id, parentId: bone.parentId, length: bone.length, setup: { x: bone.x, y: bone.y, rotation: bone.rotation, scaleX: bone.scaleX, scaleY: bone.scaleY } })) },
  animation,
});

export const buildVisualReviewPrompt = (context: VisualReviewContext): string => `Review the attached diagnostic contact sheet for a modular 2D skeletal animation.

Return JSON only with this shape:
{"reviewVersion":1,"summary":"...","detectedIssues":[{"id":"issue-1","issueType":"foot sliding","severity":"medium","timeRange":{"start":0,"end":0.25},"affectedBones":[],"explanation":"...","suggestedCorrection":"...","confidence":0.8}],"correctedAnimationProposal":{"proposalVersion":1,"summary":"...","animation":{},"warnings":[],"assumptions":[],"affectedBones":[],"confidenceNotes":[]}}

Allowed issue categories:
${VISUAL_ISSUE_CATEGORIES.join(", ")}

For every issue, explicitly distinguish whether the visible cause is most likely a rig problem, animation problem, attachment problem, draw-order problem, or art limitation. Do not infer image content outside the supplied contact sheet. Do not rename bones or mutate the rig. Any corrected animation must use the existing animation schema, degrees, seconds, sorted keyframes, and known bone IDs. Preserve unaffected tracks. Report uncertainty honestly.

Context:
${JSON.stringify(context, null, 2)}`;
