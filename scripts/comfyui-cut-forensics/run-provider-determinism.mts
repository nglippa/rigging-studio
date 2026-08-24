import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ComfyUIAdapter } from "../../src/image-production/comfy/ComfyUIAdapter";
import { TrustedWorkflowRegistry } from "../../src/image-production/workflows/registry";
import { bindTrustedWorkflow } from "../../src/image-production/workflows/workflowManifest";

const root = process.cwd();
const output = path.join(root, ".rigging-studio/diagnostics/comfyui-cut-forensics", process.env.CUT_FORENSICS_RUN_ID ?? "provider-determinism", "provider-determinism-baseline");
const sourcePath = path.join(root, ".rigging-studio/final-confirmatory-gate/v2/frozen-sources/09-moonplume-chronicler.png");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

await mkdir(output, { recursive: true });
const source = await readFile(sourcePath); const adapter = new ComfyUIAdapter(); const registry = new TrustedWorkflowRegistry();
const workflow = await registry.require("CHARACTER_SEGMENTATION"); const dependencies = await adapter.inspectDependencies(workflow);
if (!dependencies.available) throw new Error(`ComfyUI dependencies unavailable: ${JSON.stringify(dependencies)}`);
const sourceName = await adapter.uploadImage("rigging-cut-forensics-moonplume-determinism.png", source, "image/png", true);
const values = {
  sourceImage: sourceName, semanticPrompt: "human head", detectionThreshold: 0.3,
  cropWidth: 1024, cropHeight: 1536, cropX: 0, cropY: 0,
  sam2Model: process.env.COMFYUI_SAM2_MODEL ?? "sam2_hiera_large.safetensors",
  groundingDinoModel: process.env.COMFYUI_GROUNDING_DINO_MODEL ?? "GroundingDINO_SwinT_OGC (694MB)",
};
const runs: { readonly run: number; readonly promptId: string; readonly providerFilename: string; readonly bytes: number; readonly sha256: string; readonly historyFile: string; readonly rawFile: string }[] = [];
for (let index = 0; index < 5; index += 1) {
  const submitted = await adapter.submit(bindTrustedWorkflow(workflow, values)); const completed = await adapter.waitForCompletion(submitted.promptId, workflow.manifest.outputs.images.nodeId);
  const first = completed.outputs[0]; if (!first) throw new Error(`Run ${index + 1} returned no output`);
  const rawFile = `run-${index + 1}.png`; const historyFile = `run-${index + 1}-history.json`;
  await writeFile(path.join(output, rawFile), first.bytes);
  const historyResponse = await fetch(`${adapter.baseUrl}/history/${encodeURIComponent(submitted.promptId)}`); const history = await historyResponse.json(); await writeFile(path.join(output, historyFile), json(history));
  runs.push({ run: index + 1, promptId: submitted.promptId, providerFilename: first.providerAsset.filename, bytes: first.bytes.byteLength, sha256: sha(first.bytes), historyFile, rawFile });
}
const summary = {
  request: { sourcePath, sourceSha256: sha(source), sourceName, workflowId: workflow.manifest.id, outputNodeId: workflow.manifest.outputs.images.nodeId, values },
  runs, uniquePromptIds: new Set(runs.map((run) => run.promptId)).size, uniqueProviderFilenames: new Set(runs.map((run) => run.providerFilename)).size,
  uniqueRawDigests: new Set(runs.map((run) => run.sha256)).size, deterministic: new Set(runs.map((run) => run.sha256)).size === 1,
};
await writeFile(path.join(output, "summary.json"), json(summary));
process.stdout.write(json(summary));
