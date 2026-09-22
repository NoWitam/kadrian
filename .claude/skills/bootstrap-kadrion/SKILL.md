---
description: Bootstraps the new Kadrion repository for PR-00. Use only when the repository is empty or contains only initial metadata and the user asks to start, scaffold, or initialize Kadrion.
disable-model-invocation: true
---

# Bootstrap Kadrion — PR-00 only

Create the technical and documentation foundation for the approved vertical
spike. Do not implement the composition schema, runtime, Player, Producer,
editor behavior, or Taskio integration in this task.

## Required process

1. Read `AGENTS.md` completely.
2. Inspect the repository, Git status, existing files, available Node runtime,
   package manager, and FFmpeg/Chromium availability.
3. Delegate an architecture review to `kadrion-architect` and use its findings
   to refine the plan.
4. Present a concise execution plan. If the repository contains conflicting
   work or a decision contradicts D01-D10, stop and ask the user. Otherwise
   continue without requesting another confirmation.
5. Implement only the PR-00 scope below.
6. Run validation and report exact results.

## PR-00 scope

Create a private-ready TypeScript monorepo foundation using pnpm workspaces.
Use strict TypeScript and ESM. Select mutually compatible current tool versions
from authoritative package metadata; do not invent versions.

Create the initial package boundaries:

```text
packages/
  schema/
  runtime/
  player/
  editor-sdk/
  ai-sdk/
  producer/
  cli/
  test-fixtures/
apps/
  playground/
  worker/
```

Each package may contain only the minimal metadata and entry point needed for
the workspace to typecheck. Do not add domain implementation or placeholder
APIs pretending to be final contracts.

Create or update:

- root `package.json` with workspace scripts,
- `pnpm-workspace.yaml`,
- shared strict TypeScript configuration,
- lint and formatting configuration,
- `.editorconfig`, `.gitignore`, and appropriate package metadata,
- a concise root `README.md`,
- `docs/decisions/README.md`,
- accepted ADR records for D01-D10,
- `docs/vertical-spike.md`,
- `docs/development.md` with verified local commands.

ADR files must record context, accepted decision, consequences, and status.
They must preserve the exact intent of D01-D10 from `AGENTS.md` without adding
new product decisions.

The vertical-spike document must define:

- the 10-second reference composition,
- the browser-preview and server-export paths,
- the one manual `moveNode` operation,
- the equivalent AI-shaped command,
- golden timestamps,
- H.264 720p/1080p outputs,
- Custom HTML isolation objective,
- measurable acceptance criteria,
- explicit exclusions.

## Validation

Run every command that exists after scaffolding, including dependency install,
typecheck, tests, lint, and build. A minimal smoke test must prove that workspace
package resolution works.

If a tool is unavailable, report that as a limitation; do not fabricate a
successful run. Do not commit or push unless the user explicitly asks.

## Completion report

Return:

1. what was created,
2. commands executed and their results,
3. decisions intentionally deferred to PR-01,
4. risks or environment gaps,
5. the exact recommended next prompt for PR-01.

