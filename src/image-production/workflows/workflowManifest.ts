import { z } from "zod";
import { IMAGE_PRODUCTION_CAPABILITIES, imageProductionJsonSchema, type ImageProductionCapability, type ImageProductionJson } from "../proposals/imageProposal";

export type TrustedWorkflowInputBinding = {
  readonly nodeId: string;
  readonly field: string;
  readonly required: boolean;
  readonly defaultValue?: ImageProductionJson;
};

export type TrustedWorkflowManifest = {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly capability: ImageProductionCapability;
  readonly workflowFile: string;
  readonly description: string;
  readonly inputs: Readonly<Record<string, TrustedWorkflowInputBinding>>;
  readonly outputs: { readonly images: { readonly nodeId: string } };
  readonly requiredNodeClasses: readonly string[];
  readonly requiredModels: readonly string[];
};

const inputBindingSchema: z.ZodType<TrustedWorkflowInputBinding> = z.object({
  nodeId: z.string().min(1), field: z.string().min(1), required: z.boolean().default(false), defaultValue: imageProductionJsonSchema.optional(),
}).strict();

export const trustedWorkflowManifestSchema: z.ZodType<TrustedWorkflowManifest> = z.object({
  manifestVersion: z.literal(1), id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), capability: z.enum(IMAGE_PRODUCTION_CAPABILITIES),
  workflowFile: z.string().regex(/^[a-zA-Z0-9._-]+\.json$/), description: z.string().min(1),
  inputs: z.record(z.string(), inputBindingSchema), outputs: z.object({ images: z.object({ nodeId: z.string().min(1) }).strict() }).strict(),
  requiredNodeClasses: z.array(z.string().min(1)), requiredModels: z.array(z.string().min(1)),
}).strict();

export type ComfyWorkflowNode = { readonly class_type: string; readonly inputs: Readonly<Record<string, ImageProductionJson>>; readonly _meta?: Readonly<Record<string, ImageProductionJson>> };
export type ComfyApiWorkflow = Readonly<Record<string, ComfyWorkflowNode>>;

const workflowNodeSchema: z.ZodType<ComfyWorkflowNode> = z.object({
  class_type: z.string().min(1), inputs: z.record(z.string(), imageProductionJsonSchema), _meta: z.record(z.string(), imageProductionJsonSchema).optional(),
}).strict();
export const comfyApiWorkflowSchema: z.ZodType<ComfyApiWorkflow> = z.record(z.string(), workflowNodeSchema);

export type LoadedTrustedWorkflow = {
  readonly manifest: TrustedWorkflowManifest;
  readonly workflow: ComfyApiWorkflow;
  readonly manifestPath: string;
  readonly workflowPath: string;
};

export function validateWorkflowCompatibility(manifest: TrustedWorkflowManifest, workflow: ComfyApiWorkflow): readonly string[] {
  const errors: string[] = [];
  for (const [name, binding] of Object.entries(manifest.inputs)) {
    const node = workflow[binding.nodeId];
    if (!node) errors.push(`Input ${name} references missing node ${binding.nodeId}`);
    else if (!(binding.field in node.inputs) && binding.defaultValue === undefined) errors.push(`Input ${name} references missing field ${binding.nodeId}.inputs.${binding.field}`);
  }
  if (!workflow[manifest.outputs.images.nodeId]) errors.push(`Image output references missing node ${manifest.outputs.images.nodeId}`);
  const classes = new Set(Object.values(workflow).map((node) => node.class_type));
  for (const required of manifest.requiredNodeClasses) if (!classes.has(required)) errors.push(`Required node class ${required} is absent`);
  return errors;
}

export function bindTrustedWorkflow(loaded: LoadedTrustedWorkflow, values: Readonly<Record<string, ImageProductionJson>>): ComfyApiWorkflow {
  const workflow = structuredClone(loaded.workflow) as Record<string, { class_type: string; inputs: Record<string, ImageProductionJson>; _meta?: Record<string, ImageProductionJson> }>;
  for (const [name, binding] of Object.entries(loaded.manifest.inputs)) {
    const value = values[name] ?? binding.defaultValue;
    if (value === undefined) {
      if (binding.required) throw new Error(`Trusted workflow ${loaded.manifest.id} requires input ${name}`);
      continue;
    }
    const node = workflow[binding.nodeId];
    if (!node) throw new Error(`Trusted workflow ${loaded.manifest.id} is incompatible: node ${binding.nodeId} is missing`);
    node.inputs[binding.field] = value;
  }
  return workflow;
}
