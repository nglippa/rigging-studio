import type { CharacterSegmentationResponse } from "./segmentationSchema";

export type CharacterSegmentationRequest = {
  readonly generationId: string;
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly expectedEquipment: readonly string[];
};

export interface CharacterSegmentationProvider {
  segmentCharacter(request: CharacterSegmentationRequest): Promise<CharacterSegmentationResponse>;
}
