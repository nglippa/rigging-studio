import type { LocalProjectSnapshot } from "./types";

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableValue(entry)]));
  return value;
};

export const stableProjectJson = (value: unknown): string => JSON.stringify(stableValue(value));

export const portableProjectSnapshot = (snapshot: LocalProjectSnapshot): LocalProjectSnapshot => {
  const cloned = structuredClone(snapshot);
  return {
    ...cloned,
    localProjectId: null,
    project: cloned.project ? { ...cloned.project, id: "<project-id>", name: "<project-name>", createdAt: "<created-at>", updatedAt: "<updated-at>" } : null,
  };
};

export const canonicalProjectStateDigest = (snapshot: LocalProjectSnapshot, normalizeIdentity = false): string => {
  const source = stableProjectJson(normalizeIdentity ? portableProjectSnapshot(snapshot) : snapshot);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return `project-v1:${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
};

export const projectStateDigestSummary = (snapshot: LocalProjectSnapshot): Readonly<Record<string, unknown>> => ({
  digest: canonicalProjectStateDigest(snapshot),
  normalizedDigest: canonicalProjectStateDigest(snapshot, true),
  source: snapshot.project?.sourceImage ? { generationId: snapshot.project.sourceImage.generationId, width: snapshot.project.sourceImage.width, height: snapshot.project.sourceImage.height } : null,
  ownershipRuns: snapshot.project?.partCutterState?.ownership?.runs.length ?? 0,
  regions: snapshot.project?.partCutterState?.parts.length ?? 0,
  masks: snapshot.project?.partCutterState?.parts.filter((part) => part.mask.alpha.length > 0).length ?? 0,
  landmarks: snapshot.project?.partCutterState?.anatomicalGuide?.landmarks.length ?? 0,
  zones: snapshot.project?.partCutterState?.anatomicalGuide?.zones.length ?? 0,
  bones: snapshot.rig?.bones.length ?? 0,
  slots: snapshot.rig?.slots.length ?? 0,
  attachments: snapshot.rig?.attachments.length ?? 0,
  equipment: snapshot.project?.partCutterState?.parts.filter((part) => part.equipment).length ?? 0,
  animations: snapshot.animations?.animations.length ?? 0,
  keyframes: snapshot.animations?.animations.reduce((total, animation) => total + animation.tracks.reduce((trackTotal, track) => trackTotal + track.keyframes.length, 0), 0) ?? 0,
});
