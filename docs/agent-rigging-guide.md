# Agent-controlled Rigging Studio

Rigging Studio exposes its real authoring operations through a local Model Context Protocol (MCP) server. The browser UI, built-in generation tools, and MCP clients all use the same `RiggingCommandService`; MCP is not a second editor and does not edit project files behind the Studio.

## Start the Studio and bridge

From the repository root:

```bash
npm install
npm run dev:agent
```

This starts the browser Studio and the stdio MCP server together. The site opens directly to the full Rig Editor at `/`; there is no landing, demo, or pilot gate. Open the local URL printed by the `STUDIO` process and keep that editor tab open.

To run the processes separately:

```bash
# terminal 1
npm run dev

# terminal 2
npm run mcp
```

For a local end-to-end protocol check while the editor is open, run `npm run mcp:smoke`. It performs one validated head-bone rotation through a real stdio MCP client and deliberately leaves the edit in normal UI history so you can verify Undo.

The MCP process speaks stdio to the agent and hosts a localhost-only control bridge on `127.0.0.1:47831`. The browser prefers WebSocket and automatically falls back to same-origin-style HTTP polling when a browser environment blocks page WebSockets. It reconnects after an MCP restart. The editor top bar reports `Agent bridge · Connected` and shows a compact session-local activity history.

```text
Claude Code or Codex
        ⇅ MCP stdio
local MCP server
        ⇅ localhost WebSocket (HTTP polling fallback)
RiggingCommandService + StudioSession
        ⇅
Rig/animation histories, providers, validators, renderer
        ⇅
React UI and Pixi viewport
```

No DOM automation is involved. The bridge binds only to `127.0.0.1`, never evaluates code, and can write only generated preview PNGs into `.rigging-studio/previews/`.

## Claude Code setup

Claude Code supports project-scoped stdio servers. Run this from the Rigging Studio repository:

```bash
claude mcp add --transport stdio --scope project rigging-studio -- npm run mcp
claude mcp list
```

The project-scoped entry is written to `.mcp.json`; Claude Code asks for approval before using a project server. In Claude Code, `/mcp` shows connection state. Keep the command and its options after `--`; put Claude CLI options such as `--scope` before the server name.

Equivalent project-local `.mcp.json` shape:

```json
{
  "mcpServers": {
    "rigging-studio": {
      "type": "stdio",
      "command": "npm",
      "args": ["run", "mcp"]
    }
  }
}
```

See the [official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) for current scope, command, and trust behavior.

## Codex setup

From the repository root, register the same generic stdio server:

```bash
codex mcp add rigging-studio -- npm run mcp
codex mcp list
```

For a trusted project-local configuration, add this to `.codex/config.toml`:

```toml
[mcp_servers.rigging_studio]
command = "npm"
args = ["run", "mcp"]
cwd = "."
```

Use `/mcp` in an interactive Codex session to inspect the connection. Codex supports stdio and Streamable HTTP MCP transports; this integration intentionally starts with stdio. See the [official OpenAI MCP documentation](https://developers.openai.com/codex/mcp).

## How agents should operate

1. Call `studio_get_status` before acting. Check the active project, selected animation/bone, validation state, warnings, and live UI capability.
2. Prefer high-level operations such as `character_create_from_prompt`, `animation_generate`, and `animation_revise` over long primitive call sequences.
3. Stop at returned review boundaries. Source generation, segmentation/occlusion repair, and rig proposals are preview-only until an explicit acceptance command.
4. Use `rig_get_summary` and `animation_get_summary`; request full data only when a targeted inspection genuinely needs it.
5. Render a preview after meaningful animation changes. Inspect `rigging://active-project/preview/latest` or the returned local image path.
6. Use transactions for related rig edits. Commit a successful group or roll it back; do not leave a partial invalid pose.
7. Prefer small reversible changes. Agent rig and animation edits enter normal editor history, so human Cmd/Ctrl+Z can undo them.
8. Run `validation_get` before saving. Report warnings instead of hiding them.
9. Do not manually edit generated project files or raw JSON unless the user explicitly asks for import/export.
10. Never attempt to bypass the Studio validators or call unrelated shell/filesystem tools as a substitute for this application API.

## Tool surface

The initial server exposes:

- Session: `studio_get_status`.
- Projects: `project_create`, `project_open`, `project_save`, `project_export`.
- Character generation: `character_set_prompt`, `character_generate_image`, `character_get_generation`, `character_accept_generation`, `character_run_suitability_check`, `character_create_from_prompt`.
- Parts: `character_segment`, `character_get_parts`, `character_update_part`, `character_repair_occlusion`.
- Rig: `rig_create_proposal`, `rig_accept_proposal`, `rig_get_summary`, `rig_move_bone`, `rig_rotate_bone`, `rig_set_pivot`, `rig_set_parent`, `rig_set_slot_attachment`, `rig_set_slot_z_index`.
- Appearance: `character_apply_skin`, `character_set_equipment`.
- Animation: `animation_list`, `animation_create`, `animation_generate`, `animation_revise`, `animation_get_summary`, `animation_set_keyframe`, `animation_delete_keyframe`, `animation_delete`, `animation_play`, `animation_pause`, `animation_seek`.
- Review: `preview_render`, `preview_get_last`, `validation_get`, `project_run_smoke_test`.
- Compound edits: `transaction_begin`, `transaction_commit`, `transaction_rollback`.
- Image production status: `image_provider_status`, `image_provider_list_capabilities`, `comfy_get_status`.
- Trusted Comfy proposals: `image_generate_candidates`, `character_generate_with_comfy`, `image_get_proposal`, `image_get_candidates`, `image_get_candidate`, `image_render_candidate_sheet`.
- Image review: `image_review_proposal`, `image_approve_candidate`, `image_reject_candidate`, `image_regenerate_proposal`, `image_set_approval_policy`, `image_cancel_proposal`.

There are deliberately no tools for arbitrary JavaScript, shell commands, filesystem writes, evaluation, or raw state replacement. Destructive tools require `confirm: true`. All inputs are strict Zod schemas: unknown keys, non-finite transforms, invalid properties, excessive times, missing IDs, and malformed project imports are rejected as structured errors.

## Read-only resources

- `rigging://active-project` — live session and project status.
- `rigging://active-project/rig` — full validated active rig.
- `rigging://active-project/animations` — concise animation summaries.
- `rigging://active-project/warnings` — shared validation results.
- `rigging://active-project/preview/latest` — latest PNG contact sheet.
- `rigging://image-proposals/{proposalId}/candidates/{candidateId}` — a managed proposal candidate; reading records inspection evidence.
- `rigging://image-proposals/{proposalId}/contact-sheet` — the managed candidate sheet; reading records inspection evidence.

These resources expose only Studio authoring data. Environment variables, provider credentials, browser storage outside the active project, and unrelated repository files are never exposed.

## Full-character example

User request:

> Create a chunky goblin blacksmith with a huge hammer, rig him, and give him idle, walk, and attack animations.

A sensible agent sequence is:

```text
studio_get_status
character_create_from_prompt (autoAcceptSafeSteps: false)
character_get_generation
character_accept_generation (confirm: true)
character_segment
character_get_parts
rig_create_proposal
rig_accept_proposal (confirm: true)
animation_generate (idle)
animation_generate (walk)
animation_generate (attack)
preview_render (each animation)
validation_get
project_save
```

The agent must describe what it created, surface all remaining warnings, and say where source art, segmentation, joints, pivots, or motion still deserve human review.

## Revision example

For “The walk looks too floaty. Make him look heavier,” the agent should inspect the current animation and warnings, call `animation_revise`, render a 12-frame locomotion contact sheet, inspect the preview, optionally make one additional explicit revision, run validation, and leave the result selected in Studio. No JSON copying is needed.

## Undo and transactions

An agent bone move calls the same immutable `RigCommandHistory.execute` path as the inspector. An agent animation edit calls the same `AnimationCommandHistory.execute` path as the dope sheet. The editor’s Undo command therefore reverses the most recent agent edit normally.

`transaction_begin` opens a rig-history transaction. Every subsequent rig transform updates the transaction preview but does not add an undo entry. `transaction_commit` creates one undo entry for the whole group; `transaction_rollback` restores the exact pre-transaction rig and creates none. Only one transaction and one authoring project are supported in this first version.

## Preview inspection

`preview_render` asks the browser-side deterministic diagnostic renderer for a contact sheet; this is necessary because attachment images and the live rig are already available there. The response includes render ID, frame times, dimensions, diagnostics, resource URI, and a fixed local PNG path. The MCP process removes the base64 payload from the text result after safely writing it under `.rigging-studio/previews/`.

Preview rendering samples authoring time in seconds and never captures editor chrome. Supported overlays are bones, bone names, joints, slot bounds, ground, root trajectory, foot trajectories, and motion arcs. The current image review is diagnostic, not a substitute for motion judgment at full game speed.

## Current deliberate limits

- One browser Studio session and one active authoring project.
- Rig transactions only; animation operations are already atomic one-command edits.
- The local mock providers make automated tests free and deterministic. A configured provider endpoint remains a separate user-controlled choice.
- Source and reconstruction steps still stop at review boundaries.
- A browser tab must remain open for live Pixi rendering and UI synchronization.
- MCP preview files are ephemeral development artifacts and are gitignored.

## First Claude Code test prompt

Paste this exactly after the bridge shows Connected:

> Inspect the current Rigging Studio session. Create a heavy looping walk animation for the active rig named `heavy_walk`, render a 12-frame contact sheet with bones, ground, and foot trajectories, run validation, and leave the new animation selected in the editor. Use only the Rigging Studio MCP tools, make no manual file edits, and report the preview path plus every remaining warning.
# External ImageGen ingress

When novel artwork is required and the configured Studio provider reports `generationMode: "fixture"`, stop before suitability and generate the image with the available external image tool. Then call `character_import_generation` with the active `projectId`, provider/generation identifiers, prompt, and either an approved `local_path`, a PNG/JPEG `data_url`, or an approved `provider_asset` path.

The MCP server validates the source, reads its real dimensions, copies it into `.rigging-studio/generations/`, and sends a managed reference into the same `GeneratedCharacterProject` pipeline used by `character_generate_image`. Call `character_get_generation` and require `novelArtwork === true` before continuing to suitability or segmentation.

Local paths are limited to the Studio ingress directory, bundled rig-test assets, configured ingress roots, and the Codex ImageGen `generated_images` directory. The caller cannot choose the managed destination.

For novel-required orchestration, pass `requireNovelArtwork: true` to `character_create_from_prompt`. With only the fixture provider configured, the command returns `stageReached: "awaiting_generation"` and `requiresExternalGeneration: true` instead of creating fixture art.

# Agent diagnostics export

Use `diagnostics_export_report` for `torture_test`, `project_validation`, or `agent_run` JSON plus optional Markdown. Use `diagnostics_export_torture_test` for the canonical torture-test files. Both tools write only below `.rigging-studio/diagnostics/`; filenames are sanitized and revisions are timestamped unless explicit overwrite is requested.

# ComfyUI proposal workflow

Start ComfyUI separately, configure `COMFYUI_CHECKPOINT`, then start Rigging Studio with `npm run dev:agent`. The agent sequence is:

```text
studio_get_status
comfy_get_status
project_create
character_generate_with_comfy
image_render_candidate_sheet or image_get_candidate
image_review_proposal
image_approve_candidate
```

`character_generate_with_comfy` stops at `awaiting_review`. The default `manual` policy lets an agent recommend but requires the user to approve in the Studio ComfyUI popover. `agent_recommendation` allows the agent to approve only after it has retrieved candidate pixels in the current connected session and submitted a structured non-rejecting review. There is no score-threshold or unattended approval mode. See [comfyui-integration.md](comfyui-integration.md) for workflow installation and security details.

## First ComfyUI agent prompt

> Inspect Rigging Studio and local ComfyUI status. Create a new character project for “Small stocky goblin alchemist with olive-green skin, leather apron, potion belt, oversized gloves, and a crooked wooden stirring staff; clean side view, neutral modular cutout stance.” Generate three candidates with `character_generate_with_comfy`, retrieve and visually inspect the contact sheet, submit a structured recommendation, and stop before approval because the default policy is manual. Use only Rigging Studio MCP tools and report every suitability warning.
