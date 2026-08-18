# Rigging architecture

## Scope

This milestone includes the serializable runtime, setup-pose rig editor, focused transform-animation dope sheet, a user-approved AI proposal workflow, and optional user-confirmed visual review. It intentionally excludes IK, mesh deformation, weight painting, physics, sprite cutting, autonomous AI control, spritesheet export, databases, and cloud saving.

## Data flow

1. Rig and animation JSON are fetched as text.
2. Zod validates the current versioned wire format. Semantic validators then verify references, uniqueness, hierarchy integrity, and animation timing.
3. `RigRuntime` converts the setup pose into independent mutable runtime nodes and keeps skin/slot overrides outside animation state.
4. `AnimationPlayer` samples tracks into the runtime pose without modifying either the animation or rig definitions.
5. `computeWorldTransforms` resolves local poses through the validated hierarchy.
6. `RigAssetLoader` deduplicates texture requests by path. A skin and optional per-slot overrides resolve attachment IDs, and `RigRenderer` applies the corresponding bone and attachment transforms to Pixi sprites.

Definitions are authoring data. Poses and attachment overrides are runtime data. Neither React nor Pixi owns the animation model.

## Coordinate system and rotation

Coordinates use browser/canvas convention: the origin is at the top left, positive X points right, and positive Y points down. Distances are logical pixels in the rig canvas. **JSON rotations are authored in degrees.** Runtime poses, matrices, and Pixi transforms use radians. `degreesToRadians` and `radiansToDegrees` are the only conversion boundary. With a downward Y axis, positive rotation appears clockwise on screen.

The matrix representation is `{ a, b, c, d, tx, ty }`, applied as `x' = a*x + c*y + tx` and `y' = b*x + d*y + ty`.

## Bone parenting

Every rig declares `rootBoneId`, and exactly one bone must have `parentId: null`. Every other parent must exist. Duplicate IDs and cycles are rejected before runtime evaluation.

Child positions are transformed through the full parent matrix. `inheritRotation` controls whether the child's visual orientation adds the parent's rotation. `inheritScale` controls whether the child's visual scale multiplies the parent's scale. This first version deliberately produces transform-only bones with no asset paths.

## Slots, attachments, skins, and equipment

A slot binds a visual layer to a bone and owns visibility, draw order, blend mode, tint, and pivot. Pivot values are logical attachment pixels measured from its top-left corner. An attachment owns the image path, design dimensions, transform offset, category, and tags.

Resolution order is: explicit runtime slot override, selected skin mapping, then the slot's default `attachmentId`. A resolved `null` hides the attachment. Equipment therefore changes a skin or slot override; it never rewrites animation tracks.

Image paths are public-root-relative by convention. `RigAssetLoader` caches in-flight and completed loads by resolved path, so attachments that share an image never duplicate network work. `RigRenderer` owns the Pixi display objects and uses a visible magenta placeholder plus a development warning when an attachment fails. The Rig Lab fixtures use separate transparent PNG files for every character part and equipment option.

## Animation evaluation

The initial animated properties are `x`, `y`, `rotation`, `scaleX`, and `scaleY`. Values are absolute local bone values; rotation track values are degrees at the JSON boundary. Tracks must reference real bones, contain strictly increasing keyframe times, and stay within the animation duration.

The easing on a keyframe controls the segment from that keyframe to the next. `stepped` holds the left value. Before the first keyframe and after the last, the nearest value is held. Looping wraps elapsed time into the animation duration; non-looping playback clamps it. Numeric rotation interpolation is direct and deterministic rather than shortest-arc in schema version 1.

## Runtime pose versus source definitions

`RigDefinition` and `AnimationDefinition` are readonly JSON-shaped values. `RigRuntime` owns mutable runtime bone and slot nodes, but exposes pose snapshots as `RigPose`. Every animation evaluation begins from a setup-pose copy, so omitted properties never retain stale values from another animation. Multiple characters can share one parsed rig and animation while maintaining independent pose, skin, equipment, playback time, and speed.

## Editor authoring state

The visual editor treats every accepted `RigDefinition` as an immutable snapshot. A command stores the complete before and after snapshots, which keeps undo and redo deterministic and leaves room for future migration-aware command payloads. Continuous pointer drags use a history transaction: Pixi previews mutable runtime values while the pointer moves, then the final authoring transform is committed as one command on pointer release.

The editor never copies animation playback values back into bone definitions. Preview mode instantiates an `AnimationPlayer` over a disposable `RigRuntime`, disables destructive setup-pose controls, and resets the runtime to its authored setup pose on exit. Skin selection changes the runtime skin independently, so animation playback continues.

JSON imports pass through the same Zod and semantic validators as the runtime before they can replace the current editor document. JSON exports are pretty-formatted schema-versioned rig definitions. Device-local draft autosave uses a versioned `localStorage` envelope and validates again during restoration; it is not backend persistence.

Local image uploads are represented by browser object URLs for the current tab session. The attachment metadata remains serializable, but the temporary `blob:` image path cannot be reopened after a browser restart or used by another machine. Production asset ingestion will eventually need an explicit copy/import pipeline that converts temporary images into stable project paths.

## Animation authoring

Setup and Animate are separate editor workspaces. Setup commands change immutable `RigDefinition` snapshots. Animate commands change an immutable `AnimationLibrary` containing ordinary schema-versioned `AnimationDefinition` values. The library is an editor transport envelope rather than a runtime schema change; an individual animation remains compatible with `AnimationPlayer` and the existing JSON parser.

Timeline time is stored in seconds. Authoring FPS only changes ruler labels, keyboard step size, and optional snapping, so switching FPS never quantizes existing data. Key insertion replaces another key on the same bone/property track within a small time epsilon, and all resulting tracks remain sorted. Multi-key drags apply one shared time delta and produce one history command. The duration overflow policy is explicit: Clamp preserves duration, while Expand duration grows it to include moved or pasted keys.

Auto-Key converts a completed viewport transform into keyframes at the playhead and commits the entire pointer drag as one command. With Auto-Key disabled, the Pixi runtime previews the pose but the authoring animation stays unchanged until the user invokes Create keyframe. Neither path writes animation values into the rig setup pose.

The animation library importer accepts either one standard animation or a Rig Studio library, validates every clip against the current rig, and only then replaces the document. Pretty-formatted library exports preserve editor metadata and extension fields where practical. Device-local animation drafts use a rig-specific `localStorage` key and remain separate from rig drafts.

The dope sheet flattens bone and property rows, then renders only the visible vertical range with overscan. Playback updates the Pixi runtime, playhead transform, and time output imperatively; it does not set React state every frame. This keeps playback and timeline scrolling responsive for the target case of 100 bones, 500 property rows, and 2,000 keys.

Previous and next pose ghosts are derived from adjacent global key times, evaluated through the same deterministic pose evaluator, and drawn as low-opacity non-interactive bone overlays. They never participate in hit testing or selection.

## AI proposal boundary

AI generation is an authoring assistant, not a runtime controller. Providers receive a deliberately minimal rig and motion context and return an `AnimationProposal` envelope. The proposal is validated independently from the provider, diffed against the current animation, and previewed through a cloned animation value. It cannot mutate the rig, animation library, runtime, or project files.

Create, full revision, selected-bone revision, and selected-track application converge on `applyAnimationProposal`. Only an explicit acceptance invokes the existing animation command history, so the complete accepted change is one undo step. Rejection returns the original document unchanged. Recommended rig changes remain explanatory notes and use no automatic rig mutation path.

Provider adapters are replaceable. Local development uses a deterministic mock; the HTTP adapter sends the same constrained request to an optional server endpoint. Browser code contains no provider secret. Detailed configuration and lifecycle documentation is in `docs/ai-animation-authoring.md`.

## Visual review boundary

Visual review is a second, optional authoring boundary. `DiagnosticFrameRenderer` samples the same deterministic evaluator used by playback and draws only the rig, attachments, and requested diagnostic overlays to detached browser canvases. It never captures the editor DOM. `diagnosticCapturePlan` fixes frame times, dimensions, and contact-sheet layout before rendering, so repeated captures of unchanged inputs use the same samples.

The contact sheet and minimal structured context remain local until the user presses **Confirm and send for review**. A review is validated with Zod and semantic bone/time checks before issue markers reach the dope sheet. A provider's corrected animation then passes through the normal `validateAnimationProposal` path. Preview uses the existing isolated proposal runtime, and explicit acceptance remains one undoable editor command.

Review passes are bounded to one by default and three at the hard maximum. Each pass is an individual user action; provider failures are surfaced without automatic retries. Captures can instead be packaged as a deterministic local ZIP for manual review. See `docs/ai-visual-review.md` for the payload, overlays, cost controls, and image-critique limitations.

## Playback lifecycle

`AnimationPlayer` owns time and playback state, not rendering. It supports play, pause, stop, restart, deterministic seek, positive playback speeds, definition-driven looping, and an optional loop override. Non-looping clips clamp at their duration and report completion. A Pixi ticker advances the player and tells `RigRenderer` to render the latest runtime state; React is not updated on every frame.

## Game-facing visual boundary

`src/game/character-visuals` adds a backend-neutral `CharacterVisualController` above the rig runtime. Gameplay actions map to either `LegacySpriteVisual` or `ModularRigVisual`, with shared frozen definition/texture caches and per-instance mutable poses. Appearance JSON owns equipment slot mappings, directional strategy, pixel snapping, animation fallbacks, legacy art, and save-compatible cosmetic IDs. The first incremental pilot and migration checklists are documented in `docs/game-character-visual-integration.md`.

## Generated-character authoring

`src/character-generation` adds a provider-neutral prompt → image → parts → rig pipeline above the same immutable rig schemas. Generated source images never enter bone definitions. Accepted transparent parts become attachments, slots bind them to bones, and the initial skin owns the mapping. The portable versioned project format retains provider metadata, masks, reconstruction decisions, warnings, and corrections outside `RigDefinition`; only a validated rig is handed into the editor draft. See `docs/character-generation-pipeline.md` for the full flow and provider contract.

## Validation and schema migration

Schema version 1 is represented by literal version fields. Parsers reject unknown versions clearly instead of guessing. A future migration layer can inspect `schemaVersion`, migrate older unknown input to the current wire format, and only then call the current strict parser. Current schemas reject unknown object keys so misspellings do not silently enter production data.

## Future extension points

- Schema migrations before current-version parsing
- Blended animation layers and crossfades that still output `RigPose`
- Events and named markers alongside transform tracks
- Additional renderer adapters without React coupling
- Attachment manifests, caching, and disposal policies
- Editor commands that operate on immutable authoring snapshots
- Constraints, IK, meshes, and physics as explicit optional runtime stages
- Agent-authored JSON passed through the same safe parsers and validators
