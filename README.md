# Rigging Studio

A browser-based modular 2D skeletal rigging, animation, character-generation, and agent-assisted authoring studio built with React, TypeScript, Vinext, and PixiJS.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

The local site opens directly to the full Rig Editor at `/`. Start live MCP agent control with:

```bash
npm run dev:agent
```

See [docs/agent-rigging-guide.md](docs/agent-rigging-guide.md) for Claude Code and Codex setup, tools, resources, validation boundaries, undo behavior, and example workflows.

Optional local ComfyUI candidate generation is documented in [docs/comfyui-integration.md](docs/comfyui-integration.md). ComfyUI may remain offline; the editor, MCP bridge, external ImageGen ingress, and non-Comfy workflows continue to work.

## Main routes

- `/` — full Rig Editor with setup, animation, AI proposals, visual review, and live agent activity.
- `/create-character` — prompt-to-generation-to-parts-to-rig workflow.
- `/rig-lab` — focused runtime inspection surface.

## Useful Commands

- `npm run dev`: start local development
- `npm run mcp`: start the stdio MCP server and localhost browser bridge
- `npm run mcp:smoke`: run a live MCP-client-to-browser edit and validation check
- `npm run dev:agent`: start the Studio and MCP process together
- `npm run build`: verify the vinext build output
- `npm run typecheck`: verify strict TypeScript
- `npm run lint`: run ESLint
- `npm test`: run unit/MCP tests, production build, and rendered route tests
# rigging-studio
