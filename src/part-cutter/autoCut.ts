/**
 * Cut all parts: joints → a stroke along each bone → each part grown out from its stroke along the drawing
 * (applyCutPlan), then committed part by part like a guided cut.
 *
 * Measured on the cut bench (scripts/cut-bench.mts, 11 hand-labelled characters): the previous cut (zones around the
 * joints, seams snapped to edges) got 77% of pixels right (84% counting pixels within 2% of a seam for either side); this
 * one 85% (91%), and with the joint corrections of centreOnLegs and the ankle rule 89.7% (95.5%). With joints placed exactly it reaches 93% (97.5%), about where two careful people agree, so what remains is
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
 * across the body (the waistband). Ankles are each column's narrowest row above the foot (at least 4% of the figure's height up, so the narrowing sole of a big shoe is not taken for the ankle); knees are halfway between, the
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
    for (const row of stretch) if (row.y > footY - legLength * .55 && row.y < footY - Math.max(legLength * .08, h * .04) && (!best || row[side].b - row[side].a < best[side].b - best[side].a)) best = row;
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

/**
 * Upper-body joints settled from what the cut conventions and the drawing say, where the pose model is systematically off.
 * Shoulders go to where the sleeve meets the body: the pose model puts them at the anatomical shoulder, on the neck line, 2–12%
 * of the figure's height too high, so they go to at least 0.3 of the way from the neck down to the pelvis (the proportion the
 * hand-labelled seams average; x is left to the pose model). A hanging hand is not much wider apart than the shoulders, so a
 * wrist further than that from the body's axis (the pose model puts it on a held sword or staff) is pulled in along the line
 * from its shoulder.
 */
export function settleArms(joints: Joints, figureHeight?: number): Joints {
  const { pelvis } = joints; let { neck } = joints;
  // A plausibility check for big-headed (chibi) figures, whose head point sits 0.14-0.28 of the figure's height above the
  // chin: the joints can put the neck right under the head point when a long beard or a hood hangs below the face, and the
  // head ends at its lowest own drawn edge, so a neck less than 0.1 under the head point goes to 0.25 under it. Fitted on one
  // bench figure (the dwarf, 77.8% -> 85.9%), so only applied when figureHeight is given, i.e. for chibi proportions:
  // an adult's head is about an eighth of its height, and its neck is rightly ~0.07 under the head point.
  const head = joints.head;
  if (figureHeight && neck && head && neck.y - head.y < figureHeight * .1) neck = { x: neck.x, y: head.y + figureHeight * .25 };
  if (neck && neck !== joints.neck) joints = { ...joints, neck };
  if (!neck || !pelvis) return joints;
  const out: Record<string, Point> = { ...joints }; const floor = neck.y + (pelvis.y - neck.y) * .3;
  for (const side of ["left", "right"]) { const shoulder = joints[`${side}Shoulder`]; if (shoulder && shoulder.y < floor) out[`${side}Shoulder`] = { x: shoulder.x, y: floor }; }
  const { leftShoulder, rightShoulder } = out;
  if (!leftShoulder || !rightShoulder) return out;
  const reach = Math.abs(rightShoulder.x - leftShoulder.x) * 1.05; const axis = (leftShoulder.x + rightShoulder.x) / 2;
  for (const side of ["left", "right"]) {
    const shoulder = out[`${side}Shoulder`]; const wrist = joints[`${side}Wrist`];
    if (!wrist || Math.abs(wrist.x - axis) <= reach || wrist.x === shoulder.x) continue;
    const x = axis + Math.sign(wrist.x - axis) * reach; const along = (x - shoulder.x) / (wrist.x - shoulder.x);
    if (along > 0 && along < 1) out[`${side}Wrist`] = { x, y: shoulder.y + (wrist.y - shoulder.y) * along };
  }
  return out;
}

/**
 * Strokes along the middle of each bone (and past the wrist and ankle for the hand and foot), as a cut plan. The head and the
 * torso are wide, so a thin stroke down the middle leaves their sides to whichever limb or garment reaches them first: the
 * head also gets a stroke across its width, and the torso strokes across the chest (about as wide as the shoulders, so clear
 * of the arms) plus a solid block between the shoulders, from the upper chest to three quarters of the way to the pelvis
 * (stopping above it, so where the hip seam falls is left to the drawing: reaching lower took leg armour beside a
 * tabard into the torso). Measured on the cut bench: 86.2% -> 87.8% (92.2% -> 93.6% seam-tolerant).
 */
export function bonePlan(joints: Joints): CutPlan {
  const strokes: Record<string, PlanPoint[][]> = {};
  const lerp = (a: Point, b: Point, t: number): PlanPoint => [Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t)];
  const along = (part: string, a: Point | undefined, b: Point | undefined, from: number, to: number) => { if (a && b) (strokes[part] ??= []).push([lerp(a, b, from), lerp(a, b, to)]); };
  const across = (part: string, a: Point, b: Point, t: number, half: number) => { const c = lerp(a, b, t); (strokes[part] ??= []).push([[Math.round(c[0] - half), c[1]], [Math.round(c[0] + half), c[1]]]); };
  const { neck, head, pelvis, leftShoulder, rightShoulder } = joints;
  along("head", neck, head, .45, 1.3);
  if (neck && head) { const reach = Math.hypot(head.x - neck.x, head.y - neck.y) * .8; for (const t of [.7, 1.2]) across("head", neck, head, t, reach); }
  along("torso", neck, pelvis, .2, .85);
  let parts: Record<string, PlanPoint[][]> | undefined;
  if (neck && pelvis && leftShoulder && rightShoulder) {
    const half = Math.abs(rightShoulder.x - leftShoulder.x) / 2;
    for (const t of [.35, .55]) across("torso", neck, pelvis, t, half * .7);
    const top = lerp(neck, pelvis, .25); const bottom = lerp(neck, pelvis, .75); const side = half * .6;
    parts = { torso: [[[top[0] - side, top[1]], [top[0] + side, top[1]], [bottom[0] + side, bottom[1]], [bottom[0] - side, bottom[1]]]] };
  }
  for (const side of ["left", "right"]) {
    const j = (name: string) => joints[`${side}${name}`];
    // The arm seeds sit towards the elbow and the wrist's middle: the shoulder and wrist joints are the least certain.
    along(`${side}UpperArm`, j("Shoulder"), j("Elbow"), .6, .8); along(`${side}Forearm`, j("Elbow"), j("Wrist"), .4, .6); along(`${side}Hand`, j("Elbow"), j("Wrist"), 1.15, 1.35);
    along(`${side}Thigh`, j("Hip"), j("Knee"), .3, .7); along(`${side}LowerLeg`, j("Knee"), j("Ankle"), .3, .7); along(`${side}Foot`, j("Knee"), j("Ankle"), 1.15, 1.3);
  }
  return { scribbles: strokes, ...(parts ? { parts } : {}) };
}

/**
 * Capes and cloaks hang from the shoulders, so by the cut conventions they are torso, but their colour is often the sleeve's
 * and the nearest limb stroke then floods the whole cape. A large piece of the silhouette far from every stroke (more than
 * 8% of the figure's height, at least 3% of its area) at body height, between a fifth of the way from neck to pelvis and a
 * little below the pelvis, gets a torso stroke from its deepest point a third of the way back towards the body's axis. Pieces
 * higher up (the head, hair, ears) or lower down (a tail, feet) are left alone. Measured on the cut bench: 89.7% -> 90.4%
 * (95.5% -> 96.2% seam-tolerant), the two capes 80.8% -> 85.8% and 87.4% -> 90.3%.
 */
export function addMassStrokes(plan: CutPlan, joints: Joints, width: number, height: number, foreground: ArrayLike<number>): CutPlan {
  const { neck, pelvis } = joints; if (!neck || !pelvis) return plan;
  const size = width * height; let area = 0; let top = height; let bottom = -1;
  for (let index = 0; index < size; index += 1) if (foreground[index]) { area += 1; const y = Math.floor(index / width); if (y < top) top = y; if (y > bottom) bottom = y; }
  if (!area) return plan;
  const figure = bottom - top + 1; const far = figure * .08;
  // Distance to the nearest stroke or hard region corner, through the character, by two chamfer passes.
  const dist = new Float32Array(size).fill(Number.POSITIVE_INFINITY);
  const mark = (x: number, y: number) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < width && y < height) dist[y * width + x] = 0; };
  for (const value of [...Object.values(plan.scribbles ?? {}), ...Object.values(plan.parts ?? {})]) for (const polygon of (typeof (value as readonly PlanPoint[][])[0]?.[0] === "number" ? [value] : value) as readonly (readonly PlanPoint[])[]) for (let i = 0; i < polygon.length; i += 1) {
    const [ax, ay] = polygon[i]; const [bx, by] = polygon[Math.min(i + 1, polygon.length - 1)]; const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let t = 0; t <= steps; t += 1) mark(ax + (bx - ax) * t / steps, ay + (by - ay) * t / steps);
  }
  const relax = (index: number, other: number, cost: number) => { if (foreground[other] && dist[other] + cost < dist[index]) dist[index] = dist[other] + cost; };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const index = y * width + x; if (!foreground[index]) continue; if (x > 0) relax(index, index - 1, 1); if (y > 0) { relax(index, index - width, 1); if (x > 0) relax(index, index - width - 1, 1.414); if (x < width - 1) relax(index, index - width + 1, 1.414); } }
  for (let y = height - 1; y >= 0; y -= 1) for (let x = width - 1; x >= 0; x -= 1) { const index = y * width + x; if (!foreground[index]) continue; if (x < width - 1) relax(index, index + 1, 1); if (y < height - 1) { relax(index, index + width, 1); if (x > 0) relax(index, index + width - 1, 1.414); if (x < width - 1) relax(index, index + width + 1, 1.414); } }
  const isFar = (index: number) => foreground[index] && dist[index] > far && Number.isFinite(dist[index]);
  const low = neck.y + (pelvis.y - neck.y) * .2; const high = pelvis.y + figure * .05;
  const seen = new Uint8Array(size); const extra: PlanPoint[][] = [];
  for (let start = 0; start < size; start += 1) {
    if (seen[start] || !isFar(start)) continue;
    const piece = [start]; seen[start] = 1; let deepest = start;
    for (let k = 0; k < piece.length; k += 1) {
      const at = piece[k]; if (dist[at] > dist[deepest]) deepest = at; const x = at % width;
      for (const next of [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1, at - width, at + width]) if (next >= 0 && next < size && !seen[next] && isFar(next)) { seen[next] = 1; piece.push(next); }
    }
    const x = deepest % width; const y = Math.floor(deepest / width);
    if (piece.length >= area * .03 && y >= low && y <= high) extra.push([[x, y], [Math.round(x + (pelvis.x - x) / 3), y]]);
  }
  return extra.length ? { ...plan, scribbles: { ...plan.scribbles, torso: [...((plan.scribbles?.torso ?? []) as readonly (readonly PlanPoint[])[]), ...extra] } } : plan;
}

/**
 * Upper-body joints the silhouette guide placed (not the pose model) sit on the middle of the figure's bounding box, which a
 * held shield, a tail or a long staff drags to one side by up to 8% of the figure's height, while the legs sit under the
 * body: those joints move sideways by the gap between the box's middle and the legs' pelvis. A gap under 2% of the height is
 * ordinary lean and is left alone (a three-quarter view's chest really does sit off its legs). Joints the pose model placed
 * are left as they are. Measured on the cut bench: 87.8% -> 89.4% (93.6% -> 95.3% seam-tolerant).
 */
export function centreOnLegs(joints: Joints, legs: Joints, sources: Readonly<Record<string, string | undefined>>, boxMiddle: number, figureHeight: number): Joints {
  const dx = legs.pelvis.x - boxMiddle;
  if (Math.abs(dx) <= figureHeight * .02) return joints;
  const out: Record<string, Point> = { ...joints };
  for (const name of ["neck", "head", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist"]) if (out[name] && sources[name] !== "pose_model") out[name] = { x: out[name].x + dx, y: out[name].y };
  return out;
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
  const sources = Object.fromEntries((state.anatomicalGuide?.landmarks ?? []).map((landmark) => [landmark.landmarkId, landmark.source])) as Record<string, string | undefined>;
  const legs = legJoints(width, height, foreground, colours);
  let top = height; let bottom = -1; let left = width; let right = -1;
  for (let index = 0; index < width * height; index += 1) if (foreground[index]) { const x = index % width; const y = (index - x) / width; if (y < top) top = y; if (y > bottom) bottom = y; if (x < left) left = x; if (x > right) right = x; }
  const joints: Joints = settleArms(legs ? { ...centreOnLegs(fromGuide, legs, sources, (left + right) / 2, bottom - top + 1), ...legs } : fromGuide, state.anatomicalGuide?.adaptiveMetadata?.proportions === "adult" ? undefined : bottom - top + 1);
  const labels = applyCutPlan(addMassStrokes(bonePlan(joints), joints, width, height, foreground), { width, height, data: colours, foreground });
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
