import type { AnimationGenerationInput, AnimationGenerationProvider } from "./animationGenerationProvider";
import type { AnimationProposal } from "./animationProposalSchema";

export class HttpAnimationGenerationProvider implements AnimationGenerationProvider {
  readonly id = "http";
  readonly name = "Configured server provider";

  constructor(private readonly endpoint: string) {}

  async generateAnimationProposal(input: AnimationGenerationInput): Promise<AnimationProposal> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Animation provider failed with HTTP ${response.status}`);
    // The editor still validates this untrusted payload before preview or application.
    return response.json() as Promise<AnimationProposal>;
  }
}
