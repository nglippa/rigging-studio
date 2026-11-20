# Guided Studio UI: design

Date: 2026-11-20 · Status: approved in conversation, awaiting written-spec review

## Why

The user finds Rigging Studio confusing and cluttered, with buttons that do not work, from generating a character to
rigging it. The goal: every step is clean, direct, functional and easy to understand, and each step's main action is
centred and always visible. Expert tools stay, but only appear when asked for.

Problems found in an audit on 2026-11-20 (at 1440×900, real projects):

- **Two step bars disagree.** Create shows six steps (Describe, Choose art, Parts, Rig, Test, Animate); the other
  pages show five (Create, Parts, Rig, Test, Animate).
- **Create is unreachable from a rigged project.** The Create button and `/create-character` both bounce back to
  `/?mode=animate`.
- **Labels and content disagree.** The step bar read "Describe" over the part editor. The final-review panel's
  heading reads "Main Hand Equipment".
- **Starting is hidden.** "New from image" and "Generate with AI" live inside the project-name dropdown. Its recent
  list is mostly test projects.
- **Clutter.** Parts shows three overlapping toolbars and a second Undo/Redo. Animate shows the timeline, bone tree,
  keyframe tools and the facing question at once. Notices are laid over the canvas and timeline. Typefaces and
  sizes vary by panel.
- **Main actions are inconsistent.** "Build rig" is bottom-centre on Parts. Export is a small corner button on
  Animate.

## Decisions (approved)

1. Guided flow, with expert tools available on request rather than removed or always shown.
2. Five steps: **Create → Parts → Rig → Animate → Export.** Test folds into Rig. Choose art folds into Create.
3. One shared frame component for every step (approach 1 of 3; restyling in place and a single-page rewrite were
   rejected).
4. Frame layout A: an action bar along the bottom with a one-line instruction and the main button centred, and a
   narrow right panel holding only the step's essentials.
5. The Create step offers click-to-choose ComfyUI model selection.
6. The Animate step has a **Look** switch, **Rigged** or **Redrawn via Comfy**, with side-by-side preview and
   per-animation redraw status. Export follows the chosen look.
7. Every step has an expanded ("edit manually") view in the three-column layout approved for Rig. Rig's expanded
   view gains bend limits and Snap to shoulder.

Mockups (local, git-ignored): `.superpowers/brainstorm/20332-1795203451/content/` — `step-frame.html` (frame,
option A chosen), `steps.html` (all steps), `steps-v2.html` (model choice, look switch), `rig-expanded.html`
(expanded layout).

## The frame: `StepShell`

A new component in `app/studio-ui/StepShell.tsx`. Every step renders through it, so the top bar and the action
bar cannot drift, move or be duplicated per page.

```
┌ top bar: project name + saved state │ Create · Parts · Rig · Animate · Export │ Undo Redo  Projects ▾ ┐
├──────────────────────────────────────────────────────────────┬───────────────────────────┤
│                         stage (character)                    │ panel: step essentials    │
│                                                              │ … "Edit … manually →"     │
├──────────────────────────────────────────────────────────────┴───────────────────────────┤
│        [← Back]      one-line instruction / notice / error       [ Main action ]          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Slots: `stage`, `panel`, `instruction` (also carries notices and errors: no overlays on the canvas), `primary`
(`{ label, onClick, disabled?, disabledReason?, busy? }`), optional `secondary` (left of the instruction, e.g.
Back, Reset), and `expanded` (the step's expert view, see below).

- **Undo and Redo** appear once, in the top bar.
- **The Projects menu** only opens, switches and manages projects. With no project open, the app lands on
  Create. The "New" actions leave the dropdown.
- The panel is about 240-270 px wide. The stage takes the rest.

## Navigation: one step bar

`app/studio-ui/steps.ts` is the single source of the steps, their addresses, and whether each is available.
`StudioModeNav` and Create's own stepper are replaced by one `StepNav` inside `StepShell`.

| Step | Address | Available when | When unavailable |
|---|---|---|---|
| Create | `/create-character` | always | — |
| Parts | `/part-cutter` | art is chosen | "Choose art first" |
| Rig | `/?mode=setup` (absorbs `test`) | parts are cut | "Cut the parts first" |
| Animate | `/?mode=animate` | a valid rig exists | "Build the rig first" / "Fix the rig problems first" |
| Export | `/?mode=export` (new) | a valid rig exists | as Animate |

An unavailable step is shown disabled with its reason as a tooltip and accessible description. It never shows a
notice popped over the canvas. `/?mode=test` redirects to `/?mode=setup`.

**Bug to fix first:** opening `/create-character` (or the Create step) with a rigged project must stay on Create and
show that project's art and settings. Today it is redirected to `/?mode=animate`.

## The steps (guided views)

### 1. Create

- **Stage:** a description box with "or upload your own art". After generating, the stage shows the candidates
  as a grid to pick from. This replaces the separate Choose-art step.
- **Panel:**
  - **Model · on the Mac Studio:** the bridge's generation profiles as clickable cards, each with a name, what it
    is best for, its approximate time and its benchmark rank. A profile whose model is missing is disabled with
    "Install it from Command Center".
  - **Style:** Pixel art or Painted. Styles that no available model provides are hidden.
  - **Facing:** Left, Front or Right.
  - Link: "Tune this model's settings · Add a model file" opens the expanded view.
- **Main button:** Generate. Then, while candidates are shown: **Use this art →** (Generate 4 more and Change
  description are secondary actions in the panel).

### 2. Parts

- **Stage:** the character with its parts tinted.
- **Panel:** parts grouped like the body (Head, Body, Arms, Legs, Held items), each Ready or Check, with a count
  ("13 of 14 ready"). Clicking a part opens it in the expanded view.
- **Main button:** **Build rig →**. It is disabled with a reason while required parts are missing.

### 3. Rig (Test folded in)

- **Stage:** the character with its skeleton.
- **Panel:**
  - Facing.
  - Joint check per group (Body and head, Arms, Legs).
  - **Try a pose:** Wave, Crouch, Step, Rest. This replaces the Test step.
  - The "built before gap filling, Rebuild" notice moves to the instruction line, with a Rebuild secondary
    button.
- **Main button:** **Make animations →**.

### 4. Animate

- **Stage:** the selected animation playing. With **Redrawn** chosen, Rigged and Redrawn play side by side.
- **Panel:**
  - **Look:** Rigged or Redrawn via Comfy, with a one-line explanation of each.
  - **Animations:** click one to preview it, and untick to leave it out. With Redrawn chosen, each one shows its
    status: Redrawn ✓, Redrawing n/m…, or "Not yet · ~N min", using the existing estimates.
  - Small options: Redraw method (pose redraw by default, polish), "Edit keyframes manually →".
- **Main button:** **Export →**. With Redrawn chosen and animations not yet redrawn, it is **Redraw the rest**,
  and Export stays reachable from the step bar for whatever is ready.
- Redraws run through the existing bake service (`POST /bake/jobs`, mode `redraw`) one animation at a time. Results
  are kept per project and animation, so Animate and Export share them and nothing is redrawn twice.

### 5. Export

- **Stage:** a preview of the export, using the existing sheet player.
- **Panel:**
  - **Format:** Sprite sheet or Live rig. The sprite sheet uses the look chosen in Animate (Rigged: the rig's
    drawings; Redrawn: the stored redraws).
  - The animations included, with the drawing count.
  - Link: "Sheet layout and padding · Polish-only option".
- **Main button:** **Download sprite sheet** or **Download live rig**.
- `ExportForGame`'s dialog is retired. Its bake, preview and download logic move into this step.

## Expanded views ("edit manually")

Every step's expert tools open as a full workspace in one layout, the one approved for Rig:

- **Top bar:** unchanged, with the step marked "· expanded".
- **Left column (about 220 px):** a list grouped the way a person thinks about it, with a status per group and a
  search box.
- **Centre:** the character. One compact toolbar sits top-centre, with each tool showing its key. View toggles
  are top-right and zoom bottom-right. Nothing else floats on the canvas.
- **Right column (about 280 px):** the selected item only, in short titled sections. Every row is a direct
  action.
- **Action bar:** a hint for the current selection, a reset on the left, and **Done, back to [step]** centred.

| Step | Left | Centre tools | Right (selected item) |
|---|---|---|---|
| Create | Generated options and history | Compare, zoom | Model settings (LoRA strengths, size, seed), add a model file |
| Parts | Parts grouped like the body, with status | Lasso, Brush, Erase, Click-select | Name and type, accept, merge or split, recut |
| Rig | Skeleton grouped by body region, with status | Move joint (V), Rotate to test (R), Pan (Space) | Joint X/Y with nudge, Snap to shoulder, Reset · Bends between (range + test slider) · Art on this bone, draw order, swap, recut in Parts · Try a pose |
| Animate | Animations, then bones with keys | Play, Add key, Auto-key, Onion skin | The selected key's value and easing. The timeline is a strip across the bottom of the centre column only. |
| Export | Included animations | Preview player | Sheet layout, padding, polish-only option |

**New in Rig's expanded view:**

- **Bend limits:** each joint gets a min/max rotation, stored on the bone. Motion and the test slider clamp to
  it, and defaults come from the existing anatomy ranges.
- **Snap to shoulder (or hip, neck, elbow, knee):** moves the selected joint's pivot to the landmark-derived
  position the rig builder already computes (`metadata.pivotSources`).

## Removed

- The second Undo/Redo.
- Notices laid over the canvas or timeline.
- The separate Choose-art and Test steps.
- The corner Export button.
- The "New" actions in the project dropdown.
- Duplicate controls, such as the facing question appearing in both the rig panel and the clips panel.

Existing features are not removed: they move into the guided panel or the expanded view.

## Styling

- One type scale (13 px body, 11 px panel labels, 14 px main button) and one font family for the interface.
  Monospace is used only for numbers and keys.
- One accent colour for the main action and the selection.
- Thin dividers instead of nested cards.
- Existing design tokens are kept where present (`app/studio-ui/workstation.css`). The per-page CSS
  (`create-character.css`, `part-cutter.css`, `rig-editor.css`) is reduced to step-specific stage styling.

## Order of work

Each stage ships working on its own and is checked in the browser before the next.

1. **Frame and navigation:**
   - `StepShell` and `steps.ts`.
   - The single step bar, with availability and reasons.
   - The fix for Create bouncing to Animate.
   - Notices move to the instruction line.
   - Steps keep their current content inside the frame.
2. **Create:** model cards, generate, choose art in-step, and the expanded view.
3. **Parts:** guided panel and the expanded cutter.
4. **Rig:** guided panel with test poses, the expanded rig view, bend limits, and Snap to the landmark.
5. **Animate:** the Look switch, per-animation redraw status and storage, side-by-side preview, and the expanded
   timeline.
6. **Export:** the step replaces the dialog and follows the look.

## Testing

- **Every-button check (Playwright), per step and per expanded view.** Open the step with a real project and click
  every visible, enabled control. Each click must produce an observable effect (navigation, an opened view or
  menu, a started job, a changed value or selection) and no console error. Every disabled control must carry a
  reason. Destructive controls (Archive, Start over, Remove part) are checked to ask for confirmation, and are
  then cancelled.
- **Browser checks:** each stage at 1440×900 and 390×844: no sideways scroll, the main button visible without
  scrolling, and nothing overlapping the stage.
- **Unit tests:** step availability and reasons (`steps.ts`), bend-limit clamping, Snap-to-landmark, and redraw
  storage per project and animation.
- The existing suite (518 tests) stays green.

## Not in scope

- Changing what cutting, the rig build, motion or the bake do. This work changes how they are presented and
  reached, with the two named additions (bend limits, Snap to landmark).
- Hem and hair as separate animated pieces (tracked separately as a rigging change).
- New export formats.

## Risks

- `RigEditor.tsx` (871 lines) and `PartCutterWorkspace.tsx` (711 lines) mix state with layout. Splitting their
  content into the frame's slots is the largest piece of work. The state stays where it is, and only the
  rendering moves.
- Keyboard shortcuts in `RigEditor` (2, 3 and 4 switch modes) are remapped to the five steps.
- Project hydration (`ProjectHydrationBoundary`) causes the Create redirect. It is fixed in stage 1, with a
  regression test.
