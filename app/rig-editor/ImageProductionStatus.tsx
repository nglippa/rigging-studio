"use client";
/* eslint-disable @next/next/no-img-element -- managed localhost proposal assets are intentionally served outside the app origin */

import { useCallback, useEffect, useRef, useState } from "react";
import { OptionalServiceRetryBackoff } from "@/src/local-services/retryBackoff";

const BRIDGE_URL = process.env.NEXT_PUBLIC_RIGGING_STUDIO_BRIDGE_URL ?? "http://127.0.0.1:47831";
type ProviderState = { readonly provider?: { readonly reachable: boolean; readonly message: string; readonly queue: { readonly running: number; readonly pending: number } }; readonly providers?: readonly { readonly provider: string; readonly label: string; readonly connected: boolean; readonly message: string }[]; readonly error?: string };
type ProposalSummary = { readonly proposalId: string; readonly provider: string; readonly status: string; readonly operationType: string; readonly approvalPolicy: "manual" | "agent_recommendation"; readonly progress: { readonly message: string }; readonly candidateCount: number; readonly requiresHumanApproval: boolean };
type Candidate = { readonly candidateId: string; readonly imageUrl: string; readonly width: number; readonly height: number; readonly seed: number | null; readonly status: string; readonly suitabilityScore?: number; readonly providerMetadata?: Readonly<Record<string, unknown>> };

export function ImageProductionStatus({ projectId }: { readonly projectId: string | null }) {
  const [provider, setProvider] = useState<ProviderState>({});
  const [proposals, setProposals] = useState<readonly ProposalSummary[]>([]);
  const [selected, setSelected] = useState<ProposalSummary | null>(null);
  const [candidates, setCandidates] = useState<readonly Candidate[]>([]);
  const [message, setMessage] = useState("");
  const retryRef = useRef(new OptionalServiceRetryBackoff());

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const statusResponse = await fetch(`${BRIDGE_URL}/image-production/status`, { cache: "no-store" });
      setProvider(statusResponse.ok ? await statusResponse.json() as ProviderState : { error: "MCP bridge offline" });
      if (!statusResponse.ok) return false;
      if (!projectId) { setProposals([]); return true; }
      const proposalResponse = await fetch(`${BRIDGE_URL}/image-production/proposals?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      if (proposalResponse.ok) {
        const payload = await proposalResponse.json() as { readonly proposals: readonly ProposalSummary[] };
        setProposals(payload.proposals); setSelected((current) => payload.proposals.find((proposal) => proposal.proposalId === current?.proposalId) ?? payload.proposals[0] ?? null);
      }
      return proposalResponse.ok;
    } catch { setProvider({ error: "MCP bridge offline" }); return false; }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false; let timer = 0;
    const probe = async (): Promise<void> => {
      const succeeded = await refresh();
      if (!cancelled) timer = window.setTimeout(() => void probe(), retryRef.current.nextDelay(succeeded));
    };
    timer = window.setTimeout(() => void probe(), 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [refresh]);
  useEffect(() => {
    if (!selected) return;
    void fetch(`${BRIDGE_URL}/image-production/proposals/${encodeURIComponent(selected.proposalId)}/candidates`, { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ readonly candidates: readonly Candidate[] }> : Promise.reject(new Error("Candidates unavailable")))
      .then((payload) => setCandidates(payload.candidates)).catch(() => setCandidates([]));
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

  const connectedProviders = provider.providers?.filter((item) => item.connected) ?? [];
  const reachable = connectedProviders.length > 0 || provider.provider?.reachable === true;
  return <details className={`image-production-status ${reachable ? "is-connected" : ""}`} data-dismissible-menu>
    <summary><i />Image providers · {provider.error ? "Bridge offline" : reachable ? `${connectedProviders.length || 1} ready` : "setup required"}</summary>
    <div className="image-production-popover">
      <header><strong>Local image production</strong><span>{provider.error ?? (connectedProviders.map((item) => item.label).join(" · ") || provider.provider?.message || "Checking local providers")}</span></header>
      {provider.providers?.map((item) => <div className="proposal-state" key={item.provider}><b>{item.label}</b><span>{item.connected ? "Local · Ready" : item.message}</span></div>)}
      {!projectId && <p>No active generated-character project.</p>}
      {projectId && proposals.length === 0 && <p>No image proposals for this project.</p>}
      {proposals.length > 0 && <label><span>Proposal</span><select value={selected?.proposalId ?? ""} onChange={(event) => setSelected(proposals.find((proposal) => proposal.proposalId === event.target.value) ?? null)}>{proposals.map((proposal) => <option key={proposal.proposalId} value={proposal.proposalId}>{proposal.provider.replaceAll("_", " ")} · {proposal.operationType.toLowerCase().replaceAll("_", " ")} · {proposal.status}</option>)}</select></label>}
      {selected && <><div className="proposal-state"><b>{selected.progress.message}</b><span>{selected.approvalPolicy === "manual" ? "Human approval required" : "Agent recommendation may approve after inspection"}</span></div><div className="candidate-review-grid">{candidates.map((candidate) => <article key={candidate.candidateId}><img src={candidate.imageUrl} alt={`${candidate.candidateId} ${selected.provider} proposal`} /><div><strong>{candidate.candidateId}</strong><span>{candidate.seed === null ? "seed unavailable" : `seed ${candidate.seed}`} · {candidate.width}×{candidate.height}</span><span>{String(candidate.providerMetadata?.model ?? (candidate.suitabilityScore === undefined ? "Metadata captured" : `Suitability ${Math.round(candidate.suitabilityScore * 100)}%`))}</span></div>{selected.status === "awaiting_review" && <footer><button type="button" onClick={() => void decide(candidate.candidateId, "approve")}>Approve</button><button type="button" onClick={() => void decide(candidate.candidateId, "reject")}>Reject</button></footer>}</article>)}</div></>}
      <p className="privacy-note">Generation stays on configured localhost providers or watched folders. Every candidate remains a proposal until explicit approval.</p>
      {message && <output>{message}</output>}
    </div>
  </details>;
}
