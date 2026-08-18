import { z } from "zod";
import { TOOL_NAMES } from "../validation/toolSchemas";
import { STUDIO_EVENT_TYPES } from "../events/StudioEventBus";

export const BRIDGE_PROTOCOL_VERSION = 1 as const;

export const bridgeRequestSchema = z.object({
  type: z.literal("request"),
  protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
  id: z.string().min(1),
  tool: z.enum(TOOL_NAMES),
  input: z.unknown(),
  actor: z.string().min(1).max(80),
}).strict();

export const bridgeHelloSchema = z.object({
  type: z.literal("hello"), protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION), sessionId: z.string().min(1), client: z.literal("rigging-studio-browser"),
}).strict();

export const bridgeResponseSchema = z.object({
  type: z.literal("response"), protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION), id: z.string().min(1), result: z.unknown(),
}).strict();

export const bridgeActivitySchema = z.object({
  type: z.literal("activity"), protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION), id: z.string().min(1), actor: z.string().min(1).max(80),
  eventType: z.enum(STUDIO_EVENT_TYPES), summary: z.string().min(1).max(500), entityId: z.string().min(1).max(160).optional(),
}).strict();

export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
export type BridgeHello = z.infer<typeof bridgeHelloSchema>;
export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;
export type BridgeActivity = z.infer<typeof bridgeActivitySchema>;
