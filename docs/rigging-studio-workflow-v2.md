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

- `OCCLUSION_RECONSTRUCTION` nodes are all present, but the only image checkpoint is `flux1-schnell-fp8`. Run through the trusted workflow on the goblin's sword area (4 steps, cfg 1, denoise 1, 86 s), it produced abstract smears, not body. The built-in mirror fill stays the default until an inpainting checkpoint is installed.
- `CHARACTER_SEGMENTATION` / `MASK_REFINEMENT` need the ComfyUI-SAM2 custom nodes and SAM2 + Grounding DINO models; none are installed on the Studio.
