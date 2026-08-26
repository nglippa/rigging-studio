import type { PartCutterState } from "./schema";

export const GUIDED_BENCHMARK_STORAGE_KEY = "rigging-studio:guided-manual-benchmark:v1";
export const GUIDED_BENCHMARK_IDLE_THRESHOLD_MS = 5_000;

export const GUIDED_BENCHMARK_COHORT = [
  ["warrior", "Guild Warrior"], ["starweaver", "Guild Starweaver Robed Mage"], ["paladin", "Guild Paladin Shield User"],
  ["rogue", "Guild Agile Rogue"], ["doomsmith", "Guild Doomsmith Heavy"], ["dwarf", "Guild Broad Dwarf"],
  ["warden", "Guild Warden Large"], ["npc-special-beorn", "Guild Beorn Nonstandard"],
  ["numenorian", "Guild Numenorian Equipment Overlap"], ["shadow-hunter", "Guild Shadow Hunter Worst Case"],
].map(([sourceId, name], index) => ({ index, sourceId, name, image: `/benchmark/guided-manual/${sourceId}.png`, width: 48, height: 48 })) as readonly GuidedBenchmarkSource[];

export type GuidedBenchmarkSource = { readonly index: number; readonly sourceId: string; readonly name: string; readonly image: string; readonly width: number; readonly height: number };
export type GuidedBenchmarkAction = "lasso" | "use-guide" | "use-component" | "replace" | "add" | "remove" | "skip" | "back" | "undo" | "redo" | "semantic-navigation" | "equipment" | "validation";
export type GuidedBenchmarkEvent = { readonly eventId: string; readonly action: GuidedBenchmarkAction; readonly at: number; readonly semantic?: string; readonly changedPixels?: number };
export type GuidedBenchmarkResult = {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly firstActionAt: number;
  readonly completedAt: number;
  readonly rawElapsedMs: number;
  readonly activeInteractionMs: number;
  readonly inactivityThresholdMs: number;
  readonly events: readonly GuidedBenchmarkEvent[];
  readonly metrics: {
    readonly significantInterventions: number;
    readonly lassoCount: number;
    readonly useGuideCount: number;
    readonly useComponentCount: number;
    readonly replaceCount: number;
    readonly addCount: number;
    readonly removeCount: number;
    readonly skipCount: number;
    readonly backCount: number;
    readonly undoRedoCount: number;
    readonly semanticNavigationActions: number;
    readonly equipmentAssignments: number;
  };
  readonly productionReady: boolean;
  readonly prepareState?: PartCutterState;
  readonly truthAvailable: true;
  readonly qualityStatus: "pending-source-backed-evaluation";
  readonly riggabilityStatus: "pending-frozen-checker";
};
export type GuidedBenchmarkRun = {
  readonly benchmarkVersion: 1;
  readonly cohortSize: 10;
  readonly currentIndex: number;
  readonly activeSourceId: string | null;
  readonly activeEvents: readonly GuidedBenchmarkEvent[];
  readonly results: readonly GuidedBenchmarkResult[];
  readonly truthVisible: boolean;
};

export const createGuidedBenchmarkRun = (): GuidedBenchmarkRun => ({ benchmarkVersion: 1, cohortSize: 10, currentIndex: 0, activeSourceId: null, activeEvents: [], results: [], truthVisible: false });

export function startGuidedBenchmarkCharacter(run: GuidedBenchmarkRun, sourceId: string): GuidedBenchmarkRun {
  if (run.results.some((result) => result.sourceId === sourceId)) throw new Error(`${sourceId} already has a recorded result`);
  return { ...run, activeSourceId: sourceId, activeEvents: [], truthVisible: false };
}

export function recordGuidedBenchmarkEvent(run: GuidedBenchmarkRun, event: GuidedBenchmarkEvent): GuidedBenchmarkRun {
  if (!run.activeSourceId) throw new Error("Start Character before recording workflow actions");
  if (run.activeEvents.some((candidate) => candidate.eventId === event.eventId)) return run;
  const activeEvents = [...run.activeEvents, event].sort((left, right) => left.at - right.at || left.eventId.localeCompare(right.eventId));
  return { ...run, activeEvents };
}

export function activeInteractionTime(events: readonly GuidedBenchmarkEvent[], completedAt: number, thresholdMs = GUIDED_BENCHMARK_IDLE_THRESHOLD_MS): number {
  if (!events.length) return 0;
  const ordered = [...events].sort((left, right) => left.at - right.at || left.eventId.localeCompare(right.eventId));
  let active = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]; const next = ordered[index + 1]?.at ?? completedAt;
    active += Math.max(0, Math.min(thresholdMs, next - current.at));
  }
  return active;
}

export function finishGuidedBenchmarkCharacter(run: GuidedBenchmarkRun, completedAt: number, productionReady: boolean, prepareState?: PartCutterState): GuidedBenchmarkRun {
  if (!run.activeSourceId) throw new Error("No active character");
  if (!run.activeEvents.length) throw new Error("A human interaction is required before completion");
  const source = GUIDED_BENCHMARK_COHORT.find((candidate) => candidate.sourceId === run.activeSourceId);
  if (!source) throw new Error(`Unknown benchmark source ${run.activeSourceId}`);
  const firstActionAt = Math.min(...run.activeEvents.map((event) => event.at));
  const counts = guidedBenchmarkCounts(run.activeEvents);
  const result: GuidedBenchmarkResult = {
    sourceId: source.sourceId, sourceName: source.name, firstActionAt, completedAt,
    rawElapsedMs: Math.max(0, completedAt - firstActionAt),
    activeInteractionMs: activeInteractionTime(run.activeEvents, completedAt),
    inactivityThresholdMs: GUIDED_BENCHMARK_IDLE_THRESHOLD_MS,
    events: [...run.activeEvents],
    metrics: {
      significantInterventions: counts["use-guide"] + counts["use-component"] + counts.add + counts.remove + counts.skip + counts.back + counts.undo + counts.redo,
      lassoCount: counts.lasso, useGuideCount: counts["use-guide"], useComponentCount: counts["use-component"], replaceCount: counts.replace,
      addCount: counts.add, removeCount: counts.remove, skipCount: counts.skip, backCount: counts.back, undoRedoCount: counts.undo + counts.redo,
      semanticNavigationActions: counts["semantic-navigation"], equipmentAssignments: counts.equipment,
    },
    productionReady, ...(prepareState ? { prepareState } : {}), truthAvailable: true,
    qualityStatus: "pending-source-backed-evaluation", riggabilityStatus: "pending-frozen-checker",
  };
  return { ...run, activeSourceId: null, activeEvents: [], results: [...run.results, result], truthVisible: true };
}

export function nextGuidedBenchmarkCharacter(run: GuidedBenchmarkRun): GuidedBenchmarkRun {
  if (run.activeSourceId) throw new Error("Finish the active character before advancing");
  return { ...run, currentIndex: Math.min(GUIDED_BENCHMARK_COHORT.length, run.currentIndex + 1), truthVisible: false };
}

export function guidedBenchmarkCounts(events: readonly GuidedBenchmarkEvent[]): Readonly<Record<GuidedBenchmarkAction, number>> {
  const actions: GuidedBenchmarkAction[] = ["lasso", "use-guide", "use-component", "replace", "add", "remove", "skip", "back", "undo", "redo", "semantic-navigation", "equipment", "validation"];
  return Object.fromEntries(actions.map((action) => [action, events.filter((event) => event.action === action).length])) as Readonly<Record<GuidedBenchmarkAction, number>>;
}

export function serializeGuidedBenchmarkRun(run: GuidedBenchmarkRun): string {
  return JSON.stringify({ ...run, activeEvents: [...run.activeEvents].sort((a, b) => a.at - b.at || a.eventId.localeCompare(b.eventId)), results: [...run.results].sort((a, b) => GUIDED_BENCHMARK_COHORT.findIndex((source) => source.sourceId === a.sourceId) - GUIDED_BENCHMARK_COHORT.findIndex((source) => source.sourceId === b.sourceId)) }, null, 2);
}

export function parseGuidedBenchmarkRun(value: string | null): GuidedBenchmarkRun {
  if (!value) return createGuidedBenchmarkRun();
  try {
    const parsed = JSON.parse(value) as GuidedBenchmarkRun;
    if (parsed.benchmarkVersion !== 1 || parsed.cohortSize !== 10 || !Array.isArray(parsed.results) || !Array.isArray(parsed.activeEvents)) return createGuidedBenchmarkRun();
    return parsed;
  } catch { return createGuidedBenchmarkRun(); }
}
