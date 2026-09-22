# D14 — Assets are pinned by content hash and resolved by the host

- Status: Accepted — by the project owner on 2026-09-21
- Date: 2026-09-21
- Related: D01, D02, D10, [specification](../spike/vertical-spike.md) §5 P1, §8
  and open question Q6

## Context

`AGENTS.md` requires that "assets, fonts, randomness, and runtime versions must
be explicit or pinned" and that "missing required assets are errors, not silent
fallbacks". Kadrion is an engine (D01): hosts such as Taskio store the bytes
(D02), and private URLs must stay out of this repository and out of documents
that may be shared.

A document therefore has to identify an asset exactly without saying where it
lives.

## Decision

An asset entry is `{ id, type, contentHash }`:

- `type` is `image`, `audio`, or `font`. Nodes and clips refer to assets by
  `id`; a reference must resolve to an asset of the expected `type`.
- `contentHash` is `sha256:` followed by 64 lowercase hex digits: the SHA-256 of
  the exact bytes. The value names its algorithm; schema `0.1` accepts only
  `sha256`.
- The document carries no URL, path, media type, byte length, or intrinsic
  size.

Bytes come from a **host-provided resolver**. The engine verifies the hash of
what the resolver returns; a missing asset or a hash mismatch is a typed error
raised before the first frame, in both hosts. The resolver interface is defined
by the pull request that first loads assets (PR-05 or PR-06), not here.

PR-01 ships no binary assets, so the reference composition carries three
distinct, explicit **placeholder hashes** (`sha256:` followed by 63 zeros and
the digit 1, 2, or 3). No real content can hash to them, so they can never
verify by accident.

## Alternatives considered

- **URL plus integrity hash (SRI style)** — signed URLs expire, storage moves,
  and tenant URLs would leak into documents.
- **A bare `sha256` field** — a hash cannot be migrated by a document
  transform, because a migration has no bytes. A self-describing value lets a
  later schema accept another algorithm by relaxing a pattern, without a
  migration.
- **SRI encoding (`sha256-<base64>`)** — only useful for `integrity`
  attributes, which the engine does not use. Hex matches `sha256sum`, OCI
  digests, and Git LFS.
- **Media type and intrinsic metadata in the entry** — derivable from the
  bytes, so it could only disagree with them.

## Consequences

- Hash verification in the browser needs `crypto.subtle`, which requires a
  secure context for the Player.
- Font identities in the render manifest (specification §8) are the
  `contentHash` values.
- Without media metadata in the document, "audio shorter or longer than its
  clip" and "image pixels versus its node box" are rules for PR-07 and PR-03.
- The pull request that adds the fixture binaries replaces the placeholders and
  adds a test that hashes the files.

## Verification

- `packages/schema/test`: the hash pattern, an unresolved reference, and a
  reference to an asset of the wrong type are typed errors.
- `tests/repo/fixture-assets.test.ts` is a tripwire: it fails as soon as a
  binary asset exists in `@kadrion/test-fixtures` while a placeholder hash is
  still present.
