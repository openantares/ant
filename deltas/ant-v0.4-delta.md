# `.ant` v0.3 → v0.4 delta

For whoever applies this to the spec, the JSON Schema, and the Python /
JS bindings. Written to be sufficient on its own — you should not need
to read the Rust.

Reference implementation: `crates/ant-types/src/contradiction.rs` (the
record), the `antares-format` crate (container). The reference server's
importer, exporter and closure verifier apply the closure rule below on
write, import, export and verification.

**One new kind, one reason.** A contradiction case — two or more exact
claim revisions compared, with what the evidence says, what it would
cost and where the work stands kept as three separate states — is
first-class knowledge. It has to export, import, sync to followers and
verify like a belief. Carried as ids inside JSON metadata it would have
let a "valid" archive omit the very revisions it compares; as a native
kind, the archive's closure rule reaches it.

---

## 1. The record

```json
{"kind":"contradiction_case","data":{
  "id":"case_hc_1@1", "caseId":"case_hc_1", "previousRevisionId":null-or-absent,
  "tenantId":1, "projectId":1, "family":"same_subject_numeric",
  "claims":[{"kind":"belief","id":"bel_hc_1","version":1},
            {"kind":"observation","id":"obs_hc_2"}],
  "evidence":[{"evidenceId":"ev_hc_1","pointer":{"charStart":10,"charEnd":14}}],
  "measurements":[{"name":"amount_a","value":1200,"unit":"employees",
                   "evidenceId":"ev_hc_1","pointer":{"charStart":10,"charEnd":14}}],
  "comparator":{"comparator":"numeric_tolerance","comparatorVersion":"1.2",
                "ruleId":"headcount_agreement","ruleVersion":"3",
                "model":null-or-absent,"modelVersion":null-or-absent,
                "snapshotId":"snap_2026_08_10"},
  "supporting":[{"evidenceId":"ev_hc_2","dependency":{"kind":"independent"}},
                {"evidenceId":"ev_hc_3","dependency":{"kind":"forwardedCopy","of":"ev_hc_2"}}],
  "refuting":[],
  "vaultOccurrences":[{"vaultId":"vault_main","itemId":"hooli/headcount",
                       "revision":"r7","conditions":["fiscal_year=2026"]}],
  "epistemic":"incompatible", "impact":"harmful", "workflow":"awaiting_review",
  "proposalId":"prop_hc_1", "reviewReceipts":["ev_review_1"],
  "revisedAt":"2026-08-10T09:00:00Z", "author":{...author_stamp...}, "metadata":{}
}}
```

Rules:

- **camelCase throughout**, on the HTTP surface and in the file alike.
  This is the first snake_case-free core payload; the reason is that
  the record IS the wire shape, so what a leader's capture middleware
  records is byte-for-byte what its store holds and what the archive
  carries. Do not infer this kind's casing from `belief`'s.
- **`id` is a REVISION id**, unique per record and never rewritten.
  `caseId` is the stable identity every revision shares. A change is a
  new record whose `previousRevisionId` names the one it supersedes.
  The same `id` arriving again with identical content is an idempotent
  replay; with different content it is a REFUSED write (HTTP 409
  `CASE_REVISION_IMMUTABLE`). A second vault occurrence is a new
  revision carrying one more reference, not a second case.
- **Two or more `claims`.** Each names a plane (`belief` |
  `observation` | `evidence`) and an id; a belief claim may pin a
  `version`; an evidence claim may carry a `pointer` (char/byte span,
  JSON pointer `path`).
- **Three state families, each required, each independent:**
  `epistemic` ∈ {`incompatible`, `compatible`, `uncertain`,
  `insufficiently_comparable`}; `impact` ∈ {`harmful`, `alignment_only`,
  `unassessed`}; `workflow` ∈ {`open`, `awaiting_clarification`,
  `awaiting_review`, `contested`, `deferred`, `settled`, `reopened`}.
- **Content is referenced, never copied.** Material, measurements,
  receipts and positions are ids and offsets into evidence records.
  `dependency` says whether material stands on its own: a
  `forwardedCopy` or `derived` item is not an independent witness of
  the source it copies.
- `vaultOccurrences` reference a vault the archive does not carry (the
  vault scope is the next format item); they are not closure-checked in
  v0.4.

## 2. Closure — the reason for the kind

An archive containing a case MUST contain every record the case
references:

| reference | must resolve to |
|---|---|
| `claims[kind=belief]` | a `belief` record with that `id` — and, when `version` is given, that `belief_version` |
| `claims[kind=observation]` | an `observation` record |
| `claims[kind=evidence]`, `evidence[]`, `measurements[].evidenceId`, `supporting[]`/`refuting[]` `evidenceId` AND their `dependency.of`, `reviewReceipts[]` | an `evidence` record |
| `previousRevisionId` | a `contradiction_case` record, earlier in the file |

A reader that checks closure MUST report a file that violates this as
unclosed, exactly as it reports a dangling evidence id today (the
reference server's verifier reports, e.g., `belief:bel_hc_1 (cited by
contradiction_case case_hc_1@1)`). A **writer** MUST emit a previous
revision before its successor, and every referenced record before the
case. The reference exporter pulls a case's whole closure into a seed
selection — including a compared belief's subject vertex, which a
traversal that never reached that subject would otherwise leave behind.

The reference server goes one step further than the archive rule: a
case is written NOWHERE without its references. The HTTP upsert refuses (400
`CASE_UNRESOLVED_REFERENCE`) unless every referenced belief revision,
observation, evidence record, receipt and previous revision is already
in the scope; the sync apply path applies the same check (on a feed the
references precede the case because the leader enforced it); an import
refuses at the case, naming what it lacks, rather than landing a case
with nothing to compare.

## 3. Trailer and readers

`counts` gains `contradictionCases`. It MUST default to zero when
absent (a v0.3 trailer). A reader MUST ignore count keys it does not
know: they count kinds the reader skipped, and failing on them would
turn every additive kind into a breaking change. The Rust reader
already did this (serde ignores unknown fields; there is now a test).
**The v0.3 Python and JS bindings did not** — both compared the trailer
dict strictly, so a v0.4 file fails them with `counts mismatch`. That
is a bug in those bindings against §7/§8 of the spec, fixed in the v0.4
bindings, which compare only the keys they know and default missing
later-version keys to zero. Anyone on a v0.3 binding should upgrade
before receiving v0.4 files.

This is a MINOR bump: nothing an older reader could read has changed
meaning; it skips `contradiction_case` records, hashes them, and reports
the file as ahead of it.

## 4. JSON Schema

`schema/ant.schema.json` (same `$id`; title now "format 0.4") gains
`$defs.contradiction_case` plus `claim_ref`, `source_pointer`,
`evidence_ref` and `material`, a branch in the top-level `oneOf`, and —
**the `oneOf` trap from the v0.2 and v0.3 deltas, third time** —
`"contradiction_case"` added to `unknown_kind`'s exclusion list, or a
case record matches two branches and the schema rejects it.

## 5. Bindings checklist (same commit, standing rule)

- [ ] `FORMAT_MINOR` 3 → 4.
- [ ] `contradiction_case` in the data kinds; `contradictionCases` in
      the count keys / counts object.
- [ ] Trailer comparison: known keys only; missing later-version keys
      default to zero.
- [ ] Surface the kind as a record (a binding that skips it still
      verifies the golden — the runner catches it through
      `recordKinds` and `epistemicStates`).
- [ ] `run_conformance.py` and `run_conformance.mjs` green.

## 6. Conformance

`golden/contradiction_cases.ant`: two companies, eight evidence records,
four observations, one belief, four case revisions of three cases —
one synthetic incompatible pair fully dressed (measurements with
positions, a source and its forwarded copy, a receipt, a vault
occurrence, a proposal id) and the two documented false-positive
shapes as NON-cases: a model-invented shared subject
(`insufficiently_comparable`, settled on a review receipt) and a
withdrawal receipt (a case opened incompatible, then a second revision
`compatible`/`settled` naming the first as its predecessor). Real
corpus cases replace them in a later release. Every other golden was
regenerated at v0.4; their bytes change only by the version and the new
trailer key.

Redaction audit of the new fixture (pre-publication): every id, name
and content string is synthetic — the companies are the fictional
"Hooli Corp" / "Pied Piper Inc" already used by `basic.ant`, and the
decompressed lines were grepped for e-mail addresses, phone numbers,
URLs outside the `antares://` scheme, key/token/password material and
person names; none present. The audit command is in the pending master
entry.

## 7. Not in this bump

- The vault scope: `vaultOccurrences` are references outside the
  archive; a vault kind, and closure over it, is the next item.
- Publishable crate versions (`ant-types`, `antares-format`,
  `openantares`): a release-prep decision, made separately as it was
  for v0.3 — they moved to 0.2.0 in the release-prep commit that
  followed.
- Tombstones for cases: revisions are immutable and a case is closed
  over by other cases; retraction would be a revision (`workflow`
  `settled` with a receipt), not a delete.
