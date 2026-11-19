import type { PixelImage } from "../segmentation/partImageProcessor";
import type { PartType } from "../segmentation/partTaxonomy";
import type { ProposedCharacterPart, Rect } from "../segmentation/segmentationSchema";
import { PART_RIGGING_SPECS } from "../segmentation/partTaxonomy";
import { estimateZIndex } from "./zOrderEstimator";

/**
 * Art for each cut part, extended so the character does not open up when its parts move.
 *
 * Cutting gives every source pixel to exactly one part, so two neighbouring parts meet edge to edge. The moment one
 * rotates, a wedge of nothing opens at the joint, and a part that was drawn behind another (the torso behind an arm,
 * a thigh behind a sword) has a hole where the thing in front used to be. Two repairs, both invisible at rest:
 *
 * 1. Joint caps. Where two parts are jointed (upper arm and forearm), each also receives the other's real pixels inside
 *    a disc centred on their seam. A disc centred on the pivot looks the same at any rotation, so the joint stays closed
 *    however far it bends, and at rest the copied pixels sit exactly on top of the originals.
 * 2. Hidden-area fill. Where a part lies under something drawn in front of it, the covered area is painted outward from
 *    the part's own nearest pixels. It is a guess at art that was never drawn, and it only shows once the part in front moves.
 */
export type FilledPart = {
  readonly partId: string; readonly bounds: Rect; readonly image: PixelImage; readonly capPixels: number; readonly filledPixels: number;
  /** 255 where the art was invented to continue the part under something in front of it (same size as `image`), else 0. */
  readonly filledMask: Uint8Array;
};

const JOINTS: readonly (readonly [PartType, PartType])[] = [
  ["head", "torso"],
  ["torso", "leftUpperArm"], ["leftUpperArm", "leftForearm"], ["leftForearm", "leftHand"],
  ["torso", "rightUpperArm"], ["rightUpperArm", "rightForearm"], ["rightForearm", "rightHand"],
  ["torso", "leftThigh"], ["leftThigh", "leftLowerLeg"], ["leftLowerLeg", "leftFoot"],
  ["torso", "rightThigh"], ["rightThigh", "rightLowerLeg"], ["rightLowerLeg", "rightFoot"],
];
/**
 * A limb whose middle part is hidden or was skipped still bends where its visible parts meet: [outer, inner, middle].
 * Only when the middle part is missing. When it exists, the outer parts merely touch (a forearm hanging against the side
 * of a chibi's body), and capping one with the other would leave a copy of the forearm on the torso when the arm moves.
 */
const SKIP_JOINTS: readonly (readonly [PartType, PartType, PartType])[] = [
  ["torso", "leftForearm", "leftUpperArm"], ["leftUpperArm", "leftHand", "leftForearm"], ["torso", "rightForearm", "rightUpperArm"], ["rightUpperArm", "rightHand", "rightForearm"],
  ["torso", "leftLowerLeg", "leftThigh"], ["leftThigh", "leftFoot", "leftLowerLeg"], ["torso", "rightLowerLeg", "rightThigh"], ["rightThigh", "rightFoot", "rightLowerLeg"],
  // A robe: the legs were folded into the torso (guidedManual.foldLegsIntoSkirt), so the hem meets the boots directly.
  ["torso", "leftFoot", "leftLowerLeg"], ["torso", "rightFoot", "rightLowerLeg"],
];
const pairs = (a: PartType, b: PartType, first: PartType, second: PartType): boolean => (first === a && second === b) || (first === b && second === a);
const jointedAmong = (present: ReadonlySet<PartType>) => (a: PartType, b: PartType): boolean =>
  JOINTS.some(([first, second]) => pairs(a, b, first, second))
  || SKIP_JOINTS.some(([first, second, middle]) => !present.has(middle) && pairs(a, b, first, second));

type Layer = { readonly part: ProposedCharacterPart; readonly owner: number; readonly z: number; readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

export function fillPartArt(source: PixelImage, parts: readonly ProposedCharacterPart[]): readonly FilledPart[] {
  const { width, height } = source;
  const labels = new Int16Array(width * height);
  const jointed = jointedAmong(new Set(parts.map((part) => part.semanticType)));
  const layers: Layer[] = parts.map((part, index) => {
    const left = Math.max(0, Math.floor(part.bounds.x)); const top = Math.max(0, Math.floor(part.bounds.y));
    const right = Math.min(width, left + Math.ceil(part.bounds.width)); const bottom = Math.min(height, top + Math.ceil(part.bounds.height));
    // Later parts win ties, as they do when the rig is drawn.
    return { part, owner: index + 1, z: estimateZIndex(part) + index * 1e-4, left, top, right, bottom };
  });
  for (const layer of layers) {
    const mask = layer.part.mask;
    for (let y = layer.top; y < layer.bottom; y += 1) for (let x = layer.left; x < layer.right; x += 1) {
      const covered = mask ? (mask.alpha[(y - layer.top) * mask.width + (x - layer.left)] ?? 0) > 0 : true;
      if (covered && source.data[(y * width + x) * 4 + 3] > 0) labels[y * width + x] = layer.owner;
    }
  }

  // Seams: for every pair of jointed parts that actually touch, the centre and reach of their shared edge.
  const seams = new Map<string, { sumX: number; sumY: number; count: number; points: number[] }>();
  const touch = (a: number, b: number, x: number, y: number): void => {
    if (a <= 0 || b <= 0 || a === b) return;
    const first = layers[Math.min(a, b) - 1]; const second = layers[Math.max(a, b) - 1];
    if (!jointed(first.part.semanticType, second.part.semanticType)) return;
    const key = `${first.owner}:${second.owner}`; const seam = seams.get(key) ?? { sumX: 0, sumY: 0, count: 0, points: [] };
    seam.sumX += x; seam.sumY += y; seam.count += 1; seam.points.push(x, y); seams.set(key, seam);
  };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const here = labels[y * width + x]; if (here <= 0) continue;
    if (x + 1 < width) touch(here, labels[y * width + x + 1], x + .5, y);
    if (y + 1 < height) touch(here, labels[(y + 1) * width + x], x, y + .5);
  }
  const discs = [...seams.entries()].map(([key, seam]) => {
    const [first, second] = key.split(":").map(Number); const cx = seam.sumX / seam.count; const cy = seam.sumY / seam.count;
    let reach = 0; for (let index = 0; index < seam.points.length; index += 2) reach = Math.max(reach, Math.hypot(seam.points[index] - cx, seam.points[index + 1] - cy));
    return { first, second, cx, cy, radius: reach + 1 };
  });

  // The body's outline, row by row and column by column, ignoring equipment. A pixel under a weapon or shield counts as
  // "inside the body" when body art lies on both sides of it, which is where a gap would show if the equipment moved away.
  const isEquipment = (layer: Layer): boolean => PART_RIGGING_SPECS[layer.part.semanticType].bindingKind !== "body";
  const rowMin = new Int32Array(height).fill(width); const rowMax = new Int32Array(height).fill(-1);
  const colMin = new Int32Array(width).fill(height); const colMax = new Int32Array(width).fill(-1);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const owner = labels[y * width + x]; if (owner <= 0 || isEquipment(layers[owner - 1])) continue;
    if (x < rowMin[y]) rowMin[y] = x; if (x > rowMax[y]) rowMax[y] = x; if (y < colMin[x]) colMin[x] = y; if (y > colMax[x]) colMax[x] = y;
  }
  const insideBody = (x: number, y: number): boolean => (x > rowMin[y] && x < rowMax[y]) || (y > colMin[x] && y < colMax[x]);

  return layers.map((layer) => {
    // Working canvas-sized layer for this part: -1 nothing, otherwise the source pixel index whose colour to use.
    const own = layer.owner;
    const reachLimit = Math.max(2, Math.min(96, Math.round(Math.min(layer.right - layer.left, layer.bottom - layer.top) * .45)));
    let left = layer.left; let top = layer.top; let right = layer.right; let bottom = layer.bottom;
    const grow = (x: number, y: number): void => { if (x < left) left = x; if (y < top) top = y; if (x + 1 > right) right = x + 1; if (y + 1 > bottom) bottom = y + 1; };
    const extra = new Map<number, number>();
    let capPixels = 0; let filledPixels = 0;

    // 1. Joint caps: the neighbour's own pixels inside the disc on the shared seam.
    for (const disc of discs) {
      if (disc.first !== own && disc.second !== own) continue;
      const other = disc.first === own ? disc.second : disc.first; const radius = disc.radius;
      for (let y = Math.max(0, Math.floor(disc.cy - radius)); y <= Math.min(height - 1, Math.ceil(disc.cy + radius)); y += 1) for (let x = Math.max(0, Math.floor(disc.cx - radius)); x <= Math.min(width - 1, Math.ceil(disc.cx + radius)); x += 1) {
        const index = y * width + x;
        if (labels[index] !== other || Math.hypot(x - disc.cx, y - disc.cy) > radius || extra.has(index)) continue;
        extra.set(index, index); grow(x, y); capPixels += 1;
      }
    }

    // 2. Hidden-area fill: continue this part under whatever is drawn in front of it.
    // Each covered pixel is reached from the nearest edge pixel of the part, and takes the colour found by mirroring itself
    // across that edge pixel, back into the part. Mirroring carries the part's own texture and shading outward; copying the
    // edge pixel instead would smear every edge colour into a stripe. Where the mirror falls outside the part (a thin
    // part, or a fill reaching further than the part is deep) the edge colour is used, softened by its neighbours.
    // Where this part can continue under something in front: between its own pixels, along a row or a column (art on
    // both sides). Its bounding box alone is not enough: a part whose box spans a held sword (a chibi's head beside the
    // raised blade) would otherwise paint the sword's whole shape, which shows as a dark ghost when the sword moves.
    const ownRowMin = new Map<number, number>(); const ownRowMax = new Map<number, number>(); const ownColMin = new Map<number, number>(); const ownColMax = new Map<number, number>();
    for (let y = layer.top; y < layer.bottom; y += 1) for (let x = layer.left; x < layer.right; x += 1) if (labels[y * width + x] === own) {
      if (x < (ownRowMin.get(y) ?? Infinity)) ownRowMin.set(y, x); if (x > (ownRowMax.get(y) ?? -Infinity)) ownRowMax.set(y, x);
      if (y < (ownColMin.get(x) ?? Infinity)) ownColMin.set(x, y); if (y > (ownColMax.get(x) ?? -Infinity)) ownColMax.set(x, y);
    }
    const betweenOwnArt = (x: number, y: number) => (x > (ownRowMin.get(y) ?? Infinity) && x < (ownRowMax.get(y) ?? -Infinity)) || (y > (ownColMin.get(x) ?? Infinity) && y < (ownColMax.get(x) ?? -Infinity));
    const painted = new Map<number, readonly [number, number, number]>();
    const originOf = new Map<number, number>();
    let frontier: number[] = [];
    for (let y = layer.top; y < layer.bottom; y += 1) for (let x = layer.left; x < layer.right; x += 1) if (labels[y * width + x] === own) { frontier.push(y * width + x); originOf.set(y * width + x, y * width + x); }
    const rgb = (index: number): readonly [number, number, number] => [source.data[index * 4], source.data[index * 4 + 1], source.data[index * 4 + 2]];
    for (let step = 0; step < reachLimit && frontier.length; step += 1) {
      const next: number[] = [];
      for (const index of frontier) {
        const x = index % width; const y = (index - x) / width; const origin = originOf.get(index)!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx; const ny = y + dy; if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbour = ny * width + nx; const owner = labels[neighbour];
          if (owner <= 0 || owner === own || originOf.has(neighbour)) continue;
          const front = layers[owner - 1];
          // Only under parts drawn in front, and never over a jointed neighbour, whose real art the caps already continue.
          if (front.z <= layer.z || jointed(front.part.semanticType, layer.part.semanticType)) continue;
          // Under another body part the fill completes this part inside its own extent. Under equipment it may also reach
          // across to the next body part, because a weapon often hides the whole strip between two parts.
          const withinOwnExtent = nx >= layer.left && ny >= layer.top && nx < layer.right && ny < layer.bottom && betweenOwnArt(nx, ny);
          // Only the large parts that sit behind a weapon (torso, head) continue across under it; a limb behind a sword only
          // completes itself within its own extent, or it paints the weapon's whole shape and leaves it as a ghost.
          const spansBody = layer.part.semanticType === "torso" || layer.part.semanticType === "head";
          if (!(withinOwnExtent || (spansBody && isEquipment(front) && !isEquipment(layer) && insideBody(nx, ny)))) continue;
          originOf.set(neighbour, origin); next.push(neighbour);
          const ox = origin % width; const oy = (origin - ox) / width;
          const mx = 2 * ox - nx; const my = 2 * oy - ny;
          const mirror = mx >= 0 && my >= 0 && mx < width && my < height && labels[my * width + mx] === own ? my * width + mx : -1;
          painted.set(neighbour, rgb(mirror >= 0 ? mirror : origin));
          grow(nx, ny); filledPixels += 1;
        }
      }
      frontier = next;
    }
    // One light blur pass over the filled area only, so neighbouring mirrors meet without a visible seam.
    const softened = new Map<number, readonly [number, number, number]>();
    for (const [index] of painted) {
      const x = index % width; const y = (index - x) / width; let r = 0; let g = 0; let bl = 0; let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx; const ny = y + dy; if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbour = ny * width + nx; const colour = painted.get(neighbour) ?? (labels[neighbour] === own ? rgb(neighbour) : null); if (!colour) continue;
        r += colour[0]; g += colour[1]; bl += colour[2]; count += 1;
      }
      softened.set(index, [r / count, g / count, bl / count]);
    }
    // Then each filled pixel takes the nearest colour the part itself uses: averaging invents colours, and pixel art has
    // none it was not drawn with (a hand artist extends a shape with its own palette).
    const ownColours: (readonly [number, number, number])[] = []; const seenColours = new Set<number>();
    for (let y = layer.top; y < layer.bottom; y += 1) for (let x = layer.left; x < layer.right; x += 1) {
      const index = y * width + x; if (labels[index] !== own) continue;
      const key = (source.data[index * 4] << 16) | (source.data[index * 4 + 1] << 8) | source.data[index * 4 + 2];
      if (!seenColours.has(key) && seenColours.size < 256) { seenColours.add(key); ownColours.push(rgb(index)); }
    }
    const nearestOwn = (colour: readonly [number, number, number]) => {
      let best = colour; let bestDistance = Infinity;
      for (const candidate of ownColours) { const d = Math.abs(candidate[0] - colour[0]) + Math.abs(candidate[1] - colour[1]) + Math.abs(candidate[2] - colour[2]); if (d < bestDistance) { bestDistance = d; best = candidate; } }
      return best;
    };
    for (const [index, colour] of softened) painted.set(index, ownColours.length ? nearestOwn(colour) : colour);

    const outWidth = right - left; const outHeight = bottom - top; const data = new Uint8ClampedArray(outWidth * outHeight * 4);
    const put = (index: number, from: number, opaque: boolean): void => {
      const x = index % width; const y = (index - x) / width; const target = ((y - top) * outWidth + (x - left)) * 4; const origin = from * 4;
      data[target] = source.data[origin]; data[target + 1] = source.data[origin + 1]; data[target + 2] = source.data[origin + 2];
      data[target + 3] = opaque ? 255 : source.data[origin + 3];
    };
    for (let y = layer.top; y < layer.bottom; y += 1) for (let x = layer.left; x < layer.right; x += 1) if (labels[y * width + x] === own) put(y * width + x, y * width + x, false);
    const filledMask = new Uint8Array(outWidth * outHeight);
    for (const [index, colour] of painted) {
      if (extra.has(index)) continue;
      const x = index % width; const y = (index - x) / width; const target = ((y - top) * outWidth + (x - left)) * 4;
      filledMask[(y - top) * outWidth + (x - left)] = 255;
      data[target] = colour[0]; data[target + 1] = colour[1]; data[target + 2] = colour[2]; data[target + 3] = 255;
    }
    for (const [index, from] of extra) put(index, from, false);
    return { partId: layer.part.id, bounds: { x: left, y: top, width: outWidth, height: outHeight }, image: { width: outWidth, height: outHeight, data }, capPixels, filledPixels, filledMask };
  });
}
