"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AnimationDefinition, RigDefinition } from "@/src/rigging/schema/types";
import { applyAnimationProposal } from "@/src/rigging/ai/animationProposalApplier";
import { buildAnimationGenerationContext, type AnimationAuthoringConstraints, type AnimationGenerationMode, type FootContactInterval, type LeftRightMapping } from "@/src/rigging/ai/animationContextBuilder";
import { diffAnimations, type AnimationDiff } from "@/src/rigging/ai/animationDiff";
import type { AnimationGenerationProvider } from "@/src/rigging/ai/animationGenerationProvider";
import { buildAnimationGenerationPrompt } from "@/src/rigging/ai/animationPromptBuilder";
import type { AnimationProposal } from "@/src/rigging/ai/animationProposalSchema";
import { DEFAULT_ANIMATION_SAFETY_LIMITS, validateAnimationProposal, type AnimationSafetyLimits, type ProposalValidationIssue } from "@/src/rigging/ai/animationProposalValidator";
import { diagnoseNormalizedFootSliding, type FootSlideDiagnostic } from "@/src/rigging/ai/footSlideDiagnostic";
import { HttpAnimationGenerationProvider } from "@/src/rigging/ai/httpAnimationGenerationProvider";
import { MockAnimationGenerationProvider } from "@/src/rigging/ai/mockAnimationGenerationProvider";
import { animationPresetId } from "@/src/rigging/ai/animationContinuity";
import { AnimationGenerationGuard } from "@/src/rigging/ai/animationGenerationGuard";

type Preset = { readonly id: string; readonly label: string; readonly prompt: string; readonly duration: number; readonly loop: boolean };
const PRESETS: readonly Preset[] = [
  { id: "walk", label: "Walk", prompt: "Create a grounded walk cycle with clear foot contacts and opposing arm motion.", duration: 1, loop: true },
  { id: "run", label: "Run", prompt: "Create an energetic run cycle based on the existing locomotion style.", duration: .65, loop: true },
  { id: "idle", label: "Idle", prompt: "Create a subtle breathing idle with restrained head and arm movement.", duration: 2, loop: true },
  { id: "melee", label: "Melee attack", prompt: "Create a sword attack with anticipation, a fast strike, impact, and recovery.", duration: .85, loop: false },
  { id: "ranged", label: "Ranged attack", prompt: "Create a ranged attack with aim, release, and recovery.", duration: 1, loop: false },
  { id: "cast", label: "Cast", prompt: "Create a spell cast with a readable windup, release, and settle.", duration: 1.2, loop: false },
  { id: "hurt", label: "Hurt", prompt: "Create a short hurt reaction with clear impact and recovery.", duration: .6, loop: false },
  { id: "death", label: "Death", prompt: "Create a readable non-looping death fall with a held final pose.", duration: 1.5, loop: false },
  { id: "celebrate", label: "Celebrate", prompt: "Create a lively celebration with raised arms and a buoyant body motion.", duration: 1.4, loop: true },
  { id: "interact", label: "Interact", prompt: "Create a small reach-and-return interaction animation.", duration: 1, loop: false },
];
type Props = {
  readonly rig: RigDefinition;
  readonly currentAnimation: AnimationDefinition;
  readonly referenceAnimations: readonly AnimationDefinition[];
  readonly selectedBoneIds: readonly string[];
  readonly leftRightMappings: readonly LeftRightMapping[];
  readonly onPreview: (animation: AnimationDefinition | null) => void;
  readonly onAccept: (proposal: AnimationProposal, mode: AnimationGenerationMode, selectedTrackKeys?: readonly string[]) => void;
  readonly onMessage: (message: string) => void;
};

const configuredProvider = (): AnimationGenerationProvider => {
  const endpoint = process.env.NEXT_PUBLIC_AI_ANIMATION_ENDPOINT?.trim();
  return endpoint ? new HttpAnimationGenerationProvider(endpoint) : new MockAnimationGenerationProvider();
};

const parseContacts = (source: string, duration: number): FootContactInterval[] => source.split(/\n|,/).flatMap((entry) => {
  const match = entry.trim().match(/^(left|right)(?:Foot)?\s*:\s*([0-9.]+)\s*-\s*([0-9.]+)$/i);
  if (!match) return [];
  const start = Math.max(0, Math.min(duration, Number(match[2]))); const end = Math.max(0, Math.min(duration, Number(match[3])));
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ foot: match[1].toLowerCase() === "left" ? "leftFoot" as const : "rightFoot" as const, start, end }] : [];
});

const parseRotationOverrides = (source: string): Record<string, number> => Object.fromEntries(source.split(/\n|,/).flatMap((entry) => {
  const [id, raw] = entry.split(":").map((value) => value.trim()); const limit = Number(raw);
  return id && Number.isFinite(limit) && limit > 0 ? [[id, limit]] : [];
}));
const presetContacts = (presetId: string, duration: number): string => presetId === "run"
  ? `left:0-${(duration * .125).toFixed(4)}\nright:${(duration * .5).toFixed(4)}-${(duration * .625).toFixed(4)}`
  : `left:0-${(duration * .375).toFixed(4)}\nright:${(duration * .5).toFixed(4)}-${(duration * .875).toFixed(4)}`;

export function AIAnimationPanel({ rig, currentAnimation, referenceAnimations, selectedBoneIds, leftRightMappings, onPreview, onAccept, onMessage }: Props) {
  const initialPreset = PRESETS.find((preset) => preset.id === animationPresetId(currentAnimation)) ?? PRESETS[0];
  const [presetId, setPresetId] = useState(initialPreset.id);
  const [request, setRequest] = useState(initialPreset.prompt);
  const [mode, setMode] = useState<AnimationGenerationMode>("create");
  const [duration, setDuration] = useState(initialPreset.duration);
  const [loop, setLoop] = useState(initialPreset.loop);
  const [intensity, setIntensity] = useState(.55);
  const [weight, setWeight] = useState(.5);
  const [exaggeration, setExaggeration] = useState(.4);
  const [rootAllowance, setRootAllowance] = useState(80);
  const [preserveTiming, setPreserveTiming] = useState(false);
  const [preserveContacts, setPreserveContacts] = useState(true);
  const [styleNotes, setStyleNotes] = useState("");
  const [leftFoot, setLeftFoot] = useState(rig.bones.find((bone) => bone.id.toLowerCase().includes("left-foot"))?.id ?? "");
  const [rightFoot, setRightFoot] = useState(rig.bones.find((bone) => bone.id.toLowerCase().includes("right-foot"))?.id ?? "");
  const [groundPlaneY, setGroundPlaneY] = useState(rig.canvas.height - 28);
  const [contactSource, setContactSource] = useState(presetContacts(initialPreset.id, initialPreset.duration));
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [defaultRotation, setDefaultRotation] = useState(DEFAULT_ANIMATION_SAFETY_LIMITS.defaultMaximumRotation);
  const [rotationOverrides, setRotationOverrides] = useState("");
  const [minimumScale, setMinimumScale] = useState(DEFAULT_ANIMATION_SAFETY_LIMITS.minimumScale);
  const [maximumScale, setMaximumScale] = useState(DEFAULT_ANIMATION_SAFETY_LIMITS.maximumScale);
  const [maximumKeys, setMaximumKeys] = useState(DEFAULT_ANIMATION_SAFETY_LIMITS.maximumKeyframesPerTrack);
  const [proposal, setProposal] = useState<AnimationProposal | null>(null);
  const [proposalSourceFingerprint, setProposalSourceFingerprint] = useState<string | null>(null);
  const [effectiveAnimation, setEffectiveAnimation] = useState<AnimationDefinition | null>(null);
  const [diff, setDiff] = useState<AnimationDiff | null>(null);
  const [selectedTracks, setSelectedTracks] = useState<Set<string>>(new Set());
  const [validationIssues, setValidationIssues] = useState<readonly ProposalValidationIssue[]>([]);
  const [diagnostics, setDiagnostics] = useState<readonly FootSlideDiagnostic[]>([]);
  const [refinement, setRefinement] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const provider = useMemo(() => configuredProvider(), []);
  const sourceFingerprint = `${rig.id}:${JSON.stringify(currentAnimation)}`;
  const sourceRef = useRef(sourceFingerprint);
  const generationGuard = useRef(new AnimationGenerationGuard());

  useEffect(() => {
    sourceRef.current = sourceFingerprint;
    generationGuard.current.setSource(sourceFingerprint);
  }, [sourceFingerprint]);

  const constraints: AnimationAuthoringConstraints = { duration, loop, intensity, weight, exaggeration, rootMovementAllowance: rootAllowance, preserveTiming, preserveContactFrames: preserveContacts, styleNotes };
  const contactIntervals = parseContacts(contactSource, duration);
  const safetyLimits: AnimationSafetyLimits = {
    maximumRotationByBone: parseRotationOverrides(rotationOverrides),
    defaultMaximumRotation: defaultRotation,
    minimumScale,
    maximumScale,
    maximumRootTranslation: rootAllowance,
    maximumKeyframesPerTrack: maximumKeys,
    maximumTotalKeyframes: DEFAULT_ANIMATION_SAFETY_LIMITS.maximumTotalKeyframes,
  };

  const generate = async (followUp?: string): Promise<void> => {
    if (!request.trim()) { setValidationIssues([{ path: "request", message: "Enter an animation request" }]); return; }
    const generationToken = generationGuard.current.begin(sourceFingerprint);
    setLoading(true); setValidationIssues([]); setPreviewing(false); onPreview(null);
    try {
      const context = buildAnimationGenerationContext(rig, {
        request: followUp?.trim() ? `${request.trim()}\nRefinement: ${followUp.trim()}` : request.trim(), mode, constraints, selectedBoneIds, leftRightMappings, groundPlaneY,
        leftFootBoneId: leftFoot || null, rightFootBoneId: rightFoot || null, contactIntervals,
        currentAnimation, referenceAnimations: referenceAnimations.filter((animation) => referenceIds.includes(animation.id)),
        includeSlotNames: /shield|sword|weapon|hand|grip|slot/i.test(request),
      });
      const raw = await provider.generateAnimationProposal({ prompt: buildAnimationGenerationPrompt(context, followUp), context, refinement: followUp, previousProposal: proposalSourceFingerprint === sourceFingerprint ? proposal ?? undefined : undefined });
      if (!generationGuard.current.isCurrent(generationToken, sourceRef.current)) { onMessage("Stale animation generation result discarded after the source changed"); return; }
      const validation = validateAnimationProposal(raw, rig, safetyLimits, { selectedBonesOnly: mode === "reviseSelectedBones", selectedBoneIds });
      if (!validation.success) { setProposal(null); setProposalSourceFingerprint(null); setEffectiveAnimation(null); setDiff(null); setValidationIssues(validation.issues); onMessage(validation.message); return; }
      const acceptedProposal = validation.proposal;
      const effective = mode === "create" ? acceptedProposal.animation : applyAnimationProposal({ animations: [currentAnimation] }, acceptedProposal, { mode, currentAnimationId: currentAnimation.id, selectedBoneIds }).document.animations[0];
      const diffBase = mode === "create" ? { ...currentAnimation, duration: effective.duration, loop: effective.loop, tracks: [] } : currentAnimation;
      const resultDiff = diffAnimations(diffBase, effective);
      setProposal(acceptedProposal); setProposalSourceFingerprint(sourceFingerprint); setEffectiveAnimation(effective); setDiff(resultDiff); setSelectedTracks(new Set(resultDiff.tracks.map((track) => track.key)));
      setDiagnostics(diagnoseNormalizedFootSliding(rig, effective, { leftFootBoneId: leftFoot || null, rightFootBoneId: rightFoot || null }, contactIntervals));
      onMessage(`Valid ${provider.name} proposal ready for review`);
    } catch (reason: unknown) {
      setValidationIssues([{ path: "provider", message: reason instanceof Error ? reason.message : "Animation generation failed" }]);
    } finally { if (generationGuard.current.isCurrent(generationToken, sourceRef.current)) setLoading(false); }
  };

  const reject = (): void => { setProposal(null); setProposalSourceFingerprint(null); setEffectiveAnimation(null); setDiff(null); setDiagnostics([]); setPreviewing(false); onPreview(null); onMessage("AI proposal rejected. Animation document was not changed"); };
  const togglePreview = (): void => { if (!effectiveAnimation) return; const next = !previewing; setPreviewing(next); onPreview(next ? effectiveAnimation : null); };
  const accept = (selectedTrackKeys?: readonly string[]): void => {
    if (!proposal || proposalSourceFingerprint !== sourceFingerprint) { onMessage("Stale animation proposal discarded after the source changed"); return; }
    onAccept(proposal, mode, selectedTrackKeys);
  };

  return <div className="ai-animation-panel">
    <header className="ai-panel-heading"><span>AI Animation</span><small>{provider.name}</small></header>
    <div className="ai-panel-scroll">
      <section className="ai-section">
        <label className="ai-field"><span>Preset</span><select value={presetId} onChange={(event) => { const preset = PRESETS.find((candidate) => candidate.id === event.target.value); if (preset) { setPresetId(preset.id); setRequest(preset.prompt); setDuration(preset.duration); setLoop(preset.loop); if (preset.id === "walk" || preset.id === "run") setContactSource(presetContacts(preset.id, preset.duration)); } }}>{PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
        <label className="ai-field stacked"><span>Request</span><textarea value={request} onChange={(event) => setRequest(event.target.value)} rows={4} placeholder="Describe the motion or revision" /></label>
        <label className="ai-field"><span>Operation</span><select value={mode} onChange={(event) => setMode(event.target.value as AnimationGenerationMode)}><option value="create">Create new animation</option><option value="revise">Revise current animation</option><option value="reviseSelectedBones">Revise selected bones only</option></select></label>
        {mode === "reviseSelectedBones" && <p className="ai-scope-note">Scope: {selectedBoneIds.length ? selectedBoneIds.join(", ") : "No bones selected"}</p>}
      </section>

      <details className="ai-section" open><summary>Motion constraints</summary>
        <div className="ai-two-column"><NumberField label="Duration" value={duration} min={.05} step={.05} onChange={setDuration} /><label className="ai-check"><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />Loop</label></div>
        <RangeField label="Intensity" value={intensity} onChange={setIntensity} /><RangeField label="Weight" value={weight} onChange={setWeight} /><RangeField label="Exaggeration" value={exaggeration} onChange={setExaggeration} />
        <NumberField label="Root allowance" value={rootAllowance} min={0} step={5} suffix="px" onChange={setRootAllowance} />
        <label className="ai-check"><input type="checkbox" checked={preserveTiming} onChange={(event) => setPreserveTiming(event.target.checked)} />Preserve timing</label>
        <label className="ai-check"><input type="checkbox" checked={preserveContacts} onChange={(event) => setPreserveContacts(event.target.checked)} />Preserve contact frames</label>
        <label className="ai-field stacked"><span>Style notes</span><textarea value={styleNotes} onChange={(event) => setStyleNotes(event.target.value)} rows={2} placeholder="Snappy, realistic, heroic…" /></label>
        <label className="ai-field stacked"><span>Reference animations</span><select multiple size={3} value={referenceIds} onChange={(event) => setReferenceIds([...event.target.selectedOptions].map((option) => option.value))}>{referenceAnimations.map((animation) => <option key={animation.id} value={animation.id}>{animation.name}</option>)}</select></label>
      </details>

      <details className="ai-section"><summary>Feet and contact intervals</summary>
        <label className="ai-field"><span>Left foot</span><BoneSelect rig={rig} value={leftFoot} onChange={setLeftFoot} /></label>
        <label className="ai-field"><span>Right foot</span><BoneSelect rig={rig} value={rightFoot} onChange={setRightFoot} /></label>
        <NumberField label="Ground Y" value={groundPlaneY} step={1} onChange={setGroundPlaneY} />
        <label className="ai-field stacked"><span>Contacts, e.g. left:0-0.25</span><textarea value={contactSource} onChange={(event) => setContactSource(event.target.value)} rows={3} /></label>
      </details>

      <details className="ai-section"><summary>Safety limits</summary>
        <NumberField label="Rotation delta" value={defaultRotation} min={1} step={5} suffix="°" onChange={setDefaultRotation} />
        <label className="ai-field stacked"><span>Per-bone limits, bone:degrees</span><textarea value={rotationOverrides} onChange={(event) => setRotationOverrides(event.target.value)} rows={2} /></label>
        <div className="ai-two-column"><NumberField label="Min scale" value={minimumScale} min={.01} step={.05} onChange={setMinimumScale} /><NumberField label="Max scale" value={maximumScale} min={.01} step={.1} onChange={setMaximumScale} /></div>
        <NumberField label="Keys / track" value={maximumKeys} min={2} step={1} onChange={setMaximumKeys} />
      </details>

      <div className="ai-primary-actions"><button type="button" className="ai-generate" aria-busy={loading} disabled={loading || (mode === "reviseSelectedBones" && !selectedBoneIds.length)} onClick={() => void generate()}>{loading ? "Generating…" : proposal ? "Regenerate proposal" : "Generate proposal"}</button></div>

      {validationIssues.length > 0 && <section className="ai-validation" role="alert"><strong>Proposal rejected</strong>{validationIssues.slice(0, 8).map((issue, index) => <p key={`${issue.path}:${index}`}><code>{issue.path || "proposal"}</code> {issue.message}</p>)}</section>}

      {proposal && diff && <section className="ai-proposal">
        <div className="proposal-status"><span>VALID PROPOSAL</span><strong>{proposal.summary}</strong></div>
        <div className="diff-grid"><DiffStat label="Tracks +" value={diff.tracksAdded} /><DiffStat label="Tracks −" value={diff.tracksRemoved} /><DiffStat label="Tracks Δ" value={diff.tracksChanged} /><DiffStat label="Keys +" value={diff.keyframesAdded} /><DiffStat label="Keys −" value={diff.keyframesRemoved} /><DiffStat label="Values Δ" value={diff.valuesChanged} /></div>
        {(diff.durationChanged || diff.loopChanged) && <p className="settings-diff">{diff.durationChanged ? `Duration ${diff.previousDuration}s → ${diff.nextDuration}s. ` : ""}{diff.loopChanged ? `Loop ${String(diff.previousLoop)} → ${String(diff.nextLoop)}.` : ""}</p>}
        <details open><summary>Affected tracks</summary><div className="proposal-track-list">{diff.tracks.map((track) => <label key={track.key}><input type="checkbox" checked={selectedTracks.has(track.key)} onChange={() => setSelectedTracks((current) => { const next = new Set(current); if (next.has(track.key)) next.delete(track.key); else next.add(track.key); return next; })} /><span>{track.boneId}</span><code>{track.property}</code><small>{track.status}</small></label>)}</div></details>
        {proposal.warnings.length > 0 && <NoteList label="Warnings" items={proposal.warnings} warning />}
        <NoteList label="Assumptions" items={proposal.assumptions} />
        <NoteList label="Confidence" items={proposal.confidenceNotes} />
        <NoteList label="Recommended rig changes" items={(proposal.recommendedRigChanges ?? []).map((change) => `${change.summary}: ${change.rationale}`)} warning />
        {diagnostics.length > 0 && <div className="foot-diagnostics"><strong>Foot contact diagnostic</strong>{diagnostics.map((item) => <p key={`${item.foot}:${item.start}`} className={item.likelySliding ? "warn" : "ok"}>{item.message} ({item.start.toFixed(2)}–{item.end.toFixed(2)}s)</p>)}</div>}
        <div className="proposal-actions"><button type="button" onClick={togglePreview}>{previewing ? "Stop preview" : "Preview"}</button><button type="button" className="accept" disabled={proposalSourceFingerprint !== sourceFingerprint} onClick={() => accept()}>Accept all</button><button type="button" disabled={!selectedTracks.size || proposalSourceFingerprint !== sourceFingerprint} onClick={() => accept([...selectedTracks])}>Apply selected tracks</button><button type="button" className="reject" onClick={reject}>Reject</button></div>
        <label className="ai-field stacked refine"><span>Follow-up refinement</span><textarea value={refinement} onChange={(event) => setRefinement(event.target.value)} rows={2} placeholder="Keep the timing but reduce the head movement" /><button type="button" disabled={!refinement.trim() || loading} onClick={() => void generate(refinement)}>Refine proposal</button></label>
      </section>}
    </div>
  </div>;
}

function BoneSelect({ rig, value, onChange }: { readonly rig: RigDefinition; readonly value: string; readonly onChange: (value: string) => void }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Not assigned</option>{rig.bones.map((bone) => <option key={bone.id} value={bone.id}>{bone.id}</option>)}</select>;
}
function NumberField({ label, value, min, step, suffix, onChange }: { readonly label: string; readonly value: number; readonly min?: number; readonly step: number; readonly suffix?: string; readonly onChange: (value: number) => void }) {
  return <label className="ai-field"><span>{label}</span><span className="number-with-suffix"><input type="number" value={value} min={min} step={step} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(next); }} />{suffix && <small>{suffix}</small>}</span></label>;
}
function RangeField({ label, value, onChange }: { readonly label: string; readonly value: number; readonly onChange: (value: number) => void }) {
  return <label className="ai-range"><span>{label}</span><input type="range" min={0} max={1} step={.05} value={value} onChange={(event) => onChange(Number(event.target.value))} /><output>{value.toFixed(2)}</output></label>;
}
function DiffStat({ label, value }: { readonly label: string; readonly value: number }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function NoteList({ label, items, warning = false }: { readonly label: string; readonly items: readonly string[]; readonly warning?: boolean }) { return items.length ? <div className={`proposal-notes ${warning ? "warning" : ""}`}><strong>{label}</strong>{items.map((item) => <p key={item}>{item}</p>)}</div> : null; }
