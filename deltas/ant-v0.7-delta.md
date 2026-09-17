# `.ant` v0.6 → v0.7 delta

This minor version adds one native data kind, `ontology_revision`, and
one trailer count, `ontologyRevisions`. Existing record shapes retain
their v0.6 meaning and bytes.

## 1. Record envelope

```json
{"kind":"ontology_revision","data":{...}}
```

The camelCase `data` object is one immutable elected ontology revision.
It contains the semantic id `orv1:<manifestSha256>`, tenant/project
scope, the exact reviewed manifest and digest, the authenticated first
publisher, first request identity and digest, first commit time, and the
committed `ontology/v1` / `ontology` conditional-head position.

The typed manifest pins the reviewed source, target, and dependency
vault revisions and ontology heads; carries the common base; elects
typed schema, predicate, mapping, and rule definitions; explicitly
publishes native records and prerequisite ontology revisions; retains
accepted, competing, and rejected positions plus contributor
attribution; and embeds the complete approval attestation and digest.

All semantic hashes use `antares-canonical-json-v1`: SHA-256 over the
ASCII encoding name, one zero byte, and canonical UTF-8 JSON. This is
not RFC 8785 JCS.

## 2. Immutability and closure

The first envelope is immutable. An identical replay may reuse it; a
changed request under one idempotency key, the same manifest under a
second key, or different envelope bytes under one revision id is an
integrity conflict.

Every semantic support, accepted claim, retained position, and
attribution record must be listed in `publishedRecords` with its exact
kind, id, and content digest. Required source, common-base, and
dependency revisions must be listed in `publishedRevisionRefs`.
Archives write prerequisites before dependents. Importers either resolve
the exact prerequisite from a trusted destination store or refuse the
archive; they never substitute current bytes.

Import reconstructs only revision domain `ontology/v1`, chain
`ontology`, with `initializedFromExisting` false. Domain mismatch,
chain mismatch, forks, cycles, missing predecessors, divergent existing
envelopes, and a predecessor inconsistent with the reviewed target head
are hard errors.

## 3. Trailer and compatibility

The trailer adds `ontologyRevisions`. It is the number of
`ontology_revision` data lines in the stream. A v0.7 reader defaults the
key to zero when reading v0.6 or older files and ignores unknown future
count keys. A v0.6 reader skips the new record kind while hashing its
line and ignores the new count key, as required by the minor-version
compatibility rule.

## 4. Implementation checklist

- Add `ontology_revision` to the known data-kind set.
- Add `ontologyRevisions` to counts with a zero default.
- Preserve the full payload and first-envelope bytes.
- Validate manifest/envelope identity, canonical content digests,
  explicit closure, dependency order, and conditional-chain integrity.
- Regenerate the JSON Schema and deterministic conformance goldens from
  the canonical Rust writer.
- Update the Python and JavaScript bindings and run both conformance
  runners.

The OpenSPG-compatible `/public/v1` surface is unchanged.
