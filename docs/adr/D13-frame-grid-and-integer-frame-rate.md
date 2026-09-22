# D13 — Frame grid rule and integer frame rate

- Status: Accepted — by the project owner on 2026-09-21
- Date: 2026-09-21
- Related: D04, D06, D12, [specification](../spike/vertical-spike.md) §4 and open
  question Q1

## Context

D04 stores time as integer microseconds, but one frame at 30 fps lasts
33 333.3… µs. The Player's frame stepping and the Producer therefore need one
mapping between frame indices and `timeUs`, in both directions, or they sample
different instants.

Evidence:

- The naive inverse `floor(t * fps / 1_000_000)` maps 200 of the 300 reference
  frames to the wrong index (frame 1 samples 33 333 µs and maps back to 0).
  `packages/schema/test/frame-grid.test.ts` asserts this count.
- All five golden timestamps are multiples of three frames, so golden frames
  cannot detect an error in the mapping (specification §3.3).
- `frameToTimeUs` stops being strictly increasing above 1 000 000 fps, where two
  frames share one microsecond.

## Decision

Three parts that can be accepted or rejected separately.

**13.1 Frame rate.** `fps` is a JSON integer. Schema `0.1` accepts `1`–`120`.

**13.2 Rule.** In integer arithmetic, for `fps` in `1`–`1_000_000`:

- `frameToTimeUs(i) = floor(i * 1_000_000 / fps)`
- `timeUsToFrame(t) = floor(((t + 1) * fps - 1) / 1_000_000)`, the largest `i`
  with `frameToTimeUs(i) <= t`
- `frameCount(durationUs) = ceil(durationUs * fps / 1_000_000)`, which equals
  `timeUsToFrame(durationUs - 1) + 1`. The composition end is exclusive: the
  reference composition has frames 0–299, and frame 299 samples 9 966 666 µs.

Seeking to a `timeUs` between grid points stays valid in the Player; the
Producer samples grid times only.

**13.3 Placement.** `@kadrion/schema` exports the three functions. The runtime
is frame-agnostic by invariant ("Runtime state for a frame is derived from
`(composition, timeUs)`"); the grid is host-side sampling, and it defines what
the document fields `fps` and `durationUs` mean. Boundary rule that comes with
it: `schema` may hold pure functions that define the meaning of document
fields, and never state evaluation.

## Alternatives considered

- **Rational `fps` (`{ num, den }`)** — needed only for 29.97-style rates, for
  which there is no evidence yet. A later schema version can migrate `30` to
  `{ num: 30, den: 1 }`; the formulas generalise by replacing `fps` with
  `num / den`.
- **Rounding to the nearest microsecond** — halves the sampling error (0.5 µs
  instead of under 1 µs) but needs a tie rule. Truncation is the usual
  presentation-timestamp convention and is exact integer division.
- **Persisting frame indices instead of time** — contradicts D04 and makes the
  document depend on `fps`.
- **Placing the rule in `@kadrion/runtime`** (the tentative PR-02 row of
  specification §10) — the Producer's Node-side loop would import the browser
  runtime to count frames, and `editor-sdk` could never snap to the grid (D12
  prohibits `editor-sdk` → `runtime`). Every spike consumer can reach `runtime`
  today, so the D12 argument is forward-looking, not evidence.

## Consequences

- The implementation uses `BigInt` internally so that results are exact for the
  whole `0`–`2^53 − 1` range, and throws `RangeError` for inputs outside the
  domain or results outside the safe-integer range.
- `AGENTS.md` describes `@kadrion/schema` as "JSON Schema, TypeScript types,
  validation, migrations". 13.3 extends that responsibility with field
  semantics. `AGENTS.md` is the owner's file and the manifest description is
  pinned to it, so neither was changed; accepting 13.3 should come with an
  update of that line.
- Specification §10: "frame grid" leaves the PR-02 row.
- Relaxing the `fps` range later is non-breaking; narrowing it is breaking.

## Verification

`packages/schema/test/frame-grid.test.ts`, for the 300 reference frames: round
trip, strict monotonicity, both ends of every frame interval, every integer `t`
of the first 200 000 µs, the golden timestamp table, and the frame count. For
every accepted `fps`: the round trip over the first second, which is one full
period of the grid; and all properties over ten seconds at 1, 24, 25, 30, 50,
60, and 120 fps. It also covers the top of the safe-integer range and the
rejected inputs.
