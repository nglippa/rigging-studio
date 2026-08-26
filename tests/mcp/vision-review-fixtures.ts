import { PNG } from "pngjs";
import type { VisionReviewArtifactInput } from "../../mcp/vision-review";
import type { VisionReviewResult } from "../../src/vision-review";

export const tinyPng = (): Buffer => { const png = new PNG({ width: 2, height: 2 }); png.data.fill(0); for (let index = 0; index < 4; index += 1) { png.data[index * 4] = 40 + index * 20; png.data[index * 4 + 1] = 80; png.data[index * 4 + 2] = 160; png.data[index * 4 + 3] = 255; } return PNG.sync.write(png); };
export const artifact = (name = "source.png", role: VisionReviewArtifactInput["role"] = "source", candidateId?: string): VisionReviewArtifactInput => ({ name, role, mimeType: "image/png", bytes: tinyPng(), ...(candidateId ? { candidateId } : {}) });
export const acceptedReview = (patch: Partial<VisionReviewResult> = {}): VisionReviewResult => ({ decision: "ACCEPT", confidence: .9, semanticCorrectness: .95, foreignPixelRisk: .05, missingAnatomyRisk: .05, jointRisk: .04, occlusionRisk: .08, issues: [], recommendedAction: "Accept the reviewed candidate", notes: "Source-backed evidence is coherent", ranking: null, ...patch });
