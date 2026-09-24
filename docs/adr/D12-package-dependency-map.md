# D12 — Package dependencies follow a machine-checked map

- Status: Accepted — by the project owner on 2026-09-22, with the ninth package of
  D20 added by PR-03
- Date: 2026-09-21
- Related: D01, D09, D10, D11, D20

## Context

`AGENTS.md` defines the packages and their responsibilities (eight in PR-00, nine
since D20). It does not say which package may depend on which, except that
`@kadrion/ai-sdk` is "built on editor-sdk commands". Two invariants constrain
the edges: "UI and AI never mutate renderer internals directly. Both use the
same command bus." and "The browser Player and server Producer execute the same
runtime build."

pnpm's strict `node_modules` layout (D11) lets a package import only what its
manifest declares. Checking declared dependencies against a map is therefore
enough to enforce the boundaries; no import-graph linter is needed.

Amended by PR-01 on 2026-09-21: the claim above holds for `dependencies`, but
not for development dependencies. A package's own `devDependencies`, and the
root ones, are resolvable from `packages/<name>/src` by walking up to a
`node_modules` directory, so a source file could import one without any
manifest check noticing. The boundary test now also scans the bare import
specifiers in `packages/*/src` (see "Further rules").

Amended by PR-03 on 2026-09-22: the project owner answered open question Q15
with a ninth package, `@kadrion/renderer-dom` (D20). The map below includes it.

The identifier D12 may collide with a decision defined in the missing
`/bootstrap-kadrion` skill (see D11); the project owner should confirm it.

## Decision

The allowed dependency edges between workspace packages are recorded in
[`docs/architecture/package-boundaries.json`](../architecture/package-boundaries.json)
and enforced by `tests/repo/package-boundaries.test.ts`.

| Package         | May depend on (runtime)             |
| --------------- | ----------------------------------- |
| `schema`        | —                                   |
| `runtime`       | `schema`                            |
| `editor-sdk`    | `schema`                            |
| `ai-sdk`        | `editor-sdk`, `schema`              |
| `renderer-dom`  | `runtime`, `schema`                 |
| `player`        | `renderer-dom`, `runtime`, `schema` |
| `producer`      | `renderer-dom`, `runtime`, `schema` |
| `cli`           | `producer`, `schema`                |
| `test-fixtures` | — (dev-only, pure data)             |

Every edge falls into one of three categories:

1. **Allowed** — listed in the map.
2. **Prohibited** — listed under `prohibited` with a reason. Removing a
   prohibition requires an ADR.
3. **Not needed yet** — neither of the above (for example `cli` → `runtime`).
   The pull request that needs such an edge adds it to the map and justifies it
   in its description.

Prohibitions:

| From                    | To                                              | Reason                                                                                                 |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `schema`                | anything                                        | The schema is the persistent data contract and the root of the graph                                   |
| `test-fixtures`         | anything                                        | Fixtures are pure data; every package may devDepend on them, so any outgoing edge would create a cycle |
| `editor-sdk`, `ai-sdk`  | `runtime`, `renderer-dom`, `player`, `producer` | Commands are document transforms; UI and AI share one command bus that must work without a renderer    |
| `producer` and `player` | each other                                      | They share the runtime build; shared code moves down into `renderer-dom` or `runtime`, never sideways  |
| `runtime`               | `renderer-dom`                                  | The evaluation stays free of any environment; rendering builds on it, never the reverse (D20)          |
| `renderer-dom`          | `player`, `producer`                            | Both hosts load the renderer as part of the one runtime build; it cannot know either host (D20)        |

Further rules enforced by the same test:

- `test-fixtures` is a dev-only leaf: any package may list it in
  `devDependencies`, and it never appears in runtime dependencies.
- Workspace packages are linked with the `workspace:` protocol.
- External **runtime** dependencies must be on the allowlist
  `externalRuntimeDependencies`, which starts empty. Every entry records a
  reason and a licence, which doubles as the licence audit for D10.
  `devDependencies` are not restricted by the allowlist.
- Source files import only declared runtime dependencies (added by PR-01): every
  bare import specifier in `packages/<name>/src` must name a package listed in
  that manifest's `dependencies`, `peerDependencies`, or
  `optionalDependencies`. Test directories are not restricted.
- The set of packages equals the list in `AGENTS.md`
  (`tests/repo/workspace-structure.test.ts`). Adding a package therefore
  requires changing `AGENTS.md`, which is the project owner's call and deserves
  an ADR, as D20 did for the ninth.

## Alternatives considered

- **A denylist of forbidden dependency names** (Taskio, Laravel, Vue, …) —
  requires guessing names and misses everything not guessed. The allowlist
  needs no guessing.
- **An import-graph lint plugin** — redundant while pnpm's strict layout makes
  undeclared imports unresolvable.
- **No map until edges exist** — the first cross-package import would then
  define the architecture implicitly.

## Consequences

- PR-01 has to add its schema validator to the allowlist, with a reason and a
  licence. (Amended by PR-01 on 2026-09-21: this did not happen. The validator
  proposed in D17 has no runtime dependency, so the allowlist is still empty.)
- If the spike shows that the Producer should reuse Player code, that code moves
  into `renderer-dom` or `runtime`, or the prohibition is lifted by an ADR. The same holds for
  `editor-sdk` needing anything from the renderer side.
- Where the DOM/SVG renderer and the Custom HTML sandbox mount live was open
  question Q15; D20 answers it with `@kadrion/renderer-dom`.

## Verification

`tests/repo/package-boundaries.test.ts` checks that the map and `packages/` are
in sync, that no allowed edge is prohibited, that the graph including dev-only
edges is acyclic, that every manifest stays within the map and the allowlist,
and that source files import only declared runtime dependencies.
