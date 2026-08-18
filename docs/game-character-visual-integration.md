# Game character visual integration

## Repository audit and scope

This repository is a standalone Rig Studio. Before this integration it contained no gameplay entity model, camera, movement system, legacy spritesheet controller, or player-save service. The only character surfaces were the Rig Studio preview, Rig Lab, and Rig Editor.

The integration therefore introduces a game-facing boundary and one concrete pilot scene without claiming to have migrated an external game that is not present. A real game can import the same `CharacterVisualController`, provide its own Pixi parent container and save adapter, and migrate one appearance definition at a time. Existing Rig Studio, Rig Lab, and Rig Editor paths remain unchanged.

## Pilot character

The pilot is **Lab Knight**, backed by `public/rig-test/minimal-rig.json`. Its appearance definition is `public/game/characters/lab-knight.appearance.json`.

It supports:

- idle, walk, run, basic attack, hurt, and death actions
- steel and arcane swords
- one kite shield, including an empty off-hand state
- iron and bronze helmets, including an empty head state
- scout and royal torso palettes
- equipment replacement without restarting the current animation
- device-local appearance restoration through `CharacterAppearanceStore`
- a static legacy PNG fallback

The two helmet and torso options currently demonstrate data-driven palette variants using the same pilot silhouette. They validate the runtime path but are not a substitute for final authored cosmetic art.

## Gameplay integration point

Gameplay code owns a `CharacterVisualController`, adds its `container` to a Pixi world, and calls only the backend-neutral contract:

```ts
const visual = new CharacterVisualController(appearance, { cache, onWarning });
await visual.load();
world.addChild(visual.container);

visual.setPosition(entity.x, entity.y);
visual.setFacing(entity.velocityX < 0 ? "left" : "right");
visual.playAnimation(entity.isRunning ? "run" : "walk", false);
visual.setEquipment("mainHand", save.mainHandItemId);

// Game loop; no React involvement.
visual.update(deltaSeconds);
```

`CharacterVisualController` selects `ModularRigVisual` or `LegacySpriteVisual`. Position, facing, playback, visibility, tint, equipment, skin, expression, layer, bounds, and completion callbacks use the same methods for both. A backend can be changed in appearance data without changing gameplay decisions.

## Appearance data

Every versioned appearance definition contains:

- character and backend identity
- rig ID/path and skin
- all supported equipment categories and stable rig-slot mappings
- an equipment catalog with attachment IDs, per-item transforms, tint, pivot, and per-animation overrides
- logical gameplay-action to animation-clip mapping and fallback rules
- horizontal direction behavior
- scale, world offset, pixel snapping, tint palette, shadow, expression mapping, and legacy fallback art

Animation clips reference bone transforms only. They never reference sword, shield, helmet, outfit, or other cosmetic attachment IDs. Equipment remains a slot-resolution concern.

## Directional strategy

The initial strategy is **A: horizontal flipping for left/right only**.

The pilot art is authored as a right-facing side cutout. `setFacing("left")` mirrors the visual root around the gameplay origin. This does not create front or back views. A character that needs convincing north/south movement must later choose separate rigs, directional skins, or directional animations and declare that strategy explicitly rather than relying on automatic cutout rotation.

## Pixel rendering

- Pixi applications use antialiasing off for the pilot scene.
- Loaded legacy and modular textures use nearest-neighbor sampling.
- The pilot appearance enables whole-pixel root snapping.
- Camera checks run at 0.5×, 1×, and 2×.
- Equipment transforms remain local and data-driven, avoiding subpixel animation forks.
- Mesh deformation is not used.

## Cache and ownership

`CharacterAssetCache` owns one rig-definition promise per path, one animation-definition promise per rig/path pair, and one shared `RigAssetLoader`. Loaded definitions are recursively frozen and shared by reference. Each `ModularRigVisual` creates its own `RigRuntime` and `AnimationPlayer`, so poses, skin state, equipment overrides, playback time, and completion state remain independent.

The game should create one cache for a scene or application lifetime. Individual characters destroy their Pixi containers, renderer objects, listeners, and pose state but do not unload shared textures. The owning scene destroys the cache after all character visuals have been disposed.

## Fallback behavior

- A missing or invalid modular rig attempts the appearance's configured `LegacySpriteVisual`.
- If legacy art also fails, the controller installs a clear magenta placeholder.
- A missing action follows the clip-specific fallback, then configured idle fallback, then the first loaded clip.
- A missing attachment hides the affected slot and emits a development warning.
- Invalid equipment IDs or slot/category mismatches fall back to appearance defaults.
- Invalid skins fall back to the rig's default skin.
- One cosmetic or animation failure never terminates the game loop.

## Appearance persistence

The repository had no existing game save system. `CharacterAppearanceStore` is therefore the integration seam. `BrowserCharacterAppearanceStore` is used only by the local pilot and validates a versioned save envelope before restoration. An external game should implement the same interface over its existing save document and store equipment item IDs, skin, tint, and expression alongside the character record.

## Development inspector

`/game-pilot` includes a development-only inspector for animation, skin/equipment-relevant controls, playback speed, camera zoom, bones, bounds, current backend, cache counts, loaded assets, completion events, and fallback warnings. The controls are removed in production mode; the pilot scene remains available as an integration harness.

## Performance measurement

The pilot scene renders 25 simultaneous modular characters sharing one frozen rig, six frozen animation definitions, and 18 texture paths. Measurements were taken in the local Pixi scene after the rolling 600-frame window had warmed up:

| Camera zoom | Average controller/pose/renderer update | p95 update |
| --- | ---: | ---: |
| 0.5× | 2.85 ms | 5.90 ms |
| 1× | 1.88 ms | 3.00 ms |
| 2× | 2.08 ms | 3.40 ms |

This instrumentation measures JavaScript game-loop work for all 25 controllers, including pose evaluation and renderer updates. It does not measure GPU composition time or represent every target device. The live inspector continues reporting rolling measurements so final hardware and actual game camera conditions can be profiled later.

## One-character migration checklist

### Prepare modular art

- [ ] Choose an authored direction and declare the directional strategy.
- [ ] Export transparent pieces at consistent scale and coordinate origin.
- [ ] Keep pivots stable at anatomical joints.
- [ ] Separate every runtime-swappable cosmetic into a stable category.
- [ ] Avoid baked shadows and equipment in base body pieces.
- [ ] Verify nearest-neighbor appearance at the game's real zoom levels.
- [ ] Record intended draw order and any front/back hand or weapon variants.

### Validate the rig

- [ ] Validate schema, unique IDs, one root, parents, and cycle freedom.
- [ ] Check setup pose and canvas origin against the gameplay origin.
- [ ] Verify left/right flipping does not move the root or invert text/asymmetric art unexpectedly.
- [ ] Preview idle, walk, run, attack, hurt, and death.
- [ ] Confirm loop seams and non-looping completion events.
- [ ] Test whole-pixel snapping during camera movement.
- [ ] Confirm 25-instance cache sharing and independent poses.
- [ ] Confirm destroy removes listeners and display objects.

### Validate equipment compatibility

- [ ] Map each gameplay category to one stable rig slot.
- [ ] Ensure every item references an existing attachment and matching category.
- [ ] Tune offset, rotation, scale, pivot, and tint per item.
- [ ] Add only narrow per-animation attachment overrides for exceptional poses.
- [ ] Swap every item during walk and attack without restarting playback.
- [ ] Verify draw order with both hands, capes, shields, and back items.
- [ ] Confirm invalid saved items fall back to defaults.
- [ ] Confirm the legacy backend can still render the character if modular assets fail.

After these checks, change only that character's `visualBackend` to `modularRig`. Do not remove its legacy definition until the production fallback window is intentionally closed.
