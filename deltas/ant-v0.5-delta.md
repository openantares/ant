# `.ant` v0.4 → v0.5 delta

For whoever applies this to the spec, the JSON Schema, and the Python /
JS bindings. Written to be sufficient on its own — you should not need
to read the Rust.

Reference implementation: `crates/ant-types/src/proposal.rs` (the
record and PRODUCT-192's measurement contract), the `antares-format` crate
(container). The reference server's importer, exporter and closure
verifier apply the closure rule below on write, import, export and
verification.

**One new kind, one reason.** A grader reading an archive reported
ZERO relationship proposals, twice. Not because the reconnaissance loop
found none — because what it found lived in receipts local to one
server: the proposals, the measured support behind them, and the
quarantines. A record kind gives them a home that exports, imports,
syncs to followers and verifies like a belief. Carried as ids inside
JSON metadata it would have moved the problem rather than solved it: a
"valid" archive could still omit the finding a proposal rests on, and a
promotion could still name a receipt nobody has. As a native kind, the
archive's closure rule reaches it.

---

## 1. The record

```json
{"kind":"relationship_proposal","data":{
  "id":"prop_ord_cust@2", "proposalId":"prop_ord_cust",
  "previousRevisionId":"prop_ord_cust@1",
  "tenantId":1, "projectId":1,
  "origin":{
    "runId":"run_2026_09_12_01", "reconVersion":"2.1",
    "sourceManifest":{"connection":"shop","planHash":"9f2b7c1d4e6a8035",
                      "catalogHash":"3c5e9017ab42d6f8",
                      "policyVersion":3,"policyHash":"1467488ba7a68011"},
    "model":null-or-absent, "modelVersion":null-or-absent},
  "relation":{
    "subjectType":"Shop.Order", "predicate":"placedBy", "targetType":"Shop.Customer",
    "sourceRelation":"shop.orders", "sourceKeyColumns":["customer_ref"],
    "targetRelation":"shop.customers", "targetKeyColumns":["code"],
    "normalization":{"source":"trim_lower","target":"trim_lower"}},
  "support":{
    "contractVersion":1, "method":"join_match_scan", "methodVersion":1,
    "sourceRows":1000, "sourceNonNull":900, "matchedRows":890,
    "targetRows":50, "targetNonNull":50, "targetDistinct":50,
    "sampling":{"method":"full_scan"},
    "fingerprint":"sha256:1a2b3c4d5e6f7081", "minSupport":0.95},
  "status":"promoted_by_reviewer",
  "receipt":{"reviewer":"user:reviewer_1","decidedAt":"2026-09-12T09:30:00Z",
             "reason":"the customer code is the documented external key",
             "receipt":"ev_review_ord_cust"},
  "findings":["ev_find_ord_cust"],
  "probes":[{"name":"matched_rows",
             "statement":"SELECT count(*) FROM shop.orders o JOIN shop.customers c ON lower(btrim(o.customer_ref)) = lower(btrim(c.code))",
             "dialect":"postgres","ranAt":"2026-09-12T08:00:02Z",
             "evidenceId":"ev_probe_ord_cust"}],
  "proposedAt":"2026-09-12T09:30:01Z", "author":{...author_stamp...}, "metadata":{}
}}
```

Rules:

- **camelCase throughout**, on the HTTP surface and in the file alike,
  for the reason the case has it: the record IS the wire shape, so what
  a leader's capture middleware records is byte-for-byte what its store
  holds and what the archive carries. Do not infer this kind's casing
  from `belief`'s.
- **`id` is a REVISION id**, unique per record and never rewritten.
  `proposalId` is the stable identity every revision shares. A change
  is a new record whose `previousRevisionId` names the one it
  supersedes. The same `id` arriving again with identical content is an
  idempotent replay; with different content it is a REFUSED write (HTTP
  409 `PROPOSAL_REVISION_IMMUTABLE`). A quarantined hypothesis a
  reviewer later promotes is two revisions, not an edit.
- **`status` is a flattened tag** on the payload, not a nested object:
  `quarantined_hypothesis` and `refuted` carry a sibling `reason`;
  `promoted_by_reviewer` carries a sibling `receipt`; `supported`
  carries neither.
- **`supported` must be supported.** A proposal may be labelled
  `supported` only when its own measurement clears its own declared
  `minSupport`, with a non-empty denominator, a non-zero numerator and
  a unique target key. One that falls short is a
  `quarantined_hypothesis` — a finding, not a malformed record. The
  live shape is `0 / 1914`: well-formed, measured, and the opposite of
  supported. This is the only semantic rule the format states about a
  status, and it exists because that label is what a consumer reads to
  decide whether a join may be acted on.
- **Promotion is a trusted human action, never a model boolean.** There
  is no way to spell `promoted_by_reviewer` without naming a reviewer,
  a time, a reason and a receipt record — and the receipt is
  closure-checked, so a promotion whose receipt is absent is not a
  promotion. A reviewer MAY promote a proposal whose measurement falls
  short; promoting one that already clears the bar is not the point.
- **The measurement is PRODUCT-192's contract**, unchanged and now
  defined once: `sourceNonNull` is the denominator (a null key is not a
  failed match, it is no reference at all), `matchedRows` the
  numerator, `targetDistinct == targetNonNull` exactly when the key
  lands on one row, and `minSupport` travels WITH the evidence because
  a ratio without the bar it cleared is not a claim. `sampling` must be
  reproducible: `system_repeatable` / `bernoulli_repeatable` require
  `percent` and `seed`, `capped_prefix` requires `cap`, `full_scan`
  carries none of them.
- **`normalization`** has two operators, not one — `source`, and
  `target` defaulting to it. A consumer RESOLVES the normalized source
  value among the normalized target keys; it must not transform a
  source string and assume the result names a target.
- **`probes[].statement` is the statement AS EXECUTED, parameterized.**
  A probe is a question about a shape; customer values must not be
  inlined into it.
- **`origin.sourceManifest` pins the source by hash.** Without it a
  later reader cannot tell whether the source has moved under the
  proposal.
- **Recording a proposal never publishes it.** A proposal, promoted or
  not, is a record of what was proposed and decided. Turning one into a
  mapping is a separate act under whatever rules the consumer applies
  to mappings.

## 2. Closure — the reason for the kind

An archive containing a proposal MUST contain every record it
references:

| reference | must resolve to |
|---|---|
| `findings[]` | an `evidence` record |
| `probes[].evidenceId`, when present | an `evidence` record |
| `receipt.receipt` (a promotion) | an `evidence` record |
| `previousRevisionId` | a `relationship_proposal` record, earlier in the file |

A reader that checks closure MUST report a file that violates this as
unclosed, exactly as it reports a dangling evidence id (the reference
server's verifier reports, e.g., `evidence:ev_review_ord_cust (cited by
relationship_proposal prop_ord_cust@2)`). A **writer** MUST emit a
previous revision before its successor, and every referenced record
before the proposal.

The reference server goes one step further than the archive rule: a
proposal is written NOWHERE without its references. The HTTP upsert
refuses (400 `PROPOSAL_UNRESOLVED_REFERENCE`) unless every finding,
probe result, receipt and previous revision is already in the scope;
the sync apply path applies the same check (on a feed the references
precede the proposal because the leader enforced it); an import refuses
at the proposal, naming what it lacks, rather than landing a promotion
nobody can check.

## 3. Trailer and readers

`counts` gains `relationshipProposals`. It MUST default to zero when
absent (a v0.4 trailer). A reader MUST ignore count keys it does not
know: they count kinds the reader skipped, and failing on them would
turn every additive kind into a breaking change. The v0.4 Python and
JS bindings already do this (it was fixed for v0.4), so a v0.4 binding
reads a v0.5 file, skips the new kind, and still verifies.

This is a MINOR bump: nothing an older reader could read has changed
meaning; it skips `relationship_proposal` records, hashes them, and
reports the file as ahead of it.

## 4. JSON Schema

`schema/ant.schema.json` (same `$id`; title now "format 0.5") gains
`$defs.relationship_proposal` plus `proposal_origin`,
`source_manifest_ref`, `proposed_relation`, `relation_support`,
`sampling`, `normalization`, `normalization_op`, `probe_ref` and
`reviewer_receipt`; a branch in the top-level `oneOf`; and —
**the `oneOf` trap from the v0.2, v0.3 and v0.4 deltas, fourth time** —
`"relationship_proposal"` added to `unknown_kind`'s exclusion list, or
a proposal record matches two branches and the schema rejects it.

Two rules are expressed as schema conditions rather than left to prose,
because both are cheap to encode and expensive to get wrong:

- `status` → required sibling: `promoted_by_reviewer` requires
  `receipt`; `quarantined_hypothesis` and `refuted` require `reason`.
- `sampling.method` → required parameters: the repeatable methods
  require `percent` and `seed`, `capped_prefix` requires `cap`, and
  `full_scan` forbids all three.

The `supported`-must-be-supported rule is NOT expressible per-line in
JSON Schema (it compares three numbers against a fourth); it is stated
in SPEC.md §5.3 and enforced by the reference implementation.

## 5. Bindings checklist (same commit, standing rule)

- [ ] `FORMAT_MINOR` 4 → 5.
- [ ] `relationship_proposal` in the data kinds; `relationshipProposals`
      in the count keys / counts object / later-count-keys list.
- [ ] Trailer comparison: known keys only; missing later-version keys
      default to zero (already true since v0.4).
- [ ] Surface the kind as a record (a binding that skips it still
      verifies the golden — the runner catches it through
      `recordKinds`, `proposalStatuses` and the measurement).
- [ ] `run_conformance.py` and `run_conformance.mjs` green.

## 6. Conformance

`golden/relationship_proposals.ant`: five evidence records and three
proposal revisions of two proposals —

- `prop_ord_cust@1`, SUPPORTED by its own measurement (890 of 900
  against a declared minimum of 0.95, target key unique);
- `prop_color_variant@1`, a QUARANTINED HYPOTHESIS in the shape the
  loop keeps finding — a self-join a model suggested, measured at
  **0 of 1,914**, held back with its reason and the probe that measured
  it. This is the record a grader reads instead of nothing;
- `prop_ord_cust@2`, the first PROMOTED BY A REVIEWER: a new revision
  naming its predecessor and carrying who decided, when, why, and the
  receipt — which is in the file.

The runners check the statuses, the matched-row and non-null counts,
and that every finding, probe result and receipt resolves inside the
file. Every other golden was regenerated at v0.5; their bytes change
only by the version and the new trailer key.

Redaction audit of the new fixture (pre-publication): every id, name,
column, statement and content string is synthetic — a fictional `shop`
schema (orders, customers, products) with `sku` / `code` /
`color_variant_of` columns and a `user:reviewer_1` reviewer — and the
decompressed lines were grepped for e-mail addresses, phone numbers,
URLs outside the `antares://` scheme, key/token/password material and
person names; none present.

## 7. Not in this bump

- Publishing the proposal into a mapping: recording and publishing stay
  separate acts, and the publication rules are unchanged.
- Publishable crate versions (`ant-types`, `antares-format`,
  `openantares`): a release-prep decision, made separately as it was
  for v0.3 and v0.4.
- Tombstones for proposals: revisions are immutable, and a withdrawal
  is a revision (`refuted`, with its reason), not a delete.
