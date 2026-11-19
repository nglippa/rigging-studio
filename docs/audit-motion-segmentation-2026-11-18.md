# Audit: motion and segmentation against the source skills (2026-11-18)

This audit checks the pipeline against two skills built from public sources:
- **`animation-coding`**: Penner (easing); Holden, *Spring-It-On*; Aristidou et al., IK survey and FABRIK; Perlin & Goldberg, *Improv*; and the Spine runtime guides.
- **`body-segmentation`**: Animated Drawings (Smith et al. 2023); Segment Anything; SCHP; Look into Person; LaMa.

Both skills live in `~/.claude4/skills/`.

Method:
- I read the code: `src/rigging/motion`, `src/rigging/animation`, `src/part-cutter/adaptiveGuide.ts`, `src/character-generation/pose`, `src/character-generation/rigging`, the SAM2 and inpaint services, and the ComfyUI point workflow.
- Unless marked otherwise, every finding comes from that code reading, not from a new run.
- Severity: **High** means a visible defect users hit now. **Medium** means a quality ceiling. **Low** means hygiene or future risk.

## What already matches the sources

**Animation**
- `AnimationPlayer` samples statelessly by time, and clips are pure functions of time (Penner's `f(t)`). Playback is frame-rate independent.
- Overlap is implemented as staggered delays: `ELBOW_DRAG`, `HEAD_LAG`, and the per-part `curve(..., delay)` from hips to hand. This is the hand-keyed form of follow-through.
- Gait angles come from measured data through periodic Catmull-Rom sampling (`rigMotion.ts:276`).

**Segmentation**
- Pose keypoints are used only above a confidence threshold, and the silhouette estimate is the fallback (`poseLandmarks.ts:12`). This follows the per-stage fallback idea in Animated Drawings.
- Pose limbs are matched to screen sides by their position on screen (`poseLandmarks.ts:25`). That is LIP's left/right concern, handled.
- The occlusion fill follows LaMa:
  - It fills inside the part's own extent and continues the texture rather than smearing the edge.
  - It merges only the invented pixels.
  - The repaint context excludes whatever is in front (`riggedPartArt.ts:65`, `compositeBehind`; covered by tests).
- Uncut pixels are given to the nearest part (`adoptStrayArtwork`), which is close to Animated Drawings' nearest-bone completeness.

## Findings: animation

### A1 (High): every key in strikes and raises is a full stop, including contact

> **Fixed the same day.**
> - **Two problems, both fixed:**
>   - Keys can now be eased per segment (`"in"`, `"out"`, `"inOut"`).
>   - The strike's values were reordered: before, the swing peaked *at* contact and pulled back. Now the blow accelerates into contact (ease-in), carries on to a follow-through extreme (ease-out), then settles. The elbow snap is eased the same way.
> - **Test:** `rig-motion.test.ts` checks that the arm is near top speed at contact and keeps moving the same way after it. That test fails with all-smoothstep easing.
> - **Verified in the app** on the goblin's melee.
- **Where:** `rigMotion.ts:410-418` (`curve` uses smoothstep on every segment), used by `wind()` at `rigMotion.ts:486` for the attack, `frontChop` and the other-arm counterbalance.
- **Source rule:** Penner (ch01). Easing is chosen by where the velocity is zero. A move into an impact needs an **ease-in**, with top speed at contact.
- **What happens:** with smoothstep the arm's velocity is zero at the "through" key (44%). The blow decelerates into the target and stops before the overshoot. This is the most likely code-level cause of the "clunky melee" complaint.
- **Fix:** give `curve` per-key easing. Ease-in on the wind-up→contact segment, ease-out on contact→overshoot, in-out elsewhere. Keep the delays.

### A2 (High): clip changes pop, because there is no mix or inertialization
- **Where:** `AnimationPlayer.ts:16` (`play` swaps the clip and re-evaluates from the setup pose). The callers include `RigLab.tsx:178`, `EditorViewport.tsx:434` and `ModularRigVisual.ts:65` (the game).
- **Source rule:** Spine (ch05) gives every clip pair a mix duration, by default about 0.1–0.2 s. Holden (ch02) offers inertialization as the cheaper alternative.
- **Fix:** add a `mixFrom` state to the player and lerp from the old clip's sample over `mixDuration`. Alternatively, record a per-channel offset at the switch and decay it with `decay_spring_damper_exact`.

### A3 (Medium): nothing keeps the feet planted (no IK)
- **Where:** a repo-wide search for IK, FABRIK or two-bone finds nothing. The side gait only corrects body height so the lowest foot rests at ground level (`rigMotion.ts:381-391`). The stance foot is never locked horizontally. `src/rigging/ai/footSlideDiagnostic.ts` measures slide but nothing corrects it.
- **Source rule:** Aristidou (ch03). Use FK, then an analytic two-bone IK post-pass during stance, keeping the bend sign from the rest pose.
- **Fix:** while the gait builds keys, record each foot's world position at contact. For the stance samples, solve thigh and shin with two-bone IK toward that point, blended in and out over 1–2 samples.

### A4 (Medium): the idle is a perfectly periodic three-key sine
- **Where:** `rigMotion.ts:395-403`.
- **Source rule:** Perlin (ch04). Lifelike rest motion comes from coherent noise. Limb frequencies run 1:2:4 from upper arm to forearm to hand. Perfectly periodic motion reads as mechanical.
- **Fix:** add low-amplitude loopable noise (1–3°) to the head and arms at octave-spaced rates, with a different seed per side.

### A5 (Medium): secondary motion uses fixed delays, not dynamics
- **Where:** `rigMotion.ts:290-291`, plus the curve delays. Held equipment is locked to the hand.
- **Source rule:** Holden (ch02). A spring whose goal is the parent's animated angle gives follow-through that scales with how hard the parent moves. A damping ratio of 0.4–0.7 gives a small overshoot and settle.
- **Fix:** when baking the clip, run a critical or under-damped spring over two loops on the head, the held weapon and any hair or cape bones. Keep the second loop.

### A6 (Medium): actions can't be layered
- **Where:** each `MotionId` is a full-body clip, and the player has one clip.
- **Source rule:** Perlin (ch04): groups compete within themselves and occlude across. Spine (ch05): a higher track overrides only the bones it keys, scaled by alpha.
- **Effect:** the character can't attack while walking or look while idling.
- **Fix:** add tracks to the player, with a per-clip keyed-bone mask and an alpha per track.

### A7 (Low): gait velocity has 12 kinks per cycle
- **Where:** `rigMotion.ts:295-296`. Twelve samples per cycle are joined linearly.
- **Source rule:** ch01. Linear interpolation is fine only for dense samples.
- **Fix:** use 24 samples, as the other clips do, or Hermite interpolation in `evaluate.ts`. RotSprite's 5° snapping hides most of this today.

### A8 (Low): rotations interpolate in raw degrees
- **Where:** `evaluate.ts:17`.
- This is correct for `raiseArms`, which winds deliberately past 180° (`rigMotion.ts:446`). But once A2 adds mixing, blends between clips must take the shortest arc. Otherwise an arm will swing 340° the wrong way.

## Findings: segmentation

### S1 (High): overlapping legs in a side view produce a scrap part
This is the cause of the goblin bug.

> **Fixed the same day; the root cause differed from the code-reading below.**
> - **What a probe on the real goblin showed:**
>   - At knee height, the tip of the low-held sword is a second run of pixels. The silhouette guide took it for the far leg, so the right knee and ankle landed out in empty space under the blade.
>   - That leg's lower-leg zone held 1 px, and its thigh zone took the skirt and the blade.
>   - The identical-corridor scrap described below happens too, once the legs are correctly found to overlap.
> - **Fixes:**
>   - A run counts as leg evidence only if it can be followed down to the ground (`reachesGround`).
>   - Overlapping knees carry the ankles with them.
>   - Pose-model limb joints that land on empty background are ignored.
>   - When the silhouette shows one leg behind the other, the far leg follows the near one and its zones are declared hidden (`optional`, empty).
> - **Downstream of the hidden leg:**
>   - `guideAllBodyParts` reports it as `hidden` rather than `missed`.
>   - `validatePrepare` no longer asks for it, and the parts list shows it as "Hidden behind the near leg".
>   - The rig builder draws the far leg from the near one.
> - **Goblin joint error:** silhouette only 6.2% → 4.9%; with the pose model 4.65% → 4.3%. The baseline is re-recorded, and the other sprites are unchanged.
> - **Verified in the app:** Cut all parts → Build rig → Walk shows two legs striding.
> - **Tests:** `guide-all-parts.test.ts`, `pose-landmarks.test.ts`.
- **Where:** `adaptiveGuide.ts:202-206`. When the legs read as stacked, both hips, knees and ankles get the same x, so the left and right leg corridors are identical. At `adaptiveGuide.ts:249-250` zones claim pixels in priority order (`leftLowerLeg` before `rightLowerLeg`, `leftThigh` before `rightThigh`).
- **What happens:** the first leg claims everything. The second gets nothing, and the fallback gives it the single nearest unclaimed pixel. That matches the goblin cut: a 2×2 right lower leg, and one thigh holding most of both legs. The walk then has one leg's art doing both legs' work, so it barely strides.
- **Source rules:**
  - LIP (ch04): a degenerate part where the skeleton expects a limb is an error.
  - Hide the far limb explicitly rather than giving it a scrap.
  - Animated Drawings (ch01): when the legs do separate, partition by nearest bone.
- **Fix:**
  - When the knee evidence is stacked, mark the far leg's zones as hidden. The motion code already handles artless limb bones (`artlessLimbBones`).
  - When the ankle evidence shows two runs (mid-stride), split the column by nearest bone using the two ankle positions.
  - Add a structure check that rejects any limb zone below an area floor.

### S2 (High): click-to-select returns one mask from one positive point
- **Where:**
  - `PartCutterWorkspace.tsx:342` sends one positive point. The negative points the backend accepts (`ComfyCharacterPipelineService.ts:243`) are never used by the UI.
  - `comfy-workflows/point-segmentation.json` returns a single mask (`sam2MultimaskAvailable: false`, `ComfyCharacterPipelineService.ts:414`).
- **Source rule:** SAM (ch02). A single click is ambiguous between whole, part and subpart. Return 3 masks with predicted IoU, and refine with positive and negative clicks in the error region.
- **Fix:**
  - Let Alt-click add a negative point, and keep the point list per selection.
  - Expose the multimask output if the installed node allows it. Otherwise, run it at 1, 2 and 3 points.

### S3 (Medium): pixel sprites go to SAM at native size
- **Where:** the point workflow is LoadImage → Sam2Segmentation, with no upscale node.
- **Source rule:** SAM (ch02). SAM resizes the long side to 1024. A 48 px sprite is enlarged about 21× with smoothing, which blurs the pixel art the encoder sees.
- **Fix:** upscale with nearest-neighbour to about 1024 before upload, then scale the mask back down with nearest-neighbour.

### S4 (Medium): SAM masks get no cleanup
- **Where:** `ComfyCharacterPipelineService.ts:259` thresholds at 128, and nothing else happens.
- **Source rule:** SAM (ch02). Remove small islands and fill small holes; each problem affects about 4% of masks. The floors should scale with sprite area.
- **Fix:** keep the component containing the click (plus any big ones), and fill holes below a floor.

### S5 (Medium): seams are geometric, not aligned with the art's edges
- **Where:** `adaptiveGuide.ts:238`. Limb corridors are distance-to-segment ≤ radius, so the boundary between zones falls where the priority claims stop.
- **Source rule:** SCHP (ch03). Part boundaries must lie on image edges (the consistency term).
- **Effect:** a seam through flat colour shows as a sliced edge when the part rotates.
- **Fix:** add a seam-snap pass. Within a few pixels of each zone boundary, re-run the boundary as a shortest path with cost `1 − edge`. Track a seam-on-edge ratio in the benchmark.

### S6 (Medium): held equipment is detected but never cut

> **Fixed the same day, and verified live once the Studio woke** (ComfyUI 0.44.0, SAM2 point prompts):
> - Cut all parts on the goblin cut the blade as one piece across the legs and the shield as main-hand equipment.
> - Melee strikes with the sword, and Walk swings the sword with the arm.
> - Remaining cosmetic issue: where the sword was carved out of the thigh, the built-in hole fill shows as a blocky patch until the existing Repaint (inpainting) pass is run.
> - The shield's top band went to a different part than its body.
>
> The details below were written before the live run.
> - **What was built:**
>   - `heldObjectSeeds` finds points on held items: runs that are in no body zone and don't reach the ground (on the goblin, the blade, pommel and shield).
>   - After the body is cut, Cut all parts asks SAM2 for each seed's mask and keeps the piece under the seed (`selectionFromCanvasMask`).
>   - It accepts the mask only if it is within reach of a wrist, isn't mostly body, and isn't a repeat (`heldObjectHand`).
>   - It then cuts the item as that hand's equipment, carving it out of the parts that had absorbed it (`commitHeldObjects`).
>   - `attack()` now strikes with the arm holding the longest, thinnest equipment, and never with a lone shield (`equipmentElongation`).
> - **Verified:**
>   - Unit tests, using masks shaped like the goblin's sword and shield (`held-objects.test.ts`, `rig-motion.test.ts`).
>   - The app skips the step cleanly when the Studio is offline.
> - **Not verified:** the live SAM call. The Mac Studio was unreachable during this session (the bridge returned "fetch failed").
- **Where:** `adaptiveGuide.ts:120-121` already names "anything further out" than the arm as held equipment, but nothing makes an equipment zone from it. Without an equipment part, `attack()` falls back to the screen-right arm (`rigMotion.ts:477-478`), which is why the goblin swings its shield.
- **Source rule:** Animated Drawings (ch01). Held objects are the classic pose failure, so treat them explicitly.
- **Fix:**
  - Turn the outer runs next to each hand into a proposed `mainHandEquipment` or `offHandEquipment` zone attached to that hand.
  - Long, thin runs are weapons; wide, compact ones are shields.
  - Let the user confirm.

### S7 (Low): no flip-consistency check on the pose
- **Where:** `poseLandmarks.ts:25` resolves left and right from where the shoulders and hips sit on screen. It does not check consistency, and it doesn't distrust a wrist that lies on held equipment.
- **Source rules:** LIP and SCHP (ch03, ch04). Left/right swaps and boundaries are where labels go wrong.
- **Fix:** run DWPose on the mirrored image too, swap and average the results. Treat disagreement as low confidence and fall back to the silhouette for those joints.

### S8 (Low): repaint can add off-palette colours, and the manual repair shows the occluder
- **Where:**
  - The SDXL inpaint output is merged without palette snapping (`riggedPartArt.ts`; there is no palette code there).
  - The manual "Repair Hidden Area" sends the full source image as context (`PartCutterWorkspace.tsx:396`, `CreateCharacterWorkspace.tsx:242`).
- **Source rule:** LaMa (ch05). The context must exclude the occluder, and fills in pixel art should be snapped to the palette.
- **Fix:** quantize the repainted pixels to the sprite's palette. Use `compositeBehind` as the context in the manual repair too.

## Suggested order
1. S1 and S6 (the goblin) are segmentation-side and small, and they unblock the side-view walk and melee.
2. A1 (contact easing) is a small change with the largest effect on how melee feels.
3. A2 (mixing) affects every consumer of the player.
4. Then S2/S3/S4 (SAM quality), A3 (foot IK), and A4/A5 (idle noise, springs).
5. A6 (layering) and S5 (seam snapping) are larger pieces of work.
