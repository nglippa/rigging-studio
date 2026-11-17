# Rigging Studio UX v2 — handoff

Written 2026-11-16 05:25 CST. Read this first, then `docs/rigging-studio-workflow-v2.md` (the spec) and `docs/ux-workflow-audit.md` (the findings it answers, referenced as N1, P2, R5, A3 …).

## The task

Rebuild the editor's workflow around four stages — **Parts → Rig → Test → Animate** — using Spine (structure), Rive (cleanliness), Live2D (part ↔ rig mapping) and Cascadeur (manipulation, testing) as interaction references, keeping the dark neon-lab look. The owner's full brief ends with a strict gate: return `RIGGING STUDIO UX V2 PASS` only if a scripted new-user task, a navigation benchmark, a confusion audit, responsive and accessibility checks and the full regression suite all hold; otherwise `FAILED`. **No verdict has been given yet.** Do not declare PASS from the code alone.

## State of the tree

Nothing is committed. Everything is uncommitted on `main` at `7742097`. `agents.md`, `CLAUDE.md`, `.claude/`, `.codex/`, `.entire/`, `.serena/` were already dirty/untracked before this work and are not part of it.

Verified at 05:23 on this tree:

- `npx tsc --noEmit` — clean.
- `npx vitest run --config vitest.config.ts` — 53 files, 400 tests, all pass.
- `npx eslint .` — 2 errors, both `no-explicit-any` in `scripts/deterministic-cut-arbitration/finalize.mts`, a file this work never touched. No errors in changed files.

Not run yet: production build, `node --test tests/rendered-html.test.mjs`, `npm run test:ui-hydration` (the 100-switch isolation run), `npm run test:mcp` on its own, the Void Ranger / WOS regression scripts under `scripts/`.

**Two sessions have edited this tree.** The first wrote the docs, the stage rail, the rig-review / pose-test logic, the viewport changes, the new Rig/Test shell and the inspectors, then paused at a usage limit. Between 01:32 and 01:48 a second session continued: it rebuilt Animate, added the v2 styles, updated the source-string tests and made two `src/` changes. The first session has not reviewed the second session's work in a browser. Treat anything in the "second session" rows below as unverified beyond tests passing.

## What exists

| Area | Files | Written by | Browser-verified |
|---|---|---|---|
| Audit and spec | `docs/ux-workflow-audit.md`, `docs/rigging-studio-workflow-v2.md` | first | n/a |
| Four-stage rail with real ✓ / ● / ○ / ! status | `app/studio-ui/StudioModeNav.tsx`, `TopCommandRail.tsx` (`stageStatuses` prop) | first | no |
| Rig review, skeleton ordering, part ↔ bone lookups | `src/tools/rig-editor/rigReview.ts` | first | unit-tested |
| Quick-test rotation sweeps | `src/tools/rig-editor/poseTests.ts` | first | unit-tested |
| Pivot-only move (art and children stay put) | `moveBonePivot` in `src/tools/rig-editor/document.ts` | first | unit-tested on knight and Void Ranger golden |
| Tests for the three above | `tests/rigging/rig-workflow.test.ts` | first | pass |
| Viewport: pose mode, pivot-only drag with ghost marker, right-click event, brighter bones, pivot rings, outline of art controlled by the selected bone, violet bone for the selected part, `resetPose()` | `app/rig-editor/EditorViewport.tsx` | first | **no** |
| Rig/Test shell: skeleton tree with Skeleton/Parts toggle, review strip, pose strip, context menu, `test` mode, keys 1–4 and `0` | `app/rig-editor/RigEditor.tsx`, `SkeletonTree.tsx`, `RigReviewStrip.tsx`, `TestPoseStrip.tsx`, `CanvasContextMenu.tsx` | first | **no** |
| Bone / Part inspectors with Advanced collapsed | `app/rig-editor/EditorInspector.tsx` | first | **no** |
| Keyframe inspector (humanised, frame number) | `app/rig-editor/AnimationInspector.tsx` | first (second may have edited) | **no** |
| Parts stage: checklist, Guided default, Advanced disclosure, `Next part` / `Build rig →` | `app/part-cutter/PartCutterWorkspace.tsx`, `part-cutter.css` | sub-agent of first | **no** |
| Animate: single clip chooser, transport group, rail undo wired to animation history | `app/rig-editor/AnimateWorkspace.tsx` | second | **no** |
| v2 styles (`.workflow-v2 …`, about 175 lines) | `app/studio-ui/workstation.css` | second | **no** |
| Source-string tests updated to the v2 design | `tests/rigging/workspace-shell.test.ts`, `reactive-selection.test.ts`, `guided-manual-prepare.test.ts` | second | pass |
| `stage` type gains `"test"` | `src/diagnostics/integrityEvidence.ts` | second | – |
| `unresolvedComponents` bounds computed in a loop instead of spreading into `Math.min/max` | `src/part-cutter/guidedManual.ts` | second | covered by a test it added |
| Removed | `app/rig-editor/SemanticNavigator.tsx`, `semanticBody.ts` | both | – |

The `guidedManual.ts` change is production logic outside the UI brief. It looks like a real fix (spreading a whole sprite's pixels into `Math.min` overflows the call stack) but it should be read and called out in the final report, not left silent.

## Known gaps against the spec

1. **`DopeSheet.tsx` is unchanged.** Timeline rows are still two-level (`bone.parentId ? 1 : 0`) rather than following the skeleton; `skeletonRows()` in `rigReview.ts` exists for this. Check whether the second session added fit-to-width zoom; before the redesign a 1.6 s clip filled only ~650 px of the timeline.
2. **Selecting a key should move the playhead** to that key (A5). Confirm it does.
3. **Selection shared across Rig, Test and Animate.** `RigEditor` passes `initialBoneId`, `onSelectedBone`, `onHistory`, `onMotion` to `AnimateWorkspace`; tsc passes, so the props exist, but the behaviour is unchecked.
4. **Parts stage, from the sub-agent's own report:** five viewport sizes not checked; no way to collapse the left checklist at 701–900 px; the rail's issue count was left as is; `Finish Body →` and `Review Character →` moved under Advanced, which breaks two selectors in `scripts/astra-ui-redesign/capture.mts:55-56`; `verify.mts:127` and `capture.mts:25` look for a tab named "Guided Manual" that is now "Guided".
5. **Other scripts that reference removed selectors** (`.setup-progress`, `.semantic-section-nav`, `.animation-picker select`): `scripts/ux-inspection/inspect.mts`, `scripts/astra-ui-redesign/{capture,verify,matrix,performance,proposal-replay}.mts`. `npm run ux:inspect` was already failing before this work (it waits for a "Manual" tab that no longer existed).
6. **Rig review opening automatically after Build rig** relies on the editor handoff key being present at hydration. Untested end to end.
7. **Styling pass (phase 7)** has not been judged on screen at all.

## What to do next, in order

1. Open the app and look at every stage before changing anything. Nothing since the "before" screenshots has been seen rendered.
2. Fix what that shows, then close gaps 1–3.
3. Run the owner's scripted user test in a real browser, as someone who has not seen the code: open project → find head → replace head region → find left forearm → see its bone → move the elbow pivot → rotate/test the arm → reset pose → open Walk → play → find a left-leg key → change it → undo → switch to Attack → return to Rig → identify a problem → return to Animate. Count clicks, panel switches, mode switches and ambiguous steps per task; the "before" numbers are the last table in the audit.
4. Responsive at 1920×1080, 1440×900, 1280×800, 900×800, 760×800. Accessibility: labels, focus order, keyboard, hit targets, contrast, reduced motion.
5. Full regression, including the items listed as not run above.
6. Write the evidence set and the final report the brief specifies, then give the verdict honestly.

## Running it

- App: `npm run dev` → `http://localhost:5177`.
- Project storage and agent bridge (needed to open saved projects): `npm run mcp` → `127.0.0.1:47831`.
- Both were still listening at 05:23, started by the first session; they may die with it. A third server on `:5178` serves the untouched original from a detached worktree for before/after comparison.
- Real projects are in `.rigging-studio/projects/`. `HYDRATION PROJECT A/B/C` are fixtures whose every part is the whole character image; they are fine for navigation and project switching but not for judging rig review. Use the bundled knight (fresh browser profile, no project open) and the `Final Gate …` characters for Parts. The Void Ranger rig exists only as `tests/fixtures/golden/void-ranger/`; there is no Void Ranger or Wand-or-Steel project in the projects folder, so the brief's "test with Void Ranger and WOS copies" needs the owner to say where those are, or a run of `scripts/recreate-void-ranger.mts`.
- Opening a project through the storage menu changes the bridge's active project for every browser tab.
- Playwright's bundled browsers do not match the installed version; launch with `executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` (the repo's own scripts do the same).

## Evidence so far

`.rigging-studio/diagnostics/workflow-ui-v2/2026-11-16T07-10-00Z/`

- `before/01…12-*.png` — hand-captured states at 1440×900 from the original app.
- `before/matrix/` — rig, rig-selected, animate and timeline-key at all five sizes, plus `capture-log.json`. Parts captures failed at 900 and 760 (the storage menu was not clickable at those widths) and the guided capture failed at every size.
- `after/`, `comparisons/` — empty. None of the JSON deliverables (`navigation-benchmark.json`, `interaction-results.json`, `confusion-audit.json`, `responsive.json`, `accessibility.json`, `regression-results.json`) or `report.md` exist yet.

## Things that are easy to get wrong

- **Local hooks.** The first shell command of a session, the first write to any new file, and anything that looks destructive (`git checkout --`, `rm`) are refused once with a "Fact-Forcing Gate" message. State the facts it asks for and retry the same call. For a new file it also wants to see a search for existing duplicates first.
- **Delegation policy** (`~/.agents/instructions/subagent-orchestration.md`): only `repo-middle` and `repo-grunt`, at most one of each, one writer at a time, and the primary must not write while a worker is writing. Every worker prompt starts with `STACK_TASK {"objective":"Rigging Studio UX v2 workflow redesign","writes":[…]}`.
- **Tests that read source as text.** `tests/rigging/workspace-shell.test.ts` asserts on literal strings in the UI files and CSS (class names, token values such as `--font-nav:15px`, the count of `data-dismissible-menu`, the absence of `zoom:`). Renaming a class can fail a test with no behavioural change.
- **CSS is layered by generation.** `rig-editor.css` holds several older passes with `!important`; `workstation.css` loads last. Put v2 rules under `.workflow-v2` in `workstation.css` and use new class names, not overrides of the old ones.
- **Drag means different things per stage, on purpose.** In Rig a joint drag moves the pivot only (Alt-drag moves the bone with its art, the old behaviour). In Test a drag rotates and nothing is written to the rig. Pose in Test lives in the viewport's runtime and survives only while the `rig` prop identity is unchanged.
- **Rig review does not flag bones with no art.** That check produced false positives on the known-good knight (hands, feet, head helper bones), so it was removed; the tree and inspector state it without a warning.
- Cortex memory for namespace `rigging-studio` is empty; nothing has been written to it.

## Cleanup owed

- `git worktree remove` the detached checkout at `/private/tmp/claude-501/-Users-nicholaslippa-Projects-rigging-studio/c537a086-81ea-47e5-af6b-072647bd3296/scratchpad/before-worktree` once comparisons are done, and stop the `:5178` server.
- `.playwright-mcp/` and `.fastembed_cache/` are untracked tool output; do not commit them.
- `tsconfig.tsbuildinfo` shows as modified; it is build output.
