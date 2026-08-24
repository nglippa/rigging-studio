# ComfyUI image-production integration

## Image-production roles

```text
                         ┌─ Draw Things ─ character creation / variants
ImageProductionService ─┤
                         └─ ComfyUI ─ segmentation / repair / reconstruction
```

Both creation providers feed the same `ImageProposal` inspection and approval boundary. Draw Things does not replace or emulate the trusted ComfyUI workflows documented below.

## Implementation plan

Rigging Studio keeps image generation proposal-driven. A server-side, provider-neutral image-production service owns trusted workflow discovery, ComfyUI communication, managed proposal assets, inspection evidence, and approval policy. ComfyUI API-format graphs remain private implementation details behind manifest bindings. A candidate reaches the existing `GeneratedCharacterProject` pipeline only after an explicit approval routes it through the established managed-generation ingress.

The implementation is intentionally incremental:

1. Validate provider-neutral proposal, review, progress, and trusted-workflow data.
2. Connect to localhost ComfyUI with bounded queue submission, polling, output retrieval, uploads, interruption, and actionable errors.
3. Load only checked-in manifest/workflow pairs and report missing capabilities honestly.
4. Store every candidate and proposal under the managed `.rigging-studio/image-production` tree.
5. Require visual inspection evidence and the configured approval policy before project ingress.
6. Expose narrow MCP tools/resources and a compact Studio status/review surface while allowing Studio to run normally with ComfyUI offline.

The completed architecture, setup, workflow manifest format, security boundaries, and operational instructions are documented below as part of this implementation pass.

## Architecture and data flow

```text
Claude Code / Codex
  → Rigging Studio MCP tools
  → ImageProductionService / ComfyCharacterPipelineService
  → trusted workflow registry
  → ComfyUIAdapter
  → localhost ComfyUI
  → managed image/mask/reconstruction proposals
  → semantic mask or reconstruction inspection
  → explicit approval
  → existing managed generation ingress
  → GeneratedCharacterProject / existing repair records
```

The application core uses `ImageProposal`, `ImageCandidate`, and semantic capability names. Only `ComfyUIAdapter` and the workflow registry understand API-format Comfy graphs. ComfyUI output is never assigned to `sourceImage` merely because execution completed.

The adapter follows ComfyUI's supported server routes: `/queue` for reachability/queue state, `/object_info` for node and checkpoint discovery, `POST /prompt` for validated queue submission, `/history/{prompt_id}` for bounded completion polling, `/view` for declared outputs, `/upload/image` for trusted repair workflows, and `/interrupt`/`POST /queue` for cancellation. Browser or Playwright automation is not used.

## Local connection and startup

ComfyUI defaults to `http://127.0.0.1:8188`. `COMFYUI_BASE_URL` accepts only plain HTTP localhost hosts (`127.0.0.1`, `localhost`, or loopback IPv6); callers cannot override it per request. Rigging Studio starts normally when ComfyUI is absent.

Recommended Mac mini startup:

```bash
# Terminal 1 — from the user's local ComfyUI checkout (no checkout path is configured in this repository)
python3 main.py --listen 127.0.0.1 --port 8188

# Terminal 2 — configured Rigging Studio repository
cd /Users/nicholaslippa/Projects/rigging-studio
export COMFYUI_CHECKPOINT='your-installed-checkpoint.safetensors'
export COMFYUI_SAM2_MODEL='exact SAM2 loader option'
export COMFYUI_GROUNDING_DINO_MODEL='exact Grounding DINO loader option'
npm run dev:agent
```

Or run `npm run dev` and `npm run mcp` in separate Rigging Studio terminals. The editor top bar reports the MCP bridge and ComfyUI independently. `comfy_get_status` reports the configured URL, reachability, queue counts, trusted capability state, and missing dependencies without exposing environment values or system statistics.

Defaults are conservative for local Apple hardware: three candidates, a hard maximum of four, sequential execution (concurrency one), and a ten-minute bounded workflow timeout. `COMFYUI_EXECUTION_TIMEOUT_MS` may be raised for a known slow local graph. The Studio never assumes CUDA or manages checkpoints.

## Trusted workflow registry

Trusted workflows live in `comfy-workflows/` as an API-format JSON graph plus a `*.manifest.json`. A manifest declares:

```json
{
  "manifestVersion": 1,
  "id": "character_generation_v1",
  "capability": "CHARACTER_GENERATION",
  "workflowFile": "character-generation.json",
  "description": "Core-node modular character generation",
  "inputs": {
    "positivePrompt": { "nodeId": "6", "field": "text", "required": true },
    "seed": { "nodeId": "3", "field": "seed", "required": true }
  },
  "outputs": { "images": { "nodeId": "9" } },
  "requiredNodeClasses": ["KSampler", "SaveImage"],
  "requiredModels": ["COMFYUI_CHECKPOINT"]
}
```

All manifest paths, node IDs, input fields, required classes, and the declared output node validate before use. The service clones the trusted graph and binds only declared values. MCP input has no graph field, base-URL field, or output-path field.

The repository includes trusted graphs for `CHARACTER_GENERATION`, `CHARACTER_SEGMENTATION`, `MASK_REFINEMENT`, and `OCCLUSION_RECONSTRUCTION`. Segmentation/refinement require the `ComfyUI-SAM2` custom nodes `SAM2ModelLoader (segment anything2)`, `GroundingDinoModelLoader (segment anything2)`, and `GroundingDinoSAM2Segment (segment anything2)`, plus model selector values in `COMFYUI_SAM2_MODEL` and `COMFYUI_GROUNDING_DINO_MODEL`. Reconstruction uses standard `VAEEncodeForInpaint` and `ImageCompositeMasked` nodes plus `COMFYUI_CHECKPOINT`. Other capabilities remain explicitly unavailable until a reviewed pair is installed. Missing files, manifest mismatches, node classes, and model settings are reported rather than simulated.

The upstream [`ComfyUI-SAM2` installation](https://github.com/neverbiasu/ComfyUI-SAM2) requires its `requirements.txt`. Its README places Grounding DINO config/checkpoint files under `<ComfyUI>/models/grounding-dino`, SAM2 checkpoints under `<ComfyUI>/models/sam2`, and BERT files under `<ComfyUI>/models/bert-base-uncased` (or permits supported automatic downloads). Rigging Studio does not clone the node or download these models. After ComfyUI starts, use the exact loader option strings shown by ComfyUI for the two environment variables; the startup dependency check verifies those values against `/object_info`.

To add or replace a workflow, export it from ComfyUI in API format, keep all input/output file behavior inside ComfyUI's own managed directories, add a strict manifest beside it, restart `npm run mcp`, and call `image_provider_list_capabilities`. Do not add arbitrary pass-through bindings.

## Proposal lifecycle

`image_generate_candidates` accepts a semantic operation, prompt, bounded dimensions/settings, and one to four candidates. `character_generate_with_comfy` reuses the existing modular-character prompt builder and automatically includes the established side-view, complete anatomy, separable limbs/equipment, simple background, and segmentation-friendly constraints.

Candidates run sequentially. A failed later candidate does not discard completed candidates. Proposal state is persisted after each meaningful transition:

```text
generating → awaiting_review → approved
                           ↘ rejected
generating → failed (only when no candidate succeeds)
```

Each candidate records its seed, true image dimensions, workflow/prompt IDs, warnings, suitability review aids when the connected browser analyzer is available, and `generated`/`recommended`/`approved`/`rejected` status. Suitability scores are review aids, never automatic approval rules.

`image_get_candidate` and `image_render_candidate_sheet` return actual MCP image content. Reading either image resource records its resource ID, timestamp, candidate IDs, and connected Studio session ID. A structured `image_review_proposal` may recommend, accept, or reject each candidate, but does not perform ingress.

Controlled regeneration creates a child proposal with `parentProposalId`. The hard limit is two proposal rounds for one generation stage. There are no automatic regeneration loops or automatic provider resubmissions after workflow failures.

## Approval policies

New proposals default to `manual`:

- An agent may inspect and recommend.
- `image_approve_candidate` returns `requiresHumanApproval: true`.
- The user opens the compact ComfyUI panel in the editor, sees the actual candidates, and clicks Approve or Reject.

`agent_recommendation` is an explicit per-project/session choice through `image_set_approval_policy`. Agent approval then requires both current-session pixel inspection and a structured review whose decision is not reject. There is no unattended score-based policy.

Generic generation approval verifies proposal ownership and state, copies the selected candidate into `.rigging-studio/generations/`, marks it `novelArtwork: true`, `generationMode: provider_generated`, and `provider: comfyui`, and sends it through `character_import_generation`. Segmentation, mask-refinement, and occlusion-reconstruction artifacts are deliberately blocked from that ingress: they must use the part-review acceptance tools, which preserve the original mask/fragment and update the normal `GeneratedCharacterProject` only after review.

## Segmentation, refinement, and reconstruction

`CHARACTER_SEGMENTATION` runs a staged source-conditioned plan: foreground and equipment anchors first, then head/torso, explicit anatomical left/right limb chains, and optional detail targets. Each target uses a configurable registry of short detector phrases and a declared contextual source crop; crop masks are remapped to exact source coordinates before scoring. The scorer uses size, position, hierarchy, semantic geometry, and cross-mask overlap to record a clearly labeled `heuristic` confidence and a `SAFE` or `REVIEW` gate. Empty, broad, duplicate, semantically implausible, or catastrophically overlapping masks remain unresolved or review-only. The installed combined GroundingDINO→SAM2 node does not expose detector boxes, calibrated detector confidence, separate detector/SAM timing, point prompts, or multimask choice, so those fields are explicitly recorded as unavailable rather than invented. The Part Cutter renders the source plus actual alpha overlays, safety status, detector phrase, and confidence source; no part is accepted automatically.

`MASK_REFINEMENT` requires one unambiguous `targetPartId`. It uploads the current full-canvas mask, produces a new source-conditioned SAM2 mask from the correction prompt, and adds or subtracts it using the trusted graph. Unrelated proposal objects are copied byte-for-byte. The review UI reports source-coordinate pixels added/removed and bounding-box changes; rejection leaves the parent proposal intact.

`OCCLUSION_RECONSTRUCTION` requires a user-reviewed missing-area mask and `CharacterConsistencyContext`. It performs localized inpainting on the original full canvas, composites only that missing region back over the original source, crops to the locked part bounds, and rebuilds alpha from the visible-part plus reconstruction masks so neighboring anatomy/background cannot become part pixels. The candidate remains separate from the source until consistency metrics, the -20°/0°/+20° view, and explicit approval are complete.

Background removal and alpha-edge cleanup are similarly proposal-driven. Alpha cleanup targets matte fringe, bright/dark halos, and rough transparency only when explicitly requested. Originals remain in generation history. The repository does not automatically run cleanup on every asset.

## Managed assets and inspection UI

Unapproved assets live under:

```text
.rigging-studio/image-production/proposals/<proposal-id>/
  metadata.json
  candidate-01-<digest>.png
  candidate-02-<digest>.png
  candidate-contact-sheet.png
```

Approved images are copied into `.rigging-studio/generations/`. IDs, filenames, real paths, image signatures, byte limits, dimensions, and directory containment are validated. Callers cannot choose these destinations. Rejected assets remain for reproducibility and diagnostics; no cleanup API is included in this pass.

The editor's compact ComfyUI popover shows provider/queue state, proposal progress, actual candidates, dimensions, seeds, suitability scores, policy, and explicit approval/rejection controls. React polls low-frequency status only; it is not involved in Comfy execution or game/animation frame loops.

## Privacy, cost, and failure handling

For character generation, ComfyUI receives only the built rig-oriented prompt, negative prompt, bounded dimensions, seed, steps, guidance, selected checkpoint, and the trusted graph. Repair graphs may additionally receive only the selected managed source/mask. Unrelated editor state and project files are not sent. Secrets are not stored in client code.

Comfy offline, queue rejection, graph validation, missing nodes/models, execution errors, timeouts, invalid/no output, partial success, and connection loss produce actionable proposal warnings/errors. Existing candidates remain persisted. The adapter issues one bounded request/poll sequence and does not automatically resubmit expensive jobs. The Studio and all non-Comfy workflows remain available.

## MCP tools and resources

- Status: `image_provider_status`, `image_provider_list_capabilities`, `comfy_get_status`, `segmentation_status`.
- Cut/repair: `character_ai_cut`, `part_refine_mask`, `part_reconstruct_hidden`.
- Reconstruction review: `part_get_reconstruction_proposal`, `part_render_reconstruction_preview`, `part_approve_reconstruction`, `part_reject_reconstruction`.
- Optional repair status: `background_remove`, `alpha_cleanup` return exact unavailable reasons until trusted graphs exist.
- Generate: `image_generate_candidates`, `character_generate_with_comfy`.
- Inspect: `image_get_proposal`, `image_get_candidates`, `image_get_candidate`, `image_render_candidate_sheet`.
- Decide: `image_review_proposal`, `image_approve_candidate`, `image_reject_candidate`, `image_regenerate_proposal`, `image_set_approval_policy`, `image_cancel_proposal`.
- Images: `rigging://image-proposals/{proposalId}/candidates/{candidateId}` and `rigging://image-proposals/{proposalId}/contact-sheet`.
- Part review: `rigging://active-project/segmentation/{proposalId}` and `rigging://active-project/reconstruction/{partId}`. Reading the reconstruction sheet records inspection evidence.

The contact sheet contains only candidates, IDs, seeds, true dimensions, and optional suitability scores; it does not capture editor chrome.

## Known limitations

- The checked-in generation graph is a generic core-node baseline; final art quality depends on the user's checkpoint and prompt compatibility.
- `ComfyUI-SAM2` and its SAM2/Grounding DINO models are user-installed dependencies; Rigging Studio does not install nodes or download models.
- Background removal, alpha cleanup, generic part repair, and variants remain unavailable until reviewed trusted workflows are installed.
- Suitability analysis depends on the configured character pipeline provider; the local fixture analyzer is deterministic and not a vision-quality guarantee.
- Candidate sheets require the browser Studio because browser canvas safely composes the managed images and labels.
- Progress polling reports queue/sampling/collecting phases; granular percentage is available only when the provider supplies it.
- One local Studio session is authoritative, and Comfy candidate concurrency is intentionally one.
- No ComfyUI checkout path or required model selector is configured in this repository; startup diagnostics remain unavailable until the user supplies them.

## First agent prompt after setup

> Inspect the current Rigging Studio and ComfyUI status. Create a new generated-character project for “Small stocky goblin alchemist with olive-green skin, leather apron, potion belt, oversized gloves, and a crooked wooden stirring staff. Stylized high-quality 2D fantasy game character, clean side view, neutral stance, modular body parts suitable for skeletal cutout animation.” Generate three candidates through `character_generate_with_comfy`, retrieve and visually inspect the contact sheet, submit a structured recommendation naming the best candidate and the suitability problems in every candidate, and stop at the manual approval boundary. Do not edit files or approve on score alone.
