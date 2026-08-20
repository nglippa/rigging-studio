import type { CharacterSegmentationResponse } from "./segmentationSchema";
import type { CharacterConsistencyContext } from "../context/characterConsistencyContext";
import type { PartType } from "./partTaxonomy";

export type CharacterSegmentationRequest = {
  readonly generationId: string;
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly expectedEquipment: readonly string[];
  readonly semanticPrompt?: string;
  readonly taxonomy?: readonly PartType[];
  readonly targetPartPrompt?: string;
  readonly boxHint?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly clickHints?: readonly { readonly x: number; readonly y: number; readonly positive: boolean }[];
  readonly consistencyContext?: CharacterConsistencyContext;
};

export interface CharacterSegmentationProvider {
  segmentCharacter(request: CharacterSegmentationRequest): Promise<CharacterSegmentationResponse>;
}
