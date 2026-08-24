"use client";

import { useEffect, useMemo, useState } from "react";
import type { AnimationAuthoringConstraints, FootContactInterval } from "@/src/rigging/ai/animationContextBuilder";
import { diffAnimations, type AnimationDiff } from "@/src/rigging/ai/animationDiff";
import type { AnimationProposal } from "@/src/rigging/ai/animationProposalSchema";
import { DEFAULT_ANIMATION_SAFETY_LIMITS, validateAnimationProposal } from "@/src/rigging/ai/animationProposalValidator";
import { diagnoseFootSliding } from "@/src/rigging/ai/footSlideDiagnostic";
import { createDiagnosticCapturePlan, type DiagnosticOverlaySettings } from "@/src/rigging/ai-vision/diagnosticCapturePlan";
import { DiagnosticFrameRenderer, type DiagnosticCaptureResult } from "@/src/rigging/ai-vision/diagnosticFrameRenderer";
import { buildDiagnosticPackageFiles, createDiagnosticZip } from "@/src/rigging/ai-vision/diagnosticPackage";
import { buildVisualReviewContext, buildVisualReviewPrompt, type VisualReviewContext } from "@/src/rigging/ai-vision/visualReviewPromptBuilder";
import { createVisualReviewPassState, HttpVisualReviewProvider, MockVisualReviewProvider, runVisualReviewPass, type VisualReviewPassState, type VisualReviewProvider } from "@/src/rigging/ai-vision/visualReviewProvider";
import { validateVisualReview, type VisualReview, type VisualReviewIssue } from "@/src/rigging/ai-vision/visualReviewSchema";
import type { AnimationDefinition, RigDefinition } from "@/src/rigging/schema/types";
import { visualReviewGoal } from "@/src/rigging/ai/animationContinuity";

type CapturedReviewInput = {
  readonly result: DiagnosticCaptureResult;
  readonly context: VisualReviewContext;
  readonly prompt: string;
};
type ReviewHistoryItem = { readonly pass: number; readonly animationId: string; readonly animationName: string; readonly createdAt: string; readonly review: VisualReview };

type Props = {
  readonly rig: RigDefinition;
  readonly currentAnimation: AnimationDefinition;
  readonly onPreview: (animation: AnimationDefinition | null) => void;
  readonly onAccept: (proposal: AnimationProposal) => void;
  readonly onIssues: (review: VisualReview | null) => void;
  readonly onIssueSelect: (issue: VisualReviewIssue) => void;
  readonly onMessage: (message: string) => void;
};

const configuredProvider = (): VisualReviewProvider => {
  const endpoint = process.env.NEXT_PUBLIC_AI_VISION_ENDPOINT?.trim();
  return endpoint ? new HttpVisualReviewProvider(endpoint) : new MockVisualReviewProvider();
};

const defaultFoot = (rig: RigDefinition, side: "left" | "right"): string => rig.bones.find((bone) => {
  const id = bone.id.toLowerCase();
  return id.includes(side) && id.includes("foot");
})?.id ?? "";

const parseContacts = (source: string, duration: number): readonly FootContactInterval[] => source.split(/\n|,/).flatMap((entry) => {
  const match = entry.trim().match(/^(left|right)(?:foot)?\s*:\s*([0-9.]+)\s*-\s*([0-9.]+)$/i);
  if (!match) return [];
  const start = Math.max(0, Math.min(duration, Number(match[2])));
  const end = Math.max(0, Math.min(duration, Number(match[3])));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return [{ foot: match[1].toLowerCase() === "left" ? "leftFoot" as const : "rightFoot" as const, start, end }];
});

const downloadBlob = (blob: Blob, name: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};
export function VisualReviewPanel({ rig, currentAnimation, onPreview, onAccept, onIssues, onIssueSelect, onMessage }: Props) {
  const [goal, setGoal] = useState(visualReviewGoal(currentAnimation));
  const [frameCount, setFrameCount] = useState(() => createDiagnosticCapturePlan(currentAnimation).frameCount);
  const [frameWidth, setFrameWidth] = useState(360);
  const [includeIndividualFrames, setIncludeIndividualFrames] = useState(false);
  const [overlays, setOverlays] = useState<DiagnosticOverlaySettings>(() => createDiagnosticCapturePlan(currentAnimation).overlays);
  const [leftFoot, setLeftFoot] = useState(() => defaultFoot(rig, "left"));
  const [rightFoot, setRightFoot] = useState(() => defaultFoot(rig, "right"));
  const [groundPlaneY, setGroundPlaneY] = useState(rig.canvas.height - 28);
  const [contactSource, setContactSource] = useState("left:0-0.25\nright:0.5-0.75");
  const [styleNotes, setStyleNotes] = useState("");
  const [maximumPasses, setMaximumPasses] = useState(1);
  const [passState, setPassState] = useState<VisualReviewPassState>(() => createVisualReviewPassState(1));
  const [capture, setCapture] = useState<CapturedReviewInput | null>(null);
  const [captureUrl, setCaptureUrl] = useState<string | null>(null);
  const [review, setReview] = useState<VisualReview | null>(null);
  const [history, setHistory] = useState<readonly ReviewHistoryItem[]>([]);
  const [correctedProposal, setCorrectedProposal] = useState<AnimationProposal | null>(null);
  const [correctedDiff, setCorrectedDiff] = useState<AnimationDiff | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState<"capture" | "review" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const provider = useMemo(() => configuredProvider(), []);
  const contacts = parseContacts(contactSource, currentAnimation.duration);

  useEffect(() => () => { if (captureUrl) URL.revokeObjectURL(captureUrl); }, [captureUrl]);
  const captureIsStale = capture !== null && JSON.stringify(capture.context.animation) !== JSON.stringify(currentAnimation);

  const constraints: AnimationAuthoringConstraints = {
    duration: currentAnimation.duration, loop: currentAnimation.loop, intensity: .5, weight: .5, exaggeration: .35,
    rootMovementAllowance: 120, preserveTiming: true, preserveContactFrames: true, styleNotes,
  };

  const updateOverlay = (key: keyof DiagnosticOverlaySettings, value: boolean): void => setOverlays((current) => ({ ...current, [key]: value }));

  const renderCapture = async (): Promise<void> => {
    if (!goal.trim()) { setError("Describe the animation goal before rendering diagnostics."); return; }
    setBusy("capture"); setError(null); setReview(null); setCorrectedProposal(null); setCorrectedDiff(null); setPreviewing(false); onPreview(null); onIssues(null);
    try {
      const plan = createDiagnosticCapturePlan(currentAnimation, { frameCount, frameWidth, frameHeight: Math.round(frameWidth * .82), includeIndividualFrames, overlays });
      const result = await new DiagnosticFrameRenderer().capture(rig, currentAnimation, plan, { leftFootBoneId: leftFoot || null, rightFootBoneId: rightFoot || null, groundPlaneY });
      const warnings = diagnoseFootSliding(rig, currentAnimation, { leftFootBoneId: leftFoot || null, rightFootBoneId: rightFoot || null }, contacts).filter((item) => item.likelySliding).map((item) => item.message);
      const context = buildVisualReviewContext(rig, currentAnimation, {
        animationGoal: goal.trim(), groundPlaneY, feet: { leftFootBoneId: leftFoot || null, rightFootBoneId: rightFoot || null, contactIntervals: contacts }, constraints,
        knownWarnings: warnings, capture: { frameCount: plan.frameCount, imageWidth: plan.contactSheetWidth, imageHeight: plan.contactSheetHeight, times: plan.times, overlays: plan.overlays },
      });
      const prompt = buildVisualReviewPrompt(context);
      setCapture({ result, context, prompt });
      setCaptureUrl(URL.createObjectURL(result.contactSheet));
      setPassState(createVisualReviewPassState(maximumPasses));
      onMessage(`Rendered ${plan.frameCount} deterministic diagnostic frames. Nothing has been sent.`);
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : "Diagnostic capture failed"); }
    finally { setBusy(null); }
  };

  const requestReview = async (): Promise<void> => {
    if (!capture) return;
    setBusy("review"); setError(null); setPreviewing(false); onPreview(null);
    try {
      const result = await runVisualReviewPass(passState, provider, {
        prompt: capture.prompt, context: capture.context, contactSheet: capture.result.contactSheet,
        individualFrames: capture.result.individualFrames, previousReviews: history.filter((item) => item.animationId === currentAnimation.id).map((item) => item.review),
      });
      const validated = validateVisualReview(result.review, currentAnimation.duration, new Set(rig.bones.map((bone) => bone.id)));
      if (!validated.success) throw new Error(`${validated.message}: ${validated.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
      setPassState(result.state); setReview(validated.review); onIssues(validated.review);
      setHistory((current) => [...current, { pass: result.state.completedPasses, animationId: currentAnimation.id, animationName: currentAnimation.name, createdAt: new Date().toISOString(), review: validated.review }]);
      const proposalValidation = validated.review.correctedAnimationProposal
        ? validateAnimationProposal(validated.review.correctedAnimationProposal, rig, DEFAULT_ANIMATION_SAFETY_LIMITS)
        : null;
      if (proposalValidation?.success) {
        setCorrectedProposal(proposalValidation.proposal);
        setCorrectedDiff(diffAnimations(currentAnimation, proposalValidation.proposal.animation));
      } else {
        setCorrectedProposal(null); setCorrectedDiff(null);
        if (proposalValidation && !proposalValidation.success) setError(`Corrected proposal was isolated and rejected: ${proposalValidation.message}`);
      }
      onMessage(`Visual review pass ${result.state.completedPasses} completed. Review only; animation unchanged.`);
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : "Visual review failed"); }
    finally { setBusy(null); }
  };

  const exportPackage = async (): Promise<void> => {
    if (!capture) return;
    const files = await buildDiagnosticPackageFiles({ contactSheet: capture.result.contactSheet, context: capture.context, animation: currentAnimation, reviewRequest: capture.prompt, ...(review ? { reviewResponse: review } : {}) });
    downloadBlob(createDiagnosticZip(files), `${currentAnimation.id}-visual-diagnostic.zip`);
    onMessage(`Exported diagnostic package with ${files.length} files`);
  };

  const togglePreview = (): void => {
    if (!correctedProposal) return;
    const next = !previewing; setPreviewing(next); onPreview(next ? correctedProposal.animation : null);
  };
  const acceptCorrection = (): void => {
    if (!correctedProposal) return;
    onAccept(correctedProposal); setPreviewing(false); onPreview(null);
  };

  return <div className="ai-animation-panel visual-review-panel">
    <header className="ai-panel-heading"><span>Visual review</span><small>{provider.name}</small></header>
    <div className="ai-panel-scroll">
      <section className="ai-section">
        <label className="ai-field stacked"><span>Animation goal</span><textarea rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} /></label>
        <div className="ai-two-column"><NumberField label="Frames" value={frameCount} min={2} max={24} step={1} onChange={setFrameCount} /><NumberField label="Frame width" value={frameWidth} min={160} max={640} step={20} onChange={setFrameWidth} /></div>
        <label className="ai-check"><input type="checkbox" checked={includeIndividualFrames} onChange={(event) => setIncludeIndividualFrames(event.target.checked)} />Also send individual frames</label>
        <label className="ai-field"><span>Review pass limit</span><select value={maximumPasses} onChange={(event) => { const next = Math.max(passState.completedPasses || 1, Math.min(3, Number(event.target.value))); setMaximumPasses(next); setPassState((current) => ({ ...current, maximumPasses: next })); }}><option value={1}>1 pass</option><option value={2}>2 passes</option><option value={3}>3 passes (hard max)</option></select></label>
      </section>

      <details className="ai-section" open><summary>Diagnostic overlays</summary><div className="visual-overlay-grid">
        {(Object.keys(overlays) as (keyof DiagnosticOverlaySettings)[]).map((key) => <label className="ai-check" key={key}><input type="checkbox" checked={overlays[key]} onChange={(event) => updateOverlay(key, event.target.checked)} />{overlayLabel(key)}</label>)}
      </div></details>

      <details className="ai-section"><summary>Feet, contacts, constraints</summary>
        <label className="ai-field"><span>Left foot</span><BoneSelect rig={rig} value={leftFoot} onChange={setLeftFoot} /></label>
        <label className="ai-field"><span>Right foot</span><BoneSelect rig={rig} value={rightFoot} onChange={setRightFoot} /></label>
        <NumberField label="Ground Y" value={groundPlaneY} step={1} onChange={setGroundPlaneY} />
        <label className="ai-field stacked"><span>Contact intervals</span><textarea rows={3} value={contactSource} onChange={(event) => setContactSource(event.target.value)} /></label>
        <label className="ai-field stacked"><span>Constraints / style notes</span><textarea rows={2} value={styleNotes} onChange={(event) => setStyleNotes(event.target.value)} placeholder="Grounded, stylized, preserve impact timing…" /></label>
      </details>

      <div className="ai-primary-actions"><button type="button" className="ai-generate" aria-busy={busy === "capture"} disabled={busy !== null} onClick={() => void renderCapture()}>{busy === "capture" ? "Rendering…" : capture ? "Render fresh contact sheet" : "Render contact sheet"}</button></div>

      {error && <section className="ai-validation" role="alert"><strong>Visual review notice</strong><p>{error}</p></section>}

      {capture && captureUrl && <section className="visual-capture-review">
        <div className="proposal-status"><span>LOCAL CAPTURE · NOT SENT</span><strong>Inspect the contact sheet before confirming a provider request.</strong></div>
        {/* This is a local, short-lived Blob URL that cannot use the framework image optimizer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="visual-contact-sheet" src={captureUrl} alt={`Diagnostic contact sheet for ${currentAnimation.name}`} />
        <div className="visual-data-manifest"><strong>Provider payload</strong><p>{capture.result.plan.frameCount} frames · {capture.result.plan.contactSheetWidth}×{capture.result.plan.contactSheetHeight}px contact sheet</p><p>Animation goal, bone hierarchy/setup pose, current animation JSON, ground/feet/contacts, constraints, overlays, and known warnings.</p>{passState.completedPasses > 0 && <p>Prior structured session reviews are included for this explicitly started refinement pass.</p>}<p>No editor UI, unrelated files, project source, or API secret is included.</p>{capture.result.individualFrames.length > 0 && <p>{capture.result.individualFrames.length} individual PNG frames are also included.</p>}</div>
        {captureIsStale && <p className="visual-stale-capture">The animation changed after this capture. Render a fresh contact sheet before review or export.</p>}
        <div className="visual-send-actions"><button type="button" disabled={captureIsStale} onClick={() => void exportPackage()}>Export diagnostic ZIP</button><button type="button" className="confirm-send" aria-busy={busy === "review"} disabled={busy !== null || captureIsStale || passState.completedPasses >= passState.maximumPasses} onClick={() => void requestReview()}>{busy === "review" ? "Reviewing…" : passState.completedPasses ? `Start review pass ${passState.completedPasses + 1}` : "Confirm and send for review"}</button></div>
        <p className="visual-cost-note">Each click makes at most one provider request. Pass {passState.completedPasses}/{passState.maximumPasses}; there are no automatic follow-ups or retries.</p>
      </section>}

      {review && !captureIsStale && <section className="visual-review-result">
        <div className="proposal-status"><span>STRUCTURED REVIEW</span><strong>{review.summary}</strong></div>
        <div className="visual-issue-list">{review.detectedIssues.length ? review.detectedIssues.map((issue) => <button type="button" key={issue.id} className={`visual-issue severity-${issue.severity}`} onClick={() => onIssueSelect(issue)}><span><b>{issue.issueType}</b><em>{issue.severity} · {(issue.confidence * 100).toFixed(0)}%</em></span><small>{issue.timeRange.start.toFixed(3)}–{issue.timeRange.end.toFixed(3)}s · {issue.affectedBones.join(", ") || "no bone identified"}</small><p>{issue.explanation}</p><p className="suggestion">{issue.suggestedCorrection}</p></button>) : <p className="visual-empty-review">No visible issues were reported.</p>}</div>
      </section>}

      {correctedProposal && correctedDiff && !captureIsStale && <section className="ai-proposal visual-correction">
        <div className="proposal-status"><span>VALIDATED CORRECTION · PREVIEW ONLY</span><strong>{correctedProposal.summary}</strong></div>
        <div className="diff-grid"><DiffStat label="Tracks +" value={correctedDiff.tracksAdded} /><DiffStat label="Tracks −" value={correctedDiff.tracksRemoved} /><DiffStat label="Tracks Δ" value={correctedDiff.tracksChanged} /><DiffStat label="Keys +" value={correctedDiff.keyframesAdded} /><DiffStat label="Keys −" value={correctedDiff.keyframesRemoved} /><DiffStat label="Values Δ" value={correctedDiff.valuesChanged} /></div>
        <div className="proposal-actions"><button type="button" onClick={togglePreview}>{previewing ? "Stop preview" : "Preview correction"}</button><button type="button" className="accept" onClick={acceptCorrection}>Accept correction</button></div>
      </section>}

      {history.length > 0 && <details className="ai-section visual-history"><summary>Session review history ({history.length})</summary>{history.map((item, index) => <div key={`${item.createdAt}:${index}`}><span>{item.animationName} · pass {item.pass}</span><time>{new Date(item.createdAt).toLocaleTimeString()}</time><p>{item.review.summary}</p></div>)}</details>}
    </div>
  </div>;
}

function BoneSelect({ rig, value, onChange }: { readonly rig: RigDefinition; readonly value: string; readonly onChange: (value: string) => void }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Not assigned</option>{rig.bones.map((bone) => <option key={bone.id} value={bone.id}>{bone.id}</option>)}</select>;
}
function NumberField({ label, value, min, max, step, onChange }: { readonly label: string; readonly value: number; readonly min?: number; readonly max?: number; readonly step: number; readonly onChange: (value: number) => void }) {
  return <label className="ai-field"><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(next); }} /></label>;
}
function DiffStat({ label, value }: { readonly label: string; readonly value: number }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function overlayLabel(key: keyof DiagnosticOverlaySettings): string {
  return ({ bones: "Bone overlay", boneNames: "Bone names", jointPoints: "Joint points", slotBounds: "Slot bounds", groundLine: "Ground line", rootTrajectory: "Root trajectory", footTrajectories: "Foot trajectories", motionArcs: "Motion arcs" })[key];
}
