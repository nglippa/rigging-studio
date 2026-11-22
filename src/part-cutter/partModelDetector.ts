/**
 * The part model (partModel.ts) in the browser, with onnxruntime-web, like the pose model (poseDetector.ts). The model file is
 * served by the app from public/models/partseg (built by npm run part-model:train, git-ignored); when it is missing the
 * answer is null and Cut all parts cuts from the joints alone.
 */
import type { InferenceSession } from "onnxruntime-web";
import { readImagePixels } from "../character-generation/segmentation/partImageProcessor";
import { PART_MODEL_SIZE, predictParts, type PartPrediction } from "./partModel";

const MODEL_PATH = "/models/partseg/partseg.onnx";
const runtime = () => import("onnxruntime-web/wasm");
let session: Promise<InferenceSession | null> | null = null;

function loadSession(): Promise<InferenceSession | null> {
  session ??= (async () => {
    const present = await fetch(MODEL_PATH, { method: "HEAD" }).then((response) => response.ok).catch(() => false);
    if (!present) return null;
    const [ort, binary] = await Promise.all([runtime(), import("onnxruntime-web/ort-wasm-simd-threaded.wasm?url")]);
    ort.env.wasm.wasmPaths = { wasm: binary.default };
    return ort.InferenceSession.create(MODEL_PATH, { executionProviders: ["wasm"] });
  })().catch((error: unknown) => { session = null; throw error; });
  return session;
}

const results = new Map<string, Promise<PartPrediction | null>>();

/** Each pixel's body part for the character in the image, or null when the model is not installed. Kept per image. */
export function detectParts(source: string): Promise<PartPrediction | null> {
  let result = results.get(source);
  if (!result) { result = detect(source); results.set(source, result); result.catch(() => results.delete(source)); }
  return result;
}

async function detect(source: string): Promise<PartPrediction | null> {
  const [model, pixels] = await Promise.all([loadSession(), readImagePixels(source)]);
  if (!model) return null;
  const ort = await runtime();
  return predictParts(pixels, async (input) => {
    const output = await model.run({ [model.inputNames[0]]: new ort.Tensor("float32", input, [2, 4, PART_MODEL_SIZE, PART_MODEL_SIZE]) });
    return output[model.outputNames[0]].data as Float32Array;
  });
}
