/**
 * Cut all parts as the app runs it (app/part-cutter/PartCutterWorkspace.tsx, cutAllParts), under Node: the adaptive
 * silhouette guide, DWPose joints where the model is sure (onnxruntime-web, the same model file the app serves), then
 * guideAllBodyParts with the picture's colours. Returns each pixel's body part in the cut bench's encoding.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import { detectDwpose } from "../src/character-generation/pose/dwpose";
import { poseToLandmarks } from "../src/character-generation/pose/poseLandmarks";
import { applyPoseLandmarks, autoCutBodyParts, buildAdaptiveAnatomicalPartitionGuide, createPartCutterState, decodeOwnership, ensureOwnershipPartition } from "../src/part-cutter";
export const BODY_PARTS = ["head", "torso", "leftUpperArm", "leftForearm", "leftHand", "rightUpperArm", "rightForearm", "rightHand", "leftThigh", "leftLowerLeg", "leftFoot", "rightThigh", "rightLowerLeg", "rightFoot"] as const;
export type LoadedImage = { readonly width: number; readonly height: number; readonly data: Uint8Array; readonly foreground: number[] };

const AT = "2026-11-21T00:00:00.000Z";
const modelPath = fileURLToPath(new URL("../public/models/dwpose/dw-ll_ucoco_384.onnx", import.meta.url));
let session: Promise<ort.InferenceSession> | null = null;
const run = async (input: Float32Array) => {
  session ??= ort.InferenceSession.create(modelPath, { executionProviders: ["wasm"] });
  const model = await session;
  const output = await model.run({ [model.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, 384, 288]) });
  return { simccX: output[model.outputNames[0]].data as Float32Array, simccY: output[model.outputNames[1]].data as Float32Array };
};

export async function cutAllParts(image: LoadedImage): Promise<{ readonly predicted: Uint8Array; readonly poseJoints: number }> {
  const { width, height, data, foreground } = image;
  const base = createPartCutterState("cut-bench", width, height, "manual", AT);
  let guide = buildAdaptiveAnatomicalPartitionGuide(base, foreground, "humanoid", AT);
  let poseJoints = 0;
  if (existsSync(modelPath)) {
    const pose = await detectDwpose({ width, height, data }, run);
    const joints = pose ? poseToLandmarks(pose) : {};
    poseJoints = Object.keys(joints).length;
    if (poseJoints) guide = applyPoseLandmarks(guide, joints, foreground);
  }
  const result = autoCutBodyParts({ ...base, anatomicalGuide: guide }, foreground, data, AT);
  const state = ensureOwnershipPartition(result.state); const owners = decodeOwnership(state.ownership!);
  const semanticByOwner = state.ownership!.regionIds.map((id) => state.parts.find((part) => part.partId === id)?.semanticType);
  const predicted = new Uint8Array(width * height);
  for (let index = 0; index < owners.length; index += 1) {
    const owner = owners[index]; if (owner <= 0) continue;
    const semantic = semanticByOwner[owner - 1]; const label = semantic ? BODY_PARTS.indexOf(semantic as never) + 1 : 0;
    predicted[index] = label > 0 ? label : 0;
  }
  return { predicted, poseJoints };
}
