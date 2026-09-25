# OpenAntares conformance suite

Golden `.ant` files produced by the canonical Rust writer, plus one
runner per implementation. Every implementation must:

1. read and fully verify the goldens (trailer sha256 + counts),
2. report the expected manifest scope, record sequence, and counts
   (`golden/expected.json`),
3. skip unknown record kinds while still verifying
   (`forward_compat.ant` carries a `hologram` record),
4. surface `vertex_tombstone` / `edge_tombstone` as records and count
   them (`tombstones.ant`) — a binding that treats them as unknown
   kinds still VERIFIES the file, so it would look correct while
   dropping every deletion on the floor,
5. reject the negative goldens listed in `golden/expected_negatives.json`
   (`major_version.ant` declares v2.0 and is valid in every other
   respect, so a reader of 0.x and 1.x must refuse it for the VERSION),
6. read a file whose MINOR is ahead of the reader, and report that it
   saw a subset — this is the rule most often implemented as
   `version == "0.2"`, which passes every positive test while being
   wrong,
7. reject the synthesized negatives: tampered record bytes, missing
   trailer, chopped compressed stream, data after the trailer, wrong
   counts, a different MAJOR version, an unparsable version, non-zstd
   input,
8. read `contradiction_cases.ant` (v0.4) and SURFACE every
   `contradiction_case` record. A binding that skips the kind as
   unknown still verifies the file, so `expected.json` pins the record
   sequence and the epistemic and workflow states the binding reports
   (`epistemicStates`, `workflowStates`),
9. ignore trailer count keys it does not know — they count kinds it
   skipped — while defaulting later-version keys it does know to zero.
10. read `ontology_revisions.ant` (v0.7), surface the native revision,
    and report its semantic id, target vault, previous head, semantic
    item kinds, and conditional domain/chain. The fixture also pins
    exact record/revision closure and the immutable first-publisher
    envelope.
11. read `relationship_proposals.ant` (v0.5) and SURFACE every
    `relationship_proposal` record, reporting each one's status and the
    support it measured (`proposalStatuses`, `proposalMatched`,
    `proposalNonNull`). The measurement is the point: the golden's
    quarantined hypothesis matched 0 of 1914 rows, and a binding that
    skips the kind as unknown still verifies the file while leaving a
    grader nothing to read.
12. read `unknown_time.ant` (v0.6) and report the DECODED state of each
    observation's times, not just the record count. `observed_at` and
    `extracted_at` are one of three disjoint shapes — a bare RFC3339
    string (known, no basis), `{"known":{"at":…,"basis":…}}`, or
    `{"unknown":{"reason":…}}` — and `expected.json` pins the observed
    states, the extracted bases and the unknown reasons
    (`observedTimeStates`, `extractedTimeBases`, `unknownReasons`). A
    binding that cannot read the additive form misclassifies these, and
    one that stands epoch, now or zero in for an unknown time is wrong.
13. read `originals.ant` (v1.0) and reassemble each stored original from
    its `original_chunk` records, reporting its evidence id, length,
    SHA-256 and chunk count (`originals`) — including an EMPTY original,
    which has no chunks and the empty digest — and list the ids of the
    `original_source` records that follow it (`sourceReferenceIds`). A
    binding that skips the kinds as unknown still verifies the file, and
    would hand its caller evidence without the bytes or provenance it
    names. Then list the cleaned-text derivatives that follow the
    original (`derivatives`: evidence id, primary, job and slot), read as
    typed derivations — a binding that flattens them to plain evidence
    loses what they were cleaned from.
14. reject every `original_*` and `derivative_*` negative in
    `golden/expected_negatives.json`, each valid in every other respect: a
    missing chunk, reordered chunks, a chunk that does not match its own
    digest, chunks that are each sound but together are not the declared
    original, a record between an evidence and its chunks, a v0.7 file
    carrying originals, a source reference that does not bind to the
    original it follows, a derivative that does not follow its primary's
    original, one that binds other bytes, one whose content is not the
    text it names, and derivatives out of (jobId, index) order.

Format versions: **0.7**, and **1.0** for a file that carries stored
originals. [`../SPEC.md`](../SPEC.md) is normative. The
format changelog records what changed at each bump and the order to
apply it in; the spec supersedes it where they differ.

**v0.3 — SQL property types.** The v0.2 scalar set
(`null | bool | number | string | object`) could not express DECIMAL,
DATE, TIME, TIMESTAMP, UUID or BLOB: all of them are JSON strings, so a
reader could not tell them apart from text and the type was lost on the
first round-trip. v0.3 leaves those five shapes byte-identical and adds
a tagged envelope, `{"$ant":"<type>","v":<payload>}`, for the typed
values — see `propertyValue` in `../schema/ant.schema.json` for the
exact set. An object is an envelope ONLY when it has exactly the keys
`$ant` and `v` and `$ant` names a known type, so a producer's own
document carrying a `$ant` field still round-trips as that document.

Two rules a conforming reader is most likely to get wrong, both
exercised by `basic.ant`:

- **A decimal is a string, and must not be parsed as a float.** The
  golden's `exact_amount` is `12345678901234567.89`, which an IEEE
  double cannot hold; an implementation that parses it as a number
  rounds it silently and produces a different value with no error.
- **A timestamp keeps its offset.** The golden's `signed_at` is
  `2026-08-10T09:00:00+02:00`. Normalizing it to `Z` on read loses the
  one thing that distinguishes TIMESTAMPTZ from TIMESTAMP.

Because the bump is additive, a v0.2 reader still reads a v0.3 file — it
just sees the envelopes as plain objects, which is exactly what the
"minor is ahead of this reader" signal is for.

**v0.4 — contradiction cases.** A new record kind, `contradiction_case`:
one immutable revision of a case comparing two or more exact claim
revisions, with epistemic, business-impact and workflow state kept
separate, carrying references (belief versions, observations, evidence
positions, receipts, vault occurrences) and never copies. An archive
holding a case must hold everything it references — a closure
verifier refuses one that does not. The trailer gains
`contradictionCases`; a reader MUST ignore count keys it does not know.
The golden's two non-cases are the documented false-positive shapes (a
model-invented shared subject; a withdrawal receipt) and are replaced
by real corpus cases in a later release. See `../SPEC.md` §5.2 and
[`deltas/ant-v0.4-delta.md`](../deltas/ant-v0.4-delta.md).

The two runners in this repository, both of which you can run here:

**v0.5 — relationship proposals.** A new record kind,
`relationship_proposal`: one immutable revision of what the
reconnaissance loop proposed, the support it measured (rows matched
over rows non-null, with the sampling method and its parameters) and
what was decided — `supported`, `quarantined_hypothesis` with its
reason, or `promoted_by_reviewer` with its receipt. An archive holding
a proposal must hold the findings, probe results and receipt it cites —
a closure verifier refuses one that does not. The schema states the
conditional rules (a `full_scan` carries no percent, seed or cap; a
repeatable sample carries its seed; a capped prefix carries its cap; a
quarantine carries its reason; a promotion carries its receipt), and
the Python runner checks that each malformed shape is rejected. The
trailer gains `relationshipProposals`. See `../SPEC.md` §5.3 and
[`deltas/ant-v0.5-delta.md`](../deltas/ant-v0.5-delta.md).

**v0.6 — explicitly unknown observation time.** One shape change and no
new kind. An observation's `observed_at` (the event time) and
`extracted_at` (the provenance time) were required bare RFC3339
strings, so a genuinely dateless original could not be represented at
all. Each is now one of three disjoint shapes: the bare string it always
was (known, no basis), `{"known":{"at":…,"basis":…}}`, or
`{"unknown":{"reason":…}}`. A dated record is byte-identical to its v0.5
form, so an older reader still reads every dated observation. Unknown
is not null and not a sentinel: no reader may substitute epoch, now or
zero for it. The trailer is unchanged. See `../SPEC.md` §5.4 and
[`deltas/ant-v0.6-delta.md`](../deltas/ant-v0.6-delta.md).

**v0.7 — elected ontology revisions.** The new `ontology_revision`
kind preserves the complete reviewed semantic manifest and immutable
election envelope. The conformance vector reports semantic identity,
typed item kinds, target vault, prior ontology head, and the
`ontology/v1` / `ontology` conditional position so an implementation
cannot pass by skipping the kind. The trailer gains
`ontologyRevisions`; older trailers default it to zero.

**v1.0 — stored originals.** A MAJOR, because a 0.x reader would skip
the new kind and field and import every evidence without its original;
a different major is refused at the manifest instead. Only a file that
carries an original is 1.0 — everything else is still written as 0.7,
byte for byte. An evidence's `source_blob` names the original
(`assetId`, `byteLength`, `sha256`, `mediaType`, `fileName`), and its
bytes follow it at once as `original_chunk` records (SPEC §5.6,
`../deltas/ant-v1.0-delta.md`). The golden pins one 150-byte original in
three chunks, one empty original and one plain evidence; the trailer
gains `originalChunks`, omitted when zero.

| implementation | runner | negatives | schema check |
|----------------|--------|-----------|--------------|
| Python | `python3 run_conformance.py` | yes: synthesized, plus every file in `expected_negatives.json` | yes — `jsonschema` required; its absence is a failed check |
| JavaScript | `node run_conformance.mjs` | yes: synthesized, plus every file in `expected_negatives.json` | covered by the Python runner |

The goldens themselves are written by `antares-format`, the canonical
Rust implementation, which is upstream and not part of this repository.
Regenerating them is an upstream act reserved for deliberate format
changes; consuming them needs nothing but the runners above.
