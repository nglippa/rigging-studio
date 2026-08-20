"use client";
/* eslint-disable @next/next/no-img-element -- generated data/blob URLs and fixture images must remain provider-controlled */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { buildCharacterGenerationPrompt } from "@/src/character-generation/prompt/characterPromptBuilder";
import type { CharacterPromptControls } from "@/src/character-generation/prompt/generationPreset";
import { HttpCharacterPipelineProvider } from "@/src/character-generation/providers/httpCharacterPipelineProvider";
import { MockCharacterPipelineProvider } from "@/src/character-generation/providers/mockCharacterPipelineProvider";
import type { CharacterPipelineProvider } from "@/src/character-generation/providers/characterPipelineProvider";
import { detectOcclusionReviews, acceptReconstruction, rejectReconstruction, type OcclusionDecision } from "@/src/character-generation/occlusion/occlusionRepair";
import { PART_TYPES, type PartType } from "@/src/character-generation/segmentation/partTaxonomy";
import type { ProposedCharacterPart, Rect, SegmentationMask } from "@/src/character-generation/segmentation/segmentationSchema";
import { validateSegmentationResponse } from "@/src/character-generation/segmentation/segmentationValidator";
import { extractPartToDataUrl } from "@/src/character-generation/segmentation/partImageProcessor";
import { buildRigProposal } from "@/src/character-generation/rigging/rigProposalBuilder";
import { validateRigProposal } from "@/src/character-generation/rigging/rigProposalValidator";
import { wouldCreateHierarchyCycle } from "@/src/character-generation/rigging/hierarchyBuilder";
import { runRigSmokeTest, type RigSmokeTestResult } from "@/src/character-generation/testing/rigSmokeTest";
import { createGeneratedCharacterProject, parseGeneratedCharacterProject, serializeGeneratedCharacterProject, type CharacterProjectStage, type GeneratedCharacterProject } from "@/src/character-generation/project/generatedCharacterProject";
import { createCharacterProjectZip, importCharacterProjectArchive } from "@/src/character-generation/project/projectArchive";
import { getGeneratedCharacterStorage } from "@/src/character-generation/project/generatedCharacterStorage";
import { writeRigEditorHandoffPointer } from "@/src/character-generation/project/rigEditorHandoff";
import type { BoneDefinition, RigDefinition } from "@/src/rigging/schema/types";
import { createRestPose } from "@/src/rigging/runtime/pose";
import { computeWorldTransforms } from "@/src/rigging/runtime/worldTransforms";
import { invertMatrix, transformPoint } from "@/src/rigging/math/matrix";
import { getRiggingCommandService } from "@/src/agent-control";
import { useAgentBridge } from "@/src/agent-control/protocol/useAgentBridge";
import { StudioDialog } from "@/app/studio-ui/StudioDialog";
import { presentAgentStatus } from "@/app/studio-ui/agentStatus";

const TEST_PROMPT = "Small fantasy knight in polished silver armor with a blue tabard, brown hair, simple iron sword, and round blue shield. Charming stylized 2D game character, clean side view, readable silhouette, modular body parts, neutral stance.";
const STAGES: readonly { readonly id: CharacterProjectStage; readonly label: string }[] = [
  { id: "describe", label: "Describe" }, { id: "generate", label: "Generate" }, { id: "prepare", label: "Prepare" },
  { id: "rig", label: "Rig" }, { id: "test", label: "Test" }, { id: "edit", label: "Edit" },
];
const now = (): string => new Date().toISOString();
const updateProject = (project: GeneratedCharacterProject, patch: Partial<GeneratedCharacterProject>): GeneratedCharacterProject => ({ ...project, ...patch, updatedAt: now() });
const normalizeProjectWarnings = (project: GeneratedCharacterProject): GeneratedCharacterProject => ({ ...project, warnings: [...new Set(project.warnings)], segmentationData: project.segmentationData ? { ...project.segmentationData, warnings: [...new Set(project.segmentationData.warnings)], parts: project.segmentationData.parts.map((part) => ({ ...part, warnings: [...new Set(part.warnings)] })) } : undefined });
const downloadBlob = (blob: Blob, name: string): void => { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0); };

export function CreateCharacterWorkspace() {
  const commandService = useMemo(() => getRiggingCommandService(), []);
  const agentSession = useAgentBridge(commandService);
  const characterStorage = useMemo(() => getGeneratedCharacterStorage(), []);
  const [project, setProject] = useState<GeneratedCharacterProject>(() => createGeneratedCharacterProject("Fantasy Knight", TEST_PROMPT));
  const [controls, setControls] = useState<CharacterPromptControls>({ style: "stylized-game", bodyProportions: "small body, oversized readable armor", viewDirection: "right", mainHandEquipment: "simple iron sword", offHandEquipment: "round blue shield", hair: "short brown hair", headwear: "polished silver helmet", characterScale: "small", artResolution: "512", background: "transparent" });
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [selectedBoneId, setSelectedBoneId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("Describe the character, then generate source art");
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPromptDebug, setShowPromptDebug] = useState(false);
  const [brushMode, setBrushMode] = useState<"add" | "remove">("add");
  const [brushDown, setBrushDown] = useState(false);
  const [rotationCheck, setRotationCheck] = useState(0);
  const [smoke, setSmoke] = useState<RigSmokeTestResult | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef(project);
  const provider = useMemo<CharacterPipelineProvider>(() => {
    const endpoint = process.env.NEXT_PUBLIC_CHARACTER_PIPELINE_ENDPOINT;
    return endpoint ? new HttpCharacterPipelineProvider(endpoint) : new MockCharacterPipelineProvider();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => { void characterStorage.load().then((restored) => {
      if (cancelled) return;
      const normalized = restored?.success ? normalizeProjectWarnings(restored.data) : null;
      if (normalized && commandService.restoreProjectFromDraft(normalized)) {
        setSelectedPartId(normalized.segmentationData?.parts[0]?.id ?? null);
        setMessage("Local character project restored from IndexedDB");
      } else if (restored && !restored.success) setPersistenceWarning(restored.message);
    }); }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [characterStorage, commandService]);
  useEffect(() => {
    projectRef.current = project;
    commandService.syncProjectFromUi(project, "startup");
  }, [commandService, project]);
  useEffect(() => commandService.attachCharacterProject({
    getProject: () => projectRef.current,
    replaceProject: (next) => { const normalized = normalizeProjectWarnings(next); projectRef.current = normalized; setProject(normalized); },
  }), [commandService]);
  useEffect(() => { let cancelled = false; const timer = window.setTimeout(() => { void characterStorage.save(project).then((result) => { if (!cancelled) setPersistenceWarning(result.success ? null : `Draft kept in memory. ${result.layer} failed: ${result.message}`); }); }, 300); return () => { cancelled = true; window.clearTimeout(timer); }; }, [characterStorage, project]);

  const stageIndex = STAGES.findIndex((stage) => stage.id === project.stage);
  const selectedPart = project.segmentationData?.parts.find((part) => part.id === selectedPartId) ?? null;

  const run = useCallback(async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(label); setError(null);
    try { await action(); setMessage(label); } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : `${label} failed`); }
    finally { setBusy(null); }
  }, []);

  const generate = (mode: "generate" | "regenerate" | "variant"): Promise<void> => run(mode === "variant" ? "Variant ready for review" : "Source image ready for review", async () => {
    const built = buildCharacterGenerationPrompt({ description: project.originalUserPrompt, controls });
    const request = { userPrompt: project.originalUserPrompt, generationPrompt: built.prompt, negativePrompt: built.negativePrompt, controls, sourceGenerationId: project.sourceImage?.generationId };
    const result = mode === "generate" ? await provider.generateCharacter(request) : mode === "regenerate" ? await provider.regenerateCharacter(request) : await provider.generateVariant(request);
    setProject((current) => updateProject(current, {
      stage: "generate", generationPrompt: built.prompt,
      generationMetadata: { provider: result.provider, preset: built.preset, negativePrompt: built.negativePrompt, generationMode: result.generationMode, novelArtwork: result.novelArtwork, sourceArtifact: result.sourceArtifact },
      generationHistory: [...current.generationHistory, result], sourceImage: result, suitability: undefined, segmentationData: undefined,
      extractedParts: [], reconstructedParts: [], rigDefinition: undefined, skins: [], warnings: result.warnings,
    }));
  });

  const checkSuitability = (): Promise<void> => run("Rig suitability check complete", async () => {
    if (!project.sourceImage) throw new Error("Generate an image first");
    const suitability = await provider.checkSuitability({ image: project.sourceImage.image, width: project.sourceImage.width, height: project.sourceImage.height, userPrompt: project.originalUserPrompt });
    setProject((current) => updateProject(current, { suitability, warnings: [...current.warnings, ...suitability.issues.map((issue) => issue.message)] }));
  });

  const acceptImage = (): Promise<void> => run("Character parts detected · review every warning", async () => {
    if (!project.sourceImage) throw new Error("Generate an image first");
    if (!provider.capabilities.segmentation.available || !provider.capabilities.segmentation.imageConditioned) {
      throw new Error("Automatic image-conditioned cutting is unavailable. Open Part Cutter and use the manual Smart Select, Lasso, Polygon, or Brush tools.");
    }
    const suitability = project.suitability ?? await provider.checkSuitability({ image: project.sourceImage.image, width: project.sourceImage.width, height: project.sourceImage.height, userPrompt: project.originalUserPrompt });
    const response = await provider.segmentCharacter({ generationId: project.sourceImage.generationId, image: project.sourceImage.image, width: project.sourceImage.width, height: project.sourceImage.height, expectedEquipment: [controls.mainHandEquipment ?? "", controls.offHandEquipment ?? ""].filter(Boolean) });
    const validation = validateSegmentationResponse(response); if (!validation.success || !validation.data) throw new Error([...validation.errors, ...validation.warnings].join("; "));
    const reviews = detectOcclusionReviews(validation.data.parts);
    setProject((current) => updateProject(current, { stage: "prepare", suitability, segmentationData: validation.data, reconstructedParts: reviews, warnings: [...current.warnings, ...validation.warnings] }));
    setSelectedPartId(validation.data.parts[0]?.id ?? null);
  });

  const updatePart = (id: string, transform: (part: ProposedCharacterPart) => ProposedCharacterPart, correction?: string): void => {
    setProject((current) => {
      if (!current.segmentationData) return current;
      return updateProject(current, { segmentationData: { ...current.segmentationData, parts: current.segmentationData.parts.map((part) => part.id === id ? transform(part) : part) }, userCorrections: correction ? [...current.userCorrections, { stage: "prepare", description: correction, timestamp: now() }] : current.userCorrections });
    });
  };
  const patchPart = (patch: Partial<ProposedCharacterPart>, correction?: string): void => { if (selectedPart) updatePart(selectedPart.id, (part) => ({ ...part, ...patch, provenance: correction ? "manual" : part.provenance }), correction); };

  const splitPart = (): void => {
    if (!selectedPart || !project.segmentationData) return;
    const first = { ...selectedPart, id: `${selectedPart.id}-a`, name: `${selectedPart.name} A`, bounds: { ...selectedPart.bounds, width: selectedPart.bounds.width / 2 }, sourceImageRegion: { ...selectedPart.sourceImageRegion, width: selectedPart.sourceImageRegion.width / 2 }, provenance: "manual" as const };
    const second = { ...selectedPart, id: `${selectedPart.id}-b`, name: `${selectedPart.name} B`, bounds: { ...selectedPart.bounds, x: selectedPart.bounds.x + selectedPart.bounds.width / 2, width: selectedPart.bounds.width / 2 }, sourceImageRegion: { ...selectedPart.sourceImageRegion, x: selectedPart.sourceImageRegion.x + selectedPart.sourceImageRegion.width / 2, width: selectedPart.sourceImageRegion.width / 2 }, provenance: "manual" as const };
    setProject((current) => current.segmentationData ? updateProject(current, { segmentationData: { ...current.segmentationData, parts: current.segmentationData.parts.flatMap((part) => part.id === selectedPart.id ? [first, second] : [part]) }, userCorrections: [...current.userCorrections, { stage: "prepare", description: `Split ${selectedPart.id}`, timestamp: now() }] }) : current);
    setSelectedPartId(first.id);
  };
  const mergePart = (): void => {
    if (!selectedPart || !project.segmentationData) return; const index = project.segmentationData.parts.findIndex((part) => part.id === selectedPart.id); const target = project.segmentationData.parts[index - 1]; if (!target) return;
    const x = Math.min(target.bounds.x, selectedPart.bounds.x); const y = Math.min(target.bounds.y, selectedPart.bounds.y); const right = Math.max(target.bounds.x + target.bounds.width, selectedPart.bounds.x + selectedPart.bounds.width); const bottom = Math.max(target.bounds.y + target.bounds.height, selectedPart.bounds.y + selectedPart.bounds.height);
    const merged = { ...target, name: `${target.name} + ${selectedPart.name}`, bounds: { x, y, width: right - x, height: bottom - y }, sourceImageRegion: { x, y, width: right - x, height: bottom - y }, warnings: [...new Set([...target.warnings, ...selectedPart.warnings])], provenance: "manual" as const };
    setProject((current) => current.segmentationData ? updateProject(current, { segmentationData: { ...current.segmentationData, parts: current.segmentationData.parts.map((part) => part.id === target.id ? merged : part).filter((part) => part.id !== selectedPart.id) }, userCorrections: [...current.userCorrections, { stage: "prepare", description: `Merged ${selectedPart.id} into ${target.id}`, timestamp: now() }] }) : current);
    setSelectedPartId(target.id);
  };
  const addMissingPart = (): void => {
    if (!project.segmentationData) return; let suffix = 1; const ids = new Set(project.segmentationData.parts.map((part) => part.id)); while (ids.has(`manual-part-${suffix}`)) suffix += 1;
    const part: ProposedCharacterPart = { id: `manual-part-${suffix}`, name: `Manual part ${suffix}`, semanticType: "accessory", confidence: 1, confidenceSource: "heuristic", bounds: { x: 96, y: 120, width: 64, height: 64 }, sourceImageRegion: { x: 96, y: 120, width: 64, height: 64 }, suggestedBoneId: "torso", suggestedSlotId: `manual-part-${suffix}-slot`, suggestedZIndex: 12, pivotHint: { x: 128, y: 128 }, warnings: [], accepted: true, provenance: "manual" };
    setProject((current) => current.segmentationData ? updateProject(current, { segmentationData: { ...current.segmentationData, parts: [...current.segmentationData.parts, part] }, userCorrections: [...current.userCorrections, { stage: "prepare", description: `Added ${part.id}`, timestamp: now() }] }) : current); setSelectedPartId(part.id);
  };

  const applyMaskBrush = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (!selectedPart || (!brushDown && event.type !== "pointerdown")) return; const svg = event.currentTarget; const bounds = svg.getBoundingClientRect(); const x = (event.clientX - bounds.left) / bounds.width * (project.sourceImage?.width ?? 256); const y = (event.clientY - bounds.top) / bounds.height * (project.sourceImage?.height ?? 320);
    if (x < selectedPart.bounds.x || y < selectedPart.bounds.y || x > selectedPart.bounds.x + selectedPart.bounds.width || y > selectedPart.bounds.y + selectedPart.bounds.height) return;
    const width = Math.max(1, Math.round(selectedPart.bounds.width)); const height = Math.max(1, Math.round(selectedPart.bounds.height)); const alpha = [...(selectedPart.mask?.alpha ?? new Array<number>(width * height).fill(255))]; const localX = Math.round(x - selectedPart.bounds.x); const localY = Math.round(y - selectedPart.bounds.y); const radius = 7;
    for (let py = Math.max(0, localY - radius); py < Math.min(height, localY + radius); py += 1) for (let px = Math.max(0, localX - radius); px < Math.min(width, localX + radius); px += 1) if (Math.hypot(px - localX, py - localY) <= radius) alpha[py * width + px] = brushMode === "add" ? 255 : 0;
    const mask: SegmentationMask = { width, height, alpha }; patchPart({ mask }, `Adjusted ${selectedPart.id} mask`);
  };

  const setOcclusionDecision = (partId: string, decision: OcclusionDecision): void => setProject((current) => updateProject(current, { reconstructedParts: current.reconstructedParts.map((review) => review.partId === partId ? { ...review, decision } : review), userCorrections: [...current.userCorrections, { stage: "prepare", description: `${partId}: ${decision}`, timestamp: now() }] }));
  const reconstruct = (partId: string): Promise<void> => run(`Reconstruction ready for ${partId} · accept or reject it`, async () => {
    const part = project.segmentationData?.parts.find((candidate) => candidate.id === partId); if (!part || !project.sourceImage) throw new Error("The selected part is unavailable");
    const result = await provider.reconstructPart({ generationId: project.sourceImage.generationId, image: project.sourceImage.image, part, stylePrompt: project.generationPrompt });
    setProject((current) => updateProject(current, { reconstructedParts: current.reconstructedParts.map((review) => review.partId === partId ? { ...review, decision: "reconstruct", reconstructedImage: result.image, reconstructionAccepted: false } : review) }));
  });

  const prepareRig = (): Promise<void> => run("Rig proposal generated · inspect joints and pivots", async () => {
    if (!project.segmentationData || !project.sourceImage) throw new Error("Prepare character parts first");
    const accepted = project.segmentationData.parts.filter((part) => part.accepted); if (!accepted.length) throw new Error("Accept at least one part");
    const extracted = await Promise.all(accepted.map(async (part) => {
      const repair = project.reconstructedParts.find((review) => review.partId === part.id && review.reconstructionAccepted);
      const image = repair?.reconstructedImage ?? part.fixtureImagePath ?? await extractPartToDataUrl(project.sourceImage!.image, part.bounds, part.mask, 4);
      return { partId: part.id, image, width: part.bounds.width + 8, height: part.bounds.height + 8, padding: 4, status: repair ? "reconstructed" as const : part.provenance };
    }));
    const resolvedImages = Object.fromEntries(extracted.map((part) => [part.partId, part.image]));
    const proposal = buildRigProposal({ name: project.name, parts: accepted, imageWidth: project.sourceImage.width, imageHeight: project.sourceImage.height, resolvedImages });
    const unresolved = project.reconstructedParts.filter((review) => review.decision === "unreviewed").map((review) => review.partId);
    const rig = { ...proposal.rig, metadata: { ...proposal.rig.metadata, occlusionWarnings: unresolved } };
    const validated = validateRigProposal({ ...proposal, rig }); if (!validated.success) throw new Error(validated.message);
    setProject((current) => updateProject(current, { stage: "rig", extractedParts: extracted, rigDefinition: rig, skins: rig.skins, warnings: [...current.warnings, ...proposal.warnings] })); setSelectedBoneId(rig.rootBoneId);
  });

  const patchRig = (transform: (rig: RigDefinition) => RigDefinition, correction: string): void => setProject((current) => current.rigDefinition ? updateProject(current, { rigDefinition: transform(current.rigDefinition), userCorrections: [...current.userCorrections, { stage: "rig", description: correction, timestamp: now() }] }) : current);
  const moveBoneWorld = (boneId: string, point: { x: number; y: number }): void => patchRig((rig) => {
    const target = rig.bones.find((bone) => bone.id === boneId); if (!target) return rig; let local = point;
    if (target.parentId) { const parent = computeWorldTransforms(rig, createRestPose(rig))[target.parentId]; const inverse = parent ? invertMatrix(parent.matrix) : null; if (inverse) local = transformPoint(inverse, point); }
    return { ...rig, bones: rig.bones.map((bone) => bone.id === boneId ? { ...bone, x: local.x, y: local.y } : bone) };
  }, `Moved joint ${boneId}`);

  const runSmoke = (): void => { if (!project.rigDefinition) return; const result = runRigSmokeTest(project.rigDefinition); setSmoke(result); setProject((current) => updateProject(current, { stage: "test" })); setMessage(result.passed ? "All automatic rig checks passed" : "Smoke test complete · review warnings before animation"); };
  const openEditor = (): void => { void run("Opening rig editor", async () => { const next = updateProject(project, { stage: "edit" }); const saved = await characterStorage.save(next); if (!saved.success) setPersistenceWarning(`Rig remains open in memory, but ${saved.layer} failed: ${saved.message}`); writeRigEditorHandoffPointer(window.localStorage, next); setProject(next); window.location.assign("/"); }); };
  const startOver = (): void => setConfirmStartOver(true);
  const confirmStartOverProject = (): void => { void characterStorage.discard(project.id).then(() => { const next = createGeneratedCharacterProject("Untitled Character", ""); commandService.activateProjectFromUi(next); setProject(next); setSelectedPartId(null); setSelectedBoneId(null); setSmoke(null); setError(null); setMessage("New character project ready"); setConfirmStartOver(false); }); };

  const exportProject = (): Promise<void> => run("Portable character project exported", async () => downloadBlob(await createCharacterProjectZip(project), `${project.id}.character.zip`));
  const exportJson = (): void => downloadBlob(new Blob([serializeGeneratedCharacterProject(project)], { type: "application/json" }), `${project.id}.character.json`);
  const importProject = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    await run("Character project imported", async () => {
      let data: GeneratedCharacterProject;
      if (file.name.endsWith(".zip")) data = importCharacterProjectArchive(new Uint8Array(await file.arrayBuffer()));
      else { const input = JSON.parse(await file.text()) as unknown; const parsed = parseGeneratedCharacterProject(input); if (!parsed.success) throw new Error(parsed.message); data = parsed.data; }
      commandService.activateProjectFromUi(data); setSelectedPartId(data.segmentationData?.parts[0]?.id ?? null); setSelectedBoneId(data.rigDefinition?.rootBoneId ?? null); setSmoke(data.rigDefinition ? runRigSmokeTest(data.rigDefinition) : null);
    });
  };

  const agentStatus = presentAgentStatus(agentSession);
  const segmentationAvailable = provider.capabilities.segmentation.available && provider.capabilities.segmentation.imageConditioned;
  return <main className="character-workspace">
    <input ref={importRef} hidden type="file" accept="application/json,.json,.zip,application/zip" onChange={(event) => void importProject(event)} />
    <header className="character-topbar"><Link href="/" className="character-mark">RS</Link><div><strong>Create Character</strong><span>{project.name}</span></div><nav>{STAGES.map((stage, index) => <button key={stage.id} type="button" className={project.stage === stage.id ? "active" : index < stageIndex ? "complete" : ""} disabled={index > stageIndex + 1 || (stage.id === "rig" && !project.segmentationData) || (stage.id === "test" && !project.rigDefinition)} onClick={() => setProject((current) => updateProject(current, { stage: stage.id }))}><b>{index + 1}</b>{stage.label}</button>)}</nav><span className={`character-agent-state ${agentStatus.ready ? "connected" : agentStatus.state}`}>{agentStatus.label}</span><div className="character-file-tools"><button type="button" onClick={startOver}>New</button><button type="button" onClick={() => importRef.current?.click()}>Import</button><Link href="/part-cutter">Part cutter</Link><button type="button" onClick={exportJson}>Project JSON</button><button type="button" onClick={() => void exportProject()} disabled={Boolean(busy)}>Project ZIP</button><Link href="/">Rig editor</Link></div></header>
    {persistenceWarning && <div className="character-storage-warning" role="status"><strong>Draft storage needs attention</strong><span>{persistenceWarning}</span><button type="button" onClick={() => { void characterStorage.save(projectRef.current).then((result) => setPersistenceWarning(result.success ? null : `Retry failed in ${result.layer}: ${result.message}`)); }}>Retry save</button></div>}
    <section className="character-stage">
      {project.stage === "describe" && <DescribeStage project={project} controls={controls} showAdvanced={showAdvanced} showDebug={showPromptDebug} onPrompt={(value) => setProject((current) => updateProject(current, { originalUserPrompt: value }))} onName={(value) => setProject((current) => updateProject(current, { name: value }))} onControls={setControls} onAdvanced={() => setShowAdvanced((value) => !value)} onDebug={() => setShowPromptDebug((value) => !value)} onGenerate={() => void generate("generate")} busy={busy} />}
      {project.stage === "generate" && <GenerateStage project={project} providerName={provider.name} segmentationAvailable={segmentationAvailable} onRegenerate={() => void generate("regenerate")} onVariant={() => void generate("variant")} onSuitability={() => void checkSuitability()} onAccept={() => void acceptImage()} onEdit={() => setProject((current) => updateProject(current, { stage: "describe" }))} busy={busy} />}
      {project.stage === "prepare" && <PrepareStage project={project} selectedPart={selectedPart} brushMode={brushMode} onSelect={setSelectedPartId} onPartPatch={patchPart} onRemove={() => { if (selectedPart) setProject((current) => current.segmentationData ? updateProject(current, { segmentationData: { ...current.segmentationData, parts: current.segmentationData.parts.filter((part) => part.id !== selectedPart.id) } }) : current); }} onAdd={addMissingPart} onSplit={splitPart} onMerge={mergePart} onBrushMode={setBrushMode} onResetMask={() => patchPart({ mask: undefined }, selectedPart ? `Reset ${selectedPart.id} mask` : undefined)} onBrushStart={(event) => { setBrushDown(true); applyMaskBrush(event); }} onBrushMove={applyMaskBrush} onBrushEnd={() => setBrushDown(false)} onOcclusion={setOcclusionDecision} onReconstruct={(partId) => void reconstruct(partId)} onAcceptReconstruction={(partId, image) => setProject((current) => updateProject(current, { reconstructedParts: current.reconstructedParts.map((review) => review.partId === partId ? acceptReconstruction(review, image) : review) }))} onRejectReconstruction={(partId) => setProject((current) => updateProject(current, { reconstructedParts: current.reconstructedParts.map((review) => review.partId === partId ? rejectReconstruction(review) : review) }))} onContinue={() => void prepareRig()} busy={busy} />}
      {project.stage === "rig" && project.rigDefinition && <RigStage project={project} selectedBoneId={selectedBoneId} rotationCheck={rotationCheck} onSelectBone={setSelectedBoneId} onMoveBone={moveBoneWorld} onRotationCheck={setRotationCheck} onBonePatch={(id, patch) => patchRig((rig) => ({ ...rig, bones: rig.bones.map((bone) => bone.id === id ? { ...bone, ...patch } : bone) }), `Adjusted bone ${id}`)} onSlotPatch={(id, zIndex) => patchRig((rig) => ({ ...rig, slots: rig.slots.map((slot) => slot.id === id ? { ...slot, zIndex } : slot) }), `Adjusted slot ${id}`)} onTest={runSmoke} />}
      {project.stage === "test" && project.rigDefinition && <TestStage project={project} smoke={smoke ?? runRigSmokeTest(project.rigDefinition)} onRun={runSmoke} onBack={() => setProject((current) => updateProject(current, { stage: "rig" }))} onOpen={openEditor} />}
      {project.stage === "edit" && <EditStage onOpen={openEditor} onExport={() => void exportProject()} />}
    </section>
    <footer className="character-status"><span>{busy ? `Working · ${busy}` : "Ready"}</span><span>Provider · {provider.name}</span><span>{project.segmentationData ? `${project.segmentationData.parts.filter((part) => part.accepted).length} accepted parts` : "No prepared parts"}</span><span>{project.rigDefinition ? `${project.rigDefinition.bones.length} bones · ${project.rigDefinition.slots.length} slots` : "Rig not generated"}</span><span className={error ? "error" : ""}>{error ?? message}</span></footer>
    <StudioDialog open={confirmStartOver} title="Start a new character?" description="The current local character draft and its stored assets will be discarded. Export it first if you may need it later." confirmLabel="Start over" danger onCancel={() => setConfirmStartOver(false)} onConfirm={confirmStartOverProject} />
  </main>;
}

type DescribeProps = { readonly project: GeneratedCharacterProject; readonly controls: CharacterPromptControls; readonly showAdvanced: boolean; readonly showDebug: boolean; readonly onPrompt: (value: string) => void; readonly onName: (value: string) => void; readonly onControls: (value: CharacterPromptControls) => void; readonly onAdvanced: () => void; readonly onDebug: () => void; readonly onGenerate: () => void; readonly busy: string | null };
function DescribeStage(props: DescribeProps) {
  const built = useMemo(() => { try { return buildCharacterGenerationPrompt({ description: props.project.originalUserPrompt, controls: props.controls }); } catch { return null; } }, [props.controls, props.project.originalUserPrompt]);
  const patch = (key: keyof CharacterPromptControls, value: string): void => props.onControls({ ...props.controls, [key]: value || undefined });
  return <div className="describe-layout"><section className="description-main"><div className="stage-kicker">Character description</div><h1>Describe the source art you need to rig.</h1><label className="field"><span>Project name</span><input value={props.project.name} onChange={(event) => props.onName(event.target.value)} /></label><label className="prompt-field"><span>Natural-language prompt</span><textarea value={props.project.originalUserPrompt} onChange={(event) => props.onPrompt(event.target.value)} rows={8} /><small>Ask for a neutral, readable side view. The pipeline adds modular-art constraints automatically.</small></label><div className="action-row"><button type="button" className="primary" onClick={props.onGenerate} disabled={Boolean(props.busy) || !props.project.originalUserPrompt.trim()}>Generate character</button><button type="button" onClick={props.onAdvanced}>{props.showAdvanced ? "Hide controls" : "Optional controls"}</button><button type="button" onClick={props.onDebug}>{props.showDebug ? "Hide generated prompt" : "Prompt debug"}</button></div>{props.showDebug && <pre className="prompt-debug">{built ? `${built.prompt}\n\nAVOID\n${built.negativePrompt}` : "Enter a description"}</pre>}</section><aside className={`structured-controls ${props.showAdvanced ? "open" : ""}`}><div className="panel-title"><span>Generation controls</span><small>Optional</small></div><Control label="Style" value={props.controls.style} options={["stylized-game", "pixel-art", "painted-2d", "flat-cartoon"]} onChange={(value) => patch("style", value)} /><Control label="Direction" value={props.controls.viewDirection} options={["right", "left"]} onChange={(value) => patch("viewDirection", value)} /><TextControl label="Proportions" value={props.controls.bodyProportions} onChange={(value) => patch("bodyProportions", value)} /><TextControl label="Species" value={props.controls.species} onChange={(value) => patch("species", value)} /><TextControl label="Armor / clothing" value={props.controls.clothingStyle} onChange={(value) => patch("clothingStyle", value)} /><TextControl label="Main hand" value={props.controls.mainHandEquipment} onChange={(value) => patch("mainHandEquipment", value)} /><TextControl label="Off hand" value={props.controls.offHandEquipment} onChange={(value) => patch("offHandEquipment", value)} /><TextControl label="Hair" value={props.controls.hair} onChange={(value) => patch("hair", value)} /><TextControl label="Headwear" value={props.controls.headwear} onChange={(value) => patch("headwear", value)} /><TextControl label="Cape" value={props.controls.cape} onChange={(value) => patch("cape", value)} /><TextControl label="Tail" value={props.controls.tail} onChange={(value) => patch("tail", value)} /><Control label="Resolution" value={props.controls.artResolution} options={["256", "512", "1024"]} onChange={(value) => patch("artResolution", value)} /><Control label="Background" value={props.controls.background} options={["transparent", "flat-contrast"]} onChange={(value) => patch("background", value)} /></aside></div>;
}

function GenerateStage({ project, providerName, segmentationAvailable, onRegenerate, onVariant, onSuitability, onAccept, onEdit, busy }: { readonly project: GeneratedCharacterProject; readonly providerName: string; readonly segmentationAvailable: boolean; readonly onRegenerate: () => void; readonly onVariant: () => void; readonly onSuitability: () => void; readonly onAccept: () => void; readonly onEdit: () => void; readonly busy: string | null }) {
  const image = project.sourceImage; if (!image) return <div className="stage-empty">No source image. Return to Describe and generate one.</div>;
  const sourceLabel = image.generationMode === "imported_external" ? "Novel external generation" : image.generationMode === "fixture" ? "Development fixture · not novel" : "Provider-generated artwork";
  return <div className="review-layout"><section className="image-review"><div className="checkerboard"><img src={image.image} alt="Generated character source" /></div><div className="image-meta"><span>{image.width} × {image.height}</span><span>{sourceLabel}</span><span>{image.provider || providerName}</span></div></section><aside className="review-panel"><div className="stage-kicker">Generated-image review</div><h2>Confirm this source can become movable parts.</h2><p>{sourceLabel} · {image.generationId}</p>{!segmentationAvailable && <p className="warning">Automatic image-conditioned cutting is unavailable. Use the manual tools in Part Cutter; the local fixture will not be presented as AI analysis.</p>}<div className="action-stack"><button className="primary" type="button" onClick={onAccept} disabled={Boolean(busy) || !segmentationAvailable}>{segmentationAvailable ? "Accept & detect parts" : "Segmentation unavailable"}</button><button type="button" onClick={onSuitability} disabled={Boolean(busy)}>Run rig suitability check</button><div><button type="button" onClick={onRegenerate} disabled={Boolean(busy)}>Regenerate</button><button type="button" onClick={onVariant} disabled={Boolean(busy)}>Generate variant</button></div><button type="button" onClick={onEdit}>Edit prompt</button></div>{project.suitability && <div className="suitability"><div><strong>{Math.round(project.suitability.score * 100)}%</strong><span>{project.suitability.usable ? "Usable with review" : "Regeneration recommended"}</span></div><p>{project.suitability.summary}</p>{project.suitability.issues.map((issue) => <article key={`${issue.type}-${issue.message}`} data-severity={issue.severity}><b>{issue.type.replaceAll("-", " ")}</b><span>{issue.message}</span><small>{Math.round(issue.confidence * 100)}% confidence</small></article>)}</div>}<details><summary>Data sent to provider</summary><p>The character prompt, generation constraints, and this source image only. No editor files or API credentials are sent.</p></details></aside></div>;
}

type PrepareProps = { readonly project: GeneratedCharacterProject; readonly selectedPart: ProposedCharacterPart | null; readonly brushMode: "add" | "remove"; readonly onSelect: (id: string) => void; readonly onPartPatch: (patch: Partial<ProposedCharacterPart>, correction?: string) => void; readonly onRemove: () => void; readonly onAdd: () => void; readonly onSplit: () => void; readonly onMerge: () => void; readonly onBrushMode: (mode: "add" | "remove") => void; readonly onResetMask: () => void; readonly onBrushStart: (event: ReactPointerEvent<SVGSVGElement>) => void; readonly onBrushMove: (event: ReactPointerEvent<SVGSVGElement>) => void; readonly onBrushEnd: () => void; readonly onOcclusion: (partId: string, decision: OcclusionDecision) => void; readonly onReconstruct: (partId: string) => void; readonly onAcceptReconstruction: (partId: string, image: string) => void; readonly onRejectReconstruction: (partId: string) => void; readonly onContinue: () => void; readonly busy: string | null };
function PrepareStage(props: PrepareProps) {
  const segmentation = props.project.segmentationData; const source = props.project.sourceImage; if (!segmentation || !source) return <div className="stage-empty">Segmentation data is unavailable.</div>;
  const patchBounds = (key: keyof Rect, value: number): void => { if (props.selectedPart) props.onPartPatch({ bounds: { ...props.selectedPart.bounds, [key]: value }, sourceImageRegion: { ...props.selectedPart.sourceImageRegion, [key]: value } }, `Adjusted ${props.selectedPart.id} crop`); };
  return <div className="prepare-layout"><aside className="parts-panel"><div className="panel-title"><span>Detected parts</span><small>{segmentation.parts.length}</small></div><div className="parts-list">{segmentation.parts.map((part) => <button key={part.id} type="button" className={part.id === props.selectedPart?.id ? "selected" : ""} onClick={() => props.onSelect(part.id)}><i style={{ background: part.accepted ? "#61d6b0" : "#59656a" }} /><span>{part.name}</span><small>{part.confidence === null ? "Unavailable" : `${Math.round(part.confidence * 100)}%`}</small></button>)}</div><div className="compact-actions"><button type="button" onClick={props.onAdd}>+ Add missing</button><button type="button" onClick={props.onMerge} disabled={!props.selectedPart}>Merge prior</button><button type="button" onClick={props.onSplit} disabled={!props.selectedPart}>Split 50/50</button></div><div className="occlusion-list"><div className="panel-title"><span>Occlusion repair</span><small>{props.project.reconstructedParts.length}</small></div>{props.project.reconstructedParts.length === 0 && <p>No likely hidden regions.</p>}{props.project.reconstructedParts.map((review) => <article key={review.partId}><strong>{review.partId}</strong><p>{review.reason}</p><select value={review.decision} onChange={(event) => props.onOcclusion(review.partId, event.target.value as OcclusionDecision)}><option value="unreviewed">Needs decision</option><option value="keep-visible-fragment">Keep visible fragment</option><option value="acceptable">Mark acceptable</option><option value="regenerate-source">Regenerate source</option><option value="reconstruct">AI reconstruct</option></select>{review.decision === "reconstruct" && !review.reconstructedImage && <button type="button" onClick={() => props.onReconstruct(review.partId)}>Request reconstruction</button>}{review.reconstructedImage && <div className="repair-compare"><img src={segmentation.parts.find((part) => part.id === review.partId)?.fixtureImagePath ?? source.image} alt="Before repair" /><img src={review.reconstructedImage} alt="Reconstructed part" /><button type="button" onClick={() => props.onAcceptReconstruction(review.partId, review.reconstructedImage!)}>Accept</button><button type="button" onClick={() => props.onRejectReconstruction(review.partId)}>Reject</button><small>{review.reconstructionAccepted ? "Accepted reconstructed pixels" : "Not accepted"}</small></div>}</article>)}</div></aside><section className="prepare-canvas"><div className="mask-toolbar"><span>Mask correction</span><button type="button" className={props.brushMode === "add" ? "active" : ""} onClick={() => props.onBrushMode("add")}>Add brush</button><button type="button" className={props.brushMode === "remove" ? "active" : ""} onClick={() => props.onBrushMode("remove")}>Remove / eraser</button><button type="button" onClick={props.onResetMask}>Reset mask</button><small>Drag inside the selected crop</small></div><div className="source-overlay" style={{ aspectRatio: `${source.width} / ${source.height}` }}><img src={source.image} alt="Source character with part overlays" /><svg viewBox={`0 0 ${source.width} ${source.height}`} onPointerDown={props.onBrushStart} onPointerMove={props.onBrushMove} onPointerUp={props.onBrushEnd} onPointerLeave={props.onBrushEnd}>{segmentation.parts.map((part) => <g key={part.id} className={part.id === props.selectedPart?.id ? "selected" : ""}><rect x={part.bounds.x} y={part.bounds.y} width={part.bounds.width} height={part.bounds.height} /><circle cx={part.pivotHint.x} cy={part.pivotHint.y} r={3} /><text x={part.bounds.x + 2} y={part.bounds.y + 9}>{part.name}</text></g>)}</svg></div><div className="prepare-note">Blue boxes are generated. Cyan marks the selected crop and pivot. Brush corrections are stored as a per-part alpha mask.</div></section><aside className="part-inspector">{props.selectedPart ? <><div className="panel-title"><span>Part inspector</span><small>{props.selectedPart.provenance}</small></div><label><span>Name</span><input value={props.selectedPart.name} onChange={(event) => props.onPartPatch({ name: event.target.value }, `Renamed ${props.selectedPart!.id}`)} /></label><label><span>Semantic</span><select value={props.selectedPart.semanticType} onChange={(event) => props.onPartPatch({ semanticType: event.target.value as PartType }, `Reassigned ${props.selectedPart!.id}`)}>{PART_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label><label className="check"><input type="checkbox" checked={props.selectedPart.accepted} onChange={(event) => props.onPartPatch({ accepted: event.target.checked, provenance: event.target.checked ? "accepted" : props.selectedPart!.provenance }, `${event.target.checked ? "Accepted" : "Rejected"} ${props.selectedPart!.id}`)} />Accept part</label><div className="field-grid"><NumberField label="Crop X" value={props.selectedPart.bounds.x} onChange={(value) => patchBounds("x", value)} /><NumberField label="Crop Y" value={props.selectedPart.bounds.y} onChange={(value) => patchBounds("y", value)} /><NumberField label="Width" value={props.selectedPart.bounds.width} onChange={(value) => patchBounds("width", Math.max(1, value))} /><NumberField label="Height" value={props.selectedPart.bounds.height} onChange={(value) => patchBounds("height", Math.max(1, value))} /><NumberField label="Pivot X" value={props.selectedPart.pivotHint.x} onChange={(value) => props.onPartPatch({ pivotHint: { ...props.selectedPart!.pivotHint, x: value } }, `Adjusted ${props.selectedPart!.id} pivot`)} /><NumberField label="Pivot Y" value={props.selectedPart.pivotHint.y} onChange={(value) => props.onPartPatch({ pivotHint: { ...props.selectedPart!.pivotHint, y: value } }, `Adjusted ${props.selectedPart!.id} pivot`)} /><NumberField label="Z order" value={props.selectedPart.suggestedZIndex} onChange={(value) => props.onPartPatch({ suggestedZIndex: Math.round(value) }, `Adjusted ${props.selectedPart!.id} draw order`)} /></div><label><span>Suggested bone</span><input value={props.selectedPart.suggestedBoneId} onChange={(event) => props.onPartPatch({ suggestedBoneId: event.target.value }, `Reassigned ${props.selectedPart!.id} bone`)} /></label>{props.selectedPart.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}<button type="button" className="danger" onClick={props.onRemove}>Remove part</button></> : <div className="stage-empty">Select a detected part.</div>}<button type="button" className="primary continue" onClick={props.onContinue} disabled={Boolean(props.busy)}>Extract accepted parts & propose rig</button></aside></div>;
}

function RigStage({ project, selectedBoneId, rotationCheck, onSelectBone, onMoveBone, onRotationCheck, onBonePatch, onSlotPatch, onTest }: { readonly project: GeneratedCharacterProject; readonly selectedBoneId: string | null; readonly rotationCheck: number; readonly onSelectBone: (id: string) => void; readonly onMoveBone: (id: string, point: { x: number; y: number }) => void; readonly onRotationCheck: (value: number) => void; readonly onBonePatch: (id: string, patch: Partial<BoneDefinition>) => void; readonly onSlotPatch: (id: string, zIndex: number) => void; readonly onTest: () => void }) {
  const rig = project.rigDefinition!; const selected = rig.bones.find((bone) => bone.id === selectedBoneId) ?? null;
  return <div className="rig-layout"><aside className="rig-tree"><div className="panel-title"><span>Proposed hierarchy</span><small>{rig.bones.length}</small></div>{rig.bones.map((bone) => <button type="button" key={bone.id} className={bone.id === selectedBoneId ? "selected" : ""} style={{ paddingLeft: `${10 + hierarchyDepth(rig, bone.id) * 13}px` }} onClick={() => onSelectBone(bone.id)}><i />{bone.id}<small>{bone.parentId ?? "root"}</small></button>)}<div className="panel-title"><span>Slot draw order</span><small>{rig.slots.length}</small></div>{[...rig.slots].sort((a, b) => b.zIndex - a.zIndex).map((slot) => <label className="slot-row" key={slot.id}><span>{slot.id}</span><input type="number" value={slot.zIndex} onChange={(event) => onSlotPatch(slot.id, event.target.valueAsNumber)} /></label>)}</aside><section className="rig-preview"><div className="rig-preview-toolbar"><span>Rig preview</span><label>Joint rotation check <input type="range" min={-20} max={20} step={20} value={rotationCheck} onChange={(event) => onRotationCheck(event.target.valueAsNumber)} /><b>{rotationCheck}°</b></label><small>Drag cyan joints to adjust</small></div><RigOverlay rig={rig} source={project.sourceImage?.image} selectedBoneId={selectedBoneId} rotationCheck={rotationCheck} onSelect={onSelectBone} onMove={onMoveBone} /></section><aside className="rig-inspector"><div className="panel-title"><span>Bone inspector</span><small>generated → editable</small></div>{selected ? <><strong className="selected-name">{selected.id}</strong><label><span>Parent</span><select value={selected.parentId ?? ""} disabled={selected.id === rig.rootBoneId} onChange={(event) => { const parentId = event.target.value || null; if (!wouldCreateHierarchyCycle(rig.bones, selected.id, parentId)) onBonePatch(selected.id, { parentId }); }}>{rig.bones.filter((bone) => bone.id !== selected.id).map((bone) => <option key={bone.id} value={bone.id}>{bone.id}</option>)}</select></label><div className="field-grid"><NumberField label="X" value={selected.x} onChange={(value) => onBonePatch(selected.id, { x: value })} /><NumberField label="Y" value={selected.y} onChange={(value) => onBonePatch(selected.id, { y: value })} /><NumberField label="Rotation" value={selected.rotation} onChange={(value) => onBonePatch(selected.id, { rotation: value })} /><NumberField label="Length" value={selected.length} onChange={(value) => onBonePatch(selected.id, { length: Math.max(0, value) })} /></div></> : <p>Select a joint.</p>}<div className="rig-warnings"><strong>Proposal notes</strong>{project.warnings.slice(-8).map((warning, index) => <p key={`${index}-${warning}`}>{warning}</p>)}</div><button type="button" className="primary continue" onClick={onTest}>Generate rig & run smoke test</button></aside></div>;
}

function RigOverlay({ rig, source, selectedBoneId, rotationCheck, onSelect, onMove }: { readonly rig: RigDefinition; readonly source?: string; readonly selectedBoneId: string | null; readonly rotationCheck: number; readonly onSelect: (id: string) => void; readonly onMove: (id: string, point: { x: number; y: number }) => void }) {
  const previewRig = useMemo(() => ({ ...rig, bones: rig.bones.map((bone) => bone.id === selectedBoneId ? { ...bone, rotation: bone.rotation + rotationCheck } : bone) }), [rig, rotationCheck, selectedBoneId]);
  const world = useMemo(() => computeWorldTransforms(previewRig, createRestPose(previewRig)), [previewRig]); const dragRef = useRef<string | null>(null);
  const point = (event: ReactPointerEvent<SVGSVGElement>): { x: number; y: number } => { const bounds = event.currentTarget.getBoundingClientRect(); return { x: (event.clientX - bounds.left) / bounds.width * rig.canvas.width, y: (event.clientY - bounds.top) / bounds.height * rig.canvas.height }; };
  return <div className="rig-overlay" style={{ aspectRatio: `${rig.canvas.width} / ${rig.canvas.height}` }}>{source && <img src={source} alt="Rig proposal source" />}<svg viewBox={`0 0 ${rig.canvas.width} ${rig.canvas.height}`} onPointerMove={(event) => { if (dragRef.current) onMove(dragRef.current, point(event)); }} onPointerUp={() => { dragRef.current = null; }} onPointerLeave={() => { dragRef.current = null; }}>{rig.bones.map((bone) => { const transform = world[bone.id]; const angle = transform.rotation; const x2 = transform.x + Math.cos(angle) * bone.length * transform.scaleX; const y2 = transform.y + Math.sin(angle) * bone.length * transform.scaleX; return <g key={bone.id} className={bone.id === selectedBoneId ? "selected" : ""}><line x1={transform.x} y1={transform.y} x2={x2} y2={y2} /><circle cx={transform.x} cy={transform.y} r={bone.id === selectedBoneId ? 6 : 4} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = bone.id; onSelect(bone.id); }} /><text x={transform.x + 7} y={transform.y - 6}>{bone.id}</text></g>; })}</svg></div>;
}

function TestStage({ project, smoke, onRun, onBack, onOpen }: { readonly project: GeneratedCharacterProject; readonly smoke: RigSmokeTestResult; readonly onRun: () => void; readonly onBack: () => void; readonly onOpen: () => void }) {
  return <div className="test-layout"><section><div className="stage-kicker">Quick animation smoke test</div><h2>{smoke.passed ? "The generated rig is ready for animation." : "The rig is usable, with review items."}</h2><p>These deterministic checks exercise the structure needed for idle, arm swing, leg swing, head tilt, and attack posing. Final visual quality still requires human inspection.</p><div className="smoke-checks">{smoke.checks.map((check) => <article key={check.id} className={check.passed ? "pass" : "warn"}><i>{check.passed ? "✓" : "!"}</i><div><strong>{check.id.replaceAll("-", " ")}</strong><span>{check.message}</span></div></article>)}</div><div className="action-row"><button type="button" className="primary" onClick={onOpen}>Open in Rig Editor</button><button type="button" onClick={onRun}>Run checks again</button><button type="button" onClick={onBack}>Adjust rig</button></div></section><aside><div className="panel-title"><span>Generated output</span><small>{project.id}</small></div><dl><dt>Bones</dt><dd>{project.rigDefinition?.bones.length}</dd><dt>Slots</dt><dd>{project.rigDefinition?.slots.length}</dd><dt>Attachments</dt><dd>{project.rigDefinition?.attachments.length}</dd><dt>Skins</dt><dd>{project.skins.length}</dd><dt>Corrections</dt><dd>{project.userCorrections.length}</dd></dl><p>Opening the editor writes a validated local handoff, frames the rig, enables bones, and preserves the character project draft.</p></aside></div>;
}
function EditStage({ onOpen, onExport }: { readonly onOpen: () => void; readonly onExport: () => void }) { return <div className="stage-empty"><h2>Character is ready.</h2><p>Continue in the full Rig Editor or export the portable project.</p><div className="action-row"><button className="primary" onClick={onOpen}>Open Rig Editor</button><button onClick={onExport}>Export project ZIP</button></div></div>; }

function Control({ label, value, options, onChange }: { readonly label: string; readonly value?: string; readonly options: readonly string[]; readonly onChange: (value: string) => void }) { return <label><span>{label}</span><select value={value ?? ""} onChange={(event) => onChange(event.target.value)}><option value="">Auto</option>{options.map((option) => <option key={option}>{option}</option>)}</select></label>; }
function TextControl({ label, value, onChange }: { readonly label: string; readonly value?: string; readonly onChange: (value: string) => void }) { return <label><span>{label}</span><input value={value ?? ""} onChange={(event) => onChange(event.target.value)} /></label>; }
function NumberField({ label, value, onChange }: { readonly label: string; readonly value: number; readonly onChange: (value: number) => void }) { return <label><span>{label}</span><input type="number" value={Number.isFinite(value) ? Number(value.toFixed(2)) : 0} onChange={(event) => { if (Number.isFinite(event.target.valueAsNumber)) onChange(event.target.valueAsNumber); }} /></label>; }
function hierarchyDepth(rig: RigDefinition, id: string): number { let depth = 0; let cursor = rig.bones.find((bone) => bone.id === id)?.parentId ?? null; const seen = new Set<string>(); while (cursor && !seen.has(cursor)) { seen.add(cursor); depth += 1; cursor = rig.bones.find((bone) => bone.id === cursor)?.parentId ?? null; } return depth; }
