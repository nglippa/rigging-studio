# Guided Studio UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Rigging Studio into a five-step guided flow (Create → Parts → Rig → Animate → Export). Every step
shares one frame with its main button centred in a bottom action bar. Each step's expert tools open as a
three-column expanded view.

**Architecture:**
- A new `StepShell` frame and a single `steps.ts` model (steps, addresses, availability) replace the two step bars
  and each page's own header and footer.
- The existing workspaces (`CreateCharacterWorkspace`, `PartCutterWorkspace`, `RigEditor`) keep their state and
  logic. Only their rendering moves into the frame's slots and an `ExpandedView` layout.
- Redraws are stored per project and animation on the bridge, so Animate and Export share them.

**Tech Stack:**
- Next.js app router and React (TypeScript).
- Plain CSS in `app/studio-ui/`.
- Vitest for unit tests.
- Playwright scripts run with `tsx` for browser checks, as in `scripts/ui-hydration-torture.mts`.
- The existing bridge (`mcp/transport/StudioBridgeServer.ts`) and `BakeService`.

**Spec:** `docs/superpowers/specs/2026-11-20-guided-studio-ui-design.md`

## Global Constraints

- Steps, in order and with these labels: Create, Parts, Rig, Animate, Export.
- Addresses:

  | Step | Address |
  |---|---|
  | Create | `/create-character` |
  | Parts | `/part-cutter` |
  | Rig | `/?mode=setup` |
  | Animate | `/?mode=animate` |
  | Export | `/?mode=export` |

  `/?mode=test` redirects to `/?mode=setup`.
- Unavailable-step reasons, verbatim: "Choose art first", "Cut the parts first", "Build the rig first", "Fix the rig
  problems first".
- The main button is always bottom-centre in the action bar. No notice is ever laid over the stage or timeline.
  Notices and errors go in the instruction line.
- Undo and Redo appear once, in the top bar.
- Type scale: 13 px body, 11 px panel labels, 14 px main button. One interface font. Monospace only for numbers and
  keys. One accent colour for the main action and the selection.
- The guided panel is 240-270 px wide. Expanded views have a left column of about 220 px, a centre, and a right
  column of about 280 px.
- An expanded view's action bar has a reset on the left, a hint for the selection, and "Done, back to {Step}" as
  the main button.
- Expert features are moved, never deleted. The only new features are bend limits and Snap to landmark.
- Do not change what cutting, the rig build, motion or the bake compute.
- Never commit `agents.md`, `docs/ux-v2-handoff.md`, `tsconfig.tsbuildinfo`, `CLAUDE.md`, or the dot folders.
  Delete scratch files before committing.

## Review Focus

1. **Bridge down or paused** (it exits with code 144 during Command Center deploys).
   - Expected: Create's model list shows "The Mac Studio isn't reachable" and the steps stay navigable.
   - Expected: Animate's Redrawn option is disabled with that reason.
   - Expected: a redraw in flight returns to "Not yet" with a retry.
   - Pinned in Tasks 6 and 15.
2. **Redraws that no longer match the rig.** After a bone, part or clip changes, stored redraws for affected clips
   must not be reused; they show "Not yet" again. Pinned in Task 14 (fingerprints).
3. **An address for a step that isn't available**, such as `/?mode=animate` with no rig. Expected: the furthest
   available step opens, with the reason in the instruction line. Pinned in Tasks 1 and 4.
4. **Page load with a rigged project on a non-rig page.** Expected: reopening the last project never navigates
   away from the current step (the Create bounce). Pinned in Task 2.
5. **Phone width (390×844).** Expected: no sideways scroll, the main button visible without scrolling, and the
   panel stacked under the stage. Pinned in Task 5's audit, which runs both viewports.

---

## Stage 1: Frame and navigation

### Task 1: Step model

**Files:**
- Create: `app/studio-ui/steps.ts`
- Create: `tests/ui/steps.test.ts`
- Modify: `vitest.config.ts` (add `"tests/ui/**/*.test.ts"` to `include`)

**Interfaces:**
- Produces:
  - `type StepId = "create" | "parts" | "rig" | "animate" | "export"`
  - `const STEPS: readonly { id: StepId; label: string; href: string }[]`, using the addresses from the Global
    Constraints.
  - `type StepState = { hasArt: boolean; partsCut: boolean; hasRig: boolean; rigValid: boolean }`
  - `function stepAvailability(state: StepState): Record<StepId, { available: boolean; reason?: string }>`
  - `function stepForLocation(pathname: string, mode: string | null): StepId`
  - `function resolveStep(requested: StepId, state: StepState): { step: StepId; reason?: string }`, which returns
    the requested step if it is available, otherwise the furthest available step before it, with the blocking
    reason.

- [ ] **Step 1: Write the failing tests** in `tests/ui/steps.test.ts`:
  - `stepAvailability({hasArt:false,partsCut:false,hasRig:false,rigValid:false})`: only `create` is available,
    and `parts.reason === "Choose art first"`.
  - With `hasArt:true`: parts is available, and `rig.reason === "Cut the parts first"`.
  - With `partsCut:true`: rig is available, and `animate.reason === "Build the rig first"`.
  - With `hasRig:true, rigValid:false`: `animate.reason === export.reason === "Fix the rig problems first"`.
  - `stepForLocation` maps each address to its step:
    - `("/create-character", null)` → create
    - `("/part-cutter", null)` → parts
    - `("/", "setup")` → rig
    - `("/", "test")` → rig
    - `("/", "animate")` → animate
    - `("/", "export")` → export
  - `resolveStep("animate", {hasArt:true,partsCut:true,hasRig:false,rigValid:false})` returns
    `{ step: "rig", reason: "Build the rig first" }`.
- [ ] **Step 2: Run** `npx vitest run tests/ui/steps.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `app/studio-ui/steps.ts` with the signatures above. Reasons are verbatim from the
  Global Constraints.
- [ ] **Step 4: Run** `npx vitest run tests/ui/steps.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Step model: five steps, addresses and availability reasons".

### Task 2: Reopening a project never navigates (the Create bounce)

**Files:**
- Modify: `app/studio-ui/ProjectStorageMenu.tsx`. The functions involved are `installLoaded` (which currently
  always pushes the project's destination), `performOpen`, and the startup reopen effect that calls
  `performOpen(target)`.
- Create: `scripts/ui-audit.mts`, the browser audit. This task adds its first check; Task 5 extends it.
- Modify: `package.json` (add the script `"test:ui-audit": "tsx scripts/ui-audit.mts"`).

**Interfaces:**
- Produces:
  - `performOpen(project, options?: { navigate?: boolean })`. It defaults to `true` for the user's Open. The
    startup reopen passes `{ navigate: false }`.
  - `scripts/ui-audit.mts` exports nothing. It runs checks against `RIG_STUDIO_APP_URL` (default
    `http://localhost:5177`) and exits non-zero on any failure. Its checks are named functions
    `check<Name>(page): Promise<void>`, so later tasks can add more.

- [ ] **Step 1: Write the failing check** `checkCreateStaysOnCreate`.
  - Set up the hydration fixtures the same way `scripts/ui-hydration-torture.mts` installs `hydration-project-c`
    (a rig and animations). Make it the active disk project.
  - Open `/create-character` and wait 4 s.
  - Assert that `location.pathname === "/create-character"`.
- [ ] **Step 2: Run** `npm run test:ui-audit` with the dev server up. Expected: FAIL. The page ends on
  `/?mode=animate`.
- [ ] **Step 3: Implement** the `navigate` option. `installLoaded` skips `router.push` when `navigate` is false,
  and the startup effect passes `{ navigate: false }`.
- [ ] **Step 4: Run** `npm run test:ui-audit`. Expected: PASS. Also run `npm run test:ui-hydration`. Expected:
  PASS, unchanged.
- [ ] **Step 5: Commit** with the message "Reopening the last project on load no longer navigates away (Create
  bounced to Animate)".

### Task 3: `StepShell`, `StepNav` and `ExpandedView` layouts

**Files:**
- Create: `app/studio-ui/StepShell.tsx`
- Create: `app/studio-ui/ExpandedView.tsx`
- Create: `app/studio-ui/step-shell.css`, imported once in `app/layout.tsx`.

**Interfaces:**
- Consumes: `STEPS`, `stepAvailability`, `StepId` (Task 1). `ProjectStorageMenu` keeps its existing props.
- Produces:
  - `StepShell` props:
    - `step: StepId`
    - `state: StepState`
    - `projectName: string`
    - `saved: "saved" | "unsaved" | "not-saved"`
    - `onUndo?: () => void; onRedo?: () => void; canUndo?: boolean; canRedo?: boolean`
    - `stage: ReactNode`
    - `panel: ReactNode`
    - `instruction: ReactNode`
    - `tone?: "info" | "warning" | "error"` (colours the instruction)
    - `primary: { label: string; onClick: () => void; disabled?: boolean; disabledReason?: string; busy?: boolean }`
    - `secondary?: ReactNode` (left of the instruction)
    - `expanded?: ReactNode` (when present it replaces stage and panel, and the step label shows "· expanded")
  - `StepNav` (inside `StepShell`) renders `STEPS` as buttons. Each one is `aria-current="step"` when it is the
    current step. An unavailable step is a disabled button whose `title` and `aria-description` carry the reason.
    Clicking an available step navigates to its `href`.
  - `ExpandedView` props:
    - `left: ReactNode`
    - `center: ReactNode`
    - `tools: ReactNode` (top-centre of the centre column)
    - `viewToggles?: ReactNode` (top-right)
    - `zoom?: ReactNode` (bottom-right)
    - `right: ReactNode`
  - CSS classes: `.step-shell`, `.step-top`, `.step-nav`, `.step-body`, `.step-stage`, `.step-panel`,
    `.step-bar`, `.step-primary`, `.expanded`, `.expanded-left`, `.expanded-center`, `.expanded-right`,
    `.expanded-tools`. Values come from the Global Constraints and the approved mockups
    (`.superpowers/brainstorm/20332-1795203451/content/step-frame.html` option A, and `rig-expanded.html`).
- Layout rules:
  - Body is a grid: `1fr` plus a panel of `clamp(240px, 20vw, 270px)`.
  - Under 720 px wide, the panel stacks under the stage, and the bar stays fixed at the bottom with the primary
    button full-width.

- [ ] **Step 1: Write the failing check** `checkShellOnEveryStep` in `scripts/ui-audit.mts`. For each step address,
  assert:
  - exactly one `.step-shell` and one `.step-nav`;
  - five nav buttons labelled with the steps;
  - one `.step-primary` horizontally centred within ±40 px of the viewport centre;
  - no element other than the stage content overlapping `.step-stage`.
- [ ] **Step 2: Run** `npm run test:ui-audit`. Expected: FAIL (no `.step-shell`).
- [ ] **Step 3: Implement** the three components and their CSS.
- [ ] **Step 4: Typecheck** with `npx tsc --noEmit -p .`. Expected: no errors. The check still fails until Task 4
  wires the steps.
- [ ] **Step 5: Commit** with the message "StepShell, StepNav and ExpandedView layouts".

### Task 4: Mount every page in the frame, without changing its content yet

**Files:**
- Modify: `app/create-character/CreateCharacterWorkspace.tsx`. Replace the inline `<header
  className="character-topbar">` (with its own step buttons) and `<footer className="character-status">` with
  `StepShell`.
- Modify: `app/part-cutter/PartCutterWorkspace.tsx`. Replace `TopCommandRail` and the bottom "Final review / Build
  rig" bar with `StepShell`.
- Modify: `app/rig-editor/RigEditor.tsx`:
  - Replace `TopCommandRail` with `StepShell`.
  - Remove the duplicate Undo and Redo from the toolbars.
  - Route `mode=test` to `setup` (`router.replace("/?mode=setup")`).
  - Add `export` to `EditorMode`.
  - Remap shortcuts to 1-5 for the five steps.
- Modify: `app/studio-ui/RigNotices.tsx`. Return text for the instruction line instead of an overlay.
- Delete: `app/studio-ui/StudioModeNav.tsx` and its imports.
- Modify: `app/studio-ui/ProjectStorageMenu.tsx`. Remove the "New" group (New from image…, Generate with AI…,
  Import project…). Starting a character is the Create step. Importing a project moves into the Recent list's
  header as "Import…". The menu's trigger reads "Projects ▾".

**Interfaces:**
- Consumes: `StepShell` (Task 3) and `resolveStep` (Task 1).
- Produces: each page computes its `StepState` from its project:
  - `hasArt = !!project.sourceImage`
  - `partsCut` = the segmentation has accepted parts
  - `hasRig = !!rig`
  - `rigValid` = there are no blocking validation issues
  If the requested step resolves elsewhere, the page calls `router.replace(target href)` and shows the reason as
  the instruction.

- [ ] **Step 1: Extend the audit** with `checkUnavailableStepRedirects`. With a project that has art but no rig,
  `/?mode=animate` ends on `/?mode=setup` or `/part-cutter`, and the instruction contains "Build the rig first" or
  "Cut the parts first".
- [ ] **Step 2: Run** `npm run test:ui-audit`. Expected: FAIL.
- [ ] **Step 3: Implement** the mounting. Each page keeps its existing content inside `stage` and `panel`. Its
  primary action is today's main action:
  - Create: Generate
  - Parts: Build rig →
  - Rig: Make animations →
  - Animate: Export →
  - Export: the existing `ExportForGame` content rendered inline as the stage (it is fully replaced in Task 16)
- [ ] **Step 4: Run** `npm run test:ui-audit`, `npm run test:ui-hydration`, `npx vitest run` and
  `npx tsc --noEmit -p .`. Expected: all pass, including `checkShellOnEveryStep`.
- [ ] **Step 5: Commit** with the message "Every step renders in one frame with one step bar; test folds into rig".

### Task 5: Every-button audit

**Files:**
- Modify: `scripts/ui-audit.mts`
- Modify: whatever files the audit finds dead controls in.

**Interfaces:**
- Produces: `checkEveryControl(page, step: StepId, expanded: boolean)`. It is run for every step, in the guided
  view and (from Task 7 on) the expanded view, at 1440×900 and 390×844.

- [ ] **Step 1: Implement the check.**
  - For each visible, enabled `button`, `a[href]`, `[role=tab]`, `select` and `input[type=checkbox|radio]` inside
    `.step-shell`, take a fingerprint before and after clicking. The fingerprint is: URL, DOM size, `aria-*`
    states, focused element, open dialogs or popovers, network requests started, and checked or selected values.
  - Fail if the fingerprint is unchanged ("dead control") or if any console error is logged.
  - For controls whose text matches `/archive|start over|remove|delete|rebuild/i`, assert that a confirmation
    appears, then cancel it.
  - Assert that every disabled control has a non-empty `title` or `aria-description`.
  - Restore the page after each click (reload the step) so clicks don't interact.
  - At both viewports, assert that `document.documentElement.scrollWidth <= innerWidth` and that `.step-primary`
    is within the viewport without scrolling.
- [ ] **Step 2: Run** `npm run test:ui-audit`. Expected: FAIL, listing each dead control as `step / label`.
- [ ] **Step 3: Fix each listed control.** Wire it to the action its label names, or remove it if the spec moved
  that action elsewhere. Record each fix in the commit body.
- [ ] **Step 4: Run** `npm run test:ui-audit`. Expected: PASS at both viewports.
- [ ] **Step 5: Commit** with the message "Every control on every step does something (audit plus fixes)".

## Stage 2: Create

### Task 6: Create, guided view

**Files:**
- Create: `app/create-character/ModelCards.tsx`
- Modify: `app/create-character/CreateCharacterWorkspace.tsx`. The stage and panel use the new layout; the old
  Describe and Choose-art sub-steps merge into one step.
- Modify: `app/create-character/create-character.css`. Reduce it to the stage's own styling.

**Interfaces:**
- Consumes: `GenerationProfile` from `app/create-character/ProfilePicker.tsx`, using these fields: `id`, `label`,
  `available`, `missing`, `recommended`, `benchRank`, `benchSeconds`, `bestFor`, `speed`.
- Produces: `ModelCards({ profiles, selectedId, onSelect, error }: { profiles: readonly GenerationProfile[];
  selectedId: string | null; onSelect: (id: string) => void; error?: string })`.
  - Cards are sorted by `benchRank`, with unranked profiles last.
  - Badges: "Best match" for rank 1 or `recommended`, then "2nd", "3rd" and so on.
  - The subtitle is `bestFor`, then "about {benchSeconds} s" (or `speed`).
  - A profile that is not available is disabled, with the subtitle "Install it from Command Center" when
    `missing.length`, otherwise its `reason`.
  - When `error` is set and there are no profiles, it shows "The Mac Studio isn't reachable" and a Retry button.
- Layout:
  - **Stage:** the description textarea and "or upload your own art". After generating, the candidates appear as
    a grid; clicking one selects it.
  - **Panel:** the Model cards, Style, Facing, and the link "Tune this model's settings · Add a model file", which
    opens the expanded view (Task 7).
  - **Primary:** "Generate" while there are no candidates, then "Use this art →", which saves the chosen art and
    goes to Parts.
  - **Secondary actions in the panel:** "Generate 4 more", "Change description".

- [ ] **Step 1: Write the failing check** `checkCreateGuided` in the audit.
  - The panel shows model cards, and the first has the text "Best match".
  - Clicking a card gives it `aria-pressed="true"`.
  - The primary reads "Generate".
  - With the bridge unreachable (route the requests to a closed port with `page.route`), the panel shows "The Mac
    Studio isn't reachable" and the step bar still navigates.
- [ ] **Step 2: Run** `npm run test:ui-audit`. Expected: FAIL.
- [ ] **Step 3: Implement** `ModelCards` and the guided Create view.
- [ ] **Step 4: Run** `npm run test:ui-audit`, `npx vitest run` and `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Create: model cards, generate and choose art in one step".

### Task 7: Create, expanded view

**Files:**
- Modify: `app/create-character/CreateCharacterWorkspace.tsx`
- Modify: `app/create-character/ProfilePicker.tsx`. It becomes the right column's content. Keep its parameter
  editing and its profile import.

**Interfaces:**
- Consumes: `ExpandedView` (Task 3) and `ProfilePicker`'s existing props.
- Layout:
  - **Left:** the generated options and earlier generations (history), grouped by description.
  - **Centre:** the selected option, with a compare toggle (two options side by side) and zoom.
  - **Right:** `ProfilePicker`'s settings and "Add a model file".
  - **Action bar:** "Reset settings" on the left, and "Done, back to Create" as the primary.

- [ ] **Step 1: Extend the audit.** Run `checkEveryControl(page, "create", true)`, and assert that "Done, back to
  Create" returns to the guided view.
- [ ] **Step 2: Run** `npm run test:ui-audit`. Expected: FAIL.
- [ ] **Step 3: Implement** the expanded view.
- [ ] **Step 4: Run** `npm run test:ui-audit`. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Create: expanded view for model settings and generation history".

## Stage 3: Parts

### Task 8: Parts, guided view

**Files:**
- Modify: `app/part-cutter/PartCutterWorkspace.tsx`. Move the editing-mode tabs, the tool bar, `Check`, `View`,
  the second Undo/Redo and the `Advanced` drawer out of the guided view.
- Modify: `app/part-cutter/part-cutter.css`

**Interfaces:**
- Consumes: the workspace's existing part-status data (the list behind "14 / 14 ready" and "Final review").
- Layout:
  - **Stage:** the character with its parts tinted, and no overlay labels.
  - **Panel:** "Parts · {ready} of {total} ready". Groups are Head, Body, Arms, Legs and Held items. Each row shows
    Ready or Check, and clicking a row opens it in the expanded view. The link reads "Edit parts manually →".
  - **Primary:** "Build rig →", disabled with the reason "{n} required parts still need cutting" while required
    parts are missing.
  - **Instruction:** "Parts are cut automatically. Check the {first part needing a check}, then build the rig."
    When nothing needs a check: "All parts are ready. Build the rig."

- [ ] **Step 1: Write the failing check** `checkPartsGuided`. The guided panel has no `[role=tablist]` and no
  toolbars. The rows are grouped under the five group headings. The primary is "Build rig →".
- [ ] **Step 2: Run** `npm run test:ui-audit`. Expected: FAIL.
- [ ] **Step 3: Implement** the guided view.
- [ ] **Step 4: Run** `npm run test:ui-audit`. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Parts: guided view with grouped part status".

### Task 9: Parts, expanded view

**Files:**
- Modify: `app/part-cutter/PartCutterWorkspace.tsx`

**Interfaces:**
- Consumes: `ExpandedView`, and the workspace's existing tools (lasso, brush, erase, click-select, accept,
  merge, split, recut).
- Layout:
  - **Left:** every part grouped like the body, with status, and a search box.
  - **Centre tools:** Lasso (L), Brush (B), Erase (E), Click-select (C).
  - **View toggles:** Show unassigned artwork, Outlines.
  - **Right**, for the selected part:
    - Name and type
    - Accept
    - Merge with… and Split
    - Recut
    - Remove part, which asks for confirmation
  - **Action bar:** "Start over" on the left, which asks for confirmation. "Done, back to Parts" as the primary.

- [ ] **Step 1: Extend the audit.** Run `checkEveryControl(page, "parts", true)`. Pressing L, B, E and C switches
  the active tool.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with the message "Parts: expanded cutter in the shared expanded layout".

## Stage 4: Rig

### Task 10: Bend limits

**Files:**
- Modify: `src/rigging/schema/types.ts` (`BoneDefinition`) and `src/rigging/schema/schemas.ts`
- Modify: `src/rigging/animation/evaluate.ts`, so posed rotations are clamped.
- Create: `src/rigging/motion/bendLimits.ts`
- Create: `tests/rigging/bend-limits.test.ts`

**Interfaces:**
- Produces:
  - `BoneDefinition.rotationLimits?: { readonly min: number; readonly max: number }`, in degrees and relative to
    the rest rotation.
  - `defaultBendLimits(rig: RigDefinition): Record<string, { min: number; max: number }>` in `bendLimits.ts`.
    Default ranges by bone role:

    | Role | Range |
    |---|---|
    | elbow and knee | -5° to 150° on their bend side |
    | shoulder | -60° to 170° |
    | hip | -45° to 110° |
    | neck and head | -40° to 40° |
    | torso | -30° to 30° |
    | wrist and ankle | -45° to 45° |
    | anything else | none |

  - `clampToLimits(rig: RigDefinition, pose: RigPose): RigPose`, which `evaluateAnimationAtTime` applies last.

- [ ] **Step 1: Write the failing tests.**
  - A bone with `rotationLimits: {min:-10,max:20}` posed at 45° evaluates to 20°, and at -30° to -10°.
  - A bone without limits is unchanged.
  - `defaultBendLimits` on `tests/fixtures/bench-rigs/goblin-warrior-pixel.rig.json` gives `left-lower-arm` a
    range of 155° wide.
  - Every standard clip of both bench rigs, evaluated at each drawing, is identical with and without default
    limits applied. The defaults must not change today's motion.
- [ ] **Step 2: Run** `npx vitest run tests/rigging/bend-limits.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The schema field is optional, so existing rigs validate unchanged.
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS. Then run `npx tsx scripts/handdrawn-bench.mts`.
  Expected: the goblin still passes 6 of 7.
- [ ] **Step 5: Commit** with the message "Bend limits per joint, clamped when posing".

### Task 11: Snap to landmark

**Files:**
- Create: `src/rigging/editing/snapToLandmark.ts`
- Create: `tests/rigging/snap-to-landmark.test.ts`

**Interfaces:**
- Produces:
  - `landmarkFor(rig: RigDefinition, boneId: string): { x: number; y: number; label: string } | null`. It reads
    `rig.metadata.pivotSources[boneId].point`. The label is the joint word: shoulder for an upper arm, elbow for a
    lower arm, hip for an upper leg, knee for a lower leg, neck for the neck or head, otherwise "landmark".
  - `snapPivotToLandmark(rig: RigDefinition, boneId: string): RigDefinition`. It moves the bone's origin to the
    landmark (in parent space) and keeps children and attachments where they are in world space.

- [ ] **Step 1: Write the failing tests.**
  - On the goblin fixture, move `left-upper-arm` by +40 px.
  - `snapPivotToLandmark` returns the bone's world origin to `pivotSources["left-upper-arm"].point` within
    0.5 px.
  - Every child bone's world position is unchanged within 0.5 px.
  - `landmarkFor(rig, "left-upper-arm").label === "shoulder"`.
  - A bone without a pivot source returns `null`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Snap a joint's pivot back to its landmark".

### Task 12: Rig, guided view

**Files:**
- Modify: `app/rig-editor/RigEditor.tsx` (setup mode)
- Modify: `app/rig-editor/RigReviewStrip.tsx`
- Modify: `app/rig-editor/TestPoseStrip.tsx`
- Modify: `app/rig-editor/RigNotices.tsx`

**Interfaces:**
- Consumes: the existing chain checks (`RigReviewStrip`) and test poses (`TestPoseStrip`).
- Layout:
  - **Stage:** the character with its skeleton, and nothing floating on it.
  - **Panel:**
    - Facing (Left, Front, Right), shown once only.
    - "Joints": Body and head, Arms, Legs, each OK or "{n} to check".
    - "Try a pose": Wave, Crouch, Step, Rest.
    - The link "Edit bones manually →".
  - **Primary:** "Make animations →". It builds the standard clips as today, then goes to Animate.
  - The "built before gap filling" notice becomes the instruction, with a "Rebuild" secondary that asks for
    confirmation.

- [ ] **Step 1: Write the failing check** `checkRigGuided`.
  - The panel has Facing, Joints and Try a pose, and exactly one Facing control on the page.
  - Clicking "Wave" changes the stage canvas pixels; compare screenshots of the stage.
  - The primary is "Make animations →".
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:ui-audit`. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Rig: guided view with joint checks and test poses (Test step folded
  in)".

### Task 13: Rig, expanded view

**Files:**
- Create: `app/rig-editor/RigExpanded.tsx`
- Modify: `app/rig-editor/RigEditor.tsx`
- Modify: `app/rig-editor/SkeletonTree.tsx`
- Modify: `app/rig-editor/EditorInspector.tsx`
- Modify: `app/rig-editor/CanvasControls.tsx`

**Interfaces:**
- Consumes: `ExpandedView`, `defaultBendLimits` and `clampToLimits` (Task 10), `landmarkFor` and
  `snapPivotToLandmark` (Task 11), and the existing bone selection, pivot drag and draw-order commands.
- Layout (matches the approved `rig-expanded.html`):
  - **Left:** SKELETON with a bone count. A search box. Groups Body, Left arm, Right arm, Left leg and Right leg,
    each with OK or "{n} to check". Bone rows show the art they carry, such as "+ sword".
  - **Centre tools:** Move joint (V), Rotate to test (R), Pan (Space).
  - **View toggles:** Bones, Parts, Onion skin.
  - **Zoom:** Fit, −, a percentage, +.
  - **Right**, for the selected bone:
    - **Joint:** X and Y number fields with ± nudge, "Snap to {label}" (disabled with "No landmark for this bone"
      when `landmarkFor` is null), and Reset.
    - **Bends between:** min and max, and a test slider within the limits that rotates the bone live.
    - **Art on this bone:** a thumbnail, its draw-order description, Bring forward, Send back, "Swap art…", and
      "Recut in Parts" (which navigates to Parts' expanded view with that part selected).
    - **Try a pose.**
  - **Action bar:** "Reset this bone" on the left. The hint comes from the bone's chain check (for example "Pivot
    looks low: try Snap to shoulder"). "Done, back to Rig" as the primary.

- [ ] **Step 1: Extend the audit.**
  - Run `checkEveryControl(page, "rig", true)`.
  - Selecting `left-upper-arm` in the tree highlights its joint on the canvas.
  - "Snap to shoulder" is enabled for it.
  - Dragging the test slider changes the stage pixels.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:ui-audit` and `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Rig: expanded view (skeleton, joint, bend limits, art and draw order)".

## Stage 5: Animate

### Task 14: Redraw store on the bridge

**Files:**
- Create: `src/image-production/bake/redrawStore.ts`
- Modify: `src/image-production/bake/BakeService.ts`, to record each finished clip in the store.
- Modify: `mcp/transport/StudioBridgeServer.ts`, to add the routes below.
- Create: `tests/image-production/redraw-store.test.ts`

**Interfaces:**
- Produces:
  - `fingerprint(rig: RigDefinition, clip: AnimationDefinition, mode: "redraw" | "polish"): string`. It is a
    SHA-256 over the rig's bones, slots and attachments (image data included), the clip's tracks, drawings and
    smears, and the mode.
  - `class RedrawStore { constructor(root: string); record(projectId: string, clipId: string, fingerprint: string,
    jobId: string): Promise<void>; lookup(projectId: string, clipId: string, fingerprint: string):
    Promise<{ jobId: string } | null> }`. It persists to `.rigging-studio/bakes/redraws.json`.
  - `BakeRequest` gains `projectId?: string`. When it is present, each finished clip is recorded.
  - Bridge routes:
    - `POST /bake/redraws/lookup`, body `{ projectId, rig, animations, mode }`, answers
      `{ clips: { id, status: "ready" | "missing", jobId?, sheet?, json? }[] }`.
    - `GET /bake/assets/:jobId/:file` (existing) serves the files.

- [ ] **Step 1: Write the failing tests.**
  - `fingerprint` is stable for equal input.
  - `fingerprint` changes when a bone's x changes, when an attachment's image changes, when a clip keyframe
    changes, and when the mode changes.
  - `record` then `lookup` with the same fingerprint returns the `jobId`; a different fingerprint returns `null`.
  - The store survives a new `RedrawStore` instance on the same root.
- [ ] **Step 2: Run** `npx vitest run tests/image-production/redraw-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the store, the recording in `BakeService.run` (per clip, after its sheet is written),
  and the lookup route. One redraw job per clip, so a clip's sheet is a whole job.
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Redraws stored per project and animation, keyed by a rig and clip
  fingerprint".

### Task 15: Animate, guided view with the Look switch

**Files:**
- Create: `app/rig-editor/SheetPlayer.tsx`, moved out of `ExportForGame.tsx` unchanged.
- Create: `app/rig-editor/AnimateGuided.tsx`
- Modify: `app/rig-editor/RigEditor.tsx` (animate mode)
- Modify: `app/rig-editor/AnimateWorkspace.tsx`

**Interfaces:**
- Consumes: `SheetPlayer({ sheetUrl, jsonUrl })`, the lookup route (Task 14), `POST /bake/jobs` (with
  `projectId`), and `GET /bake/jobs/:id` (a 404 means the job was lost).
- Produces: `AnimateGuided({ rig, animations, projectId, look, onLook, included, onIncluded })`, where:
  - `look: "rigged" | "redrawn"` is stored on the project (`project.metadata.exportLook`, default `"rigged"`);
  - `included: ReadonlySet<string>`.
- Layout:
  - **Stage:**
    - Rigged: the selected clip plays live (the existing player).
    - Redrawn: Rigged and Redrawn side by side, labelled "Rigged · ▶ {clip}" and "Redrawn · ▶ {clip}". The
      Redrawn side shows the stored sheet, or "Not redrawn yet".
  - **Panel:**
    - "Look": Rigged, or Redrawn via Comfy, with the one-line explanations from the spec.
    - "Animations · click to preview": each with a checkbox and a status:
      - Redrawn ✓
      - Redrawing {done}/{total}…
      - Not yet · {minutes} min (30 s a drawing)
      - "Lost: Rigging Studio restarted · Retry" after a 404
    - Small links: "Redraw method: pose redraw ▾" (pose redraw or polish) and "Edit keyframes manually →".
  - **Redrawn disabled:** when the bridge is unreachable, the Redrawn option is disabled with "The Mac Studio isn't
    reachable".
  - **Primary:**
    - Rigged: "Export →".
    - Redrawn with any included clip missing: "Redraw the rest", which queues the missing clips one job each.
    - Otherwise: "Export →".

- [ ] **Step 1: Write the failing check** `checkAnimateGuided`.
  - The Look switch exists.
  - Choosing Redrawn shows two labelled previews.
  - Each clip row shows a status.
  - With `page.route` returning 404 for `/bake/jobs/*`, a started redraw shows the "Lost" status with Retry.
  - With the bridge routed to a closed port, the Redrawn option is disabled with its reason.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:ui-audit`. Expected: PASS. Then redraw one clip of the goblin for real through
  the UI, and confirm it shows "Redrawn ✓" after a reload, read back from the store.
- [ ] **Step 5: Commit** with the message "Animate: Rigged or Redrawn look, side-by-side preview, per-animation
  redraw status".

### Task 16: Animate, expanded view

**Files:**
- Modify: `app/rig-editor/AnimateWorkspace.tsx`
- Modify: `app/rig-editor/DopeSheet.tsx`
- Modify: `app/rig-editor/AnimationInspector.tsx`
- Modify: `app/rig-editor/AIAnimationPanel.tsx`

**Interfaces:**
- Consumes: `ExpandedView`, and the existing timeline, keying and AI animation commands.
- Layout:
  - **Left:** animations, then, under the selected animation, its bones with keys.
  - **Centre tools:** Play (Space), Add key (K), Auto-key, Onion skin.
  - **Centre:** the stage, with the timeline (`DopeSheet`) as a strip across the bottom of the centre column only.
  - **Right**, for the selected key: its value, easing, and time. With no key selected, the bone's tracks.
    "Generate with AI…" lives here.
  - **Action bar:** "Reset this animation" on the left, which asks for confirmation. "Done, back to Animate" as
    the primary.

- [ ] **Step 1: Extend the audit.** Run `checkEveryControl(page, "animate", true)`. The timeline's width is within
  the centre column. K adds a key at the playhead.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with the message "Animate: expanded keyframe editing in the shared layout".

## Stage 6: Export

### Task 17: Export step (replaces the dialog)

**Files:**
- Create: `app/rig-editor/ExportStep.tsx`
- Delete: `app/rig-editor/ExportForGame.tsx`, after its logic moves here.
- Modify: `app/rig-editor/RigEditor.tsx` (export mode)
- Modify: `app/globals.css`, to remove the dialog's styles.

**Interfaces:**
- Consumes: `SheetPlayer`, the lookup route (Task 14), the bake routes, and `project.metadata.exportLook`
  (Task 15).
- Layout:
  - **Stage:** `SheetPlayer` for the export as it will be saved, with a tab per clip.
  - **Panel:**
    - "Format": Sprite sheet or Live rig, with the one-line explanations from the spec.
    - "Included": the clips ticked in Animate, with the total drawing count.
    - The link "Sheet layout and padding · Polish-only option", which opens the expanded view.
  - **Primary:**
    - Sprite sheet with the Rigged look: "Download sprite sheet". It bakes in rig mode (instant) and downloads
      the PNG and JSON.
    - Sprite sheet with the Redrawn look: "Download sprite sheet", which combines the stored redrawn sheets into
      one sheet. It is disabled with "{n} animations aren't redrawn yet; finish them in Animate" while any are
      missing.
    - Live rig: "Download live rig", which downloads the rig JSON and the animations JSON, as today.
- Expanded view:
  - **Left:** included clips.
  - **Centre:** the preview.
  - **Right:** padding, cells per row, and the polish-only bake.

- [ ] **Step 1: Write the failing check** `checkExport`.
  - No `.export-for-game` dialog exists anywhere.
  - On `/?mode=export` the primary starts a download (`page.waitForEvent("download")`) for the Rigged look.
  - With Redrawn chosen and a clip missing, the primary is disabled with its reason.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Combining sheets is a new bridge route, `POST /bake/combine`, body `{ jobIds:
  string[], clipIds: string[] }`. It answers like a finished bake, with a `sheet.png` and `sheet.json` in the
  `rigging-studio-sheet/1` format, and is implemented in `BakeService.combine(jobIds, clipIds)`. Add a unit test
  in `tests/image-production/combine-sheets.test.ts`: combining two one-clip sheets gives one sheet with both
  clips, whose frames' pixels equal the originals.
- [ ] **Step 4: Run** `npm run test:ui-audit`, `npx vitest run` and `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Export is a step: format, included animations, preview, download (the
  dialog is retired)".

### Task 18: Final pass

- [ ] **Step 1: Run** `npm run test:ui-audit` (all steps, guided and expanded, both viewports),
  `npm run test:ui-hydration`, `npm test`, and `npx tsx scripts/handdrawn-bench.mts`. Expected: everything
  passes, and the bench is unchanged at 6 of 7 for the goblin.
- [ ] **Step 2: Walk the whole flow by hand in the browser** with a new character: describe, pick a model,
  generate, choose art, check parts, build the rig, snap a joint, try a pose, preview Rigged and Redrawn, redraw
  one clip, and export both a sheet and a live rig. Take screenshots of each step at 1440×900 and compare them with
  the approved mockups.
- [ ] **Step 3:** Sync to the Studio and restart it, then confirm the app and the bridge answer.
- [ ] **Step 4: Commit** any fixes, with the message "Guided studio: final pass".
