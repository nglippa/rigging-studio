import type { AnimationGenerationContext } from "./animationContextBuilder";
import type { AnimationProposal } from "./animationProposalSchema";

export type AnimationGenerationInput = {
  readonly prompt: string;
  readonly context: AnimationGenerationContext;
  readonly refinement?: string;
  readonly previousProposal?: AnimationProposal;
};

export interface AnimationGenerationProvider {
  readonly id: string;
  readonly name: string;
  generateAnimationProposal(input: AnimationGenerationInput): Promise<AnimationProposal>;
}
