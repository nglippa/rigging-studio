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

The bench has 324 labelled characters (November 2026): 11 picked by hand, 233 fresh Studio generations, and 80 ordinary
game sprites added in round nine (villagers, knights, mages, farmers and the like, with `typ-` names). The 80 ordinary
sprites' labels are mostly the model's own drafts, so their scores are reported separately below. Besides
robes, capes, cloaks, armour, tails and side and three-quarter views, it has beast-folk (about 50 species, from lion and
shark to elephant, giraffe, squirrel, lemur, koala and chameleon), shells (tortoises, turtles, snails, hermit crabs,
armadillos, a beetle), undead (skeleton, mummy, zombie), golems of stone and crystal, a gargoyle, a clockwork automaton,
a robot with a dome head, a tree creature, wings (angel, demon, fairy, harpy, bat, bird-folk, owl, moth, bee, dragonfly,
phoenix), a peacock's fan, big ears (elephants, rabbits, a fennec, a mouse, a donkey, goblins, elves), round and tall
helmets (divers, an astronaut, a great-helm, miners, a firefighter), wide hats (witch, sombrero, top hat), a lion's mane,
big hair, very wide, very thin and hunched builds, a tiny-headed ogre, children, gowns, a puffy parka, jesters, clowns
and a mime, bare skin, arms raised overhead or covering the face (a dancer, cheerleaders, a strongman, a giant lifting a
rock, a goalkeeper), boxing gloves and gauntlets, a worn backpack, two-handed weapons and many held items (kite, round
and tower shields, a boulder, a log, a hawk, lanterns, flasks, baskets, books, instruments). All are upright: the part
set is a humanoid rig.

The part model is measured by **4-fold cross-validation** (`npm run part-model:crossval`): each character is cut by a
model trained without it, so these are the numbers to expect on a new sprite.

| | Strict (mean) | Seam-tolerant (mean) | Worst character |
|---|---|---|---|
| With the part model, the 244 hand-corrected characters | **95.1%** | **98.3%** | 74.8% / 79.0% |
| With the part model, the 80 ordinary sprites (inflated: model-drafted labels) | 97.6% | 99.7% | |
| With the part model, all 324 | 95.7% | 98.7% | 74.8% / 79.0% |
| Without it (joints and strokes), all 324 | 78.5% | 86.3% | 42.2% / 50.8% |

With the model, 305 of the 324 characters are at or above 95% seam-tolerant (225 of the 244 hand-corrected ones).

**Held-out ordinary sprites.** Twenty more ordinary sprites (`tests/fixtures/rigging/part-holdout/`) were labelled
independently, rules-only drafts replaced by hand-drawn polygons, and are never trained on. Score them with
`CUT_TRUTH_DIR=tests/fixtures/rigging/part-holdout npx tsx scripts/cut-bench.mts score`:

| Model | Strict (mean) | Seam-tolerant (mean) | Worst |
|---|---|---|---|
| Round 8 (244 characters) | 90.1% | 96.5% | 77.4% / 86.6% (typ-gladiator) |
| Round 9 (324, with the 80 ordinary sprites) | 90.1% | 96.5% | 77.3% / 86.6% (typ-gladiator) |
| Without the model | 80.0% | 88.2% | 58.5% / 67.4% |

Adding the 80 model-drafted ordinary sprites changed nothing on new ordinary sprites: every held-out character moved by
half a point or less. Training on the model's own drafts teaches it what it already does. To improve on ordinary sprites,
correct those 80 labels by hand first. The held-out set scores lower than cross-validation because its labels follow
the conventions strictly where the art draws no seam (knee pads, sleeve cuffs, white clothing the foreground estimate
drops). The fairest measure of progress is the 25
characters labelled before the model existed: as the bench grew from 25 to 37 to 49 to 99 to 149 to 196 to 244 they
went from 96.8 to 97.3 to 97.9 to 97.9 to 98.4 to 98.4 to 98.3 seam-tolerant. Each later round improves once the next
is added: the 50 from round five went from 98.0 on first sight to 98.8, round six from 97.4 to 98.4, round seven from
96.7 to 97.8. Labels from the third round on were drafted by the model and then corrected, which favours it a little.

Targeting a weak shape works, and so does undoing a side effect. Round seven added shells, tails, wings and raised
arms; with a few more examples of each, the round before's weakest recovered (snail-postman 62.7 → 95.7, monkey-acrobat
89.1 → 99.1, cyclops 94.0 → 99.7). It also taught the model that a big shape around the head is often torso or
equipment, so it gave an elephant's ears to the torso and a diver's round helmet to equipment. Round eight paired the
two on purpose: big ears, round and tall helmets, wide hats, manes and big hair (all head) beside fanned tails, domed
shells, raised wings and a backpack in the same place (all torso). Elephant-merchant went 87.7 → 99.9, diver 90.6 → 100
and squirrel-scout 78.2 → 99.5; the 48 new characters score 95.1/97.9 on first sight. Where it is still weakest:

- **One-of-a-kind silhouettes around the head**: a backpack taller than the head (backpack-traveller 75.1/81.0), shells
  wrapping the head like a hood (armadillo-ranger 80.3/86.3, armadillo-miner 81.7/87.8, hermit-crab-wanderer
  74.8/79.7, snail-wizard 75.3/81.7), a peacock's fan (82.8/87.2), and a brass helmet on a brass suit with no seam
  between them (brass-diver 75.6/79.0). In round nine hermit-crab-wanderer, snail-wizard and brass-diver dropped 6 to 12
  points. All three sit in cross-validation fold 2, the only fold whose older characters went down (−0.55 seam-tolerant;
  the other three folds rose 0.1 to 0.3). Read it as one weaker fold-2 training run until a retrain of that fold says
  otherwise.
- **Gloves held up at the face** (boxer-guard 83.0/87.4) and costume hands (clown 85.6/89.5).

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
| `scripts/part-model/crossval.mts` | The cross-validation behind the table above (`npm run part-model:crossval`, about an hour a fold at 196 characters). |
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
  the export, the decoding and the rules around the model against breakage. A retrained model fits its training data a little
  differently, so after a retrain record that baseline afresh: empty the file to `{}`, then run the test with
  `UPDATE_CUT_BASELINE=1`.

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
  also takes tails, wings, shells and anything hanging from the shoulders or waist as one piece: capes, cloaks, tunic
  skirts, loincloths, short robes, and shorts drawn as one band.
- **upper arms**: from the shoulder to the elbow, including sleeve caps, shoulder pads and cloth draped over that
  shoulder.
- **forearms**: from the elbow to the wrist, including sleeve cuffs, bracers and bare skin between a sleeve and a glove.
- **hands**: from the wrist, including gloves with their cuffs and thin wrist wraps. The grip of a held item inside the
  hand is hand. A frilled or banded sleeve cuff is not a glove: it is forearm.
- **thighs**: from the hip to the knee: trousers or shorts that split into two legs, hip armour plates, and bare thigh
  below a skirt hem.
- **lower legs**: from the knee to the ankle: shins, knee pads, sock tops, boot shafts and boot cuffs.
- **feet**: below the ankle: shoes, the foot of a boot, toes.
- **equipment**: weapons, shields, staffs, wands, bows and tools held in the hand. A bow, quiver or weapon slung on the
  back or worn at the belt is torso, as are satchels, pouches and side capes.

Where the seams go:

- **Neck**: the head's lowest own edge, which is the chin or jaw, the bottom of a beard, or the rim of a hood or helmet.
- **Shoulder**: where the arm's or sleeve's outline meets the body.
- **Elbow**: at the bend. On a straight arm with nothing to mark it, halfway from shoulder to wrist.
- **Wrist**: where bare skin of the hand or the glove begins. A sleeve cuff stays with the forearm.
- **Hip**: the bottom edge of the belt or waistband. Where a tunic, skirt, loincloth, apron or coat hangs over the legs,
  the hip is that garment's hem instead. Under a long robe or dress the covered thighs and lower legs get no labels.
- **Knee**: at the bend, the knee pad or the trouser fold. Otherwise, halfway from the hip line to the ankle. The
  halfway fallback never overrides what a part includes: when a boot shaft, boot cuff or sock top reaches above
  halfway, the knee is at its top edge, and bare skin between a hem and a boot top is thigh. Trousers tucked into boots
  with nothing marking the knee keep the halfway knee when it lies above the boot top.
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
