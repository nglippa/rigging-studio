# ComfyUI image-production integration

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
  → ImageProductionService
  → trusted workflow registry
  → ComfyUIAdapter
  → localhost ComfyUI
  → managed ImageProposal candidates
  → inspection + structured review
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
# Terminal 1 — from the local ComfyUI checkout/installation
python main.py --listen 127.0.0.1 --port 8188

# Terminal 2 — Rigging Studio repository
export COMFYUI_CHECKPOINT='your-installed-checkpoint.safetensors'
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

The repository includes one honest core-node `CHARACTER_GENERATION` graph. It becomes available when `COMFYUI_CHECKPOINT` names an installed checkpoint. `CHARACTER_VARIANT`, `OCCLUSION_RECONSTRUCTION`, `PART_REPAIR`, `BACKGROUND_REMOVAL`, `ALPHA_EDGE_CLEANUP`, `EQUIPMENT_VARIANT`, and `HAND_REPAIR` remain explicitly unavailable until a reviewed manifest/API-workflow pair is installed. Missing files, renamed nodes, missing custom node classes, and missing checkpoints are reported rather than simulated.

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

Approval verifies proposal ownership and state, copies the selected candidate into `.rigging-studio/generations/`, marks it `novelArtwork: true`, `generationMode: provider_generated`, and `provider: comfyui`, and sends the normalized image through `character_import_generation`. Character/background/alpha generation approvals become the normal project generation. Occlusion, part, and hand repair approvals update the existing reconstructed-part review while preserving the original. Project `imageProductionHistory` records proposal, candidate, workflow, operation, policy, target part, and acceptance time.

## Repair workflows

Occlusion reconstruction, part repair, and hand repair use the same proposal lifecycle and require `targetPartId`. Trusted workflows may bind an uploaded source and mask to declared Comfy input nodes; the adapter exposes upload support, but no repair capability is advertised until its complete manifest/workflow pair exists. An approved reconstruction is stored beside the original and enters `reconstructedParts`; it never silently replaces the source fragment.

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

- Status: `image_provider_status`, `image_provider_list_capabilities`, `comfy_get_status`.
- Generate: `image_generate_candidates`, `character_generate_with_comfy`.
- Inspect: `image_get_proposal`, `image_get_candidates`, `image_get_candidate`, `image_render_candidate_sheet`.
- Decide: `image_review_proposal`, `image_approve_candidate`, `image_reject_candidate`, `image_regenerate_proposal`, `image_set_approval_policy`, `image_cancel_proposal`.
- Images: `rigging://image-proposals/{proposalId}/candidates/{candidateId}` and `rigging://image-proposals/{proposalId}/contact-sheet`.

The contact sheet contains only candidates, IDs, seeds, true dimensions, and optional suitability scores; it does not capture editor chrome.

## Known limitations

- The checked-in generation graph is a generic core-node baseline; final art quality depends on the user's checkpoint and prompt compatibility.
- Repair/variant/background/alpha capabilities require user-supplied reviewed workflows and remain unavailable until installed.
- Suitability analysis depends on the configured character pipeline provider; the local fixture analyzer is deterministic and not a vision-quality guarantee.
- Candidate sheets require the browser Studio because browser canvas safely composes the managed images and labels.
- Progress polling reports queue/sampling/collecting phases; granular percentage is available only when the provider supplies it.
- One local Studio session is authoritative, and Comfy candidate concurrency is intentionally one.

## First agent prompt after setup

> Inspect the current Rigging Studio and ComfyUI status. Create a new generated-character project for “Small stocky goblin alchemist with olive-green skin, leather apron, potion belt, oversized gloves, and a crooked wooden stirring staff. Stylized high-quality 2D fantasy game character, clean side view, neutral stance, modular body parts suitable for skeletal cutout animation.” Generate three candidates through `character_generate_with_comfy`, retrieve and visually inspect the contact sheet, submit a structured recommendation naming the best candidate and the suitability problems in every candidate, and stop at the manual approval boundary. Do not edit files or approve on score alone.
