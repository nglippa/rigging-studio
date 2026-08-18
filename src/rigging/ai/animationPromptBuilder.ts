import type { AnimationGenerationContext } from "./animationContextBuilder";

export const buildAnimationGenerationPrompt = (context: AnimationGenerationContext, refinement?: string): string => `You are proposing a safe 2D skeletal transform animation.

Return JSON only. It must match this exact top-level shape:
{"proposalVersion":1,"summary":"...","animation":{"schemaVersion":1,"id":"...","name":"...","duration":1,"loop":true,"tracks":[]},"warnings":[],"assumptions":[],"affectedBones":[],"confidenceNotes":[],"recommendedRigChanges":[]}

Hard requirements:
- Never rename or invent bones.
- Never change a schema version.
- Never propose rig mutations inside animation data.
- Preserve untouched tracks when revising.
- JSON rotations are degrees and keyframe times are seconds.
- Keyframes must be strictly sorted and within duration.
- Make requested loops seamless.
- Keep planted feet stable during supplied contact phases.
- Use opposing arm and leg motion for locomotion.
- Prefer a small number of expressive keys.
- State assumptions and confidence limitations.

Context:
${JSON.stringify(context, null, 2)}
${refinement?.trim() ? `\nFollow-up refinement:\n${refinement.trim()}` : ""}`;
