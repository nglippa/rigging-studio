/**
 * The guided flow's five steps: where each lives and whether it is open yet. The one source of truth for the step bar,
 * for routing a locked step, and for the reason a locked step shows.
 */
export type StepId = "create" | "parts" | "rig" | "animate" | "export";

export const STEPS: readonly { readonly id: StepId; readonly label: string; readonly href: string }[] = [
  { id: "create", label: "Create", href: "/create-character" },
  { id: "parts", label: "Parts", href: "/part-cutter" },
  { id: "rig", label: "Rig", href: "/?mode=setup" },
  { id: "animate", label: "Animate", href: "/?mode=animate" },
  { id: "export", label: "Export", href: "/?mode=export" },
];

/** What the open project has, which decides which steps are open. */
export type StepState = { readonly hasArt: boolean; readonly partsCut: boolean; readonly hasRig: boolean; readonly rigValid: boolean };

/** Each step's prerequisites, in order; the first one missing is the reason it is locked. */
const NEEDS: Readonly<Record<StepId, readonly (readonly [keyof StepState, string])[]>> = {
  create: [],
  parts: [["hasArt", "Choose art first"]],
  rig: [["hasArt", "Choose art first"], ["partsCut", "Cut the parts first"]],
  animate: [["hasArt", "Choose art first"], ["partsCut", "Cut the parts first"], ["hasRig", "Build the rig first"], ["rigValid", "Fix the rig problems first"]],
  export: [["hasArt", "Choose art first"], ["partsCut", "Cut the parts first"], ["hasRig", "Build the rig first"], ["rigValid", "Fix the rig problems first"]],
};

export function stepAvailability(state: StepState): Record<StepId, { available: boolean; reason?: string }> {
  return Object.fromEntries(STEPS.map(({ id }) => {
    const missing = NEEDS[id].find(([need]) => !state[need]);
    return [id, missing ? { available: false, reason: missing[1] } : { available: true }];
  })) as Record<StepId, { available: boolean; reason?: string }>;
}

/** The step a page address belongs to; the old Test stage is part of Rig. */
export function stepForLocation(pathname: string, mode: string | null): StepId {
  if (pathname.startsWith("/create-character")) return "create";
  if (pathname.startsWith("/part-cutter")) return "parts";
  if (mode === "animate") return "animate";
  if (mode === "export") return "export";
  return "rig";
}

/** The requested step if it is open, otherwise the furthest open step before it and the reason the request is locked. */
export function resolveStep(requested: StepId, state: StepState): { step: StepId; reason?: string } {
  const open = stepAvailability(state);
  if (open[requested].available) return { step: requested };
  const before = STEPS.slice(0, STEPS.findIndex((step) => step.id === requested)).filter((step) => open[step.id].available);
  return { step: before[before.length - 1]?.id ?? "create", reason: open[requested].reason };
}
