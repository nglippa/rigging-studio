"use client";
/* eslint-disable @next/next/no-img-element -- managed localhost proposal assets are intentionally served outside the app origin */

import { useCallback, useEffect, useState } from "react";
import { useProviderHealth } from "@/app/studio-ui/useProviderHealth";

const BRIDGE_URL = process.env.NEXT_PUBLIC_RIGGING_STUDIO_BRIDGE_URL ?? "http://127.0.0.1:47831";
type ProposalSummary = { readonly proposalId: string; readonly provider: string; readonly status: string; readonly operationType: string; readonly approvalPolicy: "manual" | "agent_recommendation"; readonly progress: { readonly message: string }; readonly candidateCount: number; readonly requiresHumanApproval: boolean };
type Candidate = { readonly candidateId: string; readonly imageUrl: string; readonly width: number; readonly height: number; readonly seed: number | null; readonly status: string; readonly suitabilityScore?: number; readonly providerMetadata?: Readonly<Record<string, unknown>> };

export function ImageProductionStatus({ projectId }: { readonly projectId: string | null }) {
  const { health, retry } = useProviderHealth();
  const [proposals, setProposals] = useState<readonly ProposalSummary[]>([]);
  const [selected, setSelected] = useState<ProposalSummary | null>(null);
  const [candidates, setCandidates] = useState<readonly Candidate[]>([]);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      if (!projectId) { setProposals([]); setSelected(null); return; }
      const proposalResponse = await fetch(`${BRIDGE_URL}/image-production/proposals?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      if (proposalResponse.ok) {
        const payload = await proposalResponse.json() as { readonly proposals: readonly ProposalSummary[] };
        setProposals(payload.proposals); setSelected((current) => payload.proposals.find((proposal) => proposal.proposalId === current?.proposalId) ?? payload.proposals[0] ?? null);
      }
    } catch { setProposals([]); setSelected(null); }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false; let timer = 0;
    const probe = async (): Promise<void> => {
      await refresh();
      if (!cancelled) timer = window.setTimeout(() => void probe(), 5_000);
    };
    timer = window.setTimeout(() => void probe(), 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [refresh]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void fetch(`${BRIDGE_URL}/image-production/proposals/${encodeURIComponent(selected.proposalId)}/candidates`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => response.ok ? response.json() as Promise<{ readonly candidates: readonly Candidate[] }> : Promise.reject(new Error("Candidates unavailable")))
      .then((payload) => setCandidates(payload.candidates)).catch(() => setCandidates([]));
    return () => controller.abort();
  }, [selected]);

  const decide = async (candidateId: string, action: "approve" | "reject"): Promise<void> => {
    if (!selected) return;
    setMessage(action === "approve" ? "Approving candidate…" : "Rejecting candidate…");
    try {
      const response = await fetch(`${BRIDGE_URL}/image-production/proposals/${encodeURIComponent(selected.proposalId)}/${action}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateId, confirm: true, ...(action === "reject" ? { reason: "Rejected in Rigging Studio visual review" } : {}) }),
      });
      const result = await response.json() as { readonly error?: string };
      if (!response.ok) throw new Error(result.error ?? `${action} failed`);
      setMessage(action === "approve" ? "Approved into the normal character pipeline" : "Candidate rejected and retained in history"); await refresh();
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : `${action} failed`); }
  };

  const connectedProviders = health.generationProviders.filter((item) => item.connected);
  const reachable = connectedProviders.length > 0 || health.state === "READY";
  return <details className={`image-production-status ${reachable ? "is-connected" : ""}`} data-dismissible-menu>
    <summary><i />Image providers · {health.state === "OFFLINE" ? "Bridge offline" : reachable ? `${connectedProviders.length || 1} ready` : "setup required"}</summary>
    <div className="image-production-popover">
      <header><strong>Local image production</strong><span>{connectedProviders.map((item) => item.label).join(" · ") || health.lastError || "Checking local providers"}</span><button type="button" onClick={() => void retry()}>Retry</button></header>
      <div className="proposal-state" data-state={health.state}><b>ComfyUI · {health.state}</b><span>{health.endpoint ?? "Configured localhost endpoint"} · segmentation {health.capabilities.find((item) => item.id === "CHARACTER_SEGMENTATION")?.available ? "ready" : "unavailable"}</span></div>
      {health.generationProviders.map((item) => <div className="proposal-state" key={item.provider}><b>{item.label}</b><span>{item.connected ? "Local · Ready" : item.message}</span></div>)}
      {!projectId && <p>No active generated-character project.</p>}
      {projectId && proposals.length === 0 && <p>No image proposals for this project.</p>}
      {proposals.length > 0 && <label><span>Proposal</span><select value={selected?.proposalId ?? ""} onChange={(event) => setSelected(proposals.find((proposal) => proposal.proposalId === event.target.value) ?? null)}>{proposals.map((proposal) => <option key={proposal.proposalId} value={proposal.proposalId}>{proposal.provider.replaceAll("_", " ")} · {proposal.operationType.toLowerCase().replaceAll("_", " ")} · {proposal.status}</option>)}</select></label>}
      {selected && <><div className="proposal-state"><b>{selected.progress.message}</b><span>{selected.approvalPolicy === "manual" ? "Human approval required" : "Agent recommendation may approve after inspection"}</span></div><div className="candidate-review-grid">{candidates.map((candidate) => <article key={candidate.candidateId}><img src={candidate.imageUrl} alt={`${candidate.candidateId} ${selected.provider} proposal`} /><div><strong>{candidate.candidateId}</strong><span>{candidate.seed === null ? "seed unavailable" : `seed ${candidate.seed}`} · {candidate.width}×{candidate.height}</span><span>{String(candidate.providerMetadata?.model ?? (candidate.suitabilityScore === undefined ? "Metadata captured" : `Suitability ${Math.round(candidate.suitabilityScore * 100)}%`))}</span></div>{selected.status === "awaiting_review" && <footer><button type="button" onClick={() => void decide(candidate.candidateId, "approve")}>Approve</button><button type="button" onClick={() => void decide(candidate.candidateId, "reject")}>Reject</button></footer>}</article>)}</div></>}
      <p className="privacy-note">Generation stays on configured localhost providers or watched folders. Every candidate remains a proposal until explicit approval.</p>
      {message && <output>{message}</output>}
    </div>
  </details>;
}
