import { z } from "zod";
import { CONFIDENCE_SOURCES, maskSchema, pointSchema, rectSchema, type ConfidenceSource, type Point, type Rect, type SegmentationMask } from "../character-generation/segmentation/segmentationSchema";
import { PART_SEMANTIC_TYPES, type PartLayerGroup, type PartSemanticType } from "./semanticTaxonomy";

export const PART_CUT_MODES = ["auto", "assisted", "manual"] as const;
export type PartCutMode = (typeof PART_CUT_MODES)[number];
export const OCCLUSION_STATES = ["complete", "likely-incomplete", "unknown", "reconstructed"] as const;
export type PartOcclusionState = (typeof OCCLUSION_STATES)[number];

export type PartCutRecord = {
  readonly partId: string;
  readonly label: string;
  readonly semanticType: PartSemanticType;
  readonly mask: SegmentationMask;
  readonly boundingBox: Rect;
  readonly sourceBoundingBox: Rect;
  readonly sourceCanvasSize: { readonly width: number; readonly height: number };
  readonly pivot: Point;
  readonly suggestedParent: string | null;
  readonly suggestedSlot: string;
  readonly zOrder: number;
  readonly layer: PartLayerGroup;
  readonly confidence: number | null;
  readonly confidenceSource: ConfidenceSource;
  readonly articulated: boolean;
  readonly equipment: boolean;
  readonly occlusionState: PartOcclusionState;
  readonly reconstructionImage?: string;
  readonly provenance: "manual" | "ai" | "reconstructed";
  readonly accepted: boolean;
  readonly notes: readonly string[];
};

export type ProposedPartCut = Omit<PartCutRecord, "partId" | "accepted" | "provenance"> & {
  readonly proposedPartId: string;
  readonly provenance: "ai";
  readonly selected: boolean;
};

export type PartCutProposal = {
  readonly proposalId: string;
  readonly sourceImageId: string;
  readonly instruction: string;
  readonly parts: readonly ProposedPartCut[];
  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
  readonly status: "pending" | "accepted" | "rejected" | "superseded";
  readonly parentProposalId?: string;
  readonly providerMetadata?: Readonly<Record<string, string | number | boolean>>;
  readonly createdAt: string;
};

export type IgnoredRegion = { readonly id: string; readonly bounds: Rect; readonly reason: "background" | "intentional" };
export type PartCutterState = {
  readonly stateVersion: 1;
  readonly sourceImageId: string;
  readonly sourceCanvasSize: { readonly width: number; readonly height: number };
  readonly mode: PartCutMode;
  readonly parts: readonly PartCutRecord[];
  readonly proposals: readonly PartCutProposal[];
  readonly activeProposalId?: string;
  readonly ignoredRegions: readonly IgnoredRegion[];
  readonly finalized: boolean;
  readonly updatedAt: string;
};

const sizeSchema = z.object({ width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192) }).strict();
const semanticSchema = z.enum(PART_SEMANTIC_TYPES);
const partShape = {
  label: z.string().trim().min(1).max(120), semanticType: semanticSchema, mask: maskSchema, boundingBox: rectSchema,
  sourceBoundingBox: rectSchema, sourceCanvasSize: sizeSchema, pivot: pointSchema, suggestedParent: z.string().nullable(), suggestedSlot: z.string().min(1),
  zOrder: z.number().int().min(-10000).max(10000), layer: z.enum(["front", "body", "back"]), confidence: z.number().min(0).max(1).nullable(), confidenceSource: z.enum(CONFIDENCE_SOURCES).default("heuristic"),
  articulated: z.boolean(), equipment: z.boolean(), occlusionState: z.enum(OCCLUSION_STATES), reconstructionImage: z.string().min(1).optional(),
  provenance: z.enum(["manual", "ai", "reconstructed"]), notes: z.array(z.string().max(1000)),
};
export const partCutRecordSchema: z.ZodType<PartCutRecord> = z.object({ partId: z.string().min(1), ...partShape, accepted: z.boolean() }).strict();
export const proposedPartCutSchema: z.ZodType<ProposedPartCut> = z.object({ proposedPartId: z.string().min(1), ...partShape, provenance: z.literal("ai"), selected: z.boolean() }).strict();
export const partCutProposalSchema: z.ZodType<PartCutProposal> = z.object({
  proposalId: z.string().min(1), sourceImageId: z.string().min(1), instruction: z.string().min(1).max(8000), parts: z.array(proposedPartCutSchema).max(100),
  warnings: z.array(z.string()), assumptions: z.array(z.string()), status: z.enum(["pending", "accepted", "rejected", "superseded"]), parentProposalId: z.string().optional(), createdAt: z.string(),
  providerMetadata: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])).optional(),
}).strict();
export const partCutterStateSchema: z.ZodType<PartCutterState> = z.object({
  stateVersion: z.literal(1), sourceImageId: z.string().min(1), sourceCanvasSize: sizeSchema, mode: z.enum(PART_CUT_MODES), parts: z.array(partCutRecordSchema).max(100),
  proposals: z.array(partCutProposalSchema).max(100), activeProposalId: z.string().optional(), ignoredRegions: z.array(z.object({ id: z.string().min(1), bounds: rectSchema, reason: z.enum(["background", "intentional"]) }).strict()),
  finalized: z.boolean(), updatedAt: z.string(),
}).strict();

export const createPartCutterState = (sourceImageId: string, width: number, height: number, mode: PartCutMode = "manual", now = new Date().toISOString()): PartCutterState => ({
  stateVersion: 1, sourceImageId, sourceCanvasSize: { width, height }, mode, parts: [], proposals: [], ignoredRegions: [], finalized: false, updatedAt: now,
});
