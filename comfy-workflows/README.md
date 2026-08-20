# Trusted ComfyUI workflows

Only API-format workflow files paired with a validated `*.manifest.json` in this directory can run through Rigging Studio. MCP callers cannot submit graph JSON or choose filesystem output paths.

Checked-in capabilities:

- `CHARACTER_GENERATION` uses standard ComfyUI sampling nodes and `COMFYUI_CHECKPOINT`.
- `CHARACTER_SEGMENTATION` uses staged contextual crops, Grounding DINO detection, and SAM2 masks from `ComfyUI-SAM2`; the service remaps every crop mask into locked source coordinates and records the detector phrase and safety score.
- `MASK_REFINEMENT` changes one named mask with Grounding DINO + SAM2 and `MaskComposite`.
- `OCCLUSION_RECONSTRUCTION` uses localized core-node inpainting, composites only the reviewed missing region over the original source, and uses `COMFYUI_CHECKPOINT`.

Set `COMFYUI_SAM2_MODEL` and `COMFYUI_GROUNDING_DINO_MODEL` to the exact loader option strings reported by ComfyUI. Background removal and alpha cleanup remain unavailable until reviewed trusted workflow pairs are added; the Studio reports the exact missing capability instead of simulating it.
