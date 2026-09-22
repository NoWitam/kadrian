# D15 — Spatial units and numeric types

- Status: Accepted — by the project owner on 2026-09-21
- Date: 2026-09-21
- Related: D03, D04, D07, D16, [specification](../spike/vertical-spike.md) open
  questions Q2 and Q10

## Context

D04 constrains time only. The schema also needs a unit, a coordinate system,
and numeric types for positions, sizes, scale factors, and opacity. Proofs P3
and P4 compare serialised JSON byte for byte, and a host written in another
language stores the documents (D02), so numbers must survive a JSON round trip
everywhere.

## Decision

**Unit and coordinate system.** The unit is the **composition pixel**: one unit
of the `width` x `height` canvas, independent of the output preset (a 720p
render of the reference composition scales the whole canvas). The origin is the
top-left corner, `x` grows to the right, `y` grows downwards.

**Transform.** A node's `position` is the offset of its origin — the top-left
corner of its box — from its parent's origin. The order is translate, then
scale about the node's own origin; children of a group live in the group's
scaled space. A group is composited before its `opacity` is applied.

**Numeric types.** Every number in the schema has an explicit `minimum` and
`maximum`.

| Value                                   | Type    | Range                          |
| --------------------------------------- | ------- | ------------------------------ |
| Canvas `width`, `height`                | integer | 1 – 1920 (D07 stops at 1080p)  |
| Coordinates (`position`, offsets)       | integer | −1 000 000 – 1 000 000         |
| Lengths (`width`, `height`, `fontSize`) | integer | 1 – 1 000 000                  |
| `opacity` and opacity keyframe values   | number  | 0 – 1                          |
| Scale factors and scale keyframe values | number  | 0 – 1000                       |
| Time (`*Us`), see D04                   | integer | 0 – 2^53 − 1; durations from 1 |
| `fps`, see D13                          | integer | 1 – 120                        |

Persisted lengths and coordinates are **integers**. Evaluated values may be
fractional: interpolation happens at render time and is never persisted.

**Colours** are lowercase `#rrggbb` sRGB strings. Transparency is expressed
through `opacity`.

## Alternatives considered

- **Fractional pixels in the document** — nothing in the spike needs them.
  Relaxing `integer` to `number` later is non-breaking; the reverse is a
  breaking change. Integers also avoid number-formatting differences between
  JSON implementations.
- **Fixed-point opacity and scale** — removes the last doubles from the
  document, at the price of a unit nobody expects (parts per million).
- **Unbounded numbers** — `type: integer` alone accepts `1e300`, which does not
  survive every JSON implementation.
- **Requiring even canvas dimensions for `yuv420p`** — evenness is a property
  of the output, which depends on the preset (Q2). PR-07 owns it, as a typed
  Producer error or as rounding of the output size.

## Consequences

- Rounding pointer input to integer composition pixels belongs to
  `@kadrion/editor-sdk`, not to an application: per `AGENTS.md`, applications
  "must not become hidden sources of domain rules".
- A node has no anchor point in `0.1`; scaling always happens about the top-left
  corner. An anchor is a later, additive feature.
- Layout engines clamp very large coordinates; the ±1 000 000 bound stays far
  below that.

## Verification

`packages/schema/test/composition-schema.test.ts` requires explicit bounds on
every numeric schema. Negative fixtures cover a fractional pixel and an
out-of-range opacity. The transform order is not mechanically verified until
the runtime exists (PR-02, PR-03).
