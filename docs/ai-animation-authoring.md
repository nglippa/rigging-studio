# AI-assisted animation authoring

## Provider interface

`AnimationGenerationProvider` is the only provider contract used by the editor:

```ts
interface AnimationGenerationProvider {
  readonly id: string;
  readonly name: string;
  generateAnimationProposal(input: AnimationGenerationInput): Promise<AnimationProposal>;
}
```

Provider output is still treated as untrusted at runtime. TypeScript types do not replace Zod and semantic validation.

The default is `MockAnimationGenerationProvider`, a deterministic local adapter intended for development and tests. `HttpAnimationGenerationProvider` posts the constrained prompt, context, optional previous proposal, and follow-up refinement to a configured server endpoint. The editor is not coupled to an AI vendor or model.

## Server configuration

This repository does not ship a model-backed endpoint or require an API key. When `NEXT_PUBLIC_AI_ANIMATION_ENDPOINT` is unset, Animate mode clearly identifies the local mock provider.

To connect a real provider, configure a server endpoint and set:

```text
NEXT_PUBLIC_AI_ANIMATION_ENDPOINT=/api/ai-animation
```

The endpoint accepts a JSON `AnimationGenerationInput` and returns an `AnimationProposal`. It should:

1. Authenticate and rate-limit the request if appropriate.
2. Keep the model API key exclusively in server environment variables.
3. Request structured JSON from the model.
4. Return the proposal JSON without applying it to project data.

`NEXT_PUBLIC_AI_ANIMATION_ENDPOINT` is only a public endpoint location. It must never contain credentials. Provider-specific secret names belong to the server implementation, not browser code. There are currently no required secret environment variables in this local project.

## Proposal lifecycle

1. The user selects Create, Revise, or Revise selected bones.
2. `animationContextBuilder` creates a minimal context. It excludes image paths, attachments, skins, arbitrary rig metadata, browser state, and project files.
3. `animationPromptBuilder` adds strict JSON and authoring instructions.
4. The selected provider returns an `AnimationProposal`.
5. Zod validates the proposal envelope and existing animation schema.
6. Semantic and safety validation checks bone references, timing, property values, track/key counts, and selected-bone scope.
7. The editor computes a human-readable animation diff and optional foot-contact diagnostics.
8. Preview uses a cloned runtime animation. It does not replace the source animation and viewport authoring is locked during proposal preview.
9. Reject clears proposal state without changing the animation document.
10. Accept all or Apply selected tracks runs once through `AnimationCommandHistory`, producing one undoable command.

Regenerate and Refine are explicit user actions. The system does not run autonomous generation loops.

## Safety validation

The panel exposes configurable limits for:

- Maximum rotation delta from each bone's setup rotation, with optional per-bone overrides
- Minimum and maximum scale
- Maximum root translation from setup
- Maximum keyframes per track
- Maximum total keyframes

The normal rig and animation validators additionally reject unknown bones, duplicate tracks, unsupported properties, non-finite values, unsorted keys, out-of-range key times, and schema changes. Unsafe values are rejected with paths and explanations; they are not silently clamped. Recommended rig changes are displayed as notes and are never applied as animation data.

Foot-slide diagnostics sample foot world positions during user-marked contact intervals. Drift over the configured tolerance is reported as likely sliding. This is a heuristic, not a constraint solver or proof that a foot is planted.

## Context boundary

The generated context may contain:

- Rig schema version
- Bone IDs, parents, lengths, and setup transforms
- Slot names only when the request mentions hands, grips, weapons, or shields
- Current animation for revision modes
- Explicitly selected reference animations
- Requested duration, loop, motion controls, style notes, and left/right mappings
- Ground plane, foot roles, and contact intervals

It never sends PNG data, image paths, attachment metadata, local uploads, or screenshots.

## Example requests

- Create a grounded walk cycle with clear left and right foot contacts.
- Make the current walk heavier while preserving its timing.
- Create a run based on Walk and keep the same animation style.
- Reduce head movement on the selected head bone only.
- Add stronger anticipation to the melee attack.
- Smooth the loop seam without changing the contact frames.
- Keep the left hand near the shield grip and report any rig limitations.
- Fix likely foot sliding during the marked contact intervals.
