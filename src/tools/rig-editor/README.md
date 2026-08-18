# Rig editor

The editor owns immutable authoring snapshots, command history, draft serialization, and safe document operations. Pixi preview state remains disposable runtime state and never becomes the source of setup-pose truth.

This pass supports setup-pose bones, slots, attachments, skins, local uploads, import/export, viewport manipulation, and animation preview. Timeline keyframe authoring remains intentionally excluded.
