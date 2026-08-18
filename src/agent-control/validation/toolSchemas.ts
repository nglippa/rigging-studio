import { z } from "zod";
import { ANIMATED_PROPERTIES, EASING_TYPES } from "../../rigging/schema/types";
import { PART_TYPES } from "../../character-generation/segmentation/partTaxonomy";
import { jsonValueSchema } from "../../rigging/schema/schemas";
import { PART_SEMANTIC_TYPES } from "../../part-cutter/semanticTaxonomy";
import { maskSchema } from "../../character-generation/segmentation/segmentationSchema";

const id = z.string().trim().min(1).max(160);
const projectId = z.object({ projectId: id.optional() }).strict();
const finite = z.number().finite();
const explicitConfirm = z.literal(true);

export const TOOL_NAMES = [
  "studio_get_status", "studio_get_agent_capabilities", "project_create", "project_open", "project_save", "project_export",
  "character_set_prompt", "character_generate_image", "character_import_generation", "character_get_generation", "character_accept_generation",
  "character_run_suitability_check", "character_segment", "character_get_parts", "character_update_part", "character_repair_occlusion",
  "parts_get_status", "parts_auto_cut", "parts_prompt_cut", "parts_get_proposal", "parts_render_proposal", "parts_accept_proposal", "parts_reject_proposal",
  "parts_update_semantic_type", "parts_merge", "parts_split", "parts_set_mask", "parts_set_pivot", "parts_set_z_order", "parts_mark_occluded", "parts_reconstruct", "parts_get_unassigned_regions", "parts_finalize",
  "rig_create_proposal", "rig_accept_proposal", "rig_get_summary", "rig_move_bone", "rig_rotate_bone", "rig_set_pivot", "rig_set_parent",
  "rig_set_slot_attachment", "rig_set_slot_z_index", "character_apply_skin", "character_set_equipment",
  "animation_list", "animation_create", "animation_generate", "animation_revise", "animation_get_summary", "animation_set_keyframe",
  "animation_delete_keyframe", "animation_play", "animation_pause", "animation_seek", "animation_delete",
  "preview_render", "preview_get_last", "validation_get", "project_run_smoke_test",
  "transaction_begin", "transaction_commit", "transaction_rollback", "character_create_from_prompt",
  "diagnostics_export_report", "diagnostics_export_torture_test",
  "image_provider_status", "image_provider_list_capabilities", "comfy_get_status", "image_generate_candidates", "character_generate_with_comfy",
  "image_get_proposal", "image_get_candidates", "image_render_candidate_sheet", "image_get_candidate", "image_review_proposal",
  "image_approve_candidate", "image_reject_candidate", "image_regenerate_proposal", "image_set_approval_policy", "image_cancel_proposal",
  "image_analyze_candidate_suitability",
  "image_prepare_repair_context",
] as const;

export type StudioToolName = (typeof TOOL_NAMES)[number];

const schemas = {
  studio_get_status: z.object({ includeActivity: z.boolean().default(false) }).strict(),
  studio_get_agent_capabilities: z.object({ includeToolNames: z.boolean().default(false) }).strict(),
  project_create: z.object({ name: z.string().trim().min(1).max(120), prompt: z.string().max(8000).default("") }).strict(),
  project_open: z.object({ project: z.unknown() }).strict(),
  project_save: projectId,
  project_export: z.object({ projectId: id.optional(), format: z.enum(["json", "package"]).default("json") }).strict(),
  character_set_prompt: z.object({ projectId: id.optional(), prompt: z.string().trim().min(1).max(8000) }).strict(),
  character_generate_image: z.object({ projectId: id.optional(), mode: z.enum(["generate", "regenerate", "variant"]).default("generate") }).strict(),
  character_import_generation: z.object({
    projectId: id.optional(),
    imageSource: z.discriminatedUnion("type", [
      z.object({ type: z.literal("local_path"), path: z.string().trim().min(1).max(4096) }).strict(),
      z.object({ type: z.literal("data_url"), dataUrl: z.string().min(1).max(32_000_000) }).strict(),
      z.object({ type: z.literal("provider_asset"), path: z.string().trim().min(1).max(4096), assetId: id.optional() }).strict(),
    ]),
    generationId: id, provider: id, prompt: z.string().max(8000), accepted: z.boolean().default(false),
    metadata: z.record(z.string(), jsonValueSchema).default({}),
  }).strict(),
  character_get_generation: projectId,
  character_accept_generation: z.object({ projectId: id.optional(), generationId: id, confirm: explicitConfirm }).strict(),
  character_run_suitability_check: projectId,
  character_segment: projectId,
  character_get_parts: z.object({ projectId: id.optional(), includeFull: z.boolean().default(false) }).strict(),
  character_update_part: z.object({
    projectId: id.optional(), partId: id,
    patch: z.object({ name: z.string().trim().min(1).max(120).optional(), semanticType: z.enum(PART_TYPES).optional(), accepted: z.boolean().optional(), suggestedBoneId: id.optional(), suggestedSlotId: id.optional(), suggestedZIndex: z.number().int().min(-10000).max(10000).optional() }).strict(),
  }).strict(),
  character_repair_occlusion: z.object({ projectId: id.optional(), partId: id }).strict(),
  parts_get_status: z.object({ projectId: id.optional(), includeParts: z.boolean().default(true) }).strict(),
  parts_auto_cut: z.object({ projectId: id.optional(), instruction: z.string().trim().min(1).max(8000).default("Cut this character into riggable body and equipment parts") }).strict(),
  parts_prompt_cut: z.object({ projectId: id.optional(), instruction: z.string().trim().min(1).max(8000), proposalId: id.optional() }).strict(),
  parts_get_proposal: z.object({ projectId: id.optional(), proposalId: id.optional(), includeMasks: z.boolean().default(false) }).strict(),
  parts_render_proposal: z.object({ projectId: id.optional(), proposalId: id.optional() }).strict(),
  parts_accept_proposal: z.object({ projectId: id.optional(), proposalId: id, partIds: z.array(id).max(100).optional(), confirm: explicitConfirm }).strict(),
  parts_reject_proposal: z.object({ projectId: id.optional(), proposalId: id, confirm: explicitConfirm }).strict(),
  parts_update_semantic_type: z.object({ projectId: id.optional(), partId: id, semanticType: z.enum(PART_SEMANTIC_TYPES) }).strict(),
  parts_merge: z.object({ projectId: id.optional(), partIds: z.array(id).min(2).max(30), label: z.string().trim().min(1).max(120).optional() }).strict(),
  parts_split: z.object({ projectId: id.optional(), partId: id, axis: z.enum(["horizontal", "vertical"]).default("vertical") }).strict(),
  parts_set_mask: z.object({ projectId: id.optional(), partId: id, mask: maskSchema }).strict(),
  parts_set_pivot: z.object({ projectId: id.optional(), partId: id, x: finite.min(-100000).max(100000), y: finite.min(-100000).max(100000) }).strict(),
  parts_set_z_order: z.object({ projectId: id.optional(), partId: id, zOrder: z.number().int().min(-10000).max(10000), layer: z.enum(["front", "body", "back"]).optional() }).strict(),
  parts_mark_occluded: z.object({ projectId: id.optional(), partId: id, state: z.enum(["complete", "likely-incomplete", "unknown"]) }).strict(),
  parts_reconstruct: z.object({ projectId: id.optional(), partId: id }).strict(),
  parts_get_unassigned_regions: z.object({ projectId: id.optional() }).strict(),
  parts_finalize: z.object({ projectId: id.optional(), confirm: explicitConfirm }).strict(),
  rig_create_proposal: projectId,
  rig_accept_proposal: z.object({ projectId: id.optional(), confirm: explicitConfirm }).strict(),
  rig_get_summary: z.object({ projectId: id.optional(), includeHierarchy: z.boolean().default(true), includeFull: z.boolean().default(false) }).strict(),
  rig_move_bone: z.object({ projectId: id.optional(), boneId: id, x: finite.min(-100000).max(100000), y: finite.min(-100000).max(100000), coordinateSpace: z.literal("rig").default("rig") }).strict(),
  rig_rotate_bone: z.object({ projectId: id.optional(), boneId: id, rotation: finite.min(-3600).max(3600), unit: z.literal("degrees").default("degrees") }).strict(),
  rig_set_pivot: z.object({ projectId: id.optional(), slotId: id, pivotX: finite.min(-100000).max(100000), pivotY: finite.min(-100000).max(100000) }).strict(),
  rig_set_parent: z.object({ projectId: id.optional(), boneId: id, parentId: id }).strict(),
  rig_set_slot_attachment: z.object({ projectId: id.optional(), slotId: id, attachmentId: id.nullable() }).strict(),
  rig_set_slot_z_index: z.object({ projectId: id.optional(), slotId: id, zIndex: z.number().int().min(-10000).max(10000) }).strict(),
  character_apply_skin: z.object({ projectId: id.optional(), skinId: id }).strict(),
  character_set_equipment: z.object({ projectId: id.optional(), slotId: id, attachmentId: id.nullable() }).strict(),
  animation_list: projectId,
  animation_create: z.object({ projectId: id.optional(), name: z.string().trim().min(1).max(120), duration: finite.positive().max(120).default(1), loop: z.boolean().default(true) }).strict(),
  animation_generate: z.object({ projectId: id.optional(), request: z.string().trim().min(1).max(4000), name: z.string().trim().min(1).max(120).optional(), duration: finite.positive().max(120).default(1), loop: z.boolean().default(true) }).strict(),
  animation_revise: z.object({ projectId: id.optional(), animationId: id, request: z.string().trim().min(1).max(4000) }).strict(),
  animation_get_summary: z.object({ projectId: id.optional(), animationId: id, includeTracks: z.boolean().default(true), includeFull: z.boolean().default(false) }).strict(),
  animation_set_keyframe: z.object({ projectId: id.optional(), animationId: id, boneId: id, property: z.enum(ANIMATED_PROPERTIES), time: finite.nonnegative().max(120), value: finite.min(-100000).max(100000), easing: z.enum(EASING_TYPES).default("linear") }).strict(),
  animation_delete_keyframe: z.object({ projectId: id.optional(), animationId: id, boneId: id, property: z.enum(ANIMATED_PROPERTIES), time: finite.nonnegative().max(120), confirm: explicitConfirm }).strict(),
  animation_play: z.object({ projectId: id.optional(), animationId: id.optional() }).strict(),
  animation_pause: projectId,
  animation_seek: z.object({ projectId: id.optional(), animationId: id.optional(), time: finite.nonnegative().max(120) }).strict(),
  animation_delete: z.object({ projectId: id.optional(), animationId: id, confirm: explicitConfirm }).strict(),
  preview_render: z.object({ projectId: id.optional(), animationId: id, mode: z.literal("contact_sheet").default("contact_sheet"), frameCount: z.number().int().min(2).max(24).default(8), width: z.number().int().min(320).max(2400).default(1024), overlays: z.array(z.enum(["bones", "boneNames", "jointPoints", "slotBounds", "ground", "rootTrajectory", "footTrajectories", "motionArcs"])).default(["bones", "ground", "footTrajectories"]) }).strict(),
  preview_get_last: projectId,
  validation_get: z.object({ projectId: id.optional(), includeDetails: z.boolean().default(true) }).strict(),
  project_run_smoke_test: projectId,
  transaction_begin: z.object({ label: z.string().trim().min(1).max(160).default("Agent compound edit") }).strict(),
  transaction_commit: z.object({ transactionId: id }).strict(),
  transaction_rollback: z.object({ transactionId: id }).strict(),
  character_create_from_prompt: z.object({ prompt: z.string().trim().min(1).max(8000), name: z.string().trim().min(1).max(120).default("Generated Character"), preset: z.literal("MODULAR_2D_RIG_CHARACTER").default("MODULAR_2D_RIG_CHARACTER"), autoAcceptSafeSteps: z.boolean().default(false), requireNovelArtwork: z.boolean().default(false) }).strict(),
  diagnostics_export_report: z.object({
    reportType: z.enum(["torture_test", "project_validation", "agent_run"]), name: z.string().trim().min(1).max(160),
    json: z.record(z.string(), jsonValueSchema), markdown: z.string().max(2_000_000).optional(), overwrite: z.boolean().default(false),
  }).strict(),
  diagnostics_export_torture_test: z.object({
    results: z.record(z.string(), jsonValueSchema), markdown: z.string().max(2_000_000), overwrite: z.boolean().default(false),
  }).strict(),
  image_provider_status: z.object({}).strict(),
  image_provider_list_capabilities: z.object({ refresh: z.boolean().default(false) }).strict(),
  comfy_get_status: z.object({}).strict(),
  image_generate_candidates: z.object({
    projectId: id, operation: z.enum(["character_generation", "character_variant", "occlusion_reconstruction", "part_repair", "background_removal", "alpha_edge_cleanup", "equipment_variant", "hand_repair"]),
    prompt: z.string().trim().min(1).max(8000), candidateCount: z.number().int().min(1).max(4).default(3),
    preset: z.literal("MODULAR_2D_RIG_CHARACTER").default("MODULAR_2D_RIG_CHARACTER"), negativePrompt: z.string().max(8000).optional(),
    width: z.number().int().min(256).max(2048).default(768), height: z.number().int().min(256).max(2048).default(768),
    seed: z.number().int().nonnegative().max(2_147_483_647).optional(), steps: z.number().int().min(1).max(100).default(24), guidance: finite.min(1).max(30).default(7),
    stylePreset: z.string().trim().min(1).max(120).default("stylized-game"), targetPartId: id.optional(), parentProposalId: id.optional(),
  }).strict(),
  character_generate_with_comfy: z.object({
    projectId: id, prompt: z.string().trim().min(1).max(8000), candidateCount: z.number().int().min(1).max(4).default(3),
    preset: z.literal("MODULAR_2D_RIG_CHARACTER").default("MODULAR_2D_RIG_CHARACTER"), width: z.number().int().min(256).max(2048).default(768),
    height: z.number().int().min(256).max(2048).default(768), seed: z.number().int().nonnegative().max(2_147_483_647).optional(),
  }).strict(),
  image_get_proposal: z.object({ proposalId: id }).strict(),
  image_get_candidates: z.object({ proposalId: id }).strict(),
  image_render_candidate_sheet: z.object({ proposalId: id, width: z.number().int().min(480).max(2400).default(1200) }).strict(),
  image_get_candidate: z.object({ proposalId: id, candidateId: id }).strict(),
  image_review_proposal: z.object({
    proposalId: id, recommendedCandidateId: id.optional(), candidateReviews: z.array(z.object({ candidateId: id, decision: z.enum(["recommend", "reject", "acceptable"]), reasons: z.array(z.string().trim().min(1).max(500)).min(1).max(20) }).strict()).min(1).max(4),
  }).strict(),
  image_approve_candidate: z.object({ proposalId: id, candidateId: id, confirm: explicitConfirm }).strict(),
  image_reject_candidate: z.object({ proposalId: id, candidateId: id, reason: z.string().trim().min(1).max(1000), confirm: explicitConfirm }).strict(),
  image_regenerate_proposal: z.object({ proposalId: id, amendedPrompt: z.string().trim().min(1).max(8000).optional(), confirm: explicitConfirm }).strict(),
  image_set_approval_policy: z.object({ projectId: id, policy: z.enum(["manual", "agent_recommendation"]), confirm: explicitConfirm }).strict(),
  image_cancel_proposal: z.object({ proposalId: id, confirm: explicitConfirm }).strict(),
  image_analyze_candidate_suitability: z.object({
    proposalId: id, candidateId: id, imageUrl: z.string().url().max(4096), width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192), prompt: z.string().max(8000),
  }).strict(),
  image_prepare_repair_context: z.object({ projectId: id, targetPartId: id }).strict(),
} satisfies Record<StudioToolName, z.ZodType>;

export const studioToolSchemas: Readonly<Record<StudioToolName, z.ZodType>> = schemas;

export type ParsedToolInput<T extends StudioToolName> = z.infer<(typeof schemas)[T]>;

export const parseToolInput = (name: StudioToolName, input: unknown): { readonly success: true; readonly data: unknown } | { readonly success: false; readonly errors: readonly { readonly path: string; readonly message: string }[] } => {
  const parsed = schemas[name].safeParse(input ?? {});
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, errors: parsed.error.issues.map((issue) => ({ path: issue.path.join(".") || "input", message: issue.message })) };
};
