# Rig Studio localhost UX inspection

This Playwright harness collects rendered evidence from the live Rig Studio app. It does not score, rank, or redesign the interface.

## Run

```sh
npm run ux:inspect
```

The runner discovers a reachable localhost port and verifies the page identifies itself as Rig Studio. Override discovery when needed:

```sh
npm run ux:inspect -- --url http://localhost:3001
```

Useful bounded-run options:

```sh
npm run ux:inspect -- --states setup-no-selection,animate-timeline --viewports 1440x900
npm run ux:inspect -- --headed
```

Each run is created at `.rigging-studio/diagnostics/ux-inspection/<ISO timestamp>/`. Existing run directories are never overwritten. Prepare scenarios use the bundled `public/rig-test/body-base.png` inside fresh browser contexts; they do not modify golden or durable projects.

Artifacts include:

- `report.md` — concise factual human-review packet
- `summary.json` — stable, machine-readable schema
- `screenshots/` — full-window state captures and representative open surfaces
- `screenshots/crops/` — rails, panels, toolbars, timeline, palette, and popover crops
- `screenshots/interactions/` — before, hover, pressed, and reduced-motion evidence
- `dom/` — visible text and interactive-element summaries
- `styles/` — typography, buttons, panels, spacing, overflow, overlap, canvas, bottom-rail, and accessibility measurements
- `console/` and `network/` — exact runtime messages and redacted failed-request URLs
- `interactions/` — hover/press/active deltas, motion timings, keyboard sequence, and reduced-motion checks

The default state matrix covers Guided, Manual, Assist, selected region, lasso, review, Ollama status, Setup selection/pivot/equipment, and Animate timeline/animation/keyframe/playback at 1920×1080, 1440×900, 1280×800, 900×800, and 760×800.

## Compare

```sh
npm run ux:compare -- <before-run-directory-or-id> <after-run-directory-or-id>
```

Comparison mode writes Markdown and JSON artifacts under the later run's `comparisons/` directory. It reports deltas in font-size counts, button dimensions, canvas visible area, bottom occupied depth, primary-candidate counts, overflow, console errors, and panel sizes. It does not declare a winner.

