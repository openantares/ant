# `.ant` format changelog

What changed at each bump and the order to apply it in. Each entry
links the delta note written for whoever applies the bump to the spec,
the JSON Schema and the bindings; `SPEC.md` supersedes a delta where
they differ.

| format | date | change | delta |
|---|---|---|---|
| 1.0 | 2026-09-23 | **major**, written only for a selection that carries stored originals (anything else is still written as 0.7, byte for byte): `evidence.source_blob` (typed reference to an original's asset id, length, SHA-256, media type and file name); `original_chunk` records (the original's bytes, base64, in order, right after their evidence, each chunk digest-checked and the whole verified against `sourceBlob`); `original_source` records (append-only provenance of an original, after its chunks); `evidence.derivation` (typed, immutable `antares.normalized-text/v1` binding of blob-free cleaned-text evidence to its primary's exact original, grouped after the original's source references, closed both ways on export); trailer keys `originalChunks` / `originalSources`, omitted when zero; data lines bounded at 64 MiB and the manifest held to a memory budget. A 0.x reader refuses the file at its manifest, so no reader can silently drop an original | [deltas/ant-v1.0-delta.md](deltas/ant-v1.0-delta.md) |
| 0.7 | 2026-09-17 | `ontology_revision` record kind: immutable elected semantic manifests with exact vault/head pins, typed definitions, explicit record and revision closure, retained positions and attribution, complete approval binding, first-publisher identity, idempotency identity, and the `ontology/v1` conditional head position; trailer key `ontologyRevisions` | [deltas/ant-v0.7-delta.md](deltas/ant-v0.7-delta.md) |
| 0.6 | 2026-09-15 | explicitly-unknown observation time: `observed_at` / `extracted_at` on `observation` become an **event time** with three disjoint wire forms — a bare RFC3339 string (Known, no basis; byte-identical to v0.5, so every dated record reads and re-exports unchanged), `{"known":{"at":…,"basis":…}}` (basis one of `source_record_time`, `asserted_valid_from`, `source_field_binding`), `{"unknown":{"reason":…}}` (reason one of `no_source_time`, `asserted_without_date`, `current_state_only`, `ambiguous_source_time`, `implausible_source_time`); unknown is neither null nor a sentinel and no reader may substitute an epoch or "now"; event time is never fabricated, provenance time may carry a basis; field encoding only, no new record kind, no trailer change | [deltas/ant-v0.6-delta.md](deltas/ant-v0.6-delta.md) |
| 0.5 | 2026-09-14 | `relationship_proposal` record kind: immutable revisions of what a reconnaissance run proposed about a source — the proposed join, the run and source manifest, the measurement (PRODUCT-192's evidence contract), the SQL probes, and the status, with a reviewer's receipt when promoted; native closure; trailer key `relationshipProposals` | [deltas/ant-v0.5-delta.md](deltas/ant-v0.5-delta.md) |
| 0.4 | 2026-09-10 | `contradiction_case` record kind: immutable revisions comparing exact claim revisions, three state families, native closure; trailer key `contradictionCases`; readers ignore unknown count keys | [deltas/ant-v0.4-delta.md](deltas/ant-v0.4-delta.md) |
| 0.3 | 2026-08 | typed property envelopes `{"$ant": ..., "v": ...}` for decimal, date, time, timestamp, uuid, bytes, sized ints and arrays; the six legacy shapes unchanged | [deltas/ant-v0.3-delta.md](deltas/ant-v0.3-delta.md) |
| 0.2 | 2026-08 | version policy (same major reads, unknown kinds skipped-but-hashed, minor-ahead flag); `vertex_tombstone` / `edge_tombstone` | [deltas/ant-v0.2-delta.md](deltas/ant-v0.2-delta.md) |
| 0.1 | 2026-07 | first version: manifest, trailer with SHA-256 and counts, schema_type, vertex, edge, observation, evidence, belief, vector | — |

The JSON Schema is served at its `$id`,
`https://openantares.org/schema/ant.schema.json`, and describes every
record line of the current minor; a reader must still treat unknown
kinds as skippable (§8 of the spec).
