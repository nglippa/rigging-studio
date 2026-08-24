import type { PartCutterState } from "./schema";

export const PREPARE_WORKFLOW_STATES = ["SOURCE_READY", "GUIDE_READY", "CUTTING", "REVIEWING", "CUT_ACCEPTED"] as const;
export type PrepareWorkflowState = (typeof PREPARE_WORKFLOW_STATES)[number];

export type PreparePrimaryAction = "continue-to-cut" | "review-cut" | "accept-cut" | "continue-to-setup";

export function derivePrepareWorkflowState(state: Pick<PartCutterState, "mode" | "parts" | "anatomicalGuide" | "ownership" | "finalized">): PrepareWorkflowState {
  if (state.finalized || state.ownership?.reviewStatus === "accepted") return "CUT_ACCEPTED";
  if (state.ownership?.reviewStatus === "review" && state.parts.length > 0) return "REVIEWING";
  if (state.parts.length > 0) return "CUTTING";
  if (state.mode === "auto" && state.anatomicalGuide) return "GUIDE_READY";
  return "SOURCE_READY";
}

export function primaryActionForPrepare(state: PrepareWorkflowState): PreparePrimaryAction {
  switch (state) {
    case "SOURCE_READY":
    case "GUIDE_READY": return "continue-to-cut";
    case "CUTTING": return "review-cut";
    case "REVIEWING": return "accept-cut";
    case "CUT_ACCEPTED": return "continue-to-setup";
  }
}

export const prepareActionLabel = (action: PreparePrimaryAction, manual: boolean): string => ({
  "continue-to-cut": manual ? "Start Lasso Cut" : "Continue to Cut",
  "review-cut": manual ? "Review Manual Cut" : "Review Cut",
  "accept-cut": "Accept Reviewed Cut",
  "continue-to-setup": "Continue to Setup →",
})[action];
