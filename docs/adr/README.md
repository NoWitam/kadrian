# Architecture Decision Records

This directory is the decision log for Kadrion. Accepted decisions are
**constraints**: if implementation evidence suggests one must change, stop and
propose a new ADR instead of silently bypassing it (see `AGENTS.md`).

## Index

| ID                                                         | Title                                                                              | Status   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| [D01](D01-engine-sdk-not-application.md)                   | Kadrion is always an engine/SDK, never an application                              | Accepted |
| [D02](D02-kadrion-owns-composition-schema.md)              | Taskio stores project versions; Kadrion owns the composition schema                | Accepted |
| [D03](D03-dom-svg-rendering-for-mvp.md)                    | MVP rendering uses DOM/SVG; Canvas/WebGL are later extensions                      | Accepted |
| [D04](D04-integer-microsecond-time.md)                     | Persistent time values are integer microseconds                                    | Accepted |
| [D05](D05-isolated-custom-html.md)                         | Custom HTML is supported only as an isolated, capability-limited element           | Accepted |
| [D06](D06-reference-producer.md)                           | Kadrion includes its own reference Producer                                        | Accepted |
| [D07](D07-h264-mp4-720p-1080p-output.md)                   | Initial output is H.264 MP4 in 720p and 1080p                                      | Accepted |
| [D08](D08-no-realtime-collaboration-in-mvp.md)             | Real-time collaboration is outside MVP                                             | Accepted |
| [D09](D09-ai-edits-through-typed-domain-tools.md)          | AI edits films, animations, and assets through typed domain tools                  | Accepted |
| [D10](D10-private-repo-designed-for-open-source.md)        | The repository is private initially and designed for possible future open source   | Accepted |
| [D11](D11-monorepo-tooling-baseline.md)                    | Monorepo tooling baseline                                                          | Accepted |
| [D12](D12-package-dependency-map.md)                       | Package dependencies follow a machine-checked map                                  | Accepted |
| [D13](D13-frame-grid-and-integer-frame-rate.md)            | Frame grid rule and integer frame rate                                             | Accepted |
| [D14](D14-content-addressed-assets.md)                     | Assets are pinned by content hash and resolved by the host                         | Accepted |
| [D15](D15-spatial-units-and-numeric-types.md)              | Spatial units and numeric types                                                    | Accepted |
| [D16](D16-composition-document-conventions.md)             | Composition document conventions for schema 0.1                                    | Accepted |
| [D17](D17-derived-types-and-dependency-free-validation.md) | Derived types and dependency-free validation                                       | Accepted |
| [D18](D18-keyframe-sampling-and-arithmetic.md)             | Keyframe sampling and evaluation arithmetic                                        | Accepted |
| [D19](D19-evaluation-api-and-state-shape.md)               | Evaluation API and state shape                                                     | Accepted |
| [D20](D20-dom-renderer-package-and-host-clock.md)          | The DOM renderer is a package of its own, and the clock belongs to the host        | Accepted |
| [D21](D21-runtime-build-artifact.md)                       | The runtime build artifact                                                         | Accepted |
| [D22](D22-dom-mapping-and-css-serialisation.md)            | DOM mapping and CSS serialisation                                                  | Accepted |
| [D23](D23-custom-html-sandbox-and-time-contract.md)        | Custom HTML sandbox, message protocol, and time contract                           | Accepted |
| [D24](D24-schema-under-the-determinism-guardrail.md)       | The schema joins the determinism guardrail, with one named exception               | Accepted |
| [D25](D25-player-host-and-render-page.md)                  | The Player host, the shared render page, and frame readiness                       | Accepted |
| [D26](D26-pinned-render-environment.md)                    | The pinned render environment                                                      | Accepted |
| [D27](D27-fonts-and-the-load-step.md)                      | Fonts from asset bytes, the load step of the runtime build, and the fixture assets | Accepted |
| [D28](D28-producer-frame-capture.md)                       | The Producer: render page, frame capture, render manifest, and CLI                 | Accepted |
| [D29](D29-mp4-export.md)                                   | The MP4 export: pinned FFmpeg, streamed frames, presets, and audio mux             | Accepted |
| [D30](D30-command-bus-and-undo.md)                         | The command bus, `SetNodePosition`, and undo/redo                                  | Accepted |
| [D31](D31-ai-tool-contract.md)                             | The AI tool contract `set_node_position`                                           | Accepted |
| [D32](D32-playground-showcases.md)                         | Playground showcases and documents of the user's own                               | Proposed |
| [D33](D33-parity-measurement.md)                           | Measuring parity between the Player and the Producer                               | Accepted |
| [D34](D34-parity-thresholds.md)                            | Parity thresholds from the first measurement                                       | Accepted |
| [D35](D35-schema-migration-policy.md)                      | How schema `0.x` changes after the spike: versions and forward migrations          | Accepted |
| [D36](D36-webrtc-in-the-player.md)                         | WebRTC and the network isolation of Custom HTML in the Player                      | Accepted |

## Provenance of D01–D10

D01–D10 were accepted by the project owner **before** this repository was
bootstrapped. Their authoritative wording is the one-line statement in
`AGENTS.md` ("Accepted architectural decisions"), and each ADR quotes it
verbatim. `AGENTS.md` does not record why the decisions were taken, so these
ADRs do not contain a reconstructed rationale: the **Rationale** section says
"not recorded" until the project owner supplies it. The **Related rules**
sections contain verbatim quotations from `AGENTS.md` only.
`tests/repo/adr.test.ts` fails when a quotation drifts from `AGENTS.md`.

## Conventions

- **Identifiers** continue the project's own numbering: `D01`, `D02`, … New
  ADRs take the next free number. Identifiers are never reused.
- **File name**: `D<NN>-<kebab-case-slug>.md`.
- **Header**: every ADR starts with `# D<NN> — <Title>` followed by a metadata
  list that contains `- Status: <status>`.
- **Statuses**: `Proposed` → `Accepted` → (`Superseded by D<NN>` | `Deprecated`).
  `Rejected` is kept for the record when a proposal is declined.
- Only the project owner accepts an ADR. A `Proposed` ADR may describe something
  a pull request already implements provisionally; it still becomes `Accepted`
  only by explicit approval.
- Accepted ADRs are immutable in substance. To change a decision, write a new
  ADR that supersedes it and update the status line of the old one.
- An Accepted ADR may receive an additive clarification or amendment on the
  project owner's explicit instruction. Such a change must not silently reverse
  the original decision. It carries an `Amended by` line in the header, with
  its date and a reference: the pull request and the numbered section. A change
  to the substance of the decision still needs a new ADR that supersedes the
  old one.
- Every ADR is listed in the index above with its current status.

## Proposing a decision

1. Copy [`TEMPLATE.md`](TEMPLATE.md) to `D<NN>-<slug>.md` with status `Proposed`.
2. Describe the evidence that triggered the proposal (failing test, measurement,
   spike finding) and the alternatives considered.
3. Add the ADR to the index in the same change.
4. Dependent implementation lands only after the project owner accepts it, or
   is clearly marked as provisional until then.
