import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Container } from "pixi.js";
import { AnimationPlayer } from "../../src/rigging/animation/AnimationPlayer";
import { RigAssetLoader, type TextureLoadResult } from "../../src/rigging/assets/RigAssetLoader";
import { RigRenderer } from "../../src/rigging/rendering/RigRenderer";
import { RigRuntime } from "../../src/rigging/runtime/RigRuntime";
import { BrowserCharacterAppearanceStore } from "../../src/game/character-visuals/appearancePersistence";
import { parseCharacterAppearanceJson } from "../../src/game/character-visuals/appearanceSchema";
import { resolveMappedAnimation } from "../../src/game/character-visuals/animationResolution";
import { CharacterAssetCache } from "../../src/game/character-visuals/CharacterAssetCache";
import { CharacterVisualController, type CharacterBackendFactory } from "../../src/game/character-visuals/CharacterVisualController";
import type { AnimationCompleteEvent, AnimationCompleteListener, CharacterBounds, CharacterFacing, CharacterVisualBackend, CharacterVisualBackendKind, EquipmentSlot } from "../../src/game/character-visuals/types";
import { validAnimation, validRig } from "./fixtures";

const appearance = () => parseCharacterAppearanceJson(readFileSync(new URL("../../public/game/characters/lab-knight.appearance.json", import.meta.url), "utf8"));

class FakeBackend implements CharacterVisualBackend {
  readonly container = new Container();
  readonly calls: string[] = [];
  readonly listeners = new Set<AnimationCompleteListener>();
  destroyed = false;
  constructor(readonly kind: CharacterVisualBackendKind | "placeholder", private readonly failLoad = false) {}
  async load(): Promise<void> { this.calls.push("load"); if (this.failLoad) throw new Error("backend load failed"); }
  destroy(): void { this.destroyed = true; this.calls.push("destroy"); this.container.destroy(); }
  update(deltaSeconds: number): void { this.calls.push(`update:${deltaSeconds}`); }
  setPosition(x: number, y: number): void { this.calls.push(`position:${x},${y}`); }
  setFacing(facing: CharacterFacing): void { this.calls.push(`facing:${facing}`); }
  playAnimation(action: string, restart = true): void { this.calls.push(`play:${action}:${restart}`); }
  stopAnimation(): void { this.calls.push("stop"); }
  setPlaybackSpeed(speed: number): void { this.calls.push(`speed:${speed}`); }
  setVisible(visible: boolean): void { this.calls.push(`visible:${visible}`); }
  setTint(tint: number): void { this.calls.push(`tint:${tint}`); }
  setEquipment(slot: EquipmentSlot, itemId: string | null): void { this.calls.push(`equipment:${slot}:${itemId}`); }
  setSkin(skinId: string | null): void { this.calls.push(`skin:${skinId}`); }
  setExpression(expression: string | null): void { this.calls.push(`expression:${expression}`); }
  setLayer(layer: number): void { this.calls.push(`layer:${layer}`); }
  getBounds(): CharacterBounds { return { x: 1, y: 2, width: 3, height: 4 }; }
  onAnimationComplete(listener: AnimationCompleteListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setDebugDisplay(showBones: boolean, showBounds: boolean): void { this.calls.push(`debug:${showBones}:${showBounds}`); }
  getLoadedAssets(): readonly string[] { return ["fixture.png"]; }
  emit(event: AnimationCompleteEvent): void { this.listeners.forEach((listener) => listener(event)); }
}

const fakeFactory = (created: FakeBackend[], failModular = false): CharacterBackendFactory => (kind) => {
  const backend = new FakeBackend(kind, kind === "modularRig" && failModular); created.push(backend); return backend;
};

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

class MissingTextureLoader extends RigAssetLoader {
  override async loadRig(rig: ReturnType<typeof validRig>): Promise<Readonly<Record<string, TextureLoadResult>>> {
    return Object.fromEntries(rig.attachments.map((attachment) => [attachment.id, { success: false as const, url: attachment.imagePath, error: new Error("missing fixture") }]));
  }
}

describe("game-facing character visuals", () => {
  it("exposes one backend-neutral gameplay contract", async () => {
    const created: FakeBackend[] = []; const controller = new CharacterVisualController(appearance(), { backendFactory: fakeFactory(created) }); await controller.load();
    controller.setPosition(10.2, 20.6); controller.setFacing("left"); controller.playAnimation("walk"); controller.stopAnimation(); controller.setPlaybackSpeed(1.5); controller.setVisible(false); controller.setTint(0xabcdef); controller.setEquipment("mainHand", "arcane-sword"); controller.setSkin("default"); controller.setExpression("smile"); controller.setLayer(7); controller.setDebugDisplay(true, true); controller.update(.016);
    const calls = created[0].calls.join("|");
    expect(controller.currentBackend).toBe("modularRig"); expect(controller.getBounds()).toEqual({ x: 1, y: 2, width: 3, height: 4 }); expect(controller.getLoadedAssets()).toEqual(["fixture.png"]);
    ["position:10.2,20.6", "facing:left", "play:walk:true", "stop", "speed:1.5", "visible:false", `tint:${0xabcdef}`, "equipment:mainHand:arcane-sword", "skin:default", "expression:smile", "layer:7", "debug:true:true", "update:0.016"].forEach((call) => expect(calls).toContain(call));
    controller.destroy();
  });

  it("falls back from a missing modular rig to the configured legacy visual", async () => {
    const created: FakeBackend[] = []; const warnings: string[] = [];
    const controller = new CharacterVisualController(appearance(), { backendFactory: fakeFactory(created, true), onWarning: (warning) => warnings.push(warning.message) }); await controller.load();
    expect(created.map((backend) => backend.kind)).toEqual(["modularRig", "legacySprite"]); expect(created[0].destroyed).toBe(true); expect(controller.currentBackend).toBe("legacySprite"); expect(warnings.join(" ")).toContain("Using configured legacy fallback"); controller.destroy();
  });

  it("persists equipment and safely restores invalid cosmetics to defaults", async () => {
    const storage = new MemoryStorage(); const store = new BrowserCharacterAppearanceStore(storage); const created: FakeBackend[] = [];
    const controller = new CharacterVisualController(appearance(), { backendFactory: fakeFactory(created) }); await controller.load(); controller.setEquipment("mainHand", "arcane-sword"); controller.setEquipment("head", "not-a-real-item"); store.save(controller.getAppearanceSave());
    const saved = store.load("lab-knight"); expect(saved?.equipment.mainHand).toBe("arcane-sword"); expect(saved?.equipment.head).toBe("iron-helm");
    const restored = new CharacterVisualController(appearance(), { backendFactory: fakeFactory(created) }); await restored.load(); if (saved) restored.restoreAppearance(saved); expect(restored.getAppearanceSave().equipment).toEqual(saved?.equipment); controller.destroy(); restored.destroy();
  });

  it("resolves missing animations through the configured fallback chain", () => {
    const definition = appearance();
    expect(resolveMappedAnimation("run", definition, new Set(["idle", "walk"]))).toEqual({ clipId: "walk", fellBack: true });
    expect(resolveMappedAnimation("unknown", definition, new Set(["idle"]))).toEqual({ clipId: "idle", fellBack: true });
  });

  it("hides missing attachment textures and reports a warning", async () => {
    const runtime = new RigRuntime(validRig()); const warnings: string[] = []; const loader = new MissingTextureLoader();
    const renderer = await RigRenderer.create(runtime, { assetLoader: loader, hideMissingAttachments: true, onWarning: (warning) => warnings.push(warning) }); renderer.update();
    expect(renderer.attachmentSprites.get("body")?.visible).toBe(false); expect(warnings[0]).toContain("could not load"); renderer.destroy(); await loader.destroy();
  });

  it("shares frozen definitions while each runtime pose remains independent", async () => {
    let fetches = 0; const source = JSON.stringify(validRig()); const cache = new CharacterAssetCache(async () => ({ ok: true, status: 200, async text() { fetches += 1; return source; } }));
    const [first, second] = await Promise.all([cache.getRig("/shared.json"), cache.getRig("/shared.json")]); expect(first).toBe(second); expect(Object.isFrozen(first)).toBe(true); expect(fetches).toBe(1);
    const left = new RigRuntime(first); const right = new RigRuntime(second); left.updateBonePose("child", { x: 77 }); expect(left.getPose().bones.child.x).toBe(77); expect(right.getPose().bones.child.x).toBe(10); await cache.destroy();
  });

  it("cleans up its backend exactly once", async () => {
    const created: FakeBackend[] = []; const controller = new CharacterVisualController(appearance(), { backendFactory: fakeFactory(created) }); await controller.load(); controller.destroy(); controller.destroy(); expect(created[0].calls.filter((call) => call === "destroy")).toHaveLength(1);
  });

  it("forwards non-looping animation completion events", async () => {
    const created: FakeBackend[] = []; const controller = new CharacterVisualController(appearance(), { backendFactory: fakeFactory(created) }); await controller.load(); const events: AnimationCompleteEvent[] = []; controller.onAnimationComplete((event) => events.push(event)); created[0].emit({ action: "hurt", clipId: "hurt" }); expect(events).toEqual([{ action: "hurt", clipId: "hurt" }]); controller.destroy();
  });

  it("keeps animation state active while equipment changes", async () => {
    const created: FakeBackend[] = []; const controller = new CharacterVisualController(appearance(), { backendFactory: fakeFactory(created) }); await controller.load(); controller.playAnimation("walk"); controller.setEquipment("mainHand", "arcane-sword"); controller.update(.1); const calls = created[0].calls; expect(calls.indexOf("play:walk:true")).toBeLessThan(calls.indexOf("equipment:mainHand:arcane-sword")); expect(calls.at(-1)).toBe("update:0.1"); controller.destroy();
  });

  it("updates 25 independent modular poses within a practical CPU budget", () => {
    const rig = validRig(); const animation = validAnimation(); const players = Array.from({ length: 25 }, () => { const runtime = new RigRuntime(rig); const player = new AnimationPlayer(runtime); player.play(animation); return player; });
    const start = performance.now(); for (let frame = 0; frame < 300; frame += 1) players.forEach((player) => player.update(1 / 60)); const elapsed = performance.now() - start;
    expect(players.every((player) => player.currentTime >= 0 && player.currentTime < animation.duration)).toBe(true); expect(elapsed).toBeLessThan(5000);
  });
});
