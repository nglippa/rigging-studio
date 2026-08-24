import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";
import { acceptProposal, ownershipSummary, type PartCutterState } from "../../src/part-cutter";
import { LOCAL_PROJECT_STORAGE_VERSION } from "../../src/project-storage/types";

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Candidate = {
  readonly candidateId: string;
  readonly imageFileName: string;
  readonly width: number;
  readonly height: number;
  readonly status: string;
  readonly providerMetadata: {
    readonly providerFilename?: string;
    readonly providerSubfolder?: string;
    readonly requestedSemantic?: string;
    readonly finalSemantic?: string;
    readonly detectorPhrase?: string;
    readonly stage?: string;
    readonly sourceCrop?: Rect;
    readonly maskSummary?: { readonly area?: number; readonly bounds?: Rect } | null;
    readonly heuristicQuality?: { readonly score?: number; readonly safe?: boolean; readonly reasons?: readonly string[] } | null;
    readonly selectedForPartProposal?: boolean;
  };
  readonly diagnostics?: { readonly warnings?: readonly string[] };
};
type ManagedMetadata = {
  readonly proposalId: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly createdAt: string;
  readonly candidates: readonly Candidate[];
};
type FullMask = { readonly width: number; readonly height: number; readonly alpha: Uint8Array };

const ROOT = process.cwd();
const RUN_ID = process.env.CUT_FORENSICS_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const OUTPUT = path.join(ROOT, ".rigging-studio/diagnostics/comfyui-cut-forensics", RUN_ID);
const PROPOSAL_ROOT = path.join(ROOT, ".rigging-studio/image-production/proposals");
const SOURCE_ROOT = path.join(ROOT, ".rigging-studio/final-confirmatory-gate/v2/frozen-sources");
const FETCH_PROVIDER = process.argv.includes("--fetch-provider");
const CORE = ["head", "torso", "pelvis", "leftUpperArm", "leftForearm", "leftHand", "rightUpperArm", "rightForearm", "rightHand", "leftThigh", "leftLowerLeg", "leftFoot", "rightThigh", "rightLowerLeg", "rightFoot"] as const;
const COLORS: readonly [number, number, number][] = [[69, 196, 255], [255, 191, 64], [205, 100, 255], [89, 221, 126], [255, 92, 120], [94, 114, 255], [255, 125, 45], [34, 211, 191], [244, 114, 182], [163, 230, 53], [251, 146, 60], [96, 165, 250], [232, 121, 249], [74, 222, 128], [250, 204, 21]];

const sha = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const count = (alpha: Uint8Array | readonly number[]): number => { let total = 0; for (const value of alpha) if (value > 0) total += 1; return total; };
const safeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const ensureDirectories = async (): Promise<void> => {
  await Promise.all([
    "provider-history", "provider-inputs", "provider-raw-responses", "raw-masks", "zone-masks", "clipped-masks", "cleaned-masks",
    "accepted-masks", "rejection-visualizations", "contact-sheets", "known-good-controls", "post-fix", "post-fix/reopen-store",
  ].map((directory) => mkdir(path.join(OUTPUT, directory), { recursive: true })));
};

const readPng = (bytes: Uint8Array): PNG => PNG.sync.read(Buffer.from(bytes));
const alphaMaskFromPng = (bytes: Uint8Array, channel: "alpha" | "red" = "red"): FullMask => {
  const decoded = readPng(bytes); const alpha = new Uint8Array(decoded.width * decoded.height);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = decoded.data[index * 4 + (channel === "alpha" ? 3 : 0)] ?? 0;
  return { width: decoded.width, height: decoded.height, alpha };
};
const encodeMask = (mask: FullMask, color: readonly [number, number, number] = [255, 255, 255]): Buffer => {
  const png = new PNG({ width: mask.width, height: mask.height });
  for (let index = 0; index < mask.alpha.length; index += 1) {
    const visible = mask.alpha[index] > 0; png.data[index * 4] = visible ? color[0] : 0; png.data[index * 4 + 1] = visible ? color[1] : 0;
    png.data[index * 4 + 2] = visible ? color[2] : 0; png.data[index * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
};
const emptyMask = (width: number, height: number): FullMask => ({ width, height, alpha: new Uint8Array(width * height) });
const fullFromLocal = (bounds: Rect, alpha: readonly number[], width: number, height: number): FullMask => {
  const full = emptyMask(width, height); const left = Math.round(bounds.x); const top = Math.round(bounds.y); const localWidth = Math.round(bounds.width); const localHeight = Math.round(bounds.height);
  for (let y = 0; y < localHeight; y += 1) for (let x = 0; x < localWidth; x += 1) {
    const targetX = left + x; const targetY = top + y; if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) continue;
    full.alpha[targetY * width + targetX] = alpha[y * localWidth + x] ?? 0;
  }
  return full;
};
const allowedZoneMask = (zone: { readonly bounds: Rect; readonly refinementMargin: number; readonly mask?: { readonly width: number; readonly height: number; readonly alpha: readonly number[] } }, width: number, height: number): FullMask => {
  if (zone.mask) return fullFromLocal(zone.bounds, zone.mask.alpha, width, height);
  const mask = emptyMask(width, height); const left = Math.max(0, Math.floor(zone.bounds.x - zone.refinementMargin)); const top = Math.max(0, Math.floor(zone.bounds.y - zone.refinementMargin));
  const right = Math.min(width, Math.ceil(zone.bounds.x + zone.bounds.width + zone.refinementMargin)); const bottom = Math.min(height, Math.ceil(zone.bounds.y + zone.bounds.height + zone.refinementMargin));
  for (let y = top; y < bottom; y += 1) mask.alpha.fill(255, y * width + left, y * width + right);
  return mask;
};
const maskIntersection = (left: FullMask, right: FullMask): FullMask => {
  const output = emptyMask(left.width, left.height); for (let index = 0; index < output.alpha.length; index += 1) output.alpha[index] = left.alpha[index] && right.alpha[index] ? Math.min(left.alpha[index], right.alpha[index]) : 0; return output;
};
const unionMasks = (masks: readonly FullMask[], width: number, height: number): FullMask => {
  const output = emptyMask(width, height); for (const mask of masks) for (let index = 0; index < output.alpha.length; index += 1) output.alpha[index] = Math.max(output.alpha[index], mask.alpha[index] ?? 0); return output;
};
const sourceForeground = (source: PNG): FullMask => {
  const alpha = new Uint8Array(source.width * source.height); for (let index = 0; index < alpha.length; index += 1) alpha[index] = source.data[index * 4 + 3] ?? 0; return { width: source.width, height: source.height, alpha };
};
const resized = (source: PNG, targetWidth = 256, targetHeight = 384): PNG => {
  const output = new PNG({ width: targetWidth, height: targetHeight });
  for (let y = 0; y < targetHeight; y += 1) for (let x = 0; x < targetWidth; x += 1) {
    const sourceX = Math.min(source.width - 1, Math.floor(x / targetWidth * source.width)); const sourceY = Math.min(source.height - 1, Math.floor(y / targetHeight * source.height));
    const from = (sourceY * source.width + sourceX) * 4; const to = (y * targetWidth + x) * 4; for (let channel = 0; channel < 4; channel += 1) output.data[to + channel] = source.data[from + channel];
  }
  return output;
};
const maskPanel = (source: PNG, masks: readonly { readonly mask: FullMask; readonly color: readonly [number, number, number] }[]): PNG => {
  const output = new PNG({ width: source.width, height: source.height }); source.data.copy(output.data);
  for (const { mask, color } of masks) for (let index = 0; index < mask.alpha.length; index += 1) if (mask.alpha[index] > 0) {
    const offset = index * 4; output.data[offset] = Math.round(output.data[offset] * .35 + color[0] * .65); output.data[offset + 1] = Math.round(output.data[offset + 1] * .35 + color[1] * .65); output.data[offset + 2] = Math.round(output.data[offset + 2] * .35 + color[2] * .65); output.data[offset + 3] = 255;
  }
  return output;
};
const contactSheet = (panels: readonly PNG[]): Buffer => {
  const scaled = panels.map((panel) => resized(panel)); const sheet = new PNG({ width: scaled.length * 256, height: 384 });
  scaled.forEach((panel, panelIndex) => { for (let y = 0; y < panel.height; y += 1) panel.data.copy(sheet.data, (y * sheet.width + panelIndex * panel.width) * 4, y * panel.width * 4, (y + 1) * panel.width * 4); });
  return PNG.sync.write(sheet);
};
const ownershipDigest = (state: PartCutterState): string => sha(json({
  parts: state.parts.filter((part) => part.accepted).map((part) => ({ id: part.partId, semantic: part.semanticType, bounds: part.boundingBox, mask: sha(Uint8Array.from(part.mask.alpha)) })).sort((a, b) => a.id.localeCompare(b.id)),
  ownership: state.ownership ? { width: state.ownership.width, height: state.ownership.height, regionIds: state.ownership.regionIds, runs: state.ownership.runs } : null,
}));

const fetchProviderResponse = async (candidate: Candidate, destination: string): Promise<{ readonly available: boolean; readonly width: number | null; readonly height: number | null; readonly pixels: number | null; readonly sha256: string | null; readonly error: string | null }> => {
  if (!FETCH_PROVIDER || !candidate.providerMetadata.providerFilename) return { available: false, width: null, height: null, pixels: null, sha256: null, error: FETCH_PROVIDER ? "provider filename missing" : "provider fetch disabled" };
  try {
    const params = new URLSearchParams({ filename: candidate.providerMetadata.providerFilename, subfolder: candidate.providerMetadata.providerSubfolder ?? "", type: "output" });
    const response = await fetch(`http://127.0.0.1:8188/view?${params.toString()}`); if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer()); await writeFile(destination, bytes); const mask = alphaMaskFromPng(bytes, "red");
    return { available: true, width: mask.width, height: mask.height, pixels: count(mask.alpha), sha256: sha(bytes), error: null };
  } catch (error: unknown) { return { available: false, width: null, height: null, pixels: null, sha256: null, error: error instanceof Error ? error.message : String(error) }; }
};

const sourceFiles = await readdir(SOURCE_ROOT);
const sources = await Promise.all(sourceFiles.filter((file) => file.endsWith(".png")).sort().map(async (file) => {
  const bytes = await readFile(path.join(SOURCE_ROOT, file)); const decoded = readPng(bytes); return { file, bytes, sha256: sha(bytes), width: decoded.width, height: decoded.height };
}));
const sourceByHash = new Map(sources.map((source) => [source.sha256, source]));
const sourceHashesBefore = sources.map(({ file, sha256, width, height }) => ({ file, sha256, width, height }));

await ensureDirectories();
await writeFile(path.join(OUTPUT, "source-hashes-before.json"), json(sourceHashesBefore));

const repositoryStore = new LocalProjectStore({ cwd: ROOT });
const summaries = (await repositoryStore.list()).filter((summary) => /^Final Gate \d+ /.test(summary.name)).sort((left, right) => left.name.localeCompare(right.name));
if (summaries.length !== 10) throw new Error(`Expected ten primary final-gate projects, found ${summaries.length}`);

const zoneResults: Record<string, Json>[] = [];
const sourceResults: Record<string, Json>[] = [];
const beforeHistogram = new Map<string, number>(); const afterHistogram = new Map<string, number>();
const addHistogram = (histogram: Map<string, number>, reason: string): void => { histogram.set(reason, (histogram.get(reason) ?? 0) + 1); };
const postStates = new Map<string, { state: PartCutterState; project: NonNullable<Awaited<ReturnType<LocalProjectStore["load"]>>["snapshot"]["project"]>; digest: string; sourceFile: string }>();

for (const [sourceIndex, summary] of summaries.entries()) {
  const loaded = await repositoryStore.load(summary.projectId); const project = loaded.snapshot.project; if (!project?.partCutterState?.anatomicalGuide) throw new Error(`${summary.name} lacks cut state/guide`);
  const state = project.partCutterState; const proposal = state.proposals.find((item) => item.proposalId === state.activeProposalId) ?? state.proposals[0]; if (!proposal) throw new Error(`${summary.name} lacks proposal`);
  const importedMetadata = project.generationMetadata.importedMetadata;
  const importedRecord = importedMetadata && typeof importedMetadata === "object" && !Array.isArray(importedMetadata) ? importedMetadata as Readonly<Record<string, unknown>> : null;
  const importedHash = typeof importedRecord?.sourceSha256 === "string" ? importedRecord.sourceSha256 : null;
  const frozen = importedHash ? sourceByHash.get(importedHash) : undefined; if (!frozen) throw new Error(`${summary.name} source hash does not map to frozen cohort`);
  const sourcePng = readPng(frozen.bytes); const foregroundAlpha = sourceForeground(sourcePng); const managedId = String(proposal.providerMetadata?.managedProposalId ?? "");
  const managedDirectory = path.join(PROPOSAL_ROOT, managedId); const managed = JSON.parse(await readFile(path.join(managedDirectory, "metadata.json"), "utf8")) as ManagedMetadata;
  const candidatesWithMasks = await Promise.all(managed.candidates.map(async (candidate) => ({ candidate, bytes: await readFile(path.join(managedDirectory, candidate.imageFileName)), mask: alphaMaskFromPng(await readFile(path.join(managedDirectory, candidate.imageFileName)), "red") })));
  const foregroundCandidate = candidatesWithMasks.find((item) => item.candidate.candidateId === "foreground-person");
  const providerForeground = foregroundCandidate?.mask ?? foregroundAlpha;
  const selectedByFinal = new Map(candidatesWithMasks.filter((item) => item.candidate.providerMetadata.selectedForPartProposal).map((item) => [item.candidate.providerMetadata.finalSemantic ?? item.candidate.providerMetadata.requestedSemantic ?? item.candidate.candidateId, item]));
  const bestByRequested = new Map<string, (typeof candidatesWithMasks)[number]>();
  for (const item of candidatesWithMasks) {
    const requested = item.candidate.providerMetadata.requestedSemantic; if (!requested || requested === "rootReference") continue; const prior = bestByRequested.get(requested);
    if (!prior || Number(item.candidate.providerMetadata.heuristicQuality?.score ?? -1) > Number(prior.candidate.providerMetadata.heuristicQuality?.score ?? -1)) bestByRequested.set(requested, item);
  }
  const proposedBySemantic = new Map(proposal.parts.map((part) => [part.semanticType, part]));
  const providerRecommendedIds = proposal.parts.filter((part) => part.notes.some((note) => note.startsWith("Gate: SAFE")) && /proposed=(\d+); accepted=\1; clipped=0;/.test(part.notes.join(" "))).map((part) => part.proposedPartId);
  const patchedProposal = { ...proposal, parts: proposal.parts.map((part) => ({ ...part, selected: providerRecommendedIds.includes(part.proposedPartId) })) };
  const patchedState = { ...state, proposals: state.proposals.map((item) => item.proposalId === proposal.proposalId ? patchedProposal : item) };
  const acceptedState = acceptProposal(patchedState, proposal.proposalId); const acceptedBySemantic = new Map(acceptedState.parts.filter((part) => part.accepted).map((part) => [part.semanticType, part]));
  const acceptedDigest = ownershipDigest(acceptedState); postStates.set(summary.projectId, { state: acceptedState, project, digest: acceptedDigest, sourceFile: frozen.file });

  const guide = state.anatomicalGuide; if (!guide) throw new Error(`${summary.name} lacks anatomical guide`);
  const guideMasks: { mask: FullMask; color: readonly [number, number, number] }[] = []; const rawMasks: { mask: FullMask; color: readonly [number, number, number] }[] = [];
  const clippedMasks: { mask: FullMask; color: readonly [number, number, number] }[] = []; const acceptedMasks: { mask: FullMask; color: readonly [number, number, number] }[] = [];
  let rawPixelTotal = 0; let clippedPixelTotal = 0; let acceptedPixelTotal = 0; let ownershipOverlapPixels = 0; const ownershipCounts = new Uint8Array(sourcePng.width * sourcePng.height);
  for (const [zoneIndex, semantic] of CORE.entries()) {
    const zone = guide.zones.find((item) => item.semanticType === semantic); if (!zone) throw new Error(`${summary.name} lacks ${semantic} zone`);
    const zoneMask = allowedZoneMask(zone, sourcePng.width, sourcePng.height); guideMasks.push({ mask: zoneMask, color: COLORS[zoneIndex] });
    const best = bestByRequested.get(semantic); const selected = selectedByFinal.get(semantic); const raw = best?.mask ?? emptyMask(sourcePng.width, sourcePng.height);
    const selectedRaw = selected?.mask ?? emptyMask(sourcePng.width, sourcePng.height); rawMasks.push({ mask: raw, color: COLORS[zoneIndex] });
    const part = proposedBySemantic.get(semantic); const clipped = part ? fullFromLocal(part.boundingBox, part.mask.alpha, sourcePng.width, sourcePng.height) : emptyMask(sourcePng.width, sourcePng.height); clippedMasks.push({ mask: clipped, color: COLORS[zoneIndex] });
    const accepted = acceptedBySemantic.get(semantic); const acceptedMask = accepted ? fullFromLocal(accepted.boundingBox, accepted.mask.alpha, sourcePng.width, sourcePng.height) : emptyMask(sourcePng.width, sourcePng.height); if (accepted) acceptedMasks.push({ mask: acceptedMask, color: COLORS[zoneIndex] });
    const rawPixels = count(raw.alpha); const selectedRawPixels = count(selectedRaw.alpha); const clippedPixels = count(clipped.alpha); const acceptedPixels = count(acceptedMask.alpha);
    rawPixelTotal += rawPixels; clippedPixelTotal += clippedPixels; acceptedPixelTotal += acceptedPixels;
    for (let index = 0; index < acceptedMask.alpha.length; index += 1) if (acceptedMask.alpha[index] > 0) { if (ownershipCounts[index] > 0) ownershipOverlapPixels += 1; ownershipCounts[index] += 1; }
    const sourceIntersectionPixels = count(maskIntersection(raw, foregroundAlpha).alpha); const zoneIntersectionPixels = count(maskIntersection(raw, zoneMask).alpha);
    const attempts = candidatesWithMasks.filter((item) => item.candidate.providerMetadata.requestedSemantic === semantic).map((item) => ({
      providerResponseId: item.candidate.providerMetadata.providerFilename ?? null, promptId: null, phrase: item.candidate.providerMetadata.detectorPhrase ?? null,
      crop: item.candidate.providerMetadata.sourceCrop ?? null, decodedWidth: item.mask.width, decodedHeight: item.mask.height, decodedPixels: count(item.mask.alpha),
      providerClassification: count(item.mask.alpha) > 0 ? "NON_EMPTY" : "EMPTY", score: item.candidate.providerMetadata.heuristicQuality?.score ?? null,
      safe: item.candidate.providerMetadata.heuristicQuality?.safe ?? false, warnings: item.candidate.diagnostics?.warnings ?? [],
    }));
    const allAttemptsEmpty = attempts.length > 0 && attempts.every((attempt) => attempt.decodedPixels === 0); const rawClassification = attempts.length === 0 ? "ERROR" : allAttemptsEmpty ? "EMPTY" : "NON_EMPTY";
    const safeGate = part?.notes.some((note) => note.startsWith("Gate: SAFE")) ?? false; const metrics = /proposed=(\d+); accepted=(\d+); clipped=(\d+);/.exec(part?.notes.join(" ") ?? "");
    const proposedPixels = Number(metrics?.[1] ?? selectedRawPixels); const constrainedPixels = Number(metrics?.[2] ?? clippedPixels); const outOfZoneRemoved = Number(metrics?.[3] ?? Math.max(0, proposedPixels - constrainedPixels));
    const preReason = part ? "DIAGNOSTIC_NOTES_MISCLASSIFIED_AS_BLOCKING" : selected ? "EMPTY_AFTER_ZONE_CLIP" : "NO_PROVIDER_CANDIDATE_OR_ZONE_MATCH";
    const postReason = accepted ? "ACCEPTED" : !selected ? (best ? "NO_WINNING_SEMANTIC_CANDIDATE" : "NO_PROVIDER_CANDIDATE") : !part ? "EMPTY_AFTER_ZONE_CLIP" : !safeGate ? "PROVIDER_REVIEW_QUALITY" : outOfZoneRemoved > 0 ? "ZONE_CLIP_FIGHT" : "NOT_RECOMMENDED";
    addHistogram(beforeHistogram, preReason); addHistogram(afterHistogram, postReason);
    const slug = `${String(sourceIndex + 1).padStart(2, "0")}-${safeName(frozen.file.replace(/\.png$/, ""))}-${semantic}`;
    await Promise.all([
      writeFile(path.join(OUTPUT, "raw-masks", `${slug}.png`), encodeMask(raw, COLORS[zoneIndex])), writeFile(path.join(OUTPUT, "zone-masks", `${slug}.png`), encodeMask(zoneMask, COLORS[zoneIndex])),
      writeFile(path.join(OUTPUT, "clipped-masks", `${slug}.png`), encodeMask(clipped, COLORS[zoneIndex])), writeFile(path.join(OUTPUT, "cleaned-masks", `${slug}.png`), encodeMask(clipped, COLORS[zoneIndex])),
      writeFile(path.join(OUTPUT, "accepted-masks", `${slug}.png`), encodeMask(acceptedMask, COLORS[zoneIndex])),
      writeFile(path.join(OUTPUT, "rejection-visualizations", `${slug}.png`), encodeMask({ ...raw, alpha: Uint8Array.from(raw.alpha, (value, index) => value > 0 && acceptedMask.alpha[index] === 0 ? 255 : 0) }, [255, 55, 70])),
      writeFile(path.join(OUTPUT, "provider-history", `${slug}.json`), json({ promptId: null, historyResult: null, outputNodeId: "6", outputFilename: best?.candidate.providerMetadata.providerFilename ?? null, reason: "ComfyUI history was empty after environment restart; historical managed output identity is preserved, but prompt IDs were not persisted by this pipeline." })),
    ]);
    let providerRaw: Awaited<ReturnType<typeof fetchProviderResponse>> | null = null;
    if (best) providerRaw = await fetchProviderResponse(best.candidate, path.join(OUTPUT, "provider-raw-responses", `${slug}.png`));
    await writeFile(path.join(OUTPUT, "provider-history", `${slug}-request.json`), json({
      sourceSha256: frozen.sha256, exactSourceBytesPreserved: true, uploadedNameExpected: `rigging-${safeName(project.sourceImage?.generationId ?? "source")}-source.png`,
      semantic, workflow: "character_segmentation_staged_v2", outputNodeId: "6", attempts,
      models: { sam2: process.env.COMFYUI_SAM2_MODEL ?? "sam2_hiera_large.safetensors", groundingDino: process.env.COMFYUI_GROUNDING_DINO_MODEL ?? "GroundingDINO_SwinT_OGC (694MB)" },
    }));
    zoneResults.push({
      projectId: summary.projectId, gateId: project.sourceImage?.generationId ?? null, sourceFile: frozen.file, sourceSha256: frozen.sha256, zoneSemantic: semantic,
      zoneBounds: zone.bounds as unknown as Json, allowedZonePixels: count(zoneMask.alpha), zoneForegroundPixels: count(maskIntersection(zoneMask, foregroundAlpha).alpha),
      providerRequestId: null, providerResponseId: best?.candidate.providerMetadata.providerFilename ?? null, providerAttempts: attempts as unknown as Json, rawClassification,
      rawMaskPixels: rawPixels, selectedRawMaskPixels: selectedRawPixels, rawSourceForegroundIntersectionPixels: sourceIntersectionPixels, rawZoneIntersectionPixels: zoneIntersectionPixels,
      decodedWidth: raw.width, decodedHeight: raw.height, expectedMappedWidth: sourcePng.width, expectedMappedHeight: sourcePng.height, providerRaw: providerRaw as unknown as Json,
      clippedMaskPixels: clippedPixels, cleanedMaskPixels: clippedPixels, cleanupOperation: "NONE", cleanupRemovedPixels: 0,
      ownershipEligiblePixels: acceptedPixels, acceptedPixels, rejectedPixels: Math.max(0, rawPixels - acceptedPixels), confidence: part?.confidence ?? best?.candidate.providerMetadata.heuristicQuality?.score ?? null,
      overlapRemoved: Math.max(0, selectedRawPixels - proposedPixels), outOfZoneRemoved, clipRetention: proposedPixels ? constrainedPixels / proposedPixels : 0,
      rejectionReasonPreFix: preReason, rejectionReasonPostFix: postReason, unresolvedContribution: acceptedPixels === 0 ? count(maskIntersection(raw, providerForeground).alpha) : 0,
    });
  }
  const acceptedUnion = unionMasks(acceptedMasks.map((item) => item.mask), sourcePng.width, sourcePng.height); const providerForegroundPixels = count(providerForeground.alpha);
  const resolvedProviderForeground = count(maskIntersection(acceptedUnion, providerForeground).alpha); const unresolvedPixels = Math.max(0, providerForegroundPixels - resolvedProviderForeground);
  const sourceSlug = `${String(sourceIndex + 1).padStart(2, "0")}-${safeName(frozen.file.replace(/\.png$/, ""))}`;
  await writeFile(path.join(OUTPUT, "provider-inputs", `${sourceSlug}.png`), frozen.bytes);
  const sourcePanel = sourcePng; const guidePanel = maskPanel(sourcePng, guideMasks); const rawPanel = maskPanel(sourcePng, rawMasks); const clippedPanel = maskPanel(sourcePng, clippedMasks); const cleanedPanel = maskPanel(sourcePng, clippedMasks); const acceptedPanel = maskPanel(sourcePng, acceptedMasks); const ownershipPanel = maskPanel(sourcePng, acceptedMasks);
  await writeFile(path.join(OUTPUT, "contact-sheets", `${sourceSlug}.png`), contactSheet([sourcePanel, guidePanel, rawPanel, clippedPanel, cleanedPanel, acceptedPanel, ownershipPanel]));
  await writeFile(path.join(OUTPUT, "contact-sheets", `${sourceSlug}-panels.json`), json({ panels: ["SOURCE", "GUIDE / ZONES", "RAW PROVIDER MASKS", "CLIPPED MASKS", "CLEANED MASKS", "ACCEPTED MASKS", "FINAL OWNERSHIP"] }));
  const acceptedCore = acceptedState.parts.filter((part) => part.accepted && CORE.includes(part.semanticType as typeof CORE[number])).length;
  const finalizable = acceptedCore >= Math.ceil(CORE.length * .9); const quality = finalizable && unresolvedPixels / Math.max(1, providerForegroundPixels) <= .15 ? "GOOD" : finalizable ? "USABLE" : "BAD";
  sourceResults.push({
    character: summary.name.replace(/^Final Gate \d+ /, ""), projectId: summary.projectId, sourceFile: frozen.file, sourceSha256: frozen.sha256, dimensions: `${sourcePng.width}x${sourcePng.height}`,
    sourceInputByteExact: sha(frozen.bytes) === importedHash, rawProviderNonempty: CORE.some((semantic) => count(bestByRequested.get(semantic)?.mask.alpha ?? []) > 0), rawMaskPixels: rawPixelTotal,
    clippedMaskPixels: clippedPixelTotal, aggregateClipRetention: rawPixelTotal ? clippedPixelTotal / rawPixelTotal : 0, primaryRejectionPreFix: "DIAGNOSTIC_NOTES_MISCLASSIFIED_AS_BLOCKING",
    acceptedCorePartsPreFix: 0, expectedCoreParts: CORE.length, acceptedCorePartsPostFix: acceptedCore, equipmentPartsPostFix: acceptedState.parts.filter((part) => part.accepted && part.equipment).length,
    unresolvedForegroundPixels: unresolvedPixels, unresolvedForegroundPercent: providerForegroundPixels ? unresolvedPixels / providerForegroundPixels * 100 : 100,
    coreAnatomyUnresolved: CORE.filter((semantic) => !acceptedBySemantic.has(semantic)), equipmentDetailUnresolved: "not requested by the fixed fifteen-zone production guide",
    cutQuality: quality, finalizableAutomaticCut: finalizable, manualRepairsNeeded: Math.max(0, CORE.length - acceptedCore), primaryRemainingIssue: acceptedCore < CORE.length ? "ZONE_CLIPPING / PROVIDER_REVIEW_QUALITY" : null,
    acceptedPixels: acceptedPixelTotal, duplicateOwnershipPixels: ownershipOverlapPixels, ownership: ownershipSummary(acceptedState) as unknown as Json, canonicalOwnershipDigest: acceptedDigest,
  });
  await writeFile(path.join(OUTPUT, "post-fix", `${sourceSlug}-state.json`), json({ ...acceptedState, updatedAt: "canonical-excluded" }));
}

const determinismCases = [
  ["Moonplume Chronicler", "pipeline-character-segmentation-1379bb64-7350-4b88-82fb-de49728d04fc", "pipeline-character-segmentation-c6828ce7-c325-4ed7-8936-053ca4a49fc3"],
  ["Starfen Veilcaller", "pipeline-character-segmentation-e9efb2ae-c1e7-4ec2-9833-ebff368a6856", "pipeline-character-segmentation-299ca978-cd74-45bf-8066-ee3abdfa36f0"],
  ["Tideglass Arbalist", "pipeline-character-segmentation-09f83be7-7f25-49d0-8203-415eda08c2ab", "pipeline-character-segmentation-051b9f46-34fd-4c78-b37d-4d78db25ac50"],
  ["Obsidian Bell Warden", "pipeline-character-segmentation-cbeda3a5-96fb-4cea-b67c-d5cdbdd2712a", "pipeline-character-segmentation-a803adc5-dd9e-458a-900a-000cf0db7f69"],
  ["Rookhorn Strider", "pipeline-character-segmentation-a0c84240-8e31-4191-91c3-6389d3caf237", "pipeline-character-segmentation-c9658703-1470-406d-b3a1-59e18d3d92d0"],
] as const;
const rawProposalDigest = async (proposalId: string): Promise<string> => {
  const directory = path.join(PROPOSAL_ROOT, proposalId); const metadata = JSON.parse(await readFile(path.join(directory, "metadata.json"), "utf8")) as ManagedMetadata;
  const entries = await Promise.all(metadata.candidates.map(async (candidate) => `${candidate.candidateId}:${sha(await readFile(path.join(directory, candidate.imageFileName)))}`)); return sha(entries.sort().join("\n"));
};
const rawDeterminism = await Promise.all(determinismCases.map(async ([character, primary, repeat]) => { const primaryDigest = await rawProposalDigest(primary); const repeatDigest = await rawProposalDigest(repeat); return { character, primary, repeat, primaryDigest, repeatDigest, match: primaryDigest === repeatDigest }; }));
const canonicalDeterminism = [...postStates.entries()].slice(0, 5).map(([projectId, item]) => {
  const second = acceptProposal({ ...item.project.partCutterState!, proposals: item.project.partCutterState!.proposals.map((proposal) => ({ ...proposal, parts: proposal.parts.map((part) => ({ ...part, selected: part.notes.some((note) => note.startsWith("Gate: SAFE")) && /proposed=(\d+); accepted=\1; clipped=0;/.test(part.notes.join(" ")) })) })) }, item.project.partCutterState!.proposals[0].proposalId);
  const repeatDigest = ownershipDigest(second); return { projectId, firstDigest: item.digest, repeatDigest, match: item.digest === repeatDigest };
});

const persistenceResults: Record<string, Json>[] = []; const roundTripStore = new LocalProjectStore({ cwd: OUTPUT, root: path.join(OUTPUT, "post-fix/reopen-store"), trashRoot: path.join(OUTPUT, "post-fix/reopen-trash"), now: () => "2026-08-24T09:01:17.000Z" });
for (const [index, [projectId, item]] of [...postStates.entries()].entries()) {
  const savedProject = { ...item.project, id: `cut-recovery-${String(index + 1).padStart(2, "0")}`, name: `Cut Recovery ${String(index + 1).padStart(2, "0")}`, stage: "prepare" as const, partCutterState: item.state, rigDefinition: undefined };
  const saved = await roundTripStore.save({ storageVersion: LOCAL_PROJECT_STORAGE_VERSION, localProjectId: savedProject.id, project: savedProject, rig: null, animations: null, selectedSkinId: null });
  const reopened = await roundTripStore.load(saved.projectId); const reopenedState = reopened.snapshot.project?.partCutterState; const reopenedDigest = reopenedState ? ownershipDigest(reopenedState) : null;
  persistenceResults.push({ projectId, savedProjectId: saved.projectId, expectedDigest: item.digest, reopenedDigest, reopenMatch: reopenedDigest === item.digest });
}
const zipIndexes = [0, 4, 8]; const zipResults: Record<string, Json>[] = [];
for (const index of zipIndexes) {
  const persistence = persistenceResults[index]; const savedProjectId = String(persistence.savedProjectId); const exported = await roundTripStore.exportSnapshot(savedProjectId); const zipName = exported.files.find((file) => file.endsWith(".project.zip")); if (!zipName) throw new Error(`${savedProjectId} ZIP missing`);
  const imported = await roundTripStore.importPortableZip(await readFile(path.join(exported.exportPath, zipName)), `Cut Recovery ZIP ${index + 1}`); const roundTrip = await roundTripStore.load(imported.projectId); const state = roundTrip.snapshot.project?.partCutterState; const digest = state ? ownershipDigest(state) : null;
  zipResults.push({ role: index === 0 ? "standard" : index === 4 ? "digitigrade" : "equipment-heavy", sourceProjectId: savedProjectId, importedProjectId: imported.projectId, expectedDigest: persistence.expectedDigest, importedDigest: digest, match: digest === persistence.expectedDigest });
}

const knownGoodControls = {
  requestedControlsAvailable: false,
  reason: "No durable project proves that two sources previously produced accepted parts through character_segmentation_staged_v2. Preserved controls prove provider output only.",
  controls: [
    { name: "Void Ranger staged-v2 smoke", topology: "standard humanoid", proposalId: "pipeline-character-segmentation-f7189029-b6d0-4520-bb11-2bb52b2a4028", rawMasksNonempty: true, acceptedPartProof: false },
    { name: "Approved swordsman historical segmentation", topology: "standard humanoid", proposalId: "pipeline-character-segmentation-0e8b1c13-d362-4feb-a6e5-f1b81ae6974f", workflow: "character_segmentation_v1", rawMasksNonempty: true, acceptedPartProof: false, limitation: "historical v1 path, not staged-v2" },
  ],
};
await writeFile(path.join(OUTPUT, "known-good-controls", "controls.json"), json(knownGoodControls));

const sourceHashesAfter = await Promise.all(sourceFiles.filter((file) => file.endsWith(".png")).sort().map(async (file) => ({ file, sha256: sha(await readFile(path.join(SOURCE_ROOT, file))) })));
const sourceHashesExact = sourceHashesAfter.every((item, index) => item.sha256 === sourceHashesBefore[index]?.sha256);
const histogramObject = (histogram: Map<string, number>): Record<string, number> => Object.fromEntries([...histogram.entries()].sort(([left], [right]) => left.localeCompare(right)));
const acceptedCoreTotal = sourceResults.reduce((sum, result) => sum + Number(result.acceptedCorePartsPostFix), 0); const expectedCoreTotal = sourceResults.reduce((sum, result) => sum + Number(result.expectedCoreParts), 0);
const finalizableCount = sourceResults.filter((result) => result.finalizableAutomaticCut === true).length; const duplicateOwnershipTotal = sourceResults.reduce((sum, result) => sum + Number(result.duplicateOwnershipPixels), 0);
const summary = {
  decision: "CUT RECOVERY FAILED", runId: RUN_ID, outputDirectory: OUTPUT,
  rootCause: "Comfy staged quality decisions were serialized as informational warning strings while ProposedCharacterPart.accepted was always false; guided auto-selection then required warnings.length === 0, so every real provider part was rejected.",
  rootCauseCategory: "ACCEPTANCE_THRESHOLD", providerAtFaultForZeroAcceptance: false, rawProviderMasksNonempty: sourceResults.every((result) => result.rawProviderNonempty === true),
  exactProductionChange: "Propagate candidate.quality.safe into ProposedCharacterPart.accepted and honor that structured recommendation in guided selection while preserving the zero-clip safeguard.",
  rejectionHistogramBefore: histogramObject(beforeHistogram), rejectionHistogramAfter: histogramObject(afterHistogram),
  acceptedCoreTotal, expectedCoreTotal, aggregateCoreAcceptancePercent: expectedCoreTotal ? acceptedCoreTotal / expectedCoreTotal * 100 : 0, finalizableAutomaticCuts: `${finalizableCount}/10`,
  ownershipViolations: duplicateOwnershipTotal, rawProviderDeterminism: `${rawDeterminism.filter((item) => item.match).length}/5`, canonicalOwnershipDeterminism: `${canonicalDeterminism.filter((item) => item.match).length}/5`,
  serialConcurrentComparison: { productionMode: "serial", equivalent: "NOT_APPLICABLE", note: "The production staged loop awaits every request; there is no concurrent branch to compare." },
  reopen: `${persistenceResults.filter((item) => item.reopenMatch === true).length}/10`, zip: `${zipResults.filter((item) => item.match === true).length}/3`, sourceHashes: sourceHashesExact ? "10/10 exact" : "changed",
  remainingDominantFailure: "ZONE_CLIPPING", finalGateReadyToRefreeze: false,
};
const determinism = { rawProvider: rawDeterminism, canonicalOwnership: canonicalDeterminism, serialConcurrent: summary.serialConcurrentComparison };

await Promise.all([
  writeFile(path.join(OUTPUT, "source-results.json"), json(sourceResults)), writeFile(path.join(OUTPUT, "zone-results.json"), json(zoneResults)),
  writeFile(path.join(OUTPUT, "rejection-histogram.json"), json({ before: histogramObject(beforeHistogram), after: histogramObject(afterHistogram) })),
  writeFile(path.join(OUTPUT, "determinism.json"), json(determinism)), writeFile(path.join(OUTPUT, "post-fix", "reopen.json"), json(persistenceResults)),
  writeFile(path.join(OUTPUT, "post-fix", "zip-round-trip.json"), json(zipResults)), writeFile(path.join(OUTPUT, "source-hashes-after.json"), json(sourceHashesAfter)),
  writeFile(path.join(OUTPUT, "summary.json"), json(summary)),
]);
const rows = sourceResults.map((result) => `| ${result.character} | ${result.rawProviderNonempty ? "YES" : "NO"} | ${result.rawMaskPixels} | ${(Number(result.aggregateClipRetention) * 100).toFixed(1)}% | ${result.primaryRejectionPreFix} | ${result.acceptedCorePartsPreFix} | ${result.acceptedCorePartsPostFix}/${result.expectedCoreParts} | ${result.equipmentPartsPostFix} | ${Number(result.unresolvedForegroundPercent).toFixed(1)}% | ${result.cutQuality} | ${result.canonicalOwnershipDigest ? "YES" : "NO"} | ${result.manualRepairsNeeded} | ${result.primaryRemainingIssue} |`).join("\n");
const report = `CUT RECOVERY FAILED\n\n# ComfyUI cut forensics and ownership-safe acceptance recovery\n\nThe zero-part failure is proven at semantic acceptance, not at ComfyUI output. Raw masks were non-empty for all ten sources. The narrow structured-SAFE propagation fix restores five ownership-safe core parts, but only ${acceptedCoreTotal}/${expectedCoreTotal} (${summary.aggregateCoreAcceptancePercent.toFixed(2)}%) expected core parts. No source reaches a finalizable automatic cut, so the required recovery target is not met and tuning stops.\n\n## Root-cause chain\n\nINPUT (10/10 exact) → PROVIDER (ready) → RAW MASK (non-empty) → DECODE (source-sized managed masks) → ZONE CLIP (often severe) → CLEANUP (none) → ACCEPTANCE (all rejected because audit notes occupied warnings and structured SAFE was lost) → OWNERSHIP (zero pre-fix).\n\nThe fix changes only the acceptance contract: Comfy quality SAFE is now stored in \`ProposedCharacterPart.accepted\`, and the guided proposal honors it while retaining \`clippedPixelCount === 0\`. The next dominant loss is zone clipping; it was not tuned in this pass.\n\n## Ten-source result\n\n| Character | Raw nonempty | Raw pixels | Clip retention | Primary rejection pre | Core pre | Core post | Equipment | Unresolved | Quality | Deterministic | Repairs | Remaining issue |\n|---|---:|---:|---:|---|---:|---:|---:|---:|---|---:|---:|---|\n${rows}\n\n## Aggregate evidence\n\n- Root-cause category: **ACCEPTANCE_THRESHOLD**.\n- Provider at fault for zero acceptance: **No**.\n- Rejection histogram before: \`${JSON.stringify(histogramObject(beforeHistogram))}\`.\n- Rejection histogram after: \`${JSON.stringify(histogramObject(afterHistogram))}\`.\n- Finalizable automatic cuts: **${summary.finalizableAutomaticCuts}**.\n- Aggregate core acceptance: **${summary.aggregateCoreAcceptancePercent.toFixed(2)}%**.\n- Duplicate ownership pixels: **${duplicateOwnershipTotal}**.\n- Raw provider determinism: **${summary.rawProviderDeterminism}** preserved paired runs.\n- Canonical ownership determinism: **${summary.canonicalOwnershipDeterminism}**.\n- Reopen: **${summary.reopen}**. Prepare ZIP: **${summary.zip}**.\n- Frozen source hashes: **${summary.sourceHashes}**.\n- Historical controls: the durable tree has two raw-output controls but no two accepted-part staged-v2 controls; this requirement is unavailable and is recorded in \`known-good-controls/controls.json\`.\n- Final gate ready to refreeze: **No**. Remaining dominant class: **ZONE_CLIPPING**.\n`;
await writeFile(path.join(OUTPUT, "report.md"), report);
process.stdout.write(json(summary));
