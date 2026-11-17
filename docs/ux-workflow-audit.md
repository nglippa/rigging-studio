# Rigging Studio UX workflow audit

Audit date: 2026-11-16. Method: the live app at `localhost:5177` with the local project bridge running, driven in a real browser at 1440×900. Projects used: the bundled knight rig (`rig-lab-knight`), `HYDRATION PROJECT A` (16 parts, 5 animations, edit stage), and `Final Gate 10 Silkline Courier` (source art, prepare stage). Screenshots are in `.rigging-studio/diagnostics/workflow-ui-v2/2026-11-16T07-10-00Z/before/`.

This audit was written before any implementation. It records where a person who has never seen the code has to stop and ask "what am I supposed to do now?". The proposed fix for each item is in [rigging-studio-workflow-v2.md](./rigging-studio-workflow-v2.md).

## Summary

The editor has the right capabilities and an already-restrained visual language. What it lacks is one consistent model of *what exists*, *what is selected* and *what comes next*. The three stages each use a different layout, a different vocabulary and a different selection model, and the product names things after its implementation (slot, attachment, semantic region, legacy proposal, landmark-guided partition) instead of after what the artist is doing.

The single largest gap: **there is no way to test a rig without entering Animate.** The only "does it bend correctly?" check is to open an animation and scrub.

## Stage navigation

| # | Observation | Why it stops the user |
|---|---|---|
| N1 | The rail reads `Prepare · Setup · Animate`. | Neither "Prepare" nor "Setup" says what you make there. Parts and Rig do. |
| N2 | Completion is positional: every stage left of the current one gets a ✓, whether or not it is done. | The ✓ is not information, so the user cannot trust it. |
| N3 | Setup has a second, inner stepper: `1 body · 2 pivots · 3 equipment · 4 validate`. Clicking a step changes overlay behaviour and which left tab is active, but not the layout or the tools. `validate` opens a drawer. | Two steppers stacked. The inner one looks like a required sequence but is really a view filter. |
| N4 | Prepare has a third stepper with different words per sub-mode: `Source — Cut — Review 0/0 — Ready` in Guide, `Source — Body — Equipment — Review` in Guided Manual. | Three progress models in one product. |
| N5 | Opening a saved project left the URL at `?mode=animate` while the screen showed Setup. | Reload lands somewhere different from what was on screen. |
| N6 | Prepare lives on a separate route with a visibly different top bar (larger type, different stage pills, different status cluster). | Feels like leaving the editor for another app. |
| N7 | The next action is only stated in Setup (`Enter Animate →`). Prepare's is `Continue to Cut` / `Finish Body →`; Animate has none. | "What next?" has an answer in one stage out of three. |

## Parts (currently "Prepare")

| # | Observation | Why it stops the user |
|---|---|---|
| P1 | First screen for a fresh character: mode tabs `GUIDE · GUIDED MANUAL · ASSIST`, tools `Select · Reshape · Split · Merge`, a canvas tag `LANDMARK-GUIDED PARTITION`, a right panel titled `LEGACY PROPOSAL REVIEW` with `Accept selected / Accept safe / Reject`, a `LEGACY FIXED GUIDE — Preserved without migration` notice, and a bottom banner `Automatic Cut OFFLINE — Manual available` with three buttons. | Nothing says "draw around the head". Five competing starting points, and most of the words describe migrations and providers. |
| P2 | The left panel is titled `SEMANTIC REGIONS 0` and shows three empty headings: `BODY`, `DETAILS`, `EQUIPMENT`. The 14 body parts the guided flow will ask for are not listed. | The user cannot see what a finished character consists of, or how far along they are. |
| P3 | Status reads `Assigned 100% · Unresolved 0px · 15 guided zones` while zero parts exist. | "100% assigned" with nothing done reads as finished. |
| P4 | Guided Manual itself is good: `HEAD · REPLACE` over the canvas, `BODY 0/14`, Replace/Add/Remove, Back/Skip, lasso stays active. But it is reached through a button in an "offline" error banner. | The best workflow is presented as a fallback. |
| P5 | `Use Guide` is explained as "Explicit guide ∩ foreground; existing manual pixels stay owned." | Set notation in a hint. |
| P6 | `5 Issues` is shown in the top bar from the first second, before the user has done anything. | Reads as "you broke something". |
| P7 | Part state is spread across validation flags; there is no single ✓ / ○ / ! per part. | No readable checklist. |

## Rig (currently "Setup")

| # | Observation | Why it stops the user |
|---|---|---|
| R1 | Left panel has four tabs (`Character · Body · Equipment · Layers`) plus `Advanced structure`. `Body` groups bones by region (Head / Torso / Arms › Left › …), not by parent. Every row is tagged `Pivot`. | The actual skeleton — who is the child of whom — is only visible under Advanced. A row called "Left Forearm · Pivot" does not say whether it is a bone, a part, or a pivot. |
| R2 | A character part is three objects: slot, attachment, and the bone it rides on. Clicking art on the canvas selects a *slot*; clicking the tree selects a *bone*; `Equipment › Art` selects an *attachment*. Each has a different inspector. | Clicking the forearm on the canvas and clicking "Left Forearm" in the tree give two different inspectors for what the user thinks is one thing. |
| R3 | The bone inspector shows `Connected To`, X, Y, Rotation, Length, Scale X, Scale Y, Inherit rotation, Inherit scale. It does not show which art the bone controls. | The part ↔ bone relationship, the core idea of rigging, is not stated anywhere. |
| R4 | The slot inspector calls the bone `Connected To` and the art `Displayed Part`, and shows blend mode, layer order, pivot X/Y and a second transform block. | Internal schema as a form. |
| R5 | Dragging a bone on the canvas moves its pivot; dragging the small violet handle rotates it — and both write to the rig's rest pose. | A user who drags to "see if the elbow bends" has just changed the rig. There is no non-destructive pose. |
| R6 | The `pivots` step adds a faint crosshair to the selected joint and nothing else. | The step implies a different tool; it is the same tool. |
| R7 | No right-click menu. No keyboard shortcut hints on tools. | Common operations (select parent, reset, test) need the tree or the command palette. |
| R8 | Validation is a count (`1 Issues`) that opens a drawer listing validator codes. | The user cannot see *where* on the character the problem is until they click through. |
| R9 | Bones are thin grey lines with 2.5 px joints at 62% alpha; unselected bones drop to 22% alpha when anything is selected. | On detailed art the skeleton is hard to find. |
| R10 | An auto-rig result arrives as a finished skeleton with no walk-through. | Nothing asks the user to confirm each limb works. |

## Test / Pose

Does not exist. The command palette has `Test selected joint`, which only prints a status message. A `previewMode` exists in code but has no control in the UI.

## Animate

| # | Observation | Why it stops the user |
|---|---|---|
| A1 | The current animation can be chosen in two places: a dropdown in the toolbar and the list in the left panel. | Two authorities for one choice. |
| A2 | Bones appear three times: the `Animated body` list (left), track labels (timeline), and the canvas. The left list and the timeline both select bones. | Three lists to keep in agreement by eye. |
| A3 | Undo exists in the top rail (disabled in Animate) and again in the animation toolbar (enabled). | The obvious undo button is dead. |
| A4 | Transport is `▶ Play` plus a `More⌄` menu holding Stop, Restart, Previous keyframe, Next keyframe. Loop is under `Manage⌄`. | Basic playback is partly hidden. |
| A5 | Selecting a key opens an inspector that reads `torso · y`, `Bone torso`, `Property y`, `Time 0.8`, `Value -5`. The playhead stays where it was, so the canvas does not show the pose being edited. | Raw ids; and "what frame am I editing?" is answered in a field, not on screen. |
| A6 | Inspector tabs: `Key · AI Animate · Visual Review`, the last containing `Legacy visual review`. | Generation and review are filed under "properties of the selected thing". |
| A7 | Creating motion: `+ New` makes an empty clip; generating a walk is on the `AI Animate` inspector tab. | The primary creative act has no obvious entry point. |
| A8 | The status toast (`Opened disk project … · Opened disk animations 31%`) sits on top of the timeline rows. | Covers the thing being edited. |
| A9 | Timeline header text: `Browser cache current`. | Storage internals in the editing surface. |

## Selection

Selection is three separate pieces of state: `selections` in the rig editor, `selectedBones` in Animate, and the part cutter's own. Switching stage drops it. Within Rig, canvas and tree agree only when the user happens to click the same *kind* of object in both.

## Vocabulary the user must currently learn

`slot`, `attachment`, `skin`, `semantic region`, `landmark-guided partition`, `legacy proposal`, `legacy fixed guide`, `anatomy profile`, `boundary refinement`, `unresolved px`, `local cache only`, `browser cache current`, `systems 1/3`, `advanced structure`. None of these is needed to cut a character, rig it and animate it.

## What already works and should be kept

- Viewport-first layout with collapsible, resizable side panels and a focus mode.
- The Guided Manual loop (target named over the canvas, draw → commit → next, lasso stays armed).
- Hover hint and chain emphasis on the canvas; the selected-bone ring and rotation handle.
- Humanised bone names (`left-lower-arm` → Left Forearm).
- The dope sheet with per-bone rows, key diamonds, issue markers and a resizable height.
- The command palette, undoable command histories, disk persistence and project isolation.
- The dark, low-chroma look with cyan for selection and violet for manipulation.

## Navigation baseline (before)

Counted on `HYDRATION PROJECT A` at 1440×900. "Ambiguous" counts points with two or more plausible controls.

| Task | Clicks | Panel switches | Mode switches | Ambiguous steps |
|---|---|---|---|---|
| Find the head part | 2 (Body tab → Head) | 0 | 0 | 1 (Body vs Layers vs canvas) |
| Replace the head region | 4+ (Prepare → Guided Manual → target → draw) | 1 | 1 (route change) | 2 |
| Find left forearm | 3 (Arms → Left → Left Forearm) | 0 | 0 | 1 |
| See which bone controls it | not shown for a bone; for a part: click art, read `Connected To` | 1 | 0 | 1 |
| Move its elbow pivot | 1 drag (indistinguishable from "move the bone") | 0 | 0 | 1 |
| Rotate / test the arm | not possible without editing the rig or entering Animate | – | 1 | 1 |
| Reset pose | not available (Undo only) | – | – | 1 |
| Open Walk | 1 | 0 | 1 | 1 (dropdown vs list) |
| Play it | 1 | 0 | 0 | 0 |
| Find a left-leg keyframe | 2–3 (expand row, click key) | 0 | 0 | 1 (left list vs timeline) |
| Change it | 1 field edit | 1 (inspector opens) | 0 | 0 |
| Undo it | 1 | 0 | 0 | 1 (two undo buttons) |
| Switch to Attack | 1 | 0 | 0 | 1 |
| Return to Rig, identify a problem | 2–3 (Setup → Issues → drawer row) | 1 | 1 | 1 |

## Conclusion

The interface is not ugly; it is unexplained. The redesign should not add surface. It should remove two of the three steppers, collapse slot/attachment/bone into "part" and "bone", make the skeleton tree the left panel, state the part ↔ bone link in both directions, give posing its own non-destructive stage, and give every stage one stated next action.
