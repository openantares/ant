# `.ant` format changelog

What changed at each bump and the order to apply it in. Each entry
links the delta note written for whoever applies the bump to the spec,
the JSON Schema and the bindings; `SPEC.md` supersedes a delta where
they differ.

| format | date | change | delta |
|---|---|---|---|
| 0.7 | 2026-09-17 | `ontology_revision` record kind: immutable elected semantic manifests with exact vault/head pins, typed definitions, explicit record and revision closure, retained positions and attribution, complete approval binding, first-publisher identity, idempotency identity, and the `ontology/v1` conditional head position; trailer key `ontologyRevisions` | [deltas/ant-v0.7-delta.md](deltas/ant-v0.7-delta.md) |
| 0.5 | 2026-09-14 | `relationship_proposal` record kind: immutable revisions of what a reconnaissance run proposed about a source — the proposed join, the run and source manifest, the measurement (PRODUCT-192's evidence contract), the SQL probes, and the status, with a reviewer's receipt when promoted; native closure; trailer key `relationshipProposals` | [deltas/ant-v0.5-delta.md](deltas/ant-v0.5-delta.md) |
| 0.4 | 2026-09-10 | `contradiction_case` record kind: immutable revisions comparing exact claim revisions, three state families, native closure; trailer key `contradictionCases`; readers ignore unknown count keys | [deltas/ant-v0.4-delta.md](deltas/ant-v0.4-delta.md) |
| 0.3 | 2026-08 | typed property envelopes `{"$ant": ..., "v": ...}` for decimal, date, time, timestamp, uuid, bytes, sized ints and arrays; the six legacy shapes unchanged | [deltas/ant-v0.3-delta.md](deltas/ant-v0.3-delta.md) |
| 0.2 | 2026-08 | version policy (same major reads, unknown kinds skipped-but-hashed, minor-ahead flag); `vertex_tombstone` / `edge_tombstone` | [deltas/ant-v0.2-delta.md](deltas/ant-v0.2-delta.md) |
| 0.1 | 2026-07 | first version: manifest, trailer with SHA-256 and counts, schema_type, vertex, edge, observation, evidence, belief, vector | — |

The JSON Schema is served at its `$id`,
`https://openantares.org/schema/ant.schema.json`, and describes every
record line of the current minor; a reader must still treat unknown
kinds as skippable (§8 of the spec).
