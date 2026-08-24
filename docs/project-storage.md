# Durable local project storage

Rig Studio treats browser IndexedDB/localStorage as a working cache. The canonical editable project lives under `.rigging-studio/projects/` and is written by the trusted localhost bridge started with `npm run dev:agent`.

Each managed directory uses a readable slug plus stable project ID:

```text
.rigging-studio/projects/<slug>--<project-id>/
  project.json
  project.json.bak
  rig.json
  rig.json.bak
  animations.json
  animations.json.bak
  source/
  parts/
  masks/
  previews/
  exports/
  diagnostics/
```

`storageVersion: 1` is validated on load. Large data-URL images and byte masks are replaced in canonical JSON by project-relative managed references and restored on open. Rig and animation schemas are validated independently. Missing assets and invalid manifests are reported rather than replaced with a valid-looking placeholder.

Manifest and authoring JSON replacements use a same-directory temporary file, flush the temporary file, retain the prior valid file as `.bak`, and atomically rename the new file. Saves are queued per project, and an expected `modifiedAt` guard prevents overwriting a project changed externally after open.

The top project-storage control reports one of `SAVED TO DISK`, `SAVING…`, `LOCAL CACHE ONLY`, `SAVE FAILED`, or `UNSAVED`. Browser-only projects can be migrated with **Persist to Disk**. The compact launcher lists disk projects, opens them without relying on browser cache, supports Save As, imports portable `.project.zip` snapshots, writes explicit snapshots to `exports/<timestamp>/`, reveals known managed directories, and archives to `.rigging-studio/trash/` after confirmation.

Use **Choose Folder** in the project-storage popover on macOS to select a persistent custom root through the trusted local bridge. The selection is stored in `.rigging-studio/storage-config.json`. On other platforms, or for automated sessions, set `RIGGING_STUDIO_PROJECTS_ROOT=/absolute/path` before starting the bridge. The environment override takes precedence. Browsers are never given arbitrary filesystem methods. The default remains the repository-local `.rigging-studio/projects/` root.

Normal working projects are ignored by Git. Only `.rigging-studio/projects/.gitkeep` is tracked; intentional golden fixtures belong under `tests/fixtures/` later.
