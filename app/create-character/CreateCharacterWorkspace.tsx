"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ProfilePicker, type GenerationProfile, type ProfileValues } from "./ProfilePicker";
import { takeStageNotice } from "@/app/studio-ui/stageNotice";
import { buildCharacterGenerationPrompt } from "@/src/character-generation/prompt/characterPromptBuilder";
import type { CharacterPromptControls } from "@/src/character-generation/prompt/generationPreset";
import { HttpCharacterPipelineProvider } from "@/src/character-generation/providers/httpCharacterPipelineProvider";
import { MockCharacterPipelineProvider } from "@/src/character-generation/providers/mockCharacterPipelineProvider";
import type { CharacterPipelineProvider } from "@/src/character-generation/providers/characterPipelineProvider";
import { createGeneratedCharacterProject, parseGeneratedCharacterProject, type GeneratedCharacterProject } from "@/src/character-generation/project/generatedCharacterProject";
import { importCharacterProjectArchive } from "@/src/character-generation/project/projectArchive";
import { getGeneratedCharacterStorage } from "@/src/character-generation/project/generatedCharacterStorage";
import { getRiggingCommandService } from "@/src/agent-control";
import { useAgentBridge } from "@/src/agent-control/protocol/useAgentBridge";
import { StudioDialog } from "@/app/studio-ui/StudioDialog";
import { StepShell } from "@/app/studio-ui/StepShell";
import { ExpandedView } from "@/app/studio-ui/ExpandedView";
import { ChooseArt, CreateArtList, CreateArtView, CreatePanel, DescribeCanvas, type ArtCandidate, type ArtEntry } from "./CreateGuided";
import { ModelCards } from "./ModelCards";
import type { StepState } from "@/app/studio-ui/steps";
import { useProjectHydrationIdentity } from "@/app/studio-ui/ProjectHydrationBoundary";
import { useProviderHealth } from "@/app/studio-ui/useProviderHealth";

const TEST_PROMPT = "Small fantasy knight in polished silver armor with a blue tabard, brown hair, simple iron sword, and round blue shield. Charming stylized 2D game character, clean side view, readable silhouette, modular body parts, neutral stance.";
const now = (): string => new Date().toISOString();
const BRIDGE_URL = process.env.NEXT_PUBLIC_RIGGING_STUDIO_BRIDGE_URL ?? "http://127.0.0.1:47831";
type GeneratorId = "draw_things" | "comfyui" | "studio_fixture";
type GeneratorStatus = { readonly provider: string; readonly label: string; readonly connected: boolean; readonly mode: string; readonly characterGeneration: { readonly available: boolean; readonly reason?: string }; readonly message: string };
type GenerationCandidate = { readonly candidateId: string; readonly imageUrl: string; readonly width: number; readonly height: number; readonly seed: number | null; readonly status: string; readonly providerMetadata?: Readonly<Record<string, unknown>> };
type GenerationProposalReview = { readonly proposalId: string; readonly provider: string; readonly status: string; readonly sourcePrompt: string; readonly progress: { readonly message: string }; readonly candidates: readonly GenerationCandidate[] };
const updateProject = (project: GeneratedCharacterProject, patch: Partial<GeneratedCharacterProject>): GeneratedCharacterProject => ({ ...project, ...patch, updatedAt: now() });
const normalizeProjectWarnings = (project: GeneratedCharacterProject): GeneratedCharacterProject => ({ ...project, warnings: [...new Set(project.warnings)], segmentationData: project.segmentationData ? { ...project.segmentationData, warnings: [...new Set(project.segmentationData.warnings)], parts: project.segmentationData.parts.map((part) => ({ ...part, warnings: [...new Set(part.warnings)] })) } : undefined });
// A job can wait its turn for the Mac Studio (Command Center may be using it), so polling allows half an hour.
const pollGenerationJob = async (jobId: string, onWaiting: (reason: string | null) => void = () => undefined): Promise<{ readonly status: string; readonly proposalId?: string; readonly error?: string }> => {
  for (let attempt = 0; attempt < 2400; attempt += 1) {
    const response = await fetch(`${BRIDGE_URL}/image-generation/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
    const job = await response.json() as { readonly status: string; readonly proposalId?: string; readonly error?: string; readonly waiting?: string };
    if (!response.ok || job.status === "failed" || job.status === "cancelled" || job.status === "completed") return job;
    onWaiting(job.proposalId ? null : job.waiting ?? null);
    await new Promise((resolve) => window.setTimeout(resolve, 750));
  }
  return { status: "failed", error: "Local image generation timed out" };
};

export function CreateCharacterWorkspace() {
  const commandService = useMemo(() => getRiggingCommandService(), []);
  const hydrationIdentity = useProjectHydrationIdentity();
  const { health: providerHealth } = useProviderHealth();
  useAgentBridge(commandService);
  const characterStorage = useMemo(() => getGeneratedCharacterStorage(), []);
  const [project, setProject] = useState<GeneratedCharacterProject>(() => createGeneratedCharacterProject("Fantasy Knight", TEST_PROMPT));
  // Only what applies to every character. Equipment, hair, headwear and facing come from the description unless the user
  // sets them in Advanced: defaults there (a sword, a shield, a helmet) were added to every prompt and overrode what was
  // described, so an elf mage with a staff came out with a knight's helmet and shield.
  const [controls, setControls] = useState<CharacterPromptControls>({ style: "chibi-pixel-art", bodyProportions: "oversized head, compact torso, short separated limbs", characterScale: "small", artResolution: "512", background: "transparent" });
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [selectedBoneId, setSelectedBoneId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // A note left by another stage (the rig editor sends people here when there is no character yet).
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { const pending = takeStageNotice(); if (pending) queueMicrotask(() => setNotice(pending)); }, []);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const [generator, setGenerator] = useState<GeneratorId>("comfyui");
  // ComfyUI generation profiles (model + LoRAs/ControlNet/custom nodes), from the bridge; the benchmark's pick is the default.
  const [profiles, setProfiles] = useState<readonly GenerationProfile[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profileValues, setProfileValues] = useState<ProfileValues>({});
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const loadProfiles = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`${BRIDGE_URL}/image-generation/profiles`, { cache: "no-store" });
      const payload = await response.json() as { readonly profiles?: readonly GenerationProfile[]; readonly error?: string };
      if (!response.ok || !payload.profiles) throw new Error(payload.error ?? "The Studio's profiles could not be loaded");
      setProfiles(payload.profiles); setProfilesError(null);
      setProfileId((current) => current && payload.profiles!.some((item) => item.id === current) ? current : payload.profiles!.find((item) => item.recommended)?.id ?? payload.profiles![0]?.id ?? null);
    } catch (reason: unknown) { setProfilesError(reason instanceof Error ? `${reason.message}. Is the bridge running (npm run mcp)?` : "Profiles unavailable"); }
    finally { setProfilesLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void loadProfiles(), 0); return () => window.clearTimeout(timer); }, [loadProfiles]);
  const importProfile = useCallback(async (profile: unknown): Promise<void> => {
    const response = await fetch(`${BRIDGE_URL}/image-generation/profiles`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(profile) });
    const payload = await response.json() as { readonly id?: string; readonly error?: string };
    if (!response.ok || !payload.id) throw new Error(payload.error ?? "The profile could not be added");
    await loadProfiles(); setProfileId(payload.id); setProfileValues({});
  }, [loadProfiles]);
  const generatorStatuses: readonly GeneratorStatus[] = providerHealth.generationProviders;
  const [generationReview, setGenerationReview] = useState<GenerationProposalReview | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [selectedArtKey, setSelectedArtKey] = useState<string | null>(null);
  const [compareArt, setCompareArt] = useState(false);
  const [artZoom, setArtZoom] = useState(1);
  // "Use this art" approves the picked option; the approved art reaches the project a render later, then Parts opens.
  const continueToParts = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef(project);
  const provider = useMemo<CharacterPipelineProvider>(() => {
    const endpoint = process.env.NEXT_PUBLIC_CHARACTER_PIPELINE_ENDPOINT;
    return endpoint ? new HttpCharacterPipelineProvider(endpoint) : new MockCharacterPipelineProvider();
  }, []);

  useEffect(() => () => provider.cancelPending?.(), [provider]);

  // Until the saved character is restored and registered with the Studio, generating would send a project the bridge does
  // not know yet (it answered 400 and the restore then hid the error), so Generate waits.
  const [restoring, setRestoring] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => { void characterStorage.load().finally(() => { if (!cancelled) window.setTimeout(() => setRestoring(false), 300); }).then((restored) => {
      if (cancelled) return;
      const normalized = restored?.success ? normalizeProjectWarnings(restored.data) : null;
      if (normalized && commandService.restoreProjectFromDraft(normalized)) {
        setSelectedPartId(normalized.segmentationData?.parts[0]?.id ?? null);
        setMessage("Restored your character from this browser");
      } else if (restored && !restored.success) setPersistenceWarning(restored.message);
    }); }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [characterStorage, commandService]);
  // Generated options live on the bridge until one is chosen, so a reload (or coming back later) shows them again instead
  // of the empty description.
  useEffect(() => {
    if (restoring) return;
    let cancelled = false;
    void (async () => {
      const listed = await fetch(`${BRIDGE_URL}/image-production/proposals?projectId=${encodeURIComponent(project.id)}`, { cache: "no-store" }).then((response) => response.ok ? response.json() as Promise<{ readonly proposals?: readonly { readonly proposalId: string; readonly status: string; readonly operationType: string; readonly createdAt: string }[] }> : null).catch(() => null);
      const latest = (listed?.proposals ?? []).filter((proposal) => proposal.status === "awaiting_review" && proposal.operationType === "CHARACTER_GENERATION").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!latest || cancelled) return;
      const payload = await fetch(`${BRIDGE_URL}/image-production/proposals/${encodeURIComponent(latest.proposalId)}/candidates`, { cache: "no-store" }).then((response) => response.ok ? response.json() as Promise<{ readonly proposal?: Omit<GenerationProposalReview, "candidates">; readonly candidates?: readonly GenerationCandidate[] }> : null).catch(() => null);
      if (!cancelled && payload?.proposal) setGenerationReview((current) => current ?? { ...payload.proposal!, candidates: payload.candidates ?? [] });
    })();
    return () => { cancelled = true; };
  }, [restoring, project.id]);
  useEffect(() => {
    projectRef.current = project;
    commandService.syncProjectFromUi(project, "startup");
  }, [commandService, project]);
  useEffect(() => commandService.attachCharacterProject({
    getProject: () => projectRef.current,
    replaceProject: (next) => { const normalized = normalizeProjectWarnings(next); projectRef.current = normalized; setProject(normalized); },
  }), [commandService]);
  useEffect(() => { let cancelled = false; const timer = window.setTimeout(() => { void characterStorage.save(project).then((result) => { if (!cancelled) setPersistenceWarning(result.success ? null : `Draft kept in memory. ${result.layer} failed: ${result.message}`); }); }, 300); return () => { cancelled = true; window.clearTimeout(timer); }; }, [characterStorage, project]);


  useEffect(() => {
    const digest = {
      activeProjectId: hydrationIdentity.activeProjectId, stage: project.stage,
      selectedRegion: selectedPartId, selectedPart: selectedPartId, selectedBone: selectedBoneId,
      selectedAnimation: null, selectedKeyframe: null,
      renderedSourceProjectId: project.sourceImage ? project.id : null,
      renderedRigProjectId: project.rigDefinition ? project.id : null,
    };
    (window as Window & { __RIG_STUDIO_UI_IDENTITY__?: typeof digest }).__RIG_STUDIO_UI_IDENTITY__ = digest;
  }, [hydrationIdentity.activeProjectId, project.id, project.rigDefinition, project.sourceImage, project.stage, selectedBoneId, selectedPartId]);

  const run = useCallback(async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(label); setError(null);
    try { await action(); setMessage(label); } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : `${label} failed`); }
    finally { setBusy(null); }
  }, []);

  const generate = (mode: "generate" | "regenerate" | "variant"): Promise<void> => run(mode === "variant" ? "Variant ready for review" : "Source image ready for review", async () => {
    const operation = commandService.captureProjectOperation(`create-character-${mode}`);
    const built = buildCharacterGenerationPrompt({ description: project.originalUserPrompt, controls });
    if (generator === "draw_things" || generator === "comfyui") {
      const readiness = generatorStatuses.find((item) => item.provider === generator);
      if (!readiness?.characterGeneration.available) throw new Error(readiness?.characterGeneration.reason ?? readiness?.message ?? `${generator} is not ready`);
      setGenerationReview(null);
      setProject((current) => updateProject(current, { stage: "generate", generationPrompt: built.prompt }));
      const response = await fetch(`${BRIDGE_URL}/image-generation/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, provider: generator, prompt: built.prompt, negativePrompt: built.negativePrompt, width: Number(controls.artResolution ?? 768), height: Number(controls.artResolution ?? 768), candidateCount: 3, generationIntent: mode === "variant" ? "character_variant" : "character", stylePreset: "chibi-pixel-art", ...(generator === "comfyui" && profileId ? { profileId, profileParams: profileValues } : {}) }) });
      const started = await response.json() as { readonly jobId?: string; readonly error?: string };
      if (!response.ok || !started.jobId) throw new Error(started.error ?? "Local generation job could not start");
      const completed = await pollGenerationJob(started.jobId, (waiting) => setBusy(waiting ? `Queued for the Mac Studio · ${waiting}` : "Making your character"));
      if (completed.status !== "completed" || !completed.proposalId) throw new Error(completed.error ?? "Local generation failed");
      const proposalResponse = await fetch(`${BRIDGE_URL}/image-production/proposals/${encodeURIComponent(completed.proposalId)}/candidates`, { cache: "no-store" });
      const proposalPayload = await proposalResponse.json() as { readonly proposal?: Omit<GenerationProposalReview, "candidates">; readonly candidates?: readonly GenerationCandidate[]; readonly error?: string };
      if (!proposalResponse.ok || !proposalPayload.proposal) throw new Error(proposalPayload.error ?? "Generation proposal could not be loaded");
      commandService.assertProjectOperationCurrent(operation, "create-character-job");
      setGenerationReview({ ...proposalPayload.proposal, candidates: proposalPayload.candidates ?? [] });
      return;
    }
    const request = { userPrompt: project.originalUserPrompt, generationPrompt: built.prompt, negativePrompt: built.negativePrompt, controls, sourceGenerationId: project.sourceImage?.generationId };
    const result = mode === "generate" ? await provider.generateCharacter(request) : mode === "regenerate" ? await provider.regenerateCharacter(request) : await provider.generateVariant(request);
    commandService.assertProjectOperationCurrent(operation, "create-character-provider");
    setProject((current) => updateProject(current, {
      stage: "generate", generationPrompt: built.prompt,
      generationMetadata: { provider: result.provider, preset: built.preset, negativePrompt: built.negativePrompt, generationMode: result.generationMode, novelArtwork: result.novelArtwork, sourceArtifact: result.sourceArtifact },
      generationHistory: [...current.generationHistory, result], sourceImage: result, suitability: undefined, segmentationData: undefined, partCutterState: undefined,
      extractedParts: [], reconstructedParts: [], rigDefinition: undefined, skins: [], warnings: result.warnings,
    }));
  });

  const decideGeneration = (candidateId: string, action: "approve" | "reject"): Promise<void> => run(action === "approve" ? "Approved source opened in Prepare" : "Candidate rejected", async () => {
    if (!generationReview) throw new Error("No generation proposal is awaiting review");
    const operation = commandService.captureProjectOperation(`generation-${action}`);
    const response = await fetch(`${BRIDGE_URL}/image-production/proposals/${encodeURIComponent(generationReview.proposalId)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidateId, confirm: true, ...(action === "reject" ? { reason: "Rejected in Create Character visual review" } : {}) }) });
    const result = await response.json() as { readonly error?: string };
    if (!response.ok) throw new Error(result.error ?? `${action} failed`);
    commandService.assertProjectOperationCurrent(operation, "create-character-job");
    if (action === "approve") { partsAfterApproval.current = true; setGenerationReview(null); }
    else setGenerationReview((current) => current ? { ...current, candidates: current.candidates.map((candidate) => candidate.candidateId === candidateId ? { ...candidate, status: "rejected" } : candidate) } : null);
  });

  const checkSuitability = (): Promise<void> => run("Rig suitability check complete", async () => {
    if (!project.sourceImage) throw new Error("Generate an image first");
    const operation = commandService.captureProjectOperation("create-character-suitability");
    const suitability = await provider.checkSuitability({ image: project.sourceImage.image, width: project.sourceImage.width, height: project.sourceImage.height, userPrompt: project.originalUserPrompt });
    commandService.assertProjectOperationCurrent(operation, "create-character-provider");
    setProject((current) => updateProject(current, { suitability, warnings: [...current.warnings, ...suitability.issues.map((issue) => issue.message)] }));
  });








  /** Saves the character with its chosen art and opens the Part Cutter, where the rest of the workflow happens. */
  const openPartCutter = (): void => { void run("Opening the Part Cutter", async () => { const next = updateProject(project, { stage: "prepare" }); const saved = await characterStorage.save(next); if (!saved.success) setPersistenceWarning(`The character stays open in memory, but ${saved.layer} failed: ${saved.message}`); setProject(next); window.location.assign("/part-cutter"); }); };
  useEffect(() => { if (continueToParts.current && project.sourceImage && !generationReview) { continueToParts.current = false; openPartCutter(); } });
  // Approving a candidate goes on to the Part Cutter, where parts are made. The approved image reaches the page through
  // the bridge a moment later, so the move waits for it; reopening a saved character does not move anywhere.
  const partsAfterApproval = useRef(false);
  useEffect(() => {
    if (!partsAfterApproval.current || project.stage !== "prepare" || !project.sourceImage) return;
    partsAfterApproval.current = false;
    queueMicrotask(openPartCutter);
  });
  const confirmStartOverProject = (): void => { void characterStorage.discard(project.id).then(() => { const next = createGeneratedCharacterProject("Untitled Character", ""); commandService.activateProjectFromUi(next); setProject(next); setSelectedPartId(null); setSelectedBoneId(null); setError(null); setMessage("New character project ready"); setConfirmStartOver(false); }); };

  const importProject = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    await run("Character project imported", async () => {
      let data: GeneratedCharacterProject;
      if (file.name.endsWith(".zip")) data = importCharacterProjectArchive(new Uint8Array(await file.arrayBuffer()));
      else { const input = JSON.parse(await file.text()) as unknown; const parsed = parseGeneratedCharacterProject(input); if (!parsed.success) throw new Error(parsed.message); data = parsed.data; }
      commandService.activateProjectFromUi(data); setSelectedPartId(data.segmentationData?.parts[0]?.id ?? null); setSelectedBoneId(data.rigDefinition?.rootBoneId ?? null);
    });
  };

  const stepState: StepState = { hasArt: Boolean(project.sourceImage), partsCut: Boolean(project.segmentationData?.parts.some((part) => part.accepted)), hasRig: Boolean(project.rigDefinition), rigValid: Boolean(project.rigDefinition) };
  // Create shows only its own views: the description, or the art to choose. A project in a later stage shows its art.
  const showDescribe = project.stage === "describe" || (!project.sourceImage && !generationReview);
  const candidates: readonly ArtCandidate[] = generationReview?.candidates.map((candidate) => ({ id: candidate.candidateId, image: candidate.imageUrl, width: candidate.width, height: candidate.height, rejected: candidate.status === "rejected" })) ?? [];
  // Every piece of art this character has had: the new options, the current art, and earlier generations by description.
  const briefOf = (prompt: string): string => (/Character brief:\s*([^.\n]+)/.exec(prompt)?.[1] ?? prompt).trim() || "Earlier";
  const artEntries: readonly ArtEntry[] = [
    ...candidates.filter((candidate) => !candidate.rejected).map((candidate, index) => ({ key: `option:${candidate.id}`, image: candidate.image, width: candidate.width, height: candidate.height, group: "New options", label: `Option ${index + 1}` })),
    ...(project.sourceImage ? [{ key: "current", image: project.sourceImage.image, width: project.sourceImage.width, height: project.sourceImage.height, group: "Current", label: "Current art" }] : []),
    ...project.generationHistory.filter((item) => item.generationId !== project.sourceImage?.generationId).map((item, index) => ({ key: `history:${item.generationId}`, image: item.image, width: item.width, height: item.height, group: briefOf(item.generationPrompt), label: item.seed !== undefined && item.seed !== null ? `Seed ${item.seed}` : `Earlier ${index + 1}` })),
  ];
  const selectedArt = artEntries.find((entry) => entry.key === selectedArtKey) ?? artEntries.find((entry) => entry.key === `option:${pickedId}`) ?? artEntries[0] ?? null;
  const generatorStatus = generatorStatuses.find((item) => item.provider === generator);
  const generatorReady = generator === "studio_fixture" || generatorStatus?.characterGeneration.available === true;
  const generatorReason = generatorReady ? undefined : generator === "comfyui" ? "The Mac Studio isn't reachable" : generatorStatus?.characterGeneration.reason ?? "This generator isn't set up";
  return <main className="character-workspace" data-project-id={hydrationIdentity.activeProjectId ?? "browser-draft"} data-canvas-project-id={hydrationIdentity.activeProjectId ?? "browser-draft"} data-inspector-project-id={hydrationIdentity.activeProjectId ?? "browser-draft"}>
    <input ref={importRef} hidden type="file" accept="application/json,.json,.zip,application/zip" onChange={(event) => void importProject(event)} />
    <StepShell step="create" state={stepState} projectName={project.name || "New character"} saved={hydrationIdentity.activeProjectId ? "saved" : "not-saved"}
      onRename={(name) => setProject((current) => updateProject(current, { name }))}
      stage={showDescribe
        ? <DescribeCanvas description={project.originalUserPrompt} onDescription={(value) => setProject((current) => updateProject(current, { originalUserPrompt: value }))} onUpload={() => importRef.current?.click()} disabled={restoring || Boolean(busy)} />
        : <ChooseArt candidates={candidates} selectedId={pickedId} onSelect={setPickedId} chosen={project.sourceImage ?? null} />}
      panel={<CreatePanel
        models={generator === "comfyui"
          ? <ModelCards profiles={profiles} selectedId={profileId} onSelect={(id) => { setProfileId(id); setProfileValues({}); }} error={profilesError} loading={profilesLoading} onRetry={() => void loadProfiles()} />
          : <p className="panel-note">Generating with {generator === "draw_things" ? "Draw Things" : "the development fixture"}. Change it in the model settings.</p>}
        facing={controls.viewDirection} onFacing={(facing) => setControls((current) => ({ ...current, viewDirection: facing }))}
        onExpand={() => setExpanded(true)}
        actions={showDescribe ? null : <>
          <p className="panel-label">{candidates.length ? "Options" : "Art"}</p>
          <button type="button" className="panel-button" onClick={() => void generate("regenerate")} disabled={Boolean(busy) || !generatorReady} title={generatorReady ? undefined : generatorReason} aria-description={generatorReady ? undefined : generatorReason}>Generate 4 more</button>
          <button type="button" className="panel-button" onClick={() => setProject((current) => updateProject(current, { stage: "describe" }))}>Change description</button>
          {project.sourceImage && !candidates.length && <button type="button" className="panel-button" onClick={() => void checkSuitability()} disabled={Boolean(busy)}>Check it rigs well</button>}
          {project.suitability && !candidates.length && <div className="panel-row"><span>Rigs well</span><span className={project.suitability.usable ? "is-ok" : "is-warn"}>{Math.round(project.suitability.score * 100)}%</span></div>}
        </>} />}
      expanded={expanded ? <ExpandedView
        left={<CreateArtList entries={artEntries} selectedKey={selectedArt?.key ?? null} onSelect={setSelectedArtKey} />}
        center={<CreateArtView selected={selectedArt} current={artEntries.find((entry) => entry.key === "current") ?? null} compare={compareArt} zoom={artZoom} />}
        tools={<button type="button" aria-pressed={compareArt} disabled={!project.sourceImage || !selectedArt || selectedArt.key === "current"} title={!project.sourceImage ? "There is no current art to compare with" : !selectedArt || selectedArt.key === "current" ? "Pick other art on the left to compare" : "Show it beside the current art"} onClick={() => setCompareArt((value) => !value)}>Compare</button>}
        zoom={<><button type="button" onClick={() => setArtZoom((value) => Math.max(.5, value / 1.25))} disabled={artZoom <= .5} title={artZoom <= .5 ? "Smallest" : "Zoom out"} aria-label="Zoom out">−</button><button type="button" onClick={() => setArtZoom(1)} disabled={artZoom === 1} title={artZoom === 1 ? "Already at 100%" : "Back to 100%"}><span className="num">{Math.round(artZoom * 100)}%</span></button><button type="button" onClick={() => setArtZoom((value) => Math.min(4, value * 1.25))} disabled={artZoom >= 4} title={artZoom >= 4 ? "Largest" : "Zoom in"} aria-label="Zoom in">+</button></>}
        right={<>
          <div className="ex-section"><h5>Selected<span>{selectedArt?.label ?? "Nothing"}</span></h5>
            {selectedArt && selectedArt.key !== "current" && <button type="button" className="panel-button" disabled={Boolean(busy) || (!selectedArt.key.startsWith("option:") && Boolean(project.segmentationData))}
              title={!selectedArt.key.startsWith("option:") && project.segmentationData ? "Parts are already cut from the current art" : undefined}
              onClick={() => { if (selectedArt.key.startsWith("option:")) { continueToParts.current = false; void decideGeneration(selectedArt.key.slice(7), "approve"); } else { const item = project.generationHistory.find((entry) => `history:${entry.generationId}` === selectedArt.key); if (item) setProject((current) => updateProject(current, { sourceImage: item, suitability: undefined })); } }}>Use this art</button>}
            {(!selectedArt || selectedArt.key === "current") && <p className="panel-note">This is the character&apos;s art.</p>}
          </div>
          <div className="ex-section"><h5>Generator</h5>
            <div className="seg" role="group" aria-label="Generator">{(["comfyui", "draw_things", "studio_fixture"] as const).map((id) => <button key={id} type="button" aria-pressed={generator === id} onClick={() => setGenerator(id)}>{id === "comfyui" ? "Mac Studio" : id === "draw_things" ? "Draw Things" : "Fixture"}</button>)}</div></div>
          {generator === "comfyui" && <div className="ex-section"><h5>Model settings</h5><ProfilePicker profiles={profiles} selectedId={profileId} values={profileValues} onSelect={(id) => { setProfileId(id); setProfileValues({}); }} onValues={setProfileValues} onImport={importProfile} loading={profilesLoading} error={profilesError} /></div>}
          <div className="ex-section create-controls"><h5>Character details<span>optional</span></h5>
            <TextControl label="Species" value={controls.species} onChange={(value) => setControls((current) => ({ ...current, species: value || undefined }))} />
            <TextControl label="Armor / clothing" value={controls.clothingStyle} onChange={(value) => setControls((current) => ({ ...current, clothingStyle: value || undefined }))} />
            <TextControl label="Main hand" value={controls.mainHandEquipment} onChange={(value) => setControls((current) => ({ ...current, mainHandEquipment: value || undefined }))} />
            <TextControl label="Off hand" value={controls.offHandEquipment} onChange={(value) => setControls((current) => ({ ...current, offHandEquipment: value || undefined }))} />
            <TextControl label="Hair" value={controls.hair} onChange={(value) => setControls((current) => ({ ...current, hair: value || undefined }))} />
            <TextControl label="Headwear" value={controls.headwear} onChange={(value) => setControls((current) => ({ ...current, headwear: value || undefined }))} />
            <TextControl label="Cape" value={controls.cape} onChange={(value) => setControls((current) => ({ ...current, cape: value || undefined }))} />
            <TextControl label="Tail" value={controls.tail} onChange={(value) => setControls((current) => ({ ...current, tail: value || undefined }))} />
          </div>
        </>} /> : undefined}
      instruction={persistenceWarning ? `Draft storage needs attention: ${persistenceWarning}` : error ? `That did not work: ${error}` : busy ? `Working · ${busy}` : notice ?? message ?? (showDescribe ? "Describe a character, pick a model, then generate." : candidates.length ? "Pick the art to rig. It should show the whole body." : "This is the character's art. Use it, or generate more.")}
      tone={persistenceWarning || error ? "error" : "info"}
      secondary={expanded ? <button type="button" onClick={() => setProfileValues({})} disabled={!Object.keys(profileValues).length} title={Object.keys(profileValues).length ? "Put the model's settings back to their defaults" : "The settings are already the model's defaults"}>Reset settings</button>
        : persistenceWarning ? <button type="button" onClick={() => { void characterStorage.save(projectRef.current).then((result) => setPersistenceWarning(result.success ? null : `Retry failed in ${result.layer}: ${result.message}`)); }}>Retry save</button>
        : error ? <button type="button" onClick={() => setError(null)}>Dismiss</button> : null}
      primary={expanded ? { label: "Done, back to Create", onClick: () => setExpanded(false) }
        : showDescribe ? { label: "Generate", onClick: () => void generate("generate"), busy: Boolean(busy), disabled: restoring || !project.originalUserPrompt.trim() || !generatorReady, disabledReason: !project.originalUserPrompt.trim() ? "Describe the character first" : generatorReason }
        : candidates.length ? { label: "Use this art →", onClick: () => { if (pickedId) { continueToParts.current = true; void decideGeneration(pickedId, "approve"); } }, busy: Boolean(busy), disabled: !pickedId, disabledReason: "Pick one of the options first" }
        : { label: "Use this art →", onClick: openPartCutter, busy: Boolean(busy), disabled: !project.sourceImage, disabledReason: "Generate or upload art first" }} />
    <StudioDialog open={confirmStartOver} title="Start a new character?" description="The current local character draft and its stored assets will be discarded. Export it first if you may need it later." confirmLabel="Start over" danger onCancel={() => setConfirmStartOver(false)} onConfirm={confirmStartOverProject} />
  </main>;
}






function TextControl({ label, value, onChange }: { readonly label: string; readonly value?: string; readonly onChange: (value: string) => void }) { return <label><span>{label}</span><input value={value ?? ""} onChange={(event) => onChange(event.target.value)} /></label>; }
