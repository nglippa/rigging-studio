"use client";

import { useEffect, useRef, useState } from "react";
import { evaluateAnimation } from "@/src/rigging/animation/evaluate";
import { loadAnimationDefinition, loadRigDefinition } from "@/src/rigging/assets/loadDefinitions";
import { createRestPose } from "@/src/rigging/runtime/pose";
import { computeWorldTransforms } from "@/src/rigging/runtime/worldTransforms";
import type { AnimationDefinition, RigDefinition } from "@/src/rigging/schema/types";

type LoadState = { readonly kind: "loading" } | { readonly kind: "ready"; readonly rig: RigDefinition; readonly animation: AnimationDefinition } | { readonly kind: "error"; readonly message: string };

export function RigStudio() {
  const canvasHost = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rigResult = await loadRigDefinition("/rig-test/minimal-rig.json");
      if (!rigResult.success) { if (!cancelled) setState({ kind: "error", message: rigResult.message }); return; }
      const animationResult = await loadAnimationDefinition("/rig-test/idle-animation.json", rigResult.data);
      if (!animationResult.success) { if (!cancelled) setState({ kind: "error", message: animationResult.message }); return; }
      if (!cancelled) setState({ kind: "ready", rig: rigResult.data, animation: animationResult.data });
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (state.kind !== "ready" || !canvasHost.current) return;
    const host = canvasHost.current;
    let cancelled = false;
    let dispose = (): void => undefined;
    void (async () => {
      const [{ Application, Graphics }, { PixiRigRenderer }, { loadPixiTextures }] = await Promise.all([
        import("pixi.js"),
        import("@/src/rigging/rendering/PixiRigRenderer"),
        import("@/src/rigging/rendering/loadPixiTextures"),
      ]);
      if (cancelled) return;
      const app = new Application();
      await app.init({ width: state.rig.canvas.width, height: state.rig.canvas.height, backgroundAlpha: 0, antialias: true });
      if (cancelled) { app.destroy(true); return; }
      host.appendChild(app.canvas);
      const backdrop = new Graphics().roundRect(18, 18, 324, 404, 18).fill({ color: 0x101416, alpha: 0.72 }).stroke({ color: 0x2d3639, width: 1 });
      app.stage.addChild(backdrop);
      const textures = await loadPixiTextures(state.rig);
      const renderer = new PixiRigRenderer(state.rig, textures);
      app.stage.addChild(renderer.container);
      const bones = new Graphics();
      app.stage.addChild(bones);
      const restPose = createRestPose(state.rig);
      const started = performance.now();
      const draw = (): void => {
        const pose = evaluateAnimation(state.animation, restPose, (performance.now() - started) / 1000);
        renderer.update(pose);
        const world = computeWorldTransforms(state.rig, pose);
        bones.clear();
        state.rig.bones.forEach((bone) => {
          const transform = world[bone.id];
          const endX = transform.x + Math.cos(transform.rotation) * bone.length * transform.scaleX;
          const endY = transform.y + Math.sin(transform.rotation) * bone.length * transform.scaleX;
          bones.moveTo(transform.x, transform.y).lineTo(endX, endY).stroke({ color: 0xb9ff5a, width: 2, alpha: 0.8 });
          bones.circle(transform.x, transform.y, 4).fill({ color: 0xb9ff5a });
        });
      };
      app.ticker.add(draw);
      draw();
      dispose = () => {
        app.ticker.remove(draw);
        renderer.destroy();
        app.destroy(true);
      };
    })();
    return () => { cancelled = true; dispose(); };
  }, [state]);

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Rig Studio home"><span className="brand-mark">RS</span><span>Rig Studio</span></a>
        <div className="build-label"><span /> Runtime foundation · <a href="/game-pilot">Game pilot</a> · <a href="/rig-editor">Editor</a></div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Modular 2D skeletal animation</p>
          <h1>One rig.<br /><em>Every loadout.</em></h1>
          <p className="lede">A strict, JSON-first runtime for assembling character parts, evaluating bone animation, and swapping equipment without multiplying spritesheets.</p>
          <div className="proof-row">
            <div><strong>5</strong><span>animated properties</span></div>
            <div><strong>5</strong><span>easing modes</span></div>
            <div><strong>0</strong><span>source mutations</span></div>
          </div>
        </div>

        <div className="preview-panel" aria-label="Live rig runtime preview">
          <div className="preview-heading"><span>Live runtime</span><code>idle-animation.json</code></div>
          <div className="canvas-shell" ref={canvasHost}>
            {state.kind === "loading" && <p className="preview-status">Validating rig data…</p>}
            {state.kind === "error" && <p className="preview-status error">{state.message}</p>}
          </div>
          <div className="preview-footer">
            <span className={state.kind === "ready" ? "valid" : "pending"}>{state.kind === "ready" ? "Validated" : state.kind}</span>
            <span>{state.kind === "ready" ? `${state.rig.bones.length} bones · ${state.rig.slots.length} slots` : "schema + hierarchy"}</span>
          </div>
        </div>
      </section>

      <section className="architecture" aria-labelledby="architecture-title">
        <div className="section-intro"><p className="eyebrow">Clean boundaries</p><h2 id="architecture-title">Author once. Pose at runtime.</h2></div>
        <div className="flow" role="list">
          <article role="listitem"><span>01</span><h3>JSON definitions</h3><p>Versioned rigs, skins, slots, attachments, and animation tracks remain portable and serializable.</p></article>
          <article role="listitem"><span>02</span><h3>Validation</h3><p>Zod checks shape; semantic passes catch missing parents, duplicate IDs, cycles, and invalid tracks.</p></article>
          <article role="listitem"><span>03</span><h3>Runtime pose</h3><p>Animation evaluates into a separate pose, leaving source definitions untouched and reusable.</p></article>
          <article role="listitem"><span>04</span><h3>Pixi rendering</h3><p>Slots resolve a skin or equipment override, then bind visual attachments to computed bone transforms.</p></article>
        </div>
      </section>

      <footer><span>Runtime · editor · controlled game pilot</span><span>No IK, meshes, physics, mass migration, or cloud state.</span></footer>
    </main>
  );
}
