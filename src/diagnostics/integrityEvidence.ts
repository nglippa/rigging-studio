import type { ValidationIssue } from "../rigging/validation/issues";

export type IntegrityEvidence = {
  readonly digest: string;
  readonly stage: "prepare" | "setup" | "animate";
  readonly state: Readonly<Record<string, unknown>>;
  readonly problems: readonly Pick<ValidationIssue, "code" | "message" | "severity" | "objectId" | "mode">[];
};

export const evidenceDigest = (value: unknown): string => {
  const source = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

export const publishIntegrityEvidence = (evidence: Omit<IntegrityEvidence, "digest">): void => {
  if (typeof window === "undefined") return;
  const value: IntegrityEvidence = { ...evidence, digest: evidenceDigest({ stage: evidence.stage, state: evidence.state, problems: evidence.problems }) };
  (window as Window & { __RIG_STUDIO_INTEGRITY__?: IntegrityEvidence }).__RIG_STUDIO_INTEGRITY__ = value;
};
