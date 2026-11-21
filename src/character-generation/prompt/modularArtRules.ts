export const MODULAR_ART_RULES = [
  "Render exactly one complete character in a neutral or lightly posed stance.",
  "Use a clean side view with consistent orthographic-looking chibi proportions and no dramatic foreshortening.",
  "Design the character as modular 2D game art intended for skeletal cutout animation.",
  "Maintain clear visual separation between torso, head, upper arms, forearms, hands, thighs, lower legs, feet, and equipment wherever possible.",
  "Keep both hands, both feet, and the full head visible and unobstructed.",
  "Keep weapons, shields, headwear, capes, and accessories visually separable from the base body.",
  "Use a readable silhouette, predictable joints, consistent lighting, and clean edges suitable for transparent extraction.",
  "Keep the head, torso, paired arms, paired legs, hands, and feet visually distinct despite the compact chibi proportions.",
  // What the part cutter needs to cut cleanly (measured on the cut bench, docs/part-cutting.md): a seam it can see at every
  // joint, limbs with their own outline, and neighbouring parts that do not share a colour.
  "Hold the arms a little away from the torso and stand with the legs slightly apart, so each arm and each leg shows its own outline.",
  "Draw a dark outline around the character and mark every joint with a drawn line or a change of colour: chin, shoulders, elbows, wrists, a belt or hem at the hips, knees, and ankles.",
  "Give sleeves, gloves, boots, and any cape their own colours, so a cape never matches the sleeve beside it; keep beards, long hair, and capes from covering the arms.",
] as const;
