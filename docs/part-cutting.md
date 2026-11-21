# Part cutting

**Cut all parts** splits a character sprite into the 14 body parts a rig needs. It runs on its own, with no AI model
apart from the local pose model, in well under a second. This guide covers:

- how the cut works;
- how accurate it is;
- how to make sprites that cut well;
- how to add a sprite to the accuracy bench, so every later change is measured against it.

## How the cut works

| Step | What it does | Code |
|---|---|---|
| Silhouette guide | Reads proportions (chibi or adult) from the figure's bounds and places every joint from the outline. | `src/part-cutter/adaptiveGuide.ts` |
| Pose model | DWPose replaces the guide's joints wherever it is confident (score ≥ .5). On big-headed art it retries with the head squashed. | `src/character-generation/pose/dwpose.ts` |
| Legs from the drawing | Tracks each leg up from the foot to the hem or waistband. The ankle is the narrowest point above the sole, the knee is halfway. | `legJoints` in `src/part-cutter/autoCut.ts` |
| Joint settling | Re-centres guide joints on the legs when a shield or staff skews the outline. Keeps shoulders and wrists off held weapons, and the neck below a beard or hood. | `centreOnLegs`, `settleArms` |
| Strokes | A short stroke inside each bone (on the bone, away from both ends), plus strokes across the head and torso. Capes and cloaks get a torso stroke. | `bonePlan`, `addMassStrokes` |
| Grow to the drawing | Each part grows out from its strokes until it meets a dark outline or a change of colour (a seeded watershed), so the seams follow the art. | `applyCutPlan` in `src/part-cutter/cutPlan.ts` |

In the app this is `autoCutBodyParts`, called from `cutAllParts` in `app/part-cutter/PartCutterWorkspace.tsx`. It runs
for a fresh cut only. The bench runs the identical pipeline under Node (`scripts/cut-pipeline.mts`).

## How accurate it is

There are two measures:

- **Strict**: the share of body pixels given to the right part.
- **Seam-tolerant**: also counts a pixel within 2% of the figure's height of a true seam as right for either neighbour.

Where the art draws no line (a knee in plain trousers), the exact seam is a convention that careful people place
differently.

On the 11-character bench (November 2026) the cut scores **91.1% strict and 96.8% seam-tolerant**. The worst character
scores 85.5% and 93.0%. Two reference points show what that means:

- With exact, hand-marked joints the same method reaches 93.0% and 97.5%.
- Two independent AI planners following the conventions below agreed with the labels on 89–91% of pixels strict and
  95–96% seam-tolerant. That is human-level agreement.

So strict accuracy above about 93% is not a sensible target. Seam-tolerant accuracy is the number to watch. Most of what
remains wrong comes from joint positions, mostly elbows and wrists.

## Making sprites that cut well

The generation prompt (`src/character-generation/prompt/modularArtRules.ts`) asks for what the cutter needs. Keep these
rules when changing it:

- **A seam at every joint.** Ask for a dark outline, and a line or a change of colour at the chin, shoulders, elbows,
  wrists, hips (belt or hem), knees and ankles. The parts grow until they meet one.
- **Limbs with their own outline.** Arms held a little off the torso and legs slightly apart. Limbs pressed into the
  body make the joints guesswork.
- **No shared colours between neighbours.** A cape the same colour as the sleeve beside it went to the arm. A beard over
  the chest pulled the neck down.
- **Equipment held clear of the body.** It is cut in a later step and must not be mistaken for a forearm.

## Adding a sprite to the bench

Add a sprite whenever a new kind of character appears, such as a new species, a costume or a view. Every later change
to the cutter is then measured on it too.

1. Put the image (a PNG with a transparent or flat background) in `tests/fixtures/rigging/cut/<name>.png`.
2. Draft the labels from the engine's own cut:
   `npm run cut:new -- tests/fixtures/rigging/cut/<name>.png <name> front`.
   The last argument is the view: `front`, `side` or `three-quarter`. Side and three-quarter views let the scorer swap
   the near and far limbs.

   This writes three files to `.bench/cut/`:
   - `<name>.draft.json`, the labels;
   - `<name>.draft.png`, the parts it gives;
   - `<name>.grid.png`, the art with numbered coordinates.
3. Correct the draft by the **conventions below**, not by what the engine did.
   - Move strokes that sit in the wrong part, and add strokes to differently coloured areas a part owns.
   - Add a hard polygon in `parts` where the art draws no seam.
   - Outline held items in `equipment`.
   - Write the character's seams in `note`.

   Check the result as you go with `npm run cut:check -- .bench/cut/<name>.draft.json .bench/cut/<name>.check.png`.
4. Move the file to `tests/fixtures/rigging/part-truth/<name>.json`.
5. Run `npm run cut:score`, then record the new character's baseline:
   `UPDATE_CUT_BASELINE=1 npm run test:cut`.

A draft scores 100% against itself, which is why it stays in `.bench/cut` until a person has corrected it. Never move
labels toward what the engine does: the labels follow the conventions, and the engine is what gets fixed.

### Label format

```json
{
  "image": "tests/fixtures/rigging/cut/<name>.png",
  "view": "front | side | three-quarter",
  "pairedLimbs": false,
  "note": "Where this character's seams fall and what is equipment.",
  "scribbles": { "<part>": [ [[x, y], [x, y]], ... ] },
  "parts": { "<part>": [[x, y], ...] },
  "equipment": [ [[x, y], ...] ]
}
```

- **Coordinates** are source pixels.
- **Part names** are `head`, `torso`, `leftUpperArm`, `leftForearm`, `leftHand`, the same three for `right…`, then
  `leftThigh`, `leftLowerLeg`, `leftFoot` and the same three for `right…`.
- **Left and right** mean the side of the image. `left` has the smaller x, whichever way the character faces.
- **Scribbles** are strokes. Each is a polyline of 2 or more points, kept about 8 px inside its part.
- **Parts** are hard polygons. Each takes every character pixel inside it. Draw them generously outward but exactly at
  the seam.
- **Equipment** polygons outline held items. Keep them off the hand that holds them.
- **Hidden parts** get no strokes at all.

### Labelling conventions

What belongs to which part:

- **head**: hair (including ponytails and braids), hats, helmets, hoods, ears, face and beard, down to the chin or jaw,
  or the lower rim of a hood or helmet.
- **torso**: the neck below the chin, plus collar, chest, belly, tunic, coat, vest, armour, apron, belt and pouches. It
  also takes anything hanging from the shoulders or waist as one piece: capes, cloaks, tunic skirts, loincloths, short
  robes, and shorts drawn as one band.
- **upper arms**: from the shoulder to the elbow, including sleeve caps, shoulder pads and cloth draped over that
  shoulder.
- **forearms**: from the elbow to the wrist, including bracers and bare skin between a sleeve and a glove.
- **hands**: from the wrist, including gloves with their cuffs and wrist wraps. The grip of a held item inside the hand is
  hand.
- **thighs**: from the hip to the knee: trousers or shorts that split into two legs, hip armour plates, and bare thigh
  below a skirt hem.
- **lower legs**: from the knee to the ankle: shins, knee pads, sock tops, boot shafts and boot cuffs.
- **feet**: below the ankle: shoes, the foot of a boot, toes.
- **equipment**: weapons, shields, staffs, wands, bows and tools held in the hand.

Where the seams go:

- **Neck**: the head's lowest own edge, which is the chin or jaw, the bottom of a beard, or the rim of a hood or helmet.
- **Shoulder**: where the arm's or sleeve's outline meets the body.
- **Elbow**: at the bend. On a straight arm with nothing to mark it, halfway from shoulder to wrist.
- **Wrist**: where the hand, glove or cuff begins.
- **Hip**: the bottom edge of the belt or waistband. Where a tunic, skirt, loincloth, apron or coat hangs over the legs,
  the hip is that garment's hem instead.
- **Knee**: at the bend, the knee pad or the trouser fold. Otherwise, halfway from the hip line to the ankle.
- **Ankle**: the top of a shoe. On a boot, it is where the boot's foot meets its shaft (the instep), not the top of the
  boot.

## Changing the cutter

- **Measure every change on the whole bench.** Run `npm run cut:score`. It writes `<name>.cut.png` (the cut) and
  `<name>.wrong.png` (wrong pixels in red) to `.bench/cut/`.
- **Keep a change only when it helps overall.** Strict and seam-tolerant means must both go up, and no character may
  drop more than 0.3 points.
- **Write rules that hold for any sprite**, such as proportions, outlines and colours. Never write rules tuned to one
  character on the bench.
- **Record the gain.** Run `UPDATE_CUT_BASELINE=1 npm run test:cut`; recording only ever raises a baseline.
  `tests/rigging/cut-accuracy.test.ts` then fails any later change that loses it.

### Tried and rejected

| Approach | Outcome |
|---|---|
| SAM2 segmentation prompted per part | Gave small material patches, not body parts. |
| Local vision models planning the strokes (qwen3-vl 8B, qwen 27B, gemma 31B, qwen 35B) | Every one scored worse than the engine (gemma 31B: 73.3% / 79.4%) or returned unusable output. |
| Assigning each pixel to the nearest bone | Worse than growing parts from strokes. |
| Voting between colour regions | Worse than growing parts from strokes. |
| Tracking the arm column down from the shoulder | Worse. |
| Elbow at the arm's midpoint | Worse. |
| Neck from a dip in the outline's width | Worse. |
| Wider torso strokes | Worse. |
