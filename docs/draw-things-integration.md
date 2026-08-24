# Draw Things local generation

Rigging Studio uses Draw Things only as a local character-creation provider. Every output becomes an `ImageProposal`, requires visual inspection, follows the project's `manual` or `agent_recommendation` approval policy, and enters `GeneratedCharacterProject` only after approval. ComfyUI remains responsible for segmentation, mask refinement, reconstruction, inpainting, background removal, and alpha repair.

The supported mechanism was discovered from the official Draw Things community source: its `HTTPAPIServer` registers the Stable Diffusion-compatible `txt2img`, `img2img`, and options routes. The installed-machine audit found no Draw Things application bundle, app container, command-line binary, documented callable URL scheme, mounted external stack, or callable Shortcuts/App Intents surface. No GUI automation is used.

## Supported modes

`direct` calls the official Draw Things localhost HTTP API:

- readiness: `GET /sdapi/v1/options`
- generation: `POST /sdapi/v1/txt2img`
- default URL: `http://127.0.0.1:7860`

Enable the HTTP API in Draw Things, then set:

```dotenv
DRAW_THINGS_ENABLED=true
DRAW_THINGS_MODE=direct
DRAW_THINGS_BASE_URL=http://127.0.0.1:7860
```

Only credential-free localhost HTTP URLs are accepted. Rigging Studio does not expose raw scripts, shell execution, AppleScript, arbitrary URLs, or filesystem browsing.

`watched_folder` lets Draw Things generate independently. Rigging Studio waits for new PNG/JPEG exports, verifies that file size and modification time are stable, validates image structure/dimensions/color type, hashes content for deduplication, and reads optional embedded PNG text plus either `image.png.json` or `image.json` sidecars.

```dotenv
DRAW_THINGS_ENABLED=true
DRAW_THINGS_MODE=watched_folder
DRAW_THINGS_EXPORT_DIR=/absolute/path/to/draw-things/inbox
```

`auto` prefers the HTTP API and falls back to the configured watched folder. A missing `/Volumes/...` export directory is reported as a disconnected external volume; Rigging Studio does not silently choose another directory.

The single manual step in watched-folder mode is exporting the generated image from Draw Things into `DRAW_THINGS_EXPORT_DIR`. Detection, stability validation, metadata parsing, proposal creation, review, approval, and managed project import happen in Rigging Studio.

## Captured metadata

The adapter preserves known prompt, negative prompt, model/model hash, seed, sampler, steps, guidance, size, scheduler, LoRA, ControlNet, reference IDs, generation timestamp, and provider response/sidecar metadata. Unavailable known values remain `null`. Approved values flow into generation history and `CharacterConsistencyContext` for later ComfyUI repair and reconstruction.

## Provider-neutral tools

Agents use `image_provider_list`, `image_provider_status`, `character_generate`, `character_generate_variant`, `image_generation_get_job`, `image_generation_get_proposal`, `image_generation_render_proposal`, `image_generation_approve_candidate`, and `image_generation_reject_candidate`. Existing ComfyUI diagnostics remain available. Generation tools return jobs immediately; candidates cannot be approved without current-session visual inspection and the configured approval policy.

## Troubleshooting and local-only behavior

- **Setup required:** set `DRAW_THINGS_ENABLED=true`, then enable the Draw Things HTTP API or configure an existing export directory.
- **App not running / API unavailable:** verify the configured localhost port and Draw Things API setting. Rigging Studio never falls back to a remote URL.
- **Model unavailable:** choose an installed model name. Discovery reports the current model only when the official options surface supplies it.
- **Timed out waiting for export:** export a new image after the job begins. Existing files and previously imported hashes are ignored.
- **Incomplete/corrupt export:** wait for Draw Things to finish writing; Rigging Studio requires a stable, decodable PNG or complete JPEG.
- **External SSD disconnected:** remount the exact configured volume. No internal fallback directory is selected.
- **Metadata partial:** export a Draw Things PNG with embedded text metadata or place a same-name JSON sidecar beside it.

Rigging Studio sends direct-mode requests only to a credential-free localhost HTTP URL and reads watched outputs only from the explicitly configured directory. It does not upload prompts, images, or metadata. This describes Rigging Studio's boundary; it does not make broader privacy claims about Draw Things configuration or downloaded models.

## Current machine

The Draw Things app, command-line tool, application container, and an external Draw Things volume were not detected during the 2026-08-21 implementation audit. A live generation therefore requires local setup; diagnostics correctly show **Draw Things — Setup required** until one of the supported modes is ready.
