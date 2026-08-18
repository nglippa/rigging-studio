"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import type { Application } from "pixi.js";
import { AnimationPlayer } from "@/src/rigging/animation/AnimationPlayer";
import { loadAnimationDefinition, loadRigDefinition } from "@/src/rigging/assets/loadDefinitions";
import { RigRuntime } from "@/src/rigging/runtime/RigRuntime";
import type { AnimationDefinition, RigDefinition } from "@/src/rigging/schema/types";
import type { RigRenderer } from "@/src/rigging/rendering/RigRenderer";

const ANIMATION_FILES = [
  { id: "idle", label: "Idle", path: "/rig-test/idle-animation.json" },
  { id: "walk", label: "Walk", path: "/rig-test/animations/walk.json" },
  { id: "attack", label: "Attack", path: "/rig-test/animations/attack.json" },
] as const;

type LoadedData = {
  readonly rig: RigDefinition;
  readonly animations: Readonly<Record<string, AnimationDefinition>>;
};
type LabEngine = {
  readonly runtime: RigRuntime;
  readonly player: AnimationPlayer;
  readonly renderer: RigRenderer;
  readonly animations: Readonly<Record<string, AnimationDefinition>>;
};

export function RigLab() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLOutputElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<LabEngine | null>(null);
  const [loaded, setLoaded] = useState<LoadedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [animationId, setAnimationId] = useState("idle");
  const [speed, setSpeed] = useState(1);
  const [showBones, setShowBones] = useState(false);
  const [showBounds, setShowBounds] = useState(false);
  const [sword, setSword] = useState("sword-a");
  const [shield, setShield] = useState(true);
  const [helmet, setHelmet] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rigResult = await loadRigDefinition("/rig-test/minimal-rig.json");
      if (!rigResult.success) {
        if (!cancelled) setError(rigResult.message);
        return;
      }
      const results = await Promise.all(ANIMATION_FILES.map(async ({ id, path }) => ({
        id,
        result: await loadAnimationDefinition(path, rigResult.data),
      })));
      const failed = results.find(({ result }) => !result.success);
      if (failed && !failed.result.success) {
        if (!cancelled) setError(failed.result.message);
        return;
      }
      const animations = Object.fromEntries(results.map(({ id, result }) => {
        if (!result.success) throw new Error(result.message);
        return [id, result.data];
      }));
      if (!cancelled) setLoaded({ rig: rigResult.data, animations });
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!loaded || !viewportRef.current) return;
    const viewport = viewportRef.current;
    let cancelled = false;
    let app: Application | undefined;
    let renderer: RigRenderer | undefined;
    let tick: ((ticker: { readonly deltaMS: number }) => void) | undefined;

    void (async () => {
      try {
        const [{ Application, Graphics }, { RigRenderer: Renderer }] = await Promise.all([
          import("pixi.js"),
          import("@/src/rigging/rendering/RigRenderer"),
        ]);
        if (cancelled) return;
        const pixi = new Application();
        await pixi.init({
          width: loaded.rig.canvas.width,
          height: loaded.rig.canvas.height,
          backgroundColor: 0x111515,
          antialias: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          autoDensity: true,
        });
        app = pixi;
        if (cancelled) { pixi.destroy(true); return; }
        viewport.appendChild(pixi.canvas);

        const grid = new Graphics();
        for (let x = 0; x <= loaded.rig.canvas.width; x += 32) grid.moveTo(x, 0).lineTo(x, loaded.rig.canvas.height);
        for (let y = 0; y <= loaded.rig.canvas.height; y += 32) grid.moveTo(0, y).lineTo(loaded.rig.canvas.width, y);
        grid.stroke({ color: 0x5f6b67, width: 1, alpha: 0.13 });
        pixi.stage.addChild(grid);

        const runtime = new RigRuntime(loaded.rig);
        renderer = await Renderer.create(runtime, {
          onWarning: (message) => setWarnings((current) => current.includes(message) ? current : [...current, message]),
        });
        if (cancelled) { renderer.destroy(); pixi.destroy(true); return; }
        pixi.stage.addChild(renderer.container);
        renderer.setBoneHandlesVisible(false);
        renderer.setSlotBoundsVisible(false);

        const player = new AnimationPlayer(runtime);
        const initialAnimation = loaded.animations.idle;
        if (!initialAnimation) throw new Error("Idle animation did not load");
        player.play(initialAnimation);
        player.setPlaybackSpeed(1);
        let priorPlaying = true;
        tick = (ticker): void => {
          player.update(ticker.deltaMS / 1000);
          renderer?.update();
          if (timeRef.current) timeRef.current.textContent = `${player.currentTime.toFixed(2)} / ${player.duration.toFixed(2)}s`;
          if (seekRef.current) {
            seekRef.current.max = String(player.duration);
            seekRef.current.value = String(player.currentTime);
          }
          if (priorPlaying !== player.isPlaying) {
            priorPlaying = player.isPlaying;
            setPlaying(player.isPlaying);
          }
        };
        pixi.ticker.add(tick);
        renderer.update();
        engineRef.current = { runtime, player, renderer, animations: loaded.animations };
        setReady(true);
      } catch (reason: unknown) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Rig Lab failed to initialize");
      }
    })();

    return () => {
      cancelled = true;
      setReady(false);
      engineRef.current = null;
      if (app && tick) app.ticker.remove(tick);
      renderer?.destroy();
      app?.destroy(true);
    };
  }, [loaded]);

  const togglePlayback = (): void => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.player.isPlaying) engine.player.pause();
    else {
      const animation = engine.animations[animationId];
      if (animation) engine.player.play(animation, false);
    }
    setPlaying(engine.player.isPlaying);
  };

  const restart = (): void => {
    const player = engineRef.current?.player;
    if (!player) return;
    player.restart();
    setPlaying(true);
  };

  const chooseAnimation = (event: ChangeEvent<HTMLSelectElement>): void => {
    const id = event.target.value;
    setAnimationId(id);
    const engine = engineRef.current;
    const animation = engine?.animations[id];
    if (!engine || !animation) return;
    engine.player.play(animation);
    setPlaying(true);
  };

  const changeSpeed = (event: ChangeEvent<HTMLInputElement>): void => {
    const next = Number(event.target.value);
    setSpeed(next);
    engineRef.current?.player.setPlaybackSpeed(next);
  };

  const seek = (event: ChangeEvent<HTMLInputElement>): void => {
    engineRef.current?.player.seek(Number(event.target.value));
    engineRef.current?.renderer.update();
  };

  const toggleBones = (event: ChangeEvent<HTMLInputElement>): void => {
    setShowBones(event.target.checked);
    engineRef.current?.renderer.setBoneHandlesVisible(event.target.checked);
  };

  const toggleBounds = (event: ChangeEvent<HTMLInputElement>): void => {
    setShowBounds(event.target.checked);
    engineRef.current?.renderer.setSlotBoundsVisible(event.target.checked);
  };

  const changeSword = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value;
    setSword(next);
    engineRef.current?.runtime.replaceSlotAttachment("weapon-slot", next);
    engineRef.current?.renderer.update();
  };

  const toggleShield = (event: ChangeEvent<HTMLInputElement>): void => {
    setShield(event.target.checked);
    engineRef.current?.runtime.replaceSlotAttachment("shield-slot", event.target.checked ? "shield" : null);
    engineRef.current?.renderer.update();
  };

  const toggleHelmet = (event: ChangeEvent<HTMLInputElement>): void => {
    setHelmet(event.target.checked);
    engineRef.current?.runtime.replaceSlotAttachment("helmet-slot", event.target.checked ? "helmet" : null);
    engineRef.current?.renderer.update();
  };

  return (
    <main className="riglab-page">
      <header className="riglab-header">
        <Link href="/" className="riglab-brand"><span>RS</span> Rig Studio</Link>
        <div className="riglab-header-copy"><small>Development runtime</small><strong>Rig Lab</strong></div>
        <div className={`riglab-status ${ready ? "is-ready" : ""}`}><i />{error ? "Runtime error" : ready ? "Runtime ready" : "Loading rig"}</div>
      </header>

      <div className="riglab-workspace">
        <aside className="riglab-controls" aria-label="Animation and equipment controls">
          <section>
            <h2>Playback</h2>
            <label>Animation<select value={animationId} onChange={chooseAnimation} disabled={!ready}>{ANIMATION_FILES.map((animation) => <option key={animation.id} value={animation.id}>{animation.label}</option>)}</select></label>
            <div className="riglab-button-row"><button type="button" onClick={togglePlayback} disabled={!ready}>{playing ? "Pause" : "Play"}</button><button type="button" className="secondary" onClick={restart} disabled={!ready}>Restart</button></div>
            <label>Timeline<input ref={seekRef} type="range" min="0" max="1" step="0.001" defaultValue="0" onChange={seek} disabled={!ready} /></label>
            <div className="riglab-time"><span>Current time</span><output ref={timeRef}>0.00 / 0.00s</output></div>
            <label>Playback speed <strong>{speed.toFixed(2)}×</strong><input type="range" min="0.25" max="2" step="0.25" value={speed} onChange={changeSpeed} disabled={!ready} /></label>
          </section>

          <section>
            <h2>Debug view</h2>
            <label className="riglab-check"><input type="checkbox" checked={showBones} onChange={toggleBones} disabled={!ready} /><span>Bone handles</span></label>
            <label className="riglab-check"><input type="checkbox" checked={showBounds} onChange={toggleBounds} disabled={!ready} /><span>Slot bounds</span></label>
          </section>

          <section>
            <h2>Equipment</h2>
            <label>Sword<select value={sword} onChange={changeSword} disabled={!ready}><option value="sword-a">Sword A · Steel</option><option value="sword-b">Sword B · Arcane</option></select></label>
            <label className="riglab-check"><input type="checkbox" checked={shield} onChange={toggleShield} disabled={!ready} /><span>Show shield</span></label>
            <label className="riglab-check"><input type="checkbox" checked={helmet} onChange={toggleHelmet} disabled={!ready} /><span>Show helmet</span></label>
          </section>
        </aside>

        <section className="riglab-stage" aria-label="PixiJS rig viewport">
          <div className="riglab-stage-label"><span>Viewport · 560 × 600</span><code>rotation: degrees → radians</code></div>
          <div ref={viewportRef} className="riglab-viewport">
            {!ready && !error && <div className="riglab-loading">Loading and validating multipart rig…</div>}
          </div>
          <div className="riglab-stage-footer"><span>15 bones</span><span>17 slots</span><span>18 attachments</span></div>
        </section>

        <aside className="riglab-inspector">
          <section><h2>Runtime contract</h2><dl><div><dt>Schema</dt><dd>v1</dd></div><div><dt>Pose state</dt><dd>Mutable copy</dd></div><div><dt>Source JSON</dt><dd>Readonly</dd></div><div><dt>Renderer</dt><dd>PixiJS 8</dd></div></dl></section>
          <section><h2>Active rig</h2><p>Multipart knight assembled from separate transparent PNG attachments. Equipment overrides stay outside the animation pose.</p></section>
          {(error || warnings.length > 0) && <section className="riglab-errors" aria-live="polite"><h2>Runtime messages</h2>{error && <p>{error}</p>}{warnings.map((warning) => <p key={warning}>{warning}</p>)}</section>}
        </aside>
      </div>
    </main>
  );
}
