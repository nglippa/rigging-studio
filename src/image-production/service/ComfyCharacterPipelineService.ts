import { PNG } from "pngjs";
import { partTypeToBoneId, partTypeToSlotId, type PartType } from "../../character-generation/segmentation/partTaxonomy";
import { validateSegmentationResponse } from "../../character-generation/segmentation/segmentationValidator";
import type { CharacterSegmentationRequest } from "../../character-generation/segmentation/segmentationProvider";
import type { CharacterSegmentationResponse, ProposedCharacterPart, Rect, SegmentationMask } from "../../character-generation/segmentation/segmentationSchema";
import type { CharacterMaskRefinementRequest, CharacterPipelineCapabilities, CharacterPipelineCapability, OcclusionReconstructionRequest, OcclusionReconstructionResult } from "../../character-generation/providers/characterPipelineProvider";
import type { ImageCandidate, ImageProductionCapability, ImageProductionJson, ImageProposal } from "../proposals/imageProposal";
import type { ImageProviderOutput } from "../providers/imageProductionProvider";
import { ImageProductionService } from "./ImageProductionService";
import { bindTrustedWorkflow } from "../workflows/workflowManifest";
import {
  detectorCrop, detectorPhrases, detectionStage, foregroundCoverage, maskIntersectionOverUnion, reclassifySemantic,
  remapCropMask, resolveCharacterScreenSides, resolveConflictingOverlaps, scoreMaskCandidate, stagedTargets, summarizeMask,
  type CandidateQuality, type MaskSummary, type SemanticReclassification, type TrustedSemanticRegion,
} from "./stagedSegmentation";

export class ComfyCharacterPipelineService {
  constructor(private readonly production: ImageProductionService) {}

  async status(): Promise<{ readonly capabilities: CharacterPipelineCapabilities }> {
    const status = await this.production.status();
    const capability = (name: ImageProductionCapability, modelFamily: string, confidenceSource: CharacterPipelineCapability["confidenceSource"] = "unavailable"): CharacterPipelineCapability => {
      const found = status.capabilities.find((candidate) => candidate.capability === name);
      return {
        available: Boolean(status.provider.reachable && found?.capabilityAvailable), imageConditioned: true,
        mode: status.provider.reachable && found?.capabilityAvailable ? "provider" : "unavailable", provider: "comfyui",
        ...(found?.workflowId ? { workflow: found.workflowId } : {}), modelFamily, confidenceSource,
        ...(!status.provider.reachable || !found?.capabilityAvailable ? { reason: found?.reason ?? status.provider.message } : {}),
      };
    };
    return { capabilities: {
      segmentation: capability("CHARACTER_SEGMENTATION", "Grounding DINO + SAM2", "heuristic"),
      maskRefinement: capability("MASK_REFINEMENT", "Grounding DINO + SAM2", "unavailable"),
      reconstruction: capability("OCCLUSION_RECONSTRUCTION", "checkpoint inpainting", "unavailable"),
      backgroundRemoval: capability("BACKGROUND_REMOVAL", "configured trusted workflow"),
      alphaCleanup: capability("ALPHA_EDGE_CLEANUP", "configured trusted workflow"),
    } };
  }

  async segmentCharacter(request: CharacterSegmentationRequest): Promise<CharacterSegmentationResponse> {
    assertCanvas(request.width, request.height);
    const started = Date.now();
    const source = await readSourceImage(request.image);
    const sourceName = await this.production.provider.uploadImage?.(`rigging-${safeId(request.generationId)}-source.${source.mimeType === "image/png" ? "png" : "jpg"}`, source.bytes, source.mimeType);
    if (!sourceName) throw new Error("ComfyUI image upload is unavailable");
    const targets = stagedTargets(request.taxonomy);
    const anchors: Partial<Record<PartType, TrustedSemanticRegion>> = {};
    const staged: StagedMaskCandidate[] = [];
    const managedOutputs: ManagedPipelineOutput[] = [];
    const warnings: string[] = [];
    let detectorCalls = 0;
    let combinedDetectionSamRuntimeMs = 0;

    const foregroundCrop = { x: 0, y: 0, width: request.width, height: request.height };
    const foregroundStarted = Date.now();
    const foregroundOutputs = await this.execute("CHARACTER_SEGMENTATION", {
      sourceImage: sourceName, semanticPrompt: "person", detectionThreshold: 0.3,
      cropWidth: request.width, cropHeight: request.height, cropX: 0, cropY: 0,
      sam2Model: requiredEnvironment("COMFYUI_SAM2_MODEL"), groundingDinoModel: requiredEnvironment("COMFYUI_GROUNDING_DINO_MODEL"),
    });
    detectorCalls += 1;
    const foregroundRuntimeMs = Date.now() - foregroundStarted;
    combinedDetectionSamRuntimeMs += foregroundRuntimeMs;
    const foreground = combineMaskOutputs(foregroundOutputs, request.width, request.height);
    managedOutputs.push({
      candidateId: "foreground-person", output: { ...foregroundOutputs[0]!, bytes: encodeMaskPng(foreground), mimeType: "image/png" },
      metadata: segmentationAuditMetadata("rootReference", "rootReference", "person", "foreground", foregroundCrop, summarizeMask(foreground.alpha, request.width, request.height), null, foregroundRuntimeMs),
    });

    for (const type of targets) {
      const crop = detectorCrop(type, request.width, request.height, anchors);
      const phrases = targets.length === 1 && request.targetPartPrompt?.trim()
        ? [request.targetPartPrompt.trim()]
        : detectorPhrases(type, phraseCandidateLimit(type));
      const candidates: StagedMaskCandidate[] = [];
      for (const [phraseIndex, phrase] of phrases.entries()) {
        const candidateStarted = Date.now();
        const outputs = await this.execute("CHARACTER_SEGMENTATION", {
          sourceImage: sourceName, semanticPrompt: phrase, detectionThreshold: 0.3,
          cropWidth: crop.width, cropHeight: crop.height, cropX: crop.x, cropY: crop.y,
          sam2Model: requiredEnvironment("COMFYUI_SAM2_MODEL"), groundingDinoModel: requiredEnvironment("COMFYUI_GROUNDING_DINO_MODEL"),
        });
        detectorCalls += 1;
        const runtimeMs = Date.now() - candidateStarted;
        combinedDetectionSamRuntimeMs += runtimeMs;
        const cropMask = combineMaskOutputs(outputs, Math.round(crop.width), Math.round(crop.height));
        const full = { width: request.width, height: request.height, alpha: remapCropMask(cropMask.alpha, cropMask.width, cropMask.height, crop, request.width, request.height) };
        const summary = summarizeMask(full.alpha, request.width, request.height);
        const reclassification = summary
          ? reclassifySemantic(type, summary, anchors, request.width, request.height)
          : { semanticType: type, confidence: 0, ambiguous: true, reason: "Provider returned an empty mask" } satisfies SemanticReclassification;
        const quality = summary ? scoreMaskCandidate(reclassification.semanticType, summary, crop, request.width, request.height, anchors) : null;
        const candidateId = `mask-${safeId(type)}-${phraseIndex + 1}-${safeId(phrase)}`;
        managedOutputs.push({
          candidateId, output: { ...outputs[0]!, bytes: encodeMaskPng(full), mimeType: "image/png" },
          metadata: segmentationAuditMetadata(type, reclassification.semanticType, phrase, detectionStage(type), crop, summary, quality, runtimeMs, reclassification),
          warnings: quality?.safe ? [] : quality?.reasons ?? ["Provider returned an empty mask"], recommended: quality?.safe,
        });
        if (summary && quality) candidates.push({ candidateId, requestedType: type, semanticType: reclassification.semanticType, mask: full, summary, quality, reclassification, phrase, crop, runtimeMs });
      }
      const winner = candidates.sort((left, right) => right.quality.score - left.quality.score)[0];
      if (!winner) { warnings.push(`Unresolved ${type}: provider returned no non-empty mask for ${phrases.join(", ")}`); continue; }
      staged.push(winner);
      if (winner.quality.safe) anchors[winner.semanticType] = trustedRegion(winner);
    }

    const unique: StagedMaskCandidate[] = [];
    for (const candidate of staged.sort((left, right) => right.quality.score - left.quality.score)) {
      const collision = unique.find((existing) => existing.semanticType === candidate.semanticType);
      if (collision) {
        warnings.push(`Unresolved ${candidate.requestedType}: semantic reclassification collides with ${collision.requestedType} as ${candidate.semanticType} (IoU ${maskIntersectionOverUnion(candidate.mask.alpha, collision.mask.alpha).toFixed(3)})`);
        continue;
      }
      unique.push(candidate);
    }
    unique.sort((left, right) => targets.indexOf(left.requestedType) - targets.indexOf(right.requestedType));
    const overlapResolved = resolveConflictingOverlaps(unique.map((candidate) => ({ semanticType: candidate.semanticType, mask: candidate.mask.alpha, qualityScore: candidate.quality.score })));
    const resolved = unique.flatMap((candidate, index): StagedMaskCandidate[] => {
      const alpha = overlapResolved.parts[index]?.mask ?? candidate.mask.alpha;
      const summary = summarizeMask(alpha, request.width, request.height);
      if (!summary) { warnings.push(`Unresolved ${candidate.requestedType}: overlap resolution removed every mask pixel`); return []; }
      const decisions = overlapResolved.decisions.filter((decision) => (decision.left === candidate.semanticType || decision.right === candidate.semanticType) && (decision.conflicting || (decision.expected && decision.intersection > 0)));
      const scored = scoreMaskCandidate(candidate.semanticType, summary, candidate.crop, request.width, request.height, anchors);
      const unresolvedConflict = decisions.filter((decision) => decision.conflicting && !decision.subtractedFrom);
      const quality: CandidateQuality = unresolvedConflict.length ? {
        ...scored, score: Math.min(scored.score, .49), safe: false,
        conflictingOverlap: Math.max(scored.conflictingOverlap, ...unresolvedConflict.map((decision) => Math.max(decision.fractionOfLeft, decision.fractionOfRight))),
        reasons: [...scored.reasons.filter((reason) => !reason.startsWith("Passed ")), ...unresolvedConflict.map((decision) => `Ambiguous catastrophic overlap: ${decision.left}/${decision.right}`)],
      } : scored;
      return [{ ...candidate, mask: { ...candidate.mask, alpha }, summary, quality, overlapNotes: decisions.map((decision) => `${decision.left}/${decision.right}: ${decision.reason}${decision.subtractedFrom ? `; subtracted from ${decision.subtractedFrom}` : ""}`) }];
    });
    const selectedCandidateIds = new Set(resolved.map((candidate) => candidate.candidateId));
    const coverage = foregroundCoverage(resolved.filter((candidate) => candidate.quality.safe).map((candidate) => candidate.mask.alpha), foreground.alpha);
    resolved.filter((candidate) => !candidate.quality.safe).forEach((candidate) => warnings.push(`Review ${candidate.semanticType}: ${candidate.quality.reasons.join("; ")}`));
    managedOutputs.forEach((item) => { if (selectedCandidateIds.has(item.candidateId)) (item.metadata as Record<string, ImageProductionJson>).selectedForPartProposal = true; });
    const managedProposalId = await this.storeManagedOutputs("CHARACTER_SEGMENTATION", request.consistencyContext?.projectId ?? request.generationId, "character_segmentation_staged_v2", request.semanticPrompt ?? "Staged character semantic mask extraction", managedOutputs);
    const parts = resolved.map((candidate, index) => partFromStagedMask(candidate, index));
    const safeCount = resolved.filter((candidate) => candidate.quality.safe).length;
    const sideResolution = resolveCharacterScreenSides(request.width, anchors);
    const response: CharacterSegmentationResponse = {
      segmentationId: `comfy-segment-${safeId(request.generationId)}-${Date.now().toString(36)}`,
      imageWidth: request.width, imageHeight: request.height, parts, warnings,
      providerMetadata: {
        provider: "comfyui", workflow: "character_segmentation_staged_v2", modelFamily: "Grounding DINO + SAM2", imageConditioned: true,
        confidenceSource: "heuristic", managedProposalId, runtimeMs: Date.now() - started, detectorCalls, sam2Runs: detectorCalls,
        detectorBoxesAvailable: false, detectorConfidenceAvailable: false, providerTimingGranularity: "combined-detection-sam2",
        combinedDetectionSamRuntimeMs, safeCount, reviewCount: parts.length - safeCount, candidateArtifactCount: managedOutputs.length,
        semanticReclassifications: resolved.filter((candidate) => candidate.semanticType !== candidate.requestedType).length,
        foregroundAssignedPercent: Number((coverage.percentAssigned * 100).toFixed(2)), foregroundPixels: coverage.foregroundPixels,
        foregroundUnresolvedPixels: coverage.unresolvedPixels, foregroundOverlappingPixels: coverage.overlappingPixels,
        leftRightConvention: sideResolution.reason,
      },
    };
    const validation = validateSegmentationResponse(response);
    if (!validation.success || !validation.data) throw new Error(`ComfyUI segmentation failed validation: ${validation.errors.join("; ")}`);
    return validation.data;
  }

  async refinePartMasks(request: CharacterMaskRefinementRequest): Promise<CharacterSegmentationResponse> {
    const started = Date.now();
    const target = selectRefinementTarget(request.current.parts, request.targetPartId, request.instruction);
    if (!target.mask) throw new Error(`Part ${target.id} has no current pixel mask to refine`);
    const source = await readSourceImage(request.image);
    const sourceName = await this.production.provider.uploadImage?.(`rigging-${safeId(request.generationId)}-source.${source.mimeType === "image/png" ? "png" : "jpg"}`, source.bytes, source.mimeType);
    if (!sourceName) throw new Error("ComfyUI image upload is unavailable");
    const fullCurrent = placeMask(target.mask, target.bounds, request.width, request.height);
    const maskName = await this.production.provider.uploadImage?.(`rigging-${safeId(request.generationId)}-${safeId(target.id)}-mask.png`, encodeMaskPng(fullCurrent), "image/png", true);
    if (!maskName) throw new Error("ComfyUI mask upload is unavailable");
    const operation = /\b(remove|exclude|erase|without)\b/i.test(request.instruction) ? "subtract" : "add";
    const outputs = await this.execute("MASK_REFINEMENT", {
      sourceImage: sourceName, currentMask: maskName, semanticPrompt: request.instruction, maskOperation: operation, detectionThreshold: 0.3,
      sam2Model: requiredEnvironment("COMFYUI_SAM2_MODEL"), groundingDinoModel: requiredEnvironment("COMFYUI_GROUNDING_DINO_MODEL"),
    });
    const managedProposalId = await this.storeManagedOutputs("MASK_REFINEMENT", request.consistencyContext?.projectId ?? request.generationId, "mask_refinement_v1", request.instruction, outputs.map((output, index) => ({ candidateId: `refined-${safeId(target.id)}-${index + 1}`, output, metadata: { targetPartId: target.id, operation } })), target.id);
    const refined = combineMaskOutputs(outputs, request.width, request.height);
    const replacement = partFromFullMask(target, refined);
    const response: CharacterSegmentationResponse = {
      ...request.current,
      segmentationId: `comfy-refine-${safeId(request.generationId)}-${Date.now().toString(36)}`,
      parts: request.current.parts.map((part) => part.id === target.id ? replacement : part),
      warnings: [...request.current.warnings, `Refined ${target.id} only; unrelated masks were preserved exactly`],
      providerMetadata: { provider: "comfyui", workflow: "mask_refinement_v1", modelFamily: "Grounding DINO + SAM2", imageConditioned: true, confidenceSource: "unavailable", targetPartId: target.id, managedProposalId, runtimeMs: Date.now() - started },
    };
    const validation = validateSegmentationResponse(response);
    if (!validation.success || !validation.data) throw new Error(`ComfyUI mask refinement failed validation: ${validation.errors.join("; ")}`);
    return validation.data;
  }

  async reconstructPart(request: OcclusionReconstructionRequest): Promise<OcclusionReconstructionResult> {
    const started = Date.now();
    if (!request.reconstructionMask || !request.reconstructionMaskBounds) throw new Error("A reviewed reconstruction mask/occlusion area is required; select the missing region before requesting reconstruction");
    if (!request.part.mask) throw new Error("Reconstruction requires the current visible part mask so neighboring source pixels remain excluded");
    if (!request.consistencyContext) throw new Error("Reconstruction requires CharacterConsistencyContext to lock the source canvas and part coordinate system");
    const source = await readSourceImage(request.image);
    const sourceName = await this.production.provider.uploadImage?.(`rigging-${safeId(request.generationId)}-reconstruction-source.${source.mimeType === "image/png" ? "png" : "jpg"}`, source.bytes, source.mimeType);
    if (!sourceName) throw new Error("ComfyUI image upload is unavailable");
    const context = request.consistencyContext;
    const fullMask = placeMask(request.reconstructionMask, request.reconstructionMaskBounds, context.sourceCanvasWidth, context.sourceCanvasHeight);
    const visibleMask = placeMask(request.part.mask, request.part.bounds, context.sourceCanvasWidth, context.sourceCanvasHeight);
    const maskName = await this.production.provider.uploadImage?.(`rigging-${safeId(request.generationId)}-${safeId(request.part.id)}-reconstruct-mask.png`, encodeMaskPng(fullMask), "image/png", true);
    if (!maskName) throw new Error("ComfyUI reconstruction-mask upload is unavailable");
    const prompt = [
      `Localized inpainting only: complete the ${request.part.semanticType} of this existing character.`,
      `Preserve the visible pixels, original scale, pose, attachment regions, palette, linework, lighting, costume, and source coordinates.`,
      `Source bounding box ${JSON.stringify(request.part.bounds)}; expected pivot ${JSON.stringify(request.expectedPivot ?? request.part.pivotHint)}.`,
      `Nearby semantic boxes ${JSON.stringify(context.semanticBBoxes)}; joint hints ${JSON.stringify(context.jointHints)}.`,
      request.stylePrompt, context.characterPrompt, context.stylePrompt,
    ].filter(Boolean).join(" ");
    const seed = context.generationSeed ?? Math.floor(Math.random() * 2_147_483_647);
    const outputs = await this.execute("OCCLUSION_RECONSTRUCTION", {
      sourceImage: sourceName, maskImage: maskName, positivePrompt: prompt,
      negativePrompt: "new character, changed pose, changed scale, changed costume, detached limb, duplicate limb, full body replacement, background change",
      seed, steps: 28, guidance: 6.5, denoise: 0.65,
      checkpoint: requiredEnvironment("COMFYUI_CHECKPOINT"),
    });
    const output = outputs[0];
    if (!output) throw new Error("ComfyUI reconstruction returned no image");
    const cropped = cropReconstructionPng(output.bytes, request.part.bounds, visibleMask, fullMask);
    const managedProposalId = await this.storeManagedOutputs("OCCLUSION_RECONSTRUCTION", context.projectId, "occlusion_reconstruction_v1", prompt, [{ candidateId: `reconstructed-${safeId(request.part.id)}`, output: { ...output, bytes: cropped, mimeType: "image/png" }, metadata: { targetPartId: request.part.id, seed } }], request.part.id, seed);
    return {
      reconstructionId: `comfy-reconstruct-${safeId(request.part.id)}-${Date.now().toString(36)}`,
      partId: request.part.id, image: `data:image/png;base64,${Buffer.from(cropped).toString("base64")}`,
      width: Math.max(1, Math.round(request.part.bounds.width)), height: Math.max(1, Math.round(request.part.bounds.height)),
      providerMetadata: { provider: "comfyui", workflow: "occlusion_reconstruction_v1", modelFamily: "checkpoint inpainting", imageConditioned: true, scaleLocked: true, managedProposalId, seed },
      warnings: ["Candidate remains unapproved until visual review and the consistency/rotation gates pass"], runtimeMs: Date.now() - started,
    };
  }

  private async execute(capability: ImageProductionCapability, values: Readonly<Record<string, ImageProductionJson>>): Promise<readonly ImageProviderOutput[]> {
    const providerStatus = await this.production.provider.status();
    if (!providerStatus.reachable) throw new Error(`ComfyUI is offline at ${providerStatus.url}: ${providerStatus.message}`);
    const workflow = await this.production.registry.require(capability);
    const dependencies = await this.production.provider.inspectDependencies(workflow);
    if (!dependencies.available) throw new Error(formatDependencyFailure(dependencies));
    const submitted = await this.production.provider.submit(bindTrustedWorkflow(workflow, values));
    const completed = await this.production.provider.waitForCompletion(submitted.promptId, workflow.manifest.outputs.images.nodeId);
    if (!completed.outputs.length) throw new Error(`Trusted ${capability} workflow returned no images`);
    return completed.outputs;
  }

  private async storeManagedOutputs(capability: ImageProductionCapability, projectId: string, workflowId: string, prompt: string, outputs: readonly ManagedPipelineOutput[], targetPartId?: string, seed = 0): Promise<string> {
    if (!outputs.length) throw new Error(`${capability} returned no provider artifacts to store`);
    const proposalId = `pipeline-${capability.toLowerCase().replaceAll("_", "-")}-${crypto.randomUUID()}`;
    const candidates: ImageCandidate[] = [];
    for (const item of outputs) {
      const asset = await this.production.storage.writeCandidate(proposalId, item.candidateId, item.output.bytes, item.output.mimeType);
      candidates.push({
        candidateId: item.candidateId, imageAssetId: asset.imageAssetId, imageFileName: asset.imageFileName, width: asset.width, height: asset.height,
        seed, providerMetadata: { workflowId, providerFilename: item.output.providerAsset.filename, providerSubfolder: item.output.providerAsset.subfolder, ...item.metadata },
        diagnostics: { warnings: item.warnings ?? [] }, status: item.recommended ? "recommended" : "generated",
      });
    }
    const timestamp = new Date().toISOString();
    const proposal: ImageProposal = {
      proposalVersion: 1, proposalId, projectId, operationType: capability, provider: "comfyui", workflowId, status: "awaiting_review", approvalPolicy: "manual",
      createdAt: timestamp, updatedAt: timestamp, sourcePrompt: prompt, negativePrompt: "", generationParameters: { candidateCount: candidates.length, managedPipelineArtifact: true },
      ...(targetPartId ? { targetPartId } : {}), proposalRound: 1, candidateIds: candidates.map((candidate) => candidate.candidateId), candidates,
      warnings: [], errors: [], progress: { phase: "ready", candidateIndex: candidates.length, candidateCount: candidates.length, percent: 100, message: `${capability} artifacts stored for review` }, inspectionEvidence: [],
    };
    await this.production.storage.create(proposal);
    return proposalId;
  }
}

type FullMask = { readonly width: number; readonly height: number; readonly alpha: Uint8Array };
type StagedMaskCandidate = {
  readonly candidateId: string;
  readonly requestedType: PartType;
  readonly semanticType: PartType;
  readonly mask: FullMask;
  readonly summary: MaskSummary;
  readonly quality: CandidateQuality;
  readonly reclassification: SemanticReclassification;
  readonly phrase: string;
  readonly crop: Rect;
  readonly runtimeMs: number;
  readonly overlapNotes?: readonly string[];
};
type ManagedPipelineOutput = {
  readonly candidateId: string;
  readonly output: ImageProviderOutput;
  readonly metadata: Readonly<Record<string, ImageProductionJson>>;
  readonly warnings?: readonly string[];
  readonly recommended?: boolean;
};

async function readSourceImage(source: string): Promise<{ readonly bytes: Uint8Array; readonly mimeType: "image/png" | "image/jpeg" }> {
  const data = /^data:(image\/(?:png|jpeg));base64,([a-zA-Z0-9+/=\s]+)$/.exec(source);
  if (data) return { bytes: Buffer.from(data[2], "base64"), mimeType: data[1] as "image/png" | "image/jpeg" };
  let url: URL;
  try { url = new URL(source); } catch { throw new Error("Character source must be a PNG/JPEG data URL or a managed localhost URL"); }
  const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && (/^\/generations\//.test(url.pathname) || /^\/image-production\/assets\//.test(url.pathname));
  if (!local) throw new Error("Character source URL is outside managed localhost image storage");
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Managed character source is unavailable (${response.status})`);
  const mimeType = response.headers.get("content-type")?.split(";")[0];
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") throw new Error("Managed character source must be PNG or JPEG");
  return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType };
}

function combineMaskOutputs(outputs: readonly ImageProviderOutput[], width: number, height: number): FullMask {
  const alpha = new Uint8Array(width * height);
  for (const output of outputs) {
    if (output.mimeType !== "image/png") throw new Error("Segmentation workflow masks must be PNG images");
    const decoded = PNG.sync.read(Buffer.from(output.bytes));
    if (decoded.width !== width || decoded.height !== height) throw new Error(`Segmentation mask ${decoded.width}×${decoded.height} does not match source ${width}×${height}`);
    for (let index = 0; index < alpha.length; index += 1) alpha[index] = Math.max(alpha[index], decoded.data[index * 4]);
  }
  return { width, height, alpha };
}

function partFromStagedMask(candidate: StagedMaskCandidate, index: number): ProposedCharacterPart {
  const type = candidate.semanticType;
  const bounds = candidate.summary.bounds;
  const mask = cropMask(candidate.mask, bounds);
  const audit = `Audit: stage=${detectionStage(candidate.requestedType)}; phrase="${candidate.phrase}"; crop=${rectText(candidate.crop)}; maskBounds=${rectText(bounds)}; detectorBox=unavailable; detectorConfidence=unavailable; confidenceSource=heuristic`;
  const gate = candidate.quality.safe
    ? `Gate: SAFE staged score=${candidate.quality.score.toFixed(3)}`
    : `Gate: REVIEW staged score=${candidate.quality.score.toFixed(3)}; ${candidate.quality.reasons.join("; ")}`;
  const semantic = candidate.semanticType === candidate.requestedType
    ? []
    : [`Semantic reclassification: ${candidate.requestedType} → ${candidate.semanticType}; ${candidate.reclassification.reason}`];
  return {
    id: type, name: type, semanticType: type, confidence: Number(candidate.quality.score.toFixed(3)), confidenceSource: "heuristic", bounds, mask, sourceImageRegion: bounds,
    suggestedBoneId: partTypeToBoneId(type), suggestedSlotId: partTypeToSlotId(type), suggestedZIndex: semanticZ(type, index),
    pivotHint: { x: bounds.x + bounds.width / 2, y: bounds.y + Math.min(bounds.height * .2, 18) },
    warnings: [audit, gate, ...semantic, ...(candidate.overlapNotes ?? [])], accepted: candidate.quality.safe, provenance: "generated",
  };
}

function trustedRegion(candidate: StagedMaskCandidate): TrustedSemanticRegion {
  return { semanticType: candidate.semanticType, mask: candidate.mask.alpha, summary: candidate.summary, qualityScore: candidate.quality.score };
}

function phraseCandidateLimit(type: PartType): number {
  if (type === "torso") return 4;
  if (type === "mainHandEquipment") return 3;
  if (type === "offHandEquipment" || type === "head") return 2;
  if (/Arm|Hand|Thigh|Leg|Foot/.test(type)) return 2;
  return 1;
}

function segmentationAuditMetadata(
  requestedSemantic: PartType,
  finalSemantic: PartType,
  detectorPhrase: string,
  stage: string,
  crop: Rect,
  summary: MaskSummary | null,
  quality: CandidateQuality | null,
  runtimeMs: number,
  reclassification?: SemanticReclassification,
): Readonly<Record<string, ImageProductionJson>> {
  return {
    requestedSemantic, finalSemantic, detectorPhrase, stage,
    sourceCrop: crop,
    detectorBoxAvailable: false,
    detectorConfidenceAvailable: false,
    detectorConfidence: null,
    combinedDetectionSamRuntimeMs: runtimeMs,
    sam2PointPromptsAvailable: false,
    sam2PositiveNegativePointsUsed: false,
    sam2MultimaskAvailable: false,
    sam2Mode: "installed combined node: detector box to one SAM2 mask",
    maskSummary: summary ? { bounds: summary.bounds, area: summary.area, bboxArea: summary.bboxArea, fillRatio: summary.fillRatio, areaRatio: summary.areaRatio, centroid: summary.centroid } : null,
    heuristicQuality: quality ? {
      score: quality.score, safe: quality.safe, broad: quality.broad, semanticConsistency: quality.semanticConsistency,
      hierarchyConsistency: quality.hierarchyConsistency, sizePlausibility: quality.sizePlausibility,
      positionPlausibility: quality.positionPlausibility, conflictingOverlap: quality.conflictingOverlap, reasons: quality.reasons,
    } : null,
    semanticReclassification: reclassification ? { semanticType: reclassification.semanticType, confidence: reclassification.confidence, ambiguous: reclassification.ambiguous, reason: reclassification.reason } : null,
  };
}

function rectText(rect: Rect): string { return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}×${Math.round(rect.height)}`; }

function partFromFullMask(original: ProposedCharacterPart, full: FullMask): ProposedCharacterPart {
  const bounds = tightBounds(full);
  if (!bounds) throw new Error(`Refinement removed every pixel from ${original.id}`);
  return {
    ...original, bounds, sourceImageRegion: bounds, mask: cropMask(full, bounds), confidence: null, confidenceSource: "unavailable", accepted: false,
    pivotHint: { x: clamp(original.pivotHint.x, bounds.x, bounds.x + bounds.width), y: clamp(original.pivotHint.y, bounds.y, bounds.y + bounds.height) },
    warnings: [...original.warnings, "Image-conditioned mask refinement requires review"],
  };
}

function tightBounds(mask: FullMask): Rect | null {
  let left = mask.width; let top = mask.height; let right = -1; let bottom = -1;
  for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) if (mask.alpha[y * mask.width + x] > 0) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  return right < left || bottom < top ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function cropMask(full: FullMask, bounds: Rect): SegmentationMask {
  const width = Math.max(1, Math.round(bounds.width)); const height = Math.max(1, Math.round(bounds.height)); const alpha: number[] = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) alpha.push(full.alpha[(Math.round(bounds.y) + y) * full.width + Math.round(bounds.x) + x] ?? 0);
  return { width, height, alpha };
}

function placeMask(mask: SegmentationMask, bounds: Rect, width: number, height: number): FullMask {
  assertCanvas(width, height);
  if (mask.width !== Math.round(bounds.width) || mask.height !== Math.round(bounds.height)) throw new Error("Mask dimensions do not match the declared source bounds");
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) {
    const targetX = Math.round(bounds.x) + x; const targetY = Math.round(bounds.y) + y;
    if (targetX >= 0 && targetY >= 0 && targetX < width && targetY < height) alpha[targetY * width + targetX] = mask.alpha[y * mask.width + x] ?? 0;
  }
  return { width, height, alpha };
}

function encodeMaskPng(mask: FullMask): Uint8Array {
  const png = new PNG({ width: mask.width, height: mask.height });
  for (let index = 0; index < mask.alpha.length; index += 1) {
    const value = mask.alpha[index]; const offset = index * 4;
    png.data[offset] = value; png.data[offset + 1] = value; png.data[offset + 2] = value; png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

function cropReconstructionPng(bytes: Uint8Array, bounds: Rect, visibleMask: FullMask, reconstructionMask: FullMask): Uint8Array {
  const source = PNG.sync.read(Buffer.from(bytes));
  if (source.width !== visibleMask.width || source.height !== visibleMask.height || source.width !== reconstructionMask.width || source.height !== reconstructionMask.height) throw new Error("Reconstruction output no longer matches the locked source canvas");
  const x = Math.round(bounds.x); const y = Math.round(bounds.y); const width = Math.max(1, Math.round(bounds.width)); const height = Math.max(1, Math.round(bounds.height));
  if (x < 0 || y < 0 || x + width > source.width || y + height > source.height) throw new Error("Reconstruction crop leaves the generated source canvas");
  const output = new PNG({ width, height });
  PNG.bitblt(source, output, x, y, width, height, 0, 0);
  for (let localY = 0; localY < height; localY += 1) for (let localX = 0; localX < width; localX += 1) {
    const sourceIndex = (y + localY) * source.width + x + localX; const outputOffset = (localY * width + localX) * 4;
    output.data[outputOffset + 3] = Math.max(visibleMask.alpha[sourceIndex] ?? 0, reconstructionMask.alpha[sourceIndex] ?? 0);
  }
  return PNG.sync.write(output);
}

function selectRefinementTarget(parts: readonly ProposedCharacterPart[], requestedId: string | undefined, instruction: string): ProposedCharacterPart {
  if (requestedId) {
    const exact = parts.find((part) => part.id === requestedId);
    if (!exact) throw new Error(`Mask-refinement target ${requestedId} does not exist`);
    return exact;
  }
  const lower = instruction.toLowerCase();
  const matches = parts.filter((part) => lower.includes(part.id.toLowerCase()) || lower.includes(part.name.toLowerCase()) || lower.includes(part.semanticType.toLowerCase()));
  if (matches.length !== 1) throw new Error("Mask refinement requires one unambiguous targetPartId; unrelated parts were left unchanged");
  return matches[0];
}

function semanticZ(type: PartType, index: number): number {
  if (/left|cape|back/i.test(type)) return -10 + index;
  if (/right|Equipment|helmet|hair|face|accessory/i.test(type)) return 10 + index;
  return index;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function formatDependencyFailure(dependencies: { readonly missingNodeClasses: readonly string[]; readonly missingModels: readonly string[] }): string {
  return [`Missing ComfyUI node classes: ${dependencies.missingNodeClasses.join(", ") || "none"}`, `Missing workflow/model configuration: ${dependencies.missingModels.join(", ") || "none"}`].join("; ");
}

function assertCanvas(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error("Source canvas dimensions are invalid or exceed 8192 px");
}

function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120) || "asset"; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
