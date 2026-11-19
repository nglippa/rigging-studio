import { analyzeCoverage } from "./operations";
import type { PartCutterState } from "./schema";
import type { PartSemanticType } from "./semanticTaxonomy";

export const ANATOMY_PROFILES = ["humanoid", "digitigrade", "custom"] as const;
export type AnatomyProfile = (typeof ANATOMY_PROFILES)[number];
export type PrepareIssue = {
  readonly id: string;
  readonly severity: "error" | "warning";
  readonly objectId: string;
  readonly mode: "prepare";
  readonly message: string;
  readonly suggestedAction: string;
  readonly overrideable: boolean;
};
export type PrepareValidation = {
  readonly canBuild: boolean;
  readonly canOverride: boolean;
  readonly issues: readonly PrepareIssue[];
  readonly foregroundCoverage: number | null;
  readonly overlapRatio: number | null;
};

const HUMANOID_PARTS: readonly PartSemanticType[] = [
  "head", "torso",
  "leftUpperArm", "leftForearm", "leftHand", "rightUpperArm", "rightForearm", "rightHand",
  "leftThigh", "leftLowerLeg", "leftFoot", "rightThigh", "rightLowerLeg", "rightFoot",
];

export function validatePrepare(
  state: PartCutterState,
  options: { readonly foreground?: readonly number[]; readonly profile?: AnatomyProfile; readonly allowIncomplete?: boolean } = {},
): PrepareValidation {
  const issues: PrepareIssue[] = [];
  const add = (issue: Omit<PrepareIssue, "mode">): void => { issues.push({ ...issue, mode: "prepare" }); };
  if (!state.parts.length) add({ id: "prepare-no-parts", severity: "error", objectId: state.sourceImageId, message: "No accepted parts exist.", suggestedAction: "Cut or accept at least one source region.", overrideable: false });
  const pending = state.proposals.find((proposal) => proposal.status === "pending" && proposal.parts.length);
  if (pending) add({ id: "prepare-unresolved-proposal", severity: "error", objectId: pending.proposalId, message: `${pending.parts.length} proposed part${pending.parts.length === 1 ? " is" : "s are"} unresolved.`, suggestedAction: "Review, accept, or reject every unresolved part.", overrideable: true });

  state.parts.forEach((part) => {
    const expectedWidth = Math.max(1, Math.round(part.boundingBox.width)); const expectedHeight = Math.max(1, Math.round(part.boundingBox.height));
    if (part.mask.width !== expectedWidth || part.mask.height !== expectedHeight || part.mask.alpha.length !== part.mask.width * part.mask.height) add({ id: `prepare-mask-shape-${part.partId}`, severity: "error", objectId: part.partId, message: `${part.label} has a mask that does not match its bounds.`, suggestedAction: "Restore the proposal or recut this part.", overrideable: false });
    if (!part.mask.alpha.some((value) => value > 0)) add({ id: `prepare-empty-mask-${part.partId}`, severity: "error", objectId: part.partId, message: `${part.label} has an empty mask.`, suggestedAction: "Add pixels or remove the empty part.", overrideable: false });
    const right = part.boundingBox.x + part.boundingBox.width; const bottom = part.boundingBox.y + part.boundingBox.height;
    if (part.boundingBox.x < 0 || part.boundingBox.y < 0 || right > state.sourceCanvasSize.width || bottom > state.sourceCanvasSize.height) add({ id: `prepare-out-of-bounds-${part.partId}`, severity: "error", objectId: part.partId, message: `${part.label} extends outside the source canvas.`, suggestedAction: "Recut or contract the part bounds.", overrideable: false });
    if (!Number.isFinite(part.pivot.x) || !Number.isFinite(part.pivot.y)) add({ id: `prepare-invalid-pivot-${part.partId}`, severity: "error", objectId: part.partId, message: `${part.label} has a non-finite pivot.`, suggestedAction: "Reset the pivot in the Part inspector.", overrideable: false });
  });

  const profile = options.profile ?? "humanoid";
  if (profile !== "custom") {
    const semantics = new Set(state.parts.map((part) => part.semanticType));
    // A part the guide found hidden behind its twin (the far leg of a side view) is meant to have no art of its own: the
    // rig draws it from the near one. It is not missing.
    const hidden = new Set(hiddenGuideSemantics(state));
    HUMANOID_PARTS.filter((semantic) => !semantics.has(semantic) && !hidden.has(semantic)).forEach((semantic) => add({
      id: `prepare-missing-${semantic}`,
      severity: "error",
      objectId: semantic,
      message: `No ${plainPartName(semantic)} has been drawn.`,
      suggestedAction: `Draw it, or build without it if it is hidden in this pose (the far arm or leg of a side view, for example).`,
      overrideable: true,
    }));
  }

  const coverage = analyzeCoverage(state, options.foreground);
  const foregroundCoverage = coverage.foregroundPixels ? coverage.assignedPixels / coverage.foregroundPixels : null;
  const overlapRatio = coverage.foregroundPixels ? coverage.overlappingPixels / coverage.foregroundPixels : null;
  if (foregroundCoverage !== null && foregroundCoverage < .65) add({ id: "prepare-catastrophic-gaps", severity: "error", objectId: state.sourceImageId, message: `${Math.round((1 - foregroundCoverage) * 100)}% of detected foreground is unassigned.`, suggestedAction: "Use Find Missing Parts and repair the large uncovered regions.", overrideable: true });
  else if (foregroundCoverage !== null && foregroundCoverage < .9) add({ id: "prepare-visible-gaps", severity: "warning", objectId: state.sourceImageId, message: `${Math.round((1 - foregroundCoverage) * 100)}% of detected foreground is unassigned.`, suggestedAction: "Inspect the missing-region overlay before building.", overrideable: true });
  if (overlapRatio !== null && overlapRatio > .35) add({ id: "prepare-catastrophic-overlap", severity: "error", objectId: state.sourceImageId, message: `${Math.round(overlapRatio * 100)}% of detected foreground appears in multiple parts.`, suggestedAction: "Remove contamination from overlapping masks.", overrideable: true });
  else if (overlapRatio !== null && overlapRatio > .1) add({ id: "prepare-visible-overlap", severity: "warning", objectId: state.sourceImageId, message: `${Math.round(overlapRatio * 100)}% of detected foreground overlaps.`, suggestedAction: "Run Reassemble and inspect the overlap overlay.", overrideable: true });

  const blocking = issues.filter((issue) => issue.severity === "error");
  const hardBlocking = blocking.filter((issue) => !issue.overrideable);
  return {
    canBuild: hardBlocking.length === 0 && (Boolean(options.allowIncomplete) || blocking.length === 0),
    canOverride: blocking.length > 0 && hardBlocking.length === 0,
    issues,
    foregroundCoverage,
    overlapRatio,
  };
}

/** Parts the guide declared hidden behind others (no zone art), e.g. the far leg of a side view. */
export function hiddenGuideSemantics(state: Pick<PartCutterState, "anatomicalGuide"> & { readonly guidedManual?: PartCutterState["guidedManual"] }): readonly PartCutterState["parts"][number]["semanticType"][] {
  const fromGuide = (state.anatomicalGuide?.zones ?? []).filter((zone) => zone.optional && !zone.mask?.alpha.some(Boolean)).map((zone) => zone.semanticType);
  // An arm left out because the item it holds covers it is drawn from its twin too (guidedManual.hideCoveredArms).
  // ... and legs folded into a robe (guidedManual.foldLegsIntoSkirt): the feet below the hem carry them.
  const covered = (state.guidedManual?.skippedSemantics ?? []).filter((semantic) => /^(left|right)(UpperArm|Forearm|Hand|Thigh|LowerLeg)$/.test(semantic));
  return [...new Set([...fromGuide, ...covered])];
}

/** "leftUpperArm" → "left upper arm". */
function plainPartName(semantic: string): string { return semantic.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(); }
