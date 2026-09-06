import { doctorReviewSchema, type DoctorReview } from "./schema";
import type { DoctorPacket } from "./evidence";

export interface AnimationDoctorProvider {
  readonly id: string;
  readonly model: string;
  review(packet: DoctorPacket, signal: AbortSignal): Promise<DoctorReview>;
}

export class BridgeAnimationDoctorProvider implements AnimationDoctorProvider {
  readonly id = "astra-local-agent";
  readonly model = "gpt-6-astra";
  async review(packet: DoctorPacket, signal: AbortSignal): Promise<DoctorReview> {
    const response = await fetch("http://127.0.0.1:47831/animation-doctor/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(packet), signal });
    const body = await response.json() as { review?: unknown; error?: string; model?: string };
    if (!response.ok) throw new Error(body.error ?? "Motion review provider unavailable");
    if (body.model !== this.model) throw new Error("Motion review model mismatch; no fallback accepted");
    return doctorReviewSchema.parse(body.review);
  }
}
