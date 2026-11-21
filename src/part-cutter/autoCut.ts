/**
 * Cut all parts: joints → a stroke along each bone → each part grown out from its stroke along the drawing
 * (applyCutPlan), then committed part by part like a guided cut.
 *
 * Measured on the cut bench (scripts/cut-bench.mts, 11 hand-labelled characters): the previous cut (zones around the
 * joints, seams snapped to edges) got 77% of pixels right (84% counting pixels within 2% of a seam for either side); this
 * one 85% (91%). With joints placed exactly it reaches 91% (96%), about where two careful people agree, so what remains is
 * joint accuracy. The leg joints come from the drawing itself (legJoints): on the bench, hips, knees and ankles within
 * about 2–3% of the figure's height, where the silhouette guide and the pose model were 4–6% off.
 */
import type { PartCutterState } from "./schema";
import { applyCutPlan, PLAN_PARTS, type CutPlan, type PlanPoint } from "./cutPlan";
import { commitGuidedSelection, GUIDED_BODY_ORDER, initializeGuidedManual } from "./guidedManual";

type Point = { readonly x: number; readonly y: number };
type Run = { readonly a: number; readonly b: number };
export type Joints = Readonly<Record<string, Point>>;

/**
 * Leg joints read from the silhouette. From the feet up, the two leg columns are followed until they merge, or until a
 * substantial piece hangs between them (a tabard, a loincloth): that row is the hip line, the hem of whatever hangs over
 * the legs. Trousers instead split at the crotch, so above a split no wider than the legs the hip is the first drawn line
 * across the body (the waistband). Ankles are each column's narrowest row above the foot; knees are halfway between, the
 * rule for a leg with nothing marking the knee. Null when the figure has no two separate legs (a robe, a blob).
 */
export function legJoints(width: number, height: number, foreground: ArrayLike<number>, colours?: ArrayLike<number>): Joints | null {
  let top = height; let bottom = -1;
  for (let index = 0; index < width * height; index += 1) if (foreground[index]) { const y = Math.floor(index / width); if (y < top) top = y; if (y > bottom) bottom = y; }
  if (bottom < 0) return null;
  const h = bottom - top + 1; const minGap = Math.max(2, Math.round(h * .006)); const minRun = Math.max(3, Math.round(h * .02));
  const runs = (y: number): Run[] => {
    const out: Run[] = []; let a = -1; let gap = 0;
    for (let x = 0; x < width; x += 1) { if (foreground[y * width + x]) { if (a < 0) a = x; gap = 0; } else if (a >= 0 && ++gap > minGap) { out.push({ a, b: x - gap }); a = -1; gap = 0; } }
    if (a >= 0) out.push({ a, b: width - 1 });
    return out.filter((run) => run.b - run.a + 1 >= minRun);
  };
  // The lowest row (within the bottom fifth) with two separate columns: the feet can touch, or one can be lower.
  let footY = bottom - Math.round(h * .01); let legs = runs(footY);
  for (let y = footY; y > bottom - h * .2 && legs.length < 2; y -= 1) { footY = y; legs = runs(y); }
  if (legs.length < 2) return null;
  legs = [...legs].sort((p, q) => (q.b - q.a) - (p.b - p.a)).slice(0, 2).sort((p, q) => p.a - q.a);
  let left = legs[0]; let right = legs[1]; let hipY = top;
  const stretch: { readonly y: number; readonly l: Run; readonly r: Run }[] = [];
  let missed = 0; const tolerance = Math.max(2, Math.round(h * .02));
  for (let y = footY; y > top + h * .3; y -= 1) {
    const row = runs(y);
    const nl = row.find((run) => run.b >= left.a - 4 && run.a <= left.b + 4); const nr = row.find((run) => run.b >= right.a - 4 && run.a <= right.b + 4);
    const split = Boolean(nl && nr && nl !== nr);
    const between = split && footY - y > h * .1 && row.some((run) => run !== nl && run !== nr && run.a > nl!.b && run.b < nr!.a && (run.b - run.a) > (nr!.a - nl!.b) * .4);
    if (!split || between) { if (between || ++missed > tolerance) { hipY = y + 1 + (between ? 0 : missed - 1); break; } continue; }
    missed = 0; left = nl!; right = nr!; stretch.push({ y, l: nl!, r: nr! });
  }
  if (!stretch.length) return null;
  const legLength = footY - hipY;
  const ankle = (side: "l" | "r"): Point => {
    let best: (typeof stretch)[number] | undefined;
    for (const row of stretch) if (row.y > footY - legLength * .55 && row.y < footY - legLength * .08 && (!best || row[side].b - row[side].a < best[side].b - best[side].a)) best = row;
    best ??= stretch[Math.floor(stretch.length * .2)];
    return { x: (best[side].a + best[side].b) / 2, y: best.y };
  };
  let waistY = hipY;
  if (colours) {
    const luminance = (index: number) => (colours[index * 4] * .299 + colours[index * 4 + 1] * .587 + colours[index * 4 + 2] * .114) / 255;
    const lineShare = (y: number): number => {
      let seen = 0; let line = 0;
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x; if (!foreground[index]) continue; seen += 1;
        const up = index - width * 2; const down = index + width * 2;
        const jump = foreground[up] && foreground[down] ? Math.hypot(colours[up * 4] - colours[down * 4], colours[up * 4 + 1] - colours[down * 4 + 1], colours[up * 4 + 2] - colours[down * 4 + 2]) : 0;
        if (luminance(index) < .22 || jump > 90) line += 1;
      }
      return seen ? line / seen : 0;
    };
    const widest = runs(Math.max(top, hipY - 3)).sort((p, q) => (q.b - q.a) - (p.b - p.a))[0];
    const hangingGarment = widest && (widest.b - widest.a) > (right.b - left.a) * 1.25;
    if (!hangingGarment) for (let y = hipY - 2; y > hipY - h * .14; y -= 1) if (lineShare(y) > .6) { waistY = y; break; }
  }
  const columnAt = (side: "l" | "r") => { const row = stretch[stretch.length - 1]; return (row[side].a + row[side].b) / 2; };
  const leftHip = { x: columnAt("l"), y: waistY }; const rightHip = { x: columnAt("r"), y: waistY };
  const leftAnkle = ankle("l"); const rightAnkle = ankle("r");
  return {
    leftHip, rightHip, leftAnkle, rightAnkle,
    leftKnee: { x: (leftHip.x + leftAnkle.x) / 2, y: (leftHip.y + leftAnkle.y) / 2 }, rightKnee: { x: (rightHip.x + rightAnkle.x) / 2, y: (rightHip.y + rightAnkle.y) / 2 },
    pelvis: { x: (leftHip.x + rightHip.x) / 2, y: waistY },
  };
}

/** A stroke along the middle of each bone (and past the wrist and ankle for the hand and foot), as a cut plan. */
export function bonePlan(joints: Joints): CutPlan {
  const strokes: Record<string, PlanPoint[][]> = {};
  const lerp = (a: Point, b: Point, t: number): PlanPoint => [Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t)];
  const along = (part: string, a: Point | undefined, b: Point | undefined, from: number, to: number) => { if (a && b) (strokes[part] ??= []).push([lerp(a, b, from), lerp(a, b, to)]); };
  along("head", joints.neck, joints.head, .45, 1.3);
  along("torso", joints.neck, joints.pelvis, .2, .85);
  for (const side of ["left", "right"]) {
    const j = (name: string) => joints[`${side}${name}`];
    along(`${side}UpperArm`, j("Shoulder"), j("Elbow"), .3, .7); along(`${side}Forearm`, j("Elbow"), j("Wrist"), .3, .7); along(`${side}Hand`, j("Elbow"), j("Wrist"), 1.15, 1.35);
    along(`${side}Thigh`, j("Hip"), j("Knee"), .3, .7); along(`${side}LowerLeg`, j("Knee"), j("Ankle"), .3, .7); along(`${side}Foot`, j("Knee"), j("Ankle"), 1.15, 1.3);
  }
  return { scribbles: strokes };
}

export type AutoCutResult = { readonly state: PartCutterState; readonly cut: readonly string[]; readonly hidden: readonly string[]; readonly joints: Joints };

/**
 * Cuts every body part from the guide's joints (its leg joints replaced by legJoints when the legs are readable). Each part
 * is committed through commitGuidedSelection, so it is one guided cut per part: undo, ownership and review behave as for
 * Use Guide. A part that gets no pixels is reported hidden and skipped.
 */
export function autoCutBodyParts(state: PartCutterState, foreground: readonly number[], colours: ArrayLike<number>, at?: string): AutoCutResult {
  const { width, height } = state.sourceCanvasSize;
  const fromGuide = Object.fromEntries((state.anatomicalGuide?.landmarks ?? []).map((landmark) => [landmark.landmarkId, landmark.point])) as Record<string, Point>;
  const legs = legJoints(width, height, foreground, colours);
  const joints: Joints = legs ? { ...fromGuide, ...legs } : fromGuide;
  const labels = applyCutPlan(bonePlan(joints), { width, height, data: colours, foreground });
  let current = initializeGuidedManual(state, at); const cut: string[] = []; const hidden: string[] = [];
  for (const semantic of GUIDED_BODY_ORDER) {
    const label = PLAN_PARTS.indexOf(semantic as (typeof PLAN_PARTS)[number]) + 1;
    let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
    for (let index = 0; index < labels.length; index += 1) if (labels[index] === label) { const x = index % width; const y = (index - x) / width; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) { hidden.push(semantic); continue; }
    const w = x1 - x0 + 1; const h = y1 - y0 + 1; const alpha = new Array<number>(w * h).fill(0);
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) if (labels[y * width + x] === label) alpha[(y - y0) * w + (x - x0)] = 255;
    const positioned: PartCutterState = { ...current, guidedManual: { ...current.guidedManual!, phase: "body", currentSemantic: semantic, intent: "replace" } };
    const result = commitGuidedSelection(positioned, { bounds: { x: x0, y: y0, width: w, height: h }, mask: { width: w, height: h, alpha } }, foreground, at, true);
    if (result.ok) { current = result.state; cut.push(semantic); } else hidden.push(semantic);
  }
  if (hidden.length) {
    const progress = current.guidedManual!;
    current = { ...current, guidedManual: { ...progress, skippedSemantics: [...new Set([...progress.skippedSemantics, ...(hidden as typeof progress.skippedSemantics)])] } };
  }
  return { state: current, cut, hidden, joints };
}
