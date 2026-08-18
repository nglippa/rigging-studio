# AI visual review

## Workflow

Visual review is an optional, user-controlled step in **Rig Editor → Animate → Visual review**.

1. Describe the animation goal and choose frame, overlay, foot, contact, and constraint settings.
2. Press **Render contact sheet**. The editor deterministically samples the current animation and renders the rig to detached canvases. No request occurs.
3. Inspect the contact sheet and the exact payload disclosure shown beneath it.
4. Either export a diagnostic ZIP for manual review or press **Confirm and send for review**.
5. The configured provider returns a structured critique. The client validates its schema, time ranges, issue IDs, and affected bone IDs before displaying it.
6. Issue bars appear above the dope sheet. Selecting an issue seeks to the middle of its reported time range and selects its affected bones.
7. If the response includes a corrected animation proposal, the ordinary proposal validator checks the rig references, schema, transforms, timings, scales, root motion, and key counts. A rejected correction remains isolated. A valid correction can be previewed and diffed, but only **Accept correction** writes it through the existing one-command undo history.

Changing the animation after a capture marks that capture stale and disables sending/export until it is rendered again. Scrubbing, reviewing, and previewing do not create history entries or modify setup-pose data.

## Data sent to a provider

The confirmation view reports frame count and contact-sheet dimensions. A confirmed HTTP review sends multipart form data containing only:

- `contactSheet`: the rendered PNG contact sheet
- optional `frames`: individual rendered PNG frames, when explicitly enabled
- `prompt`: the review instructions and structured JSON context
- `context`: animation goal; rig schema version; bone IDs, parents, lengths, and setup transforms; current animation JSON; marked foot bones and contact intervals; motion constraints; known foot-contact warnings; capture times, dimensions, and overlay flags
- `previousReviews`: prior structured reviews in this editor session, only on an explicitly started later pass

It does not send editor UI, unrelated project files, source code, arbitrary rig metadata, asset paths, local uploads, browser state, or API credentials. The PNG naturally contains the visible character art required for visual inspection.

`NEXT_PUBLIC_AI_VISION_ENDPOINT` configures only the public URL of a server endpoint. Provider credentials must remain in server environment variables. When the endpoint is unset, the panel uses the deterministic local mock provider and makes no external AI call.

The endpoint accepts multipart form data and should return the documented `VisualReview` JSON object. It should authenticate and rate-limit requests as needed, use a vision-capable model, and return the model response without applying it to project state.

## Cost and pass control

- Rendering a contact sheet is local and does not call a provider.
- No provider call occurs until the user presses the confirmation button.
- One button press makes at most one provider request. The client performs no model retry.
- Maximum passes default to 1 and have a hard limit of 3.
- Every later pass requires another explicit click; there is no autonomous refinement loop.
- The session history retains each validated review and any correction it contained.
- Corrections never replace accepted animation data silently.
- Frame count is capped at 24, frame width/height at 640 pixels, and contact-sheet width at 2400 pixels to bound payload size.

Normal low-level browser/network behavior may reconnect below the application layer, but the visual-review provider adapter itself issues exactly one `fetch` per requested pass.

## Diagnostic overlays

Each overlay is independently selectable:

- Bone segments
- Bone names
- Joint points
- Slot bounds
- Ground line at the configured authoring Y coordinate
- Root trajectory sampled across the animation
- Left/right foot trajectories
- Motion arcs for hand, foot, and weapon-related bones

The default capture shows bones, joints, ground, root trajectory, and foot trajectories. Bone labels, slot bounds, and broader motion arcs default off to keep the silhouette readable. The background is a plain dark neutral chosen to contrast the test character. Attachments render in slot `zIndex` order with their bone, offset, rotation, scale, and pivot transforms.

## Manual diagnostic package

**Export diagnostic ZIP** works without a configured provider. It contains:

- `contact-sheet.png`
- `rig-context.json`
- `animation.json`
- `review-request.txt`
- `review-response.json` when a review has already completed

This package can be inspected or sent manually to Claude, OpenAI, or another vision-capable model. It uses an uncompressed deterministic ZIP writer so the package requires no upload or archive dependency.

## Known limitations

Image-based critique is advisory. A contact sheet shows selected poses rather than every in-between frame, so very brief pops, easing artifacts, or high-frequency motion may be missed. Trajectory overlays help with contact and root-motion analysis but are not a physics solver. Flat images also make depth, intended occlusion, handedness, and whether a gap belongs to art, attachment setup, draw order, or animation genuinely ambiguous.

The reviewer is explicitly asked to separate rig, animation, attachment, draw-order, and art limitations, but confidence is still heuristic. Always preview a correction at full playback speed and inspect the relevant frames before accepting it. The browser capture uses detached 2D canvases as a safe offscreen equivalent; its purpose is deterministic diagnosis, not pixel-identical export from every GPU renderer.
