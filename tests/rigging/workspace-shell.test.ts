import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("stage-driven workspace shell", () => {
  it("hands a disk project to the workspace mode encoded by its snapshot", () => {
    expect(source("../../app/studio-ui/ProjectStorageMenu.tsx")).toContain("rig-studio:durable-project-opened");
    expect(source("../../app/rig-editor/RigEditor.tsx")).toContain("setEditorMode(mode)");
    expect(source("../../app/rig-editor/AnimateWorkspace.tsx")).toContain("Disk animations restored");
  });

  it("keeps Prepare, Setup, and Animate as the single global progress path", () => {
    const nav = source("../../app/studio-ui/StudioModeNav.tsx");
    const rail = source("../../app/studio-ui/TopCommandRail.tsx");
    expect(nav).toContain('["prepare", "setup", "animate"]');
    expect(nav).toContain("is-complete");
    expect(rail).toContain("studio-command-rail");
    expect(rail).toContain("connection-cluster");
    expect(rail).toContain("Search commands (⌘K)");
  });

  it("uses semantic Setup navigation with the technical tree behind disclosure", () => {
    const navigator = source("../../app/rig-editor/SemanticNavigator.tsx");
    expect(navigator).toContain('["character", "body", "equipment", "layers"]');
    expect(navigator).toContain("Advanced structure");
    expect(navigator).toContain("<EditorHierarchy");
  });

  it("groups persistent canvas toggles into View and Snap popovers", () => {
    const controls = source("../../app/rig-editor/CanvasControls.tsx");
    expect(controls).toContain('className="canvas-popover" data-dismissible-menu><summary>View');
    expect(controls).toContain('className="canvas-popover" data-dismissible-menu><summary>Snap');
    expect(controls).toContain("Pixel snap");
    expect(controls).toContain("Angle snap · 15°");
  });

  it("removes the overloaded status footer and keeps contextual surfaces by stage", () => {
    const rigEditor = source("../../app/rig-editor/RigEditor.tsx");
    const animate = source("../../app/rig-editor/AnimateWorkspace.tsx");
    const prepare = source("../../app/part-cutter/PartCutterWorkspace.tsx");
    expect(rigEditor).not.toContain('className="editor-statusbar"');
    expect(rigEditor).toContain("context-rail-empty");
    expect(rigEditor).toContain("StudioUtilityDrawer");
    expect(animate).toContain("DopeSheet");
    expect(animate).toContain("rigging-studio-timeline-height");
    expect(prepare).toContain("prepare-action-rail");
    expect(prepare).not.toContain('className="prepare-stage-progress"');
    expect(prepare).not.toContain('className="part-cutter-status"');
  });

  it("persists the user-controlled workspace layout", () => {
    const rigEditor = source("../../app/rig-editor/RigEditor.tsx");
    for (const preference of ["leftCollapsed", "rightCollapsed", "focusMode", "semanticSection", "leftPanelWidth", "rightPanelWidth"]) expect(rigEditor).toContain(preference);
  });

  it("keeps semantic body groups collapsible, remembered, and selection-aware", () => {
    const navigator = source("../../app/rig-editor/SemanticNavigator.tsx");
    expect(navigator).toContain("rigging-studio-semantic-groups-v1");
    expect(navigator).toContain('aria-expanded={open}');
    expect(navigator).toContain("toggleGroup(group.id)");
    expect(navigator).toContain("selectedBoneId");
    expect(navigator).toContain("...keys");
  });

  it("renders a primary bone with parent and child chain context", () => {
    const viewport = source("../../app/rig-editor/EditorViewport.tsx");
    const selection = source("../../app/rig-editor/viewportSelection.ts");
    expect(viewport).toContain("selectionChainForBone");
    expect(selection).toContain("parentId");
    expect(selection).toContain("childIds");
    expect(viewport).toContain("chain?.relatedIds.has(slot.boneId)");
    expect(viewport).toContain("0xa77bff");
  });

  it("uses a narrow illuminated context edge instead of an empty inspector rail", () => {
    const css = source("../../app/rig-editor/rig-editor.css");
    expect(css).toContain("minmax(320px,1fr) 20px");
    expect(css).toContain(".editor-right-panel.is-context-idle");
    expect(css).toContain("inset 1px 0 rgba(84,232,255,.55)");
  });

  it("consolidates connection details into one systems cluster", () => {
    const rail = source("../../app/studio-ui/TopCommandRail.tsx");
    expect(rail).toContain('className="connection-cluster"');
    expect(rail).toContain("Systems");
    expect(rail).toContain("systems-popover");
    expect(rail).toContain("Open diagnostics");
  });

  it("models Setup as a meaningful four-state subflow with an integrated next action", () => {
    const rigEditor = source("../../app/rig-editor/RigEditor.tsx");
    for (const step of ['"body"', '"pivots"', '"equipment"', '"validate"']) expect(rigEditor).toContain(step);
    expect(rigEditor).toContain("setup-workflow-rail");
    expect(rigEditor).toContain('data-state={state}');
    expect(rigEditor).toContain("Setup valid");
    expect(rigEditor).toContain("Ready for animation");
    expect(rigEditor).toContain("Enter Animate");
  });

  it("makes active canvas tools affect viewport behavior", () => {
    const viewport = source("../../app/rig-editor/EditorViewport.tsx");
    expect(viewport).toContain('props.canvasTool === "pan"');
    expect(viewport).toContain("mode: \"pan\"");
    expect(viewport).toContain("viewport-semantic-hint");
  });

  it("preserves focus layout and reduced-motion affordances", () => {
    const css = source("../../app/rig-editor/rig-editor.css");
    expect(css).toContain(".is-focus-mode .setup-workflow-rail");
    expect(css).toContain("@media (prefers-reduced-motion:reduce)");
    expect(css).toContain("transition:none!important");
  });

  it("uses one readable typography and control scale across every stage", () => {
    const setupCss = source("../../app/rig-editor/rig-editor.css");
    const prepareCss = source("../../app/part-cutter/part-cutter.css");
    for (const css of [setupCss, prepareCss]) {
      expect(css).toContain("--font-micro:12px");
      expect(css).toContain("--font-caption:13px");
      expect(css).toContain("--font-ui:14px");
      expect(css).toContain("--font-nav:15px");
      expect(css).toContain("--font-section:17px");
      expect(css).toContain("--font-stage:16px");
      expect(css).toContain("--font-brand:18px");
      expect(css).toContain("--control-md:40px");
      expect(css).toContain("--row-standard:44px");
    }
    expect(setupCss).toContain("font-size:var(--font-nav)");
    expect(prepareCss).toContain("font-size:var(--font-nav)");
    expect(setupCss).not.toContain("zoom:");
    expect(prepareCss).not.toContain("zoom:");
  });

  it("centralizes restrained motion and exposes real busy states", () => {
    const globals = source("../../app/globals.css");
    const prepare = source("../../app/part-cutter/PartCutterWorkspace.tsx");
    const animate = source("../../app/rig-editor/AIAnimationPanel.tsx");
    expect(globals).toContain("--motion-fast:100ms");
    expect(globals).toContain("--motion-normal:160ms");
    expect(globals).toContain("--motion-panel:200ms");
    expect(globals).toContain("button[aria-busy=\"true\"]");
    expect(globals).toContain("@media (prefers-reduced-motion:reduce)");
    expect(prepare.match(/aria-busy=/g)?.length).toBeGreaterThanOrEqual(2);
    expect(animate).toContain("aria-busy={loading}");
  });

  it("dismisses transient menus on click-away, replacement, and Escape", () => {
    const behavior = source("../../app/studio-ui/useDismissibleMenus.ts");
    const rail = source("../../app/studio-ui/TopCommandRail.tsx");
    const canvas = source("../../app/rig-editor/CanvasControls.tsx");
    const animate = source("../../app/rig-editor/AnimateWorkspace.tsx");
    expect(behavior).toContain('document.addEventListener("pointerdown"');
    expect(behavior).toContain('document.addEventListener("toggle"');
    expect(behavior).toContain('document.addEventListener("click"');
    expect(behavior).toContain('event.key !== "Escape"');
    expect(behavior).toContain("!menu.contains(target)");
    expect(behavior).toContain("other !== menu");
    expect(rail.match(/data-dismissible-menu/g)).toHaveLength(2);
    expect(canvas.match(/data-dismissible-menu/g)).toHaveLength(2);
    expect(animate.match(/data-dismissible-menu/g)).toHaveLength(2);
  });
});
