import type { Point, Rect, SegmentationMask } from "../character-generation/segmentation/segmentationSchema";
import { SEMANTIC_TAXONOMY, type PartSemanticType } from "./semanticTaxonomy";
import type { AnatomicalLandmark, AnatomicalLandmarkId, AnatomicalPartitionGuide, AnatomicalZone, ChibiProportionDescriptor, LandmarkEvidenceSource, LandmarkVisibilityState, PartCutterState } from "./schema";

export type SilhouetteRow = { readonly y: number; readonly left: number | null; readonly right: number | null; readonly width: number; readonly pixelCount: number; readonly centroidX: number | null; readonly componentCount: number };
export type SilhouetteColumn = { readonly x: number; readonly top: number | null; readonly bottom: number | null; readonly height: number; readonly pixelCount: number; readonly centroidY: number | null };
export type SilhouetteProfile = { readonly width: number; readonly height: number; readonly foregroundBounds: Rect; readonly topmostForeground: number; readonly bottommostForeground: number; readonly centerOfMass: Point; readonly foregroundPixelCount: number; readonly rows: readonly SilhouetteRow[]; readonly columns: readonly SilhouetteColumn[] };

const BODY_TYPES = ["head", "torso", "pelvis", "leftUpperArm", "leftForearm", "leftHand", "rightUpperArm", "rightForearm", "rightHand", "leftThigh", "leftLowerLeg", "leftFoot", "rightThigh", "rightLowerLeg", "rightFoot"] as const satisfies readonly PartSemanticType[];
type BodyType = (typeof BODY_TYPES)[number];
const PARENTS: Readonly<Record<(typeof BODY_TYPES)[number], PartSemanticType | null>> = { head: "torso", torso: "pelvis", pelvis: null, leftUpperArm: "torso", leftForearm: "leftUpperArm", leftHand: "leftForearm", rightUpperArm: "torso", rightForearm: "rightUpperArm", rightHand: "rightForearm", leftThigh: "pelvis", leftLowerLeg: "leftThigh", leftFoot: "leftLowerLeg", rightThigh: "pelvis", rightLowerLeg: "rightThigh", rightFoot: "rightLowerLeg" };
const ANCHORS: Readonly<Record<(typeof BODY_TYPES)[number], readonly AnatomicalLandmarkId[]>> = { head: ["neck", "head"], torso: ["pelvis", "chest", "neck"], pelvis: ["pelvis", "leftHip", "rightHip"], leftUpperArm: ["leftShoulder", "leftElbow"], leftForearm: ["leftElbow", "leftWrist"], leftHand: ["leftWrist"], rightUpperArm: ["rightShoulder", "rightElbow"], rightForearm: ["rightElbow", "rightWrist"], rightHand: ["rightWrist"], leftThigh: ["leftHip", "leftKnee"], leftLowerLeg: ["leftKnee", "leftAnkle"], leftFoot: ["leftAnkle"], rightThigh: ["rightHip", "rightKnee"], rightLowerLeg: ["rightKnee", "rightAnkle"], rightFoot: ["rightAnkle"] };
const PARENT_LANDMARKS: Readonly<Record<AnatomicalLandmarkId, AnatomicalLandmarkId | null>> = { root: null, pelvis: "root", chest: "pelvis", neck: "chest", head: "neck", leftShoulder: "chest", leftElbow: "leftShoulder", leftWrist: "leftElbow", rightShoulder: "chest", rightElbow: "rightShoulder", rightWrist: "rightElbow", leftHip: "pelvis", leftKnee: "leftHip", leftAnkle: "leftKnee", rightHip: "pelvis", rightKnee: "rightHip", rightAnkle: "rightKnee", leftHock: "leftKnee", rightHock: "rightKnee" };
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const roundPoint = (point: Point, width: number, height: number): Point => ({ x: clamp(Math.round(point.x), 0, width - 1), y: clamp(Math.round(point.y), 0, height - 1) });
const alphaAt = (alpha: readonly number[], width: number, height: number, x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height && (alpha[Math.round(y) * width + Math.round(x)] ?? 0) > 0;
const elapsed = (start: number): number => Math.max(0, (typeof performance !== "undefined" ? performance.now() : Date.now()) - start);

export function analyzeSilhouette(alpha: readonly number[], width: number, height: number): SilhouetteProfile {
  if (alpha.length !== width * height) throw new Error("Foreground alpha length must equal width × height");
  let minX = width; let minY = height; let maxX = -1; let maxY = -1; let count = 0; let sumX = 0; let sumY = 0;
  const rows: SilhouetteRow[] = [];
  for (let y = 0; y < height; y += 1) {
    let left = width; let right = -1; let rowCount = 0; let rowSum = 0; let components = 0; let active = false;
    for (let x = 0; x < width; x += 1) {
      const foreground = (alpha[y * width + x] ?? 0) > 0;
      if (!foreground) { active = false; continue; }
      if (!active) components += 1; active = true; left = Math.min(left, x); right = Math.max(right, x); rowCount += 1; rowSum += x; count += 1; sumX += x; sumY += y; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    rows.push({ y, left: right >= 0 ? left : null, right: right >= 0 ? right : null, width: right >= 0 ? right - left + 1 : 0, pixelCount: rowCount, centroidX: rowCount ? rowSum / rowCount : null, componentCount: components });
  }
  if (!count) throw new Error("Adaptive guide requires a non-empty foreground silhouette");
  const columns: SilhouetteColumn[] = [];
  for (let x = 0; x < width; x += 1) { let top = height; let bottom = -1; let columnCount = 0; let columnSum = 0; for (let y = 0; y < height; y += 1) if ((alpha[y * width + x] ?? 0) > 0) { top = Math.min(top, y); bottom = Math.max(bottom, y); columnCount += 1; columnSum += y; } columns.push({ x, top: bottom >= 0 ? top : null, bottom: bottom >= 0 ? bottom : null, height: bottom >= 0 ? bottom - top + 1 : 0, pixelCount: columnCount, centroidY: columnCount ? columnSum / columnCount : null }); }
  return { width, height, foregroundBounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, topmostForeground: minY, bottommostForeground: maxY, centerOfMass: { x: sumX / count, y: sumY / count }, foregroundPixelCount: count, rows, columns };
}

const smoothRowWidth = (profile: SilhouetteProfile, y: number, radius = 3): number => { let sum = 0; let samples = 0; for (let row = Math.max(0, y - radius); row <= Math.min(profile.height - 1, y + radius); row += 1) { if (profile.rows[row].pixelCount) { sum += profile.rows[row].pixelCount; samples += 1; } } return samples ? sum / samples : 0; };
const rowCentroidOnSide = (alpha: readonly number[], profile: SilhouetteProfile, y: number, side: "left" | "right", centerX: number, fallback: number): number => {
  const { width, height, foregroundBounds: bounds } = profile; const band = Math.max(3, Math.round(bounds.height * .025)); const columns = new Array<number>(width).fill(0);
  for (let row = Math.max(bounds.y, Math.round(y - band)); row <= Math.min(height - 1, Math.round(y + band)); row += 1) for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) if (alpha[row * width + x] && (side === "left" ? x < centerX : x > centerX)) columns[x] += 1;
  const segments: { left: number; right: number; weight: number; centroid: number }[] = []; let x = bounds.x;
  while (x < bounds.x + bounds.width) { while (x < bounds.x + bounds.width && columns[x] === 0) x += 1; const left = x; let weight = 0; let weighted = 0; while (x < bounds.x + bounds.width && columns[x] > 0) { weight += columns[x]; weighted += x * columns[x]; x += 1; } if (weight) segments.push({ left, right: x - 1, weight, centroid: weighted / weight }); }
  const candidates = segments.filter((segment) => side === "left" ? segment.centroid <= centerX : segment.centroid >= centerX);
  if (!candidates.length) return fallback;
  return candidates.sort((a, b) => (Math.abs(a.centroid - fallback) - Math.abs(b.centroid - fallback)) || (b.weight - a.weight))[0].centroid;
};
const foregroundBoundsInBand = (alpha: readonly number[], profile: SilhouetteProfile, top: number, bottom: number, centerX: number, maxDistance: number): Rect => {
  let minX = profile.width; let minY = profile.height; let maxX = -1; let maxY = -1;
  for (let y = clamp(Math.floor(top), 0, profile.height - 1); y <= clamp(Math.ceil(bottom), 0, profile.height - 1); y += 1) for (let x = Math.max(0, Math.floor(centerX - maxDistance)); x <= Math.min(profile.width - 1, Math.ceil(centerX + maxDistance)); x += 1) if (alpha[y * profile.width + x]) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  return maxX >= minX ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : { x: centerX - 1, y: top, width: 2, height: Math.max(1, bottom - top) };
};

/**
 * Body proportions the guide lays joints out with. "chibi" (the default) finds the neck below a big head and uses chibi
 * ratios. "adult" puts the neck at 22% and the pelvis at 52% of the figure's height: measured on a near-adult goblin in
 * profile, whose neck the silhouette cannot find (the face juts forward, so no row is narrow).
 */
export type GuideProportions = "auto" | "chibi" | "adult";

/**
 * Chibi or adult, from the silhouette alone: the median row width as a share of the figure's height. Chibi sprites are
 * squat (0.55-0.80 across the ten benchmark sprites); adult figures are slender (0.14-0.25 on the goblin and the
 * courier). The median ignores the few rows a weapon or shield widens. tests/rigging/guide-accuracy.test.ts checks this
 * on every sprite in tests/fixtures/rigging/joint-ground-truth.json.
 */
export const ADULT_MAX_MEDIAN_WIDTH = .4;
export function detectProportions(alpha: readonly number[], width: number, height: number): "chibi" | "adult" {
  const widths: number[] = [];
  for (let y = 0; y < height; y += 1) { let count = 0; for (let x = 0; x < width; x += 1) if (alpha[y * width + x]) count += 1; if (count) widths.push(count); }
  if (!widths.length) return "chibi";
  const median = [...widths].sort((a, b) => a - b)[Math.floor(widths.length / 2)];
  return median / widths.length < ADULT_MAX_MEDIAN_WIDTH ? "adult" : "chibi";
}
const ADULT_NECK = .22; const ADULT_PELVIS = .52;
const adultPelvisFactor = (ADULT_PELVIS - ADULT_NECK) / (1 - ADULT_NECK);

/** Runs of foreground across a horizontal band, heaviest first. Thin runs (a blade, a strap) are left out. */
const massSegments = (alpha: readonly number[], profile: SilhouetteProfile, y: number, band: number, minWidth: number): { left: number; right: number; weight: number; centroid: number }[] => {
  const { width, foregroundBounds: bounds } = profile; const columns = new Array<number>(width).fill(0);
  for (let row = Math.max(bounds.y, Math.round(y - band)); row <= Math.min(bounds.y + bounds.height - 1, Math.round(y + band)); row += 1) for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) if (alpha[row * width + x]) columns[x] += 1;
  const segments: { left: number; right: number; weight: number; centroid: number }[] = []; let x = bounds.x;
  while (x < bounds.x + bounds.width) {
    while (x < bounds.x + bounds.width && columns[x] === 0) x += 1;
    const left = x; let weight = 0; let weighted = 0;
    while (x < bounds.x + bounds.width && columns[x] > 0) { weight += columns[x]; weighted += x * columns[x]; x += 1; }
    if (weight && x - left >= minWidth) segments.push({ left, right: x - 1, weight, centroid: weighted / weight });
  }
  return segments.sort((a, b) => b.weight - a.weight);
};

/**
 * Where the legs actually are at one height. Two substantial runs are two legs. One wide run is two legs touching side
 * by side. One narrow run is a side view with the legs overlapping, so both legs go on it ("stacked"). Null without
 * evidence, so the proportional guess stays.
 */
/**
 * Whether a run of silhouette at one height can be followed down, row by row through overlapping runs, to the ground.
 * A leg always can. The tip of a sword or the rim of a shield held low cannot: it ends in the air (body-segmentation
 * skill ch04: every part map must make a valid skeleton; ch01: held objects are the classic cause of wrong limbs).
 */
const reachesGround = (alpha: readonly number[], profile: SilhouetteProfile, y: number, from: { left: number; right: number }): boolean => {
  const { width, foregroundBounds: bounds } = profile; const ground = bounds.y + bounds.height - 1 - Math.max(1, Math.round(bounds.height * .06));
  let left = from.left; let right = from.right;
  for (let row = Math.round(y) + 1; row <= ground; row += 1) {
    let nextLeft = Number.POSITIVE_INFINITY; let nextRight = Number.NEGATIVE_INFINITY; let x = bounds.x;
    while (x < bounds.x + bounds.width) {
      while (x < bounds.x + bounds.width && !alpha[row * width + x]) x += 1;
      const start = x; while (x < bounds.x + bounds.width && alpha[row * width + x]) x += 1;
      if (x > start && start <= right + 1 && x - 1 >= left - 1) { nextLeft = Math.min(nextLeft, start); nextRight = Math.max(nextRight, x - 1); }
    }
    if (nextRight < nextLeft) return false;
    left = nextLeft; right = nextRight;
  }
  return true;
};

const legEvidence = (alpha: readonly number[], profile: SilhouetteProfile, y: number): { left: number; right: number; stacked: boolean } | null => {
  const bounds = profile.foregroundBounds;
  const segments = massSegments(alpha, profile, y, Math.max(1, Math.round(bounds.height * .012)), Math.max(2, Math.round(bounds.width * .03))).filter((segment) => reachesGround(alpha, profile, y, segment));
  if (!segments.length) return null;
  const [first, second] = segments;
  if (second && second.weight >= first.weight * .35) { const pair = [first, second].sort((a, b) => a.centroid - b.centroid); return { left: pair[0].centroid, right: pair[1].centroid, stacked: false }; }
  const span = first.right - first.left + 1;
  if (span > bounds.width * .28) return { left: first.left + span * .27, right: first.right - span * .27, stacked: false };
  return { left: first.centroid, right: first.centroid, stacked: true };
};

/**
 * The arm on one side at one height, when it is drawn apart from the body: the run of silhouette next to the torso's
 * run on that side. The torso's run is the one under the body centre. Null when the arm lies against the body (no
 * separate run), so the proportional guess stays.
 */
const armEvidence = (alpha: readonly number[], profile: SilhouetteProfile, y: number, side: "left" | "right", bodyX: number): number | null => {
  const bounds = profile.foregroundBounds;
  const segments = massSegments(alpha, profile, y, Math.max(1, Math.round(bounds.height * .01)), Math.max(2, Math.round(bounds.width * .02)));
  if (segments.length < 2) return null;
  const torso = segments.find((segment) => segment.left <= bodyX && segment.right >= bodyX) ?? [...segments].sort((a, b) => Math.abs(a.centroid - bodyX) - Math.abs(b.centroid - bodyX))[0];
  const beside = segments.filter((segment) => segment !== torso && (side === "left" ? segment.right < torso.left : segment.left > torso.right));
  if (!beside.length) return null;
  // The arm attaches to the body, so the run nearest the torso is the arm; anything further out is held equipment.
  return beside.sort((a, b) => (side === "left" ? b.right - a.right : a.left - b.left))[0].centroid;
};

/**
 * The wrist, by tracing one arm down from its elbow: row by row, follow the run of silhouette beside the torso that is
 * nearest the previous row's, and take the narrowest row in the middle of the trace, where the forearm pinches before the
 * hand widens (the last rows are fingertips, also narrow, so they are left out). Null when the arm cannot be followed far
 * enough apart from the body, so the proportional guess stays.
 */
const traceWrist = (alpha: readonly number[], profile: SilhouetteProfile, side: "left" | "right", start: Point, bodyX: number, maxY: number): Point | null => {
  const bounds = profile.foregroundBounds; const step = Math.max(1, bounds.width * .06);
  const rows: { y: number; x: number; width: number }[] = []; let previous = start.x;
  // Rows where the arm still joins the body are skipped; the trace begins where it separates.
  for (let y = Math.round(start.y); y <= Math.min(maxY, bounds.y + bounds.height - 1); y += 1) {
    const segments = massSegments(alpha, profile, y, 0, 1);
    const torso = segments.find((segment) => segment.left <= bodyX && segment.right >= bodyX);
    const beside = segments.filter((segment) => segment !== torso && (!torso || (side === "left" ? segment.right < torso.left : segment.left > torso.right)));
    // The arm is the run nearest where it was last (at first: the guessed elbow). Until it is found, a short stretch of
    // rows where it still joins the body is skipped; a run far from the guess is held equipment, not the arm.
    const next = beside.sort((a, b) => Math.abs(a.centroid - previous) - Math.abs(b.centroid - previous))[0];
    if (!next || Math.abs(next.centroid - previous) > step) { if (rows.length || y - start.y > bounds.height * .06) break; continue; }
    rows.push({ y, x: next.centroid, width: next.right - next.left + 1 }); previous = next.centroid;
  }
  if (rows.length < Math.max(3, bounds.height * .06)) return null;
  const middle = rows.slice(Math.floor(rows.length * .4), Math.ceil(rows.length * .8));
  if (!middle.length) return null;
  const narrowest = middle.reduce((best, row) => row.width <= best.width ? row : best);
  return { x: narrowest.x, y: narrowest.y };
};

function descriptorFor(alpha: readonly number[], profile: SilhouetteProfile, requestedProfile: AnatomicalPartitionGuide["profile"], proportions: "chibi" | "adult" = "chibi"): { descriptor: ChibiProportionDescriptor; neckY: number; hiddenLegs: boolean; armorLikely: boolean } {
  const bounds = profile.foregroundBounds; const bottom = bounds.y + bounds.height - 1; const bboxCenter = bounds.x + bounds.width / 2; const bodyCenterX = clamp(bboxCenter + (profile.centerOfMass.x - bboxCenter) * .4, bounds.x, bounds.x + bounds.width - 1);
  const compactSource = bounds.height < profile.height * .82; const tall = bounds.height / bounds.width > 1.42; const foregroundCenterYRatio = (profile.centerOfMass.y - bounds.y) / bounds.height;
  const defaultRatio = compactSource ? .52 : tall ? .45 : .42; const searchTop = Math.round(bounds.y + bounds.height * .30); const searchBottom = Math.round(bounds.y + bounds.height * .60);
  let narrowY = Math.round(bounds.y + bounds.height * defaultRatio); let narrowScore = Number.POSITIVE_INFINITY;
  for (let y = searchTop; y <= searchBottom; y += 1) { const width = smoothRowWidth(profile, y); const above = smoothRowWidth(profile, Math.max(bounds.y, y - Math.round(bounds.height * .08))); const below = smoothRowWidth(profile, Math.min(bottom, y + Math.round(bounds.height * .08))); if (!width || !above || !below) continue; const score = width / Math.max(1, (above + below) / 2) + Math.abs(y - (bounds.y + bounds.height * defaultRatio)) / bounds.height * .45; if (score < narrowScore) { narrowScore = score; narrowY = y; } }
  let neckY = proportions === "adult" ? Math.round(bounds.y + bounds.height * ADULT_NECK) : clamp(Math.round(narrowY * .45 + (bounds.y + bounds.height * defaultRatio) * .55), bounds.y + bounds.height * .28, bounds.y + bounds.height * .62);
  let headBounds = foregroundBoundsInBand(alpha, profile, bounds.y, neckY, bodyCenterX, Math.max(bounds.width * .36, bounds.height * .25));
  const provisionalHeadWidthRatio = headBounds.width / bounds.width; const extreme = compactSource && provisionalHeadWidthRatio >= .54 && foregroundCenterYRatio < .49;
  if (extreme && proportions !== "adult") { neckY = Math.max(neckY, Math.round(bounds.y + bounds.height * .57)); headBounds = foregroundBoundsInBand(alpha, profile, bounds.y, neckY, bodyCenterX, Math.max(bounds.width * .42, bounds.height * .3)); }
  const headHeightRatio = headBounds.height / bounds.height; const headWidthRatio = headBounds.width / bounds.width;
  const actuallyExtreme = extreme;
  const torsoProbe = smoothRowWidth(profile, Math.round(neckY + (bottom - neckY) * .30)); const headProbe = Math.max(1, smoothRowWidth(profile, Math.round(headBounds.y + headBounds.height * .55))); const broad = !actuallyExtreme && (torsoProbe / headProbe > 1.48 || compactSource);
  const archetype: ChibiProportionDescriptor["archetype"] = requestedProfile === "digitigrade" ? "digitigrade" : actuallyExtreme ? "large_head_extreme" : broad ? "broad_chibi" : tall ? "tall_chibi" : requestedProfile === "custom" ? "custom" : "standard_chibi";
  const resolvedBodyCenterX = requestedProfile === "digitigrade" ? bboxCenter + (profile.centerOfMass.x - bboxCenter) * .8 : archetype === "large_head_extreme" ? bboxCenter - bounds.width * .02 : bboxCenter;
  const pelvisFactor = proportions === "adult" ? adultPelvisFactor : extreme ? .66 : broad ? .61 : tall ? .54 : .57; const pelvisY = neckY + (bottom - neckY) * pelvisFactor;
  const lowerComponentRows = profile.rows.slice(Math.round(pelvisY), Math.round(bottom - bounds.height * .08)).filter((row) => row.pixelCount); const separatedRows = lowerComponentRows.filter((row) => row.componentCount >= 2).length; const hiddenLegs = archetype === "tall_chibi" || (lowerComponentRows.length > 0 && separatedRows / lowerComponentRows.length < .68);
  const shoulderRowWidth = smoothRowWidth(profile, Math.round(neckY + (pelvisY - neckY) * .12)); const armorLikely = requestedProfile === "humanoid" && bounds.height / bounds.width > 1.1 && shoulderRowWidth > headProbe * 1.42;
  const torsoHeightRatio = (pelvisY - neckY) / bounds.height; const legLengthRatio = (bottom - pelvisY) / bounds.height; const armLengthRatio = Math.min(1, (pelvisY - neckY) * 1.15 / bounds.height); const overallCompactness = clamp(bounds.width / bounds.height, 0, 2);
  return { descriptor: { foregroundBounds: bounds, headBounds, centerOfMass: profile.centerOfMass, bodyCenterX: resolvedBodyCenterX, headHeightRatio, headWidthRatio, torsoHeightRatio, legLengthRatio, armLengthRatio, overallCompactness, archetype }, neckY, hiddenLegs, armorLikely };
}

type LandmarkInput = { id: AnatomicalLandmarkId; point: Point; source: LandmarkEvidenceSource; visibility: LandmarkVisibilityState; confidence: number; method: string };
function inferLandmarks(alpha: readonly number[], profile: SilhouetteProfile, descriptor: ChibiProportionDescriptor, neckYInput: number, requestedProfile: AnatomicalPartitionGuide["profile"], hiddenLegs: boolean, armorLikely: boolean, proportions: "chibi" | "adult" = "chibi"): AnatomicalLandmark[] {
  const bounds = descriptor.foregroundBounds; const bottom = bounds.y + bounds.height - 1; const bboxCenter = bounds.x + bounds.width / 2; const extreme = descriptor.archetype === "large_head_extreme"; const broad = descriptor.archetype === "broad_chibi"; const tall = descriptor.archetype === "tall_chibi"; const digitigrade = requestedProfile === "digitigrade"; const center = digitigrade ? bboxCenter + (profile.centerOfMass.x - bboxCenter) * .8 : extreme ? bboxCenter - bounds.width * .02 : bboxCenter; const pelvisFactor = proportions === "adult" ? adultPelvisFactor : extreme ? .66 : broad ? .61 : tall ? .54 : .57;
  const neckY = armorLikely ? neckYInput - bounds.height * .07 : neckYInput; const pelvisY = neckY + (bottom - neckY) * pelvisFactor; const chestY = neckY + (pelvisY - neckY) * .34; const shoulderY = neckY + (pelvisY - neckY) * (proportions === "adult" ? .25 : armorLikely ? .06 : .12); const rootY = Math.min(profile.height * .96, bottom + bounds.height * .15); const ankleY = rootY - bounds.height * .055; const kneeY = pelvisY + (ankleY - pelvisY) * .55;
  const wideBroad = broad && bounds.width / bounds.height > 1.05; const shoulderHalf = broad && !armorLikely ? bounds.width * .20 : armorLikely ? bounds.width * .18 : Math.max(bounds.width * .16, bounds.height * .095); const hipHalf = Math.max(bounds.width * .055, bounds.height * .035);
  // The shoulders sit on the torso, so they are measured from the torso's own run of pixels, never from the bounding box,
  // which a held sword or shield widens (on the goblin, the box-based right shoulder landed on the shield's rim and the
  // "upper arm" cut was a piece of shield). The torso is the run at chest height under the body centre; a shoulder outside
  // it (plus a small margin for a shoulder pad) is pulled back to its edge. An arm drawn apart from the body is
  // unaffected: its run is separate, so the torso run is narrow and the shoulder stays at its edge.
  const torsoRun = massSegments(alpha, profile, chestY, Math.max(1, Math.round(bounds.height * .01)), 1)
    .sort((a, b) => (a.left <= center && a.right >= center ? 0 : 1) - (b.left <= center && b.right >= center ? 0 : 1) || Math.abs(a.centroid - center) - Math.abs(b.centroid - center))[0];
  const torsoMargin = torsoRun ? (torsoRun.right - torsoRun.left + 1) * .1 : 0;
  const onTorso = (x: number) => torsoRun ? clamp(x, torsoRun.left - torsoMargin, torsoRun.right + torsoMargin) : x;
  // Seen from the side (the legs overlap in one column) the shoulders sit over the torso, one a little in front of the
  // other, not at its edges as in a front view.
  const sideView = Boolean(legEvidence(alpha, profile, kneeY)?.stacked);
  const torsoMiddle = torsoRun ? (torsoRun.left + torsoRun.right) / 2 : center; const torsoWidth = torsoRun ? torsoRun.right - torsoRun.left + 1 : shoulderHalf * 2;
  const leftShoulderX = sideView ? torsoMiddle - torsoWidth * .2 : onTorso(center - shoulderHalf);
  const rightShoulderX = sideView ? torsoMiddle + torsoWidth * .2 : onTorso(center + shoulderHalf);
  // Adult arms hang to the hips; chibi arms are short.
  const wristY = proportions === "adult" ? pelvisY : shoulderY + (pelvisY - shoulderY) * .74; const elbowY = shoulderY + (wristY - shoulderY) * .50; const armReach = bounds.width * (armorLikely ? .16 : extreme ? .24 : wideBroad ? .36 : .34);
  const leftWristEvidence = rowCentroidOnSide(alpha, profile, wristY, "left", center, center - armReach); const rightWristEvidence = rowCentroidOnSide(alpha, profile, wristY, "right", center, center + armReach); const evidenceWeight = armorLikely ? .08 : .15;
  // An arm drawn apart from the body is measured; one lying against it keeps the proportional guess nudged by the silhouette.
  const leftWristX = armEvidence(alpha, profile, wristY, "left", center) ?? (center - armReach) * (1 - evidenceWeight) + leftWristEvidence * evidenceWeight;
  const rightWristX = armEvidence(alpha, profile, wristY, "right", center) ?? (center + armReach) * (1 - evidenceWeight) + rightWristEvidence * evidenceWeight;
  const leftElbowFallback = (leftShoulderX + leftWristX) / 2; const rightElbowFallback = (rightShoulderX + rightWristX) / 2; const leftElbowEvidence = rowCentroidOnSide(alpha, profile, elbowY, "left", center, leftElbowFallback); const rightElbowEvidence = rowCentroidOnSide(alpha, profile, elbowY, "right", center, rightElbowFallback); const leftElbowX = armEvidence(alpha, profile, elbowY, "left", center) ?? leftElbowFallback * .85 + leftElbowEvidence * .15;
  const rightElbowX = armEvidence(alpha, profile, elbowY, "right", center) ?? rightElbowFallback * .85 + rightElbowEvidence * .15;
  // Follow each arm down from its elbow to find where the wrist really is.
  const traceLimit = pelvisY + bounds.height * .15;
  // Starting at the shoulder was tried and made the chibi sprites much worse: where the arm still joins the body, the first
  // separate run is the held weapon, and the trace follows it. Starting at the elbow, the arm is already apart.
  const leftTracedWrist = traceWrist(alpha, profile, "left", { x: leftElbowX, y: elbowY }, center, traceLimit);
  const rightTracedWrist = traceWrist(alpha, profile, "right", { x: rightElbowX, y: elbowY }, center, traceLimit);
  const kneeHalf = digitigrade ? bounds.width * .15 : wideBroad ? bounds.width * .13 : extreme ? bounds.width * .06 : bounds.width * .085; const ankleHalf = digitigrade ? bounds.width * .18 : wideBroad ? bounds.width * .15 : extreme ? bounds.width * .08 : bounds.width * .105;
  let leftKneeX = center - kneeHalf; let rightKneeX = center + kneeHalf; let leftAnkleX = center - ankleHalf; let rightAnkleX = center + ankleHalf;
  let leftHipX = center - hipHalf; let rightHipX = center + hipHalf; let pelvisX = center;
  // Measure the legs where they are drawn instead of assuming them symmetric about one centre: held equipment shifts and
  // widens the silhouette, and in a side view both legs overlap. Skipped when the legs are hidden (robe, tall chibi).
  // When the legs read as hidden (one lower-body column), a NARROW column is still a leg seen side-on, not a robe, so it is used.
  const usableLegs = (evidence: ReturnType<typeof legEvidence>) => evidence && (!hiddenLegs || evidence.stacked) ? evidence : null;
  const kneeEvidence = usableLegs(legEvidence(alpha, profile, kneeY)); const ankleEvidence = usableLegs(legEvidence(alpha, profile, ankleY));
  if (kneeEvidence) { leftKneeX = kneeEvidence.left; rightKneeX = kneeEvidence.right; }
  if (ankleEvidence) { leftAnkleX = ankleEvidence.left; rightAnkleX = ankleEvidence.right; }
  if (kneeEvidence?.stacked) {
    const hipEvidence = legEvidence(alpha, profile, pelvisY + (kneeY - pelvisY) * .25);
    const hipX = hipEvidence?.stacked ? hipEvidence.left : kneeEvidence.left;
    leftHipX = hipX; rightHipX = hipX; pelvisX = hipX;
    // Overlapping legs (a side view) stay overlapping down to the feet: the ankles sit in the run under the knees, not
    // at a guess around the bounding box, which held equipment widens.
    if (!ankleEvidence?.stacked) {
      const under = massSegments(alpha, profile, ankleY, Math.max(1, Math.round(bounds.height * .012)), 1)
        .sort((a, b) => Math.abs(a.centroid - kneeEvidence.left) - Math.abs(b.centroid - kneeEvidence.left))[0];
      if (under) { leftAnkleX = under.left <= kneeEvidence.left && under.right >= kneeEvidence.left ? (under.centroid + kneeEvidence.left) / 2 : under.centroid; rightAnkleX = leftAnkleX; }
    }
  }
  const visibleHeadCenterX = descriptor.headBounds.x + descriptor.headBounds.width / 2; const headCenter = { x: center * .7 + visibleHeadCenterX * .3, y: descriptor.headBounds.y + descriptor.headBounds.height * .48 };
  const inputs: LandmarkInput[] = [
    { id: "root", point: { x: center, y: rootY }, source: "silhouette", visibility: "visible", confidence: .9, method: "bottom foreground terminal" },
    { id: "pelvis", point: { x: pelvisX, y: pelvisY }, source: hiddenLegs ? "inferred_hidden" : "silhouette", visibility: hiddenLegs ? "inferred" : "visible", confidence: hiddenLegs ? .55 : .78, method: "lower central mass and leg divergence" },
    { id: "chest", point: { x: center, y: chestY }, source: "silhouette", visibility: "visible", confidence: .82, method: "central torso mass" },
    { id: "neck", point: { x: center, y: neckY }, source: "silhouette", visibility: armorLikely ? "needs-review" : "visible", confidence: armorLikely ? .61 : .8, method: "upper-mass narrowing" },
    { id: "head", point: headCenter, source: "silhouette", visibility: "visible", confidence: .88, method: "oversized upper foreground mass" },
    { id: "leftShoulder", point: { x: leftShoulderX, y: shoulderY }, source: armorLikely ? "symmetry" : "silhouette", visibility: armorLikely ? "needs-review" : "visible", confidence: armorLikely ? .58 : .77, method: armorLikely ? "inner attachment below armor extent" : "upper-body widening" },
    { id: "leftElbow", point: { x: leftElbowX, y: elbowY }, source: "centerline", visibility: "visible", confidence: .7, method: "limb branch centerline bend" },
    { id: "leftWrist", point: leftTracedWrist ?? { x: leftWristX, y: wristY }, source: "centerline", visibility: "visible", confidence: leftTracedWrist ? .8 : .72, method: leftTracedWrist ? "distal branch narrowing (arm traced from the elbow)" : "distal branch narrowing" },
    { id: "rightShoulder", point: { x: rightShoulderX, y: shoulderY }, source: armorLikely ? "symmetry" : "silhouette", visibility: armorLikely ? "needs-review" : "visible", confidence: armorLikely ? .58 : .77, method: armorLikely ? "inner attachment below armor extent" : "upper-body widening" },
    { id: "rightElbow", point: { x: rightElbowX, y: elbowY }, source: "centerline", visibility: "visible", confidence: .7, method: "limb branch centerline bend" },
    { id: "rightWrist", point: rightTracedWrist ?? { x: rightWristX, y: wristY }, source: "centerline", visibility: "visible", confidence: rightTracedWrist ? .8 : .72, method: rightTracedWrist ? "distal branch narrowing (arm traced from the elbow)" : "distal branch narrowing" },
    { id: "leftHip", point: { x: leftHipX, y: pelvisY + bounds.height * .012 }, source: hiddenLegs ? "inferred_hidden" : "silhouette", visibility: hiddenLegs ? "inferred" : "visible", confidence: hiddenLegs ? .5 : .76, method: "pelvis width and leg origin" },
    { id: "leftKnee", point: { x: leftKneeX, y: kneeY }, source: hiddenLegs ? "inferred_hidden" : "centerline", visibility: hiddenLegs ? "inferred" : "visible", confidence: hiddenLegs ? .42 : .7, method: hiddenLegs ? "symmetric hidden trajectory" : "leg centerline bend" },
    { id: "leftAnkle", point: { x: leftAnkleX, y: ankleY }, source: hiddenLegs ? "inferred_hidden" : "centerline", visibility: hiddenLegs ? "inferred" : "visible", confidence: hiddenLegs ? .48 : .74, method: hiddenLegs ? "foot-aligned hidden trajectory" : "distal leg narrowing" },
    { id: "rightHip", point: { x: rightHipX, y: pelvisY + bounds.height * .012 }, source: hiddenLegs ? "inferred_hidden" : "silhouette", visibility: hiddenLegs ? "inferred" : "visible", confidence: hiddenLegs ? .5 : .76, method: "pelvis width and leg origin" },
    { id: "rightKnee", point: { x: rightKneeX, y: kneeY }, source: hiddenLegs ? "inferred_hidden" : "centerline", visibility: hiddenLegs ? "inferred" : "visible", confidence: hiddenLegs ? .42 : .7, method: hiddenLegs ? "symmetric hidden trajectory" : "leg centerline bend" },
    { id: "rightAnkle", point: { x: rightAnkleX, y: ankleY }, source: hiddenLegs ? "inferred_hidden" : "centerline", visibility: hiddenLegs ? "inferred" : "visible", confidence: hiddenLegs ? .48 : .74, method: hiddenLegs ? "foot-aligned hidden trajectory" : "distal leg narrowing" },
  ];
  if (requestedProfile === "digitigrade") { const hockY = kneeY + (ankleY - kneeY) * .55; inputs.push({ id: "leftHock", point: { x: leftKneeX + (leftAnkleX - leftKneeX) * .35, y: hockY }, source: "centerline", visibility: "needs-review", confidence: .62, method: "digitigrade intermediate bend" }, { id: "rightHock", point: { x: rightKneeX + (rightAnkleX - rightKneeX) * .35, y: hockY }, source: "centerline", visibility: "needs-review", confidence: .62, method: "digitigrade intermediate bend" }); }
  return inputs.map((input) => ({ landmarkId: input.id, point: roundPoint(input.point, profile.width, profile.height), parentLandmarkId: PARENT_LANDMARKS[input.id], confidence: input.confidence, source: input.source, visibility: input.visibility, method: input.method }));
}

const distanceToSegment = (point: Point, a: Point, b: Point): number => { const dx = b.x - a.x; const dy = b.y - a.y; const length = dx * dx + dy * dy; if (!length) return Math.hypot(point.x - a.x, point.y - a.y); const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / length, 0, 1); return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)); };
const pointInPolygon = (point: Point, polygon: readonly Point[]): boolean => { let inside = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]; const b = polygon[j]; if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || 1e-9) + a.x) inside = !inside; } return inside; };
const localRadius = (alpha: readonly number[], width: number, height: number, a: Point, b: Point, fallback: number): number => { const dx = b.x - a.x; const dy = b.y - a.y; const length = Math.max(1, Math.hypot(dx, dy)); const nx = -dy / length; const ny = dx / length; const totals: number[] = []; for (const t of [.25, .5, .75]) { const p = { x: a.x + dx * t, y: a.y + dy * t }; let span = 1; for (const direction of [-1, 1]) for (let step = 1; step <= fallback * 2.5; step += 1) { if (!alphaAt(alpha, width, height, p.x + nx * step * direction, p.y + ny * step * direction)) break; span += 1; } totals.push(span / 2); } return clamp(totals.reduce((sum, value) => sum + value, 0) / Math.max(1, totals.length), Math.max(2, fallback * .45), fallback * 1.45); };
const boundsFromFullMask = (full: Uint8Array, width: number, height: number): { bounds: Rect; mask: SegmentationMask } | null => { let minX = width; let minY = height; let maxX = -1; let maxY = -1; for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (full[y * width + x]) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); } if (maxX < minX) return null; const maskWidth = maxX - minX + 1; const maskHeight = maxY - minY + 1; const cropped = new Array<number>(maskWidth * maskHeight).fill(0); for (let y = 0; y < maskHeight; y += 1) for (let x = 0; x < maskWidth; x += 1) cropped[y * maskWidth + x] = full[(minY + y) * width + minX + x] ?? 0; return { bounds: { x: minX, y: minY, width: maskWidth, height: maskHeight }, mask: { width: maskWidth, height: maskHeight, alpha: cropped } }; };

function adaptiveZones(alpha: readonly number[], width: number, height: number, landmarks: readonly AnatomicalLandmark[], descriptor: ChibiProportionDescriptor): AnatomicalZone[] {
  const byId = new Map(landmarks.map((landmark) => [landmark.landmarkId, landmark.point])); const bounds = descriptor.foregroundBounds; const defaultRadius = Math.max(3, Math.min(bounds.width, bounds.height) * .045); const candidates = new Map<BodyType, { full: Uint8Array; centerline: readonly Point[]; polygon: readonly Point[]; kind: "silhouette-region" | "centerline-corridor" | "terminal-mass" }>();
  const corridor = (type: BodyType, aId: AnatomicalLandmarkId, bId: AnatomicalLandmarkId) => { const a = byId.get(aId)!; const b = byId.get(bId)!; const radius = localRadius(alpha, width, height, a, b, defaultRadius); const full = new Uint8Array(width * height); for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (alpha[y * width + x] && distanceToSegment({ x, y }, a, b) <= radius) full[y * width + x] = 255; const dx = b.x - a.x; const dy = b.y - a.y; const length = Math.max(1, Math.hypot(dx, dy)); const nx = -dy / length * radius; const ny = dx / length * radius; candidates.set(type, { full, centerline: [a, b], polygon: [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }], kind: "centerline-corridor" }); };
  const region = (type: BodyType, polygon: readonly Point[], centerline: readonly Point[]) => { const full = new Uint8Array(width * height); for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (alpha[y * width + x] && pointInPolygon({ x, y }, polygon)) full[y * width + x] = 255; candidates.set(type, { full, polygon, centerline, kind: "silhouette-region" }); };
  const terminal = (type: BodyType, anchorId: AnatomicalLandmarkId, toward: Point, radiusScale: number) => { const anchor = byId.get(anchorId)!; const radius = defaultRadius * radiusScale; const centerPoint = { x: anchor.x + toward.x, y: anchor.y + toward.y }; const full = new Uint8Array(width * height); for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (alpha[y * width + x] && Math.hypot(x - centerPoint.x, y - centerPoint.y) <= radius) full[y * width + x] = 255; const polygon = Array.from({ length: 8 }, (_, index) => ({ x: centerPoint.x + Math.cos(index / 8 * Math.PI * 2) * radius, y: centerPoint.y + Math.sin(index / 8 * Math.PI * 2) * radius })); candidates.set(type, { full, centerline: [anchor, centerPoint], polygon, kind: "terminal-mass" }); };
  const neck = byId.get("neck")!; const pelvis = byId.get("pelvis")!; const leftShoulder = byId.get("leftShoulder")!; const rightShoulder = byId.get("rightShoulder")!; const leftHip = byId.get("leftHip")!; const rightHip = byId.get("rightHip")!;
  region("head", [{ x: descriptor.headBounds.x, y: descriptor.headBounds.y }, { x: descriptor.headBounds.x + descriptor.headBounds.width, y: descriptor.headBounds.y }, { x: descriptor.headBounds.x + descriptor.headBounds.width, y: neck.y + defaultRadius }, { x: descriptor.headBounds.x, y: neck.y + defaultRadius }], [byId.get("head")!, neck]);
  region("torso", [{ x: leftShoulder.x - defaultRadius, y: neck.y }, { x: rightShoulder.x + defaultRadius, y: neck.y }, { x: rightHip.x + defaultRadius, y: pelvis.y }, { x: leftHip.x - defaultRadius, y: pelvis.y }], [neck, byId.get("chest")!, pelvis]);
  region("pelvis", [{ x: leftHip.x - defaultRadius, y: pelvis.y - defaultRadius }, { x: rightHip.x + defaultRadius, y: pelvis.y - defaultRadius }, { x: rightHip.x + defaultRadius * .8, y: pelvis.y + defaultRadius * 1.8 }, { x: leftHip.x - defaultRadius * .8, y: pelvis.y + defaultRadius * 1.8 }], [leftHip, pelvis, rightHip]);
  corridor("leftUpperArm", "leftShoulder", "leftElbow"); corridor("leftForearm", "leftElbow", "leftWrist"); terminal("leftHand", "leftWrist", { x: -defaultRadius * .5, y: defaultRadius * .2 }, 1.35);
  corridor("rightUpperArm", "rightShoulder", "rightElbow"); corridor("rightForearm", "rightElbow", "rightWrist"); terminal("rightHand", "rightWrist", { x: defaultRadius * .5, y: defaultRadius * .2 }, 1.35);
  corridor("leftThigh", "leftHip", "leftKnee"); corridor("leftLowerLeg", "leftKnee", "leftAnkle"); terminal("leftFoot", "leftAnkle", { x: -defaultRadius * .25, y: defaultRadius * .8 }, 1.7);
  corridor("rightThigh", "rightHip", "rightKnee"); corridor("rightLowerLeg", "rightKnee", "rightAnkle"); terminal("rightFoot", "rightAnkle", { x: defaultRadius * .25, y: defaultRadius * .8 }, 1.7);
  const priority: readonly BodyType[] = ["head", "leftHand", "rightHand", "leftFoot", "rightFoot", "leftForearm", "rightForearm", "leftLowerLeg", "rightLowerLeg", "leftUpperArm", "rightUpperArm", "leftThigh", "rightThigh", "pelvis", "torso"]; const claimed = new Uint8Array(width * height); const built = new Map<BodyType, AnatomicalZone>();
  // Two legs on the same line (a side view, one leg behind the other) would get the same zone twice; whichever came first
  // took every pixel and the other was left a scrap. The far leg is hidden instead: it gets no art of its own, and the rig
  // draws it from the near leg (body-segmentation skill ch04: a collapsed part is an error, an occluded one is declared).
  const near = (a: AnatomicalLandmarkId, b: AnatomicalLandmarkId) => Math.hypot(byId.get(a)!.x - byId.get(b)!.x, byId.get(a)!.y - byId.get(b)!.y) <= defaultRadius;
  const hidden = new Set<BodyType>(near("leftKnee", "rightKnee") && near("leftAnkle", "rightAnkle") ? ["rightThigh", "rightLowerLeg", "rightFoot"] : []);
  for (const type of hidden) { const anchor = byId.get(ANCHORS[type][ANCHORS[type].length - 1])!; const x = clamp(Math.round(anchor.x), 0, width - 1); const y = clamp(Math.round(anchor.y), 0, height - 1); const candidate = candidates.get(type)!; built.set(type, { zoneId: type, semanticType: type, label: SEMANTIC_TAXONOMY[type].label, parentZoneId: PARENTS[type], anchorLandmarkIds: ANCHORS[type], bounds: { x, y, width: 1, height: 1 }, mask: { width: 1, height: 1, alpha: [0] }, geometry: { kind: candidate.kind, centerline: candidate.centerline, polygon: candidate.polygon }, optional: true, refinementMargin: 0 }); }
  for (const type of priority) { if (hidden.has(type)) continue; const candidate = candidates.get(type)!; const exclusive = candidate.full.slice(); for (let index = 0; index < exclusive.length; index += 1) if (exclusive[index] && claimed[index]) exclusive[index] = 0; else if (exclusive[index]) claimed[index] = 1; let extracted = boundsFromFullMask(exclusive, width, height); if (!extracted) { const anchor = byId.get(ANCHORS[type][0])!; let nearest = -1; let nearestDistance = Number.POSITIVE_INFINITY; for (let index = 0; index < alpha.length; index += 1) if (alpha[index] && !claimed[index]) { const x = index % width; const y = Math.floor(index / width); const distance = Math.hypot(x - anchor.x, y - anchor.y); if (distance < nearestDistance) { nearest = index; nearestDistance = distance; } } if (nearest >= 0) { const fallback = new Uint8Array(width * height); fallback[nearest] = 255; claimed[nearest] = 1; extracted = boundsFromFullMask(fallback, width, height); } } if (!extracted) { const anchor = byId.get(ANCHORS[type][0])!; const x = clamp(Math.round(anchor.x), 0, width - 1); const y = clamp(Math.round(anchor.y), 0, height - 1); extracted = { bounds: { x, y, width: 1, height: 1 }, mask: { width: 1, height: 1, alpha: [255] } }; } built.set(type, { zoneId: type, semanticType: type, label: SEMANTIC_TAXONOMY[type].label, parentZoneId: PARENTS[type], anchorLandmarkIds: ANCHORS[type], bounds: extracted.bounds, mask: extracted.mask, geometry: { kind: candidate.kind, centerline: candidate.centerline, polygon: candidate.polygon }, optional: false, refinementMargin: Math.max(2, Math.round(Math.min(width, height) * .025)) }); }
  return BODY_TYPES.map((type) => built.get(type)!);
}

export function buildAdaptiveAnatomicalPartitionGuide(state: Pick<PartCutterState, "sourceCanvasSize" | "parts">, foreground: readonly number[], requestedProfile: AnatomicalPartitionGuide["profile"] = "humanoid", timestamp = new Date().toISOString(), requestedProportions: GuideProportions = "auto"): AnatomicalPartitionGuide {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now(); const { width, height } = state.sourceCanvasSize; const alpha = foreground.map((value) => value > 0 ? 255 : 0); const profile = analyzeSilhouette(alpha, width, height); const proportions = requestedProportions === "auto" ? detectProportions(alpha, width, height) : requestedProportions; const analysis = descriptorFor(alpha, profile, requestedProfile, proportions); const landmarks = inferLandmarks(alpha, profile, analysis.descriptor, analysis.neckY, requestedProfile, analysis.hiddenLegs, analysis.armorLikely, proportions); const zones = adaptiveZones(alpha, width, height, landmarks, analysis.descriptor);
  const inferredLandmarkIds = landmarks.filter((landmark) => landmark.visibility === "inferred").map((landmark) => landmark.landmarkId); const needsReviewLandmarkIds = landmarks.filter((landmark) => landmark.visibility === "needs-review").map((landmark) => landmark.landmarkId);
  return { guideVersion: 1, profile: requestedProfile, sourceCanvasSize: state.sourceCanvasSize, landmarks, zones, adaptiveMetadata: { initializationMethod: "alpha-silhouette-adaptive-v1", topology: requestedProfile, topologyNeedsReview: requestedProfile === "custom" && analysis.descriptor.archetype === "custom", proportionDescriptor: analysis.descriptor, foregroundPixelCount: profile.foregroundPixelCount, inferredLandmarkIds, needsReviewLandmarkIds, runtimeMs: elapsed(started), proportions }, status: "seeded", createdAt: timestamp, updatedAt: timestamp };
}

const affectedZones: Readonly<Record<AnatomicalLandmarkId, readonly PartSemanticType[]>> = { root: [], pelvis: ["torso", "pelvis"], chest: ["torso"], neck: ["head", "torso"], head: ["head"], leftShoulder: ["torso", "leftUpperArm"], leftElbow: ["leftUpperArm", "leftForearm"], leftWrist: ["leftForearm", "leftHand"], rightShoulder: ["torso", "rightUpperArm"], rightElbow: ["rightUpperArm", "rightForearm"], rightWrist: ["rightForearm", "rightHand"], leftHip: ["pelvis", "leftThigh"], leftKnee: ["leftThigh", "leftLowerLeg"], leftAnkle: ["leftLowerLeg", "leftFoot"], rightHip: ["pelvis", "rightThigh"], rightKnee: ["rightThigh", "rightLowerLeg"], rightAnkle: ["rightLowerLeg", "rightFoot"], leftHock: ["leftLowerLeg", "leftFoot"], rightHock: ["rightLowerLeg", "rightFoot"] };
export function moveAdaptiveLandmark(guide: AnatomicalPartitionGuide, landmarkId: AnatomicalLandmarkId, point: Point, foreground: readonly number[], timestamp = new Date().toISOString()): AnatomicalPartitionGuide {
  if (!guide.adaptiveMetadata) throw new Error("Legacy guides must be explicitly regenerated before adaptive landmark editing"); const { width, height } = guide.sourceCanvasSize; const landmarks = guide.landmarks.map((landmark) => landmark.landmarkId === landmarkId ? { ...landmark, point: roundPoint(point, width, height), source: "manual" as const, visibility: "manual" as const, confidence: 1, method: "direct landmark drag" } : landmark); const rebuilt = adaptiveZones(foreground, width, height, landmarks, guide.adaptiveMetadata.proportionDescriptor); const affected = new Set(affectedZones[landmarkId]); const zones = guide.zones.map((zone) => affected.has(zone.semanticType) ? rebuilt.find((candidate) => candidate.semanticType === zone.semanticType) ?? zone : zone); return { ...guide, landmarks, zones, adaptiveMetadata: { ...guide.adaptiveMetadata, inferredLandmarkIds: guide.adaptiveMetadata.inferredLandmarkIds.filter((id) => id !== landmarkId), needsReviewLandmarkIds: guide.adaptiveMetadata.needsReviewLandmarkIds.filter((id) => id !== landmarkId) }, updatedAt: timestamp };
}

/** A joint found by a pose model, in source pixels, with the model's 0–1 confidence. */
export type PoseLandmarkPoint = { readonly point: Point; readonly confidence: number };

/**
 * Replaces the silhouette's guesses with joints found by a pose model and rebuilds every zone from them. Joints the
 * model did not supply keep their silhouette estimate, and joints a person has placed by hand are never replaced.
 */
export function applyPoseLandmarks(guide: AnatomicalPartitionGuide, points: Partial<Readonly<Record<AnatomicalLandmarkId, PoseLandmarkPoint>>>, foreground: readonly number[]): AnatomicalPartitionGuide {
  if (!guide.adaptiveMetadata) return guide;
  const { width, height } = guide.sourceCanvasSize;
  const bounds = guide.adaptiveMetadata.proportionDescriptor.foregroundBounds;
  // A limb joint must sit on the drawing. Pose models trained on photos place a hidden far limb, or a limb they confuse with
  // a held weapon, out in empty space; such a joint keeps its silhouette estimate (body-segmentation skill ch01, ch04).
  const reach = Math.max(2, Math.round(Math.min(bounds.width, bounds.height) * .03));
  const onDrawing = (point: Point): boolean => {
    for (let y = Math.max(0, Math.round(point.y) - reach); y <= Math.min(height - 1, Math.round(point.y) + reach); y += 1) for (let x = Math.max(0, Math.round(point.x) - reach); x <= Math.min(width - 1, Math.round(point.x) + reach); x += 1) if (foreground[y * width + x] > 0) return true;
    return false;
  };
  const limbJoint = /(Shoulder|Elbow|Wrist|Hip|Knee|Ankle|Hock)$/;
  const landmarks = guide.landmarks.map((landmark) => {
    const found = points[landmark.landmarkId];
    if (!found || landmark.source === "manual") return landmark;
    if (limbJoint.test(landmark.landmarkId) && !onDrawing(found.point)) return landmark;
    return { ...landmark, point: roundPoint(found.point, width, height), source: "pose_model" as const, visibility: "visible" as const, confidence: Math.max(0, Math.min(1, found.confidence)), method: "pose model keypoint" };
  });
  // When the silhouette shows one leg behind the other (a side view), it is the better witness: the pose model still
  // places two legs, guessing the far one. The far leg follows the near one, so the guide keeps it hidden.
  const original = new Map(guide.landmarks.map((landmark) => [landmark.landmarkId, landmark]));
  const same = (a?: AnatomicalLandmark, b?: AnatomicalLandmark) => Boolean(a && b && a.point.x === b.point.x && a.point.y === b.point.y);
  const legJoints = ["Hip", "Knee", "Ankle"] as const;
  const stackedLegs = same(original.get("leftKnee"), original.get("rightKnee")) && same(original.get("leftAnkle"), original.get("rightAnkle"))
    && legJoints.every((joint) => original.get(`right${joint}`)?.source !== "manual");
  const placed = stackedLegs ? landmarks.map((landmark) => {
    const joint = legJoints.find((name) => landmark.landmarkId === `right${name}`);
    const nearLeg = joint && landmarks.find((candidate) => candidate.landmarkId === `left${joint}`);
    return nearLeg ? { ...landmark, point: nearLeg.point, source: nearLeg.source, visibility: "inferred" as const, confidence: nearLeg.confidence, method: "hidden behind the near leg" } : landmark;
  }) : landmarks;
  const alpha = foreground.map((value) => value > 0 ? 255 : 0);
  const zones = adaptiveZones(alpha, width, height, placed, guide.adaptiveMetadata.proportionDescriptor);
  const moved = placed.filter((landmark) => landmark.source === "pose_model").map((landmark) => landmark.landmarkId);
  return {
    ...guide, landmarks: placed, zones,
    adaptiveMetadata: {
      ...guide.adaptiveMetadata,
      inferredLandmarkIds: guide.adaptiveMetadata.inferredLandmarkIds.filter((id) => !moved.includes(id)),
      needsReviewLandmarkIds: guide.adaptiveMetadata.needsReviewLandmarkIds.filter((id) => !moved.includes(id)),
    },
  };
}

/** A point on something the character holds, found from the silhouette, to prompt a click-to-select model with. */
/**
 * `points` is the prompt: `point` first, then up to two more spread over the same unclaimed patch of artwork. One point is
 * ambiguous to a click-to-select model (the grip, or the whole shield?); several on the same object settle it on the
 * whole object (body-segmentation skill ch02).
 */
export type HeldObjectSeed = {
  readonly point: Point; readonly points: readonly Point[]; readonly weight: number;
  /** From a hand rather than the silhouette: a fallback for items drawn inside the arm, whose mask can be the arm itself. */
  readonly fromHand?: boolean;
};

/**
 * Points on held objects (a sword, a shield), for a promptable segmenter such as SAM to cut out (body-segmentation skill
 * ch02: the model gives the shape; ch01: held objects are what pose and silhouette guides get wrong). A held object shows
 * in the silhouette as a run of pixels that does not belong to any body zone and does not carry down to the ground the
 * way a leg does: a blade tip below the hip, a shield rim beside the body. Heaviest first, at most `limit`.
 */
export function heldObjectSeeds(guide: AnatomicalPartitionGuide, foreground: readonly number[], limit = 6): readonly HeldObjectSeed[] {
  const { width, height } = guide.sourceCanvasSize; const alpha = foreground.map((value) => value > 0 ? 255 : 0);
  const profile = analyzeSilhouette(alpha, width, height); const bounds = profile.foregroundBounds;
  if (!bounds.width || !bounds.height) return [];
  const at = (id: AnatomicalLandmarkId) => guide.landmarks.find((landmark) => landmark.landmarkId === id)?.point;
  // The whole figure height: a raised blade or a staff head can stand above the neck.
  const top = bounds.y; const bottom = Math.max(at("leftAnkle")?.y ?? 0, at("rightAnkle")?.y ?? 0) || bounds.y + bounds.height;
  const inZone = (x: number, y: number) => guide.zones.some((zone) => {
    if (!zone.mask) return false; const localX = Math.round(x) - zone.bounds.x; const localY = Math.round(y) - zone.bounds.y;
    return localX >= 0 && localY >= 0 && localX < zone.mask.width && localY < zone.mask.height && zone.mask.alpha[localY * zone.mask.width + localX] > 0;
  });
  const hipLine = Math.max(at("leftHip")?.y ?? 0, at("rightHip")?.y ?? 0, at("pelvis")?.y ?? 0) || bounds.y + bounds.height * .55;
  const minWidth = Math.max(2, Math.round(bounds.width * .02)); const spacing = Math.max(bounds.width, bounds.height) * .08;
  const seeds: HeldObjectSeed[] = [];
  const rows = 24;
  for (let step = 0; step <= rows; step += 1) {
    const y = Math.round(top + (bottom - top) * step / rows);
    for (const segment of massSegments(alpha, profile, y, 0, minWidth)) {
      const point = { x: Math.round(segment.centroid), y };
      // Below the hips a run outside the zones can still be leg (wide trousers, a robe), which reaches the ground; above
      // them, anything outside the body zones is a candidate (a raised blade is joined to the ground through the hand).
      if (!alpha[y * width + point.x] || inZone(point.x, y) || (y > hipLine && reachesGround(alpha, profile, y, segment))) continue;
      if (seeds.some((seed) => Math.hypot(seed.point.x - point.x, seed.point.y - point.y) < spacing)) continue;
      seeds.push({ point, points: [point], weight: segment.weight });
    }
  }
  // Spread two more prompt points over the unclaimed artwork around each seed (not in any body zone, within reach), by
  // farthest-point sampling over a breadth-first walk from the seed.
  const reach = Math.max(bounds.width, bounds.height) * .12;
  const spread = (seed: Point, allowed: (x: number, y: number) => boolean = (x, y) => !inZone(x, y)): readonly Point[] => {
    const start = Math.round(seed.y) * width + Math.round(seed.x); const visited = new Map<number, number>([[start, 0]]); const queue = [start];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]; const x = index % width; const y = Math.floor(index / width);
      for (const next of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) {
        if (next < 0 || visited.has(next) || !alpha[next]) continue;
        const nx = next % width; const ny = Math.floor(next / width);
        if (Math.hypot(nx - seed.x, ny - seed.y) > reach || !allowed(nx, ny)) continue;
        visited.set(next, 0); queue.push(next);
      }
    }
    const chosen: Point[] = [seed];
    for (let round = 0; round < 2 && queue.length > 1; round += 1) {
      let best = -1; let bestDistance = 0;
      for (const index of queue) { const x = index % width; const y = Math.floor(index / width); const distance = Math.min(...chosen.map((point) => Math.hypot(x - point.x, y - point.y))); if (distance > bestDistance) { bestDistance = distance; best = index; } }
      if (best < 0 || bestDistance < Math.max(2, reach * .15)) break;
      // Pull the point a quarter of the way back toward the seed, off the patch's very edge.
      const x = best % width; const y = Math.floor(best / width); const pulled = { x: Math.round(x + (seed.x - x) * .25), y: Math.round(y + (seed.y - y) * .25) };
      chosen.push(alpha[pulled.y * width + pulled.x] && allowed(pulled.x, pulled.y) ? pulled : { x, y });
    }
    return chosen;
  };
  const fromSilhouette = seeds.sort((a, b) => b.weight - a.weight).slice(0, limit).map((seed) => ({ ...seed, points: spread(seed.point) }));
  // Also each hand itself: an item drawn over the arm (a small sprite's shield across its forearm) lies inside the body
  // zones and leaves no unclaimed run, but a click on the hand that holds it returns hand and item together.
  const hands = (["left", "right"] as const).flatMap((side) => {
    const zone = guide.zones.find((candidate) => candidate.semanticType === `${side}Hand` && candidate.mask);
    if (!zone?.mask) return [];
    let sx = 0; let sy = 0; let n = 0;
    for (let y = 0; y < zone.mask.height; y += 1) for (let x = 0; x < zone.mask.width; x += 1) if (zone.mask.alpha[y * zone.mask.width + x]) { sx += x; sy += y; n += 1; }
    if (!n) return [];
    const point = { x: Math.round(zone.bounds.x + sx / n), y: Math.round(zone.bounds.y + sy / n) };
    // Spread over the hand and what it holds: anything but the other body zones (the head, torso, legs, upper arms).
    const notBody = (x: number, y: number) => !guide.zones.some((other) => other.mask && !/(Hand|Forearm)$/.test(other.semanticType) && (() => { const lx = x - other.bounds.x; const ly = y - other.bounds.y; return lx >= 0 && ly >= 0 && lx < other.mask!.width && ly < other.mask!.height && other.mask!.alpha[ly * other.mask!.width + lx] > 0; })());
    const seedsHere: HeldObjectSeed[] = alpha[point.y * width + point.x] ? [{ point, points: spread(point, notBody), weight: 0, fromHand: true }] : [];
    // A held item carries on along the arm past the hand: a point one hand-length beyond the wrist, along the forearm.
    const wrist = at(`${side}Wrist`); const elbow = at(`${side}Elbow`);
    if (wrist && elbow) {
      // Two points along that line (more than one prompt on the same object settles a click-to-select model on it whole).
      const along = [.6, 1.1].map((share) => ({ x: Math.round(wrist.x + (wrist.x - elbow.x) * share), y: Math.round(wrist.y + (wrist.y - elbow.y) * share) }))
        .filter((point) => point.x >= 0 && point.y >= 0 && point.x < width && point.y < height && alpha[point.y * width + point.x]);
      if (along.length) seedsHere.push({ point: along[0], points: along, weight: 0, fromHand: true });
    }
    return seedsHere;
  });
  return [...fromSilhouette, ...hands];
}

/**
 * Whether a mask returned for a held-object seed is something held, and in which hand: it must come close to a hand
 * (held objects are held), must not be most of the character or mostly body, and must not repeat one of `found` (the
 * other held items; pass all of them, so an arm zone drawn across another item does not count as that hand). Hands are
 * named by screen side, like the guide's limbs. Null when the mask is not a held object.
 */
export function heldObjectHand(guide: AnatomicalPartitionGuide, mask: SegmentationMask, maskBounds: Rect, foreground: readonly number[], found: readonly { readonly bounds: Rect; readonly mask: SegmentationMask }[] = []): "left" | "right" | null {
  const area = mask.alpha.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0); const visible = foreground.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0);
  if (!area || area > visible * .3 || area < visible * .002) return null;
  const has = (other: { readonly bounds: Rect; readonly mask: SegmentationMask }, x: number, y: number) => { const localX = x - other.bounds.x; const localY = y - other.bounds.y; return localX >= 0 && localY >= 0 && localX < other.mask.width && localY < other.mask.height && other.mask.alpha[localY * other.mask.width + localX] > 0; };
  let overlap = 0;
  for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) if (mask.alpha[y * mask.width + x] && found.some((other) => has(other, maskBounds.x + x, maskBounds.y + y))) overlap += 1;
  if (overlap > area * .5) return null;
  // A mask lying mostly inside the body's own zones is the body, not something held. The hand and forearm zones are left
  // out of this: they are rough guesses around the hand, and an item held in the hand naturally lies across them.
  const bodyZones = guide.zones.filter((zone) => zone.mask && !/(Hand|Forearm)$/.test(zone.semanticType));
  let onBody = 0;
  for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) if (mask.alpha[y * mask.width + x] && bodyZones.some((zone) => has({ bounds: zone.bounds, mask: zone.mask! }, maskBounds.x + x, maskBounds.y + y))) onBody += 1;
  if (onBody > area * .5) return null;
  const figure = guide.adaptiveMetadata?.proportionDescriptor.foregroundBounds ?? { x: 0, y: 0, width: guide.sourceCanvasSize.width, height: guide.sourceCanvasSize.height };
  // Generous: a wrist estimated from the silhouette alone can sit well above the hand actually drawn (an adult arm hangs
  // past the hip line), and the nearest hand still wins.
  const reach = Math.max(3, Math.max(figure.width, figure.height) * .12);
  // Distance from the mask to each side's hand: its hand and forearm zones as well as its wrist point, so an item held
  // below a wrist that was estimated too high (or whose mask stops at the crossguard, leaving the grip to the hand) still
  // finds its hand. Measured on a coarse grid with a breadth-first distance map, so it stays fast on large sprites.
  // A long object (a blade, a spear, a staff) is held at one end, so only its two ends count; its middle can pass close to
  // the other hand. The ends are the extremes along the mask's principal axis.
  const grip = ((): readonly [Point, Point] | null => {
    let sx = 0; let sy = 0; let n = 0;
    for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) if (mask.alpha[y * mask.width + x]) { sx += x; sy += y; n += 1; }
    if (!n) return null; const mx = sx / n; const my = sy / n; let xx = 0; let yy = 0; let xy = 0;
    for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) if (mask.alpha[y * mask.width + x]) { xx += (x - mx) ** 2; yy += (y - my) ** 2; xy += (x - mx) * (y - my); }
    const trace = (xx + yy) / n; const det = (xx * yy - xy * xy) / (n * n); const gap = Math.sqrt(Math.max(0, trace * trace / 4 - det));
    const major = trace / 2 + gap; const minor = Math.max(1e-6, trace / 2 - gap);
    if (Math.sqrt(major / minor) < 2.5) return null;
    const angle = .5 * Math.atan2(2 * xy, xx - yy); const ux = Math.cos(angle); const uy = Math.sin(angle);
    let low = { t: Number.POSITIVE_INFINITY, x: 0, y: 0 }; let high = { t: Number.NEGATIVE_INFINITY, x: 0, y: 0 };
    for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) if (mask.alpha[y * mask.width + x]) { const t = (x - mx) * ux + (y - my) * uy; if (t < low.t) low = { t, x, y }; if (t > high.t) high = { t, x, y }; }
    return [{ x: maskBounds.x + low.x, y: maskBounds.y + low.y }, { x: maskBounds.x + high.x, y: maskBounds.y + high.y }];
  })();
  const { width, height } = guide.sourceCanvasSize; const cell = Math.max(1, Math.ceil(Math.max(width, height) / 256));
  const columns = Math.ceil(width / cell); const rows = Math.ceil(height / cell);
  const distanceTo = (hand: "left" | "right"): number => {
    const grid = new Int32Array(columns * rows).fill(-1); const queue: number[] = [];
    const seed = (x: number, y: number) => { const index = Math.min(rows - 1, Math.max(0, Math.floor(y / cell))) * columns + Math.min(columns - 1, Math.max(0, Math.floor(x / cell))); if (grid[index] < 0) { grid[index] = 0; queue.push(index); } };
    const wrist = guide.landmarks.find((landmark) => landmark.landmarkId === `${hand}Wrist`)?.point; if (wrist) seed(wrist.x, wrist.y);
    for (const zone of guide.zones) {
      if (zone.semanticType !== `${hand}Hand` && zone.semanticType !== `${hand}Forearm` || !zone.mask) continue;
      // Zone pixels lying inside another held item are that item, not the arm (a forearm zone drawn across a shield).
      for (let y = 0; y < zone.mask.height; y += 1) for (let x = 0; x < zone.mask.width; x += 1) if (zone.mask.alpha[y * zone.mask.width + x] && !found.some((other) => has(other, zone.bounds.x + x, zone.bounds.y + y))) seed(zone.bounds.x + x, zone.bounds.y + y);
    }
    if (!queue.length) return Number.POSITIVE_INFINITY;
    // The two ends of a long object: straight-line distance to the nearest hand cell (the grid walk below overstates diagonals).
    if (grip) return Math.min(...grip.map((end) => Math.min(...queue.map((index) => Math.hypot((index % columns + .5) * cell - end.x, (Math.floor(index / columns) + .5) * cell - end.y)))));
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]; const x = index % columns; const y = Math.floor(index / columns);
      for (const next of [x > 0 ? index - 1 : -1, x + 1 < columns ? index + 1 : -1, y > 0 ? index - columns : -1, y + 1 < rows ? index + columns : -1]) if (next >= 0 && grid[next] < 0) { grid[next] = grid[index] + 1; queue.push(next); }
    }
    const at = (x: number, y: number) => grid[Math.min(rows - 1, Math.max(0, Math.floor(y / cell))) * columns + Math.min(columns - 1, Math.max(0, Math.floor(x / cell)))] * cell;
    let nearest = Number.POSITIVE_INFINITY;
    for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) if (mask.alpha[y * mask.width + x]) nearest = Math.min(nearest, at(maskBounds.x + x, maskBounds.y + y));
    return nearest;
  };
  const left = distanceTo("left"); const right = distanceTo("right");
  const best: { hand: "left" | "right"; distance: number } = left <= right ? { hand: "left", distance: left } : { hand: "right", distance: right };
  const other = Math.max(left, right);
  // Close to a hand; or a little further when one hand is clearly the nearer (a wrist estimated from the silhouette can sit
  // above the grip it holds).
  if (!(best.distance <= reach || (best.distance <= reach * 2 && other >= best.distance * 1.75))) return null;
  // A held item reaches past the hand: its far end lies at least a forearm's length from the wrist. A hand or a glove
  // (what a click on the fingers returns) does not.
  const point = (id: AnatomicalLandmarkId) => guide.landmarks.find((landmark) => landmark.landmarkId === id)?.point;
  const wrist = point(`${best.hand}Wrist`); const elbow = point(`${best.hand}Elbow`);
  if (wrist && elbow) {
    const forearm = Math.hypot(wrist.x - elbow.x, wrist.y - elbow.y); let extent = 0;
    for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) if (mask.alpha[y * mask.width + x]) extent = Math.max(extent, Math.hypot(maskBounds.x + x - wrist.x, maskBounds.y + y - wrist.y));
    if (extent < forearm) return null;
  }
  return best.hand;
}
