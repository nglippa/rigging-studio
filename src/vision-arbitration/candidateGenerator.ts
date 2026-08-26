import type { Point, Rect } from "../character-generation/segmentation/segmentationSchema";
import type { PartSemanticType } from "../part-cutter";
import { candidateReviewJobSchema, candidateSetHash, cutCandidateManifestSchema, sha256, type CandidateReviewJob, type CutCandidate, type CutCandidateManifest } from "./schema";

export type CandidateGenerationInput = {
  readonly jobId: string; readonly projectId: string; readonly sessionId: string; readonly revision: string; readonly semantic: PartSemanticType;
  readonly width: number; readonly height: number; readonly sourceAlpha: readonly number[]; readonly sourceHash: string; readonly envelope: Rect;
  readonly anchors: readonly Point[]; readonly protectedAlpha?: readonly number[]; readonly round?: 1 | 2; readonly characterLeftScreenSide?: "left" | "right"; readonly createdAt?: string;
};
export type GeneratedCandidateSet = { readonly job: CandidateReviewJob; readonly candidates: readonly CutCandidate[]; readonly generationMs: number };

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
const inRect = (x: number, y: number, rect: Rect): boolean => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
const distanceToSegment = (point: Point, start: Point, end: Point): number => { const dx = end.x - start.x; const dy = end.y - start.y; const squared = dx * dx + dy * dy; if (!squared) return Math.hypot(point.x - start.x, point.y - start.y); const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / squared, 0, 1); return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy); };
const distanceToPath = (point: Point, anchors: readonly Point[]): number => anchors.length === 1 ? Math.hypot(point.x - anchors[0].x, point.y - anchors[0].y) : Math.min(...anchors.slice(1).map((anchor, index) => distanceToSegment(point, anchors[index], anchor)));
const expand = (rect: Rect, margin: number, width: number, height: number): Rect => { const x = clamp(Math.floor(rect.x - margin), 0, width - 1); const y = clamp(Math.floor(rect.y - margin), 0, height - 1); const right = clamp(Math.ceil(rect.x + rect.width + margin), x + 1, width); const bottom = clamp(Math.ceil(rect.y + rect.height + margin), y + 1, height); return { x, y, width: right - x, height: bottom - y }; };
const pixelCount = (alpha: readonly number[]): number => alpha.reduce((count, value) => count + (value > 0 ? 1 : 0), 0);
const alphaBytes = (alpha: readonly number[]): Uint8Array => Uint8Array.from(alpha, (value) => value > 0 ? 255 : 0);
const anchorCoverage = (alpha: readonly number[], width: number, anchors: readonly Point[], radius: number): number => anchors.filter((anchor) => { for (let y = Math.floor(anchor.y - radius); y <= Math.ceil(anchor.y + radius); y += 1) for (let x = Math.floor(anchor.x - radius); x <= Math.ceil(anchor.x + radius); x += 1) if (x >= 0 && y >= 0 && x < width && alpha[y * width + x] > 0) return true; return false; }).length / anchors.length;
const geometryScore = (alpha: readonly number[], input: CandidateGenerationInput): number => { const count = pixelCount(alpha); if (!count) return 0; let inside = 0; alpha.forEach((value, index) => { if (value && inRect(index % input.width, Math.floor(index / input.width), input.envelope)) inside += 1; }); const precision = inside / count; const anchors = anchorCoverage(alpha, input.width, input.anchors, Math.max(1, Math.min(input.envelope.width, input.envelope.height) * .18)); const targetArea = Math.max(1, input.envelope.width * input.envelope.height); const compactness = 1 - Math.min(1, Math.abs(count / targetArea - .55)); return clamp(precision * .5 + anchors * .35 + compactness * .15, 0, 1); };

const connectedComponents = (alpha: readonly number[], width: number, height: number): readonly number[][] => {
  const seen = new Uint8Array(width * height); const components: number[][] = [];
  for (let start = 0; start < alpha.length; start += 1) { if (!alpha[start] || seen[start]) continue; const queue = [start]; const component: number[] = []; seen[start] = 1;
    for (let cursor = 0; cursor < queue.length; cursor += 1) { const index = queue[cursor]; component.push(index); const x = index % width; const y = Math.floor(index / width); for (const next of [index - 1, index + 1, index - width, index + width]) { if (next < 0 || next >= alpha.length || seen[next] || !alpha[next]) continue; const nx = next % width; const ny = Math.floor(next / width); if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue; seen[next] = 1; queue.push(next); } }
    components.push(component);
  }
  return components;
};

const fullMask = (input: CandidateGenerationInput, predicate: (x: number, y: number) => boolean): number[] => input.sourceAlpha.map((alpha, index) => { if (!alpha || input.protectedAlpha?.[index]) return 0; const x = index % input.width; const y = Math.floor(index / input.width); return predicate(x, y) ? 255 : 0; });

export function generateCutCandidates(input: CandidateGenerationInput): GeneratedCandidateSet {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (input.width <= 0 || input.height <= 0 || input.sourceAlpha.length !== input.width * input.height) throw new Error("Source alpha dimensions are invalid");
  if (!input.anchors.length || input.anchors.length > 4) throw new Error("Candidate generation requires 1-4 articulation anchors");
  if (input.protectedAlpha && input.protectedAlpha.length !== input.sourceAlpha.length) throw new Error("Protected ownership dimensions are invalid");
  const round = input.round ?? 1; const side = input.characterLeftScreenSide ?? "right"; const centerX = input.width / 2;
  const radius = Math.max(1.5, Math.min(input.envelope.width, input.envelope.height) * (round === 1 ? .38 : .52)); const margin = Math.max(1, Math.round(Math.min(input.envelope.width, input.envelope.height) * (round === 1 ? .14 : .28)));
  const expanded = expand(input.envelope, margin, input.width, input.height); const expectedScreenSide = input.semantic.startsWith("left") ? side : input.semantic.startsWith("right") ? (side === "right" ? "left" : "right") : null;
  const specifications: { readonly generator: CutCandidate["generator"]; readonly params: Record<string, number>; readonly alpha: number[] }[] = [
    { generator: "anatomical-envelope", params: { margin: 0 }, alpha: fullMask(input, (x, y) => inRect(x, y, input.envelope)) },
    { generator: "anchor-corridor", params: { radius }, alpha: fullMask(input, (x, y) => inRect(x, y, expanded) && distanceToPath({ x, y }, input.anchors) <= radius) },
    { generator: "expanded-envelope", params: { margin }, alpha: fullMask(input, (x, y) => inRect(x, y, expanded)) },
    { generator: "side-aware-envelope", params: { margin, screenSide: expectedScreenSide === "right" ? 1 : expectedScreenSide === "left" ? -1 : 0 }, alpha: fullMask(input, (x, y) => inRect(x, y, expanded) && (expectedScreenSide === null || (expectedScreenSide === "right" ? x >= centerX : x < centerX))) },
    { generator: "articulation-split", params: { radius: radius * .72 }, alpha: fullMask(input, (x, y) => inRect(x, y, expanded) && distanceToPath({ x, y }, input.anchors) <= radius * .72) },
  ];
  if (round === 2) {
    const search = fullMask(input, (x, y) => inRect(x, y, expand(input.envelope, margin * 2, input.width, input.height))); const components = connectedComponents(search, input.width, input.height);
    const nearest = [...components].sort((left, right) => { const distance = (component: readonly number[]) => Math.min(...component.map((index) => distanceToPath({ x: index % input.width, y: Math.floor(index / input.width) }, input.anchors))); return distance(left) - distance(right) || right.length - left.length; })[0] ?? [];
    const nearestSet = new Set(nearest); specifications.unshift({ generator: "nearest-component", params: { searchMargin: margin * 2 }, alpha: search.map((value, index) => value && nearestSet.has(index) ? 255 : 0) });
  }
  const candidates: CutCandidate[] = []; const hashes = new Set<string>();
  for (const specification of specifications) {
    const count = pixelCount(specification.alpha); if (!count) continue; const candidateHash = sha256(alphaBytes(specification.alpha)); if (hashes.has(candidateHash)) continue; hashes.add(candidateHash);
    const candidateId = String.fromCharCode(65 + candidates.length); const parsed = cutCandidateManifestSchema.parse({ candidateId, candidateHash, semantic: input.semantic, generator: specification.generator, sourceHash: input.sourceHash, width: input.width, height: input.height, pixelCount: count, geometryScore: geometryScore(specification.alpha, input), round, inputLandmarks: input.anchors, geometryParameters: specification.params });
    candidates.push({ ...parsed, alpha: specification.alpha }); if (candidates.length === 5) break;
  }
  if (candidates.length < 2) throw new Error("Geometry did not produce at least two unique non-empty candidates");
  const manifests: CutCandidateManifest[] = candidates.map((candidate) => {
    const { alpha, ...manifest } = candidate;
    void alpha;
    return manifest;
  }); const setHash = candidateSetHash(input.sourceHash, input.semantic, round, manifests);
  const job = candidateReviewJobSchema.parse({ schemaVersion: 1, jobId: input.jobId, projectId: input.projectId, sessionId: input.sessionId, revision: input.revision, semantic: input.semantic, round, tasks: ["PART_SELECTION", "CONTAMINATION_CHECK", "SIDE_IDENTITY", "ARTICULATION_USABILITY", "RELATIVE_RANK"], sourceHash: input.sourceHash, candidateSetHash: setHash, characterLeftScreenSide: side, candidates: manifests, createdAt: input.createdAt ?? new Date().toISOString() });
  return { job, candidates, generationMs: Math.max(0, (typeof performance !== "undefined" ? performance.now() : Date.now()) - started) };
}
