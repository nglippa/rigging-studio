"use client";
/* eslint-disable @next/next/no-img-element -- Generated local PNG evidence needs exact pixels, not image optimization. */

import { useEffect, useRef, useState } from "react";
import { getRiggingCommandService } from "@/src/agent-control";
import { applyDoctorProposal, assertDoctorIdentity } from "@/src/animation-doctor/commands";
import { renderDoctorEvidence, type EvidenceImage } from "@/src/animation-doctor/evidence";
import { compareDoctorMetrics, measureDoctorMotion, type MotionMetrics } from "@/src/animation-doctor/metrics";
import { BridgeAnimationDoctorProvider } from "@/src/animation-doctor/provider";
import { doctorEditsForVersion, runAnimationDoctor, type DoctorResult } from "@/src/animation-doctor/session";
import type { AnimationDefinition } from "@/src/rigging/schema/types";
import { canonicalProjectStateDigest } from "@/src/project-storage/digest";
import type { DoctorEdit } from "@/src/animation-doctor/schema";

const measurements = { contacts: [], grips: [] };
type Preview = { ids: string[]; images: EvidenceImage[]; metrics: MotionMetrics; animation: AnimationDefinition };
type Props = { animation: AnimationDefinition; onPreview: (clip: AnimationDefinition | null) => void; onMessage: (message: string) => void };

export function MotionReviewPanel({ animation, onPreview, onMessage }: Props) {
  const [status, setStatus] = useState("Ready"); const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DoctorResult | null>(null); const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null); const [frame, setFrame] = useState(0); const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const edits = result ? doctorEditsForVersion(result, result.bestVersion) : [];
  const service = getRiggingCommandService();
  const assertCurrent = (review: DoctorResult) => assertDoctorIdentity(review.identity, service.captureMotionReviewIdentity(animation.id));
  const saveAudit = async (review: DoctorResult, action: "reviewed" | "accepted" | "rejected", acceptedEdits: DoctorEdit[] = []) => {
    const response = await fetch("http://127.0.0.1:47831/animation-doctor/audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      provider: review.provider, model: review.model, jobType: "ANIMATION_DOCTOR", identity: review.identity, action, beforeDigest: review.identity.beforeDigest,
      afterDigest: action === "accepted" ? canonicalProjectStateDigest(service.getDurableSnapshot()) : review.identity.beforeDigest, acceptedEdits,
      versions: review.versions.map((version) => ({ version: version.version, digest: version.digest, review: version.review, metrics: measureDoctorMotion(version.snapshot.rig!, version.snapshot.animations!.animations.find((clip) => clip.id === review.identity.clipId)!, measurements), canonicalValidity: version.scorecard.canonicalValidity, retained: version.scorecard.accepted, vetoes: version.scorecard.vetoes, imageHashes: version.images.map((image) => image.sha256) })),
      startedAt: review.startedAt, completedAt: review.completedAt, timestamp: new Date().toISOString(), toolCalls: review.toolCalls, renderRequests: review.renderRequests,
    }) });
    if (!response.ok) onMessage("Motion decision kept; diagnostic audit could not be saved");
  };

  const start = async () => {
    controller.current?.abort(); const run = new AbortController(); controller.current = run;
    setBusy(true); setError(null); setResult(null); setPreview(null); onPreview(null);
    try {
      const identity = service.captureMotionReviewIdentity(animation.id);
      const completed = await runAnimationDoctor({ snapshot: service.getDurableSnapshot(), identity, provider: new BridgeAnimationDoctorProvider(), measurements, signal: run.signal,
        assertCurrent: () => assertDoctorIdentity(identity, service.captureMotionReviewIdentity(animation.id)), onStatus: (value) => { if (!run.signal.aborted) setStatus(value); } });
      if (run.signal.aborted) return;
      setResult(completed); setSelected(doctorEditsForVersion(completed, completed.bestVersion).map((edit) => edit.id));
      setStatus(completed.bestVersion ? "Improvements ready to compare" : "Baseline retained");
      void saveAudit(completed, "reviewed").catch(() => onMessage("Motion review complete; diagnostic audit could not be saved"));
    } catch (reason) { if (!run.signal.aborted) { setError(reason instanceof Error ? reason.message : "Motion review unavailable"); setStatus("Review stopped"); } }
    finally { if (!run.signal.aborted) setBusy(false); }
  };
  const buildPreview = async () => {
    if (!result) return; const run = controller.current; setBusy(true); setError(null);
    try {
      assertCurrent(result); const chosen = edits.filter((edit) => selected.includes(edit.id));
      const snapshot = applyDoctorProposal(result.versions[0].snapshot, { identity: result.identity, edits: chosen }, service.captureMotionReviewIdentity(animation.id));
      const clip = snapshot.animations!.animations.find((clip) => clip.id === animation.id)!;
      const metrics = measureDoctorMotion(snapshot.rig!, clip, measurements);
      const vetoes = compareDoctorMetrics(result.versions[0].scorecard, metrics); if (vetoes.length) throw new Error(vetoes.join("; "));
      const images = await renderDoctorEvidence(snapshot, animation.id, result.bestVersion);
      if (run !== controller.current || run?.signal.aborted) return; assertCurrent(result);
      setPreview({ ids: [...selected], images, metrics, animation: clip }); setFrame(0); onPreview(clip);
    } catch (reason) { if (run === controller.current && !run?.signal.aborted) setError(reason instanceof Error ? reason.message : "Preview rejected"); }
    finally { if (run === controller.current && !run?.signal.aborted) setBusy(false); }
  };
  const accept = () => {
    if (!result || !preview) return;
    try {
      assertCurrent(result);
      if (JSON.stringify(selected) !== JSON.stringify(preview.ids)) throw new Error("Preview the selected edits before accepting");
      const applied = service.applyMotionReview({ identity: result.identity, edits: edits.filter((edit) => selected.includes(edit.id)) });
      if (!applied.success) throw new Error("Motion change was rejected");
      void saveAudit(result, "accepted", edits.filter((edit) => selected.includes(edit.id))).catch(() => onMessage("Motion change accepted; diagnostic audit could not be saved"));
      onPreview(null); setPreview(null); setResult(null); setStatus("Accepted · use Undo to restore"); onMessage("Motion review accepted as one undo step");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Motion change rejected"); }
  };
  const reject = () => { controller.current?.abort(); if (result) void saveAudit(result, "rejected").catch(() => onMessage("Motion review rejected; diagnostic audit could not be saved")); setBusy(false); setResult(null); setPreview(null); setError(null); setStatus("Baseline retained"); onPreview(null); };
  const format = (value: number | null) => value === null ? "Unmeasured" : value.toFixed(3);

  return <section className="motion-review" aria-label="Animation Doctor">
    <header className="inspector-heading"><span>Motion review</span><strong>{animation.name}</strong></header>
    <p>Inspect motion, compare bounded corrections, then choose what to keep.</p>
    <div className="motion-review-actions"><button type="button" disabled={busy} onClick={() => void start()}>Review Motion</button>{(busy || result) && <button type="button" onClick={reject}>{busy ? "Cancel" : "Reject"}</button>}</div>
    <output aria-live="polite">{status.replaceAll("_", " ").toLowerCase()}</output>
    {error && <p role="alert">{error}</p>}
    {result && <>
      <p>{edits.length ? `${edits.length} proposed key changes` : "No candidate passed the review gates."}</p>
      <ul className="motion-review-issues">{result.versions[0].review?.issues.map((issue, i) => <li key={i}><strong>{issue.severity}</strong> · {issue.description}</li>)}</ul>
      {edits.map((edit) => <label className="motion-review-edit" key={edit.id}><input type="checkbox" checked={selected.includes(edit.id)} disabled={busy} onChange={() => { setSelected((ids) => ids.includes(edit.id) ? ids.filter((id) => id !== edit.id) : [...ids, edit.id]); setPreview(null); onPreview(null); }} /><span><strong>{edit.boneId} · {edit.property}</strong><br />{edit.time.toFixed(3)}s: {edit.currentValue.toFixed(2)} → {edit.proposedValue.toFixed(2)}<br />{edit.expectedVisualEffect}</span></label>)}
      {edits.length > 0 && <div className="motion-review-actions"><button type="button" disabled={busy || !selected.length} onClick={() => void buildPreview()}>Preview selected</button><button type="button" disabled={busy || !preview} onClick={accept}>{selected.length === edits.length ? "Accept all" : "Accept selected"}</button></div>}
      {preview && <>
        <div className="motion-review-compare">{[{ label: "Baseline", image: result.versions[0].images[frame] }, { label: "Proposal", image: preview.images[frame] }].map(({ label, image }) => <figure key={label}><figcaption>{label}</figcaption>{/* Generated local PNG evidence, never a remote tracking image. */}<img src={image.dataUrl} alt={`${label} at ${image.time?.toFixed(3)} seconds`} /></figure>)}</div>
        <label>Frame {frame + 1} / 6<input aria-label="Compare frame" type="range" min={0} max={5} step={1} value={frame} onChange={(event) => setFrame(Number(event.target.value))} /></label>
        <table><thead><tr><th>Metric</th><th>Before</th><th>After</th></tr></thead><tbody>{(["footDrift", "gripError", "loopContinuity", "recoveryError", "motionTravel"] as const).map((key) => <tr key={key}><th>{key}</th><td>{format(result.versions[0].scorecard[key])}</td><td>{format(preview.metrics[key])}</td></tr>)}</tbody></table>
      </>}
      <details><summary>Candidate scorecards</summary>{result.versions.map((version) => <p key={version.version}>Version {version.version}: {version.scorecard.accepted ? "retained" : "rejected"} · visual {format(version.scorecard.visualReviewScore)} · {version.scorecard.issueCount ?? "unreviewed"} issues{version.scorecard.vetoes.length > 0 && ` · ${version.scorecard.vetoes.join("; ")}`}</p>)}<p>{result.toolCalls} tool calls · {result.renderRequests} render requests</p></details>
    </>}
  </section>;
}
