import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("stage-driven workspace shell", () => {
  it("hands a disk project to the workspace mode encoded by its snapshot", () => {
    expect(source("../../app/studio-ui/ProjectStorageMenu.tsx")).toContain("rig-studio:durable-project-opened");
    expect(source("../../app/rig-editor/RigEditor.tsx")).toContain("setEditorMode(mode)");
    expect(source("../../app/rig-editor/AnimateWorkspace.tsx")).toContain("Disk animations restored");
  });

  it("puts every page in one frame whose step bar is the single progress path", () => {
    const shell = source("../../app/studio-ui/StepShell.tsx");
    expect(shell).toContain("STEPS.map");
    expect(shell).toContain('aria-current={current ? "step" : undefined}');
    for (const page of ["../../app/create-character/CreateCharacterWorkspace.tsx", "../../app/part-cutter/PartCutterWorkspace.tsx", "../../app/rig-editor/RigEditor.tsx"]) {
      expect(source(page)).toContain("<StepShell");
      expect(source(page)).not.toContain("TopCommandRail");
      expect(source(page)).not.toContain("StudioModeNav");
    }
  });

  it("shows the real skeleton and its parts, with the raw document behind Advanced structure", () => {
    const tree = source("../../app/rig-editor/SkeletonTree.tsx");
    const rigEditor = source("../../app/rig-editor/RigEditor.tsx");
    expect(tree).toContain('["skeleton", "parts"]');
    expect(tree).toContain("skeletonRows(props.rig)");
    expect(tree).toContain("Controlled by");
    expect(rigEditor).toContain("Advanced structure");
    expect(rigEditor).toContain("<EditorHierarchy");
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
    expect(prepare).toContain("<StepShell");
    expect(prepare).not.toContain("prepare-action-rail");
    expect(prepare).not.toContain('className="prepare-stage-progress"');
    expect(prepare).not.toContain('className="part-cutter-status"');
  });

  it("persists the user-controlled workspace layout", () => {
    const rigEditor = source("../../app/rig-editor/RigEditor.tsx");
    for (const preference of ["leftCollapsed", "rightCollapsed", "focusMode", "structureView", "leftPanelWidth", "rightPanelWidth"]) expect(rigEditor).toContain(preference);
  });

  it("mirrors the canvas selection in the tree and links each part to its bone", () => {
    const tree = source("../../app/rig-editor/SkeletonTree.tsx");
    expect(tree).toContain("selectedBoneId === bone.id");
    expect(tree).toContain("is-linked");
    expect(tree).toContain("is-broken");
    expect(tree).toContain("has-problem");
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

  it("replaces the Setup stepper with rig review and gives Test its own strip, each with one next action", () => {
    const rigEditor = source("../../app/rig-editor/RigEditor.tsx");
    const review = source("../../app/rig-editor/RigReviewStrip.tsx");
    const test = source("../../app/rig-editor/TestPoseStrip.tsx");
    expect(rigEditor).not.toContain("setup-workflow-rail");
    expect(rigEditor).toContain("<RigReviewStrip");
    expect(rigEditor).toContain("<TestPoseStrip");
    expect(review).toContain("Rotate test");
    expect(review).toContain("stage-next-action");
    expect(test).toContain("Reset pose");
    expect(test).toContain("Fix in Rig");
    expect(test).toContain("stage-next-action");
  });

  it("keeps Test and Rotate to test from editing the rig", () => {
    const rigEditor = source("../../app/rig-editor/RigEditor.tsx");
    // Posing covers the old Test view and the expanded view's Rotate to test tool.
    expect(rigEditor).toContain('const posing = testing || (rigExpanded && !rigAdvanced && rigTool === "rotate");');
    expect(rigEditor).toContain("poseMode={posing}");
    expect(rigEditor).toContain("pivotEdit={!posing}");
    expect(rigEditor).toContain("onBoneDragCommit={posing ? () => { setPosed(true); markTested(); } : commitBoneDrag}");
  });

  it("gives Animate one clip chooser, one undo, and a full transport", () => {
    const animate = source("../../app/rig-editor/AnimateWorkspace.tsx");
    const rigEditor = source("../../app/rig-editor/RigEditor.tsx");
    expect(animate).not.toContain("animation-picker");
    expect(animate).not.toContain("Animated body");
    expect(animate).not.toContain("inspector-mode-tabs");
    expect(animate).not.toContain('aria-label="Undo animation change"');
    for (const control of ["First frame", "Previous keyframe", "Next keyframe", "Last frame", 'aria-label="Loop"', "Generate…", "Timeline ⋯"]) expect(animate).toContain(control);
    expect(animate).toContain('action === "undo"');
    expect(rigEditor).toContain('animationCommand("undo")');
    expect(rigEditor).toContain("initialBoneId={selectedBoneId}");
  });

  it("makes active canvas tools affect viewport behavior", () => {
    const viewport = source("../../app/rig-editor/EditorViewport.tsx");
    expect(viewport).toContain('props.canvasTool === "pan"');
    expect(viewport).toContain("mode: \"pan\"");
    expect(viewport).toContain("viewport-semantic-hint");
  });

  it("preserves focus layout and reduced-motion affordances", () => {
    const css = source("../../app/rig-editor/rig-editor.css");
    expect(source("../../app/studio-ui/workstation.css")).toContain(".is-focus-mode .stage-strip");
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
    const shell = source("../../app/studio-ui/StepShell.tsx");
    const canvas = source("../../app/rig-editor/CanvasControls.tsx");
    const animate = source("../../app/rig-editor/AnimateWorkspace.tsx");
    expect(behavior).toContain('document.addEventListener("pointerdown"');
    expect(behavior).toContain('document.addEventListener("toggle"');
    expect(behavior).toContain('document.addEventListener("click"');
    expect(behavior).toContain('event.key !== "Escape"');
    expect(behavior).toContain("!menu.contains(target)");
    expect(behavior).toContain("other !== menu");
    // Every step's frame installs the behaviour, and the project menu closes on click-away.
    expect(shell).toContain("useDismissibleMenus();");
    expect(source("../../app/studio-ui/ProjectStorageMenu.tsx").match(/data-dismissible-menu/g)).toHaveLength(1);
    expect(canvas.match(/data-dismissible-menu/g)).toHaveLength(2);
    expect(animate.match(/data-dismissible-menu/g)).toHaveLength(3);
  });
});
