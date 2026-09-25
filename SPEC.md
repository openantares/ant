# OpenAntares `.ant` Format — Specification v0.7 / v1.0

Status: normative for format versions `0.7` and `1.0`. `1.0` is `0.7`
plus stored originals (§5.6), and is written ONLY for a selection that
carries one; every other file is `0.7`, unchanged. This document plus
[`schema/ant.schema.json`](schema/ant.schema.json) are the source of
truth for the container; every implementation (the Rust crate
`antares-format`, the reference bindings under [`bindings/`](bindings/),
and any third-party reader/writer) must pass the
[conformance suite](conformance/) against them.

Change notes for the bumps that produced this version live in the
format changelog and the per-version delta notes (v0.2: version policy,
tombstones, trailer/manifest additions; v0.3: typed property values;
v0.4: contradiction cases; v0.5: relationship proposals; v0.6:
explicitly-unknown observation time; v0.7: elected ontology revisions;
v1.0: stored originals).
This spec supersedes them; where
they differ, this document and the golden files win.

## 1. Purpose

`.ant` is a self-contained, compressed, streamable container for
exchanging a *selection* of an Antares world model: schema types,
vertices, edges, observations, evidence (structured and unstructured
data ride together), beliefs, vector documents, elected ontology
revisions, and deletions. Design
goals, in priority order:

1. **Open** — plain JSON records inside a standard zstd stream; a
   reader is ~100 lines in any language with zstd and SHA-256.
2. **Integrity-checked** — truncation and tampering are detectable in
   one pass, without a side channel.
3. **Streamable** — writers emit records as they go; readers process
   them without loading the file.
4. **Forward compatible** — old readers skip record kinds they do not
   know; additive fields never break a reader.

Integrity is a **checksum, not encryption**. The format is fully open;
confidentiality, when required, is an *optional* encryption envelope
around the file, never a property of the format itself.

## 2. Container framing

A `.ant` file is **one zstd-compressed stream** (standard zstd frame,
magic `28 B5 2F FD`). The decompressed payload is **NDJSON**: UTF-8
JSON objects, one per line, separated by a single `\n` (0x0A). The
final line also ends with `\n`.

```
{"kind":"manifest", ...}                              exactly one, FIRST line
{"kind":"schema_type","data":{...}}
{"kind":"vertex","data":{...}}
{"kind":"edge","data":{...}}
{"kind":"observation","data":{...}}
{"kind":"evidence","data":{...}}
{"kind":"belief","data":{...}}
{"kind":"vector","data":{...}}
{"kind":"vertex_tombstone","data":{...}}
{"kind":"edge_tombstone","data":{...}}
{"kind":"contradiction_case","data":{...}}            v0.4
{"kind":"relationship_proposal","data":{...}}         v0.5
{"kind":"ontology_revision","data":{...}}             v0.7
{"kind":"original_chunk","data":{...}}                v1.0, right after its evidence
{"kind":"trailer","counts":{...},"sha256":"..."}      exactly one, LAST line
```

Every line is a JSON object with a string field `kind`. Data records
(anything that is not `manifest`/`trailer`) may appear in any order and
any multiplicity, including zero — with one exception: an
`original_chunk` belongs to the `evidence` record just before it, and
all of that evidence's chunks follow it immediately (§5.6).

File identification: the zstd magic **plus** a first record with
`kind == "manifest"`, `format == "antares"`, and a supported `version`.

A reader MAY bound how much it buffers per line. The Rust reader holds
the manifest to a memory budget — for every version, since the manifest
is read before the version is known:
- The manifest line may not exceed the budget, and is read with its
  buffer capped at it.
- The line plus a one-pass upper bound on its decoded size must fit the
  budget.

Both are refused by name before the parser allocates. The default budget
is 256 MiB; a reader that can afford more passes a larger one. The
manifest grows with a vault map, so a very large vault-attributed scope
can need more. The Rust reader also refuses, in a `1.x` file, a data line
over 64 MiB (§5.6). `0.x` data lines are not bounded. None of these
bounds an original: originals are chunk records of bounded size (§5.6).

## 3. Version compatibility

`version` is `MAJOR.MINOR`. A bare `"1"` is read as `1.0`; anything
that is not two integers separated by a dot is a hard error — guessing
at a version is how a reader ends up misinterpreting a payload.

The rule, which a reader MUST implement:

- **Same MAJOR → readable, at any MINOR.** Minor bumps are additive by
  definition (new record kinds, new fields, new value encodings), and
  everything a reader already understood keeps its meaning.
- **Different MAJOR → reject.** The rejection message should name both
  the file's version and the reader's, and say that majors are not
  compatible.
- **A file whose MINOR is ahead of the reader MUST be readable, and the
  reader MUST expose that it is ahead** (a `minorAhead` flag on the
  read result, or equivalent). The reader saw the file; it saw a
  *subset* of what the file means. A caller that needs completeness can
  then refuse, and one that does not can proceed.

The failure this rule exists to prevent is a version gate written as
`version == "0.2"`. That passes every positive test while being wrong,
and it locks out every future file for no reason. v0.1 shipped with
exactly that bug.

**Two majors are current: `0` and `1`.** A conforming reader of this
spec reads both. Major `1` exists because of what a `0.x` reader does
with an additive change: it skips unknown record kinds and ignores
unknown fields. A stored original introduced as a minor would therefore
be imported by every `0.x` reader as Evidence *without its original* —
silently. A `1.0` file is refused by a `0.x` reader at the manifest,
before any record. Writers use `1.0` only when the file carries an
original; a file without one is `0.7`, byte for byte as before.

## 4. The manifest (first line)

| field       | type            | required | meaning |
|-------------|-----------------|----------|---------|
| `kind`      | `"manifest"`    | yes      | |
| `format`    | `"antares"`     | yes      | belt for the zstd-magic braces |
| `version`   | string          | yes      | container layout `MAJOR.MINOR`; this spec is `"0.7"`, or `"1.0"` for a file carrying stored originals (§5.6) |
| `tenantId`  | integer         | yes      | origin tenant |
| `projectId` | integer         | yes      | origin project |
| `selection` | any JSON        | no       | what was selected (whole scope, seed query, digest params). Recorded **verbatim, not interpreted** |
| `createdAt` | RFC 3339 string | no       | |
| `producer`  | string          | no       | tool/server identifier |

A reader MUST reject a stream whose first line is not a manifest, whose
`format` is not `"antares"`, or whose `version` it does not support per
§3. A duplicate manifest anywhere later in the stream is an error.

## 5. Data records

Each data record is `{"kind":"<kind>","data":{...}}`. The `data`
payloads are the canonical JSON encodings of the corresponding Antares
core types — exactly the encoding the store uses, so an export is a
faithful byte-level snapshot. Field-name casing is therefore **mixed
by design** and normative:

- the record **envelope**, `manifest`, `trailer.counts`, the `vector`
  payload, **both tombstone payloads**, the `contradiction_case`
  payload, the `relationship_proposal` payload and the
  `ontology_revision` payload use **camelCase**
  (`tenantId`, `schemaTypes`, `recordType`, `textPreview`, `deletedAt`,
  `caseId`, `previousRevisionId`, `proposalId`, `sourceNonNull`);
- the `vertex`/`edge`/`observation`/`evidence`/`belief` payloads use
  **snake_case** (`src_type`, `subject_id`, `observed_at`,
  `value_json`, `evidenced_by`) — the core-model encoding.

Do not infer the casing of one kind from another; check the golden
files. `vertex` in particular carries only `id`, `name`, `label`,
`properties` — no tenant/project, which the manifest already scopes.

The JSON Schema in `schema/ant.schema.json` specifies the required
fields per kind; **unknown fields inside `data` MUST be
preserved-or-ignored, never an error** (additive evolution).

Kinds defined as of v0.7 (and v1.0, which adds `original_chunk`):

| kind               | since | payload |
|--------------------|-------|---------|
| `schema_type`      | 0.1   | ontology type: name, kind, properties, relations |
| `vertex`           | 0.1   | graph entity: id, name, label, typed properties |
| `edge`             | 0.1   | graph relation: id, src/dst + types, label, properties, provenance |
| `observation`      | 0.1   | append-only fact: subject, predicate, object, times, confidence, evidence ids |
| `evidence`         | 0.1   | source material: provenance + verbatim content (structured AND unstructured together) |
| `belief`           | 0.1   | current interpretation: subject, predicate, value, version, supersession metadata |
| `vector`           | 0.1   | embedding doc: record ref, label, field, float array. Vectors MUST ride in exports when the origin server does not persist vector indexes |
| `vertex_tombstone` | 0.2   | a deleted vertex: `id`, `deletedAt`, optional `author` |
| `edge_tombstone`   | 0.2   | a deleted edge: same shape |
| `contradiction_case` | 0.4 | one immutable revision of a case comparing two or more exact claim revisions: references, comparator identity, three state families (§5.2) |
| `relationship_proposal` | 0.5 | one immutable revision of a relationship a reconnaissance run proposed about a source: the proposed join, the run and source manifest, the measurement, the SQL probes, and the status — quarantined, supported, promoted by a reviewer, refuted (§5.3) |
| `ontology_revision` | 0.7 | one immutable elected ontology envelope: exact reviewed manifest, semantic definitions, evidence and revision closure, approval binding, publisher stamp, idempotency identity, commit time, and conditional ontology-head position (§5.5) |
| `original_chunk`   | 1.0   | one chunk of the stored original of the `evidence` record just before it: ids, index, offset, SHA-256 and base64 bytes (§5.6) |

### 5.1 Deletions (v0.2)

Import was additive-only in v0.1: deleting a vertex at the source and
re-exporting left the record alive at the destination forever, and the
two stores diverged with nothing able to detect it. Tombstones carry
the deletion.

Only the **vertex and edge** planes may be tombstoned. Observations are
append-only, evidence is cited by other records, and beliefs are
derived state — deleting any of those would break references that other
records still hold.

A tombstone payload is `{"id": ..., "deletedAt": <RFC3339>}` plus an
optional `author`.

On import, in this order:

1. **Edge tombstones are applied before vertex tombstones.** Deleting a
   vertex cascades to its edges exactly as a live delete does, so doing
   vertices first would make the edge accounting wrong.
2. **A tombstone whose id also appears as a LIVE record in the same
   file is skipped.** The file is self-consistent by construction: if
   it carries both a deletion and a live record for one id, the live
   record is the newer intent and wins.
3. **A tombstone for a record the destination does not have is a
   no-op**, not an error — the record may never have been imported
   there.
4. Otherwise the record is deleted.

Note that this is a within-file rule, not a timestamp comparison
against the destination store: `deletedAt` is carried for provenance
and audit, and importers are not required to compare it against stored
record times.

An importer should report how many deletions it applied, how many it
skipped as superseded, and how many named records it did not have —
otherwise "the import converged" cannot be distinguished from "the
import silently did nothing". The names of those counters are an
implementation's own API, not part of this format.

### 5.2 Contradiction cases (v0.4)

A contradiction case is first-class knowledge: two or more exact claim
revisions compared, with what the evidence says, what it would cost if
true, and where the work stands kept as THREE separate states. It
exports, imports, syncs and verifies like a belief. The reference
record is `ant_types::ContradictionCase`; the payload is camelCase.

Fields, in short (the JSON Schema is exact): `id` (this REVISION's id,
unique per record), `caseId` (the stable case identity), optional
`previousRevisionId`; `tenantId`, `projectId`; `family` (the comparison
family — cases compare within one, never across); `claims` (two or
more: `{kind: belief|observation|evidence, id, version?, pointer?}`);
`evidence` (source positions), `measurements` (values read, each with
an optional `evidenceId` and `pointer`); `comparator` (comparator, rule
and model names and versions, `snapshotId`); `supporting` and
`refuting` material, each with a `dependency` of `independent`,
`forwardedCopy {of}` or `derived {of}` — a forwarded copy is NOT an
independent witness; `vaultOccurrences` (`vaultId`, `itemId`,
`revision?`, `pointer?`, `conditions[]`); `epistemic` ∈ {`incompatible`,
`compatible`, `uncertain`, `insufficiently_comparable`}; `impact` ∈
{`harmful`, `alignment_only`, `unassessed`}; `workflow` ∈ {`open`,
`awaiting_clarification`, `awaiting_review`, `contested`, `deferred`,
`settled`, `reopened`}; optional `proposalId`; `reviewReceipts`
(evidence ids); `revisedAt`; optional `author`; `metadata`.

**Revisions are immutable.** A change is a new record with a new `id`,
the same `caseId` and `previousRevisionId` naming the record it
supersedes. Nothing is edited in place: a writer that sees the same
`id` with different content MUST refuse it. A second vault occurrence
is a new revision carrying one more reference, not a second case.

**Content is referenced, never copied.** Claims, positions,
measurements, material and receipts are ids and offsets into records
that live on their own planes.

**Closure is native.** A file containing a case MUST contain every
record the case references: the `belief` for each belief claim (and,
when `version` is given, that `belief_version`), the `observation` for
each observation claim, an `evidence` record for every evidence claim,
evidence position, measurement `evidenceId`, material `evidenceId` and
material `dependency.of`, and every review receipt; and the
`contradiction_case` named by `previousRevisionId`, EARLIER in the
file. Writers MUST emit a case after everything it references and a
previous revision before its successor. A reader that checks closure
MUST report a violation the way it reports a dangling evidence id. An
importer MUST refuse a case it cannot resolve against the file and its
own store, rather than land a case with nothing to compare. This is
the reason the kind is native: carried as ids inside `metadata`, a
"valid" file could omit the very revisions the case compares.

Vault occurrences reference a vault the file does not carry; they are
not closure-checked in v0.4.

### 5.3 Relationship proposals (v0.5)

A relationship proposal is first-class knowledge about a SOURCE: what
a reconnaissance run proposed, what it measured, which SQL probes took
the measurement, and what was decided. It exports, imports, syncs and
verifies like a belief or a case. The reference record is
`ant_types::RelationshipProposal`; the payload is camelCase.

The kind exists because the alternative does not work. A loop that
proposes joins, measures them and quarantines the ones the data
refuses produces findings that matter — and while those lived only in
receipts local to one server, a reader of an archive saw nothing.

Fields, in short (the JSON Schema is exact): `id` (this REVISION's id,
unique per record), `proposalId` (the stable proposal identity),
optional `previousRevisionId`; `tenantId`, `projectId`; `origin`
(`runId`, `reconVersion`, `sourceManifest`, and the `model` /
`modelVersion` consulted when one was); `sourceManifest` (`connection`,
`planHash`, optional `catalogHash`, `policyVersion`, `policyHash`) —
the source as the run read it, pinned by hash, so a later reader can
tell whether it has moved; `relation` (`subjectType`, `predicate`,
`targetType`, `sourceRelation`, `sourceKeyColumns[]`,
`targetRelation`, `targetKeyColumns[]`, optional `normalization`);
`support` (the measurement, below); `status` with its payload (below);
`findings[]` (evidence ids); `probes[]` (`name`, `statement`,
`dialect`, optional `ranAt` and `evidenceId`); `proposedAt`; optional
`author`; `metadata`.

**The measurement.** `support` carries what is needed to re-derive the
claim, not a score: `sourceRows`, `sourceNonNull` (THE DENOMINATOR — a
null key is not a failed match, it is no reference at all),
`matchedRows` (the numerator), `targetRows`, `targetNonNull`,
`targetDistinct` (equal to `targetNonNull` exactly when the key lands
on one row), `sampling`, a `fingerprint` tying it to the run, and
`minSupport` — the threshold it was judged against, carried WITH the
evidence, because a ratio without the bar it cleared is not a claim.
`sampling.method` is one of `full_scan`, `system_repeatable`,
`bernoulli_repeatable`, `capped_prefix`; a sampled method MUST carry
`percent` and `seed` (a measurement nobody can take again is not
evidence), `capped_prefix` MUST carry `cap`, and `full_scan` MUST
carry none of them.

**`normalization`** declares what is applied to each side before
matching: `source` and an optional `target` (defaulting to `source`),
each `trim`, `lower`, `trim_lower`, or `{"cast": <type>}`. Two
operators, not one, because "the source has trailing spaces" and "the
target is stored lowercased" are different facts. A consumer RESOLVES
the normalized source value among the normalized target keys; it MUST
NOT transform a source string and assume the result names a target.

**Status is a flattened tag** on the payload: `quarantined_hypothesis`
and `refuted` carry a `reason`; `promoted_by_reviewer` carries a
`receipt` (`reviewer`, `decidedAt`, `reason`, `receipt` — the evidence
record holding it); `supported` carries neither.

**`supported` MUST be supported.** A proposal may be labelled
`supported` only when its own measurement clears its own declared
`minSupport`, with a non-empty denominator, a non-zero numerator and a
unique target key. A measurement that falls short is a
`quarantined_hypothesis` — a finding, not a malformed record. This is
the one semantic rule the format states about a status, and it exists
because that label is what a consumer reads to decide whether a join
may be acted on.

**Promotion is a trusted human action, never a model boolean.** There
is no way to spell `promoted_by_reviewer` without naming a reviewer, a
time, a reason and a receipt record — and the receipt is closure-checked
like any other reference, so a promotion whose receipt is absent is not
a promotion. A reviewer MAY promote a proposal whose measurement falls
short; promoting one that already clears the bar is not the point.

**Revisions are immutable**, exactly as for a case: a change is a new
record with a new `id`, the same `proposalId`, and
`previousRevisionId` naming what it supersedes. A writer that sees the
same `id` with different content MUST refuse it.

**Closure is native.** A file containing a proposal MUST contain every
record it references: an `evidence` record for every `findings[]` id,
every probe `evidenceId`, and the `receipt.receipt` of a promotion;
and the `relationship_proposal` named by `previousRevisionId`, EARLIER
in the file. Writers MUST emit a proposal after everything it
references. A reader that checks closure MUST report a violation the
way it reports a dangling evidence id, and an importer MUST refuse a
proposal it cannot resolve against the file and its own store.

**Recording a proposal is not publishing it.** A proposal — including
a promoted one — is a record of what was proposed and decided. Turning
one into a mapping, materializing edges from it, is a separate act
under whatever rules the consumer applies to mappings. Nothing in this
kind authorizes it.

### 5.4 Explicitly-unknown observation time (v0.6)

An `observation` carries two times: `observed_at` (the EVENT time — when
the underlying thing happened) and `extracted_at` (the PROVENANCE time —
when an extractor produced the record). Through v0.5 both were required
bare RFC3339 strings, so a genuinely dateless original could not be
represented at all. In v0.6 each is an **event time** with three
disjoint wire forms:

```
"observed_at": "2026-08-09T10:00:00Z"                         Known, no basis
"observed_at": {"known":{"at":"2026-08-09T10:00:00Z",         Known, with a basis
                         "basis":"source_record_time"}}
"observed_at": {"unknown":{"reason":"no_source_time"}}         Unknown, the new state
```

- A bare RFC3339 string is a **Known** time with no recorded basis —
  **byte-identical to v0.5**. This is why the bump is a MINOR, additive
  one: every dated observation in every v0.5 file reads and re-exports
  unchanged, and nothing re-encodes historical records.
- `{"known":{"at",…,"basis":…}}` is a Known time whose `basis` records
  how the instant was arrived at. `basis` is one of
  `source_record_time`, `asserted_valid_from`, `source_field_binding`.
  A producer MAY populate the PROVENANCE time (`extracted_at`) with a
  basis drawn from an extraction receipt; nothing may fabricate an EVENT
  time (`observed_at`) that the source did not carry.
- `{"unknown":{"reason":…}}` is an explicitly-unknown time. `reason` is
  one of `no_source_time`, `asserted_without_date`, `current_state_only`,
  `ambiguous_source_time`, `implausible_source_time`. Unknown is **not
  null and not a sentinel**: it carries a reason, and a reader MUST NOT
  stand `epoch`, `now` or `0` in for it.

A **time-aware reader** (a time window, a time-ordered index, a
"most-recent" read) MUST treat an `unknown` time as being on **no
timeline**: excluded from time windows and time-ordered results, never
clamped to a bound. The observation remains fully present in the main
plane, in unordered listings, in the archive, and in replay. The reason
vocabulary is shared verbatim with the engine's process-mining
`EventTime`; it is one dialect, not two.

A v0.5 reader encountering a v0.6 file reads every observation whose
times are bare strings exactly as before, and errors only on an
observation that uses one of the two object forms — which is precisely
the "the file is ahead of this reader" signal §3 describes.

### 5.5 Elected ontology revisions (v0.7)

`ontology_revision` carries one immutable election of reviewed semantic
definitions. It is a native data record, not a reconstruction from
current graph state. Its `data` payload contains:

- `id`, exactly `orv1:` followed by `manifestSha256`;
- `tenantId` and `projectId`, which MUST equal the enclosing manifest;
- the exact typed `manifest` and its canonical `manifestSha256`;
- the authenticated first `publisher` (`principal`, `tokenId`,
  `subjectType`), first `requestId` and canonical `requestSha256`, and
  first `committedAt` time;
- `conditional`, the committed ontology-head position: domain
  `ontology/v1`, chain `ontology`, this `revisionId`, and an optional
  `previousRevisionId`. `initializedFromExisting` MUST be false.

The manifest is contract version 1. It pins the reviewed source,
target and dependency vault revisions and the ontology head at each
position; names the immutable common base where the target already had
a head; carries typed `semanticItems`; explicitly lists
`publishedRecords` and `publishedRevisionRefs`; retains accepted claims,
competing and rejected positions, and contributor attribution; and
includes the complete external approval attestation and its digest.
Semantic items are one of `schema_type`, `predicate_definition`,
`mapping_definition`, or `rule_definition`. Each carries a stable key,
source/review revision, typed content, canonical content digest, and at
least one native support record.

Every `contentSha256`, `electionSubjectSha256`, `manifestSha256`,
approval digest, and request digest uses the declared
`antares-canonical-json-v1` encoding: SHA-256 over the ASCII domain
prefix `antares-canonical-json-v1`, one zero byte, and canonical UTF-8
JSON bytes. This encoding is not RFC 8785 JCS. Integers remain integers,
object keys sort by Unicode scalar value, arrays retain order, and no
whitespace is emitted between tokens.

**The first envelope is immutable.** Replaying the same revision may
reproduce those bytes, but MUST NOT replace its publisher token, request
identity, commit time, manifest, or conditional position. The same
`requestId` with different request bytes, the same manifest under a
second request id, or the same revision id with a different envelope is
a hard integrity conflict. An importer MUST compare an existing
revision byte-for-byte before treating it as already present.

**Closure is explicit and ordered.** Every record named by a semantic
item, accepted claim, retained position, or attribution MUST appear in
`publishedRecords` with the same kind, id, and content digest. Every
required source, common-base, or dependency revision MUST appear in
`publishedRevisionRefs`. An archive MUST contain those native records
and revisions, earlier in dependency order, unless the import contract
explicitly resolves them from an already trusted destination store.
Missing and digest-mismatched closure is an error; current records may
not be substituted for the reviewed bytes.

Import reconstructs the ontology head only in revision domain
`ontology/v1` and chain `ontology`. It MUST reject a domain or chain
mismatch, a fork (two successors of one head), a cycle, a missing
predecessor, or a record whose declared predecessor disagrees with the
reviewed target head. Importing an archive never grants publication
authority and never elects a different head from current state.

### 5.6 Stored originals (v1.0)

A primary evidence record may name the exact file it was cut from — a
PDF, an Office document, a mail message — in an optional `source_blob`
(the evidence payload is snake_case; the object inside is camelCase):

```json
"source_blob": {"assetId": "…", "byteLength": 150, "sha256": "<64 hex>",
                "mediaType": "application/pdf", "fileName": "Q3.pdf"}
```

- `assetId` names the stored original, `[A-Za-z0-9_-]{16,128}`. It is an
  identifier, never a credential.
- `byteLength` is the exact length; `0` is an empty file.
- `sha256` is the whole original's digest, lowercase hex.
- `mediaType` (1..=255 printable ASCII) and `fileName` (1..=1024 bytes,
  no control characters) are descriptive only.

In a file, the evidence record is followed **immediately** by the
original's bytes as `original_chunk` records, in order, before any other
record:

```json
{"kind":"original_chunk","data":{"evidenceId":"…","assetId":"…","index":0,
 "byteOffset":0,"sha256":"<chunk hex>","bytes":"<standard base64>"}}
```

A reader MUST reject the file unless, for every evidence with a
`source_blob`:

1. its chunks follow it with no other record in between;
2. chunk `i` has `index == i`, `byteOffset` equal to the sum of the
   preceding chunks' lengths, and the evidence's `id` and `assetId`;
3. every chunk decodes (standard base64, padded) to at least one byte,
   and the decoded bytes match the chunk's `sha256`;
4. every chunk but the last has the length of the first, and the last is
   no longer;
5. the chunks total exactly `byteLength` and their concatenation matches
   `sha256`. An empty original has no chunks, and its `sha256` is the
   digest of zero bytes.

A reader MUST also reject a `0.x` file that contains an evidence with a
`source_blob` or any `original_chunk`. A reader MAY bound the length of a
line it will buffer in a `1.x` file; the Rust reader refuses a data line
over 64 MiB before buffering it. Chunk size is the writer's choice (the
engine writes 1 MiB); it is a transfer unit, not a limit on an
original's size.

**Source references.** Where an original came from — a folder, a drive
item, a mail message — is recorded as `original_source` records, all of
which follow that original's last chunk (or its evidence, for an empty
original), in strictly increasing `referenceId` order:

```json
{"kind":"original_source","data":{"evidenceId":"…","assetId":"…","sha256":"…",
 "byteLength":150,"referenceId":"ref-drive-0001","source":{…},
 "recordedAt":"2026-09-21T00:00:00Z"}}
```

`evidenceId`, `assetId`, `sha256` and `byteLength` MUST equal the
evidence's `source_blob`; `referenceId` is `[A-Za-z0-9_.:-]{1,128}`;
`source` is a JSON object of at most 16 KiB serialized, nesting at most
64 levels (arrays and objects, `source` itself the first); `author` is
optional. A reader MUST reject a reference that does not follow its
original, does not bind to it, or repeats or goes back in order, and a
`0.x` file that contains one. References are immutable: an importer
MUST refuse one whose `referenceId` it already holds with a different
`source`. A writer that exports an evidence with an original exports
all of its references (the trailer counts them as `originalSources`,
omitted when zero).

An evidence's original is immutable: an importer MUST refuse to replace
an existing evidence's original with a different one, or to overwrite
an evidence that has an original with one that has none. Importers
verify the whole file (every rule above and the trailer) before applying
anything.

**Cleaned-text derivatives.** Text normalized from a stored original is
an ordinary, blob-free `evidence` record (its `content` is the text)
carrying a typed `derivation` that binds it, immutably, to the exact
original it came from:

```json
{"kind":"evidence","data":{"id":"ev_original_text_0", …, "content":"First cleaned block.",
 "derivation":{"contract":"antares.normalized-text/v1","primaryEvidenceId":"ev_original",
  "assetId":"…","sha256":"…","byteLength":150,
  "normalizer":{"name":"html5ever-visible","version":"product-3-html-original-v1",
                "configurationSha256":"…"},
  "jobId":"normalization-…","segment":{"index":0,"locator":"html:line:1:block:0",
  "coverage":{…}},"textSha256":"…","textByteLength":20}}}
```

- `contract` is `antares.normalized-text/v1`.
- `primaryEvidenceId`, `assetId`, `sha256` and `byteLength` MUST equal the primary's
  `source_blob`. A derivative has no `source_blob` of its own. `primaryEvidenceId` is
  non-empty with no control characters (Unicode `Cc`), `assetId` is
  `[A-Za-z0-9_-]{16,128}` and `sha256` is 64 lowercase hex characters.
- `textSha256` and `textByteLength` MUST be the SHA-256 (64 lowercase hex characters)
  and the UTF-8 byte length of `content`.
- `normalizer.name` and `normalizer.version` are `[A-Za-z0-9_.:-]{1,64}`, and
  `configurationSha256` is 64 lowercase hex characters. `jobId` is
  `[A-Za-z0-9_.:-]{1,128}`.
- `segment.index` is a stable 0-based slot, any unsigned 64-bit integer. Slots may be
  sparse, and `(primaryEvidenceId, jobId, index)` names one derivative.
- `segment.locator` is 1..=2048 bytes (UTF-8) with no control characters.
- `segment.coverage` is a JSON object of at most 8 KiB serialized (canonical size,
  below), nesting at most 64 levels (arrays and objects, `coverage` itself the first),
  carried verbatim. It describes that segment only, never the whole job. The nesting
  bound keeps a record readable inside every envelope that carries it: a JSON parser
  such as serde_json refuses a document nested past 127 levels, and a sync feed frame
  already puts `coverage` seven levels down.
- `derivation`, `normalizer` and `segment` carry exactly these fields, no others.

**Numbers and canonical size.** A reader MUST return every integer in
[-2^63, 2^64-1] exactly, wherever it appears (a slot, a coverage fact, a source
field); a reader whose native numbers are doubles uses an exact integer type past
2^53 (the JavaScript binding returns a `BigInt` there, and a `number` otherwise). Every
other number is the IEEE-754 double nearest its literal (correctly rounded); `-0` is the
double -0.0; a literal no finite double can hold is refused.

The "serialized" size bounding `segment.coverage` (8 KiB) and a source reference's
`source` (16 KiB) is the byte length of the value's canonical compact JSON, the
serialization the Rust reader produces:
- no insignificant whitespace; object members and array elements in file order;
- strings escaped as JSON requires (`"`, `\`, and U+0000..U+001F, the latter as
  `\b \f \n \r \t` or `\u00xx`), every other character as UTF-8;
- `true`, `false`, `null` as themselves;
- an integer literal in [-2^63, 2^64-1] as its decimal digits;
- `-0` and every other number as its double in shortest round-trip digits `D`
  (length `n`, no trailing zeros) with decimal-point position `kk` (the value is
  `0.D × 10^kk`), prefixed by `-` when negative, laid out as:
  `0.0` for zero; `D` padded with zeros then `.0` when `kk - n >= 0` and `kk <= 16`;
  `D` with a point after `kk` digits when `0 < kk <= 16`; `0.` then `-kk` zeros then
  `D` when `-5 < kk <= 0`; otherwise `DeX` (one digit) or `D0.D1..eX` with
  `X = kk - 1` written with its sign and no padding. So `1.0` is 3 bytes, `1e-6` is 4,
  and `1e16` is `1e+16` (5).

In a file, a derivative follows its primary: after the original's
chunks and source references, or after another derivative of the same
primary, in strictly increasing `(jobId, index)`. A reader MUST reject
the following:
- a derivation that breaks any rule above (sizes counted canonically);
- a derivative that also carries a `source_blob`;
- a derivative anywhere else;
- one that does not bind to the original it follows;
- one whose content is not the text it names;
- derivatives out of order;
- a derivative in a `0.x` file.

A 0.x reader already refuses the file at its manifest, so no reader can
read the text while dropping what it was cleaned from.

A writer that exports a primary with an original exports every
derivative of it that the export may show. A writer that exports a
derivative exports its primary, the original's chunks and its source
references. If the primary cannot be exported, the writer refuses. A
derivative is immutable: an importer MUST refuse a record whose id, or
whose `(primaryEvidenceId, jobId, index)` slot, it already holds with a
different derivation or text, and one that would add, change or drop a
`derivation` on an existing record. Derivatives count as `evidence` in
the trailer.

## 6. Property values

A property value is one of five bare JSON forms, or a tagged envelope.

**The five bare forms (v0.1, unchanged and byte-identical):**

| JSON            | meaning |
|-----------------|---------|
| `null`          | null |
| `true` / `false`| boolean |
| `42`            | 64-bit integer (BIGINT) |
| `1.5`           | double |
| `"hi"`          | text |
| `{...}` / `[...]` | a JSON/JSONB document value |

**The tagged envelope (added in v0.3)**, `{"$ant":"<type>","v":<payload>}`:

| tag         | payload | meaning |
|-------------|---------|---------|
| `decimal`   | string  | DECIMAL/NUMERIC. Canonical decimal literal |
| `date`      | string  | DATE, `YYYY-MM-DD` |
| `time`      | string  | TIME, `HH:MM:SS[.ffffff]` |
| `timestamp` | string  | TIMESTAMP WITH TIME ZONE, RFC3339 |
| `uuid`      | string  | UUID, lowercase 8-4-4-4-12 |
| `bytes`     | string  | BLOB/BYTEA, base64 (standard alphabet, padded) |
| `int32`     | integer | INT, range-checked |
| `int16`     | integer | SMALLINT, range-checked |
| `array`     | array   | elements are themselves property values |

v0.2 had only the bare forms, and they cannot express these types:
`DECIMAL`, `DATE`, `TIME`, `TIMESTAMP`, `UUID` and `BLOB` all serialize
as JSON strings, so a reader could not tell a date from a string that
looked like one and the type was lost on the first round-trip.

Writers **MUST NOT** wrap the five bare forms. `{"$ant":"long","v":42}`
is invalid: `42` is already unambiguous, and wrapping it would break
every v0.2 reader for no gain.

### 6.1 Recognising an envelope

An object is an envelope **only when it has exactly the two keys `$ant`
and `v`, and `$ant` names a tag from the table above.** Everything else
is an ordinary JSON document value and MUST round-trip as one:

```json
{"$ant":"decimal","v":"1.0","mine":true}   -> a document (three keys)
{"$ant":"wat","v":1}                       -> a document (unknown tag)
{"$ant":"date","v":"not-a-date"}           -> a document (payload does not parse)
```

The last case matters for durability: this decoding runs against data
that is already committed, so a malformed envelope degrades to a plain
JSON value rather than failing the read.

### 6.2 Two rules that silently corrupt data

Both are exercised by `golden/basic.ant`; an implementation that gets
them wrong still parses the file cleanly.

**A decimal is a string and MUST NOT be parsed as a float.** The
golden's `exact_amount` is `12345678901234567.89` — 19 significant
digits, where an IEEE double carries ~15–16. Parsed as a number it
becomes `12345678901234568`, with no error. This is why the payload is
a string, and why readers should surface it as text (or a decimal type)
rather than a native number. The same applies on write: do not accept a
fractional JSON *number* as a decimal, because your JSON parser has
already passed it through a double before you see it.

**A timestamp keeps its offset.** The golden's `signed_at` is
`2026-08-10T09:00:00+02:00`. Normalizing it to `Z` on read discards the
only thing that distinguishes TIMESTAMPTZ from TIMESTAMP. Compare
timestamps by instant; serialize the offset as given.

## 7. The trailer (last line) and integrity

```
{"kind":"trailer","counts":{"schemaTypes":N,"vertices":N,"edges":N,
 "observations":N,"evidence":N,"beliefs":N,"vectors":N,
 "vertexTombstones":N,"edgeTombstones":N,"contradictionCases":N,
 "relationshipProposals":N,"ontologyRevisions":N},"sha256":"<hex>"}
```

A `1.0` trailer adds `"originalChunks":N`. Writers omit the key when it
is zero, so a file without originals keeps the `0.7` trailer bytes.

- `sha256` is the lowercase-hex SHA-256 over **every preceding
  uncompressed line including its trailing `\n`** — from the manifest
  line through the last data record line. The trailer line itself is
  not covered (it cannot contain its own hash).
- `counts` are the number of data records **per kind** actually
  present. Unknown-kind records are NOT counted (they are hashed —
  they are part of the byte stream — but a reader cannot attribute them
  to a kind; writers of future kinds bump the MINOR version if they
  need counted records).
- `vertexTombstones` and `edgeTombstones` were added in v0.2,
  `contradictionCases` in v0.4, `relationshipProposals` in v0.5,
  `ontologyRevisions` in v0.7, and `originalChunks` in v1.0. Each MUST
  default to zero when absent,
  so an older trailer still validates. A reader MUST ignore count keys
  it does not know: they count kinds it skipped as unknown, and failing
  on them would make every additive kind a breaking change.

A reader MUST:

1. fail if the stream ends without a trailer (truncation),
2. fail if the trailer `sha256` does not equal the hash it computed
   over the preceding lines,
3. fail if the trailer `counts` do not match the records it saw
   (excluding skipped unknown kinds),
4. treat everything after the trailer line as an error.

## 8. Forward compatibility

- A record whose `kind` is a string the reader does not recognize MUST
  be **skipped silently** (but still hashed — it is part of the byte
  stream).
- A line that is not a JSON object, or lacks a string `kind`, is a
  hard error.
- New fields on known kinds are additive; readers use defaults.
- New MINOR versions are readable per §3; only a MAJOR bump is a
  rejection.

## 9. Selection semantics (writer-side contract)

A `.ant` file carries whatever selection the exporter chose (whole
scope, a seed set + traversal, a digest). The manifest records the
selection descriptor verbatim so the consumer knows what the file
*claims* to contain. **Evidence closure is the exporter's obligation:**
every `evidence_id` referenced by an exported observation/edge/belief
should have its `evidence` record included in the same file. **Case
closure is mandatory** (§5.2): a file containing a `contradiction_case`
MUST contain every record it references. Relationship-proposal closure
is mandatory under §5.3, and ontology-revision closure and dependency
ordering are mandatory under §5.5. **Original closure is mandatory**
(§5.6): an evidence with a `source_blob` is exported with its complete
original or not at all — a writer that cannot read an original refuses
the export rather than write the evidence without it.

## 10. Reference implementations

| language | location | role |
|----------|----------|------|
| Rust     | `antares-format` crate — canonical, upstream, not in this repository | writer that produces the goldens |
| Python   | `bindings/python/openantares.py` | reference reader + writer + validator |
| JavaScript (Node ≥ 22.15) | `bindings/js/openantares.mjs` | reference reader + validator |

All three run the same [conformance suite](conformance/README.md)
against shared golden files produced by the Rust writer.

**Any change to this document changes all of them.** The Rust test
suite structurally cannot catch a stale binding — the Python and JS
runners are separate processes, not `cargo test` — so a version bump
that lands without them leaves every non-Rust reader broken while Rust
stays green. That has happened twice. Update the bindings, the JSON
Schema, and the goldens in the SAME commit as the spec.
