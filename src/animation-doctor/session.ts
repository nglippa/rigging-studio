import { canonicalProjectStateDigest } from "../project-storage/digest";
import type { LocalProjectSnapshot } from "../project-storage/types";
import type { AnimationDefinition } from "../rigging/schema/types";
import { applyDoctorProposal, validateDoctorSnapshot } from "./commands";
import { inspectDoctorPacket, renderDoctorEvidence, renderDoctorSource, type DoctorPacket, type EvidenceImage } from "./evidence";
import { compareDoctorMetrics, measureDoctorMotion, type MotionMetrics } from "./metrics";
import type { AnimationDoctorProvider } from "./provider";
import { DOCTOR_LIMITS, doctorReviewSchema, type DoctorEdit, type DoctorIdentity, type DoctorMeasurements, type DoctorReview } from "./schema";

export type DoctorScorecard = MotionMetrics & { canonicalValidity: boolean; visualReviewScore: number | null; issueCount: number | null; accepted: boolean; vetoes: string[] };
export type DoctorVersion = { version: number; snapshot: LocalProjectSnapshot; digest: string; images: EvidenceImage[]; review: DoctorReview | null; scorecard: DoctorScorecard; edits: DoctorEdit[] };
export type DoctorResult = { identity: DoctorIdentity; provider: string; model: string; versions: DoctorVersion[]; bestVersion: number; toolCalls: number; renderRequests: number; startedAt: string; completedAt: string; trace: { tool: string; latencyMs: number }[] };
type Options = {
  snapshot: LocalProjectSnapshot; identity: DoctorIdentity; provider: AnimationDoctorProvider; measurements: DoctorMeasurements;
  assertCurrent: () => void; signal: AbortSignal; onStatus?: (status: string) => void;
  render?: typeof renderDoctorEvidence;
  renderSource?: typeof renderDoctorSource;
};
const clipOf = (snapshot: LocalProjectSnapshot, id: string) => snapshot.animations!.animations.find((clip) => clip.id === id)!;
const amplitude = (values: readonly number[]) => Math.max(...values) - Math.min(...values);

export async function runAnimationDoctor(options: Options): Promise<DoctorResult> {
  const { identity, provider, measurements } = options;
  const baseline = structuredClone(options.snapshot); validateDoctorSnapshot(baseline);
  if (canonicalProjectStateDigest(baseline) !== identity.beforeDigest) throw new Error("Review source digest mismatch");
  const result: DoctorResult = { identity, provider: provider.id, model: provider.model, versions: [], bestVersion: 0, toolCalls: 0, renderRequests: 0, startedAt: new Date().toISOString(), completedAt: "", trace: [] };
  const started = Date.now(); const signal = AbortSignal.any([options.signal, AbortSignal.timeout(DOCTOR_LIMITS.timeoutMs)]);
  const check = () => { signal.throwIfAborted(); options.assertCurrent(); if (Date.now() - started > DOCTOR_LIMITS.timeoutMs) throw new Error("Motion review timed out"); };
  const call = async <T>(tool: string, operation: () => Promise<T>): Promise<T> => {
    check(); if (result.toolCalls >= DOCTOR_LIMITS.toolCalls) throw new Error("Motion review tool budget exhausted");
    result.toolCalls++; const start = Date.now();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason ?? new Error("Motion review cancelled")); signal.addEventListener("abort", abort, { once: true }); });
    try { const value = await Promise.race([operation(), cancelled]); result.trace.push({ tool, latencyMs: Date.now() - start }); check(); return value; }
    finally { signal.removeEventListener("abort", abort); }
  };
  const render = async (snapshot: LocalProjectSnapshot, version: number, time?: number) => {
    if (result.renderRequests >= DOCTOR_LIMITS.renders) throw new Error("Motion review render budget exhausted");
    result.renderRequests++; options.onStatus?.("WAITING_FOR_RENDER");
    return call("render_animation_frames", () => (options.render ?? renderDoctorEvidence)(snapshot, identity.clipId, version, time));
  };
  const measure = (snapshot: LocalProjectSnapshot) => measureDoctorMotion(snapshot.rig!, clipOf(snapshot, identity.clipId), measurements);
  const baselineMetrics = measure(baseline);
  result.renderRequests++;
  const sourceImage = await call("render_character", () => (options.renderSource ?? renderDoctorSource)(baseline, identity.clipId));
  const baselineImages = await render(baseline, 0);
  const initial: DoctorVersion = { version: 0, snapshot: baseline, digest: identity.beforeDigest, images: baselineImages, review: null, edits: [], scorecard: { ...baselineMetrics, canonicalValidity: true, visualReviewScore: null, issueCount: null, accepted: true, vetoes: [] } };
  result.versions.push(initial);
  const review = async (version: DoctorVersion, purpose: DoctorPacket["purpose"], previousReview: DoctorReview | null) => {
    let packet = { ...inspectDoctorPacket(version.snapshot, identity, version.version, measure(version.snapshot), baselineMetrics, [sourceImage, ...version.images]), purpose, previousReview };
    // Comparison always includes the same baseline endpoints, labeled by version.
    if (version.version) packet = { ...packet, images: [sourceImage, ...baselineImages.slice(0, 1), ...baselineImages.slice(-1), ...version.images.slice(0, 4), ...version.images.slice(-1)].slice(0, 8) };
    options.onStatus?.("REVIEWING");
    for (let requestRound = 0; requestRound < 3; requestRound++) {
      const response = doctorReviewSchema.parse(await call("review_motion", () => provider.review(packet, signal)));
      const refs = new Set(packet.evidenceRefs.map((reference) => reference.id));
      for (const item of [...response.issues, ...response.edits]) if (item.evidence.some((ref) => !refs.has(ref)) || !packet.bones.some((bone) => bone.id === item.boneId)) throw new Error("Review cites unknown evidence or bone");
      if (!response.requests.length) return response;
      for (const request of response.requests) {
        if (request.tool === "inspect_bone") {
          await call("inspect_bone", async () => {
            const bone = packet.bones.find((bone) => bone.id === request.boneId); if (!bone || request.time !== null) throw new Error("Invalid bone inspection request");
            packet = { ...packet, findings: [...packet.findings, JSON.stringify(bone)] }; return bone;
          });
        } else {
          if (request.time === null || request.boneId !== null) throw new Error("Invalid pose request");
          const extra = await render(version.snapshot, version.version, request.time);
          packet = { ...packet, images: [...packet.images.slice(0, 7), ...extra].slice(0, 8) };
        }
      }
    }
    throw new Error("Motion review evidence request limit reached");
  };
  initial.review = await review(initial, "propose", null);
  initial.scorecard.visualReviewScore = initial.review.visualScore; initial.scorecard.issueCount = initial.review.issues.length;
  let best = initial;
  for (let iteration = 1; iteration <= DOCTOR_LIMITS.iterations; iteration++) {
    const response = best.review!; if (!response.edits.length || result.toolCalls > DOCTOR_LIMITS.toolCalls - 2) break;
    options.onStatus?.("VALIDATING"); check();
    let snapshot: LocalProjectSnapshot;
    try {
      snapshot = applyDoctorProposal(best.snapshot, { identity: { ...identity, beforeDigest: best.digest }, edits: response.edits }, { ...identity, beforeDigest: best.digest });
    } catch (error) {
      result.versions.push({ ...best, version: iteration, edits: response.edits, scorecard: { ...best.scorecard, canonicalValidity: false, accepted: false, vetoes: [error instanceof Error ? error.message : "Validator veto"] } }); break;
    }
    const metrics = measure(snapshot); const vetoes = compareDoctorMetrics(best.scorecard, metrics);
    vetoes.push(...compareDoctorMetrics(baselineMetrics, metrics));
    if (metrics.loopContinuity !== null && metrics.loopContinuity > .5) vetoes.push("Loop continuity exceeds 0.5 world pixels");
    if (metrics.gripError !== null && metrics.gripError > 1) vetoes.push("Grip error exceeds 1 world pixel");
    // Fixed baseline amplitude prevents three small edits from cumulatively freezing one channel.
    const baselineClip = clipOf(baseline, identity.clipId); const candidateClip = clipOf(snapshot, identity.clipId);
    candidateClip.tracks.forEach((track, i) => { const oldAmplitude = amplitude(baselineClip.tracks[i].keyframes.filter((key) => !baselineClip.loop || key.time !== baselineClip.duration).map((key) => key.value)); if (oldAmplitude > .01 && amplitude(track.keyframes.filter((key) => !candidateClip.loop || key.time !== candidateClip.duration).map((key) => key.value)) < oldAmplitude * .7) vetoes.push(`Motion collapsed on ${track.boneId}.${track.property}`); });
    // Unmeasured contact/grip safety must remain visibly unproven, never reported as a pass.
    if (response.edits.some((edit) => edit.reasonCode === "foot_slide") && metrics.footDrift === null) vetoes.push("Foot repair requires authored contact intervals");
    if (response.edits.some((edit) => edit.reasonCode === "grip_separation") && metrics.gripError === null) vetoes.push("Grip repair requires authored socket pairs");
    const candidate: DoctorVersion = { version: iteration, snapshot, digest: canonicalProjectStateDigest(snapshot), images: [], review: null, edits: response.edits, scorecard: { ...metrics, canonicalValidity: true, visualReviewScore: null, issueCount: null, accepted: false, vetoes: [...new Set(vetoes)] } };
    result.versions.push(candidate);
    // Recheck the net proposal against the original bounds, not just this iteration's delta.
    try {
      candidate.scorecard.accepted = true;
      applyDoctorProposal(baseline, { identity, edits: doctorEditsForVersion(result, iteration) }, identity);
    } catch (error) { candidate.scorecard.vetoes.push(error instanceof Error ? error.message : "Cumulative edit bound exceeded"); }
    candidate.scorecard.accepted = false;
    if (candidate.scorecard.vetoes.length) break;
    candidate.images = await render(snapshot, iteration); candidate.review = await review(candidate, "compare", response);
    candidate.scorecard.visualReviewScore = candidate.review.visualScore; candidate.scorecard.issueCount = candidate.review.issues.length;
    const improvedMetric = (["footDrift", "gripError", "loopContinuity", "recoveryError"] as const).some((key) => metrics[key] !== null && best.scorecard[key] !== null && metrics[key]! < best.scorecard[key]! - .001);
    if (candidate.review.visualScore < best.review!.visualScore || candidate.review.issues.filter((issue) => issue.severity === "critical").length > best.review!.issues.filter((issue) => issue.severity === "critical").length) candidate.scorecard.vetoes.push("Visual review regressed");
    if (!improvedMetric && candidate.review.visualScore <= best.review!.visualScore) candidate.scorecard.vetoes.push("No measured or visual improvement");
    if (candidate.scorecard.vetoes.length) break;
    candidate.scorecard.accepted = true; best = candidate; result.bestVersion = iteration;
  }
  check(); options.onStatus?.("COMPLETE"); result.completedAt = new Date().toISOString(); return result;
}

/** Flatten accepted iterations to one bounded proposal against the original clip. */
export function doctorEditsForVersion(result: DoctorResult, version: number): DoctorEdit[] {
  const candidate = result.versions.find((item) => item.version === version);
  if (!candidate?.scorecard.accepted || !version) return [];
  const baseline: AnimationDefinition = clipOf(result.versions[0].snapshot, result.identity.clipId);
  const clip = clipOf(candidate.snapshot, result.identity.clipId);
  return clip.tracks.flatMap((track, i) => track.keyframes.flatMap((key, j) => {
    const old = baseline.tracks[i].keyframes[j]; if (old.value === key.value) return [];
    const evidence = result.versions.slice(1, version + 1).flatMap((item) => item.edits).findLast((edit) => edit.boneId === track.boneId && edit.property === track.property && edit.time === key.time)!;
    return [{ ...evidence, id: `edit-${i}-${j}`, currentValue: old.value, proposedValue: key.value }];
  }));
}
