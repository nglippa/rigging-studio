import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type ExecutionPlanEntry = {
  readonly index: number;
  readonly gateId: string;
  readonly sourceHash: string;
};

export type CanonicalExecutionPlan = {
  readonly schemaVersion: 1;
  readonly gateVersion: "v2";
  readonly manifestSha256: string;
  readonly gateSpecSha256: string;
  readonly entries: readonly ExecutionPlanEntry[];
};

export type ResolvedManifestSource = {
  readonly index: number;
  readonly stableGateId: string;
  readonly file: string;
  readonly filename?: string;
  readonly name: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly archetype: string;
  readonly topology: string;
  readonly equipment: string;
  readonly details: string;
  readonly [key: string]: unknown;
};

type FrozenManifest = {
  readonly gateVersion: "v2";
  readonly sourceCount: number;
  readonly sources: readonly ResolvedManifestSource[];
};

type FrozenGateSpec = {
  readonly gateVersion: "v2";
  readonly cohortSize: number;
  readonly manifestSha256: string;
  readonly executionOrder: readonly {
    readonly order: number;
    readonly index: number;
    readonly stableGateId: string;
    readonly name: string;
    readonly sha256: string;
  }[];
};

export type ResolvedExecutionPlan = {
  readonly plan: CanonicalExecutionPlan;
  readonly planJson: string;
  readonly planSha256: string;
  readonly plannedGateIds: readonly string[];
  readonly resolvedSources: readonly ResolvedManifestSource[];
};

const sha = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function requireExactlyTenUnique(values: readonly string[], label: string): void {
  if (values.length !== 10) throw new Error(`${label} must contain exactly 10 entries; found ${values.length}`);
  if (new Set(values).size !== 10) throw new Error(`${label} contains a duplicate entry`);
}

export async function resolveV2ExecutionPlan(options: {
  readonly artifactDirectory: string;
  readonly sourceDirectory: string;
}): Promise<ResolvedExecutionPlan> {
  const manifestPath = path.join(options.artifactDirectory, "frozen-cohort-manifest.json");
  const gateSpecPath = path.join(options.artifactDirectory, "final-confirmatory-gate-v2-spec.json");
  const [manifestBytes, gateSpecBytes] = await Promise.all([readFile(manifestPath), readFile(gateSpecPath)]);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as FrozenManifest;
  const gateSpec = JSON.parse(gateSpecBytes.toString("utf8")) as FrozenGateSpec;
  const manifestSha256 = sha(manifestBytes);
  const gateSpecSha256 = sha(gateSpecBytes);

  if (manifest.gateVersion !== "v2" || gateSpec.gateVersion !== "v2") throw new Error("Execution plan requires v2 manifest and gate spec");
  if (manifest.sourceCount !== 10 || manifest.sources.length !== 10) throw new Error("Frozen manifest population must be exactly 10");
  if (gateSpec.cohortSize !== 10 || gateSpec.executionOrder.length !== 10) throw new Error("Frozen gate-spec execution order must be exactly 10");
  if (gateSpec.manifestSha256 !== manifestSha256) throw new Error("Gate spec does not bind the exact frozen manifest bytes");

  requireExactlyTenUnique(manifest.sources.map((source) => source.stableGateId), "Manifest stable gate IDs");
  requireExactlyTenUnique(manifest.sources.map((source) => source.file), "Manifest source files");
  requireExactlyTenUnique(manifest.sources.map((source) => source.sha256), "Manifest source hashes");
  requireExactlyTenUnique(gateSpec.executionOrder.map((entry) => entry.stableGateId), "Gate-spec execution-order IDs");
  if (!gateSpec.executionOrder.every((entry, index) => entry.order === index + 1)) throw new Error("Gate-spec execution-order positions must be contiguous 1 through 10");

  const manifestIds = [...manifest.sources.map((source) => source.stableGateId)].sort();
  const orderedIds = [...gateSpec.executionOrder.map((entry) => entry.stableGateId)].sort();
  if (JSON.stringify(manifestIds) !== JSON.stringify(orderedIds)) throw new Error("Gate-spec order and manifest population differ (missing or extra cohort member)");

  const resolvedSources: ResolvedManifestSource[] = [];
  const entries: ExecutionPlanEntry[] = [];
  for (const [index, requested] of gateSpec.executionOrder.entries()) {
    const matches = manifest.sources.filter((source) => source.stableGateId === requested.stableGateId);
    if (matches.length !== 1) throw new Error(`Gate ID ${requested.stableGateId} resolved to ${matches.length} manifest entries`);
    const source = matches[0];
    if (source.name !== requested.name) throw new Error(`Gate ID ${requested.stableGateId} name does not exactly match the manifest`);
    if (source.index !== requested.index) throw new Error(`Gate ID ${requested.stableGateId} manifest index does not match the spec binding`);
    if (source.sha256 !== requested.sha256) throw new Error(`Gate ID ${requested.stableGateId} source hash differs between spec and manifest`);
    const actualSourceHash = sha(await readFile(path.join(options.sourceDirectory, source.file)));
    if (actualSourceHash !== source.sha256) throw new Error(`Gate ID ${requested.stableGateId} source file hash does not match the frozen manifest`);
    entries.push({ index: index + 1, gateId: source.stableGateId, sourceHash: source.sha256 });
    resolvedSources.push(source);
  }

  const plan: CanonicalExecutionPlan = { schemaVersion: 1, gateVersion: "v2", manifestSha256, gateSpecSha256, entries };
  const planJson = json(plan);
  return { plan, planJson, planSha256: sha(planJson), plannedGateIds: entries.map((entry) => entry.gateId), resolvedSources };
}

export async function verifyFrozenV2ExecutionPlan(options: {
  readonly artifactDirectory: string;
  readonly sourceDirectory: string;
}): Promise<ResolvedExecutionPlan> {
  const resolved = await resolveV2ExecutionPlan(options);
  const [frozenPlan, frozenHash] = await Promise.all([
    readFile(path.join(options.artifactDirectory, "execution-plan.json"), "utf8"),
    readFile(path.join(options.artifactDirectory, "execution-plan.sha256"), "utf8"),
  ]);
  if (frozenPlan !== resolved.planJson) throw new Error("Frozen execution-plan.json differs from the canonical spec/manifest resolution");
  if (frozenHash.trim() !== resolved.planSha256) throw new Error("Frozen execution-plan.sha256 differs from the canonical plan hash");
  return resolved;
}
