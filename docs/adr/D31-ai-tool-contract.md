# D31 — The AI tool contract `set_node_position`

- Status: Accepted — by the project owner on 2026-09-23, without a change of substance
- Date: 2026-09-23
- Supersedes: —
- Related: D09, D12, D15, D17, D19, D30,
  [specification](../spike/vertical-spike.md) §5 P4 and §9

## Context

P4 asks `@kadrion/ai-sdk` for "a tool contract (name, description, JSON Schema
for the arguments) built on the same editor-sdk command", and for a fixture tool
call with the parameters of the P3 drag to produce a document "whose serialised
JSON is byte-identical to the P3 result". Invalid arguments must be "rejected
with a typed error and leave the document untouched", and no model is called.
§9 adds that "the AI tool contract is derived from the command definition so
that the two cannot drift apart". `AGENTS.md` binds the boundary: "UI and AI
never mutate renderer internals directly. Both use the same command bus."

D30 gives the command (`SetNodePosition`), its one parser (`parseCommand`, which
also rounds), and a bus whose `dispatch` takes `unknown`. D12 lets `ai-sdk`
depend on `editor-sdk` and `schema` and on nothing on the renderer side.

The project owner settled the open points on 2026-09-23, before this pull
request: the tool is called `set_node_position`; `editor-sdk` owns and exports
the JSON Schema of the arguments, which `ai-sdk` wraps without copying or
generating anything; the tool runs on the host's `CommandBus` through `dispatch`
and returns the `CommandResult`; `ai-sdk` gets a purity guardrail of its own;
there is no second command in this pull request.

## Decision

### D31.1 The contract is data plus one function

```ts
interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ClosedObjectSchema<string>; // from editor-sdk
}
const setNodePositionTool: ToolDefinition; // deep-frozen, name 'set_node_position'
function executeSetNodePosition(bus: Pick<CommandBus, 'dispatch'>, args: unknown): CommandResult;
```

The definition is provider-neutral — `inputSchema` is the field name the Model
Context Protocol uses — and a host maps it onto whatever its model API calls the
same three things. The package exports exactly these two values; there is no
tool registry, no generic `execute_command`, and no undo or redo tool, because
the spike needs one command end to end (§9).

### D31.2 `editor-sdk` owns the argument schema

`@kadrion/editor-sdk` exports, next to `parseCommand`, the argument type
`SetNodePositionArguments` and `setNodePositionArgumentsSchema`, a deep-frozen
JSON Schema (draft 2020-12) of `{ nodeId: string, position: { x: number, y:
number } }` with every object closed. `SetNodePositionCommand` is defined as the
arguments plus the discriminator, so the command and its arguments cannot differ
in their fields at compile time.

`ai-sdk` passes that very object as `inputSchema`: it copies no field and no
constraint, and it generates nothing from `compositionSchema`. `x` and `y` are
`number`, not `integer`: `parseCommand` accepts a fraction and rounds it (D30.3),
so `integer` would describe the document after normalisation, not the input of
the command. The descriptions state the rounding rule, because a model cannot
read `parseCommand`. The bounds of a coordinate are the document's (D15), and
the schema does not restate them: a coordinate the document cannot hold is
refused as `invalid-result` by the full validation of D30.6.

The schema is written by hand next to the parser, so it is **co-owned and
differentially tested**, not derived. §9's "derived so that the two cannot
drift" is met by one owner, one shared type, and the differential test of
D31.9, which feeds the same corpus to an independent JSON Schema validator and
to `parseCommand` and demands the same verdict.

### D31.3 The adapter adds the discriminator and nothing else

The arguments carry no `type`. The adapter builds the command as
`{ type: 'SetNodePosition', ...args }`, spread once, so that a getter is read
once and `parseCommand` sees a plain snapshot. Two cases are decided before the
spread:

- arguments that are not a plain object are handed to `dispatch` unchanged, and
  `parseCommand` refuses them — the rejection stays in one place;
- arguments with an **own** `type` property are refused with `invalid-argument`.
  The schema forbids that field, and either spread order would disagree with it:
  `{ ...args, type }` silently overwrites what the model sent, and
  `{ type, ...args }` would let the model choose the command once a second one
  exists.

The adapter does not round, convert, clamp, or default anything; `parseCommand`
is the one normalisation point (D30.3).

### D31.4 The tool dispatches on the host's bus, once

`executeSetNodePosition` calls `bus.dispatch` exactly once and returns its
`CommandResult` — the validated document after the change and the inverse, a
ready `SetNodePosition` with the previous position, or `null` when nothing
changed. It never calls `applyCommand`, never creates a bus, and never reads the
document to write it back. The parameter type is `Pick<CommandBus, 'dispatch'>`,
so the capability the tool receives is visible in its signature.

Because the edit goes through the host's bus, the AI and the UI share one
history: undo right after an AI edit restores the previous document, redo
repeats it, and there is no second owner of the document. `ai-sdk` keeps no
document, no history, and no cache.

### D31.5 The AI can do exactly what the UI can do

The tool's capability is one `dispatch` of one command type on a bus the host
hands in. Its signature grants that and nothing more: `Pick<CommandBus,
'dispatch'>`. `Pick` narrows the type, not the object — a host that passes its
whole bus hands over a live object — so the rest is held by three means:

- the sources of `ai-sdk` may not assert a type
  (`@typescript-eslint/consistent-type-assertions` with `assertionStyle:
'never'`; `as const` stays legal), so `(bus as CommandBus).undo()` does not
  compile past lint;
- they may not assign to a property of a parameter (`no-param-reassign` with
  `props`), so `bus.dispatch = …`, which would intercept every later edit of
  the UI, is refused;
- the tests run the tool, the refusals included, on a frozen object that has
  `dispatch` alone, so any other reach is a `TypeError` rather than a code.

A host that wants the guarantee at run time rather than in review passes such
an object itself. Freezing the object `createCommandBus` returns would give it
to every host; that changes `editor-sdk`, belongs to D30, and is left to the
project owner.

The tool cannot reach the renderer, the Player, or the Producer (D12). Every
precondition the UI's command meets — the parse, the node lookup, the full
`validateComposition` of the result — holds for the tool's command, because it
is the same call.

### D31.6 Errors are the command bus's own

The tool throws the `EditorError` of D30.8 and adds no error class: a host
checks `code` whichever entry point an edit came from. Arguments the schema
refuses surface as `invalid-argument`; a node the document lacks as
`unknown-node`; a position the document cannot hold as `invalid-result`, with
the validation errors as `details`. None of them is rewrapped. A failed call
leaves the document and both stacks of the bus unchanged (D30.9, rule 6).

### D31.7 No second path to the document

ESLint enforces the path, because a dry run through `applyCommand` followed by
`dispatch` passes every behavioural test:

- the sources of `ai-sdk` may not import `applyCommand` or `createCommandBus`
  from `@kadrion/editor-sdk`, nor anything from `@kadrion/schema` — D12 allows
  that dependency, but the tool needs no validator of its own, and with one it
  could edit JSON itself and validate the result;
- the brand rule of Q17 is repeated in the block, so `ai-sdk` cannot assert a
  `ValidatedComposition` either.

### D31.8 A purity guardrail for `ai-sdk`

`ai-sdk` is a pure adapter between the contract and the command; the effects
belong to the bus the host passes in. Its sources may not reach a clock
(`Date`, `performance`, `Temporal`, `Intl`), a timer or frame callback, a random
source (`Math.random`, `crypto`), the DOM or any other host API, the network
(`fetch`, `XMLHttpRequest`, `WebSocket`, …), `process` or any other part of the
system, a Node built-in module by specifier or bare name, the syntactic forms of
module state listed below, or a weak collection, and inline configuration cannot
switch that off.

The block shares its lists with the purity block of `editor-sdk` (D30.11), under
a message of its own, and adds rules `editor-sdk` does not have, because
`const calls = []` is module state that the rules of D24 do not see. A
module-scope variable may not be initialised with:

- an array or object literal, also behind one or two type wrappers (`as`,
  `satisfies`, `<T>`, `!`) or a conditional or logical operator;
- a call whose argument holds a literal nested in a literal — `Object.freeze`
  is shallow, so `Object.freeze({ calls: [] })` is state too;
- an immediately invoked function, whose closure is state.

A default export and a static field may not be a literal either. Syntax cannot
close every form of module state — a helper that returns a fresh array walks
past these rules — so they are a review aid with a test per form, not a proof.
The tool definition is built through a call that freezes it, and its one
non-primitive field is the schema `editor-sdk` has already frozen deeply.

Sharing the lists tightens `editor-sdk` as well: D30.11 promises that "every
Node built-in" is refused "by specifier and by bare name", while its block
named seven bare names; both blocks now take the list from the
`builtinModules` of the Node that runs ESLint — a newer Node within `engines`
only adds bans — and both refuse `process`, `global`, `require`, `Buffer`,
`crypto`, `navigator`, `location`, the storage APIs, and the channel APIs.
`editor-sdk` uses none of them. `COMMAND_TYPES` is frozen for the same reason:
a caller that pushed a name onto it would make `parseCommand` accept a type the
build does not know.

### D31.9 What the differential test covers

The oracle is Ajv 8.20.0 (`Ajv2020`, `strict`, `strictNumbers`), already pinned
by `@kadrion/schema` for the same purpose. Its domain is JSON: values produced
by `JSON.parse`, which is what a tool call delivers. Values JSON cannot carry —
a non-enumerable `type`, a getter, a proxy, a class instance — are outside it;
`NaN` and `±Infinity` are included, because `strictNumbers` and `parseCommand`
both refuse them. The corpus is built from the schema's own properties (each one
missing, each one of the wrong JSON type, an extra field at every level) plus
hand-written rows whose normalised coordinates are stated, not recomputed.

## Alternatives considered

- **The tool calls `applyCommand` on a document it holds** — stateless, but the
  AI's edit then has no place in the host's history, and a host with a bus ends
  up with two owners of one document (D30.12).
- **The argument schema generated from `compositionSchema`** — it would say
  `integer` with the document's bounds, which is not what `parseCommand`
  accepts; the two would disagree on every fraction.
- **The argument schema written in `ai-sdk`** — a second copy of the command's
  shape in a second package, which is the drift §9 rules out.
- **Arguments that include `type`** — the model would have to repeat a constant
  the tool already implies, and a wrong value would be one more way to fail.
- **A tool error class of its own** — a host would need two vocabularies for one
  set of failures; the codes of D30.8 already name every case.

## Consequences

- `@kadrion/ai-sdk` depends on `@kadrion/editor-sdk` only; `ajv` and
  `@kadrion/test-fixtures` are development dependencies.
- `@kadrion/editor-sdk` gains two exports (the argument type and schema) and
  `ajv` as a development dependency; its purity block grows as D31.8 says.
- The root workspace gains a development dependency on `@kadrion/ai-sdk` for the
  P4 equivalence test in `tests/app/`.
- A second command, when one arrives, brings its own argument schema in
  `editor-sdk`, its own tool here, and the failing-undo test that D30.9 defers.
- Schema 0.1 is untouched.

## Verification

- `packages/editor-sdk/test/arguments-schema.test.ts`: the schema is deep-frozen
  and accepted by Ajv's meta-schema; the differential corpus gets the same
  verdict from Ajv and from `parseCommand`, and accepted rows normalise as
  stated.
- `packages/ai-sdk/test/`: the tool definition is frozen and its `inputSchema`
  is the `editor-sdk` object; the export surface is exactly D31.1; the tool
  calls `dispatch` once and returns its result; UI and AI share one history,
  undo and redo; refused arguments leave the document and the stacks unchanged
  and keep their code; neither the arguments nor the document are mutated; the
  tool-level differential agrees with Ajv.
- `tests/app/ai-equivalence.test.ts`: the committed fixture tool call equals the
  payload the playground's own drag dispatches, minus `type`, and the document
  the tool produces is byte-identical to the one the Player received from the
  gesture — for the reference document, a fractional drag, and a document that
  spells `position` as `y` before `x`.
- `tests/repo/lint-guardrails.test.ts` feeds each banned construct to the real
  configuration under an `ai-sdk` path, including the import bans of D31.7,
  the assertion and parameter rules of D31.5, and each form of module state of
  D31.8.
