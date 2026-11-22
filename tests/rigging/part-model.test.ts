import { describe, expect, it } from "vitest";
import { decodePartModel, heldEquipmentOnly, PART_MODEL_CLASSES, PART_MODEL_SIZE, partModelSeeds, PLAN_EQUIPMENT, PLAN_PARTS, preparePartModelInput } from "../../src/part-cutter";

const id = (part: (typeof PLAN_PARTS)[number]) => PLAN_PARTS.indexOf(part) + 1;
/** A w×h RGBA image, opaque inside the box. */
const figure = (w: number, h: number, box: [number, number, number, number]) => {
  const data = new Uint8Array(w * h * 4);
  for (let y = box[1]; y <= box[3]; y += 1) for (let x = box[0]; x <= box[2]; x += 1) { const i = (y * w + x) * 4; data[i] = 200; data[i + 1] = 100; data[i + 2] = 50; data[i + 3] = 255; }
  return { width: w, height: h, data };
};

describe("part model input and output", () => {
  it("scales the figure to 440 px in the middle of the canvas, as drawn and mirrored", () => {
    const image = figure(100, 200, [40, 20, 59, 179]);
    const prepared = preparePartModelInput(image)!; const plane = PART_MODEL_SIZE * PART_MODEL_SIZE;
    expect(prepared.frame.scale).toBeCloseTo(440 / 160);
    // Alpha plane of the first pass: opaque at the canvas centre, clear in the corner.
    expect(prepared.input[3 * plane + 256 * PART_MODEL_SIZE + 256]).toBe(1);
    expect(prepared.input[3 * plane]).toBe(0);
    // Premultiplied colour.
    expect(prepared.input[256 * PART_MODEL_SIZE + 256]).toBeCloseTo(200 / 255);
    expect(preparePartModelInput({ width: 4, height: 4, data: new Uint8Array(64) })).toBeNull();
  });

  it("reads the mirrored pass back with left and right swapped", () => {
    const image = figure(64, 64, [16, 8, 47, 55]); const { frame } = preparePartModelInput(image)!;
    const plane = PART_MODEL_SIZE * PART_MODEL_SIZE; const logits = new Float32Array(2 * PART_MODEL_CLASSES * plane);
    // The plain pass says left hand everywhere; the mirrored pass (seeing the figure flipped) says right hand.
    for (let i = 0; i < plane; i += 1) { logits[id("leftHand") * plane + i] = 10; logits[PART_MODEL_CLASSES * plane + id("rightHand") * plane + i] = 10; }
    const prediction = decodePartModel(logits, frame, image);
    expect(prediction.labels[30 * 64 + 30]).toBe(id("leftHand"));
    expect(prediction.confidence[30 * 64 + 30]).toBeGreaterThan(.99);
    expect(prediction.labels[0]).toBe(0);
  });

  it("decodes the equipment class as PLAN_EQUIPMENT", () => {
    const image = figure(32, 32, [8, 8, 23, 23]); const { frame } = preparePartModelInput(image)!;
    const plane = PART_MODEL_SIZE * PART_MODEL_SIZE; const logits = new Float32Array(2 * PART_MODEL_CLASSES * plane);
    for (let pass = 0; pass < 2; pass += 1) for (let i = 0; i < plane; i += 1) logits[pass * PART_MODEL_CLASSES * plane + 15 * plane + i] = 10;
    expect(decodePartModel(logits, frame, image).labels[16 * 32 + 16]).toBe(PLAN_EQUIPMENT);
  });
});

describe("seeds and held equipment", () => {
  it("keeps only sure pixels whose four neighbours agree", () => {
    const w = 5; const labels = new Uint8Array(25).fill(id("torso")); labels[12] = id("head");
    const confidence = new Float32Array(25).fill(.9); confidence[6] = .5;
    const seeds = partModelSeeds({ labels, confidence }, w, 5);
    expect(seeds[12]).toBe(0); // different from its neighbours
    expect(seeds[6]).toBe(0); // unsure
    expect(seeds[11]).toBe(0); // neighbour of the odd pixel
    expect(seeds[0]).toBe(0); // image border
    const flat = partModelSeeds({ labels: new Uint8Array(25).fill(id("torso")), confidence: new Float32Array(25).fill(.9) }, w, 5);
    expect(flat[12]).toBe(id("torso"));
  });

  it("gives equipment that no hand holds to the part it touches, and keeps held equipment", () => {
    // Row 0: an antenna (equipment) on the head; row 2: a sword (equipment) beside a hand.
    const w = 6; const E = PLAN_EQUIPMENT; const H = id("head"); const R = id("rightHand");
    const labels = Uint8Array.from([E, E, H, H, H, 0, 0, 0, 0, 0, 0, 0, E, E, E, R, R, 0]);
    const out = heldEquipmentOnly(labels, w, 3);
    expect([...out.slice(0, 2)]).toEqual([H, H]);
    expect([...out.slice(12, 15)]).toEqual([E, E, E]);
  });
});
