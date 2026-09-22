# D16 — Composition document conventions for schema 0.1

- Status: Accepted — by the project owner on 2026-09-21
- Date: 2026-09-21
- Related: D02, D04, D05, D09, D13, D14, D15, D17,
  [specification](../spike/vertical-spike.md) §3 and open questions Q11, Q13,
  Q16

## Context

The specification forbids deciding open points "implicitly in code". Writing
the reference composition forced several choices that no open question listed.
They are recorded here so that they can be accepted, changed, or rejected
individually. `AGENTS.md` sets the frame: "only fields required by the
reference spike", "Unknown or unsupported fields produce a clear error or
explicit warning", and no "meaningful state in CSS class names, DOM order,
callbacks, or opaque code".

## Decision

**16.1 Closed and explicit.** Every object rejects unknown fields. Every field
is required; there are no optional fields and no defaults. A reader never
fills in a value, so two hosts cannot disagree about a default. Defaults belong
to the commands that create nodes.

**16.2 What validates, renders.** Schema `0.1` accepts only what the spike
implements and tests. Relaxing a rule later keeps old documents valid;
tightening one breaks them. Concretely: exactly one scene; at most one audio
clip (mixing is undefined until PR-07); group children are image and text
nodes, so groups do not nest; `interpolation` is `linear` only (Q11); Custom
HTML content is an inline string (Q13) and declares no capabilities, because
none exists yet.

**16.3 One ID namespace.** IDs match `^[A-Za-z0-9_-]+$` and are unique across
the whole document, whatever the kind of entity. Commands and AI tools can
address anything by a bare ID. Every occurrence of an ID after the first is
reported; keys are visited in sorted order, so the result does not depend on
the key order of the input.

**16.4 Ownership and order.** A scene owns its nodes, a group owns its
children, and a node owns its animations, so an animation can never point at a
missing node. Array order is the z-order, the first item at the bottom. The
document order is the truth; DOM order is derived from it.

**16.5 Time base.** The single scene spans the composition, so every time in
the document is composition time. Nothing at or after `durationUs` is ever
sampled: keyframes and clips may extend past the end and are cut there.

**16.6 Animation semantics.** An animation modifies its node's base value; it
never replaces it. Position keyframe values are offsets added to `position`;
scale and opacity keyframe values are factors multiplied with `scale` and
`opacity`. Before the first keyframe the first value holds, after the last
keyframe the last value holds, and between two keyframes the value is
interpolated linearly. An animation has at least two keyframes with strictly
ascending `timeUs`, and a node has at most one animation per property.

## Alternatives considered

- **An animation replaces the base value** — the base value of an animated
  property is then never read, two documents that differ only there render
  identically, and `SetNodePosition` has no meaning on an animated node. The
  JSON shape is identical, so switching costs descriptions, fixture values, and
  the PR-02 evaluation only.
- **A property is either static or keyframed (Lottie style)** — no dead state,
  but every animatable property becomes a union of a value and an object, and
  the union is not discriminated by a constant (see D17).
- **A scene-level animation list with `nodeId`** — allows dangling targets and
  needs a lookup for every node removal.
- **Optional fields with defaults** — shorter documents, but the defaults become
  rules that every reader must share.
- **Per-kind ID namespaces** — hosts could reuse database keys unchanged, but
  every reference would need a kind qualifier.
- **Scenes with `startUs` and `durationUs`** — with one scene these are
  redundant state, and no test could distinguish scene-local time from
  composition time.

## Consequences

- `SetNodePosition` (P3, P4) edits the base `position` and stays meaningful for
  an animated node: the whole motion path moves.
- Hosts that use per-table numeric keys must prefix them to form IDs.
- Under 16.1, **every** new field is a breaking schema change that needs a
  forward migration, and PR-01 deliberately ships no migration framework. How
  PR-03 to PR-09 evolve schema `0.1` is open question Q16.
- Multi-scene timing, nested groups, audio mixing, easing, and Custom HTML
  capabilities each arrive as an explicit relaxation with its own fixture.
- No nesting also keeps the schema free of `$ref` recursion, which D17 relies
  on.

## Verification

`packages/schema/test`: the reference composition validates; negative fixtures
cover an unknown field, a missing field, a duplicate ID, a nested group, a
second scene, a second clip, an unsupported interpolation, a single keyframe,
non-ascending keyframes, and two animations on one property.
`composition-schema.test.ts` checks that every object schema is closed and
lists all of its properties as required. 16.5 and 16.6 describe evaluation and
are verified by PR-02.
