# Trusted ComfyUI workflows

Only API-format workflow files paired with a validated `*.manifest.json` in this directory can run through Rigging Studio. MCP callers cannot submit graph JSON or choose filesystem output paths.

`character-generation.json` uses only standard ComfyUI nodes. Set `COMFYUI_CHECKPOINT` to an installed checkpoint filename. Repair capabilities intentionally remain unavailable until a compatible, reviewed manifest/workflow pair is added; the Studio reports those capabilities as unavailable instead of simulating them.
