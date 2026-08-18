import { z } from "zod";
import { jsonValueSchema } from "../../rigging/schema/schemas";

export const managedGenerationIngressSchema = z.object({
  projectId: z.string().trim().min(1).max(160).optional(),
  generationId: z.string().trim().min(1).max(160),
  provider: z.string().trim().min(1).max(160),
  prompt: z.string().max(8000),
  accepted: z.boolean(),
  generationMode: z.enum(["imported_external", "provider_generated"]).default("imported_external"),
  operation: z.enum(["CHARACTER_GENERATION", "CHARACTER_VARIANT", "OCCLUSION_RECONSTRUCTION", "PART_REPAIR", "BACKGROUND_REMOVAL", "ALPHA_EDGE_CLEANUP", "EQUIPMENT_VARIANT", "HAND_REPAIR"]).default("CHARACTER_GENERATION"),
  targetPartId: z.string().trim().min(1).max(160).optional(),
  metadata: z.record(z.string(), jsonValueSchema),
  managedImage: z.object({
    image: z.string().url(),
    sourceArtifact: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    mimeType: z.enum(["image/png", "image/jpeg"]),
  }).strict(),
  ingressToken: z.string().min(32),
}).strict();

export type ManagedGenerationIngress = z.infer<typeof managedGenerationIngressSchema>;
