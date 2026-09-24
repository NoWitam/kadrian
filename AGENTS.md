# Kadrion — project instructions

## Product identity

Kadrion is a private, independent TypeScript engine for describing, previewing,
editing, and deterministically rendering video compositions. It is not an end-user
application. Taskio will be its first consumer, but Kadrion must not depend on
Taskio, Laravel, Vue, a tenant model, or Taskio-specific domain objects.

The project may become open source later. Keep product-specific infrastructure,
credentials, private URLs, and Taskio implementation details outside this repo.

## Current phase

The repository is in the vertical-spike phase. The immediate goal is to prove
one narrow end-to-end path:

1. One versioned JSON composition is loaded by a browser player.
2. The same runtime renders it in pinned Chromium on the server.
3. A canvas interaction changes the JSON through a typed domain command.
4. An AI-shaped tool call performs an equivalent command.
5. The Producer exports an H.264 MP4 without storing all intermediate frames.

Do not turn the spike into a complete editor, media platform, plugin ecosystem,
or Taskio integration.

## Accepted architectural decisions

- D01: Kadrion is always an engine/SDK, never an application.
- D02: Taskio stores project versions; Kadrion owns the composition schema.
- D03: MVP rendering uses DOM/SVG. Canvas/WebGL are later extensions.
- D04: Persistent time values are integer microseconds, never floating-point seconds.
- D05: Custom HTML is supported only as an isolated, capability-limited element.
- D06: Kadrion includes its own reference Producer.
- D07: Initial output is H.264 MP4 in 720p and 1080p.
- D08: Real-time collaboration is outside MVP.
- D09: AI edits films, animations, and assets through typed domain tools.
- D10: The repository is private initially and designed for possible future open source.

Treat these decisions as constraints. If implementation evidence suggests one
must change, stop and propose an ADR instead of silently bypassing it.

## Non-negotiable invariants

- The versioned composition document is the only source of rendering truth.
- Runtime state for a frame is derived from `(composition, timeUs)`.
- Runtime animation logic must not depend on `Date.now()`, timers, playback
  history, UI state, or the number of previously rendered frames.
- Assets, fonts, randomness, and runtime versions must be explicit or pinned.
- Missing required assets are errors, not silent fallbacks.
- The browser Player and server Producer execute the same runtime build.
- The Producer is the reference output; browser preview parity is measured.
- UI and AI never mutate renderer internals directly. Both use the same command bus.
- Stable IDs are required for scenes, nodes, clips, animations, and assets.
- Structured nodes are the default path for Taskio and AI.
- Custom HTML never receives host secrets or privileged host APIs.

## Intended package boundaries

- `@kadrion/schema`: JSON Schema, TypeScript types, validation, migrations.
- `@kadrion/runtime`: deterministic state evaluation, layout, interpolation.
- `@kadrion/renderer-dom`: DOM/SVG rendering of evaluated state and the Custom HTML mount.
- `@kadrion/player`: browser host, iframe protocol, playback and seek.
- `@kadrion/editor-sdk`: typed commands, patches, transactions, undo/redo.
- `@kadrion/ai-sdk`: AI tool contracts built on editor-sdk commands.
- `@kadrion/producer`: Chromium/FFmpeg render orchestration.
- `@kadrion/cli`: local rendering and diagnostics.
- `@kadrion/test-fixtures`: reference compositions and golden frames.

Applications such as `playground` and `worker` may compose these packages but
must not become hidden sources of domain rules.

## Composition model rules

- JSON Schema is the persistent data contract.
- Start with schema `0.x` and only fields required by the reference spike.
- Breaking schema changes require explicit forward migrations.
- Unknown or unsupported fields produce a clear error or explicit warning.
- Use integer fields such as `startUs`, `durationUs`, and `timeUs`.
- Do not hide meaningful state in CSS class names, DOM order, callbacks, or opaque code.
- Extension points require an explicit type manifest, property schema, runtime
  implementation, editor metadata, AI metadata, and reference tests.

## Reference spike

Use one 10-second, 1080x1920, 30 fps composition containing:

- a background,
- one image,
- two text nodes,
- one group,
- opacity/position/scale keyframes,
- one sandboxed Custom HTML element,
- one audio track.

Golden timestamps: `0`, `2_500_000`, `5_000_000`, `7_500_000`, and
`9_900_000` microseconds.

## Engineering workflow

For every task:

1. Read these instructions and relevant ADRs.
2. Inspect the current repository state; do not assume a planned file exists.
3. State the smallest implementation slice and affected package boundaries.
4. Implement only that slice.
5. Add or update tests at the same abstraction level as the change.
6. Run the relevant typecheck, tests, lint, build, and focused smoke check.
7. Report changed files, validation results, known limitations, and next step.

Prefer small, reviewable changes. Avoid speculative abstractions and public APIs
that are not required by the current spike.

## Safety and repository hygiene

- Preserve user changes and inspect `git status` before editing.
- Do not commit, push, create releases, or modify remotes unless explicitly asked.
- Do not use destructive Git commands.
- Never add secrets or real Taskio credentials.
- Keep generated media, frames, browser caches, and large fixtures out of Git.
- Pin tools that influence rendering reproducibility once the spike selects them.
- Do not claim completion when validation commands fail or were not run.

## Explicitly outside the current scope

- Taskio database models, queues, permissions, billing, and multi-tenancy.
- A production REST service or distributed render farm.
- Full timeline UI, advanced trimming, color grading, filters, or transitions.
- A conversational LLM agent or production asset generation pipeline.
- CRDT collaboration, public plugins, 4K, HDR, and desktop/mobile apps.

