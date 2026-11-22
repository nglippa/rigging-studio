/**
 * A cut plan: strokes inside each body part (and, where the art draws no line between two parts, a hard polygon that
 * places the seam by convention), plus outlines of held equipment. applyCutPlan grows every part out from its strokes
 * until it meets a drawn outline or a change of colour (a seeded watershed), so the seams follow the drawing and the
 * strokes only need to be inside the right part. Plans come from whoever can tell parts apart: a person, or a vision
 * model given the gridded view from planGrid. Measured by scripts/cut-bench.mts.
 */
export type PlanPoint = readonly [number, number];
export type PlanPolygon = readonly PlanPoint[];
export type CutPlan = {
  readonly view?: string;
  readonly pairedLimbs?: boolean;
  readonly scribbles?: Readonly<Record<string, PlanPolygon | readonly PlanPolygon[]>>;
  readonly parts?: Readonly<Record<string, PlanPolygon | readonly PlanPolygon[]>>;
  readonly equipment?: readonly PlanPolygon[];
};
export type PlanImage = { readonly width: number; readonly height: number; readonly data: ArrayLike<number>; readonly foreground: ArrayLike<number> };

export const PLAN_PARTS = ["head", "torso", "leftUpperArm", "leftForearm", "leftHand", "rightUpperArm", "rightForearm", "rightHand", "leftThigh", "leftLowerLeg", "leftFoot", "rightThigh", "rightLowerLeg", "rightFoot"] as const;
export type PlanPart = (typeof PLAN_PARTS)[number];
/** Label for equipment pixels in applyCutPlan's output; body parts are their PLAN_PARTS index + 1, background 0. */
export const PLAN_EQUIPMENT = 255;
/** Hard polygons claim pixels in this order: small parts first, the torso last. */
const PRIORITY: readonly PlanPart[] = ["leftHand", "rightHand", "leftFoot", "rightFoot", "leftForearm", "rightForearm", "leftLowerLeg", "rightLowerLeg", "leftUpperArm", "rightUpperArm", "leftThigh", "rightThigh", "head", "torso"];

const polygonsOf = (value: PlanPolygon | readonly PlanPolygon[] | undefined): readonly PlanPolygon[] =>
  !value?.length ? [] : typeof (value as readonly PlanPolygon[])[0][0] === "number" ? [value as PlanPolygon] : value as readonly PlanPolygon[];
const inside = (x: number, y: number, polygon: PlanPolygon): boolean => {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i]; const [bx, by] = polygon[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / ((by - ay) || 1e-9) + ax) hit = !hit;
  }
  return hit;
};
const bounds = (polygon: PlanPolygon) => polygon.reduce((box, [x, y]) => ({ x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

/**
 * Each pixel's part (PLAN_PARTS index + 1), PLAN_EQUIPMENT for equipment, 0 for background. `seeds` (same encoding, 0 for
 * none) are pixels already known, such as the part model's sure pixels: they are fixed like strokes and grown from.
 */
export function applyCutPlan(plan: CutPlan, image: PlanImage, seeds?: ArrayLike<number>): Uint8Array {
  const { width, height, foreground, data } = image; const size = width * height; const labels = new Uint8Array(size);
  const fill = (polygons: readonly PlanPolygon[], label: number) => {
    for (const polygon of polygons) {
      if (polygon.length < 3) continue; const box = bounds(polygon);
      for (let y = Math.max(0, Math.floor(box.y0)); y <= Math.min(height - 1, Math.ceil(box.y1)); y += 1) for (let x = Math.max(0, Math.floor(box.x0)); x <= Math.min(width - 1, Math.ceil(box.x1)); x += 1) {
        const index = y * width + x; if (!foreground[index] || labels[index]) continue;
        if (inside(x + .5, y + .5, polygon)) labels[index] = label;
      }
    }
  };
  // Hard regions: equipment first, then body parts in priority order, each taking only pixels nobody has.
  fill(plan.equipment ?? [], PLAN_EQUIPMENT);
  for (const part of PRIORITY) fill(polygonsOf(plan.parts?.[part]), PLAN_PARTS.indexOf(part) + 1);
  if (seeds) for (let index = 0; index < size; index += 1) if (seeds[index] && foreground[index] && !labels[index]) labels[index] = seeds[index];
  // Strokes, 3 px wide, on character pixels not already taken.
  for (const [name, value] of Object.entries(plan.scribbles ?? {})) {
    const label = PLAN_PARTS.indexOf(name as PlanPart) + 1; if (label <= 0) continue;
    for (const stroke of polygonsOf(value)) for (let i = 0; i < stroke.length; i += 1) {
      const [ax, ay] = stroke[i]; const [bx, by] = stroke[Math.min(i + 1, stroke.length - 1)];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let t = 0; t <= steps; t += 1) {
        const cx = Math.round(ax + (bx - ax) * t / steps); const cy = Math.round(ay + (by - ay) * t / steps);
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          const x = cx + dx; const y = cy + dy; if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const index = y * width + x; if (foreground[index] && !labels[index]) labels[index] = label;
        }
      }
    }
  }
  // Seeded watershed: every other character pixel goes to the label that reaches it most cheaply, where stepping onto a
  // dark outline or across a change of colour costs much more than stepping within one colour.
  const luminance = (index: number): number => (data[index * 4] * .299 + data[index * 4 + 1] * .587 + data[index * 4 + 2] * .114) / 255;
  const step = (from: number, to: number): number => 1 + 12 * Math.max(0, (.3 - luminance(to)) / .3)
    + 12 * Math.hypot(data[from * 4] - data[to * 4], data[from * 4 + 1] - data[to * 4 + 1], data[from * 4 + 2] - data[to * 4 + 2]) / 441;
  const cost = new Float64Array(size).fill(Number.POSITIVE_INFINITY); const heap: number[] = []; const heapCost: number[] = [];
  const push = (index: number, value: number) => { heap.push(index); heapCost.push(value); let at = heap.length - 1; while (at > 0) { const parent = (at - 1) >> 1; if (heapCost[parent] <= heapCost[at]) break; [heap[parent], heap[at]] = [heap[at], heap[parent]]; [heapCost[parent], heapCost[at]] = [heapCost[at], heapCost[parent]]; at = parent; } };
  const pop = (): number => { const top = heap[0]; const lastIndex = heap.pop()!; const lastCost = heapCost.pop()!; if (heap.length) { heap[0] = lastIndex; heapCost[0] = lastCost; let at = 0; for (;;) { const left = at * 2 + 1; const right = left + 1; let smallest = at; if (left < heap.length && heapCost[left] < heapCost[smallest]) smallest = left; if (right < heap.length && heapCost[right] < heapCost[smallest]) smallest = right; if (smallest === at) break; [heap[smallest], heap[at]] = [heap[at], heap[smallest]]; [heapCost[smallest], heapCost[at]] = [heapCost[at], heapCost[smallest]]; at = smallest; } } return top; };
  const fixed = Uint8Array.from(labels, (label) => label ? 1 : 0);
  for (let index = 0; index < size; index += 1) if (labels[index] && labels[index] !== PLAN_EQUIPMENT) { cost[index] = 0; push(index, 0); }
  while (heap.length) {
    const index = pop(); const x = index % width;
    for (const next of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, index - width, index + width]) {
      if (next < 0 || next >= size || fixed[next] || !foreground[next]) continue;
      const value = cost[index] + step(index, next);
      if (value < cost[next]) { cost[next] = value; labels[next] = labels[index]; push(next, value); }
    }
  }
  return labels;
}

// A 3×5 pixel font for the grid's numbers.
const DIGITS: Record<string, readonly string[]> = {
  "0": ["111", "101", "101", "101", "111"], "1": ["010", "110", "010", "010", "111"], "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"], "4": ["101", "101", "111", "001", "001"], "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"], "7": ["111", "001", "010", "010", "010"], "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

/**
 * The gridded view a planner reads coordinates from: the figure's bounds plus a margin, the art over light grey, a line
 * every 50 source pixels (red at multiples of 100, numbered with the source coordinate on all four edges).
 * Returns RGBA pixels and the crop's origin in source pixels.
 */
export function planGrid(image: PlanImage, margin = 30): { readonly width: number; readonly height: number; readonly data: Uint8Array; readonly originX: number; readonly originY: number } {
  let x0 = image.width; let y0 = image.height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) if (image.foreground[y * image.width + x]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = image.width - 1; y1 = image.height - 1; }
  const originX = Math.max(0, Math.floor((x0 - margin) / 10) * 10); const originY = Math.max(0, Math.floor((y0 - margin) / 10) * 10);
  const width = Math.min(image.width, x1 + margin) - originX; const height = Math.min(image.height, y1 + margin) - originY;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sx = originX + x; const sy = originY + y; const s = (sy * image.width + sx) * 4; const d = (y * width + x) * 4; const a = image.data[s + 3] / 255;
    for (let c = 0; c < 3; c += 1) data[d + c] = Math.round(image.data[s + c] * a + 232 * (1 - a)); data[d + 3] = 255;
    if (sx % 100 === 0 || sy % 100 === 0) { data[d] = 230; data[d + 1] = 30; data[d + 2] = 30; }
    else if (sx % 50 === 0 || sy % 50 === 0) { data[d] = 40; data[d + 1] = 100; data[d + 2] = 230; }
  }
  const text = (value: string, left: number, top: number) => {
    const scale = 2;
    [...value].forEach((digit, n) => DIGITS[digit]?.forEach((row, ry) => [...row].forEach((bit, rx) => {
      if (bit !== "1") return;
      for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) {
        const x = left + (n * 4 + rx) * scale + dx; const y = top + ry * scale + dy; if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const d = (y * width + x) * 4; data[d] = 0; data[d + 1] = 0; data[d + 2] = 0;
      }
    })));
  };
  for (let sx = Math.ceil(originX / 100) * 100; sx < originX + width; sx += 100) { text(String(sx), sx - originX + 3, 2); text(String(sx), sx - originX + 3, height - 12); }
  for (let sy = Math.ceil(originY / 100) * 100; sy < originY + height; sy += 100) { text(String(sy), 2, sy - originY + 3); text(String(sy), width - 26, sy - originY + 3); }
  return { width, height, data, originX, originY };
}
