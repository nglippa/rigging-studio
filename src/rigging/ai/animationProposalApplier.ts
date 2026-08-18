import type { AnimationDefinition } from "../schema/types";
import { animationTrackKey } from "./animationDiff";
import type { AnimationGenerationMode } from "./animationContextBuilder";
import type { AnimationProposal } from "./animationProposalSchema";

export type AnimationCollection<TAnimation extends AnimationDefinition = AnimationDefinition> = {
  readonly animations: readonly TAnimation[];
};

export type ProposalApplicationOptions = {
  readonly mode: AnimationGenerationMode;
  readonly currentAnimationId: string;
  readonly selectedBoneIds?: readonly string[];
  readonly selectedTrackKeys?: readonly string[];
  readonly uniqueId?: (desired: string) => string;
};

export type ProposalApplicationResult<TCollection extends AnimationCollection> = {
  readonly document: TCollection;
  readonly animationId: string;
};

const mergeTracks = (base: AnimationDefinition, proposed: AnimationDefinition, allowedKeys: ReadonlySet<string>): AnimationDefinition => ({
  ...base,
  duration: proposed.duration,
  loop: proposed.loop,
  tracks: [
    ...base.tracks.filter((track) => !allowedKeys.has(animationTrackKey(track))),
    ...proposed.tracks.filter((track) => allowedKeys.has(animationTrackKey(track))),
  ],
});

export const createProposalPreview = (proposal: AnimationProposal): AnimationDefinition => structuredClone(proposal.animation);

export const applyAnimationProposal = <TCollection extends AnimationCollection>(document: TCollection, proposal: AnimationProposal, options: ProposalApplicationOptions): ProposalApplicationResult<TCollection> => {
  const current = document.animations.find((animation) => animation.id === options.currentAnimationId);
  if (options.mode === "create") {
    const id = options.uniqueId?.(proposal.animation.id) ?? proposal.animation.id;
    const selected = options.selectedTrackKeys ? new Set(options.selectedTrackKeys) : null;
    const animation = { ...structuredClone(proposal.animation), id, tracks: selected ? proposal.animation.tracks.filter((track) => selected.has(animationTrackKey(track))) : proposal.animation.tracks };
    return { document: { ...document, animations: [...document.animations, animation] }, animationId: id } as ProposalApplicationResult<TCollection>;
  }
  if (!current) throw new Error(`Current animation "${options.currentAnimationId}" does not exist`);
  const proposed = { ...structuredClone(proposal.animation), id: current.id };
  let replacement: AnimationDefinition;
  if (options.selectedTrackKeys) replacement = mergeTracks(current, proposed, new Set(options.selectedTrackKeys));
  else if (options.mode === "reviseSelectedBones") {
    const selected = new Set(options.selectedBoneIds ?? []);
    replacement = mergeTracks(current, proposed, new Set(proposed.tracks.filter((track) => selected.has(track.boneId)).map(animationTrackKey)));
  } else replacement = proposed;
  return {
    document: { ...document, animations: document.animations.map((animation) => animation.id === current.id ? replacement : animation) },
    animationId: current.id,
  } as ProposalApplicationResult<TCollection>;
};

export const rejectAnimationProposal = <T>(document: T): T => document;
