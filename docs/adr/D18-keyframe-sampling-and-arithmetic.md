# D18 — Keyframe sampling and evaluation arithmetic

- Status: Accepted — by the project owner on 2026-09-22
- Date: 2026-09-21
- Supersedes: —
- Related: D04, D13, D15, D16, D19, [specification](../spike/vertical-spike.md)
  §3.2, §4, and §6.1

## Context

D16.6 says what an animation means: hold, linear interpolation, and a value
that modifies the base value. It does not say how the numbers are computed.
Evaluated values are IEEE 754 binary64 numbers (D15), and with them the order of
the operations decides the last bits of a result. Player and Producer execute the
same build, so they would agree on any order; hand-derived expectations, a later
native or GPU evaluator, and another JavaScript engine would not.

Evidence gathered on 2026-09-21 and re-measured by PR-03 on 2026-09-22, after the
reference composition received base values that are not the identity (every
number below is asserted by a test):

1. Three orders of the same formula were compared on the reference composition:
   multiply-first `a + ((b - a) * dt) / span`, progress-first
   `a + (b - a) * (dt / span)`, and the symmetric form `a * (1 - p) + b * p`. At
   the five golden timestamps they yield identical bits, except the symmetric
   form at 9 900 000 (`scale.x` 2.1750000000000003 instead of 2.175). **The
   golden timestamps therefore do not pin the order of the operations.**
2. On the 300-frame grid, multiply-first and progress-first differ in at least
   one final value on 61 frames, and in each of the five animated channels on
   its own. At frame 61 (2 033 333 µs) the group's `position.x` is
   92.26666399999999 or 92.266664. (With the identity bases of PR-02 the grid had
   69 such frames, and frame 61 gave 76.26666399999999 or 76.266664.)
3. 49 pixels over 49 µs, sampled after 1 µs: multiply-first yields exactly 1, the
   other two orders yield 0.9999999999999999.
4. Applying the formula at a keyframe time misses the keyframe value as soon as
   the values are not dyadic: 0 → 0.1 over 3 µs ends at 0.10000000000000002, and
   0.1 → 0 ends at −1.4e-17, which is outside the schema range of `opacity`.
5. ECMAScript defines `+ - * /` on numbers as correctly rounded binary64
   operations. `Math.sin`, `Math.pow`, `Math.exp`, and their relatives are
   implementation-approximated, so their results may differ between engines.

## Decision

The parts are numbered for reference.

**18.1 Time domain.** `timeUs` is an integer with `0 <= timeUs < durationUs`.
Any other value is a typed error (`time-not-integer`, `time-out-of-range`); it is
never clamped, rounded, or snapped to the frame grid. `-0` is `0`. The evaluation
never reads `fps`: the frame grid is host-side sampling (D13.3).

**18.2 Sampling.** For keyframes `(t0, v0) … (tn, vn)`: at or before `t0` the
value is `v0`, at or after `tn` it is `vn`, and at `ti` it is exactly `vi`,
without any arithmetic. Only a time strictly between two neighbouring keyframes
is interpolated.

**18.3 Arithmetic.** Between `(ti, a)` and `(ti+1, b)`, each scalar channel is

```text
v = a + ((b - a) * (t - ti)) / (ti+1 - ti)
```

evaluated in exactly this order: the difference of the values, the two
differences of times (exact integers), the product, the quotient, the sum. `x`
and `y` are independent channels. Nothing but `+ - * /` is used.

**18.4 Base value.** The sampled value meets the base value in one operation
(D16.6): `position = base + offset`, `scale = base * factor`,
`opacity = base * factor`. A property without an animation is its base value,
untouched.

**18.5 Local values.** Evaluated values are local to the parent of their node.
Nothing of a group is folded into its children, because a group is composited
before its opacity applies (D15).

Why multiply-first. Any fixed sequence of `+ - * /` is equally reproducible, so
reproducibility demands _a_ rule, not this one. The choice rests on secondary
properties, each with its condition:

- **One rounding of the interpolant** while `(b - a) * (t - ti)` is exactly
  representable. That always holds for integer channels with a product below
  2^53: for position offsets, up to 75 minutes per segment at the largest
  difference the schema allows. Every representable interpolant is then produced
  exactly (evidence 3). It does not hold for fractional factors, where the
  difference and the product may round.
- **No multiply-add pattern.** The product feeds a division, so a fused
  multiply-add cannot change the result in a later native or GPU evaluator.
  Progress-first and the symmetric form both contain `x + y * z`.
- **Derivable by hand.** The expected state of the reference composition is a
  quotient of two integers plus one rounding argument per value.

It is not the most accurate order. The base value adds a second rounding, and at
frame 61 the result lies one unit in the last place below the correctly rounded
exact value 92.266664, which progress-first happens to hit. An error of 1e-14
pixels is irrelevant; that the rule is one rule is not.

## Alternatives considered

- **Progress-first or the symmetric form** — see above. The symmetric form also
  needs four roundings and is not monotonic in general.
- **Exact rational arithmetic** — factors are doubles in the document already
  (D15), the DOM takes doubles, and a big-integer division per channel and frame
  buys nothing that a fixed order does not.
- **Fixed-point results**, for example 1/1024 pixel — a second rounding rule,
  and slow movements need finer steps.
- **Clamping `timeUs` into the domain** — hides a host error, and two hosts
  could clamp differently. A `seek` beyond the end is the Player's decision.
- **The formula on keyframes as well** — evidence 4.
- **A lint ban on implementation-approximated `Math` functions now** — linear
  interpolation calls none. The first mode that needs one brings its own rule;
  the interpolator table of the runtime is keyed by the schema's modes, so that
  pull request cannot avoid touching this code.

## Consequences

- `@kadrion/runtime` implements this.
- Opacity and scale are not clamped. A seeded property test checks that the
  evaluated opacity stays within 0–1 and the scale stays non-negative for random
  documents. The bounds follow from the monotonicity of rounding while the
  elapsed time stays below 2^53, which the schema guarantees; that argument has
  not been written out as a proof.
- A document may contain `-0`, which JSON allows and which propagates by the IEEE
  rules. It carries no meaning; `String(-0)` is `"0"`, so a renderer that
  serialises numbers cannot tell the difference.
- Serialising doubles for CSS is the renderer's concern (PR-03).
  `Number.prototype.toString` is specified exactly, so it adds no variance.
- An interpolation mode that needs an implementation-approximated function needs
  its own ADR. Cubic Bézier easing can be built from `+ - * /` with a fixed
  number of iterations.
- Since PR-03 (project owner's decision of 2026-09-22) no animated property of
  the reference composition has the identity as its base value: the image scale
  has the base 1.25, the title opacity the base 0.75, and the group position
  offsets start at (16, 8). Its golden states therefore prove all three forms of
  18.4 — `base * factor` for scale and opacity, `base + offset` with a non-zero
  offset — and at 9 900 000 the scale `1.25 * RN(1.37)` is exactly one unit in
  the last place above RN(1.7125), which a runtime that folds the base value into the
  keyframe endpoints misses. In PR-02 every scale and opacity base was 1 and the
  first offset zero, so only the group position proved 18.4.

## Verification

- `packages/test-fixtures/src/compositions/reference.expected-state.json`: the
  expected state at the golden timestamps, derived by hand before the runtime
  existed and derived by hand again in PR-03 for the new base values, before the
  runtime tests were changed, with the derivation next to the numbers; guarded on
  its own by `tests/repo/expected-state.test.ts`.
- `packages/runtime/test/golden-state.test.ts`: the runtime reproduces it bit
  for bit.
- `packages/runtime/test/evaluate.test.ts`: evidence 1–4 as assertions on the
  reference composition of PR-03, with the grid pinning each of the five
  animated channels on its own; the base value meets the interpolated value and
  is not folded into the endpoints; holds with a first value that is not the
  identity; pairs with three keyframes; animations in
  any order and on every kind of node; local values of group children; off-grid
  times; independence of `fps`; the time domain; the property test.
- `packages/runtime/test/determinism.test.ts`: repeatability, order
  independence, clock independence, and a document that is only ever read.
