# Rigging Studio workflow v2

This maps the current editor workflow to the proposed one. Findings referenced as N1, P2, R5, A3 and so on are in [ux-workflow-audit.md](./ux-workflow-audit.md).

## The model

Four stages, named after what the user makes in each:

| Stage | Means | Internal name (unchanged) | Route |
|---|---|---|---|
| **Parts** | Define the pieces of my character that can move. | `prepare` | `/part-cutter` |
| **Rig** | Connect those pieces with bones and pivots. | `setup` | `/?mode=setup` |
| **Test** | Pose the character and confirm the rig behaves. | `test` (new) | `/?mode=test` |
| **Animate** | Create and edit motion. | `animate` | `/?mode=animate` |

Two kinds of object, everywhere: a **part** (a piece of art) and a **bone** (what moves it). A part *is controlled by* a bone. `slot`, `attachment` and `skin` remain in the data model and under Advanced; they are not words the default interface uses.

One layout, everywhere:

```
┌ project ──── PARTS · RIG · TEST · ANIMATE ──── status ┐
│ what exists │        work on it         │ what I clicked │
│ (tree)      │        (viewport)         │ (inspector)    │
├─────────────┴───────────────────────────┴────────────────┤
│ context for this stage: review · pose tests · timeline   │
└───────────────────────────────────────────────────────────┘
```

Every stage states one next action in the same place: the right end of the bottom strip.

## Stage rail

| Current | Proposed | Fixes |
|---|---|---|
| `Prepare · Setup · Animate`, ✓ by position | `Parts · Rig · Test · Animate`, each with a real state: ✓ done, ● current, ○ not started, ! needs attention | N1, N2 |
| Keys 1–3 | Keys 1–4 | |
| Animate blocked by a validation error with a toast | Same guard, but the rail shows `! Rig` and the click lands on the problem | R8 |

State rules. Parts ✓ when the rig has art-bearing parts. Rig ✓ when there are no blocking problems, `!` when there are. Test ✓ once a quick test or a manual pose has been run on this project in this browser. Animate ✓ when at least one clip has keys. Stages are never locked except Animate behind a blocking rig problem, which was already the case.

## Parts

| Current | Proposed | Fixes |
|---|---|---|
| Left: `SEMANTIC REGIONS` with empty Body / Details / Equipment headings | Left: **Character parts** checklist. Body (Head, Torso, Left arm › Upper arm, Forearm, Hand, …) and Equipment. Every row carries ✓ Ready, ○ Missing or ! Needs review. Clicking a row makes it the current target. | P2, P7 |
| Lands on `GUIDE` with legacy proposal review | Lands on the guided draw loop when the character has no parts yet. The automatic cut, when its provider is online, is offered as one button, not as the default screen. | P1, P4 |
| Mode tabs `GUIDE · GUIDED MANUAL · ASSIST` | `Guided` (draw each part in turn) and `Free edit` (select and reshape existing parts). AI assist becomes an action inside those, visible only when a provider is available. | P1 |
| `LANDMARK-GUIDED PARTITION`, `LEGACY PROPOSAL REVIEW`, `LEGACY FIXED GUIDE`, anatomy profile, boundary refinement in the default right panel | Right panel shows the current part only: name, status, `Replace · Add · Remove`, `Use guide`, `Use component`. Everything else moves under a collapsed **Advanced**. | P1, P5 |
| Always-on `Automatic Cut OFFLINE` banner with three buttons | Removed. Provider state lives in the systems menu. | P1 |
| `Assigned 100% · Unresolved 0px · 15 guided zones` | `5 / 14 parts ready` and, when relevant, `Unassigned artwork: show`. | P3 |
| `5 Issues` before any work | Problems count only what blocks moving on; a fresh character shows `0 / 14 parts` instead. | P6 |
| Bottom stepper `Source — Body — Equipment — Review` | Bottom strip: current target and count on the left, next action (`Next part`, then `Build rig →`) on the right. | N4, N7 |

One ownership rule changed. A loop still only claims pixels nobody owns, so the overlap at a seam never nibbles the neighbouring part. But a loop drawn mostly on top of existing parts (a hand in front of the torso) carves those pixels out, because that is the only thing the user can mean. A loop that would erase another part completely is refused. A rejected loop is shown as an error that stays on screen.

Retained unchanged: the cutting engine, guided targets, lasso and gesture handling, history, and all validation. Relocated to Advanced: proposal review, guide regeneration, anatomy profile, boundary refinement, foreground recheck.

## Rig

| Current | Proposed | Fixes |
|---|---|---|
| Left tabs `Character · Body · Equipment · Layers` + `Advanced structure` | Left: **Skeleton**, the real parent/child tree, with a `Skeleton · Parts` toggle. Each bone row shows whether it has art. Each part row shows its bone. Raw slot/attachment/skin lists stay behind `Advanced structure`. | R1, R2 |
| Inner stepper `body · pivots · equipment · validate` | Removed. The bottom strip is **Rig review** (below). | N3, R6 |
| Canvas click selects a slot; tree click selects a bone; different inspectors | Still two object kinds, but each shows the other. Selecting a bone outlines the art it controls and lists it in the inspector. Selecting a part highlights its bone and names it. One click moves between them. | R2, R3 |
| Bone inspector: nine numeric fields | **Bone**: Parent · Pivot X/Y · Rotation · Length · Attached part · Status. Scale and inheritance under Advanced. | R3 |
| Slot inspector: schema form | **Part**: Controlled by (bone) · Art · Visible · Layer. Pivot offsets, blend mode and art transform under Advanced. A part with no bone or no art shows a broken-link state. | R4 |
| No context menu | Right-click a bone: Select parent · Select child · Test rotation · Reset rotation. Right-click a part: Select its bone · Edit region in Parts · Hide. | R7 |
| Thin grey bones | Brighter bones, larger joint nodes, a ring on every pivot, the selected chain emphasised and the rest faded, not hidden. | R9 |
| Validation count → drawer of codes | Review rows per joint in plain words; clicking one selects that joint on the canvas. The drawer remains for the full list. | R8 |

### Rig review

The bottom strip in Rig lists the character's chains: Torso, Left arm, Right arm, Left leg, Right leg, and Equipment when present. Selecting a chain emphasises it on the canvas and lists its joints with ✓ or a one-line reason (`Elbow pivot sits outside its art`). **Rotate test** swings the chain's joints through a short sweep without touching the rig. Clicking a flagged joint selects it. Arriving from Parts with a freshly built rig opens review on the first chain (R10).

The checks are deliberately few and visual: the bone has length; the bone controls some art or has children; the pivot lies on or near the art it rotates; no validator error names the bone. Two more catch a rig that reassembles correctly but would bend wrongly: the pivot must also sit on the part it hangs from (a joint is where two parts meet), and a joint whose position the builder could only estimate is flagged until the user moves it.

Bones are drawn joint to joint. A generated rig keeps every bone at zero rest rotation so motion clips stay portable between characters, which means a bone's own axis says nothing about the limb; the canvas draws each bone toward its child joint, and an end bone toward the far side of its art.

### Building the rig from Parts

- A hand-cut part's joint is the seam it shares with its parent part. The bounding-box guess is only a fallback, and a pivot the user moved in Parts always wins. The torso pivots at the waist, where it meets the legs.
- Landmarks from the fixed body template rank below real geometry. Only landmarks fitted to the character are trusted over a seam.
- Equipment keeps its drawn position: its art is offset from the hand or torso bone that carries it.

## Test (new)

Same shell. The skeleton tree on the left, the character in the middle, a pose readout on the right, and a strip of quick tests at the bottom.

- Drag any bone to rotate it. Drag the root to move the character. **Nothing in Test changes the rig** (R5): the pose lives in the viewport only.
- **Reset pose** returns to rest. Key `0`.
- Quick tests: Arm test, Leg test, Full rotation, Equipment test. Each plays a short generated sweep over the relevant bones.
- Two exits, stated: `Looks right → Animate` and `Fix in Rig` (which keeps the bone selected).

Rig and Test now mean different things when you drag: in Rig a drag moves a pivot and edits the rig; in Test a drag poses.

## Animate

| Current | Proposed | Fixes |
|---|---|---|
| Animation dropdown and animation list | The left **Clips** list is the only chooser. The dropdown is removed. | A1 |
| `Animated body` bone list on the left | Removed as a separate list. Bones with keys appear nested under the active clip and mirror the timeline's selection. | A2 |
| Dead undo in the rail, live undo in the toolbar | The rail's undo/redo drive the animation history while in Animate. Toolbar copies removed. | A3 |
| `▶ Play` + `More⌄` | Transport: first · previous key · play/pause · next key · last · loop, with the time beside it. Always visible. | A4 |
| Key inspector `torso · y` | **Keyframe**: Torso · Position Y · frame 19 (0.800 s) · value. Selecting a key moves the playhead to it. | A5 |
| Inspector tabs `Key · AI Animate · Visual Review` | Right panel is the keyframe inspector. `Generate` (from the Clips header) and `Review motion` (from the toolbar) open in the same panel with a close button back to the inspector. | A6, A7 |
| `+ New` only | Clips header: `New clip` and `Generate…` (Idle, Walk, Run, Attack, Custom). An accepted result opens in the timeline and plays. | A7 |
| Toast over the timeline | Status messages move to the top of the viewport and clear themselves. Storage wording removed from the timeline header. | A8, A9 |
| Timeline settings and utilities as left-panel accordions | One `Timeline ⋯` menu on the timeline header. | |

Retained unchanged: the dope sheet, key operations, auto-key, onion ghosts, AI proposal apply, motion review, histories.

## Selection

One selected bone id is held by the editor shell and passed to Rig, Test and Animate, so the forearm selected in Rig is still selected in Test and in the timeline. Parts keeps its own selection because its objects are regions, not bones.

## One authority per task

| Task | The one place | Mirrors |
|---|---|---|
| Select a part | Click it on the canvas | Parts list |
| Select a bone | Click it on the canvas | Skeleton tree, timeline row |
| Edit a pivot | Drag the joint in Rig | Pivot X/Y in the bone inspector |
| Pose | Drag a bone in Test | – |
| Choose a clip | Clips list | – |
| Play | Transport, `Space` | – |
| Edit a keyframe | Timeline; values in the inspector | – |

## Shortcuts

`1–4` stages · `V` select · `Space`-drag pan · `F` fit · `0` reset pose (Test) · `L` lasso (Parts) · `Space` play/pause (Animate) · `K` add key · `⌘Z` / `⇧⌘Z` undo/redo · `⌘K` commands. Each appears in the tool's tooltip.

## Components

| Component | Disposition |
|---|---|
| `StudioModeNav`, `TopCommandRail` | Retained; four stages with computed status |
| `SemanticNavigator` | Replaced by `SkeletonTree` (Skeleton / Parts views); `EditorHierarchy` retained under Advanced |
| `EditorInspector` | Simplified: Bone and Part views, Advanced collapsed |
| `EditorViewport` | Retained; adds pose mode, context-menu event, stronger bone rendering, part outlines for the selected bone |
| Setup workflow rail | Replaced by `RigReviewStrip` |
| – | New `TestPoseStrip`, `CanvasContextMenu`, `src/tools/rig-editor/rigReview.ts`, `src/tools/rig-editor/poseTests.ts` |
| `AnimateWorkspace` | Toolbar and left panel rebuilt as above; `DopeSheet` retained |
| `AnimationInspector` | Humanised; frame shown |
| `PartCutterWorkspace` | Left checklist, guided default, Advanced disclosure, relabelled |

Duplicated concepts removed: the Setup inner stepper, the Prepare stepper variants, the animation dropdown, the animated-body list, the toolbar undo, the Character/Layers tabs.

## Order of work

Shell and stage rail → Rig → Test → Animate → Parts → styling. Styling is last on purpose.

## Standard motions are built per rig

Animate no longer loads the knight's hand-authored clips onto every character. Those clips store absolute angles for bones that rest at about 90°, so on any other rig the limbs flew apart. They are now used only on the bundled knight (`rig-lab-knight`).

Every other rig gets Idle, Walk, Run, Raise Arms, Melee Attack, Hurt and Death from `src/rigging/motion/rigMotion.ts`. Each motion is written anatomically and resolved against the rig:

- **Facing** (`left`, `right` or `front`) comes from `rig.metadata.facing` if set, otherwise from where the foot art sits relative to the ankles (toes point the way the character faces). Feet that point different ways, or sit under the ankle, mean front.
- **Limb direction** is the rest direction joint to joint, so "forward" and "overhead" are worked out per limb rather than assumed.
- **Knees and elbows** bend the way they already bend at rest; a straight joint bends by anatomy (foot trails behind, hand comes forward; seen from the front both fold toward the body).
- **Walk and run follow measured human gait.** Hip, knee and ankle angles come from a table sampled through the gait cycle (heel strike, loading, midstance, push-off, swing), taken from published normal-gait and running kinematics. The stride reaches about 30° forward and 10° back, the knee yields under load and folds most in early swing, and the second leg runs half a cycle behind. Arms swing opposite their own-side leg with more elbow bend in front; a run holds the elbows bent and leans forward.
- **Side view**: those angles are rotations. **Front view**: the same angles point at the viewer, so each segment is shortened by the cosine of its angle (a scale along the limb), which lifts the foot straight up under the hip instead of swinging the leg sideways. The hips shift over the standing leg and drop on the free side.
- **The body is placed from the feet**: after the legs are posed, the pelvis moves so the lower foot stays at ground height, which produces the down and up of each step. A run adds two airborne moments per cycle.
- Every value is the bone's rest value plus a delta, so clips start from the rest pose.

Unedited standard clips are rebuilt when Animate opens, so they follow the rig after a joint is moved. A clip the user changed is never replaced, and a deleted one does not come back (`refreshStandardClips`, tracked by fingerprint in the animation library's metadata). The Generate panel's local provider uses the same engine for named motions.

The reference behind these rules is kept as a Claude skill, `human-motion-rigging` (in the user skills folder), built from Physiopedia's gait and running pages, Wikipedia's gait and arm-swing articles and two animator walk/run breakdowns.

## Keeping the character whole when parts move

Cutting gives every pixel to one part, so parts meet edge to edge and anything behind another part has a hole in it. Build rig now repairs this before any art reaches the rig. The rest pose stays pixel-identical.

- **Stray artwork is adopted.** Slivers left between hand-drawn loops join the nearest part (`adoptStrayArtwork`, up to 6% of the image diagonal away), so loops that do not quite meet leave no cracks. Artwork far from every part stays out.
- **Joint caps.** Jointed neighbours (head–torso, upper arm–forearm, thigh–shin and so on) each receive the other's real pixels inside a disc centred on their seam. A disc centred on the pivot looks the same at any rotation, so a bending joint never opens.
- **Hidden-area fill.** Where a part lies under something drawn in front of it, the covered area is painted by blending the part's own edge colours outward. Under another body part this stays inside the part's own extent; under equipment it also bridges to the next body part, so the body is complete when a weapon or shield swings away. This is a blended guess at art that was never drawn.

All of this lives in `src/character-generation/rigging/jointFill.ts` (`fillPartArt`). The rig builder takes the extended art's bounds through `artBounds`.

## Parts that were not cut

A side view hides the far arm and leg. Parts lists what is missing in plain words and offers **Build without the missing parts**. Bones for those parts are placed from the character itself, never from a body template: an unseen hand that carries equipment sits at that equipment, a wholly hidden leg sits on its visible twin, and anything else folds onto the nearest known joint. Limb bones with no art are not drawn in the viewport and get no keys in the standard clips, though a hidden leg still takes its turn carrying the body in a walk.

A cut part's pivot counts as hand-placed only when `pivotSetByUser` is true on the prepared part (set by the `parts_set_pivot` agent command). Comparing the stored pivot with a fresh outline guess was unreliable: carving and joining stray artwork change the outline, so an untouched guess looked moved and overrode the seam.

## One build path, and rules that hold for any future rig

- **Both ways of building a rig share the art preparation.** The Parts screen and the agent `finalize` command both call `prepareRiggedPartArt` (`src/character-generation/rigging/riggedPartArt.ts`): stray artwork adopted, joint caps, hidden-area fill. The foreground estimate lives in `estimateForeground` so a path without the Parts screen still has one.
- **Hidden-area fill mirrors the part's own texture** across its nearest edge (then one light blur), instead of copying the edge pixel outward, which smeared edges into stripes.
- **Joints across gaps and hidden parents.** A part with no shared edge with its parent (a sword cut out between hip and thigh) is jointed where it comes closest to the parent (`nearestApproach`). A part whose parent was not cut (a forearm whose upper arm is hidden) hangs from the next part up the chain.
- **Facing certainty.** Feet splayed in opposite directions look the same from the front and in a three-quarter view, so the engine reports `facingCertainty: "unsure"` instead of guessing. Animate then asks "Which way does this character face?" with Left / Front / Right; the answer is stored in `rig.metadata.facing`.
- **Small sprites.** A front-view step always lifts the foot by at least 5% of the character's height (7.5% running), so chibi and pixel characters visibly step. Raising the arms counter-rotates a hand that holds equipment, so a held sword stays upright instead of turning upside down.
- **Hurt** is a clear snap away from the blow (torso 20°, head 12°, arms flung forward, knees give), a small overshoot, then recovery.

## Measured gait data, far leg, rebuild and facing (2026-11-17)

- **Gait curves are measured.** `GAIT` in `src/rigging/motion/rigMotion.ts` holds mean hip, knee and ankle angles sampled every 1/16 of the cycle from two CC BY 4.0 motion-capture datasets: Fukuchi, Fukuchi & Duarte 2018 (walking, 42 adults, PeerJ 6:e4640, doi:10.7717/peerj.4640) and Fukuchi, Fukuchi & Duarte 2017 (running at 3.5 m/s, 30 adults, PeerJ 5:e3298, doi:10.7717/peerj.3298). Front-view hip tilt uses the measured pelvic obliquity (about ±5°). Arm swing is not in these datasets and still follows the opposing-leg rule.
- **Far leg in side views.** When a whole leg was not drawn but its twin was, the rig draws the far leg as a darker copy (tint `0x8a8a8a`) of the near leg's art behind the body. It stays listed in `hiddenAnatomy` (it was not drawn) and `metadata.farLegFrom` names the twin. At rest it sits exactly behind the near leg; in a walk it swings half a cycle out of phase.
- **Rebuilding older rigs.** New builds record `metadata.artPreparation` (`ART_PREPARATION_VERSION`, now 2). A generated rig with a lower value shows a notice in Rig and Animate with a **Rebuild** button. It leaves a session request for this project and opens Parts, which rebuilds with the same "build without missing parts" choice and without the replace confirmation. A facing someone chose is kept across rebuilds (Parts and the agent finalize).
- **Facing question right after Build rig.** When the engine is unsure, the question appears at the top of the Rig canvas (and in Animate until answered). Notices live in `app/rig-editor/RigNotices.tsx`.

### ComfyUI on the Mac Studio (tested 2026-11-17)

The Studio runs ComfyUI 0.44 on demand behind a gate (`10.77.77.2:8193` starts the playground engine on `:8192`). Rigging Studio only accepts a localhost ComfyUI URL, so it is reached with `ssh -N -L 127.0.0.1:8188:10.77.77.2:8192 studio`.

- `OCCLUSION_RECONSTRUCTION`: Flux Schnell (the Studio's only image checkpoint) returned abstract smears. SDXL inpainting 0.1 (official `diffusers/stable-diffusion-xl-1.0-inpainting-0.1`, OpenRAIL++, fp16 parts verified by SHA-256) was installed on the Studio and joined into one file with ComfyUI's `CheckpointSave`: `/Volumes/Studio-AI/ComfyUI-Shared/models/checkpoints/sdxl-inpainting-0.1.safetensors`. Point `COMFYUI_INPAINT_CHECKPOINT` at it. Tested on the goblin's sword area: denoise 0.65 returns flat grey (the workflow default is now 1.0); at 1.0 the body under the blade is repainted convincingly, while mask area outside the body is filled with an invented object, which a rig never asks for. About 40 s per repaint on the Studio.
- `CHARACTER_SEGMENTATION` / `MASK_REFINEMENT` need the ComfyUI-SAM2 custom nodes and SAM2 + Grounding DINO models; none are installed on the Studio.

### Repainting hidden areas with the inpainting model

After Build rig, Rig offers **Repaint** when parts have filled-in hidden areas (`metadata.filledParts`), the image is at least 256 px on its short side, the bridge reports `OCCLUSION_RECONSTRUCTION` available, and it has not been done (a failure offers **Try again**). It rebuilds through Parts with `prepareRiggedPartArt(..., { repaint })`: each worthwhile part (at least 200 filled pixels and 2% of its art) is sent to the provider one at a time, and only its filled-in pixels (`FilledPart.filledMask`) are replaced; the artist's pixels and joint caps never change. A failed part keeps the built-in fill. The outcome is recorded in `metadata.hiddenAreaRepaint`.

The model is shown `compositeBehind(...)`: the part and everything drawn behind it, with the gap roughed in by the built-in fill and nothing in front. Shown the original image it repainted the occluder instead (a second sword fragment on the goblin's thigh).

Results (2026-11-17, SDXL inpainting 0.1 on the Mac Studio, about 50 s per part): the ranger's two small hidden patches repainted with no visible change in motion; on the goblin, five parts repainted with no ghost sword, but the thigh under the sword came back as a pale, washed-out cloth patch that is not clearly better than the built-in fill. Repaint stays optional; the built-in fill is the default.

The Parts screen's provider client also had a bug that broke every browser-side reconstruction call ("Illegal invocation" from a stored, unbound `fetch`); `HttpCharacterPipelineProvider` and `OllamaProvider` now wrap `fetch`.

## Top bar (2026-11-17)

- The character's name opens the **project menu**: New from image…, Generate with AI…, Load rig file… (Rig), Import project…, five recent projects, Save, Save As…, Export snapshot, Show folder, Archive…, the projects folder, and rare workspace resets. It replaced both the save pill on the right and the ••• overflow. A small dot and word beside the name give the save state.
- On the right there is one **status chip** (`connection-cluster`): rig issues first, then systems. Then ⌘K, Export (Rig/Animate) and focus.
- Stage-only tools live in the stage: Parts keeps Check and View › Clean source preview.
- Importing an image calls `forgetActiveDiskProject()` first. The project menu reopens the last active disk project whenever it mounts without one, and an import remounts the workspace, so before this the old project was reopened over the new character.

## Cut all parts and the pose model (2026-11-17)

- Parts has **Cut all parts**. It cuts every body part that is not done from the guide (`guideAllBodyParts` in `src/part-cutter/guidedManual.ts`) as one undo step. Hand-cut parts are never changed. When it cut every part itself, slivers between zones join the nearest part (`adoptStrayArtwork`, 15% of the diagonal).
- The joints come from **MediaPipe Pose Landmarker** (`@mediapipe/tasks-vision` 1.2.0, Apache-2.0, `src/character-generation/pose/`) when it finds the character, otherwise from the silhouette guide. `npm run setup:pose` copies the WASM runtime and downloads `pose_landmarker_full.task` into `public/mediapipe/` (git-ignored). Nothing loads from a CDN.
  - Keypoints are used at visibility ≥ 0.6 and inside the image; at least 8 joints must be found. The model names limbs by the character's own side and the guide by screen side, so `poseToLandmarks` matches chains by screen position.
  - `applyPoseLandmarks` swaps them in (source `pose_model`), never over hand-placed joints, and rebuilds every zone.
  - Measured 2026-11-17: an HD front illustration (Silkline Courier, 1024×1536) gets every joint at ≥ 0.82; three 48 px pixel sprites (paladin, rogue, warrior) get shoulders but unreliable legs (the warrior's ankles fell below the image, so they are dropped); the goblin, dwarf, warden and doomsmith find no person. Small sprites are upscaled with smoothing and padded with a 25% margin, which is what made the pixel sprites detectable at all.
- The Parts screen used a private copy of `readImagePixels` without `crossOrigin`. Source images come from the bridge (127.0.0.1:47831), another origin, so the canvas was tainted, foreground analysis always failed and Use Guide stayed disabled. It now uses the shared reader.
- Finished parts are drawn in their own overlay colour and names scale with the image, so a cut can be checked at a glance.

## Orientation (2026-11-17)

- At Build rig, when no facing has been chosen, `estimateView` sets `metadata.facing`, `characterView` (front, back, three-quarter or profile) and `facingSource: "pose-model"`. It reads shoulder and hip width against torso length, shoulder depth, nose direction, and, to tell front from back, which of the character's own shoulders is on the viewer's left.
- `analyzeRigAnatomy` gives three-quarter side-facing rigs `planeScale = cos 45°`. The side-view gait projects every angle through it (`atan(tan α · cos θ)`), so a turned character's stride is foreshortened instead of swinging as if side-on.
- Back views use the front gait on purpose: in 2D a figure walking away lifts its feet exactly as one walking toward the viewer, and arms pair with legs by bone, not by screen side.
- A wholly hidden far arm is now treated like the far leg: its bones sit on the near arm's joints and it is drawn as a darker copy behind the body (`farArmFrom` in rig metadata). `ART_PREPARATION_VERSION` is 3, so older rigs are offered a rebuild.

## Repaint finding (2026-11-17)

On the goblin thigh, with the same input and seed, `InpaintModelConditioning` (keeps the original pixels, so denoise can drop below 1) was compared with the current `VAEEncodeForInpaint` at denoise 1.0, 0.8 and 0.6. Every result turned the red cloth strips pale; 0.6 kept the most colour but invented a metal plate. None beat the built-in fill, so the graph is unchanged and repaint stays optional.

## Click to select with SAM2 on the Mac Studio (2026-11-17)

- Installed in the Studio's playground ComfyUI (Command Center's engine, `/Volumes/Studio-AI/cc-comfy-playground/engine`): `kijai/ComfyUI-segment-anything-2` at commit `0c35fff5f382` in `custom_nodes`, and `sam2.1_hiera_base_plus.safetensors` (323 MB) in `engine/models/sam2`. No pip packages were added or upgraded. Grounding DINO was not installed, so text-prompted `CHARACTER_SEGMENTATION` stays unavailable.
- Capability `POINT_SEGMENTATION` (`comfy-workflows/point-segmentation.json`): source image plus click points in, one mask out, about 1–2 s per click. The node crashes on an empty negative-point list, so the input is left out when there are none.
- `COMFYUI_WAKE_URL=http://10.77.77.2:8193/` (in `.env.local`) lets the bridge start the Studio engine through its gate when it has been stopped for idleness. The tunnel is `ssh -N -L 127.0.0.1:8188:10.77.77.2:8192 studio`.
- Parts has a **Click** tool in the guided toolbar: a click applies SAM2's outline of the item to the current part with the chosen Replace / Add / Remove, and the tool stays on.
- What SAM2 is good and bad at, measured on Silkline Courier: separate objects come out whole from one click (grapple 8,967 px, belt pouch with strap). Body parts do not: it cuts by material (face without hair, shirt without jacket, wristband instead of hand, scattered straps on black leggings), so body parts stay with Cut all parts.
- Provider health is DEGRADED, not MISCONFIGURED, when ComfyUI is reachable and some capabilities work; each capability is then offered on its own. The automatic text-prompted cut is still refused until segmentation is available.

## Joint accuracy benchmark (2026-11-17)

`tests/rigging/guide-accuracy.test.ts` scores the guide's joints against joints marked by hand (`tests/fixtures/rigging/joint-ground-truth.json`), as a share of character height:

| Sprite | View | Silhouette guide (mean / worst) | With pose model |
| --- | --- | --- | --- |
| warrior, 48 px | front | 5.0% / 9.6% (left hip) | 7.5%: worse; its right shoulder lands on the shield |
| goblin, 1024×1536 | profile | 12.1% / 23.8% (left hip) | pose model finds no person |

The ceilings are today's numbers plus a margin; lower them when the guide improves. Because of the warrior result, the pose model is only consulted for images at least 256 px on the short side (`POSE_MODEL_MIN_SIDE`).

### Side views and adult proportions (2026-11-18)

- The guide now measures the legs instead of placing them symmetrically about one centre: at knee and ankle height, two substantial runs of silhouette are two legs, one wide run is two legs touching, and one narrow run is a side view with the legs overlapping (both legs, the hips and the pelvis go on it). Thin runs such as a blade are ignored. A narrow single column counts as a leg even when the lower body otherwise reads as hidden (robe).
- Parts has a **Chibi / Adult** switch above Cut all parts (`GuideProportions`). Chibi is the old behaviour. Adult puts the neck at 22% and the pelvis at 52% of the figure's height and the shoulders a quarter of the way down the torso. In profile the face juts forward, so no row is narrow and the neck cannot be found from the silhouette; a search for a narrow neck in the top 15–30% was tried and found nothing on the goblin, so it was removed.
- Goblin (profile, adult): mean error 12.1% → 7.7%, worst 23.8% → 14.3% (now a wrist). Warrior unchanged at 5.0%.

### When the Studio engine is asleep

The gate stops the Studio engine after 30 minutes idle. With `COMFYUI_WAKE_URL` set, the bridge reports the engine as asleep (provider `asleep: true`, health DEGRADED) and keeps offering the capabilities that worked at its last successful check; the first request wakes it. If the bridge starts while the engine sleeps and nothing is known yet, it wakes the engine once, so the browser learns what it can do (about 50 s). Health polling never wakes it again, so the engine still sleeps when idle.

### One standard for every character (2026-11-18)

Every character goes through the same steps, with nothing tuned for one sprite:

1. **Proportions** are detected from the silhouette (`detectProportions`): median row width ÷ figure height under 0.4 is adult, otherwise chibi. Measured: chibi 0.55–0.80 (all ten benchmark sprites), adult 0.14–0.25 (goblin, courier); the median ignores the rows a weapon widens. `buildAdaptiveAnatomicalPartitionGuide` defaults to `"auto"`, so every caller gets it; Parts shows Auto / Chibi / Adult with Auto selected, and the result is recorded in the guide's `adaptiveMetadata.proportions`.
2. **Joints** come from the pose model (DWPose) wherever it scores a joint at least 0.5, otherwise from the silhouette (see "Pose model: DWPose" below).
3. **Silhouette joints are measured where the drawing allows**: legs from leg columns at knee and ankle height, arms from a run of silhouette beside the torso at elbow and wrist height (the run nearest the body; anything further out is held equipment). Adult wrists hang at the hips. Where nothing separate is drawn, the proportional guess stays.

**Adding a character to the benchmark.** Add it to `tests/fixtures/rigging/joint-ground-truth.json` with its image, view, proportions and hand-marked joints (screen-side names), or only its image and proportions under `proportionsOnly`. `tests/rigging/guide-accuracy.test.ts` then checks it like every other: proportions detected correctly, mean joint error at most 10% of the figure's height, and no worse than its recorded baseline. Record a new sprite's baseline, or lower baselines after an improvement, with `UPDATE_GUIDE_BASELINE=1 npx vitest run tests/rigging/guide-accuracy.test.ts`; recording never raises a baseline.

Current baselines (mean / worst joint error): warrior 5.0% / 9.6%, goblin 6.2% / 10.0%, courier 5.95% / 12.7%, paladin 5.9% / 11.4%, rogue 3.8% / 8.2%.

**Wrists are traced** (`traceWrist`): each arm is followed down from its elbow, row by row, along the run of silhouette beside the torso nearest the previous row's (at first, nearest the guessed elbow; a short stretch where the arm still joins the body is skipped), and the wrist is the narrowest row in the middle of the trace (the last rows are fingertips). The courier went from 6.3% to 5.95%. Starting the trace at the shoulder was tried and rejected by the benchmark: where the arm still joins the body, the first separate run is the held weapon (the paladin 5.9% → 7.0%, the rogue 3.8% → 5.3%). The paladin's wrists stay about 4 px high: in 48 px art its raised hands merge with the mace and shield, so the silhouette cannot say where the arm ends. Place them by hand, or let Build rig put the hand at the equipment it carries.

## Pose model: DWPose, joint by joint (2026-11-18)

MediaPipe is replaced by **DWPose** (`yzd-v/DWPose`, `dw-ll_ucoco_384.onnx`, Apache-2.0), run with `onnxruntime-web` 1.31.1 in the browser and, with the same code, in the benchmark under Node (`src/character-generation/pose/dwpose.ts`: crop around the silhouette with a 25% margin, nearest-neighbour fit to 288×384, decode the SimCC outputs). `npm run setup:pose` downloads the model to `public/models/dwpose/` (git-ignored, checksum-verified). The runtime is bundled: Vite will not load modules from `public/`, so `poseDetector.ts` imports `onnxruntime-web/wasm` and the `.wasm` binary as a `?url` asset, and `vite.config.ts` excludes `onnxruntime-web` from dependency pre-bundling.

**One rule for every character: a joint comes from DWPose only when DWPose scores it at least 0.5; every other joint comes from the silhouette.** No size gate. Measured on the five hand-marked sprites (mean joint error, share of figure height):

| Sprite | Outline only | Full pipeline | Joints from DWPose |
| --- | --- | --- | --- |
| courier (HD, front) | 5.9% | **1.9%** | 17 |
| goblin (HD creature, profile) | 6.2% | **4.6%** | 9 |
| warrior, paladin, rogue (48 px) | 5.0%, 5.9%, 3.8% | unchanged | 0 (low scores) |

The 0.5 threshold and nearest-neighbour fitting were chosen on these five sprites (smooth upscaling and lower thresholds made the pixel sprites worse); the benchmark keeps checking them on every sprite added, and fails if the pose model ever makes a sprite worse than the outline alone.

**Fixing what is still wrong is one drag.** Parts that Cut all parts (or Use Guide) made are remembered; moving a joint in the guide (View › Anatomical guide) re-cuts those whose zone changed, in the same undo step (`recutFromGuide`, `changedZoneSemantics`). A part edited by hand (lasso, Add, Remove, Click, brush, edge reshape) is never re-cut over.
