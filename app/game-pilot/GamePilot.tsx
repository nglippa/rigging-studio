"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Application, Container } from "pixi.js";
import { BrowserCharacterAppearanceStore, CharacterAssetCache, CharacterVisualController, parseCharacterAppearanceJson, type CharacterAppearanceDefinition, type EquipmentSlot } from "@/src/game/character-visuals";

type PilotEngine = { readonly app: Application; readonly world: Container; readonly hero: CharacterVisualController; readonly characters: readonly CharacterVisualController[]; readonly cache: CharacterAssetCache; heroX: number; movement: -1 | 0 | 1; currentAction: string };
type Profile = { readonly averageMs: number; readonly p95Ms: number; readonly samples: number };
const ACTIONS = ["idle", "walk", "run", "basicAttack", "hurt", "death"] as const;
const isDevelopment = process.env.NODE_ENV !== "production";

export function GamePilot() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PilotEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState("loading");
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const [assetCount, setAssetCount] = useState(0);
  const [loadedAssets, setLoadedAssets] = useState<readonly string[]>([]);
  const [cacheStats, setCacheStats] = useState({ rigDefinitions: 0, animationDefinitions: 0, texturePaths: 0 });
  const [profile, setProfile] = useState<Profile>({ averageMs: 0, p95Ms: 0, samples: 0 });
  const [action, setAction] = useState("idle");
  const [head, setHead] = useState<string | null>("iron-helm");
  const [torso, setTorso] = useState<string | null>("scout-tunic");
  const [mainHand, setMainHand] = useState<string | null>("steel-sword");
  const [offHand, setOffHand] = useState<string | null>("kite-shield");
  const [showBones, setShowBones] = useState(false);
  const [showBounds, setShowBounds] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [lastComplete, setLastComplete] = useState("—");

  useEffect(() => {
    const viewport = viewportRef.current; if (!viewport) return;
    let cancelled = false; let tick: ((ticker: { readonly deltaMS: number }) => void) | null = null; let profileTimer = 0;
    const samples: number[] = []; const pressed = new Set<string>();
    const keyDown = (event: KeyboardEvent): void => { if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") pressed.add("left"); if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") pressed.add("right"); };
    const keyUp = (event: KeyboardEvent): void => { if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") pressed.delete("left"); if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") pressed.delete("right"); };
    window.addEventListener("keydown", keyDown); window.addEventListener("keyup", keyUp);

    void (async () => {
      let app: Application | null = null; let cache: CharacterAssetCache | null = null; const characters: CharacterVisualController[] = [];
      try {
        const [pixi, appearanceResponse] = await Promise.all([import("pixi.js"), fetch("/game/characters/lab-knight.appearance.json")]);
        if (!appearanceResponse.ok) throw new Error(`Appearance definition failed with HTTP ${appearanceResponse.status}`);
        const appearance = parseCharacterAppearanceJson(await appearanceResponse.text());
        if (cancelled) return;
        app = new pixi.Application(); await app.init({ width: 1120, height: 640, backgroundColor: 0x111719, antialias: false, resolution: 1, autoDensity: false });
        if (cancelled) { app.destroy(true); return; }
        viewport.appendChild(app.canvas); const world = new pixi.Container(); world.sortableChildren = true; app.stage.addChild(world);
        world.addChild(new pixi.Graphics().rect(0, 0, 1120, 640).fill({ color: 0x111719 }).rect(0, 505, 1120, 135).fill({ color: 0x172326 }).moveTo(0, 505).lineTo(1120, 505).stroke({ color: 0x52686d, width: 1, alpha: .7 }));
        cache = new CharacterAssetCache();
        const addController = async (definition: CharacterAppearanceDefinition, x: number, y: number, layer: number, initialAction: string): Promise<CharacterVisualController> => {
          const controller = new CharacterVisualController(definition, { cache: cache!, onWarning: (warning) => setWarnings((current) => current.includes(warning.message) ? current : [...current, warning.message]) });
          await controller.load(); controller.setPosition(x, y); controller.setLayer(layer); controller.playAnimation(initialAction); characters.push(controller); world.addChild(controller.container); return controller;
        };
        const hero = await addController(appearance, 560, 520, 100, "idle");
        const saved = new BrowserCharacterAppearanceStore(window.localStorage).load(appearance.characterId);
        if (saved) { hero.restoreAppearance(saved); setHead(saved.equipment.head ?? null); setTorso(saved.equipment.torso ?? null); setMainHand(saved.equipment.mainHand ?? null); setOffHand(saved.equipment.offHand ?? null); }
        hero.onAnimationComplete((event) => { setLastComplete(`${event.action} → ${event.clipId}`); if (event.action !== "death") { hero.playAnimation("idle"); setAction("idle"); } });
        const crowdAppearance = { ...appearance, scale: .22, snapToPixels: true, shadow: { ...appearance.shadow, radiusX: 18, radiusY: 6, alpha: .16 } };
        await Promise.all(Array.from({ length: 24 }, async (_, index) => {
          const column = index % 8; const row = Math.floor(index / 8); const controller = await addController({ ...crowdAppearance, characterId: `lab-knight-crowd-${index + 1}` }, 115 + column * 126, 205 + row * 105, row, index % 3 === 0 ? "walk" : "idle");
          controller.setFacing(index % 2 ? "left" : "right"); if (index % 4 === 0) controller.setEquipment("mainHand", "arcane-sword"); if (index % 5 === 0) controller.setEquipment("head", "bronze-helm");
        }));
        if (cancelled) { characters.forEach((character) => character.destroy()); await cache.destroy(); app.destroy(true); return; }
        const engine: PilotEngine = { app, world, hero, characters, cache, heroX: 560, movement: 0, currentAction: "idle" }; engineRef.current = engine;
        tick = (ticker): void => {
          const start = performance.now(); const delta = Math.min(.05, ticker.deltaMS / 1000);
          const movement: -1 | 0 | 1 = pressed.has("left") === pressed.has("right") ? 0 : pressed.has("left") ? -1 : 1;
          if (movement !== engine.movement) { engine.movement = movement; if (movement) { hero.setFacing(movement < 0 ? "left" : "right"); hero.playAnimation("walk"); engine.currentAction = "walk"; } else if (engine.currentAction === "walk") { hero.playAnimation("idle"); engine.currentAction = "idle"; } }
          if (movement) { engine.heroX = Math.max(55, Math.min(1065, engine.heroX + movement * 145 * delta)); hero.setPosition(engine.heroX, 520); }
          characters.forEach((character) => character.update(delta)); samples.push(performance.now() - start); if (samples.length > 600) samples.splice(0, samples.length - 600);
        };
        app.ticker.add(tick); setBackend(hero.currentBackend); setAssetCount(hero.getLoadedAssets().length); setLoadedAssets(hero.getLoadedAssets()); setCacheStats(cache.getStats()); setReady(true);
        profileTimer = window.setInterval(() => { if (!samples.length) return; const sorted = [...samples].sort((a, b) => a - b); setProfile({ averageMs: samples.reduce((sum, value) => sum + value, 0) / samples.length, p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], samples: samples.length }); }, 600);
      } catch (reason: unknown) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Character runtime failed to initialize");
        characters.forEach((character) => character.destroy()); if (cache) await cache.destroy(); app?.destroy(true);
      }
    })();
    return () => {
      cancelled = true; window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); window.clearInterval(profileTimer);
      const engine = engineRef.current; engineRef.current = null; if (engine) { if (tick) engine.app.ticker.remove(tick); engine.characters.forEach((character) => character.destroy()); void engine.cache.destroy(); engine.app.destroy(true); }
    };
  }, []);

  const changeEquipment = (slot: EquipmentSlot, value: string | null, update: (next: string | null) => void): void => {
    const hero = engineRef.current?.hero; if (!hero) return; hero.setEquipment(slot, value); update(value); new BrowserCharacterAppearanceStore(window.localStorage).save(hero.getAppearanceSave());
  };
  const play = (next: string): void => { const engine = engineRef.current; if (!engine) return; engine.hero.playAnimation(next); engine.currentAction = next; setAction(next); };
  const setDebug = (bones: boolean, bounds: boolean): void => { engineRef.current?.hero.setDebugDisplay(bones, bounds); };

  return <main className="game-pilot-page">
    <header className="game-pilot-header"><Link href="/">RS · Rig Studio</Link><div><small>Character runtime inspector</small><strong>Full modular access</strong></div><span className={ready ? "ready" : ""}>{error ? "ERROR" : ready ? "25 VISUALS ACTIVE" : "LOADING"}</span></header>
    <div className="game-pilot-layout">
      <section className="game-stage"><div className="game-stage-label"><span>Game-facing Pixi scene · Arrow keys / A D to move</span><code>horizontal flip · whole-pixel root</code></div><div ref={viewportRef} className="game-canvas-host">{!ready && <p>{error ?? "Loading shared rig, animations, and textures…"}</p>}</div><footer><span>Camera zoom {zoom.toFixed(2)}×</span><span>25 modular instances</span><span>{profile.averageMs.toFixed(2)}ms avg · {profile.p95Ms.toFixed(2)}ms p95 update</span></footer></section>
      <aside className="game-inspector">
        <header><span>DEV VISUAL INSPECTOR</span><strong>{backend}</strong></header>
        {!isDevelopment ? <p className="production-inspector-note">Inspector controls are disabled in production builds.</p> : <>
          <section><h2>Animation</h2><label>Action<select data-testid="pilot-action" value={action} disabled={!ready} onChange={(event) => play(event.target.value)}>{ACTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>Playback speed<input type="range" min="0.25" max="2" step="0.25" defaultValue="1" onChange={(event) => engineRef.current?.hero.setPlaybackSpeed(Number(event.target.value))} /></label><p>Complete: {lastComplete}</p></section>
          <section><h2>Appearance</h2><label>Skin<select defaultValue="default" onChange={(event) => engineRef.current?.hero.setSkin(event.target.value)}><option value="default">default</option></select></label><SelectEquipment label="Head" value={head} values={[null, "iron-helm", "bronze-helm"]} onChange={(value) => changeEquipment("head", value, setHead)} /><SelectEquipment label="Torso" value={torso} values={["scout-tunic", "royal-tunic"]} onChange={(value) => changeEquipment("torso", value, setTorso)} /><SelectEquipment label="Main hand" value={mainHand} values={[null, "steel-sword", "arcane-sword"]} onChange={(value) => changeEquipment("mainHand", value, setMainHand)} /><SelectEquipment label="Off hand" value={offHand} values={[null, "kite-shield"]} onChange={(value) => changeEquipment("offHand", value, setOffHand)} /></section>
          <section><h2>Rendering</h2><label>Camera zoom<select data-testid="pilot-zoom" value={zoom} onChange={(event) => { const next = Number(event.target.value); setZoom(next); engineRef.current?.world.scale.set(next); }}><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option></select></label><label className="check"><input type="checkbox" checked={showBones} onChange={(event) => { setShowBones(event.target.checked); setDebug(event.target.checked, showBounds); }} />Bone handles</label><label className="check"><input type="checkbox" checked={showBounds} onChange={(event) => { setShowBounds(event.target.checked); setDebug(showBones, event.target.checked); }} />Slot bounds</label><button type="button" onClick={() => { const hero = engineRef.current?.hero; if (!hero) return; hero.setTint(0xffffff); new BrowserCharacterAppearanceStore(window.localStorage).remove(hero.appearance.characterId); setHead("iron-helm"); setTorso("scout-tunic"); setMainHand("steel-sword"); setOffHand("kite-shield"); ["head", "torso", "mainHand", "offHand"].forEach((slot) => hero.setEquipment(slot as EquipmentSlot, hero.appearance.equipmentSlots[slot as EquipmentSlot] ?? null)); }}>Reset saved appearance</button></section>
          <section><h2>Runtime</h2><dl><div><dt>Backend</dt><dd>{backend}</dd></div><div><dt>Loaded assets</dt><dd>{assetCount}</dd></div><div><dt>Rig cache</dt><dd>{cacheStats.rigDefinitions}</dd></div><div><dt>Animation cache</dt><dd>{cacheStats.animationDefinitions}</dd></div><div><dt>Texture paths</dt><dd>{cacheStats.texturePaths}</dd></div></dl><details className="asset-list"><summary>Loaded asset manifest</summary>{loadedAssets.map((asset) => <code key={asset}>{asset}</code>)}</details></section>
          <section className="warnings"><h2>Fallback warnings</h2>{warnings.length ? warnings.map((warning) => <p key={warning}>{warning}</p>) : <p>None</p>}</section>
        </>}
      </aside>
    </div>
  </main>;
}

function SelectEquipment({ label, value, values, onChange }: { readonly label: string; readonly value: string | null; readonly values: readonly (string | null)[]; readonly onChange: (value: string | null) => void }) {
  return <label>{label}<select data-testid={`pilot-equipment-${label.toLowerCase().replaceAll(" ", "-")}`} value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>{values.map((item) => <option key={item ?? "none"} value={item ?? ""}>{item ?? "none"}</option>)}</select></label>;
}
