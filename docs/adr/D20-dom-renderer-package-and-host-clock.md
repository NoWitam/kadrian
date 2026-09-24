# D20 — The DOM renderer is a package of its own, and the clock belongs to the host

- Status: Accepted — by the project owner on 2026-09-22
- Date: 2026-09-22
- Supersedes: —
- Related: D03, D05, D12, D18, D19, [specification](../spike/vertical-spike.md)
  §6.1, §7, and open question Q15

## Context

Open question Q15 asked which package owns the DOM/SVG renderer and the Custom
HTML sandbox mount. `AGENTS.md` assigned neither, and D12 forbids shared code
from moving sideways between Player and Producer. The specification proposed
`@kadrion/runtime`, "unless evidence demands a ninth package".

Two forces pulled against `runtime`:

- PR-02 made `@kadrion/runtime` an evaluator that needs no environment: its
  TypeScript project has neither DOM nor Node.js types, so a timer or a frame
  callback does not even compile there (specification §6.1). A renderer needs
  the DOM library, which would end that layer for the evaluator too.
- The determinism guardrail binds every source of `@kadrion/runtime` and allows
  no inline exception. §6.1 left open whether it narrows to an evaluation
  subtree once a renderer lands in the package, or whether code that needs time
  receives its timer from the host.

The project owner decided both questions on 2026-09-22.

## Decision

**20.1 Ninth package.** `@kadrion/renderer-dom` maps a validated document and
its `CompositionState` onto DOM/SVG. It will also own the mount of the isolated
Custom HTML element (PR-04). Responsibilities:

| Package                 | Owns                                                            |
| ----------------------- | --------------------------------------------------------------- |
| `@kadrion/runtime`      | the environment-free evaluation `(composition, timeUs)` → state |
| `@kadrion/renderer-dom` | document and state → DOM/SVG; later the Custom HTML mount       |
| `@kadrion/player`       | playback, seek, `postMessage`, and the preview clock            |
| `@kadrion/producer`     | frame sampling, Chromium, FFmpeg, and export                    |

Allowed edges (D12): `renderer-dom` → `runtime`, `schema`; `player` →
`renderer-dom`, `runtime`, `schema`; `producer` → `renderer-dom`, `runtime`,
`schema`. No `renderer-canvas` or `renderer-webgl` package exists; they are
later extensions (D03).

**20.2 The clock belongs to the host.** Neither `@kadrion/runtime` nor
`@kadrion/renderer-dom` reads a clock, starts a timer, asks for a frame
callback, draws a random number, or keeps a history of earlier frames. They
receive an explicit `timeUs` or a ready `CompositionState`. The Player derives
`timeUs` from its preview clock and may schedule with `requestAnimationFrame`;
the Producer derives it from the frame index (D13). Neither mechanism moves into
the two packages. Code of those packages that will need to wait — for example
the bounded acknowledgement wait of the Custom HTML element (§7) — receives its
timer from the host.

**20.3 Guardrail scope.** The determinism guardrail of §6.1 covers every source
of both packages, with inline configuration switched off. It does not narrow to
an evaluation subtree. Which names and forms the guardrail bans in detail is
implementation, proposed in D22.8.

## Alternatives considered

- **The renderer inside `@kadrion/runtime`** (the proposed direction of Q15) —
  no new package, but the evaluator would gain the DOM library, and the
  guardrail would have to narrow to a subtree or bind rendering code that has no
  reason to be near the evaluator.
- **The renderer inside `@kadrion/player`** — the Producer could not use it
  without a prohibited sideways edge (D12).
- **Narrowing the guardrail to an evaluation subtree** — rendering code would
  be free to read a clock, which is exactly what makes two renders of one frame
  differ.

## Consequences

- `AGENTS.md` lists nine packages; `tests/repo/workspace-structure.test.ts`
  checks the list, and D12 and `docs/architecture/package-boundaries.json` carry
  the new edges.
- The "runtime build" that Player and Producer must share (`AGENTS.md`) is the
  bundle of `@kadrion/renderer-dom` together with `@kadrion/runtime` and
  `@kadrion/schema` (D21).
- PR-04 mounts the Custom HTML element from `@kadrion/renderer-dom` and passes
  the acknowledgement timer in from the host.
- Known gap: the runtime build also contains `@kadrion/schema`, whose
  `validateComposition` runs inside the page on every call (D21), but the
  guardrail does not bind the schema sources. They hold one module-level memo
  today (`WeakSet` of supported schema nodes in `validate-structure.ts`), whose
  result does not depend on history. Extending the guardrail to the schema needs
  that memo rewritten or named as an exception; that is the project owner's
  call and is not part of PR-03.

## Verification

- `tests/repo/workspace-structure.test.ts` and
  `tests/repo/package-boundaries.test.ts`: the package list and the edges.
- `tests/repo/lint-guardrails.test.ts`: violating text is rejected under paths of
  both packages, and the scope assertions cover nested paths of both and leave
  every other package free.
- `packages/renderer-dom/test`: clock independence of the renderer and of the
  built artifact, with every clock replaced by a throwing function in the realm
  of the page.
