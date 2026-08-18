import type { RigDefinition } from "../../rigging/schema/types";

function freezeDeep(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  Object.freeze(value);
}

export function immutableRig(rig: RigDefinition): RigDefinition {
  const snapshot = structuredClone(rig);
  freezeDeep(snapshot);
  return snapshot;
}

export function rigsEqual(left: RigDefinition, right: RigDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
