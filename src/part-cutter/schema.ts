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
export const OWNERSHIP_BACKGROUND = -1 as const;
export const OWNERSHIP_UNRESOLVED = 0 as const;
export type OwnershipAuditEvent = {
  readonly eventId: string;
  readonly action: "migrate" | "assign" | "reshape" | "relabel" | "split" | "merge" | "unresolved" | "refine" | "accept";
  readonly regionIds: readonly string[];
  readonly changedPixels: number;
  readonly actor: "human" | "agent" | "migration" | "ai";
  readonly timestamp: string;
  readonly detail?: string;
};
export type OwnershipPartition = {
  readonly ownershipVersion: 1;
  readonly width: number;
  readonly height: number;
  /** Region id at index n is encoded as owner n + 1. Background is -1; unresolved is 0. */
  readonly regionIds: readonly string[];
  /** Run-length encoded pairs: owner, length. */
  readonly runs: readonly number[];
  readonly adjacency: Readonly<Record<string, readonly string[]>>;
  readonly reviewStatus: "review" | "accepted";
  readonly audit: readonly OwnershipAuditEvent[];
  /** Extraction-only transparent canvas padding. It never changes semantic ownership. */
  readonly riggingPadding: Readonly<Record<string, number>>;
};
export const ANATOMICAL_LANDMARK_IDS = [
  "root", "pelvis", "chest", "neck", "head",
  "leftShoulder", "leftElbow", "leftWrist",
  "rightShoulder", "rightElbow", "rightWrist",
  "leftHip", "leftKnee", "leftAnkle",
  "rightHip", "rightKnee", "rightAnkle",
  "leftHock", "rightHock",
] as const;
export type AnatomicalLandmarkId = (typeof ANATOMICAL_LANDMARK_IDS)[number];
export const LANDMARK_EVIDENCE_SOURCES = ["silhouette", "centerline", "equipment_anchor", "symmetry", "inferred_hidden", "fallback_prior", "manual"] as const;
export type LandmarkEvidenceSource = (typeof LANDMARK_EVIDENCE_SOURCES)[number];
export const LANDMARK_VISIBILITY_STATES = ["visible", "inferred", "needs-review", "manual"] as const;
export type LandmarkVisibilityState = (typeof LANDMARK_VISIBILITY_STATES)[number];
export type AnatomicalLandmark = {
  readonly landmarkId: AnatomicalLandmarkId;
  readonly point: Point;
  readonly parentLandmarkId: AnatomicalLandmarkId | null;
  readonly confidence?: number;
  readonly source?: LandmarkEvidenceSource;
  readonly visibility?: LandmarkVisibilityState;
  readonly method?: string;
};
export type AdaptiveZoneGeometry = {
  readonly kind: "silhouette-region" | "centerline-corridor" | "terminal-mass";
  readonly centerline: readonly Point[];
  readonly polygon: readonly Point[];
};
export type AnatomicalZone = {
  readonly zoneId: string;
  readonly semanticType: PartSemanticType;
  readonly label: string;
  readonly parentZoneId: string | null;
  readonly anchorLandmarkIds: readonly AnatomicalLandmarkId[];
  readonly bounds: Rect;
  readonly mask?: SegmentationMask;
  readonly geometry?: AdaptiveZoneGeometry;
  readonly optional: boolean;
  readonly refinementMargin: number;
};
export type ChibiProportionDescriptor = {
  readonly foregroundBounds: Rect;
  readonly headBounds: Rect;
  readonly centerOfMass: Point;
  readonly bodyCenterX: number;
  readonly headHeightRatio: number;
  readonly headWidthRatio: number;
  readonly torsoHeightRatio: number;
  readonly legLengthRatio: number;
  readonly armLengthRatio: number;
  readonly overallCompactness: number;
  readonly archetype: "standard_chibi" | "broad_chibi" | "tall_chibi" | "tiny_limbs" | "large_head_extreme" | "digitigrade" | "custom";
};
export type AdaptiveGuideMetadata = {
  readonly initializationMethod: "alpha-silhouette-adaptive-v1";
  readonly topology: "humanoid" | "digitigrade" | "custom";
  readonly topologyNeedsReview: boolean;
  readonly proportionDescriptor: ChibiProportionDescriptor;
  readonly foregroundPixelCount: number;
  readonly inferredLandmarkIds: readonly AnatomicalLandmarkId[];
  readonly needsReviewLandmarkIds: readonly AnatomicalLandmarkId[];
  readonly runtimeMs: number;
};
export type AnatomicalPartitionGuide = {
  readonly guideVersion: 1;
  readonly profile: "humanoid" | "digitigrade" | "custom";
  readonly sourceCanvasSize: { readonly width: number; readonly height: number };
  readonly landmarks: readonly AnatomicalLandmark[];
  readonly zones: readonly AnatomicalZone[];
  readonly adaptiveMetadata?: AdaptiveGuideMetadata;
  readonly status: "seeded" | "ai-refined" | "reviewed";
  readonly createdAt: string;
  readonly updatedAt: string;
};
export const GUIDED_MANUAL_PHASES = ["body", "equipment", "review"] as const;
export type GuidedManualPhase = (typeof GUIDED_MANUAL_PHASES)[number];
export const GUIDED_MANUAL_INTENTS = ["replace", "add", "remove"] as const;
export type GuidedManualIntent = (typeof GUIDED_MANUAL_INTENTS)[number];
export type GuidedManualProgress = {
  readonly guidedManualVersion: 1;
  readonly phase: GuidedManualPhase;
  readonly currentSemantic: PartSemanticType;
  readonly completedSemantics: readonly PartSemanticType[];
  readonly skippedSemantics: readonly PartSemanticType[];
  readonly intent: GuidedManualIntent;
  readonly updatedAt: string;
};
export type PartCutterState = {
  readonly stateVersion: 1;
  readonly sourceImageId: string;
  readonly sourceCanvasSize: { readonly width: number; readonly height: number };
  readonly mode: PartCutMode;
  readonly parts: readonly PartCutRecord[];
  readonly proposals: readonly PartCutProposal[];
  readonly activeProposalId?: string;
  readonly ignoredRegions: readonly IgnoredRegion[];
  readonly ownership?: OwnershipPartition;
  readonly anatomicalGuide?: AnatomicalPartitionGuide;
  readonly guidedManual?: GuidedManualProgress;
  readonly finalized: boolean;
  readonly updatedAt: string;
};

const sizeSchema = z.object({ width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192) }).strict();
const semanticSchema = z.enum(PART_SEMANTIC_TYPES);
const landmarkIdSchema = z.enum(ANATOMICAL_LANDMARK_IDS);
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
  ownership: z.object({
    ownershipVersion: z.literal(1), width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
    regionIds: z.array(z.string().min(1)).max(100), runs: z.array(z.number().int()).max(134_217_728), adjacency: z.record(z.string(), z.array(z.string())),
    reviewStatus: z.enum(["review", "accepted"]),
    audit: z.array(z.object({ eventId: z.string().min(1), action: z.enum(["migrate", "assign", "reshape", "relabel", "split", "merge", "unresolved", "refine", "accept"]), regionIds: z.array(z.string()), changedPixels: z.number().int().nonnegative(), actor: z.enum(["human", "agent", "migration", "ai"]), timestamp: z.string(), detail: z.string().optional() }).strict()).max(500),
    riggingPadding: z.record(z.string(), z.number().int().min(0).max(64)),
  }).strict().optional(),
  anatomicalGuide: z.object({
    guideVersion: z.literal(1), profile: z.enum(["humanoid", "digitigrade", "custom"]), sourceCanvasSize: sizeSchema,
    landmarks: z.array(z.object({ landmarkId: landmarkIdSchema, point: pointSchema, parentLandmarkId: landmarkIdSchema.nullable(), confidence: z.number().min(0).max(1).optional(), source: z.enum(LANDMARK_EVIDENCE_SOURCES).optional(), visibility: z.enum(LANDMARK_VISIBILITY_STATES).optional(), method: z.string().max(200).optional() }).strict()).max(32),
    zones: z.array(z.object({ zoneId: z.string().min(1), semanticType: semanticSchema, label: z.string().min(1), parentZoneId: z.string().nullable(), anchorLandmarkIds: z.array(landmarkIdSchema).min(1).max(4), bounds: rectSchema, mask: maskSchema.optional(), geometry: z.object({ kind: z.enum(["silhouette-region", "centerline-corridor", "terminal-mass"]), centerline: z.array(pointSchema).min(1).max(64), polygon: z.array(pointSchema).min(3).max(128) }).strict().optional(), optional: z.boolean(), refinementMargin: z.number().int().min(0).max(256) }).strict()).max(100),
    adaptiveMetadata: z.object({ initializationMethod: z.literal("alpha-silhouette-adaptive-v1"), topology: z.enum(["humanoid", "digitigrade", "custom"]), topologyNeedsReview: z.boolean(), proportionDescriptor: z.object({ foregroundBounds: rectSchema, headBounds: rectSchema, centerOfMass: pointSchema, bodyCenterX: z.number().finite(), headHeightRatio: z.number().finite().min(0).max(1), headWidthRatio: z.number().finite().min(0).max(1), torsoHeightRatio: z.number().finite().min(0).max(1), legLengthRatio: z.number().finite().min(0).max(1), armLengthRatio: z.number().finite().min(0).max(2), overallCompactness: z.number().finite().min(0).max(2), archetype: z.enum(["standard_chibi", "broad_chibi", "tall_chibi", "tiny_limbs", "large_head_extreme", "digitigrade", "custom"]) }).strict(), foregroundPixelCount: z.number().int().nonnegative(), inferredLandmarkIds: z.array(landmarkIdSchema), needsReviewLandmarkIds: z.array(landmarkIdSchema), runtimeMs: z.number().finite().nonnegative() }).strict().optional(),
    status: z.enum(["seeded", "ai-refined", "reviewed"]), createdAt: z.string(), updatedAt: z.string(),
  }).strict().optional(),
  guidedManual: z.object({
    guidedManualVersion: z.literal(1), phase: z.enum(GUIDED_MANUAL_PHASES), currentSemantic: semanticSchema,
    completedSemantics: z.array(semanticSchema).max(100), skippedSemantics: z.array(semanticSchema).max(100),
    intent: z.enum(GUIDED_MANUAL_INTENTS), updatedAt: z.string(),
  }).strict().optional(),
  finalized: z.boolean(), updatedAt: z.string(),
}).strict();

export const createPartCutterState = (sourceImageId: string, width: number, height: number, mode: PartCutMode = "manual", now = new Date().toISOString()): PartCutterState => ({
  stateVersion: 1, sourceImageId, sourceCanvasSize: { width, height }, mode, parts: [], proposals: [], ignoredRegions: [], finalized: false, updatedAt: now,
});
