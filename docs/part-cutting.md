# Part cutting

**Cut all parts** splits a character sprite into the 14 body parts a rig needs. It runs on its own, on this machine,
with no cloud service. This guide covers:

- how the cut works;
- how accurate it is;
- the part model, and how to retrain it;
- how to make sprites that cut well;
- how to add a sprite to the accuracy bench, so every later change is measured against it.

## How the cut works

There are two paths. The app uses the part model when its file is installed (`public/models/partseg/partseg.onnx`,
built by `npm run part-model:train`), and the joints alone when it is not.

**With the part model** (the normal path):

| Step | What it does | Code |
|---|---|---|
| Part model | A segmentation network trained on the hand-labelled bench says, for every pixel, which body part it is or whether it is held equipment. It runs locally in the browser with onnxruntime-web, on the sprite and its mirror image, averaged. | `src/part-cutter/partModel.ts`, `partModelDetector.ts` |
| Held equipment only | Equipment that no hand or forearm touches (antennae, a ponytail's tip) goes to the part it borders. | `heldEquipmentOnly` in `src/part-cutter/autoCut.ts` |
| Trousers | The model has learned that cloth over the legs is torso, which is right for robes, coats and tabards. When the silhouette shows the legs apart above the knees, the hip line is known: torso below it between the legs is dropped and the thighs get a stroke along the bone. | `cutFromPrediction` |
| Grow to the drawing | The model's sure pixels (confidence ≥ .7, away from its own seams) are the seeds. Each part grows from them until it meets a dark outline or a change of colour, so the seams follow the art. | `applyCutPlan` in `src/part-cutter/cutPlan.ts` |

**Without the part model** (fallback; also what the rig's joints come from on both paths):

| Step | What it does | Code |
|---|---|---|
| Silhouette guide | Reads proportions (chibi or adult) from the figure's bounds and places every joint from the outline. | `src/part-cutter/adaptiveGuide.ts` |
| Pose model | DWPose replaces the guide's joints wherever it is confident (score ≥ .5). On big-headed art it retries with the head squashed. | `src/character-generation/pose/dwpose.ts` |
| Legs from the drawing | Tracks each leg up from the foot to the hem or waistband. The ankle is the narrowest point above the sole, the knee is halfway. | `legJoints` in `src/part-cutter/autoCut.ts` |
| Joint settling | Re-centres guide joints on the legs when a shield or staff skews the outline. Keeps shoulders and wrists off held weapons, and the neck below a beard or hood. | `centreOnLegs`, `settleArms` |
| Strokes | A short stroke inside each bone, plus strokes across the head and torso. Capes and cloaks get a torso stroke. | `bonePlan`, `addMassStrokes` |
| Grow to the drawing | As above, from the strokes. | `applyCutPlan` |

In the app this is `autoCutBodyParts`, called from `cutAllParts` in `app/part-cutter/PartCutterWorkspace.tsx`. It runs
for a fresh cut only. The bench runs the identical pipeline under Node (`scripts/cut-pipeline.mts`).

## How accurate it is

There are two measures:

- **Strict**: the share of body pixels given to the right part.
- **Seam-tolerant**: also counts a pixel within 2% of the figure's height of a true seam as right for either neighbour.

Where the art draws no line (a knee in plain trousers), the exact seam is a convention that careful people place
differently. Two independent planners following the conventions below agreed with the labels on 89–91% of pixels strict
and 95–96% seam-tolerant, so strict accuracy above about 93% is not a sensible target. Seam-tolerant accuracy is the
number to watch.

The bench has 37 hand-labelled characters (November 2026): 11 picked by hand, and 26 fresh Studio generations taken as
they came (robes, capes, cloaks, plate and samurai armour, tails, coats, a grass skirt, bare skin, beast-folk, baggy
trousers, held lutes, axes and hammers, side and three-quarter views).

The part model is measured by **4-fold cross-validation** (`npm run part-model:crossval`): each character is cut by a
model trained without it, so these are the numbers to expect on a new sprite.

| | Strict (mean) | Seam-tolerant (mean) | Worst character |
|---|---|---|---|
| With the part model | **93.3%** | **97.9%** | 84.7% / 93.1% |
| Without it (joints and strokes) | 83.0% | 90.4% | 64.9% / 73.5% |

With the model, 33 of the 37 characters are at or above 95% seam-tolerant. On the 25 characters of the previous round
alone, adding the 12 newest to the training data moved the mean from 91.5/96.8 to 92.3/97.3 and the worst from
82.0/87.9 to 84.7/93.1. The 12 newest score 95.4/99.1, but their labels were drafted by the earlier model and then
corrected, which favours it a little; the older 25 are the fairer measure. Where it is still weakest:

- **A cape over posed legs** (posed-caped-paladin 84.7/93.1): legs mostly hidden behind the cape.
- **Short builds and side views** (dwarf 87.8/93.7, goblin-side 88.5/94.5): the knee and hip seams.
- **Characters the rules alone cut well** (archer, orc, goblin-side): the model is slightly worse strict than the cut
  without it, because it moves seams a few pixels.

Every labelled character added makes the model better on the next one: label it, retrain, and rerun the
cross-validation.

Without the model, most of what goes wrong is joint placement and material: shoulder pads given to the torso, hip plates
given to the torso, knees too low, cloak beside a hand given to the hand. Even with exact joints that path reaches only
about 90–93% on caped and armoured sprites, which is why the model exists.

## The part model

A U-Net with a pretrained ResNet-34 encoder (about 24 million weights, 98 MB as ONNX). Training and export run on this
Mac's GPU with PyTorch through `uv`; nothing is sent anywhere.

| File | What it is |
|---|---|
| `scripts/part-model/export-data.mts` | Writes each labelled character's image and per-pixel labels to `.bench/train/` (`npm run part-model:data`). |
| `scripts/part-model/train.py` | Trains, predicts held-out characters and, with `--export`, writes the ONNX file. |
| `scripts/part-model/crossval.mts` | The cross-validation behind the table above (`npm run part-model:crossval`, about 25 minutes a fold). |
| `public/models/partseg/partseg.onnx` | The model the app and the bench load. Git-ignored like the pose model: build it with `npm run part-model:train` (about 30 minutes) and copy it to the Mac Studio with the rest of `public/models`. |

What the training does so the model learns shapes rather than one character's colours: each sample is scaled, moved,
turned slightly and mirrored (left and right labels swap with it), its whole colour is shifted, and each part is
recoloured on its own.

Things to know:

- **Left and right are screen sides**, as everywhere in the cutter.
- **The model is confident even when it is wrong** (on the orc it was sure of 87% of pixels and right on 82% of those).
  Its confidence is not a usable signal of a bad cut; the cross-validation is.
- **On the bench characters themselves it scores near 100%**, because they are its training data. The accuracy test
  (`npm run test:cut`) keeps a separate baseline for that path (`cut-accuracy-baseline.model.json`), which only guards
  the export, the decoding and the rules around the model against breakage.

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
2. Draft the labels from the cutter's own cut (from the part model when it is installed, which is much closer):
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
   `UPDATE_CUT_BASELINE=1 npm run test:cut` (once with the model installed, once with `CUT_PART_MODEL=0`).
6. Retrain the part model with the new character (`npm run part-model:train`) and copy `public/models/partseg` to the
   Studio. Every few characters, rerun `npm run part-model:crossval` and update the table above.

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
  also takes tails, and anything hanging from the shoulders or waist as one piece: capes, cloaks, tunic skirts, loincloths, short
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

- **Measure model changes with cross-validation** (`npm run part-model:crossval`), never on the bench characters the
  model was trained on. Keep a change when both cross-validated means go up and no character drops more than 0.3 points.
- **Measure every rule change on the whole bench.** Run `npm run cut:score`. It writes `<name>.cut.png` (the cut) and
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
| Narrower torso strokes | Worse (cat-mage −1.7). |
| Longer upper-arm stroke (from .3 of shoulder to elbow) | Means down; dwarf-ranger −1.2. |
| Extra upper-arm stroke at the shoulder, reaching out over a pad | +2–3 on paladin, rogue and lizard. −1.5 to −2.3 on dwarf, robot, archer and cat-mage, whose shoulder joint already sits on the sleeve. |
| Local edit models repainting the sprite as a flat-colour part map (FLUX.2 Klein 4B, Qwen-Image-Edit 2511), used as the cut, as seeds, as joints or as a judge | Klein follows the anatomy on arms but not legs or tails; best combination 87.9 / 94.4, no better than the engine. Qwen took 7–12 minutes a sprite and repainted chests and torsos. Agreement with the engine only loosely predicted accuracy (correlation 0.5). |
| Sapiens (Meta's body-part segmenter) without training | Out of its domain: it labelled only 1–41% of each figure and never found a torso or upper arm. |
| Generating every character in one fixed pose (Klein RefControl pose LoRA) so the joints are known | The pose is followed only roughly (arms about 5% of the figure's height off, held weapons override it); cutting with the skeleton's joints was no better than the engine. |
| Colour regions given to the nearest bone, with exact joints | 83.0 / 89.9 against 90.5 / 96.0 for strokes on the same joints. |
| The same stroke, only where the pad's colour differs from a chest sample | Best variant raised both means (88.2 / 94.7), but archer fell 1.3. It also depends on a hand-picked colour threshold. Untested: compare the pad with the colour already under the upper-arm stroke, not with a chest sample. |
| Knee at the largest colour change between .35 and .65 of hip to ankle | Means flat. |
