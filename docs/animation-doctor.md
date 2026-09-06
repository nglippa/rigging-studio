# Animation Doctor

Animation Doctor reviews an existing clip and offers exact-key replacements. Open **Review Motion** in the Animate toolbar. Review, select edits, preview the selected subset, then accept or reject. Acceptance is one existing animation-history command; the toolbar's Undo restores it exactly.

The optional local bridge invokes the exact `gpt-6-astra` model through the authenticated `codex` executable on its PATH. There is no model fallback. A missing, incompatible, unauthenticated, or offline provider leaves editing available. No API keys are requested or stored. The provider requires a CLI and account that actually support this model; CLI installation alone is not proof of model availability.

## State and commands

`RiggingCommandService` continues to own the live project, lifecycle and history. `captureMotionReviewIdentity` captures project ID, session token, revision, clip ID and the existing canonical project digest. `applyMotionReview` rechecks that identity, strictly validates the proposal, checks current key values, runs canonical project validation and calls the normal animation command history.

The agent receives a focused packet, never the project snapshot: source image or clearly labeled rest-render fallback, bones, current clip channels, selected-skin equipment context, six diagnostic frames including the literal end pose, world motion paths and metrics. Existing `DiagnosticFrameRenderer`, animation evaluation, world transforms, slot resolution and project validators are reused.

Only existing `rotation`, `x` and `y` keys can change in this slice. Channel creation, timing, scaling, key insertion/removal, rig topology, Prepare ownership and arbitrary JSON mutation are unavailable. Each edit identifies a bone/property/time and supplies its current value, proposed value, reason, expected effect, confidence and evidence IDs. Extra schema fields, non-finite numbers, duplicate targets and missing references are rejected.

The detached review session implements inspect → propose → validate → candidate → render → compare. The baseline and up to three candidates stay in memory for review. A candidate needs canonical validity, non-regressing measured metrics, no visual regression, and either measured or visual improvement. Rejected candidates never replace the live document or best candidate. Cumulative edits are rechecked against the original bounds. Acceptance of a selected subset rerenders and remeasures that subset before user approval.

## Frozen limits and measurements

| Contract | Limit |
| --- | --- |
| Mutation iterations | 3 |
| Tool calls, including provider reviews and rendering | 12 |
| Render requests | 8 |
| Edits, including cumulative net edits | 24 |
| Rotation change per key | ±15° from original |
| Translation change per key | min(12 px, 2.5% of smaller canvas dimension) |
| Full review timeout | 300 seconds |
| Single provider timeout | 150 seconds |
| Extra evidence rounds | 2 serviced rounds followed by final review |
| Loop endpoint tolerance | 0.5 world pixels |
| Authored grip tolerance | 1 world pixel |

The schema can request one existing bone or another pose at a bounded time. The host services those requests; the model has no filesystem, shell, project-editing or general network tool. Initial channel, rig, equipment and motion-path inspection are combined into the focused packet instead of duplicate MCP queries. Broad CLI tools are disabled, user configuration/rules ignored, and only managed PNGs with matching SHA-256 hashes are attached. Process stdout/stderr are not persisted as audit content.

Foot drift uses **authored** bone/contact windows; grip error uses **authored** hand/equipment socket pairs. These are host inputs, never inferred by the model. The current inspector supplies neither and displays both metrics as **Unmeasured**. Foot/grip-specific repairs are vetoed without that data. This is a material limitation: general stylistic edits cannot claim proven foot/grip no-regression. End-to-start recovery distance is a proxy, not an authored recovery target. Bone tips are included in seam measurements so rotation-only endpoint faults cannot disappear through playback wrapping. Motion travel and interior channel amplitude gates prevent simple freezing; they are not a complete perceptual quality model.

## Audit and access

`POST /animation-doctor/review` accepts only the strict focused packet. `POST /animation-doctor/audit` stores bounded review/accept/reject receipts. These endpoints permit localhost editor origins and JSON requests; they do not inherit wildcard bridge CORS. Generated directories under `.rigging-studio/diagnostics/animation-doctor-jobs/` contain hashed evidence, provider/model, input identity, proposal, timing and results. Decision receipts include canonical validity, metrics, retained/rejected state, accepted edits and before/after digests. Credentials are never included. Audits are diagnostics, not canonical project state; an audit write failure does not roll back an accepted edit and is reported to the user.

## Deferred scope

Rig Doctor, motion direction, style dimensions, authored contact/socket controls, joint-stress limits and animation variants remain future work. Existing rig inspection, pivot/parent commands, rig proposal validators and smoke renderers are the integration points for Rig Doctor. Existing generation and legacy visual review remain available; they are not represented as Astra results.

Keep the current renderer. It already provides layered transforms, rig overlays, motion paths, deterministic pose sampling and PNG evidence without changing canonical state. If future 2.5D requirements emerge, a renderer adapter can consume `RigDefinition`, `AnimationDefinition`, resolved slots and sampled poses. No current evidence justifies a Three.js migration.

Implementation references: [Zod strict JSON Schema conversion](https://zod.dev/json-schema), [React effect cleanup](https://react.dev/reference/react/useEffect), [Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json).
